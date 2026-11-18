#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""settings.py — 这台机器的设置：日志保留天数 / 脚本日志每天上限

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

存在 <数据目录>/settings.json，界面里改完不用重启就生效；没设过时按环境变量兜底。
日志相关的**默认值与上下限**也在这儿（`log_keep_days()` 和 `log_usage()` 都要用它们，
放进 applog 会跟它互相 import 成环）。
"""

from .paths import LOG_DIR
from .paths import SETTINGS_FILE

import json
import os
import re
import threading


_LOG_KEEP_DEFAULT = 3

_LOG_KEEP_MIN, _LOG_KEEP_MAX = 1, 30        # 界面里能选的范围（1 天 = 只留今天）

try:
    _LOG_KEEP_ENV = max(1, int(os.environ.get("HMI_LOG_KEEP_DAYS") or _LOG_KEEP_DEFAULT))
except ValueError:
    _LOG_KEEP_ENV = _LOG_KEEP_DEFAULT


# 认这三种名字：hmi-2026-10-04.log（服务日志）、update-2026-10-04.log（自己更新的日志）、
# script-2026-10-04.log（脚本里的 hmi.log 落盘那份，见 scriptlog_write）
_LOG_NAME_RE = re.compile(r"^(?:hmi|update|script)-(\d{4}-\d{2}-\d{2})\.log$", re.I)



# ─────────────────────────────────────────────────────────
# 这台机器的设置（界面「工程 ▾ → 日志设置…」改，存 server/data/settings.json）
#
# 为什么放在**服务器**上而不是工程里：日志保留天数、脚本日志每天上限都是**这台机器**的磁盘策略
# （现场机器盘小就调小），跟"画面怎么组"没关系 —— 换台机器/换个工程不该被带走。
# 取值顺序：**界面里设的 > 环境变量 > 默认值**（界面里改完**立刻生效**，不用重启后端）。
# ─────────────────────────────────────────────────────────
_SETTINGS_LOCK = threading.Lock()



def _settings_load():
    """读这台机器的设置（文件不在/坏了都给空 dict，别让设置文件把服务搞起不来）"""
    try:
        if SETTINGS_FILE.exists():
            d = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            return d if isinstance(d, dict) else {}
    except Exception:                                           # noqa: BLE001
        pass
    return {}



def _settings_save(patch):
    """把设置合并写回（原子写：先写 .tmp 再替换，断电不会留个半截文件）"""
    with _SETTINGS_LOCK:
        d = _settings_load()
        d.update(patch)
        try:
            tmp = SETTINGS_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, SETTINGS_FILE)
        except Exception as e:                                  # noqa: BLE001
            return None, f"写设置文件失败：{e}"
    return d, ""



def _clamp_int(v, lo, hi, dflt):
    try:
        return max(lo, min(hi, int(float(v))))
    except (TypeError, ValueError):
        return dflt



def _clamp_float(v, lo, hi, dflt):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return dflt



def log_keep_days():
    """日志保留天数（界面 > 环境变量 > 默认 3），夹在 1~30 天"""
    v = _settings_load().get("log_keep_days")
    if v is None:
        v = _LOG_KEEP_ENV
    return _clamp_int(v, _LOG_KEEP_MIN, _LOG_KEEP_MAX, _LOG_KEEP_DEFAULT)



def scriptlog_max_mb():
    """脚本日志每天上限 MB（界面 > 环境变量 > 默认 10），夹在 0.5~硬上限（100）"""
    v = _settings_load().get("scriptlog_max_mb")
    if v is None:
        v = _SCRIPTLOG_MAX_MB_ENV
    return _clamp_float(v, 0.5, SCRIPTLOG_MAX_MB_HARD, SCRIPTLOG_MAX_MB_DEFAULT)



def log_usage():
    """日志目录现状（界面里显示"现在占多少"，好据此决定留几天）"""
    out = {"dir": str(LOG_DIR), "files": 0, "bytes": 0, "by_kind": {}}
    try:
        for f in LOG_DIR.iterdir():
            m = _LOG_NAME_RE.match(f.name) if f.is_file() else None
            if not m:
                continue
            size = f.stat().st_size
            kind = f.name.split("-", 1)[0].lower()
            out["files"] += 1
            out["bytes"] += size
            out["by_kind"][kind] = out["by_kind"].get(kind, 0) + size
    except Exception:                                           # noqa: BLE001
        pass
    return out

SCRIPTLOG_MAX_MB_DEFAULT = 10.0    # 每天体积的**默认上限：10MB/天**（正常工程按事件记几行，够用很久）

SCRIPTLOG_MAX_MB_HARD = 100.0      # 每天体积的**硬上限：100MB/天**（界面上最多调到这儿，防写满盘）

try:
    # 环境变量只当兜底：**界面里设过就以界面为准**（工程 ▾ → 日志设置…，见 scriptlog_max_mb）
    _SCRIPTLOG_MAX_MB_ENV = min(SCRIPTLOG_MAX_MB_HARD,
                                max(0.5, float(os.environ.get("HMI_SCRIPTLOG_MAX_MB") or SCRIPTLOG_MAX_MB_DEFAULT)))
except ValueError:
    _SCRIPTLOG_MAX_MB_ENV = SCRIPTLOG_MAX_MB_DEFAULT
