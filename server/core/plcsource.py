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

# 地址「写法不属于当前地址模型」时 addr_model 抛的异常（INVT 工程里写 D100、TS600 里写 %MX0.0…）。
# 这类不是填错，而是「协议还没选对」：先当**内部变量**挂着 —— 不采集、不下发、不报红，
# 用户把协议改对之后下一轮 declare 自动恢复正常采集。
try:
    _UnsupportedAddress = modbus.UnsupportedAddress
except AttributeError:                     # 兼容还没加这个类的旧 addr_model
    class _UnsupportedAddress(ValueError):
        pass

# 地址模型是进程级全局量：连接对话框「测试连接」和变量表地址解析都会临时切到请求里的模型再切回。
# 这些临时切换必须串行（api._ep_plc 的 test/orders/parse 三个分支、datasource.plc_connect），
# 否则两个请求交叉执行会拿错模型解析地址（ThreadingHTTPServer 是多线程的）。
_addr_model_lock = threading.RLock()


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
        self.poll_ms = max(1, int(poll_ms))
        # 实测节拍（状态栏给现场看）：round_ms = 读完一轮花的时间；cycle_ms = 一轮到下一轮的实际间距。
        # poll_ms 是**目标周期**：一轮读不完就接着读（不排队、不补跑），所以 cycle_ms = max(poll_ms, round_ms)。
        self.round_ms = 0.0
        self.cycle_ms = 0.0
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

        地址解析结果按**（地址, 类型, 地址模型）**缓存：变量表上万时，每改一个变量都要重新解析全部地址
        （10000 次 parse_address ≈ 上百毫秒），缓存后只有真变了的地址才重解析。
        ⚠ 类型必须进缓存键：同一个地址在 TS600 下「bool」和「int」解析到的是**不同区**
          （T5 的 bool → 线圈 49157，int → 寄存器 57349），只按地址串缓存会串。
        ⚠ 模型也必须进缓存键：运行中可能切模型（测试连接会临时切、改协议也会切），
          否则切完还是拿到旧模型的解析结果。
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
                old = self._vars.get(name) or {}
                vlen = v.get("len") or old.get("len") or 0
                parsed = None
                perr = ""
                note = ""
                if addr:
                    # ⚠ 模型也要进缓存键：解析结果取决于当前 addr_profile，运行中可能切
                    #   （连接对话框「测试连接」会临时切、改协议时也会切）；只用 (地址,类型)
                    #   缓存的话，切模型后同一个 D100 还会拿到旧模型的解析结果/内部变量标记。
                    ckey = (addr, vtype, modbus.get_profile())
                    hit = cache.get(ckey)
                    if hit is not None:
                        parsed, perr, note = hit
                    else:
                        try:
                            parsed = modbus.parse_address(addr, vtype=vtype)
                            # TS600 的寄存器/位区都是**分段**的（D/R/T/C/Z、M/S/X/Y/T/C 各占一段，
                            # 段与段之间是空洞）。类型决定占几个字：real=2、string 按长度……
                            # 超出区末从站会回异常码，不如声明时就报成地址错误（界面上能看见）。
                            need = modbus.words_for(vtype, parsed.words, vlen)
                            limit = modbus.region_end(parsed)
                            if limit is not None and parsed.offset + need - 1 > limit:
                                raise ValueError(
                                    f"地址 {addr}（{vtype}）占 {need} 个字，"
                                    f"{modbus.AREA_CN.get(parsed.area, parsed.area)} 区只到 "
                                    f"{limit}，越区了")
                        except _UnsupportedAddress as e:
                            # 写法与当前地址模型不匹配（INVT 工程里写 D100、TS600 里写 %MX0.0…）：
                            # 不是错配置 —— 先当**内部变量**挂着，不采集、不下发、不报红；
                            # 用户把协议/地址模型改对之后，下一轮 declare 自动恢复正常采集。
                            note = (str(e) or "").strip() or (
                                f"地址 {addr} 的写法不符合当前地址模型，按内部变量处理")
                            perr = ""
                            parsed = None
                        except ValueError as e:
                            perr = str(e)
                            parsed = None
                        cache[ckey] = (parsed, perr, note)
                # 地址留空 = **内部变量**：不读不写 PLC，值由 HMI 自己维护（见 RetainStore）。
                # ⚠ 以前这种变量被当成"地址没填好的 PLC 变量"：写它会报
                #   「地址 '' 无效：未填写」，界面上就是一条「下发失败」——
                #   于是"接上真 PLC 之后，HMI 自己的内部变量全废了"。
                # 写法不匹配当前模型的（note 非空）同理：先按内部变量跑，不挡着工程。
                internal = not addr or bool(note)
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
                        "address": addr,             # 不匹配的留原写法，变量表里能看出是哪条
                        "value": value,
                        "default": v.get("value"),   # 「恢复初值」按它还原
                        "parsed": None,
                        "addr_error": "",
                        "addr_note": note,           # 为什么被当成内部变量（给变量表/状态栏显示）
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
                    "addr_note": "",
                    "internal": False,
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
            out = {}
            for k, v in self._vars.items():
                m = {"address": v.get("address", ""), "type": v.get("type", ""),
                     # internal：这个变量不跟 PLC 通讯（地址空，或写法跟当前模型不匹配）
                     "internal": bool(v.get("internal"))}
                note = v.get("addr_note") or ""
                if note:
                    m["addr_note"] = note
                out[k] = m
            return out

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
        if not self._cli.connected:
            self._connect()
        before = self._cli.fc16_fallbacks
        vtype = v.get("type", "uint")
        if elem_idx is not None and str(vtype).lower().endswith("[]"):
            elem = str(vtype)[:-2].lower()
            ew = modbus.elem_words(elem)
            a = v["parsed"]
            sub = modbus.Address(a.area, a.offset + elem_idx * ew, ew, kind=a.kind)
            self._cli.write_var(sub, value, elem, self.word_order)
        else:
            self._cli.write_var(v["parsed"], value, vtype, self.word_order,
                                length=v.get("len") or None)
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
        self._cli.connect()
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
        bit_blocks = []
        ts600 = modbus.get_profile() == "ts600-modbus-tcp"
        for area in (modbus.COIL, modbus.DISCRETE):
            bits = sorted([(p.offset, n, p) for n, p in items if p.area == area], key=lambda x: x[0])
            block = None            # [area, lo, hi, [(name, parsed, vtype, vlen)]]
            for off, n, p in bits:
                vtype = (self._vars.get(n) or {}).get("type", "uint")
                vlen = (self._vars.get(n) or {}).get("len") or None
                # ⚠ %QW 是「16 个位拼成的字」（见 addr_model.py）：它占的位范围要按 p.bits 算进去，
                #   只按 offset 算的话块只盖住第一位，拼出来的字高 15 位全丢。
                hi = off + max(1, p.bits) - 1
                zone_lo = None
                if ts600:
                    z = modbus.bit_zone(off)
                    if z:
                        zone_lo, zone_hi = z
                        hi = min(hi, zone_hi)
                # ⚠ 位区必须**分段**合并，不能像寄存器那样「整页合成一块、超 512 位就丢掉」：
                #   TS600 的 M(0x0000)/S(0x8000)/X(0xA000)/Y(0xB000) 隔着几万位，
                #   页面上只要同时有 M 和 Y，跨距就 >512，以前整块被丢弃 —— 线圈一个都不读，
                #   界面上 M/Y/S 永远停在初值（写下去亮着、PLC 关了也不灭，就是这个）。
                #   另外 TS600 一次 FC01/FC02 跨区（M32767 连到 S0）会被整块判 02 异常，
                #   所以只在**同一个元件区**里合并。
                if block is not None and block[4] == zone_lo:
                    lo, cur_hi = block[1], block[2]
                    if off - cur_hi - 1 <= 64 and max(cur_hi, hi) - lo + 1 <= 2000:
                        block[2] = max(cur_hi, hi)
                        block[3].append((n, p, vtype, vlen))
                        continue
                block = [area, off, hi, [(n, p, vtype, vlen)], zone_lo]
                bit_blocks.append(block)
                plan.append(block)
        for b in bit_blocks:            # 去掉 zone 标记，hi → count（轮询按 count 读，FC01 的 count 是位个数）
            b[2] = b[2] - b[1] + 1
            del b[4]
        return plan

    def _pace(self, t0):
        """按 poll_ms 定节拍 + 记实测周期（状态栏「实测 xx ms」就是它）。

        现场口径（m04917）：轮询周期最小可以填 1ms —— 但 **1ms 只是「尽可能快」的意思**，
        不是真能 1ms 读一轮：Modbus 一帧往返就要 1.5~2ms（TS600 实测），一页 11 块一圈约 20ms。
        所以 poll_ms 小于一轮耗时 = 读完立刻开始下一轮（不 sleep、不排长队）。
        """
        spent = time.perf_counter() - t0
        wait = self.poll_ms / 1000.0 - spent
        if wait > 0:
            self._stop.wait(wait)
            cyc_ms = (spent + wait) * 1000.0
        else:
            cyc_ms = spent * 1000.0
        self.round_ms = round(spent * 1000.0, 1)
        # 平滑一下（现场看的是稳定值，不是某一轮的抖动）
        self.cycle_ms = round(cyc_ms, 1) if not self.cycle_ms else round(self.cycle_ms * 0.7 + cyc_ms * 0.3, 1)

    def _poll_loop(self):
        while not self._stop.is_set():
            t_round = time.perf_counter()
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
                    self._pace(t_round)
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
                # 断线重连退避：至少 200ms（poll_ms 可以填到 1ms，别把重连也打成忙等）
                time.sleep(min(2.0, max(0.2, self.poll_ms / 1000 * 5)))
            except Exception as e:                                  # noqa: BLE001
                self.errors += 1
                self.last_error = str(e)
                self.online = False
                self._cli.close()
                time.sleep(1.0)
            self._pace(t_round)

    def plan_count(self):
        """现在这套采集范围会合并成几次读（前端状态栏「本页 N 变量/M 块」用）。
        注意不能读 self._blocks：那是上一轮轮询留下的，刚改完范围时会差一拍。"""
        try:
            return len(self._plan())
        except Exception:                              # noqa: BLE001
            return self._blocks

    def status(self):
        with self._lock:
            # bad_address 只留**真错误**（认不出/越界/类型不配）；写法跟当前模型不匹配的
            # 变量已经按内部变量处理了，不算错误（用户改协议后自动恢复采集）
            bad = [n for n, v in self._vars.items()
                   if v.get("address") and not v.get("parsed") and not v.get("internal")]
            # 地址写了、但写法不属于当前协议/模型 → 内部变量；变量表据此显示原因
            internal_by_addr = [{"name": n, "address": v.get("address", ""),
                                 "note": v.get("addr_note") or "地址写法不符合当前地址模型"}
                                for n, v in self._vars.items()
                                if v.get("internal") and (v.get("address") or "").strip()]
            n_vars = len(self._vars)
            active = None if self._active is None else len(self._active)
            scoped = self._active is not None
        return {
            "mode": "plc", "protocol": "modbus",
            "host": self.host, "port": self.port, "unit": self.unit,
            "poll_ms": self.poll_ms, "word_order": self.word_order,
            # 实测节拍：cycle_ms = 一轮到下一轮的实际间距（poll_ms 填 1 时它 ≈ 读一轮的耗时）
            "round_ms": self.round_ms, "cycle_ms": self.cycle_ms,
            "word_order_cn": modbus.WORD_ORDER_CN.get(self.word_order, self.word_order),
            # 地址模型：同一份变量表按哪种 PLC 的地址规则解析（invt-modbus-slave / ts600-modbus-tcp）
            "addr_profile": modbus.get_profile(),
            "addr_profile_cn": modbus.profile_cn(),
            "online": bool(self.online and self._cli.connected),
            "last_error": self.last_error,
            "last_ok": self.last_ok,
            "reads": self.reads, "writes": self.writes, "errors": self.errors,
            "fc16_fallbacks": getattr(self._cli, "fc16_fallbacks", 0),
            "vars": n_vars, "bad_address": bad[:10],
            "internal_by_addr": internal_by_addr[:50],
            # 按页采集：active = 本页实际在采几个变量，blocks = 合并成几次读（连续地址并成一块）
            "scoped": scoped, "active": n_vars if active is None else active, "blocks": self._blocks,
        }

    def order_candidates(self, address=None, vtype="real", length=None):
        """只读：把某个地址按 4 种字序各解一遍，现场用来判断对方 PLC 是哪种

        不传地址 = 用当前地址模型的默认地址（invt → %MW0，TS600 → D0）。
        ⚠ 默认值要在**调用时**取，不能在函数定义时求值：模型是连接时才切过去的。
        """
        if not address:
            address = modbus.default_address()
        if not self._cli.connected:
            self._connect()
        return self._cli.read_order_candidates(address, vtype, length)

