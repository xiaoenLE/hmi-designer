# -*- coding: utf-8 -*-
"""自检：登录页的三个占位符都得被替换掉（尤其是**页内脚本里**那个 __EDITOR__）。"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
from core import loginpage                                        # noqa: E402

h = loginpage.login_page_html()
left = [k for k in ("__EDITOR__", "__RUN__", "__SCRIPT__") if k in h]
print("没替换掉的占位符：", left or "（无）")
m = re.search(r"location\.replace\('([^']*)'\)", h)
print("脚本里登录成功后跳到：", m.group(1) if m else "（没找到）")
m2 = re.search(r'href="([^"]*)">← 回到运行画面', h)
print("「回到运行画面」链接：", m2.group(1) if m2 else "（没找到）")
ok = not left and m and not m.group(1).startswith("__") and m2 and not m2.group(1).startswith("__")
print("结论：", "OK" if ok else "还有问题")
sys.exit(0 if ok else 1)
