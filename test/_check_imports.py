# -*- coding: utf-8 -*-
"""体检：长连接工具的 import 是不是**真的**在顶层（不是写在字符串/注释里）。

为什么需要：接线是脚本改的，脚本判断"要不要加 import"时看的只是
「文件里出现过 `_wsfetch.mjs` 这个字符串」—— 有的套件在**模板字符串**（里面裹着
Python 探针代码）或注释里也出现过这行字，脚本以为已经 import 过了，
于是调用插进去了、import 没加 → 运行时
`ReferenceError: installNodeFetchPatch is not defined`（踩到 verify-log-block / verify-opcua）。

用"第几条 import 行"糊是不行的（套件里 import 和 const 常常交替写，那本身合法：
ESM 的 import 会提升）。所以这里老老实实扫一遍字符，把
字符串 / 模板串 / 注释 里的内容剔掉，只看**真正的代码行**里有没有那句 import。
"""
import re
import sys
from pathlib import Path

TEST = Path(__file__).resolve().parent
IMPORT_RE = re.compile(r"^import \{[^}]*\} from '\./_wsfetch\.mjs';")


def code_lines(src: str):
    """逐行判断"这一行的**行首**是不是处在正常代码里"。

    只看行首状态就够：我们要找的那句 import 一定是从行首开始的。
    处在字符串/模板串/注释**里面**的行，行首状态就不是正常代码 → 整行作废
    （套件里那些裹着 Python 探针的模板串就是这么被识破的）。
    """
    lines = src.split("\n")
    keep = []
    i, n, state = 0, len(src), None      # None / "'" / '"' / '`' / '//' / '/*'
    line = 0
    at_line_start = True
    while i < n:
        ch = src[i]
        if at_line_start:
            keep.append(state is None)   # 这一行行首算不算"真代码"
            line += 1
            at_line_start = False
        nxt = src[i + 1] if i + 1 < n else ""
        if ch == "\n":
            if state == "//":
                state = None
            at_line_start = True
            i += 1
            continue
        if state is None:
            if ch == "/" and nxt == "/":
                state = "//"
                i += 2
                continue
            if ch == "/" and nxt == "*":
                state = "/*"
                i += 2
                continue
            if ch in "\"'`":
                state = ch
            i += 1
            continue
        if state == "//":
            i += 1
            continue
        if state == "/*":
            if ch == "*" and nxt == "/":
                state = None
                i += 2
            else:
                i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if ch == state:
            state = None
        i += 1
    while len(keep) < len(lines):
        keep.append(True)
    return [ln if keep[k] else "" for k, ln in enumerate(lines)]


bad, okc = [], 0
for p in sorted(TEST.glob("*.mjs")):
    if p.name == "_wsfetch.mjs":
        continue
    raw = p.read_text(encoding="utf-8-sig")          # 有的文件带 BOM
    if "installNodeFetchPatch(" not in raw:
        continue
    found = any(IMPORT_RE.match(ln) and "installNodeFetchPatch" in ln for ln in code_lines(raw))
    if found:
        okc += 1
    else:
        bad.append(p.name)

print(f"顶层 import 正常的：{okc}")
print(f"没真正 import 的：{bad if bad else '（无）'}")
sys.exit(1 if bad else 0)