# OPC UA 数据源类（没装 asyncua 时 opcua.py 自己会把 AVAILABLE 置 False，类仍在）
OpcUaSource = getattr(opcua, "OpcUaSource", None) if opcua else None

_REMOTE_SRC = tuple(c for c in (PlcSource, OpcUaSource) if c is not None)

_plc_cfg = {"mode": "memory", "protocol": "modbus", "ip": "127.0.0.1", "port": 502, "unit": 1,
            "poll_ms": 200, "word_order": "cdab",
            # 地址模型（server/addr_model.py 的 PROFILES id）：invt-modbus-slave / ts600-modbus-tcp
            "addr_profile": "invt-modbus-slave",
            # OPC UA 专有
            "endpoint": "opc.tcp://127.0.0.1:4840", "security": "none",
            "username": "", "password": "", "default_ns": 4}



# 协议下拉恒为三项：①Modbus TCP（INVT 写法 %MW…）②TS600 TCP（D/M/X/Y/S/T/C/R/Z 元件写法）
# ③OPC UA。落盘口径：TS600 也是 Modbus TCP —— protocol 存 "modbus"，地址模型存
# "ts600-modbus-tcp"（前端老配置里可能写成 ts600 / ts / ts600_tcp 等别名，这里统一收）。
_TS_PROTOCOLS = ("ts600", "ts", "modbus_ts", "modbus-ts", "ts600_tcp", "ts600-tcp",
                 "ts600_modbus_tcp", "ts600-modbus-tcp")
_OPCUA_PROTOCOLS = ("opcua", "ua", "opc-ua", "opc_ua", "opcua_ua")
_MODBUS_PROTOCOLS = ("", "modbus", "modbus_tcp", "modbus-tcp", "modbus tcp")


def _norm_protocol_name(raw):
    """协议名归一：ts* / opcua 别名 / modbus 都认；不认识的返回小写原样（调用方负责报错）。"""
    p = str(raw or "").strip().lower()
    if p in _TS_PROTOCOLS:
        return "ts600"
    if p in _OPCUA_PROTOCOLS:
        return "opcua"
    if p in _MODBUS_PROTOCOLS:
        return "modbus"
    return p


def _is_ts_protocol(raw):
    """这个协议名是不是「Modbus TCP + TS600 地址模型」"""
    return _norm_protocol_name(raw) == "ts600"


def _protocol_of(cfg=None):
    """实际走哪条链路：modbus / opcua（TS600 也走 modbus，只是地址模型不同）"""
    return "opcua" if _norm_protocol_name((cfg or _plc_cfg).get("protocol")) == "opcua" else "modbus"



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
