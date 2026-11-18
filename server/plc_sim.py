#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
plc_sim.py — 模拟 PLC（Modbus TCP 从站）+ 网页调试台
======================================================
零第三方依赖（标准库 socket + http.server）。

一条命令启动：
    python server/plc_sim.py                     # Modbus TCP 从站 :502，网页 :8899
    python server/plc_sim.py --port 15020 --web-port 8899 --no-browser
    python server/plc_sim.py --import-csv 变量表.csv   # 按变量表的地址预置数据

网页里可以直接改数据（%MW 字 / %MD 双字 DINT·REAL / %QX·%IX 位），
还能给某个字打开「自动正弦」，方便看采集/波形/通讯是否正常。
从站本身按手册实现：FC01/02/03/04/05/06/0F/10，地址无偏移（%MW96 = 寄存器96）。
"""
import argparse
import csv
import json
import math
import os
import socket
import socketserver
import struct
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from modbus import (parse_address, decode_value, encode_value, HOLDING, COIL, DISCRETE, INPUT_REG,  # noqa: E402
                    AREA_CN, words_for, region_end, set_profile, get_profile, profile_cn, profiles)

# 「设备在读什么」统计的边界：现场也够用，同时给内存留个底
MAX_READ_ADDRS = 4096          # 单个主站单个区域最多记多少个地址
MAX_READ_PEERS = 8             # 最多记几个主站（超了淘汰最久没动静的那个）
MAX_READ_RUNS = 24             # 每个区域最多列几段地址区间（网页上列全了反而看不清）


def _ranges(counts, max_runs=MAX_READ_RUNS):
    """地址列表压成区间：{100,101,105} → [[100,101],[105,105]]；段数超了截断并标记"""
    runs, start, prev = [], None, None
    for a in sorted(counts):
        if start is None:
            start = prev = a
        elif a == prev + 1:
            prev = a
        else:
            runs.append([start, prev])
            start = prev = a
    if start is not None:
        runs.append([start, prev])
    return runs[:max_runs], len(runs) > max_runs


# ─────────────────────────────────────────────
#  数据区：位/字/双字都在这里，网页和从站共享
# ─────────────────────────────────────────────
class DataStore:
    def __init__(self):
        self.lock = threading.RLock()
        self.holding = {}      # %MW：寄存器号 -> 0..65535
        self.input_reg = {}    # %IW
        self.coils = {}        # %QX：位号 -> bool
        self.discrete = {}     # %IX
        self.auto = {}         # 寄存器号 -> {"kind":"sine|ramp|random","period":s,"amp":,"mid":,"t0":}
        self.log = []          # 最近请求（网页上看通讯是否正常）
        self.stats = {"rx": 0, "tx": 0, "errors": 0}
        self.reads = {}        # (主站IP, 区域) -> {地址: 读次数}：设备到底在读哪些地址
        self.read_seen = {}    # 主站IP -> 最后一次读的时间

    # -- 字 --
    def get_w(self, addr):
        with self.lock:
            return self.holding.get(addr, 0) & 0xFFFF

    def set_w(self, addr, val):
        with self.lock:
            self.holding[addr] = int(val) & 0xFFFF

    def set_words(self, addr, vals):
        """一帧多寄存器写必须整体生效：逐个 set_w 会让读线程看到「半帧」
        （例如 REAL 的低字已更新、高字还是旧值 → 读到莫名其妙的数）。"""
        with self.lock:
            for i, v in enumerate(vals):
                self.holding[addr + i] = int(v) & 0xFFFF

    def set_word_bit(self, addr, bit, on):
        """%MX 位（%MW 的第 bit 位）：**先读回当前字 → 只改这一位 → 再整字写回**，
        同字其他 15 位一个都不动。和 HMI 侧写 %MX 的语义一致（server/modbus.py 的
        write_var 也是读改写）；在从站里做是为了原子 —— 网页控制台和 HMI 同时写同一个字
        也不会互相盖（先读后写中间不放手）。返回 (旧字, 新字) 供日志写清楚。"""
        with self.lock:
            old = self.holding.get(addr, 0) & 0xFFFF
            new = ((old | (1 << bit)) if on else (old & ~(1 << bit))) & 0xFFFF
            self.holding[addr] = new
            return old, new

    def get_iw(self, addr):
        with self.lock:
            return self.input_reg.get(addr, 0) & 0xFFFF

    def set_iw(self, addr, val):
        with self.lock:
            self.input_reg[addr] = int(val) & 0xFFFF

    def get_bit(self, area, addr):
        with self.lock:
            d = self.coils if area == COIL else self.discrete
            return bool(d.get(addr, False))

    def set_bit(self, area, addr, val):
        with self.lock:
            d = self.coils if area == COIL else self.discrete
            d[addr] = bool(val)

    def set_bits(self, area, addr, vals):
        """一帧多线圈写同样要整体生效（理由同 set_words）"""
        with self.lock:
            d = self.coils if area == COIL else self.discrete
            for i, v in enumerate(vals):
                d[addr + i] = bool(v)

    def add_log(self, text):
        with self.lock:
            self.log.append(f"{time.strftime('%H:%M:%S')}  {text}")
            if len(self.log) > 200:
                del self.log[:100]

    # -- 「设备在读什么」：主站读走一个地址就记一笔 --
    def note_read(self, ip, area, addr, qty):
        """记下哪个主站读走了哪些地址 —— 网页上直接显示对方读了多少个 %MW/%IW/%QX/%IX，
        对着工程变量表核：个数少了就是有变量没被读（地址写错 / 没勾轮询）。"""
        with self.lock:
            key = (ip, area)
            m = self.reads.get(key)
            if m is None:
                peers = {k[0] for k in self.reads}
                if ip not in peers and len(peers) >= MAX_READ_PEERS:
                    oldest = min(self.read_seen, key=lambda p: self.read_seen.get(p, 0))
                    for k in [k for k in self.reads if k[0] == oldest]:
                        self.reads.pop(k, None)
                    self.read_seen.pop(oldest, None)
                m = self.reads[key] = {}
            self.read_seen[ip] = time.time()
            for a in range(addr, addr + qty):
                if a not in m and len(m) >= MAX_READ_ADDRS:
                    break                                       # 记满了就不再长（内存有底）
                m[a] = m.get(a, 0) + 1

    def read_summary(self):
        """按主站汇总成网页直接能用的样子：每个区域的 去重地址个数 / 读次数 / 地址区间"""
        with self.lock:
            per = {}                                            # ip -> {area: {addr: count}}
            for (ip, area), m in self.reads.items():
                per.setdefault(ip, {})[area] = dict(m)
            seen = dict(self.read_seen)
        total = {}
        for m in per.values():
            for area, addrs in m.items():
                t = total.setdefault(area, {})
                for a, c in addrs.items():
                    t[a] = t.get(a, 0) + c
        now = time.time()
        clients = []
        for ip, areas in per.items():
            entry = {"ip": ip, "ago": round(max(0.0, now - seen.get(ip, now)), 1), "areas": {}}
            for area, m in areas.items():
                runs, more = _ranges(m)
                entry["areas"][area] = {"n": len(m), "reads": sum(m.values()), "ranges": runs, "more": more}
            clients.append(entry)
        clients.sort(key=lambda c: c["ago"])                     # 还在读的排前面
        out_total = {}
        for area, m in total.items():
            runs, more = _ranges(m)
            out_total[area] = {"n": len(m), "reads": sum(m.values()), "ranges": runs, "more": more}
        return {"clients": clients, "total": out_total}

    def clear_reads(self):
        with self.lock:
            self.reads.clear()
            self.read_seen.clear()

    # -- 自动仿真 --
    def tick_auto(self):
        now = time.time()
        with self.lock:
            for addr, cfg in list(self.auto.items()):
                t = now - cfg.get("t0", now)
                period = max(0.2, float(cfg.get("period", 5)))
                amp = float(cfg.get("amp", 10000))
                mid = float(cfg.get("mid", 0))
                kind = cfg.get("kind", "sine")
                if kind == "sine":
                    v = mid + amp * math.sin(2 * math.pi * t / period)
                elif kind == "ramp":
                    v = mid + amp * ((t % period) / period)
                else:
                    v = mid + amp * (0.5 + 0.5 * math.sin(t * 3.7 + addr))
                # ── 输出类型：int（写一个字）或 real（浮点，写两个字，低字在前 CDAB）──
                if cfg.get("type") == "real":
                    u = struct.unpack(">I", struct.pack(">f", float(v)))[0]
                    self.holding[addr] = u & 0xFFFF                 # %MWn   = 低字
                    self.holding[addr + 1] = (u >> 16) & 0xFFFF     # %MWn+1 = 高字
                else:
                    self.holding[addr] = int(round(v)) & 0xFFFF

    def snapshot(self):
        with self.lock:
            reads = self.read_summary()          # 自己也要拿锁：RLock，同一线程可重入
            return {
                "holding": dict(self.holding),
                "input_reg": dict(self.input_reg),
                "coils": {k: bool(v) for k, v in self.coils.items()},
                "discrete": {k: bool(v) for k, v in self.discrete.items()},
                "auto": {str(k): v for k, v in self.auto.items()},
                "log": self.log[-40:],
                "stats": dict(self.stats),
                "reads": reads,
                "slave": slave_info(),
            }

STORE = DataStore()

# ─────────────────────────────────────────────
#  Modbus TCP 从站
# ─────────────────────────────────────────────
EXC_ILLEGAL_FUNCTION, EXC_ILLEGAL_ADDRESS, EXC_ILLEGAL_VALUE = 1, 2, 3

# ── 从站开关：网页上一勾就能停掉/恢复 Modbus 通讯（现场要验「掉线」「拔网线」就这么用）──
SLAVE = {"srv": None, "on": False, "port": None}
CONNS = set()                    # 现在挂着的客户端连接（关从站时连它们一起断）
CONNS_LOCK = threading.Lock()


class ModbusSlaveHandler(socketserver.BaseRequestHandler):
    def setup(self):
        # 登记现有连接：关从站时要连它们一起断 —— 只停 accept 的话，老连接照样在通
        with CONNS_LOCK:
            CONNS.add(self.request)

    def finish(self):
        with CONNS_LOCK:
            CONNS.discard(self.request)
        super().finish()

    def handle(self):
        self.request.settimeout(30)
        peer = f"{self.client_address[0]}:{self.client_address[1]}"
        STORE.add_log(f"客户端接入 {peer}")
        try:
            while True:
                head = self._recv(7)
                if not head:
                    break
                tid, pid, length, unit = struct.unpack(">HHHB", head)
                pdu = self._recv(max(0, length - 1))
                if not pdu:
                    break
                with STORE.lock:
                    STORE.stats["rx"] += 1
                resp = self._dispatch(pdu[0], pdu[1:])
                frame = struct.pack(">HHHB", tid, 0, len(resp) + 1, unit) + resp
                self.request.sendall(frame)
                with STORE.lock:
                    STORE.stats["tx"] += 1
        except (socket.timeout, ConnectionResetError, OSError):
            pass
        finally:
            STORE.add_log(f"客户端断开 {peer}")

    def _recv(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.request.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def _dispatch(self, fc, data):
        try:
            if fc == 0x03:
                return self._read_regs(data, STORE.holding, fc)
            if fc == 0x04:
                return self._read_regs(data, STORE.input_reg, fc)
            if fc == 0x01:
                return self._read_bits(data, COIL, fc)
            if fc == 0x02:
                return self._read_bits(data, DISCRETE, fc)
            if fc == 0x06:
                addr, val = struct.unpack(">HH", data[:4])
                STORE.set_w(addr, val)
                STORE.add_log(f"FC06 写 %MW{addr} = {val} ({val:#06x})")
                return struct.pack(">BHH", fc, addr, val)
            if fc == 0x10:
                addr, cnt, nbytes = struct.unpack(">HHB", data[:5])
                vals = struct.unpack(">" + "H" * cnt, data[5:5 + cnt * 2])
                STORE.set_words(addr, vals)          # 整帧一起生效，避免读到半帧
                STORE.add_log(f"FC16 写 %MW{addr}..{addr + cnt - 1} = {list(vals)}")
                return struct.pack(">BHH", fc, addr, cnt)
            if fc == 0x05:
                addr, val = struct.unpack(">HH", data[:4])
                STORE.set_bit(COIL, addr, val == 0xFF00)
                STORE.add_log(f"FC05 写 %QX{addr} = {'ON' if val == 0xFF00 else 'OFF'}")
                return struct.pack(">BHH", fc, addr, val)
            if fc == 0x0F:
                addr, cnt, nbytes = struct.unpack(">HHB", data[:5])
                raw = data[5:5 + nbytes]
                STORE.set_bits(COIL, addr, [bool((raw[i // 8] >> (i % 8)) & 1) for i in range(cnt)])
                STORE.add_log(f"FC15 写 %QX{addr}..{addr + cnt - 1}")
                return struct.pack(">BHH", fc, addr, cnt)
            with STORE.lock:
                STORE.stats["errors"] += 1
            STORE.add_log(f"不支持的功能码 {fc:#04x}")
            return bytes([fc | 0x80, EXC_ILLEGAL_FUNCTION])
        except Exception as e:                                  # noqa: BLE001
            with STORE.lock:
                STORE.stats["errors"] += 1
            STORE.add_log(f"处理异常：{e}")
            return bytes([fc | 0x80, EXC_ILLEGAL_ADDRESS])

    def _read_regs(self, data, area, fc):
        addr, cnt = struct.unpack(">HH", data[:4])
        if cnt < 1 or cnt > 125:
            return bytes([fc | 0x80, EXC_ILLEGAL_VALUE])
        STORE.note_read(self.client_address[0], "holding" if fc == 3 else "input_reg", addr, cnt)
        vals = [self._area_get(area, addr + i) for i in range(cnt)]
        self._log_read(fc, addr, cnt, vals)
        return struct.pack(">BB", fc, cnt * 2) + struct.pack(">" + "H" * cnt, *vals)

    def _area_get(self, area, addr):
        with STORE.lock:
            return area.get(addr, 0) & 0xFFFF

    def _read_bits(self, data, area, fc):
        addr, cnt = struct.unpack(">HH", data[:4])
        if cnt < 1 or cnt > 2000:
            return bytes([fc | 0x80, EXC_ILLEGAL_VALUE])
        STORE.note_read(self.client_address[0], "coils" if area == COIL else "discrete", addr, cnt)
        packed = bytearray((cnt + 7) // 8)
        for i in range(cnt):
            if STORE.get_bit(area, addr + i):
                packed[i // 8] |= 1 << (i % 8)
        with STORE.lock:
            STORE.log.append(f"{time.strftime('%H:%M:%S')}  FC{fc:02d} 读 {('线圈' if area == COIL else '离散输入')} #{addr} ×{cnt}")
            if len(STORE.log) > 200:
                del STORE.log[:100]
        return struct.pack(">BB", fc, len(packed)) + bytes(packed)

    def _log_read(self, fc, addr, cnt, vals):
        area = "保持寄存器 %MW" if fc == 3 else "输入寄存器 %IW"
        head = vals[0] if len(vals) == 1 else f"{vals[0]}..{vals[-1]}"
        STORE.add_log(f"FC{fc:02d} 读 {area} #{addr} ×{cnt} → {head}")


class ModbusSlave(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_slave(port):
    srv = ModbusSlave(("0.0.0.0", port), ModbusSlaveHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    SLAVE.update(srv=srv, on=True, port=port)
    return srv


def slave_stop(quiet=False):
    """关掉从站：停止监听 + **把现有连接全断开**（只停 accept，老连接还在通）。
    数据区一个字节都不动 —— 关了还能在网页上改值，再开启就照新值通讯。"""
    with CONNS_LOCK:
        socks = list(CONNS)
        CONNS.clear()
    for s in socks:
        try:
            s.shutdown(socket.SHUT_RDWR)      # 让阻塞在 recv 的从站线程当场退出
        except OSError:
            pass
        try:
            s.close()
        except OSError:
            pass
    srv = SLAVE.get("srv")
    port = SLAVE.get("port")
    if srv is not None:
        try:
            srv.shutdown()                    # 只在 handler 线程里调（serve_forever 在别的线程）
            srv.server_close()
        except Exception:                     # noqa: BLE001
            pass
    SLAVE.update(srv=None, on=False)
    if not quiet:
        STORE.add_log(f"[网页] 从站已关闭：停止监听 :{port}，断开 {len(socks)} 个连接（数据区照旧保留）")
    return len(socks)


def slave_info():
    with CONNS_LOCK:
        n = len(CONNS)
    return {"on": bool(SLAVE["on"]), "port": SLAVE.get("port"), "conns": n}


def slave_switch(on):
    """网页上那个开关的落点：开启=重新监听（端口沿用上次的）；关闭=停监听+断连接"""
    if on:
        if SLAVE["on"]:
            return True, ""
        port = SLAVE.get("port") or 502
        try:
            start_slave(port)
        except OSError as e:
            STORE.add_log(f"[网页] 从站开启失败（:{port}）：{e}")
            return False, f"监听 :{port} 失败：{e}"
        STORE.add_log(f"[网页] 从站已开启：监听 :{port}")
        return True, ""
    if SLAVE["on"]:
        slave_stop()
    return True, ""


def auto_loop():
    while True:
        try:
            STORE.tick_auto()
        except Exception:                                       # noqa: BLE001
            pass
        time.sleep(0.2)


# ─────────────────────────────────────────────
#  网页调试台
# ─────────────────────────────────────────────
PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>模拟 PLC · Modbus TCP 从站调试台</title>
<style>
 :root{--bd:#d9dee5;--tx:#1f2329;--t2:#6b7280;--pri:#2563eb}
 *{box-sizing:border-box} body{margin:0;font:13px "Segoe UI","Microsoft YaHei",sans-serif;color:var(--tx);background:#eef1f5}
 header{height:46px;display:flex;align-items:center;gap:12px;padding:0 14px;background:#fff;border-bottom:1px solid var(--bd)}
 header b{font-size:15px} .badge{padding:1px 9px;border-radius:9px;font-size:11px;background:#e3edff;color:var(--pri);border:1px solid #bcd3fa}
 .wrap{display:flex;gap:12px;padding:12px;align-items:flex-start;flex-wrap:wrap}
 .card{background:#fff;border:1px solid var(--bd);border-radius:8px;padding:10px 12px;min-width:420px;flex:1}
 .card h3{margin:0 0 8px;font-size:13px;display:flex;align-items:center;gap:8px}
 table{border-collapse:collapse;width:100%;font:12px Consolas,monospace}
 th,td{border-bottom:1px solid #eef0f3;padding:2px 4px;text-align:left}
 th{color:var(--t2);font-weight:500;font-size:11px}
 td input[type=number],td input[type=text]{width:100%;height:22px;border:1px solid transparent;border-radius:3px;background:transparent;font:12px Consolas,monospace;padding:0 4px}
 td input:hover{border-color:var(--bd)} td input:focus{outline:none;border-color:var(--pri);background:#fff}
 .row-on{background:#eef4ff}
 .auto-on{background:#fff7e6}
 /* %MX 位小格：上排低字节（.0~.7）、下排高字节（.0~.7），点一下翻转那一位 */
 .mxwrap{line-height:0;white-space:nowrap}
 .mxb{display:inline-block;width:11px;height:11px;margin:1px;border:1px solid #c3cbd6;border-radius:2px;
      background:#fff;cursor:pointer;vertical-align:top}
 .mxb:hover{border-color:var(--pri);box-shadow:0 0 0 2px #dbeafe}
 .mxb.on{background:var(--pri);border-color:var(--pri)}
 input[type=checkbox]{accent-color:var(--pri)}
 #log{height:230px;overflow:auto;font:11px Consolas,monospace;color:#334155;white-space:pre-wrap;line-height:1.5}
 .hint{color:var(--t2);font-size:11px;line-height:1.6}
 button{height:26px;padding:0 10px;border:1px solid var(--bd);border-radius:5px;background:#fff;cursor:pointer;font-size:12px}
 button:hover{border-color:var(--pri);color:var(--pri)}
 button.pri{background:var(--pri);border-color:var(--pri);color:#fff}
 .stat{color:var(--t2);font-size:11px}
 /* 从站通讯开关：一眼看出开/关 */
 .switch{display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:2px 8px;border-radius:9px;
         border:1px solid var(--bd);background:#f6f8fb;color:var(--tx);font-size:11px}
 .switch input{width:12px;height:12px;margin:0;accent-color:var(--pri);cursor:pointer}
 .switch.off{background:#fdeaea;border-color:#f3c9c9;color:#b91c1c}
 .badge.off{background:#fdeaea;color:#b91c1c;border-color:#f3c9c9}
 /* 关掉从站时顶上挂一条，免得对着"怎么不动了"发懵 */
 .offbar{margin:8px 12px 0;padding:7px 10px;border-radius:6px;font-size:12px;line-height:1.7;
         background:#fdeaea;border:1px solid #f3c9c9;color:#b91c1c}
 .offbar.hidden{display:none}
</style></head><body>
<header>
  <b>模拟 PLC</b>
  <span class="badge" id="mode">Modbus TCP 从站</span>
  <span class="badge" id="prof">地址模型 —</span>
  <span class="stat" id="listen"></span>
  <span class="stat" id="stats"></span>
  <label class="stat switch" title="从站通讯开关：关掉 = 停止监听 Modbus 端口 + 断开所有连接（主站那边立刻读到连接失败／掉线）。数据区不受影响，照样能改；再勾上就重新监听原端口">
    <input type="checkbox" id="slaveOn">从站通讯</label>
  <label class="stat" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;margin-left:auto"
         title="勾上整个画面定住（值不变、日志不滚）：要慢慢核对或改数时用；正在输入的那些格子本来就不会被刷新动到">
    <input type="checkbox" id="pause">暂停刷新</label>
</header>
<div id="slaveOff" class="offbar hidden"></div>
<div class="wrap">
  <div class="card" style="flex:1 1 100%;min-width:560px">
    <h3>设备在读什么（主站读走的地址）
      <button onclick="resetReads()">清零统计</button>
      <span class="hint" id="rdWho">还没有主站来读</span>
    </h3>
    <table id="rds"><thead><tr>
      <th style="width:160px">区域</th><th style="width:74px">个数</th><th style="width:86px">读次数</th>
      <th>地址（去重后压成区间）</th>
    </tr></thead><tbody></tbody></table>
    <div class="hint" id="rdPer" style="margin-top:4px"></div>
    <div class="hint" style="margin-top:6px">
      只统计主站<b>读走</b>的地址（FC01/02/03/04）；写进来的看右边通讯日志。
      <b>个数 = 去重后的地址个数</b> —— 对着工程变量表核：数少了就是有变量没在读（地址写错、没勾轮询）；
      地址太长时只列前几段（鼠标停在上面看全的），想只看「接下来在读什么」就点<b>清零统计</b>。
    </div>
  </div>
  <div class="card">
    <h3>%MW 保持寄存器 / %MD 双字
      <button onclick="jump()">跳转地址</button>
      <input id="base" type="number" value="0" style="width:80px;height:24px;border:1px solid var(--bd);border-radius:4px;padding:0 6px">
      <span class="hint">共 <span id="rows">32</span> 行</span>
    </h3>
    <table id="tbl"><thead><tr>
      <th style="width:82px">%MW</th><th style="width:86px">无符号</th><th style="width:86px">有符号</th>
      <th style="width:78px">HEX</th><th style="width:96px">%MD(DINT)</th><th style="width:104px">REAL（可改）</th>
      <th style="width:122px" title="这一字的 16 个 %MX 位：上排 = 低字节 %MX(2a).0~.7，下排 = 高字节 %MX(2a+1).0~.7；点小格翻转那一位（先读回当前字、只改这一位、再整字写回）">位 %MX（可点）</th>
      <th style="width:104px">自动输出</th><th>说明</th>
    </tr></thead><tbody></tbody></table>
    <div class="hint" style="margin-top:6px">
      偶地址的 %MD 由「本行(低16位) + 下一行(高16位)」组成（与手册表 5-6 一致）。
      <b>顶上「从站通讯」是总开关</b>：关掉 = 停止监听 Modbus 端口 + 断开所有连接（主站那边立刻读到
      连接失败／掉线，就是「拔网线」的现场）；<b>数据区不受影响</b>，照旧能改，再勾上就重新监听原端口。<br>
      <b>REAL 一栏可以直接改</b>：填个数就是往这两个字里写浮点（低字在前）；
      「自动输出」是两个<b>勾选框</b>：<b>自动</b> 管开/关，<b>REAL</b> 管类型 ——
      勾上跑浮点正弦（占本行+下一行两个字），不勾就是单字整数正弦；
      <b>不用先勾「自动」，直接勾 REAL 就开始输出</b>（去掉勾则切回整数正弦）。<br>
      <b>改值怎么发出去</b>：数字框里填完按 <b>回车</b>（或点到别处）就地写进寄存器；
      刷新（每 600ms 一次）<b>不会再动你正在输入的那一格</b>，也不会把刚点的勾冲掉 ——
      想整个画面定住慢慢看，右上角勾<b>暂停刷新</b>。<br>
      <b>「位 %MX」那一格</b>：一行 16 个小格 = 这一字的 16 位，<b>上排</b>是低字节
      <b>%MX(2a).0~.7</b>、<b>下排</b>是高字节 <b>%MX(2a+1).0~.7</b>（例如 %MW0 这行就是 %MX0.0~%MX1.7，
      %MX0.0 = 第 0 位）。<b>点一下翻转那一位</b>：从站里<b>先读回当前字、只改这一位、再整字写回</b>，
      同字其他 15 位一个都不动（和 HMI 侧写 %MX 的语义一致）；每格悬停能看到它对应的 %MX 地址。<br>
      本页的 %MD/REAL 一律按<b>低字在前（CDAB）</b>显示原始寄存器；
      如果对方程序是 ABCD / BADC / DCBA，在设计器的「🔌 PLC → 双字字序」里改，
      并用那里的「按 4 种字序各读一次」对着这里的原始寄存器核对。
    </div>
  </div>
  <div class="card" style="flex:1 1 100%;min-width:560px">
    <h3>地址控制台（按当前地址模型解析地址）
      <span class="hint" id="cprof"></span>
    </h3>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input id="caddr" type="text" placeholder="D100 / M10 / T5 / C200 / R100 / Z3 / %MW100"
             style="width:240px;height:26px;border:1px solid var(--bd);border-radius:4px;padding:0 6px;font:12px Consolas,monospace">
      <select id="cvtype" style="height:26px;border:1px solid var(--bd);border-radius:4px;font-size:12px">
        <option value="int">int</option><option value="uint">uint</option>
        <option value="real">real</option><option value="bool">bool</option>
        <option value="string">string</option><option value="dint">dint</option>
      </select>
      <input id="cval" type="text" placeholder="要写的值"
             style="width:170px;height:26px;border:1px solid var(--bd);border-radius:4px;padding:0 6px;font:12px Consolas,monospace">
      <button onclick="consoleRead()">读</button>
      <button class="pri" onclick="consoleWrite()">写</button>
      <span class="hint" id="cres"></span>
    </div>
    <div class="hint" style="margin-top:6px">
      invt 模型：%MW100 / %MD48 / %QX0 / %IX0；TS600 模型：D100 / R100 / T5 / C150 / C200 / Z3 / M10 / X17。
      bool 元件走位区、D/R/T/C/Z 走字区；<b>X 是输入元件（只读），写它会被拒绝</b>（和 HMI 侧 write_var 同一条规则）。
    </div>
  </div>
  <div class="card" style="min-width:300px;max-width:420px">
    <h3>位区 %QX / %IX</h3>
    <div id="bits" class="hint">加载中…</div>
    <h3 style="margin-top:12px">通讯日志</h3>
    <div id="log"></div>
  </div>
</div>
<script>
let base = 0, ROWS = 32, state = {holding:{},input_reg:{},coils:{},discrete:{},auto:{},log:[],stats:{}};
const pickReal = {};        // 每行「有没有勾 REAL」：服务器只记正在输出的那些，勾选框状态靠它不跟着刷新跑丢
let pause = false;          // 「暂停刷新」勾上：画面定住（值还留在页面上，方便对着看、慢慢改）
let builtFor = '';          // 表格是按哪个 base 建的（换页才重建 DOM）
const ACT = () => document.activeElement;
const num = v => (v===undefined||v===null)?0:v;
const s16 = v => (num(v) & 0x8000) ? (num(v) - 0x10000) : num(v);
const hex = v => '0x' + (num(v)&0xFFFF).toString(16).toUpperCase().padStart(4,'0');
function dword(a){ return (num(state.holding[a]) | (num(state.holding[a+1])<<16)) >>> 0; }
function realOf(a){ const b=new ArrayBuffer(4), dv=new DataView(b); dv.setUint32(0, dword(a)); return dv.getFloat32(0); }
/** 浮点显示：最多 6 位有效数字，去掉多余的小数尾巴（12.345679283 → 12.3457） */
function realText(f){ if (!isFinite(f)) return String(f); return String(Number(f.toPrecision(6))); }
function setReal(a, f){ const b=new ArrayBuffer(4), dv=new DataView(b); dv.setFloat32(0, f); const u=dv.getUint32(0);
  post('/api/write', {kind:'w', addr:a, value:u & 0xFFFF}); post('/api/write', {kind:'w', addr:a+1, value:(u>>>16)&0xFFFF}); }
async function post(url, body){ await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); await refresh(); }
function jump(){ base = Math.max(0, Math.min(65504, +document.getElementById('base').value||0)); refresh(); }
/* 行只建 DOM 一次（data-a 记住地址），刷新只改值 ——
   以前每次刷新都 innerHTML 重建整张表：正在输入的数字、刚点的勾会被一起冲掉，
   值根本发不出去（这就是「一直刷新，改不了值」的根因）。 */
function rowHTML(a){
  const odd = a % 2;
  return `<tr data-a="${a}">
   <td>%MW${a}</td>
   <td><input type="number" data-k="w" min="0" max="65535" title="无符号：填完按回车（或点到别处）就写进这个寄存器"></td>
   <td data-k="s"></td>
   <td data-k="hex"></td>
   <td><input type="number" data-k="dw" ${odd?'disabled':''} title="双字 DINT（写本行+下一行两个字）"></td>
   <td><input type="number" step="any" data-k="r" ${odd?'disabled':''} title="直接填 REAL 值（写本行+下一行，低字在前）"></td>
   <td>${mxBitsHTML(a)}</td>
   <td style="text-align:center;white-space:nowrap">
     <label class="hint" style="margin-right:6px" title="开启/关闭自动输出"><input type="checkbox" data-k="auto">自动</label>
     <label class="hint" title="勾上=REAL 正弦（占本行+下一行两个字）；不勾=单字整数正弦。没勾「自动」时直接勾它就开始输出"><input type="checkbox" data-k="real">REAL</label></td>
   <td class="hint" data-k="note"></td></tr>`;
}
/** 这一字的 16 个 %MX 位小格：上排 %MX(2a).0~.7（低字节）、下排 %MX(2a+1).0~.7（高字节）
 *  —— 和设计器里的地址模型一致（%MX0.0~%MX1.7 = %MW0 的 16 位，%MX0.0 = 第 0 位） */
function mxBitsHTML(a){
  let h = '<div class="mxwrap">';
  for (let b = 0; b < 16; b++) {
    const byte = a * 2 + (b >= 8 ? 1 : 0);
    h += `<i class="mxb" data-a="${a}" data-b="${b}" title="%MX${byte}.${b % 8}　=　%MW${a} 的第 ${b} 位（点一下翻转：先读回当前字，只改这一位，再整字写回）"></i>`;
    if (b === 7) h += '<br>';
  }
  return h + '</div>';
}
function buildTable(){
  document.querySelector('#tbl tbody').innerHTML =
    Array.from({length:ROWS},(_,i)=>rowHTML(base+i)).join('');
  for (const tr of document.querySelectorAll('#tbl tbody tr')) paintRow(tr);
  builtFor = base + ':' + ROWS;
}
function paintRow(tr){
  const a = +tr.dataset.a, focus = ACT(), el = k => tr.querySelector(`[data-k="${k}"]`);
  const w = el('w');
  if (w !== focus) w.value = num(state.holding[a]);          // 正在输入的那格绝不动它
  el('s').textContent = s16(state.holding[a]);
  el('hex').textContent = hex(state.holding[a]);
  const dw = el('dw');
  if (a % 2 === 0 && dw !== focus) dw.value = (dword(a) & 0x80000000) ? dword(a)-0x100000000 : dword(a);
  const r = el('r');
  if (a % 2 === 0 && r !== focus) r.value = realText(realOf(a));
  const wv = num(state.holding[a]);                       // %MX 位小格：亮=1
  for (const b of tr.querySelectorAll('.mxb')) {
    const on = !!(wv & (1 << +b.dataset.b));
    if (b.classList.contains('on') !== on) b.className = 'mxb' + (on ? ' on' : '');
  }
  const on = state.auto[String(a)];
  const isReal = (a in pickReal) ? pickReal[a] : !!(on && on.type === 'real');
  const cbAuto = el('auto'), cbReal = el('real');
  if (cbAuto !== focus) cbAuto.checked = !!on;               // 刚点的勾同理：不跟用户抢
  if (cbReal !== focus) cbReal.checked = isReal;
  tr.className = on ? 'auto-on' : '';
  el('note').textContent = on ? (isReal?'REAL 正弦':'整数正弦') + (on.period?' 周期'+on.period+'s':'')
                               + (isReal?'（占 %MW'+a+'/'+(a+1)+'）':'') : '';
}
function toggleAuto(a, on){
  const cur = state.auto[String(a)];
  const real = (a in pickReal) ? pickReal[a] : !!(cur && cur.type === 'real');
  post('/api/auto', {addr:a, on:on, type:real?'real':'int'});
}
function setAutoReal(a, real){
  pickReal[a] = real;                       // 记住这一行的选择：关掉自动再加回来还是原来那个类型
  // 勾上 = 立刻按 REAL 输出；去掉勾 = 正在输出就切回单字整数，没在输出就只记选择
  if (real || state.auto[String(a)]) post('/api/auto', {addr:a, on:true, type:real?'real':'int'});
  else refresh();
}
function buildBits(){
  let h = '';
  for (const [area,label] of [['coils','%QX 线圈'],['discrete','%IX 离散输入']]) {
    h += `<div style="margin-bottom:6px"><b style="font-size:12px">${label}</b><div>`;
    for (let i = 0; i < 16; i++) {
      h += `<label style="display:inline-flex;align-items:center;gap:2px;margin:2px 8px 2px 0">
        <input type="checkbox" data-area="${area}" data-bit="${i}">
        <span class="hint">${area==='coils'?'Q':'I'}${i}</span></label>`;
    }
    h += '</div></div>';
  }
  document.getElementById('bits').innerHTML = h;
}
function paintBits(){
  const focus = ACT();
  for (const cb of document.querySelectorAll('#bits input[type=checkbox]')) {
    if (cb === focus) continue;                    // 刚点的那一下不覆盖
    cb.checked = !!state[cb.dataset.area][+cb.dataset.bit];
  }
}
/* ── 设备在读什么：主站读走的 %MW/%IW/%QX/%IX 个数（对着变量表核漏读）── */
const RD_AREAS = [['holding','%MW 保持寄存器','%MW'], ['input_reg','%IW 输入寄存器','%IW'],
                  ['coils','%QX 线圈','%QX'], ['discrete','%IX 离散输入','%IX']];
function rdRanges(pfx, a, cut){
  if (!a || !a.ranges || !a.ranges.length) return '—';
  const t = a.ranges.map(([s,e]) => (s === e ? pfx + s : pfx + s + '~' + pfx + e)).join('，');
  return t + (cut && a.more ? ' …' : '');
}
function paintReads(){
  const rd = state.reads || {clients:[], total:{}};
  document.getElementById('rdWho').textContent = rd.clients.length
    ? `${rd.clients.length} 个主站：` + rd.clients.map(c => `${c.ip}（${c.ago}s 前` + (c.ago < 3 ? '还在读' : '读过') + '）').join('　')
    : '还没有主站来读过 —— 设计器那边「🔌 PLC」连上了吗？';
  document.querySelector('#rds tbody').innerHTML = RD_AREAS.map(([k,label,pfx]) => {
    const a = rd.total[k];
    return `<tr><td>${label}</td><td><b>${a ? a.n : 0}</b></td><td>${a ? a.reads : 0}</td>
      <td class="hint" title="${a ? rdRanges(pfx, a, false) : ''}">${rdRanges(pfx, a, true)}</td></tr>`;
  }).join('');
  document.getElementById('rdPer').textContent = rd.clients.length > 1
    ? '按主站拆开：' + rd.clients.map(c => c.ip + ' → ' +
        RD_AREAS.map(([k,,pfx]) => pfx + ' ' + (c.areas[k] ? c.areas[k].n : 0)).join(' / ')).join('　')
    : '';
}
function resetReads(){ post('/api/read-reset', {}); }
/* ── 从站通讯开关：关 = 停止监听 + 断开连接（数据区照旧能改）── */
function paintSlave(){
  const s = state.slave || {on:true, port:0, conns:0};
  const box = document.getElementById('slaveOn');
  if (box && ACT() !== box) box.checked = !!s.on;                  // 正在点它的手别抢
  const sw = box ? box.closest('.switch') : null;
  if (sw) sw.classList.toggle('off', !s.on);
  const mode = document.getElementById('mode');
  mode.textContent = s.on ? 'Modbus TCP 从站' : '已停止（不通讯）';
  mode.classList.toggle('off', !s.on);
  document.getElementById('listen').textContent = s.on
    ? `监听 :${s.port}（${s.conns} 个连接）` : '未监听';
  const bar = document.getElementById('slaveOff');
  bar.classList.toggle('hidden', !!s.on);
  if (!s.on) {
    bar.textContent = `Modbus 从站已关闭：不监听 :${s.port}、连接已全部断开 —— 主站那边会读到连接失败／掉线（这正是「拔网线」的现场）。`
      + '数据区照旧能改：改好再勾上「从站通讯」恢复监听，主站下次轮询就拿到新值。';
  }
}
async function setSlave(on){
  const r = await fetch('/api/slave', {method:'POST', headers:{'Content-Type':'application/json'},
                                       body: JSON.stringify({on})});
  const j = await r.json().catch(() => ({}));
  if (!j.ok) alert('切换从站失败：' + (j.error || ('HTTP ' + r.status)));
  await refresh();
}
/* ── 地址控制台：按当前地址模型解析地址，bool 走位、D/R/T/C/Z 走字，X 只读 ── */
function consoleText(j){
  if (!j.ok) return '失败：' + (j.error || '未知错误');
  const rd = j.readonly ? '（只读）' : '';
  return `${j.address} → ${j.area_cn || j.area} ${j.offset}，${j.words} 字${rd}`
    + (j.value !== undefined ? ' = ' + JSON.stringify(j.value) : '');
}
async function consolePost(path, extra){
  const r = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({address: document.getElementById('caddr').value,
                          vtype: document.getElementById('cvtype').value, ...extra})});
  const j = await r.json().catch(() => ({}));
  document.getElementById('cres').textContent = consoleText(j);
  if (j.ok && j.value !== undefined) {
    const v = document.getElementById('cval');
    if (v !== document.activeElement) v.value = typeof j.value === 'string' ? j.value : String(j.value);
  }
  return j;
}
function consoleRead(){ return consolePost('/api/console/read', {}); }
function consoleWrite(){ return consolePost('/api/console/write', {value: document.getElementById('cval').value}).then(refresh); }
async function refresh(){
  if (pause) return;                               // 暂停刷新：整个画面定住
  const r = await fetch('/api/state'); state = await r.json();
  const pbadge = document.getElementById('prof');
  if (pbadge) pbadge.textContent = '地址模型 ' + (state.profile_cn || state.profile || '—');
  const cprof = document.getElementById('cprof');
  if (cprof) cprof.textContent = state.profile ? `${state.profile}（${state.profile_cn || ''}）` : '';
  if (builtFor !== base + ':' + ROWS) buildTable();
  for (const tr of document.querySelectorAll('#tbl tbody tr')) paintRow(tr);
  paintBits();
  paintReads();
  paintSlave();
  document.getElementById('log').textContent = state.log.join('\\n');
  document.getElementById('stats').textContent = `收 ${state.stats.rx} 帧 / 发 ${state.stats.tx} 帧 / 异常 ${state.stats.errors}`;
}
/* 事件委托（挂在容器上，表重建了也照样管用）；值在 change 时下发，
   数字框里按回车 = 立刻下发（以前必须先点到别处才发得出去，赶上刷新就被冲了） */
document.querySelector('#tbl tbody').addEventListener('change', e => {
  const t = e.target, tr = t.closest('tr'); if (!tr) return;
  const a = +tr.dataset.a;
  if (t.dataset.k === 'w') post('/api/write', {kind:'w', addr:a, value:+t.value});
  else if (t.dataset.k === 'dw') post('/api/write', {kind:'dw', addr:a, value:+t.value});
  else if (t.dataset.k === 'r') setReal(a, +t.value);
  else if (t.dataset.k === 'auto') toggleAuto(a, t.checked);
  else if (t.dataset.k === 'real') setAutoReal(a, t.checked);
});
document.querySelector('#tbl tbody').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.target.blur(); }   // blur 触发 change → 下发
});
document.getElementById('bits').addEventListener('change', e => {
  const t = e.target;
  if (t.type === 'checkbox') post('/api/write', {kind:'bit', area:t.dataset.area, addr:+t.dataset.bit, value:t.checked});
});
// %MX 位小格：点一下翻转那一位 —— 从站里读回当前字、改这一位、再整字写回（同字其他位不动）
document.querySelector('#tbl tbody').addEventListener('click', e => {
  const el2 = e.target.closest ? e.target.closest('.mxb') : null;
  if (!el2) return;
  post('/api/write', {kind:'mx', addr:+el2.dataset.a, bit:+el2.dataset.b, value: !el2.classList.contains('on')});
});
document.getElementById('pause').addEventListener('change', e => {
  pause = e.target.checked;
  if (!pause) refresh();                           // 取消暂停立刻追一帧
});
document.getElementById('slaveOn').addEventListener('change', e => setSlave(e.target.checked));
buildTable(); buildBits();
setInterval(refresh, 600); refresh();
</script></body></html>
"""


