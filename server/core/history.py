#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""history.py — 历史数据（按周期采样变量值 → 按天落盘 → 按时间段查询 / 导出 CSV）

现场需求：运行态看到的变量值要能按时间段导出成**历史数据报表**。

存哪儿（都是**现场数据**，不进版本库 —— .gitignore 里有 server/data/history/ 与 history.json）：
  · 配置  `<数据目录>/history.json`
        {"on": false, "intervalMs": 1000, "vars": ["温度", "速度"], "keepDays": 7}
  · 数据  `<数据目录>/history/YYYY-MM-DD.jsonl`，一行一个采样点：
        {"t": 1760000000123, "v": {"温度": 35.5, "速度": 1200}}
    只写配置里给了、**当前数据源里读得到**的变量；缺的变量查询时给 null。

采样怎么做的（为什么要守护线程，而不是挂在某个回调上）：
  · 数据源这边有两条路：内存模拟（MemorySource）值只在写的时候变，
    PLC/OPC UA 是轮询线程把值刷进缓存（PlcSource.read_all() 读的是缓存，**不发通讯**）。
    挂"值变化回调"会漏掉"值没变但报表要按周期出一行"的采样点；
    所以这里起一个守护线程，每 intervalMs 直接读一次数据源当前值，只挑配置里的变量。
  · ⚠ 接真设备时**只在该设备确实在轮询时才记**（poll_gate.wanted()）：没人看运行画面时
    PLC 轮询本来就是停的（现场要求"没人看就别跟设备通讯"），缓存值是冻住的 ——
    这时候还按秒记，报表上会变成一条"设备一直没变化"的假直线，还把盘占着。
    想夜里无人值守也存历史：后端加 `--poll-always`（或 HMI_POLL_ALWAYS=1），轮询不停，历史就连续。
    内存模拟不受影响（值本来就在内存里，不轮询也照记）。
  · on=false 时线程只是低频等待，**不读数据源、不写盘**（现场没开历史就一点开销都没有）。
  · 读写异常一律只打 warn（限速：同一类错误 60 秒最多说一次），绝不让后端掉线/起不来。

查询 / 导出：
  · query(from_ms, to_ms, vars) → {"vars": [...], "rows": [[ts, v1, v2, …], …], …}
    （按 vars 的顺序；缺值 null；单次最多 MAX_QUERY_ROWS 行，超了 truncated=true）
  · export_csv(from_ms, to_ms, vars) → 字符串：UTF-8 BOM + CRLF，表头 `时间,变量1,…`，
    时间格式 `YYYY-MM-DD hh:mm:ss.mmm`（Excel 直接双击打开不乱码、不串行）
  · purge() → 按 keepDays 删旧文件；启动、改设置、以及采样线程每小时各清一次。
