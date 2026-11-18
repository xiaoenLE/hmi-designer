# -*- coding: utf-8 -*-
"""验收打包产物：清单 + app 包内容 + 安装器载荷（不联网、只读）。"""
import json
import sys
import zipfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
REL = ROOT / "build" / "release"
STAGE = ROOT / "build" / "stage"

man = json.loads((REL / "version.json").read_text(encoding="utf-8"))
print("=== 清单 build/release/version.json ===")
for k in ("app", "version", "date", "url"):
    print(f"  {k}: {man.get(k)}")
for k in ("app_zip", "setup"):
    v = man.get(k) or {}
    print(f"  {k}: {v.get('file')}  size={v.get('size')}  sha256={str(v.get('sha256'))[:16]}…")
print("  notes 条数:", str(man.get("notes", "")).count("\n") + 1)

zp = REL / f"WebHMI-Designer-{man['version']}-app.zip"
with zipfile.ZipFile(zp) as z:
    names = z.namelist()
    vz = json.loads(z.read("version.json").decode("utf-8"))
print(f"\n=== app 包 {zp.name}：{len(names)} 个条目 ===")
must = ["index.html", "version.json", "server/server.py", "server/core/api.py", "server/core/wsbridge.py",
        "server/hmi_desktop.py", "js/main.js", "js/api/backend.js", "css/base.css"]
miss = [m for m in must if m not in names]
print("  必需文件缺的：", miss or "（无）")
bad = [n for n in names if "server/data" in n or "__pycache__" in n or n.endswith(".pyc")]
print("  不该进的（server/data / pycache / pyc）：", bad[:5] or "（无）")
core = [n for n in names if n.startswith("server/core/")]
print(f"  server/core/ 里 {len(core)} 个文件（v1 的老接口层 routes.py 不该有：{'server/core/routes.py' in names}）")
print("  包里的版本号：", vz.get("version"))
print("  前端 js 文件数：", len([n for n in names if n.startswith("js/") and n.endswith(".js")]))

print("\n=== 安装器载荷 build/stage（只在刚打完包时有；清过 build / -SkipExe 就没有）===")
app = STAGE / "app"
if not app.is_dir():
    print("  build/stage 不在（正常：它不是交付物，下一次完整打包会重建）")
else:
    files = [p for p in app.rglob("*") if p.is_file()]
    print(f"  app\\ 文件数：{len(files)}")
    for m in ("server/core/api.py", "index.html", "server/hmi_desktop.py"):
        print(f"    {m}: {(app / m).is_file()}")
    print("    app\\server\\data 在吗（绝不该在）：", (app / "server" / "data").exists())
    shell = STAGE / "WebHMIDesigner"
    if shell.is_dir():
        tot = sum(p.stat().st_size for p in shell.rglob("*") if p.is_file()) / 1024 / 1024
        print(f"  壳 WebHMIDesigner\\：{tot:.1f} MB，exe 在：{(shell / 'WebHMIDesigner.exe').is_file()}")