# ─────────────────────────────────────────────
#  地址控制台：按**当前地址模型**解析地址再读写（invt 的 %MW/%QX、TS600 的 D100/M10/T5/C200/Z3…）
#  自测脚本和现场手测都走这里 —— 跟 PlcSource 声明时用的是同一套 parse_address。
# ─────────────────────────────────────────────
def console_addr(addr, vtype=""):
    """解析地址并按类型算字数，越区直接抛 ValueError（口径和 PlcSource.declare 一致）。"""
    a = parse_address(addr, vtype=vtype)
    nw = words_for(vtype or "uint", a.words)
    limit = region_end(a)
    if limit is not None and a.offset + nw - 1 > limit:
        raise ValueError(f"地址 {addr}（{vtype or 'uint'}）占 {nw} 个字，"
                         f"{AREA_CN.get(a.area, a.area)} 区只到 {limit}，越区了")
    return a, nw


def _console_value(vtype, raw):
    """把网页/JSON 传来的值按类型转好（bool/real/string/int）。"""
    t = str(vtype or "uint").lower()
    if "string" in t:
        return "" if raw is None else str(raw)
    if "real" in t or t in ("float", "double"):
        return float(raw or 0)
    if t == "bool":
        # ⚠ 不能直接 bool(raw)："0"/"false" 是非空字符串，bool("0") 是 True
        if isinstance(raw, str):
            return raw.strip().lower() in ("1", "true", "on", "yes")
        return bool(raw)
    return int(float(raw or 0))


