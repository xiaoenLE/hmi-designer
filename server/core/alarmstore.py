#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""alarmstore.py — 报警历史存档（server/data/alarm_history.json）

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

现场记录是凭据，但不能无限长：按 5MB 环形封顶，超了丢最早的。
⚠ 去重规则必须和前端 js/runtime/alarms.js **完全一致**，
否则两个页面同时判定同一条报警会记出重复条目。
"""

from .paths import ALARMS_FILE

import json
import threading
import time


# ─────────────────────────────────────────────
#  报警历史（运行记录）：**存服务器**，不能只放浏览器
#  · 为什么：客户机/一体机上每次打开都是**新的浏览器 profile**（PyWebView 尤其明显），
#    换地址（127.0.0.1 ↔ 局域网 IP）也是各自一份 localStorage —— 报警记录就这么"消失"了。
#    报警记录是现场凭据，必须落在跑 server.py 那台机器上。
#  · 为什么不塞进工程文件：报警是**运行数据**（一直长），工程是配置（会被整份覆盖），
#    混在一起就会「存一次工程把记录冲掉」。
#  · 写入不设登录闸门：报警由**运行页**产生（客户机上没人登录），和写变量一个性质
#    （见 HMIServer.ADMIN_PATHS 的说明）。
# ─────────────────────────────────────────────
ALARM_CAP_BYTES = 5 * 1024 * 1024   # 报警记录**环形存储**上限：5MB，超了就从最早那条开始丢

                                    # （现场记录是凭据，但也不能无限长 —— 满盘比丢老记录更糟）
ALARM_DUP_WINDOW_MS = 60000         # 同一条报警在这个窗口内的"又一次触发"算**同一次**

                                    # （两个页面同时在跑判定、或页面重开时会各判一次，不去重就记出重复条目）
_alarm_lock = threading.Lock()



def _alarms_load():
    """读存档（读不出来就按空记录继续 —— 宁可少几条，也不能让接口 500）"""
    if not ALARMS_FILE.exists():
        return []
    try:
        raw = json.loads(ALARMS_FILE.read_text(encoding="utf-8"))
    except Exception as e:                                   # noqa: BLE001
        print(f"[alarm] 报警记录文件读不出来（{e}）：本次按空记录继续，文件没动")
        return []
    items = raw.get("history") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    return [r for r in items if isinstance(r, dict)]



def _alarm_rec_bytes(r) -> int:
    """一条记录序列化出来大约多少字节 —— **不真的 dumps**，按字段估。

    为什么要估而不是直接量：`_alarms_save` 要在"丢到不超 5MB"这件事上快速找到切点。
    以前的做法是"丢掉最早的一成 → 把**整份**重新 dumps 一遍 → 再量"，几万条记录时
    一次落盘要整份序列化十来遍（一遍 5MB 的 dumps 就是几十毫秒），而它**每条报警都要走一遍**：
    记录越满越卡，正是"跑一阵子以后越用越慢"的一部分。
    这里改成先估一遍（纯字段长度相加，不解析），一次就能定位切点，
    真正的 dumps 只做一次；万一估偏了，后面还有一次精确的兜底循环。"""
    n = 2
    for k, v in r.items():
        n += len(k) + 4                                     # "key":  +  逗号/引号
        if isinstance(v, bool):
            n += 6                                          # true / false
        elif v is None:
            n += 5                                          # null
        elif isinstance(v, (int, float)):
            n += 14
        elif isinstance(v, str):
            # 中文按 UTF-8 3 字节算；再留一成余量给 \" \\ \n 这类转义
            n += int(len(v.encode("utf-8")) * 1.1) + 3
        else:
            n += 24
    return n



def _alarms_save(items):
    """整份落盘：按**环形**截断（超过 ALARM_CAP_BYTES 就丢最早的那些），再原子替换。

    · 先写临时文件再 replace：写一半断电也不会把记录毁掉；
    · 紧凑 JSON（不缩进）：文件是给机器读的，缩进白占两成空间，能多留两成记录。"""
    items = sorted(items, key=lambda r: r.get("at") or 0)
    # 先按估算的字节数把切点一次算出来（见 _alarm_rec_bytes 的说明），
    # 这样下面那次精确 dumps 基本一遍就过，不用"丢一成重新整份序列化"来回十几趟
    sizes = [_alarm_rec_bytes(r) for r in items]
    total = sum(sizes) + 16                                 # {"history":[]} 的壳子
    cut = 0
    while total > ALARM_CAP_BYTES and cut < len(items) - 1:
        total -= sizes[cut]
        cut += 1
    dropped = cut
    if cut:
        items = items[cut:]
    body = json.dumps({"history": items}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    while len(body) > ALARM_CAP_BYTES and len(items) > 1:
        # 估算偏小（转义比预想的多）时的兜底：一次丢最早的一成再量一次
        drop = max(1, len(items) // 10)
        items = items[drop:]
        dropped += drop
        body = json.dumps({"history": items}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tmp = ALARMS_FILE.with_name(ALARMS_FILE.name + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(ALARMS_FILE)
    if dropped:
        print(f"[alarm] 记录超过 {ALARM_CAP_BYTES // 1048576}MB 上限：环形丢掉最早的 {dropped} 条，"
              f"现在 {len(items)} 条 / {len(body) / 1024:.0f}KB")
    return items



def _alarm_add(items, adds):
    """追加记录。

    去重规则（前端 js/runtime/alarms.js 用的是同一条规则，两边必须一致）：
      同一条报警（key 相同）**还没恢复**（endAt 空）且起始时间在 DUP 窗口内 → 算同一次触发，
      不新记一条，把服务器上那条回给前端（前端拿它换掉自己刚记的那条）。
    另外：真的记了一条新触发时，把同一条报警还挂着的旧记录补上结束时间
    （现场换班/重启后重新触发，老记录不该永远"未恢复"）。"""
    # ⚠ 按 key 建索引：以前每加一条都要把**整个 items** 扫一遍找同 key 的旧记录，
    #   几万条记录 + 一次补传一批（比如 10000 条）时就是上亿次比较 —— 接口会卡住好几十秒。
    by_key = {}
    for x in items:
        by_key.setdefault(x.get("key"), []).append(x)
    added, skipped, closed = [], [], []
    for r in adds:
        if not isinstance(r, dict):
            continue
        key = r.get("key")
        if not key:
            continue
        at = int(r.get("at") or 0)
        rec = {
            "key": key, "id": r.get("id") or key, "name": r.get("name") or "",
            "text": r.get("text") or "", "level": r.get("level") or "alarm",
            "value": r.get("value"), "at": at, "endAt": int(r.get("endAt") or 0),
            "acked": bool(r.get("acked")),
        }
        same = by_key.get(key) or []
        opens = [x for x in same if not x.get("endAt")]
        dup = next((x for x in opens if abs(int(x.get("at") or 0) - at) <= ALARM_DUP_WINDOW_MS), None)
        if dup is not None:
            # 同一次报警（多客户端同时判定 / 前端重发）→ 只更新"当时的值/文字"，不再记一条
            dup["value"] = rec["value"]
            if rec["text"]:
                dup["text"] = rec["text"]
            skipped.append(dup)
            continue
        for x in opens:            # 新的这次触发之前还挂着的旧记录：补结束时间
            x["endAt"] = at or int(time.time() * 1000)
            closed.append(x)
        items.append(rec)
        by_key.setdefault(key, []).append(rec)   # 同一批里的后续记录也能看见它
        added.append(rec)
    return items, added, skipped, closed



def _alarm_patch(items, patches):
    """改记录（补恢复时间 / 确认）：按 key（+at）找到那一条"""
    patched = []
    for p in patches:
        if not isinstance(p, dict) or not p.get("key"):
            continue
        key = p.get("key")
        at = int(p.get("at") or 0)
        same = [x for x in items if x.get("key") == key]
        if not same:
            continue
        cand = [x for x in same if at and int(x.get("at") or 0) == at]
        if not cand:
            cand = [x for x in same if not x.get("endAt")] or same
        tgt = cand[-1]
        changed = False
        if p.get("endAt") and not tgt.get("endAt"):
            tgt["endAt"] = int(p["endAt"])
            changed = True
        if p.get("acked") and not tgt.get("acked"):
            tgt["acked"] = True
            changed = True
        if changed:
            patched.append(tgt)
    return items, patched
