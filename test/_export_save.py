# -*- coding: utf-8 -*-
"""_export_save.py — 给 test/verify-export-file.mjs 用的探针：**不弹真框**，只验 save_text 的逻辑

桌面上"点导出弹系统保存框"这件事没法在自动化里真点（弹出来的是 Windows 原生框），
所以这里用**假窗口**把 DesktopApi.save_text 的三条路各跑一遍：
  A) 用户在框里选了路径   → 文件按原文本写下去（CSV 的 BOM 一个字节都不许少）
  B) 用户在框里点取消     → 不写文件、回 cancelled
  C) 两条弹框路都失败     → 兜底写进用户的「下载」文件夹，并回 fallback=True（绝不静默丢文件）
顺便验文件名里的非法字符会被换成下划线。

用法：python test/_export_save.py <工程根>      输出一行 JSON
"""
import io
import json
import os
import shutil
import sys
import tempfile

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import hmi_desktop                                            # noqa: E402

OUT = {}


class FakeWin:
    """假窗口：create_file_dialog 按脚本回话（真弹的话自动化点不了）"""
    def __init__(self, result=None, boom=False):
        self.result, self.boom = result, boom
        self.calls = []

    def create_file_dialog(self, kind, directory="", allow_multiple=False,
                           save_filename="", file_types=()):
        self.calls.append({"save_filename": save_filename, "directory": directory,
                           "file_types": list(file_types)})
        if self.boom:
            raise RuntimeError("假的：这条弹框路走不通")
        return self.result


def main():
    tmp = tempfile.mkdtemp(prefix="hmi-export-")
    csv_text = "\ufeff名称,值\r\nA,1\r\n"                      # 带 BOM + CRLF，跟真导出一样
    json_text = json.dumps({"app": "hmi-designer"}, ensure_ascii=False)

    try:
        # ── A：用户选了路径 → 原样写盘 ──
        target = os.path.join(tmp, "选中的.csv")
        api = hmi_desktop.DesktopApi("http://127.0.0.1:1")
        api._win = FakeWin((target,))
        r = api.save_text("脚本表-全部.csv", csv_text, "csv")
        raw = open(target, "rb").read()
        OUT["pick"] = {
            "ret": r,
            "wrote": os.path.exists(target),
            "bom": raw[:3] == b"\xef\xbb\xbf",                 # UTF-8 BOM
            "crlf": b"\r\n" in raw,
            "text": raw.decode("utf-8"),
            "asked_name": api._win.calls[0]["save_filename"],
            "asked_dir_nonempty": bool(api._win.calls[0]["directory"]),
        }

        # ── B：用户点取消 → 一个字节都不写 ──
        api2 = hmi_desktop.DesktopApi("http://127.0.0.1:1")
        api2._win = FakeWin(None)                               # None = 取消
        r2 = api2.save_text("取消.csv", csv_text, "csv")
        OUT["cancel"] = {"ret": r2, "wrote": os.path.exists(os.path.join(tmp, "取消.csv"))}

        # ── C：两条弹框路都失败 → 兜底写进「下载」文件夹 ──
        api3 = hmi_desktop.DesktopApi("http://127.0.0.1:1")
        api3._win = FakeWin(boom=True)                          # pywebview 那条抛
        real_win32 = hmi_desktop._dialog_win32
        hmi_desktop._dialog_win32 = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("假的：win32 也不行"))
        try:
            r3 = api3.save_text("兜底-报表.json", json_text, "json")
        finally:
            hmi_desktop._dialog_win32 = real_win32
        p3 = (r3 or {}).get("path") or ""
        OUT["fallback"] = {
            "ret": r3,
            "in_downloads": os.path.basename(os.path.dirname(p3)) == "Downloads",
            "wrote": bool(p3) and os.path.exists(p3),
            "text": open(p3, encoding="utf-8").read() if p3 and os.path.exists(p3) else None,
        }
        if p3 and os.path.exists(p3):
            os.remove(p3)

        # ── D：文件名里的非法字符 ──
        OUT["safe"] = {
            "raw": "报表*表?.csv",
            "safe": hmi_desktop._safe_filename("报表*表?.csv"),
            "empty": hmi_desktop._safe_filename(""),
            "types_csv": list(hmi_desktop._dialog_file_types("x.csv", "csv")),
            "types_json": list(hmi_desktop._dialog_file_types("x.hmiw.json", "json")),
        }

        # ── E：页面回传了完整路径（工程「保存 = 写回上次那个文件」）→ 直接写，**不许弹框** ──
        target2 = os.path.join(tmp, "写回同一个文件.json")
        api4 = hmi_desktop.DesktopApi("http://127.0.0.1:1")
        api4._win = FakeWin(boom=True)                         # 真去弹框就会抛：用来证明"没弹"
        r4 = api4.save_text("随便.json", json_text, "json", target2)
        OUT["writeback"] = {
            "ret": r4,
            "wrote": os.path.exists(target2),
            "text": open(target2, encoding="utf-8").read() if os.path.exists(target2) else None,
            "dialog_calls": len(api4._win.calls),               # 必须是 0（没弹框）
        }
        OUT["ok"] = True
    except Exception as e:                                     # noqa: BLE001
        OUT["ok"] = False
        OUT["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:                                          # noqa: BLE001
        pass
    print("EXPORT_PROBE " + json.dumps(OUT, ensure_ascii=False))
    return 0 if OUT.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())