def console_read(addr, vtype=""):
    """按模型读一个地址：bool 元件走位区、D/R/T/C/Z 走字区，返回值和解析信息。"""
    a, nw = console_addr(addr, vtype)
    t = vtype or ""
    if a.bits:
        bits = [STORE.get_bit(a.area, a.offset + i) for i in range(a.bits * nw)]
        raw = []
        for i in range(nw):
            w = 0
            for j, b in enumerate(bits[i * 16:(i + 1) * 16]):
                w |= (1 if b else 0) << j
            raw.append(w)
        val = decode_value(raw, t or "uint", "cdab")
    elif a.area in (COIL, DISCRETE):
        val = STORE.get_bit(a.area, a.offset)
    else:
        ws = ([STORE.get_iw(a.offset + i) for i in range(nw)] if a.area == INPUT_REG
              else [STORE.get_w(a.offset + i) for i in range(nw)])
        if a.bit is not None:
            val = bool((ws[0] >> a.bit) & 1)
        else:
            val = decode_value(ws, t or "uint", "cdab", byte=a.byte)
    return {"address": addr, "vtype": t, "area": a.area, "area_cn": AREA_CN.get(a.area, a.area),
            "offset": a.offset, "words": nw, "readonly": bool(a.readonly), "kind": a.kind,
            "profile": a.profile, "value": val}


