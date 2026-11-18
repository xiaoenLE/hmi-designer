#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify-project-ext.py — 工程文件后缀 .LE（老 .json 照样读得到）

现场要求：工程文件后缀统一 **.LE**（本机保存/另存为、导出、服务器那份都用它）；
机器上原有的 `hmi_project.json` **必须还能读**（升级上来第一件事就是把它读进来），
而且**不许把它删掉**（万一要回退旧版本，那份还在）。

盯的就是 core/projectfile.py 那三个函数（读 / 写 / "现在该读哪一份"）：
  · 只有老的 .json     → 读得到它（老机器升级上来工程不丢）
  · 写一次             → 写的是 .LE，**老 .json 原样留着**
  · 两份都在           → 以 .LE 为准（新的是现场在用那份）
  · 都没有             → 返回 None（页面按"服务器上还没有工程"处理，不报错）

用法（不用后端、不用浏览器，秒回）：python test/verify-project-ext.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
PY = sys.executable
OUT = {"encoding": "utf-8", "errors": "replace"}

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                                # noqa: BLE001
    pass

_passed = 0
_failed = 0


def ok(name, cond, info=""):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"PASS  {name}" + (f"  [{info}]" if info else ""))
    else:
        _failed += 1
        print(f"FAIL  {name}  [{info}]")


WORK = Path(tempfile.mkdtemp(prefix="hmi-projext-"))
DATA = WORK / "data"
DATA.mkdir(parents=True, exist_ok=True)
ENV = {**os.environ, "HMI_DATA_DIR": str(DATA), "PYTHONPATH": str(SERVER),
       "PYTHONIOENCODING": "utf-8"}
OLD = DATA / "hmi_project.json"
NEW = DATA / "hmi_project.LE"


def run(code):
    """在独立进程里跑一小段（数据目录用临时那份），把最后一行 stdout 带回来"""
    p = subprocess.run([PY, "-c", code], capture_output=True, text=True, env=ENV, **OUT)
    out = (p.stdout or "").strip()
    return (out.splitlines()[-1].strip() if out else ""), (p.stderr or "").strip()


# ── ① 都没有：返回 None，不抛异常 ──────────────────────────────────────
res, err = run("from core.projectfile import read_project_file; print(repr(read_project_file()))")
ok("服务器上还没有工程 → 读到 None（不抛异常，页面按「还没存过」处理）", res == "None", f"{res} {err[:60]}")

# ── ② 只有老的 hmi_project.json：照样读得到（升级上来工程不丢）──────────
OLD.write_text(json.dumps({"meta": {"name": "老工程-别丢"}, "pages": []}, ensure_ascii=False), encoding="utf-8")
res, err = run("from core.projectfile import read_project_file, project_file_in_use;"
               "print((read_project_file() or {}).get('meta', {}).get('name'), project_file_in_use().name)")
ok("★ 老机器上那份 hmi_project.json **照样读得到**（工程不会「消失」）",
   res == "老工程-别丢 hmi_project.json", f"{res} {err[:60]}")

# ── ③ 写一次：写 .LE，老 .json 一个字节不动 ────────────────────────────
before = OLD.read_text(encoding="utf-8")
res, err = run("from core.projectfile import write_project_file;"
               "p = write_project_file({'meta': {'name': '新工程'}, 'pages': []}); print(p.name)")
ok("★ 「存到服务器」写的是 hmi_project.LE", res == "hmi_project.LE", f"{res} {err[:60]}")
ok("★ 老的 hmi_project.json 原样留着（没删、没改 —— 要回退旧版本时它还在）",
   OLD.exists() and OLD.read_text(encoding="utf-8") == before)
ok("新文件里就是刚写的内容",
   json.loads(NEW.read_text(encoding="utf-8"))["meta"]["name"] == "新工程")

# ── ④ 两份都在：以 .LE 为准 ────────────────────────────────────────────
res, err = run("from core.projectfile import read_project_file, project_file_in_use;"
               "print((read_project_file() or {}).get('meta', {}).get('name'), project_file_in_use().name)")
ok("★ 两份都在时以 .LE 为准（现场在用那份）", res == "新工程 hmi_project.LE", f"{res} {err[:60]}")

# ── ⑤ 老文件坏了不许拖垮读取 ───────────────────────────────────────────
NEW.unlink()
OLD.write_text("{ 这不是 json", encoding="utf-8")
res, err = run("from core.projectfile import read_project_file; print(repr(read_project_file()))")
ok("老 .json 坏了 → 还是返回 None（不把后端拖崩）", res == "None", f"{res} {err[:60]}")

print(f"\n==== 工程文件后缀 .LE（老 .json 也认）：{_passed}/{_passed + _failed} 通过 ====")
try:
    import shutil
    shutil.rmtree(WORK, ignore_errors=True)
except Exception:                                                # noqa: BLE001
    pass
sys.exit(1 if _failed else 0)
