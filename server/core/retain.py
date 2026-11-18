#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""retain.py — 掉电保持变量的落盘

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

变量表里勾了「保持」的，值存在这儿，重启 / 断电再上电照旧。
"""

from .paths import FLUSH_INTERVAL
from .paths import RETAIN_FILE

from pathlib import Path
import json
import threading
import time


# ─────────────────────────────────────────────
#  数据源抽象（Python ↔ 设备 的唯一对接点）
# ─────────────────────────────────────────────
class RetainStore:
    """HMI 内部的**掉电保持**变量：值存 server/data/retain_vars.json。

    只对**地址留空**的变量（= 内部变量，见前端变量表的「保持」列）有意义 ——
    这类变量不读也不写 PLC，值就是 HMI 自己算/自己写的：

        · 勾了「保持」 → 值落盘，**后端重启 / 整机断电后还在**（和报警历史一个级别：
          跟着跑后端这台机器走，换浏览器、换台电脑打开都一样）
        · 没勾     → 只在内存里，重启回变量表初值

    为什么**不做**"开机把保持值下发给 PLC"：那等于开机偷偷写设备（掉电前是"启动"、
    上电就自动下发，现场不可预料）。要写 PLC 请在脚本/控件里显式做。

    写盘策略和内存模式一致：写入只标脏，后台线程每 FLUSH_INTERVAL 秒合并写一次
    （原子写：先写 .tmp 再替换，断电不会写坏存档）。
    """

    def __init__(self, path: Path, interval: float = FLUSH_INTERVAL):
        self.path = path
        self.interval = interval
        self._lock = threading.Lock()
        self._vals = {}
        self._dirty = False
        try:
            if path.exists():
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self._vals = raw
        except Exception as e:
            print(f"[warn] 掉电保持值读不出来（先当空的）: {e}")
        threading.Thread(target=self._flush_loop, daemon=True).start()

    def all(self) -> dict:
        with self._lock:
            return dict(self._vals)

    def get(self, name, default=None):
        with self._lock:
            return self._vals.get(name, default)

    def has(self, name) -> bool:
        with self._lock:
            return name in self._vals

    def set(self, name, value):
        with self._lock:
            if self._vals.get(name) == value and name in self._vals:
                return False
            self._vals[name] = value
            self._dirty = True
        return True

    def forget(self, *names):
        """不再保持（取消勾选 / 变量删掉）→ 把存盘那份丢掉"""
        with self._lock:
            hit = False
            for n in names:
                if n in self._vals:
                    del self._vals[n]
                    hit = True
            if hit:
                self._dirty = True
        return hit

    def flush(self):
        with self._lock:
            if not self._dirty:
                return False
            self._dirty = False
            payload = json.dumps(self._vals, ensure_ascii=False, indent=2)
        try:
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(self.path)
            return True
        except Exception as e:
            print(f"[warn] 掉电保持值落盘失败: {e}")
            with self._lock:
                self._dirty = True
            return False

    def _flush_loop(self):
        while True:
            time.sleep(self.interval)
            try:
                self.flush()
            except Exception as e:
                print(f"[warn] 掉电保持落盘线程异常: {e}")



# 全局一份：两种数据源（内存模拟 / 真 PLC）共用 ——
# 掉电保持是 **HMI 自己的**数据，跟当前接没接 PLC 无关。
_retain = RetainStore(RETAIN_FILE)