def console_write(addr, vtype, raw):
    """按模型写一个地址：bool 元件走位、字区元件走字；TS600 的 X（离散输入）只读，拒绝写。"""
    a, nw = console_addr(addr, vtype)
    if a.readonly or a.area in (DISCRETE, INPUT_REG):
        raise ValueError(f"地址 {addr} 是输入元件（只读），不能写")
    t = vtype or "uint"
    val = _console_value(t, raw)
    if a.bits:                                   # %QW：16 个位拼成的字
        enc = encode_value(val, t or "uint", nw, "cdab")
        ws = enc if isinstance(enc, list) else [enc]
        STORE.set_bits(a.area, a.offset,
                       [1 if (w >> i) & 1 else 0 for w in ws for i in range(16)])
    elif a.area == COIL:
        STORE.set_bit(COIL, a.offset, bool(val))
    elif a.bit is not None:                      # %MX：只改这一位（同字其他位不动）
        STORE.set_word_bit(a.offset, a.bit, bool(val))
    else:
        enc = encode_value(val, t, nw, "cdab")
        ws = enc if isinstance(enc, list) else [enc]
        for i, w in enumerate(ws):
            STORE.set_w(a.offset + i, w)
    STORE.add_log(f"[控制台] {addr}（{a.profile or 'invt-modbus-slave'}）← {raw!r}")
    return {"address": addr, "vtype": t, "area": a.area, "area_cn": AREA_CN.get(a.area, a.area),
            "offset": a.offset, "words": nw, "readonly": bool(a.readonly), "kind": a.kind,
            "profile": a.profile, "value": val}


class WebHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/state":
            snap = STORE.snapshot()
            snap["stats"] = snap["stats"]
            # 当前地址模型：网页顶上要显示（invt 的 %MW/%QX / TS600 的 D/M/T/C/Z…）
            snap["profile"] = get_profile()
            snap["profile_cn"] = profile_cn()
            snap["profiles"] = profiles()
            self._json(snap)
        else:
            self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:                                       # noqa: BLE001
            body = {}
        if path == "/api/console/write":
            try:
                self._json({"ok": True, **console_write(body.get("address") or "",
                                                        body.get("vtype") or "",
                                                        body.get("value"))})
            except (ValueError, TypeError) as e:
                self._json({"ok": False, "error": str(e)}, 400)
            return
        if path == "/api/console/read":
            try:
                self._json({"ok": True, **console_read(body.get("address") or "",
                                                       body.get("vtype") or "")})
            except (ValueError, TypeError) as e:
                self._json({"ok": False, "error": str(e)}, 400)
            return
        if path == "/api/write":
            kind = body.get("kind")
            addr = int(body.get("addr", 0))
            if kind == "w":
                STORE.set_w(addr, int(body.get("value", 0)))
                STORE.add_log(f"[网页] %MW{addr} = {int(body.get('value',0))}")
            elif kind == "dw":
                v = int(body.get("value", 0)) & 0xFFFFFFFF
                STORE.set_words(addr, [v & 0xFFFF, (v >> 16) & 0xFFFF])   # 双字一起写
                STORE.add_log(f"[网页] %MD{addr} = {int(body.get('value',0))}")
            elif kind == "bit":
                area = COIL if body.get("area") == "coils" else DISCRETE
                STORE.set_bit(area, addr, bool(body.get("value")))
                STORE.add_log(f"[网页] {'%QX' if area == COIL else '%IX'}{addr} = {bool(body.get('value'))}")
            elif kind == "mx":
                # %MX 位：从站里读改写那一位（%MX0.0~%MX1.7 ↔ %MW0 的 16 位）
                bit = int(body.get("bit", 0))
                if not 0 <= bit <= 15:
                    return self._json({"ok": False, "error": "bit 只能是 0~15"}, 400)
                on = bool(body.get("value"))
                old, new = STORE.set_word_bit(addr, bit, on)
                byte = addr * 2 + (1 if bit >= 8 else 0)
                STORE.add_log(f"[网页] %MX{byte}.{bit % 8} = {'ON' if on else 'OFF'}"
                              f"（%MW{addr}: {old:#06x} → {new:#06x}，只改这一位）")
            elif kind == "iw":
                STORE.set_iw(addr, int(body.get("value", 0)))
            self._json({"ok": True})
        elif path == "/api/auto":
            addr = int(body.get("addr", 0))
            if body.get("on"):
                # 输出类型：int（默认，写一个字）/ real（浮点，写两个字、低字在前）
                otype = "real" if str(body.get("type", "int")).lower() == "real" else "int"
                on = STORE.auto.get(addr) or {}
                STORE.auto[addr] = {"kind": str(body.get("kind") or on.get("kind") or "sine"),
                                    "type": otype,
                                    "period": float(body.get("period", on.get("period", 5))),
                                    "amp": float(body.get("amp", on.get("amp", 10000))),
                                    "mid": float(body.get("mid", on.get("mid", 20000))),
                                    "t0": time.time()}
                STORE.add_log(f"[网页] %MW{addr} 打开自动{'REAL 正弦（占两字）' if otype == 'real' else '整数正弦'}")
            else:
                STORE.auto.pop(addr, None)
                STORE.add_log(f"[网页] %MW{addr} 关闭自动")
            self._json({"ok": True})
        elif path == "/api/clear-log":
            with STORE.lock:
                STORE.log.clear()
            self._json({"ok": True})
        elif path == "/api/read-reset":
            STORE.clear_reads()                                  # 「设备在读什么」清零，重新数
            STORE.add_log("[网页] 读地址统计已清零")
            self._json({"ok": True})
        elif path == "/api/slave":
            # 从站通讯开关：关 = 停止监听 + 断开所有连接（主站那边就是掉线）
            ok2, err = slave_switch(bool(body.get("on")))
            self._json({"ok": ok2, "error": err, **slave_info()}, 200 if ok2 else 500)
        else:
            self._json({"ok": False, "error": "not found"}, 404)