"""
from .paths import HISTORY_DIR
from .paths import HISTORY_FILE
from . import datasource
from .plcsource import _REMOTE_SRC

import csv
import io
import json
import os
import poll_gate
import re
import threading
import time
from datetime import date
from datetime import timedelta
from pathlib import Path


# ── 配置默认值 / 上下限 ─────────────────────────────────────────────
DEFAULTS = {"on": False, "intervalMs": 1000, "vars": [], "keepDays": 7}
INTERVAL_MIN, INTERVAL_MAX = 500, 60000     # 采样周期（毫秒）：500ms~60s
KEEP_MIN, KEEP_MAX = 1, 90                  # 历史保留天数
MAX_VARS = 256                              # 一条采样最多记多少个变量（防手滑/防跑飞）
MAX_QUERY_ROWS = 20000                      # 单次查询/导出最多多少行（再大就 truncated）

_DAY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.jsonl$")
_WARN_EVERY = 60.0                          # 同类 warn 的限速间隔（秒）


def _as_bool(v, default=False):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return default


def _as_int(v, default, lo, hi):
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _norm_vars(v):
    """变量名列表：只留字符串、去空、去重（保留给的顺序），最多 MAX_VARS 个"""
    if isinstance(v, str):
        v = [x for x in re.split(r"[,，]", v)]
    if not isinstance(v, (list, tuple)):
        return []
    out = []
    for x in v:
        if not isinstance(x, str):
            continue
        n = x.strip()
        if n and n not in out:
            out.append(n)
        if len(out) >= MAX_VARS:
            break
    return out


def _fmt_ts(ts_ms) -> str:
    """epoch 毫秒 → 'YYYY-MM-DD hh:mm:ss.mmm'（本地时区，和按天文件名的日期一致）"""
    try:
        n = int(ts_ms)
    except (TypeError, ValueError):
        n = 0
    sec, ms = divmod(n, 1000)
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(sec)) + ".%03d" % ms


def _csv_cell(v) -> str:
    """单元格文本：None→空、bool→1/0、浮点用 15 位有效数字（1200.0→1200）、其它转文本"""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:                      # NaN
            return ""
        return format(v, ".15g")
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    except Exception:                                           # noqa: BLE001
        return str(v)


class HistoryStore:
    """历史数据：配置 + 按天 jsonl + 采样线程 + 查询/导出。

    一个进程一个实例（见文件末尾 `_history`）；`threading.RLock` 串起
    "读配置 / 写文件 / 清文件 / 统计"这几件事（采样线程和接口线程会同时用）。
    """

    def __init__(self, cfg_path, data_dir, interval_check: float = 0.25):
        self.path = Path(cfg_path)
        self.dir = Path(data_dir)
        self._lock = threading.RLock()
        self._cfg = dict(DEFAULTS)
        self._rec = None            # 现有文件里的采样行数（None = 还没数过，等第一次 stats/lazy 扫）
        self._warn_at = {}          # 同类 warn 上次打印时间（限速用）
        self._last_purge = 0.0
        self._load()
        try:
            self.purge()                                   # 启动先按 keepDays 清一次
        except Exception as e:                             # noqa: BLE001
            print(f"[warn] 历史数据清理失败（不影响其它功能）：{type(e).__name__}: {e}")
        self._stop = threading.Event()
        threading.Thread(target=self._loop, name="history-sampler", daemon=True).start()

    # ── 配置 ───────────────────────────────────────────────────────────
    def _norm_settings(self, raw) -> dict:
        """把任意 dict 规整成合法配置（缺键用默认值，数字夹到上下限）"""
        raw = raw if isinstance(raw, dict) else {}
        cur = dict(DEFAULTS)
        for k in DEFAULTS:
            if k in raw:
                cur[k] = raw[k]
        return {
            "on": _as_bool(cur.get("on"), False),
            "intervalMs": _as_int(cur.get("intervalMs"), DEFAULTS["intervalMs"],
                                  INTERVAL_MIN, INTERVAL_MAX),
            "vars": _norm_vars(cur.get("vars")),
            "keepDays": _as_int(cur.get("keepDays"), DEFAULTS["keepDays"], KEEP_MIN, KEEP_MAX),
        }

    def _load(self):
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception as e:                                      # noqa: BLE001
            self._warn("load", f"历史数据配置读不出来（{e}）：先按默认值（关闭）继续：{self.path}")
            return
        self._cfg = self._norm_settings(raw)

    def settings(self) -> dict:
        """当前配置（副本：外面改了不会影响采样线程）"""
        with self._lock:
            return {**self._cfg, "vars": list(self._cfg.get("vars") or [])}

    def save_settings(self, patch) -> dict:
        """合并保存配置（原子写：tmp → replace）。返回保存后的配置；写盘失败抛 OSError。"""
        with self._lock:
            merged = dict(self._cfg)
            if isinstance(patch, dict):
                for k in DEFAULTS:
                    if k in patch:
                        merged[k] = patch[k]
            self._cfg = self._norm_settings(merged)
            self._write_config_locked()
            snapshot = {**self._cfg, "vars": list(self._cfg["vars"])}
        print(f"[history] 采样设置已更新：{'开' if snapshot['on'] else '关'}"
              f"、周期 {snapshot['intervalMs']}ms、{len(snapshot['vars'])} 个变量"
              f"、保留 {snapshot['keepDays']} 天")
        try:
            self.purge()                # 保留天数改小了：当场清一次
        except Exception as e:                                      # noqa: BLE001
            self._warn("purge", f"历史数据清理失败：{type(e).__name__}: {e}")
        return snapshot

    def _write_config_locked(self):
        """把配置写盘（调用方已持锁）：先写 .tmp 再 os.replace，断电不会留半截 JSON"""
        payload = json.dumps(self._cfg, ensure_ascii=False, indent=2)
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(payload, encoding="utf-8")
            os.replace(tmp, self.path)
        finally:
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass

    # ── 写一个采样点 ───────────────────────────────────────────────────
    def append(self, ts_ms, values) -> int:
        """写一个采样点到当天文件（追加一行）。返回写了几个变量（0 = 这行没写）。"""
        if not isinstance(values, dict) or not values:
            return 0
        try:
            line = json.dumps({"t": int(ts_ms), "v": values},
                              ensure_ascii=False, separators=(",", ":"))
            path = self.dir / (time.strftime("%Y-%m-%d", time.localtime(int(ts_ms) / 1000.0)) + ".jsonl")
            with self._lock:
                self.dir.mkdir(parents=True, exist_ok=True)
                with open(path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
                if self._rec is not None:
                    self._rec += 1
            return len(values)
        except Exception as e:                                      # noqa: BLE001
            self._warn("append", f"历史数据写盘失败（{type(e).__name__}: {e}）")
            return 0

    # ── 采样线程 ───────────────────────────────────────────────────────
    def _loop(self):
        while not self._stop.is_set():
            cfg = self.settings()
            interval = max(0.1, cfg["intervalMs"] / 1000.0)
            started = time.time()
            if cfg["on"] and cfg["vars"]:
                try:
                    values = self._read_current(cfg["vars"])
                    if values:
                        self.append(int(started * 1000), values)
                except Exception as e:                              # noqa: BLE001
                    self._warn("sample", f"历史采样读数据失败（{type(e).__name__}: {e}）")
            # 每小时清一次旧文件（保留天数可能改小、跨天也要清）
            if time.time() - self._last_purge > 3600:
                self._last_purge = time.time()
                try:
                    self.purge()
                except Exception:                                   # noqa: BLE001
                    pass
            rest = interval - (time.time() - started)
            self._stop.wait(max(0.1, rest))

    def _read_current(self, names):
        """读数据源当前值，挑出配置里的变量（read_all 读的是轮询缓存/内存值，不额外发通讯）

        ⚠ 真设备只有在**确实在轮询**时才记：没人看运行画面时轮询是停的（poll_gate），
          缓存值冻住 —— 记下来就是一条假直线（见文件开头的说明）。内存模拟不受此限。
        """
        src = datasource.get_source()
        if isinstance(src, _REMOTE_SRC) and not poll_gate.wanted():
            return {}
        cur = src.read_all()
        if not isinstance(cur, dict):
            return {}
        return {n: cur[n] for n in names if n in cur}

    def _warn(self, key, msg):
        now = time.time()
        if now - self._warn_at.get(key, 0) < _WARN_EVERY:
            return
        self._warn_at[key] = now
        print(f"[warn] {msg}")

    # ── 段 → 文件 ──────────────────────────────────────────────────────
    def _day_files(self):
        """现有历史文件：[(日期字符串, Path)]，按日期升序"""
        try:
            items = []
            for p in self.dir.iterdir():
                m = _DAY_RE.match(p.name)
                if m and p.is_file():
                    items.append((m.group(1), p))
            items.sort(key=lambda x: x[0])
            return items
        except FileNotFoundError:
            return []

    def normalize_range(self, from_ms=None, to_ms=None):
        """时间范围：缺 to 用现在、缺 from 用最后 1 小时；范围反了自动对调"""
        try:
            to = int(to_ms) if to_ms not in (None, "") else int(time.time() * 1000)
        except (TypeError, ValueError):
            to = int(time.time() * 1000)
        try:
            frm = int(from_ms) if from_ms not in (None, "") else to - 3600 * 1000
        except (TypeError, ValueError):
            frm = to - 3600 * 1000
        if to < frm:
            frm, to = to, frm
        return frm, to

    def _query_names(self, vars_):
        """这次查询用哪些变量：调用方给了就用它（按给的顺序），没给就用配置里的"""
        names = _norm_vars(vars_)
        if names:
            return names
        return list(self.settings()["vars"])

    # ── 查询 ───────────────────────────────────────────────────────────
    def query(self, from_ms=None, to_ms=None, vars_=None) -> dict:
        """按时间段查采样点 → {"vars": [...], "rows": [[ts, v1, …], …], "truncated": bool}"""
        frm, to = self.normalize_range(from_ms, to_ms)
        names = self._query_names(vars_)
        out = {"vars": names, "rows": [], "from": frm, "to": to,
               "count": 0, "truncated": False, "badLines": 0}
        if not names:
            return out
        frm_day = time.strftime("%Y-%m-%d", time.localtime(frm / 1000.0))
        to_day = time.strftime("%Y-%m-%d", time.localtime(to / 1000.0))
        for day, path in self._day_files():
            if day < frm_day or day > to_day:
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = json.loads(line)
                            ts = int(rec.get("t"))
                            vals = rec.get("v") or {}
                        except Exception:                           # noqa: BLE001
                            out["badLines"] += 1
                            continue                        # 半截行（断电）跳过，别整单失败
                        if ts < frm or ts > to:
                            continue
                        out["rows"].append([ts] + [vals.get(n) for n in names])
                        if len(out["rows"]) >= MAX_QUERY_ROWS:
                            out["truncated"] = True
                            out["count"] = len(out["rows"])
                            return out
            except Exception as e:                                  # noqa: BLE001
                print(f"[warn] 读历史文件失败（{path.name}）：{type(e).__name__}: {e}")
        out["count"] = len(out["rows"])
        return out

    # ── 导出 CSV ───────────────────────────────────────────────────────
    def csv_from_query(self, q: dict) -> str:
        """把 query() 的结果转 CSV 文本（不重复扫文件 —— 接口层一次查询既拿行又拿 CSV）"""
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\r\n")
        w.writerow(["时间"] + list(q.get("vars") or []))
        for row in q.get("rows") or []:
            w.writerow([_fmt_ts(row[0])] + [_csv_cell(v) for v in row[1:]])
        return "\ufeff" + buf.getvalue()

    def export_csv(self, from_ms=None, to_ms=None, vars_=None) -> str:
        """查询并转 CSV：UTF-8 BOM + CRLF + 表头「时间,变量1,…」，时间到毫秒"""
        return self.csv_from_query(self.query(from_ms, to_ms, vars_))

    def csv_filename(self, from_ms=None, to_ms=None) -> str:
        """导出文件名（时间范围写进名字里，现场一次导好几段不会覆盖）"""
        frm, to = self.normalize_range(from_ms, to_ms)
        fmt = "%Y%m%d-%H%M%S"
        return ("history_"
                + time.strftime(fmt, time.localtime(frm / 1000.0)) + "_"
                + time.strftime(fmt, time.localtime(to / 1000.0)) + ".csv")

    # ── 清理 / 统计 ────────────────────────────────────────────────────
    def purge(self) -> int:
        """按 keepDays 删旧文件（保留最近 N 天，含今天）。返回删掉的文件数。"""
        keep = self.settings()["keepDays"]
        cutoff = (date.today() - timedelta(days=max(0, keep - 1))).strftime("%Y-%m-%d")
        removed = 0
        with self._lock:
            for day, path in self._day_files():
                if day >= cutoff:
                    continue
                try:
                    path.unlink()
                    removed += 1
                except OSError as e:
                    self._warn("purge", f"删历史文件失败（{path.name}）：{e}")
            if removed:
                self._rec = None            # 行数变了：下次 stats 重新数
        if removed:
            print(f"[history] 按保留 {keep} 天清掉 {removed} 个旧的历史文件")
        return removed

    def stats(self) -> dict:
        """现状（GET /api/history 用）：{days, files, records, bytes, dir, lastDay, lastTs}"""
        files = self._day_files()
        total = 0
        try:
            for _, p in files:
                total += p.stat().st_size
        except OSError:
            pass
        records = self._rec
        if records is None:
            records = 0
            for _, p in files:
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        records += sum(1 for line in f if line.strip())
                except Exception:                                   # noqa: BLE001
                    pass
            self._rec = records
        last_day, last_ts = "", 0
        if files:
            last_day = files[-1][0]
            try:
                with open(files[-1][1], "rb") as f:
                    f.seek(0, os.SEEK_END)
                    f.seek(max(0, f.tell() - 4096))
                    tail = f.read().decode("utf-8", "replace").splitlines()
                for line in reversed(tail):
                    try:
                        last_ts = int(json.loads(line).get("t") or 0)
                        break
                    except Exception:                               # noqa: BLE001
                        continue
            except Exception:                                       # noqa: BLE001
                pass
        return {"days": len(files), "files": len(files), "records": records,
                "bytes": total, "dir": str(self.dir),
                "lastDay": last_day, "lastTs": last_ts,
                "on": self.settings()["on"], "intervalMs": self.settings()["intervalMs"],
                "vars": len(self.settings()["vars"]), "keepDays": self.settings()["keepDays"]}


# 全局一份（和 core/recipe.py 的 `_recipes` 一个用法）：路径从 core/paths.py 来，
# 测试用独立 HMI_DATA_DIR 起后端时自然指向临时目录。
_history = HistoryStore(HISTORY_FILE, HISTORY_DIR)
