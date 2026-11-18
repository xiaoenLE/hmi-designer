#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen-demo-project.py — 把一份工程 JSON 变成内置模板模块 js/data/demo-project.js

为什么要有这个脚本：
  「新建 ▾ → 演示工程」和"这台机器上还没有工程"时用的那份**内置工程模板**，
  内容是一份真工程（页面/变量/报警/脚本/权限一股脑都在里面）。它得**跟着程序走**，
  不能靠现场机器上的文件，也不能联网去取。

  但这份模板不适合手写进 JS：改一处画面就得上千行，手抄必错。所以：
  源工程还是**用设计器存出来的普通 .json**（在你手上编辑、随时另存），
  再由这个脚本**机械地**转成一个 ES 模块（js/data/demo-project.js）。

  为什么是 JS 模块而不是"运行时 fetch 一个 .json"：
  种子工程走的是**同步**路径（首屏加载 / 点「新建工程」当场就要），fetch 是异步的；
  而且 exe 版必须离线可用。

用法：
  py -3 tools/gen-demo-project.py <工程.json> [输出路径]
  默认输出 js/data/demo-project.js

源工程（当前这份模板的来源，路径在仓库外面，改模板时用它）：
  ..\\..\\工程演示-20261003.json      （1024×600 · 7 个页面 · 46 个变量 · 7 条报警 · 1 段仿真脚本）
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "js", "data", "demo-project.js")

HEADER = '''/**
 * demo-project.js — **内置工程模板**（自动生成，别手改）
 *
 * 用在哪：① 这台机器上还没有工程时首次打开看到的画面；② 「新建 ▾ → 带示例的演示工程」。
 *   内容来自一份真工程：{name}（{pages} 个页面 · {vars} 个变量 · {alarms} 条报警 · {scripts} 段脚本）。
 *
 * ⚠ 改模板**不要手改这个文件**：
 *   改法只有一条 —— 用设计器打开那份工程、改完「保存」，再跑
 *     python tools/gen-demo-project.py <工程.json>
 *   脚本头部写着当前这份模板的来源文件。
 *   （生成时只做转义，一个字段都不改 —— 页面/变量/报警/脚本/权限等级/PLC 配置都一起带进来；
 *     只有编辑器的**面板摆法** layout 不带，理由见 tools/gen-demo-project.py。）
 *
 * 载入进来的是**原始工程数据**，project.js 的 seedProject() 会深拷贝一份并打上
 * "这份是没人动过的模板"标记（template/seedVersion/autoSeed），再交给 normalize()。
 */
export const DEMO_PROJECT = '''


def js_string(text: str) -> str:
    """把一个工程对象转成 JS 里合法的字面量

    json.dumps(ensure_ascii=False) 出来的东西本来就长得跟 JS 字面量一样（对象/数组/字符串/数字/布尔/null），
    只有两个字符 JS 语法上不认（行分隔符/段分隔符），必须转成 \\u 转义 ——
    工程里粘一段文字带进去过就会踩，肉眼还看不出来。
    """
    s = json.dumps(text, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    return s.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    src = argv[1]
    out = argv[2] if len(argv) > 2 else DEFAULT_OUT
    if not os.path.isfile(src):
        print(f"找不到工程文件：{src}")
        return 2
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("pages"), list) or not data["pages"]:
        print("这不像一份工程 JSON（没有 pages）")
        return 2

    stats = {
        "name": (data.get("meta") or {}).get("name") or "未命名工程",
        "pages": len(data["pages"]),
        "vars": len(data.get("variables") or []),
        "alarms": len(data.get("alarms") or []),
        "scripts": len(data.get("scripts") or []),
    }
    # layout（编辑器的面板摆法）**不进模板**：它是"这台机器上的人怎么摆面板"，不是画面内容。
    #   带进来的话，所有人新建的工程、每台新装的机器第一次打开，看到的都是**别人**的面板摆法
    #   （报警面板跑到下区、画布被压短…），而文档里写的、大家习惯的是内置默认摆法。
    #   真要连摆法一起带走，把下面两行删掉重新生成即可。
    dropped = []
    if "layout" in data:
        data.pop("layout")
        dropped.append("layout（面板摆法）")
    body = HEADER.format(**stats) + js_string(data) + ";\n"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    widgets = sum(len(p.get("widgets") or []) for p in data["pages"])
    print(f"已生成 {os.path.relpath(out, ROOT)}："
          f"{stats['name']} · {stats['pages']} 页 · {widgets} 个控件 · {stats['vars']} 个变量 · "
          f"{stats['alarms']} 条报警 · {stats['scripts']} 段脚本 · {len(body.encode('utf-8')) / 1024:.0f} KB")
    if dropped:
        print("（没带进模板：" + "、".join(dropped) + " —— 理由见脚本里的说明）")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                                   # noqa: BLE001
        pass
    sys.exit(main(sys.argv))