def import_csv(path):
    """按变量表 CSV（名称,类型,地址,初值）预置数据，方便对着工程变量表造数据"""
    n = 0
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            if len(row) < 4 or not row[0].strip() or row[0].strip() == "名称":
                continue
            name, vtype, addr, val = row[0].strip(), row[1].strip(), row[2].strip(), row[3].strip()
            if not addr:
                continue
            try:
                # 地址按「类型」解析：TS600 下 T5 是 bool 就是线圈、是 int 才是寄存器；
                # 字数也得按类型算（real 占 2 字），不能只看地址写法
                a, nw = console_addr(addr, vtype)
                if a.area == COIL or a.area == DISCRETE:
                    STORE.set_bit(a.area, a.offset, str(val).lower() in ("1", "true", "on"))
                elif a.bits:
                    enc = encode_value(_console_value(vtype, val), vtype or "uint", nw, "cdab")
                    ws = enc if isinstance(enc, list) else [enc]
                    STORE.set_bits(a.area, a.offset,
                                   [1 if (w >> i) & 1 else 0 for w in ws for i in range(16)])
                elif a.bit is not None:
                    STORE.set_word_bit(a.offset, a.bit, str(val).lower() in ("1", "true", "on"))
                else:
                    enc = encode_value(_console_value(vtype, val), vtype or "uint", nw, "cdab")
                    ws = enc if isinstance(enc, list) else [enc]
                    for i, w in enumerate(ws):
                        STORE.set_w(a.offset + i, w)
                n += 1
            except Exception as e:                              # noqa: BLE001
                print(f"[warn] 跳过 {name} {addr}: {e}")
    print(f"[import] 已按变量表预置 {n} 个地址")


