# -*- coding: utf-8 -*-
"""check-syntax.py — 打包前的语法自检：python 全量编译 + 前端 js 解析 + 关键文件在位

为什么要有这一步：打包脚本是 shell/bat 触发的，打出来的东西一旦带语法错，
现场就是"双击没反应"。宁可在这里失败，也别让坏包发出去。

用法：python tools/check-syntax.py
"""
import ast
import glob
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
bad = []


def check_python():
    files = sorted(glob.glob(str(ROOT / "server" / "**" / "*.py"), recursive=True)
                   + glob.glob(str(ROOT / "packaging" / "*.py"))
                   + glob.glob(str(ROOT / "tools" / "*.py")))
    for f in files:
        try:
            ast.parse(Path(f).read_text(encoding="utf-8"))
        except SyntaxError as e:
            bad.append(f"python 语法错：{Path(f).name}:{e.lineno} {e.msg}")
    return len(files)


def check_js():
    """前端是 ES 模块：node --check 对 ESM **不校验**（实测过），
    所以用 vm.SourceTextModule 真解析一遍（跑不了就退化成"跳过但说明白"）"""
    js_dir = ROOT / "js"
    if not js_dir.is_dir():
        return 0
    files = sorted(str(p) for p in js_dir.rglob("*.js"))
    code = (
        "const fs=require('fs'),vm=require('vm');"
        "let bad=0;"
        "for(const f of process.argv.slice(1)){"
        " try{new vm.SourceTextModule(fs.readFileSync(f,'utf8'),{identifier:f});}"
        " catch(e){bad++;console.log('FAIL '+f+' :: '+e.message);}}"
        "process.exit(bad?1:0);"
    )
    try:
        r = subprocess.run(["node", "--experimental-vm-modules", "--no-warnings", "-e", code, *files],
                           capture_output=True, text=True, encoding="utf-8", errors="ignore")
    except FileNotFoundError:
        print("（没装 node：跳过前端 js 语法检查）")
        return 0
    if r.returncode != 0:
        bad.extend([ln for ln in (r.stdout or "").splitlines() if ln.startswith("FAIL")] or ["前端 js 解析失败"])
    return len(files)


def check_files():
    for rel in ("index.html", "version.json", "server/server.py", "server/hmi_desktop.py",
                "server/updater.py", "server/_restart.py", "packaging/launcher.py"):
        if not (ROOT / rel).exists():
            bad.append(f"少文件：{rel}")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                                   # noqa: BLE001
        pass
    n_py = check_python()
    n_js = check_js()
    check_files()
    if bad:
        print("打包前自检没过：")
        for b in bad:
            print("  ✗", b)
        sys.exit(1)
    print(f"自检通过：python {n_py} 个文件、前端 js {n_js} 个文件，关键文件都在")
