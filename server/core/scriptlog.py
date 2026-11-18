#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scriptlog.py — 脚本日志（hmi.log / hmi.warn 落盘的那一份）

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

运行页把脚本日志按批送过来，这里写进 logs/script-日期.log。
每天有大小上限，到顶写一行说明就不记了；读回时按天（面板「服务器历史」用它）。
"""

from .paths import LOG_DIR
from .settings import SCRIPTLOG_MAX_MB_HARD
from .settings import _LOG_NAME_RE
from .settings import scriptlog_max_mb

import re
import time


# ─────────────────────────────────────────────────────────
# 脚本日志落盘：脚本里的 hmi.log / warn / 运行错误 → logs/script-YYYY-MM-DD.log
#
# 为什么要落盘：脚本日志以前**只活在浏览器内存里**（每条脚本最近 60 行，见 scriptEngine）——
#   刷新就没、退出运行态就没，而且**运行页（/run）上根本看不见**：现场出了事一点痕迹都没有。
#   现在运行态把日志按批发过来，后端按天落盘，「脚本日志」面板/编辑器随时能查历史。
#
# 三条硬规矩（跟前一份日志一个口径，都是现场踩出来的）：
#   · **限速 + 上限 + 按天**：前端按脚本限速（scriptEngine 里的令牌桶），后端再兜一层：
#     单请求最多 SCRIPTLOG_MAX_LINES 行、每行文本截断 SCRIPTLOG_MAX_CHARS 字、
#     每天最多 SCRIPTLOG_MAX_MB —— **默认 10MB/天、硬上限 100MB/天**（界面上能改，见日志设置）。
#     到顶了写一行"已到上限"然后当天不再记 —— **绝不把工控机的盘写满**；
#     文件名带日期，所以也走 _log_prune 那套"只留最近 3 天"。
#   · **不拖请求线程**：就是往文件追加 + flush（文件句柄/换天/prune 全复用上面那套）。
#     控制台那半边的坑（窗口被点住、谁写谁卡）不在这里 —— 这里只碰文件。
#   · **不用登录**：脚本跑在运行页上，客户机没人登录（同 /api/vars、/api/alarms）。
#     写进来的只是一行行**有长度上限**的文本，请求体也有硬上限，拿它当攻击面没意义。
#
# 一行长这样（好读、好 grep）：[2026-10-04 22:41:02] [产量脚本] [warn] 状态变了
#   ⚠ 脚本名/级别里的方括号会被换成圆括号（不然字段解析会串），正文只换掉换行/制表符。
# ─────────────────────────────────────────────────────────
SCRIPTLOG_MAX_LINES = 200          # 一次请求最多接多少行

SCRIPTLOG_MAX_CHARS = 500          # 单行文本最多多少字（超了截断）

SCRIPTLOG_MAX_BODY = 512 * 1024    # 请求体硬上限（一条日志不可能这么大）

_SLOG_FILE = None

_SLOG_DAY = ""

_SLOG_SIZE = 0                     # 今天这份已经写了多少字节（上限跨后端重启照样管用）

_SLOG_NOTICED = ""                 # 已经写过"到上限"说明的那一天

_SLOG_LINE_RE = re.compile(r"^\[([^\]]+)\] \[([^\]]*)\] \[([a-z]+)\] (.*)$")

# 字段里的"会搅乱格式"的字符：换行/制表 → 空格，方括号 → 圆括号（一次 translate 换掉）
_SLOG_FIELD_MAP = str.maketrans({"\r": " ", "\n": " ", "\t": " ", "[": "(", "]": ")"})



def _slog_ensure():
    """返回「今天」的脚本日志文件句柄；换天就换文件（顺手记下已有大小）"""
    global _SLOG_FILE, _SLOG_DAY, _SLOG_SIZE
    day = time.strftime("%Y-%m-%d")
    if _SLOG_FILE is not None and day == _SLOG_DAY:
        return _SLOG_FILE
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if _SLOG_FILE is not None:
            _SLOG_FILE.close()
        path = LOG_DIR / f"script-{day}.log"
        try:
            _SLOG_SIZE = path.stat().st_size if path.exists() else 0
        except Exception:                                       # noqa: BLE001
            _SLOG_SIZE = 0
        _SLOG_FILE = open(path, "a", encoding="utf-8")
        _SLOG_DAY = day
    except Exception:                                           # noqa: BLE001
        _SLOG_FILE = None
        _SLOG_DAY = ""
    return _SLOG_FILE



def _slog_field(v, limit):
    """字段（脚本名 / 级别）：换行、制表、方括号都收拾掉 —— 方括号会把上面的字段格式搅乱。
    ⚠ 一次 translate 替换掉（不是连着两次 replace）：'[' 和 ']' 各换各的，别互相踩"""
    s = str(v if v is not None else "").translate(_SLOG_FIELD_MAP)
    return s[:limit] + "…" if len(s) > limit else s



def _slog_text(v, limit):
    """正文：只把换行/制表符换成空格（一条记录必须只占一行）。方括号**照原样留着**
    —— 脚本里 log('arrw[3] =', v) 这种很常见，改掉反而看不懂"""
    s = str(v if v is not None else "").replace("\r", " ").replace("\n", " ").replace("\t", " ")
    return s[:limit] + "…" if len(s) > limit else s



def scriptlog_write(rows):
    """写一批脚本日志。rows=[{t,name,level,text}] → {written, dropped, capped, size}"""
    global _SLOG_SIZE, _SLOG_NOTICED
    day = time.strftime("%Y-%m-%d")
    total = len(rows) if isinstance(rows, list) else 0
    rows = rows[:SCRIPTLOG_MAX_LINES] if isinstance(rows, list) else []
    f = _slog_ensure()
    if f is None:
        return {"written": 0, "dropped": total, "capped": False, "size": 0}
    cap_mb = scriptlog_max_mb()                     # 每次现算：界面上改了立刻按新上限走（不用重启）
    limit = int(cap_mb * 1024 * 1024)
    written = 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        if _SLOG_SIZE >= limit:
            if _SLOG_NOTICED != day:                # 到上限：当天写一次说明就够了
                _SLOG_NOTICED = day
                note = (f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [脚本日志] [warn] "
                        f"今天的脚本日志已到上限（{cap_mb:g} MB），后面的不再记录"
                        f"（明天自动换新文件；这个上限在「工程 ▾ → 日志设置…」里能改，"
                        f"最大 {SCRIPTLOG_MAX_MB_HARD:g} MB/天）")
                try:
                    f.write(note + "\n")
                    f.flush()
                    _SLOG_SIZE += len(note.encode("utf-8")) + 1
                except Exception:                               # noqa: BLE001
                    pass
            break
        t = r.get("t")
        try:
            ts = (time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(t) / 1000.0))
                  if t else time.strftime("%Y-%m-%d %H:%M:%S"))
        except Exception:                                       # noqa: BLE001
            ts = time.strftime("%Y-%m-%d %H:%M:%S")
        name = _slog_field(r.get("name") or "脚本", 60)
        level = (_slog_field(r.get("level") or "log", 8).strip().lower() or "log")
        text = _slog_text(r.get("text"), SCRIPTLOG_MAX_CHARS)
        line = f"[{ts}] [{name}] [{level}] {text}\n"
        try:
            f.write(line)
            f.flush()
            _SLOG_SIZE += len(line.encode("utf-8"))
            written += 1
        except Exception:                                       # noqa: BLE001
            break
    return {"written": written, "dropped": max(0, total - written),
            "capped": _SLOG_NOTICED == day, "size": _SLOG_SIZE}



def scriptlog_read(date_str="", limit=300):
    """读回某天的脚本日志（默认今天）。只读文件尾部（不整份读进来 —— 那份可能有几 MB）。

    返回 {ok, date, file, size, lines:[{at,name,level,text}], truncated, days:[...]}
    days = 现有哪几天有脚本日志（倒序），给界面做"按天翻看"。"""
    day = date_str if re.match(r"^\d{4}-\d{2}-\d{2}$", str(date_str or "")) else time.strftime("%Y-%m-%d")
    try:
        limit = max(1, min(int(limit or 300), 2000))
    except (TypeError, ValueError):
        limit = 300
    path = LOG_DIR / f"script-{day}.log"
    out = {"ok": True, "date": day, "file": path.name, "size": 0,
           "lines": [], "truncated": False, "days": [],
           # 每天体积上限（MB）：给界面提示用，也让"上限到底是多少"可被外部核对
           "max_mb": scriptlog_max_mb(), "hard_mb": SCRIPTLOG_MAX_MB_HARD}
    try:
        days = []
        for x in LOG_DIR.iterdir():
            if not x.is_file() or not x.name.lower().startswith("script-"):
                continue
            m = _LOG_NAME_RE.match(x.name)
            if m:
                days.append(m.group(1))
        out["days"] = sorted(set(days), reverse=True)[:14]
    except Exception:                                           # noqa: BLE001
        pass
    try:
        size = path.stat().st_size
    except Exception:                                           # noqa: BLE001
        return out                                              # 那天没日志：空列表，不是错
    out["size"] = size
    try:
        with open(path, "rb") as f:
            read = min(size, max(64 * 1024, limit * 400))
            out["truncated"] = read < size
            f.seek(size - read)
            tail = f.read(read)
    except Exception:                                           # noqa: BLE001
        return out
    # ⚠ 用 splitlines()：Windows 上写出去的日志是 CRLF，按 "\n" 切会给每行正文尾巴留一个 "\r"
    lines = tail.decode("utf-8", "replace").splitlines()
    if out["truncated"] and lines:
        lines = lines[1:]                                       # 开头可能是被截断的半行
    for l in [x for x in lines if x.strip()][-limit:]:
        m = _SLOG_LINE_RE.match(l)
        if m:
            out["lines"].append({"at": m.group(1), "name": m.group(2),
                                 "level": m.group(3), "text": m.group(4)})
        else:
            out["lines"].append({"at": "", "name": "", "level": "raw", "text": l})
    return out