def _port_in_use(port, host="127.0.0.1"):
    """端口是不是已经被占（Windows 上 allow_reuse_address 会让第二个实例也 bind 成功，
    然后两个模拟器抢同一个端口 —— 一个改数据另一个不认，看着像「通讯时好时坏」）"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(0.4)
        s.connect((host, int(port)))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="模拟 PLC（Modbus TCP 从站 + 网页调试台）")
    ap.add_argument("--port", type=int, default=502, help="Modbus TCP 端口（默认 502）")
    ap.add_argument("--web-port", type=int, default=8899, help="网页调试台端口（默认 8899）")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0，局域网可连）")
    ap.add_argument("--profile", default="invt-modbus-slave",
                    help="地址模型：invt（默认）或 ts600 —— 决定调试台/控制台怎么解析地址")
    ap.add_argument("--import-csv", default="", help="按变量表 CSV 预置数据")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--force", action="store_true", help="端口被占也照常启动（不推荐）")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:                                           # noqa: BLE001
        pass

    # 地址模型必须在导入 CSV / 起从站之前定下来：CSV 里的 D100/M10 按模型解析
    try:
        prof = set_profile(args.profile)
    except ValueError as e:
        print(f"  [启动失败] {e}")
        sys.exit(2)

    # 端口预检：起第二个模拟器是常见误操作，必须当场说清楚，而不是悄悄抢端口
    busy = [p for p in (args.port, args.web_port) if _port_in_use(p)]
    if busy and not args.force:
        print("=" * 58)
        print(f"  [启动失败] 端口已被占用：{', '.join(str(p) for p in busy)}")
        print("  · 很可能已经有一个模拟 PLC 在跑了（网页调试台 http://127.0.0.1:%d/）" % args.web_port)
        print(f"  · 换端口   : python server/plc_sim.py --port 15020 --web-port 8898")
        print(f"  · 看占用   : netstat -ano | findstr :{busy[0]}")
        print("  · 确实要再起一个（两个抢同一端口会互相干扰）：加 --force")
        print("=" * 58)
        sys.exit(2)

    if args.import_csv:
        try:
            import_csv(args.import_csv)
        except Exception as e:                                  # noqa: BLE001
            print(f"[warn] 导入 CSV 失败：{e}")

    # 给几个默认值，方便一打开就能看到数据
    STORE.set_w(100, 1250)      # %MW100 = 12.50（配合 HMI 里 ×0.01 量程）
    STORE.set_w(104, 8600)      # %MW104 = 计数
    STORE.auto[110] = {"kind": "sine", "period": 6, "amp": 8000, "mid": 12000, "t0": time.time()}

    threading.Thread(target=auto_loop, daemon=True).start()
    try:
        start_slave(args.port)
        slave_ok = True
    except OSError as e:
        slave_ok = False
        print(f"[错误] Modbus 从站监听 {args.port} 失败：{e}")

    web = ThreadingHTTPServer((args.host, args.web_port), WebHandler)
    print("=" * 58)
    print("  模拟 PLC · Modbus TCP 从站")
    print(f"  地址模型: {prof}（{profile_cn()}）—— 网页「地址控制台」/ --import-csv 都按它解析")
    if slave_ok:
        addr_hint = ("D/M/X/Y/S/T/C/R/Z 元件写法（也兼容 %MW/%QX）"
                     if prof == "ts600-modbus-tcp"
                     else "%MW/%QX/%IX/%IW，地址无偏移")
        print(f"  Modbus  : {args.host}:{args.port}   站号 1（{addr_hint}）")
    print(f"  网页调试: http://127.0.0.1:{args.web_port}/   直接改数据 / 地址控制台 / 自动正弦 / 从站通讯开关")
    print("  停止    : Ctrl+C")
    print("=" * 58)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{args.web_port}/")).start()
    try:
        web.serve_forever()
    except KeyboardInterrupt:
        print("\n再见。")


if __name__ == "__main__":
    main()
