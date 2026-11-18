#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""plcsource.py — PlcSource：Modbus TCP / OPC UA 的轮询与读写 + PLC 连接配置

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

按页采集（只读当前页面用到的变量）与连续地址合并（一次读一块）都在 _plan() 里；
字序、字符串长度、位地址这些也在这一层。
"""

from .broadcast import broadcast
from .paths import PLCFG_FILE
from .retain import _retain
from .sourcebase import DataSource

from .opcualib import opcua
import json
import modbus                     # 同目录：Modbus TCP 主站 + %MW/%MD 地址解析
import poll_gate                  # 同目录：有没有人在看运行画面（没人看就不跟设备通讯）
import re
import threading
import time


# ─────────────────────────────────────────────
#  真实设备接入：Modbus TCP 主站数据源
# ─────────────────────────────────────────────
class PlcSource(DataSource):
    """把 PLC（Modbus TCP 从站，如 Invtmatic 的 Modbus_TCP_Slave）当数据源。

    变量表里的地址决定怎么读写：
        %MW96 保持寄存器   %MD48 双字(低字在前)   %MB194 字节   %MX195.0 内存位
        %QX0 线圈(FC01/05) %IX0 离散输入(FC02)    %IW5 输入寄存器(FC04)
    轮询线程把地址按区域合并成连续区间批量读（最多 125 个寄存器/帧），
    值变化时通过 on_change 回调广播给前端。
    """

    def __init__(self, host, port=502, unit=1, poll_ms=200, word_order="cdab", timeout=1.5,
                 on_change=None, on_changes=None):
        self.host = host
        self.port = int(port)
        self.unit = int(unit)
        self.poll_ms = max(50, int(poll_ms))
        # 4 种字序：abcd / cdab / badc / dcba（low/high 作兼容别名）
        self.word_order = modbus.normalize_order(word_order)
        self._lock = threading.RLock()
        self._vars = {}                 # name -> {"type","address","value","parsed"}
        self._active = None             # 本页要采集的变量名集合（None = 全部）
        self._blocks = 0                # 上一次规划的读取块数（状态栏/体检用）
        self._cli = modbus.ModbusTcpClient(host, self.port, self.unit, timeout)
        self._stop = threading.Event()
        self._thread = None
        self._on_change = on_change
        self._on_changes = on_changes      # 一批变化一起回调（优先用，见 _emit_changed）
        self.online = False
        self.last_error = ""
        self.last_ok = 0.0
        self.reads = 0
        self.writes = 0
        self.errors = 0

    # ── 变量表同步 ──
    def set_active(self, active):
        """只改「本页采集范围」，**不动变量表**：编辑器切页面时只想要「这一页会采几个变量 / 几块」，
        不能拿编辑器那份变量表去覆盖后端正在用的这份（可能是别的标签页/现场运行页的工程）。"""
        with self._lock:
            self._active = None if active is None else (set(active) & set(self._vars.keys()))

    def declare(self, variables, active=None):
        """整体替换变量表：删掉的变量要真的不再采集/广播（只增量更新会一直留着）。

        active：**本页需要的变量名**（不传 = 全部采集）。前端切页面时只把当前页用到的
        变量名发过来，轮询就只读这些 —— 画面上的控件、报警条件之外的一律不占通讯带宽。

        地址解析结果按**地址字符串**缓存：变量表上万时，每改一个变量都要重新解析全部地址
        （10000 次 parse_address ≈ 上百毫秒），缓存后只有真变了的地址才重解析。
        """
        cache = getattr(self, "_addr_cache", None)
        if cache is None:
            cache = self._addr_cache = {}
        new = {}
        with self._lock:
            for v in variables or []:
                if not isinstance(v, dict):
                    continue
                name = v.get("name")
                if not name:
                    continue
                addr = (v.get("address") or "").strip()
                vtype = v.get("type", "uint")
                parsed = None
                perr = ""
                if addr:
                    hit = cache.get(addr)
                    if hit is not None:
                        parsed, perr = hit
                    else:
                        try:
                            parsed = modbus.parse_address(addr)
                        except ValueError as e:
                            perr = str(e)
                        cache[addr] = (parsed, perr)
                old = self._vars.get(name) or {}
                # 地址留空 = **内部变量**：不读不写 PLC，值由 HMI 自己维护（见 RetainStore）。
                # ⚠ 以前这种变量被当成"地址没填好的 PLC 变量"：写它会报
                #   「地址 '' 无效：未填写」，界面上就是一条「下发失败」——
                #   于是"接上真 PLC 之后，HMI 自己的内部变量全废了"。
                internal = not addr
                if internal:
                    retain = bool(v.get("retain"))
                    value = old.get("value")
                    if value is None:
                        value = _retain.get(name, v.get("value")) if retain else v.get("value")
                    elif retain and not _retain.has(name):
                        _retain.set(name, value)
                    if old.get("retain") and not retain:
                        _retain.forget(name)         # 取消勾选「保持」→ 存盘那份丢掉
                    new[name] = {
                        "type": vtype,
                        "address": "",
                        "value": value,
                        "default": v.get("value"),   # 「恢复初值」按它还原
                        "parsed": None,
                        "addr_error": "",
                        "internal": True,
                        "retain": retain,
                        "len": v.get("len") or old.get("len") or 0,
                    }
                    continue
                new[name] = {
                    "type": vtype,
                    "address": addr,
                    "value": old.get("value", v.get("value")),
                    "default": v.get("value"),
                    "parsed": parsed,
                    "addr_error": perr,
                    # 字符串长度（字符数）：变量表「长度」列，或地址里的 %MW200[10]（10 个字）
                    "len": v.get("len") or old.get("len") or 0,
                }
            self._vars = new
            if active is not None:
                self._active = set(active)
                # 变量表里没有的（或已删掉的）不算在采集范围里
                self._active &= set(new.keys())

    def meta(self):
        with self._lock:
            return {k: {"address": v.get("address", ""), "type": v.get("type", "")}
                    for k, v in self._vars.items()}

    def read_all(self):
        with self._lock:
            return {k: v.get("value") for k, v in self._vars.items()}

    def read(self, name):
        with self._lock:
            v = self._vars.get(name)
            return None if v is None else v.get("value")

    def reset(self, clear=False):
        """**只重置内部变量**（地址留空的那些）—— 接真 PLC 时按这个口径：

            · PLC 变量一个字节都不碰（"恢复初值"绝不能去盖设备上的值）
            · 内部变量 → 回变量表初值；勾了「保持」的连存档一起改掉（否则重启又带回来）
            · clear=True → 内部变量整份清空，下次下发变量表按初值重建

        这样接不接 PLC，"内部变量：恢复初值"这个入口都在（前端右键菜单）。
        """
        changed = {}
        with self._lock:
            for name, rec in list(self._vars.items()):
                if not rec.get("internal"):
                    continue
                if clear:
                    del self._vars[name]
                    _retain.forget(name)
                    continue
                if "default" in rec:
                    rec["value"] = rec["default"]
                if rec.get("retain"):
                    _retain.set(name, rec["value"])
                changed[name] = rec.get("value")
        return changed

    # ── 写 ──
    def _mark_down(self, e):
        """一次**链路**失败 = 这条链路现在不通 → 标掉线、把 socket 关掉。

        为什么要当场标：`self.online` 平时由轮询线程维护（每 poll_ms 一次），
        设备刚断的那一下轮询还没跑到，这期间每一笔写都会各自去等一个 socket 超时
        （默认 1.5 秒）。脚本一个周期写十几个量时，这些超时叠起来就是
        「断开之后前面数据还在下发，一条条弹失败弹完才停」。
        标掉线之后 `_ensure_writable()` 会把后面的写**立刻**拒掉，队列当场清空。
        """
        with self._lock:
            self.online = False
            self.last_error = str(e)
        try:
            self._cli.close()
        except Exception:                                       # noqa: BLE001
            pass

    def _ensure_writable(self):
        """设备现在通不通？不通就**连试都不试**，立刻拒绝这次下发。

        判据是**轮询线程说了算的 online** —— 它才是"这一刻通不通"的权威，
        而不是"这次写请求"（一次写失败可能只是那一个地址/那一下抖动）。

        ⚠ `last_ok <= 0` 表示"接上以后一次都还没读成功过"：那种情况下照旧去试，
          不能因为 online 还是初值 False 就把**首次连接后的第一笔写**拒掉
          （前端那道"连上先读一遍"的门已经保证了正常流程，这里是兜底）。
        """
        if self.online or self.last_ok <= 0:
            return
        raise modbus.ModbusError(
            f"{self.host}:{self.port} 已断开（{self.last_error or '连不上'}），这次没有下发",
            transport=True)

    def write(self, name, value):
        # 数组元素写法 `arrw[3]`：只写那一个元素占的寄存器（地址往后挪 i×每元素字数），
        # 其余寄存器一个都不碰 —— 和 OPC UA 侧的「读改写整段」是同一个语义，前端不用改
        name_s = str(name or "")
        elem_idx = None
        base_name = name_s
        with self._lock:
            v = self._vars.get(name_s)
        if v is None:
            # ⚠ 先按**整名**找变量，找不到才当「数组的第 n 个元素」解析：
            #   数组被「展开成单个变量」之后变量名本身就长这样（arrw[1]），
            #   不做这一步的话，展开出来的元素一个都写不进去（报"arrw 未声明"）。
            m = re.match(r"^(.+)\[(\d+)\]$", name_s)
            if m:
                base_name, elem_idx = m.group(1), int(m.group(2))
                with self._lock:
                    v = self._vars.get(base_name)
        if not v:
            raise ValueError(f"变量 {base_name} 未在变量表声明")
        # 内部变量（地址留空）：不碰 PLC，值就存在后端（勾了「保持」的顺带落盘）。
        # ⚠ 这里**不能只看 internal 标记**：老版本的 vars.json / 内存模式落盘的档案里没有这个键，
        #   只看它就会把内部变量当成"地址没填好的 PLC 变量"，写值直接报
        #   「变量 _demoT 的地址 '' 无效：未填写」—— 界面上就是一条刺眼的「下发失败」，
        #   而它其实根本不该往 PLC 发。所以**地址本身才是判据**，标记只是补充。
        if v.get("internal") or not (v.get("address") or "").strip():
            # 内部变量：不碰 PLC，值就存在后端（勾了「保持」的顺带落盘）
            with self._lock:
                v["value"] = value
            if v.get("retain"):
                _retain.set(base_name, value)
            return True
        if not v.get("parsed"):
            raise ValueError(f"变量 {base_name} 的地址 {v.get('address')!r} 无效：{v.get('addr_error') or '未填写'}")
        # 掉线期间**连试都不试**：立刻拒绝，不去等 socket 超时（见 _mark_down 的说明）
        self._ensure_writable()
        if not self._cli.connected:
            try:
                self._connect()
            except (OSError, modbus.ModbusError) as e:
                self._mark_down(e)
                raise
        before = self._cli.fc16_fallbacks
        vtype = v.get("type", "uint")
        try:
            if elem_idx is not None and str(vtype).lower().endswith("[]"):
                elem = str(vtype)[:-2].lower()
                ew = modbus.elem_words(elem)
                a = v["parsed"]
                sub = modbus.Address(a.area, a.offset + elem_idx * ew, ew, kind=a.kind)
                self._cli.write_var(sub, value, elem, self.word_order)
            else:
                self._cli.write_var(v["parsed"], value, vtype, self.word_order,
                                    length=v.get("len") or None)
        except modbus.ModbusError as e:
            # ⚠ 只有**链路**失败才标掉线：`%IW`/`%IX` 只读、从站异常码这些是"这个变量写不了"，
            #   设备本身好好的 —— 标了会把后面所有写一起挡掉（白挡一个轮询周期）。
            if getattr(e, "transport", False):
                self._mark_down(e)
            raise
        self.writes += 1
        if self._cli.fc16_fallbacks > before:
            self.last_error = ""            # 退回落是正常兜底，不算错，但要留个痕
            print(f"[plc] 从站不支持 FC16（写多寄存器），{v.get('address')} 已退回逐个 FC06 写")
        with self._lock:
            if elem_idx is None:
                v["value"] = value
            else:
                cur = v.get("value")
                arr = list(cur) if isinstance(cur, list) else []
                while len(arr) <= elem_idx:
                    arr.append(0)
                arr[elem_idx] = value
                v["value"] = arr
        # HMI 写过的变量**一直留在采集范围里**：否则它一旦不在本页采集范围内就再也不读了，
        # 界面上会永远停在下发的那个值上（PLC 已经变回去了，界面还显示旧值 —— 实测踩过）
        seen = getattr(self, "_written", None)
        if seen is None:
            seen = self._written = set()
        seen.add(base_name)

    # ── 轮询 ──
    def _connect(self):
        if self._cli.connected:
            return
        try:
            self._cli.connect()
        except OSError as e:
            # 连不上是**链路**失败（不是地址问题）：包成 ModbusError 并打上 transport 标记，
            # 让上面 write() 的 except 能认出来 —— 原样抛 OSError 的话它会被当成"未知错误"，
            # 前端就分不出"设备断了、别再发了"和"这个变量写不了"。
            raise modbus.ModbusError(f"连不上 {self.host}:{self.port} —— {e}", transport=True) from e
        self.online = True
        self.last_error = ""
        print(f"[plc] 已连接 {self.host}:{self.port} 站号 {self.unit}")

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._cli.close()

    def _plan(self):
        """把「本页要采的」地址按区域合并成连续区间：[(area, start, count, [(name, parsed, vtype, vlen)])]

        连续地址合并成一次读（FC03 一次读多个寄存器）—— %MW100/102/104 三个变量
        以前是 3 次请求，现在 1 次读回 5 个字就都有了。间隔 ≤ 8 个字就并进同一块，
        块内最多 125 个字（Modbus 单次上限）。
        """
        active = getattr(self, "_active", None)
        written = getattr(self, "_written", None) or set()
        with self._lock:
            items = [(n, v["parsed"]) for n, v in self._vars.items()
                     if v.get("parsed") and (active is None or n in active or n in written)]
        plan = []
        for area in (modbus.HOLDING, modbus.INPUT_REG):
            regs = sorted([(p.offset, n, p, (self._vars.get(n) or {}).get("type", "uint"),
                            (self._vars.get(n) or {}).get("len") or None)
                           for n, p in items if p.area == area and not p.is_bit],
                          key=lambda x: x[0])
            block = None
            for off, name, p, vtype, vlen in regs:
                # ⚠ 字数按「类型」算（real=2、lreal=4、string 按字符数），不能只看地址写法：
                # 地址写 %MW100 而类型是 real 时，只读 1 个字会解出 6.4757e-320 这种鬼数
                span = modbus.words_for(vtype, p.words, vlen)
                end = off + span
                if block and off - (block[1] + block[2]) <= 8 and (end - block[1]) <= 125:
                    block[2] = end - block[1]
                    block[3].append((name, p, vtype, vlen))
                else:
                    block = [area, off, end - off, [(name, p, vtype, vlen)]]
                    plan.append(block)
        for area in (modbus.COIL, modbus.DISCRETE):
            bits = sorted([(p.offset, n, p) for n, p in items if p.area == area], key=lambda x: x[0])
            if bits:
                lo = bits[0][0]
                # ⚠ %QW 是「16 个位拼成的字」（见 addr_model.py）：它占的位范围要按 p.bits 算进去，
                #   只按 offset 算的话块只盖住第一位，拼出来的字高 15 位全丢。
                hi = max(p.offset + max(1, p.bits) - 1 for _, _, p in bits)
                if hi - lo <= 512:
                    plan.append([area, lo, hi - lo + 1,
                                 [(n, p, (self._vars.get(n) or {}).get("type", "uint"),
                                   (self._vars.get(n) or {}).get("len") or None) for _, n, p in bits]])
        return plan

    def _poll_loop(self):
        while not self._stop.is_set():
            try:
                # 「不在运行态就不通讯」：没人打开运行页面（或都退出了/超时了）时，
                # 连都不连、一个字节都不发 —— 现场要求：编辑画面时别占着 PLC 通讯口。
                if not poll_gate.wanted():
                    self._stop.wait(0.2)
                    continue
                if not self._cli.connected:
                    self._connect()
                plan = self._plan()
                self._blocks = len(plan)
                if not plan:
                    # 本页没用变量（采集范围空）→ 什么都不读也"成功"，PLC 断了发现不了。
                    # 保活：探一个寄存器/线圈，读不动就按掉线处理（界面上要能提示）
                    self._cli.read_registers(0, 1, modbus.FC_READ_HOLDING)
                    self.reads += 1
                    self.last_ok = time.time()
                    self.online = True
                    self._stop.wait(self.poll_ms / 1000)
                    continue
                for area, start, count, members in plan:
                    if self._stop.is_set():
                        return
                    if area == modbus.HOLDING:
                        words = self._cli.read_registers(start, count, modbus.FC_READ_HOLDING)
                    elif area == modbus.INPUT_REG:
                        words = self._cli.read_registers(start, count, modbus.FC_READ_INPUT)
                    else:
                        fc = modbus.FC_READ_COILS if area == modbus.COIL else modbus.FC_READ_DISCRETE
                        bits = self._cli.read_bits(start, count, fc)
                        words = None
                    self.reads += 1
                    changed = []
                    with self._lock:
                        for name, p, vtype, vlen in members:
                            v = self._vars.get(name)
                            if not v:
                                continue
                            # %MX 内存位：与 %MW 同一片内存，从那个字里取第 p.bit 位
                            #   ⚠ 这里必须先于下面的「整字解码」—— 否则会落到 decode_value 的
                            #   bool 分支，而那里 bit 传的是 None（当 bit0 用），结果「不管置的是哪一位，
                            #   读回来都是第 0 位」：%MX0.0 那些看着正常，%MX1.x 以上全错。
                            if words is not None and p.bit is not None and not p.bits:
                                w = words[p.offset - start] if 0 <= p.offset - start < len(words) else 0
                                val = bool((w >> p.bit) & 1)
                            elif words is not None and not p.is_bit:
                                # 字数和 _plan 用同一个函数算，读/写/轮询三处必须一致
                                cnt = modbus.words_for(vtype or v.get("type"), p.words, vlen)
                                seg = words[p.offset - start: p.offset - start + cnt]
                                try:
                                    val = modbus.decode_value(seg, vtype or v.get("type"), self.word_order,
                                                              byte=p.byte, bit=None, length=vlen)
                                except ValueError as e:
                                    # 声明和读数对不上时不要塞垃圾值进界面，报到状态里让人看见
                                    self.last_error = f"{name}：{e}"
                                    continue
                            elif p.bits:                            # %QW：16 个位拼成的字
                                nw = modbus.words_for(vtype or v.get("type") or "uint", p.words, vlen)
                                seg = bits[p.offset - start: p.offset - start + p.bits * nw]
                                raw = [modbus.bits_to_word(seg[i * 16:(i + 1) * 16]) for i in range(nw)]
                                try:
                                    val = modbus.decode_value(raw, vtype or v.get("type") or "uint",
                                                              self.word_order, length=vlen)
                                except ValueError as e:
                                    self.last_error = f"{name}：{e}"
                                    continue
                            else:                                   # 线圈/离散输入（单个 bool）
                                idx = p.offset - start
                                val = bits[idx] if 0 <= idx < len(bits) else False
                            if v.get("value") != val and not (isinstance(val, float) and isinstance(v.get("value"), float)
                                                              and abs(val - v["value"]) < 1e-9):
                                v["value"] = val
                                changed.append((name, val))
                    _emit_changed(changed, self._on_changes, self._on_change)
                self.last_ok = time.time()
                self.online = True            # 这一轮读成功 = 通讯正常
                # 低频心跳（60 秒一条）：让日志里能看出轮询一直在跑，而不是"读了一次就不读了"
                if self.last_ok - getattr(self, "_beat_at", 0.0) >= 60:
                    self._beat_at = self.last_ok
                    with self._lock:
                        n_act = len(self._active) if self._active is not None else len(self._vars)
                    print(f"[poll] Modbus 本页采 {n_act} 变量 / {self._blocks} 块，"
                          f"累计读 {self.reads} 次，在线 {self.online}")
            except modbus.ModbusError as e:
                self.errors += 1
                self.last_error = str(e)
                self.online = False
                self._cli.close()
                time.sleep(min(2.0, self.poll_ms / 1000 * 5))
            except Exception as e:                                  # noqa: BLE001
                self.errors += 1
                self.last_error = str(e)
                self.online = False
                self._cli.close()
                time.sleep(1.0)
            self._stop.wait(self.poll_ms / 1000)

    def plan_count(self):
        """现在这套采集范围会合并成几次读（前端状态栏「本页 N 变量/M 块」用）。
        注意不能读 self._blocks：那是上一轮轮询留下的，刚改完范围时会差一拍。"""
        try:
            return len(self._plan())
        except Exception:                              # noqa: BLE001
            return self._blocks

    def status(self):
        with self._lock:
            bad = [n for n, v in self._vars.items() if v.get("address") and not v.get("parsed")]
            n_vars = len(self._vars)
            active = None if self._active is None else len(self._active)
            scoped = self._active is not None
        return {
            "mode": "plc", "host": self.host, "port": self.port, "unit": self.unit,
            "poll_ms": self.poll_ms, "word_order": self.word_order,
            "word_order_cn": modbus.WORD_ORDER_CN.get(self.word_order, self.word_order),
            "online": bool(self.online and self._cli.connected),
            "last_error": self.last_error,
            "last_ok": self.last_ok,
            "reads": self.reads, "writes": self.writes, "errors": self.errors,
            "fc16_fallbacks": getattr(self._cli, "fc16_fallbacks", 0),
            "vars": n_vars, "bad_address": bad[:10],
            # 按页采集：active = 本页实际在采几个变量，blocks = 合并成几次读（连续地址并成一块）
            "scoped": scoped, "active": n_vars if active is None else active, "blocks": self._blocks,
        }

    def order_candidates(self, address="%MW0", vtype="real", length=None):
        """只读：把某个地址按 4 种字序各解一遍，现场用来判断对方 PLC 是哪种"""
        if not self._cli.connected:
            self._connect()
        return self._cli.read_order_candidates(address, vtype, length)

# OPC UA 数据源类（没装 asyncua 时 opcua.py 自己会把 AVAILABLE 置 False，类仍在）
OpcUaSource = getattr(opcua, "OpcUaSource", None) if opcua else None

_REMOTE_SRC = tuple(c for c in (PlcSource, OpcUaSource) if c is not None)

_plc_cfg = {"mode": "memory", "protocol": "modbus", "ip": "127.0.0.1", "port": 502, "unit": 1,
            "poll_ms": 200, "word_order": "cdab",
            # OPC UA 专有
            "endpoint": "opc.tcp://127.0.0.1:4840", "security": "none",
            "username": "", "password": "", "default_ns": 4}



def _protocol_of(cfg=None):
    p = str((cfg or _plc_cfg).get("protocol") or "modbus").strip().lower()
    return "opcua" if p in ("opcua", "ua", "opc-ua", "opcua_ua") else "modbus"



def _load_plc_cfg():
    global _plc_cfg
    if PLCFG_FILE.exists():
        try:
            _plc_cfg.update(json.loads(PLCFG_FILE.read_text(encoding="utf-8")))
        except Exception:                                       # noqa: BLE001
            pass



def _save_plc_cfg():
    try:
        PLCFG_FILE.write_text(json.dumps(_plc_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:                                      # noqa: BLE001
        print(f"[warn] PLC 配置保存失败: {e}")



# 模块一加载就把上次保存的 PLC 配置读进内存（server.py 直接跑 / hmi_desktop.py import 都覆盖到）。
# 不读的话 _plc_cfg 永远是内存默认值（mode=memory），_autoconnect_saved_plc() 的
# 「mode == 'plc'」判断永远过不去 → 开机自动连上次配好的服务器就失效，得每次手动点连接。
_load_plc_cfg()



def _on_plc_change(name, value):
    """PLC 值变化 → 广播给所有在线前端（与 /api/vars 写入同一通道）"""
    broadcast({"name": name, "value": value})



def _on_plc_changes(changed):
    """一批 PLC 值变化 → **一条** SSE 消息（{"vars": {...}}）。

    为什么要有批量这条：一次轮询 500 个变量都变了，按老路子要发 500 条 SSE 消息，
    浏览器那边就是 500 次 JSON.parse + 500 次事件派发 —— 光这一项就能吃掉几毫秒，
    而且和控件数无关地白白浪费。合成一条之后前端一次性 applyRemote。"""
    if not changed:
        return
    if len(changed) == 1:
        name, value = changed[0]
        broadcast({"name": name, "value": value})
        return
    broadcast({"vars": {n: v for n, v in changed}})



def _emit_changed(changed, on_changes, on_change):
    """把一批变化交给回调：优先批量回调，没有就退回逐条（老接口仍可用）"""
    if not changed:
        return
    if on_changes:
        on_changes(changed)
        return
    if on_change:
        for name, val in changed:
            on_change(name, val)
