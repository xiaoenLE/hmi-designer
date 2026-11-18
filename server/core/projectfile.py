#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""projectfile.py — 「服务器上那一份」画面工程的读写（一处收口）

现场要求：工程文件后缀统一 **.LE**（本机保存/另存为、导出、服务器这份都用它）；
机器上原有的 `hmi_project.json` **照样读得到** —— 升级上来第一件事就是把它读进来，
之后保存写 .LE，**老文件原样留着不删**（万一要回退旧版本，那份还在）。

读 / 写都走这个模块的原因：有三处要用它，各写一遍就容易"一处改后缀、另一处忘了"：
  · core/api.py      的 GET / POST `/api/project`（页面上的「从服务器读取…」/「存到服务器」）
  · hmi_desktop.py   开窗口时读工程名当窗口标题
  · server.py        启动横幅上写「工程存：…」
"""

import json
from pathlib import Path

from .paths import PROJECT_FILE, PROJECT_FILE_LEGACY


def project_file_in_use() -> Path:
    """现在**该读**哪一份：新的 .LE 在就读它，否则退到老的 .json；
    两份都没有 → 返回 .LE 的路径（那是将来要写的地方）。"""
    if PROJECT_FILE.exists():
        return PROJECT_FILE
    if PROJECT_FILE_LEGACY.exists():
        return PROJECT_FILE_LEGACY
    return PROJECT_FILE


def read_project_file():
    """读服务器上那份工程。读不到 / 文件坏了 / 不是 JSON → None
    （调用方按「服务器上还没有工程」处理，别抛异常把页面拖垮）。"""
    p = project_file_in_use()
    try:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:                                            # noqa: BLE001
        pass
    return None


def write_project_file(data) -> Path:
    """存服务器上那份工程。**一律写 .LE**（老 .json 不动，留作回退）。"""
    PROJECT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return PROJECT_FILE
