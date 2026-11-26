"""
hmi_desktop.py — 现场客户端：**一个原生窗口 + 内置后端，关窗口 = 关服务**

客户机上双击 start_hmi_window.bat（或 python server/hmi_desktop.py）：
  1. 在本进程里起后端（默认只监听 127.0.0.1，端口默认 8866，被占用就自动换一个空闲的）
  2. 开一个 WebView2 原生窗口，指向 http://127.0.0.1:<端口>/run（现场运行页，不用登录）
  3. **窗口一关，服务跟着停**：端口立刻释放，不留后台进程，也不用再跑 stop_server.bat

为什么用这个而不是浏览器：
  · 客户机不用记地址、不用管控制台窗口；关掉就是彻底退出（端口、轮询、SSE 全停）
  · 窗口有标题栏/最小化，能跟其它工控软件一样摆在桌面上，也能全屏当触摸屏用
  · 仍然是同一套后端与前端：/run 的只读运行 + /login 管理员登录照旧

常用参数：
  --port 8866        指定端口（占用时自动换空闲端口）
  --edit             直接开组态编辑器（/，要管理员登录）
  --fullscreen       全屏开窗（一体机/触摸屏）
  --width/--height   窗口尺寸（默认 1280x800）
  --data-dir DIR     数据目录（默认 server/data，和命令行后端共用同一份工程/PLC 配置）
  --no-auth          关掉登录闸门（本机调试用）
  --mcp-live         为本机 hmi-mcp 开启当前窗口实时操作（独立调试端口）
  --no-window        只起服务不开窗口（调试 / 自动化）
  --self-test        自检：起服务 → 开窗口 → 等页面就绪 → 关窗口 → 打印结果并退出
"""
import argparse
import atexit
import ctypes
import json
import os
import re
import socket
import sys
import threading
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))          # 同目录的 server.py / modbus.py / opcua.py

# ── 兼容补丁：必须在 import webview 之前 ─────────────────────────────
# 本机是 Python 3.10.0b1（正式版 3.10 才有 types.UnionType），而 pywebview 的 Windows
# 后端要经过 pythonnet → clr_loader → cffi → pycparser → typing_extensions，
# 这条链在导入时就会用到 types.UnionType。补一个**谁也匹配不上的哨兵类**即可
# （为什么不能用 types.Union / type(int | str)：见 opcua.py 里同一段补丁的注释）。
if not hasattr(types, "UnionType"):
    types.UnionType = type("UnionType", (), {})


def pick_port(preferred: int, host: str = "127.0.0.1") -> int:
    """端口被占就换一个空闲的 —— 别让「地址已在使用」把客户拦在门外。

    ⚠ 不能用 bind 试：Windows 上 SO_REUSEADDR 允许「第二个进程照样绑同一个端口」，
      试不出来（server.py 也踩过这个坑，所以它有 _port_in_use 的连接探测）。
    """
    import server as hmi
    if not hmi._port_in_use(host, preferred):
        return preferred
    # 多开桌面 EXE 时使用相邻的可用端口，方便 hmi-mcp 自动发现；
    # 只有常用段都被占用时才退回系统分配的临时端口。
    for candidate in range(max(1, preferred + 1), min(65536, preferred + 1001)):
        if not hmi._port_in_use(host, candidate):
            return candidate
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def pick_cdp_port(server_port: int) -> int:
    """给 MCP 实时操作分配和服务端口对应的独立 WebView2 调试端口。"""
    import server as hmi
    preferred = 20000 + (int(server_port) % 20000)
    for offset in range(256):
        candidate = preferred + offset
        if candidate >= 65536:
            break
        if not hmi._port_in_use("127.0.0.1", candidate):
            return candidate
    return 0


def project_title(default: str = "WebHMI_设计器 · 运行") -> str:
    """窗口标题用工程名（没工程就用默认）——读的是服务器上那份（.LE，老 .json 也认）"""
    try:
        from core.projectfile import read_project_file
        d = read_project_file() or {}
        name = (d.get("meta") or {}).get("name")
        if name:
            return f"{name} · 运行"
    except Exception:                                           # noqa: BLE001
        pass
    return default


class DesktopApi:
    """暴露给页面的接口（window.pywebview.api.*）。

    1) `where()` 表明"这是原生窗口"（页面据此决定「去运行画面」是同窗口换页还是另开标签）
    2) `save_text()` 导出文件时**弹系统的「另存为」框**，用户选哪儿就写哪儿

    ⚠ 这些方法里**不要**去操作窗口（load_url / evaluate_js）：
      js_api 调用期间页面的 JS 是阻塞的，Python 再回头调页面会死锁（实测过）。
      不过**弹模态文件框是可以的**（实测：js_api 的 HTTP 线程里 create_file_dialog 能弹出来、
      关掉后正常返回；页面自己用 location.href 换页就行了）。
    """

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        # ⚠ 窗口句柄必须放在**下划线开头**的属性上（`_win`）：
        #   pywebview 生成页面那份 JS API 时会把 js_api 对象上**非下划线**的属性也当"命名空间"
        #   递归展开（见 webview/util.py 的 get_functions）——把 Window 对象挂成 self.win，
        #   它就顺着 Window 一路展开下去，**开窗那一步直接卡死**（自检 90 秒不出结果，实测）。
        #   名字带下划线的会被跳过，所以窗口只能放这儿。
        self._win = None
        self.host = ""
        self.port = 0
        self._last_dir = ""            # 上次导出选的目录（下次弹框默认停这儿）
        self._picker = ScreenPicker()  # 屏幕吸管（同样挂在下划线属性上，别被当成命名空间）

    def where(self):
        """让页面问一句「这是原生窗口吗、开的是哪个页」"""
        return {"desktop": True, "base": self.base}

    def goto_editor(self):      # 兼容旧调用：只回话，换页由页面自己做
        return {"path": "/login"}

    def goto_runtime(self):
        return {"path": "/run"}

    def goto_login(self):
        return {"path": "/login"}

    # ── 导出文件：弹「另存为」────────────────────────────────────────
    def save_text(self, filename, text, kind="", path=""):
        """把一段文本导出到用户选的文件（页面上的导出按钮、工程的「另存为」都走这条）。

        `path` 给了就**直接写那儿、不弹框**：桌面窗口里没有 File System Access 的文件句柄，
           「保存 = 写回上次那个文件」只能靠页面把上次的完整路径回传过来（见 js/core/storage.js）。

        ⚠ 为什么不能靠网页那套 `<a download>`：exe 是 PyWebView + WebView2 的窗口，
          下载**没有宿主处理**（没人接 WebView2 的 DownloadStarting）→ 下载被就地取消：
          不弹框、不报错、文件一个字节都不落盘（实测：exe 那个 webview profile 的下载库里
          state=2「已取消」、target_path 全空）。
          （WebView2 里其实**有** showSaveFilePicker，但它会不会真弹出框没实测过；
           而下面这条 Python 弹框路是**实测过**的：框能弹出来、关掉后正常返回路径。
           所以桌面版走它。ps：探针窗口用 html= 加载时那个 API 是 undefined —— 得用
           http://127.0.0.1 这种安全上下文才看得到它。）

        弹框顺序：① pywebview 的 create_file_dialog（官方那条）
                  ② Win32 通用保存框（ctypes，任何线程都能调，兜底）
                  两条都弹不出来 → 写到用户的「下载」文件夹，至少让文件落在看得见的地方
                  （返回里带 fallback=True，页面上会说明）。
        返回 {'ok':True,'path':...} / {'ok':True,'path':...,'fallback':True} /
             {'ok':False,'cancelled':True} / {'ok':False,'error':...}
        """
        name = _safe_filename(filename)
        text = "" if text is None else str(text)
        types = _dialog_file_types(name, kind)
        start_dir = self._last_dir or _default_export_dir()
        cancelled, errs = False, []

        # ⓪ 页面给了完整路径（「保存」写回上次那个文件）→ 直接写，不弹框
        if str(path or "").strip():
            target = str(path)
            try:
                _write_text(target, text)
            except Exception as e:                              # noqa: BLE001
                return {"ok": False, "error": "写文件失败：%s" % e}
            self._last_dir = os.path.dirname(target) or self._last_dir
            print("[desktop] 已保存 %s" % target)
            return {"ok": True, "path": target}

        path = None
        # ① pywebview 自己的保存框
        try:
            r = _dialog_pywebview(self._win, name, types, start_dir)
            if r:
                path = r[0] if isinstance(r, (list, tuple)) else str(r)
            else:
                cancelled = True
        except Exception as e:                                  # noqa: BLE001
            errs.append("pywebview: %s" % e)

        # ② 兜底：Win32 通用保存框（pywebview 那条走不通才来这儿）
        if path is None and not cancelled:
            try:
                r2 = _dialog_win32(name, types, start_dir)
                if r2:
                    path = r2
                else:
                    cancelled = True
            except Exception as e:                              # noqa: BLE001
                errs.append("win32: %s" % e)

        # ③ 两条都弹不出来 → 放到「下载」文件夹（绝不静默丢文件）
        if path is None and not cancelled:
            path = os.path.join(_default_export_dir(), name)
            try:
                _write_text(path, text)
                print("[desktop] 保存框弹不出来（%s），已导出到 %s" % ("; ".join(errs) or "原因不明", path))
                return {"ok": True, "path": path, "fallback": True}
            except Exception as e:                              # noqa: BLE001
                return {"ok": False, "error": "导出失败：%s" % e}

        if cancelled or not path:
            return {"ok": False, "cancelled": True}

        try:
            _write_text(path, text)
        except Exception as e:                                  # noqa: BLE001
            return {"ok": False, "error": "写文件失败：%s" % e}
        self._last_dir = os.path.dirname(path) or self._last_dir
        print("[desktop] 已导出 %s" % path)
        return {"ok": True, "path": path}

    # ── 屏幕吸管：页面轮询这三条 ──────────────────────────────────────
    def pick_color_start(self):
        """开始采屏（后台线程）。页面拿 state=active 后每 ~70ms 轮询 pick_color_read()"""
        if not sys.platform.startswith("win"):
            return {"ok": False, "error": "当前系统不支持屏幕取色"}
        try:
            return {"ok": True, **self._picker.start()}
        except Exception as e:                              # noqa: BLE001
            return {"ok": False, "error": "屏幕取色启动失败：%s" % e}

    def pick_color_read(self):
        """读实时颜色：{state: active|done|cancelled|idle, hex, x, y}"""
        return {"ok": True, **self._picker.snapshot()}

    def pick_color_stop(self):
        """取消采屏（页面点「停止」或对话框关掉）"""
        return {"ok": True, **self._picker.stop()}


# ── 屏幕取色（吸管）：桌面版自己采屏 ────────────────────────────────────
# ⚠ WebView2 里的 `EyeDropper` 是「有构造函数、吸不到色」：2.1.17 打包版实测
#   `typeof EyeDropper === "function"`、`open()` 也能进取色态，但**取不到任何像素**
#   （浏览器那套吸管界面在 Chrome 里是浏览器层实现的，WebView2 没有）。
#   页面因此只看到"点了没反应"。所以桌面版走 Win32 采屏：
#     GetDC(NULL) + GetPixel 连续读光标下的像素，**左键单击 = 确认、Esc = 取消**。
#   采屏在后台线程里跑，页面用 pick_color_read() 轮询实时颜色：
#   每次调用都是瞬时的，不会像在 js_api 里死等取色那样把页面卡住（见 DesktopApi 注释）。
VK_LBUTTON = 0x01
VK_ESCAPE = 0x1B
PICK_IDLE = "idle"
PICK_ACTIVE = "active"
PICK_DONE = "done"
PICK_CANCELLED = "cancelled"
PICK_TIMEOUT = 120.0          # 最长采屏 2 分钟：超时按取消处理，线程不会一直挂着


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def _cursor_pos(user32):
    """光标位置，**物理像素**（跟屏幕 DC 的坐标才是一套；GetCursorPos 在高 DPI 下会被虚拟化）"""
    pt = _POINT()
    getter = getattr(user32, "GetPhysicalCursorPos", None) or user32.GetCursorPos
    return (pt.x, pt.y) if getter(ctypes.byref(pt)) else None


def _screen_pixel_hex(x: int, y: int) -> str:
    """屏幕上 (x, y) 那一点的颜色（`#rrggbb`）；取不到返回空串"""
    user32, gdi32 = ctypes.windll.user32, ctypes.windll.gdi32
    user32.GetDC.argtypes = [ctypes.c_void_p]
    user32.GetDC.restype = ctypes.c_void_p
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    hdc = user32.GetDC(None)
    if not hdc:
        return ""
    try:
        gdi32.GetPixel.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        gdi32.GetPixel.restype = ctypes.c_uint32
        color = gdi32.GetPixel(hdc, int(x), int(y))
    finally:
        user32.ReleaseDC(None, hdc)
    if color == 0xFFFFFFFF:                      # CLR_INVALID
        return ""
    return "#%02x%02x%02x" % (color & 0xFF, (color >> 8) & 0xFF, (color >> 16) & 0xFF)


class ScreenPicker:
    """后台线程采屏：左键单击 = 确认，Esc = 取消。状态用 snapshot() 只读取走。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._state = PICK_IDLE
        self._hex = ""
        self._pos = (0, 0)
        self._session = 0

    def snapshot(self) -> dict:
        with self._lock:
            return {"state": self._state, "hex": self._hex, "x": self._pos[0], "y": self._pos[1]}

    def start(self) -> dict:
        with self._lock:
            start = self._state != PICK_ACTIVE
            if start:
                self._session += 1
                session = self._session
                self._state, self._hex = PICK_ACTIVE, ""
        if start:
            threading.Thread(target=self._loop, args=(session,), name="hmi-screen-picker", daemon=True).start()
        return self.snapshot()

    def stop(self) -> dict:
        """页面取消（点「停止」/ 关对话框）"""
        with self._lock:
            if self._state == PICK_ACTIVE:
                self._state = PICK_CANCELLED
        return self.snapshot()

    def _loop(self, session) -> None:
        user32 = ctypes.windll.user32
        # 采屏线程的 DC 和鼠标使用同一套物理像素坐标，适配多屏不同缩放。
        set_dpi = getattr(user32, "SetThreadDpiAwarenessContext", None)
        if set_dpi:
            set_dpi.argtypes = [ctypes.c_void_p]
            set_dpi.restype = ctypes.c_void_p
            set_dpi(ctypes.c_void_p(-4))          # PER_MONITOR_AWARE_V2
        key_state = user32.GetAsyncKeyState
        key_state.argtypes = [ctypes.c_int]
        key_state.restype = ctypes.c_short
        armed = False
        end = time.monotonic() + PICK_TIMEOUT
        while time.monotonic() < end:
            pressed = bool(key_state(VK_LBUTTON) & 0x8000)
            cancel = bool(key_state(VK_ESCAPE) & 0x8000)
            confirm = armed and pressed
            armed = armed or not pressed
            pos = _cursor_pos(user32)
            color = _screen_pixel_hex(*pos) if pos and not cancel else ""
            with self._lock:
                if session != self._session or self._state != PICK_ACTIVE:
                    return
                if cancel:
                    self._state = PICK_CANCELLED
                    return
                if pos:
                    self._pos = pos
                self._hex = color
                if confirm:
                    self._state = PICK_DONE
                    return
            time.sleep(0.01)
        with self._lock:
            if session == self._session and self._state == PICK_ACTIVE:
                self._state = PICK_CANCELLED


def _safe_filename(name: str) -> str:
    """文件名里不能有的字符换掉（工程名是随手输入的）"""
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", str(name or "")).strip()
    return s or "export.txt"


def _default_export_dir() -> str:
    """保存框的默认目录：用户的「下载」文件夹（不存在就退回用户主目录/数据目录）"""
    for d in (os.path.join(os.path.expanduser("~"), "Downloads"),
              os.path.expanduser("~"),
              os.path.expanduser("~/Desktop")):
        if d and os.path.isdir(d):
            return d
    return os.getcwd()


def _dialog_file_types(name: str, kind: str):
    """按扩展名给保存框的过滤器（pywebview 要求 ('说明 (*.ext)',) 这种写法）

    工程文件后缀是 **.LE**（现场要求）；**老 .json 也列出来**，方便"另存为"时覆盖老文件。
    """
    ext = (os.path.splitext(name)[1] or "").lower().lstrip(".")
    if ext == "csv" or kind == "csv":
        return ("CSV 表格 (*.csv)", "所有文件 (*.*)")
    if ext in ("le", "json") or kind in ("le", "json"):
        return ("HMI 工程文件 (*.LE)", "老工程文件 (*.json)", "所有文件 (*.*)")
    return ("所有文件 (*.*)",)


def _dialog_pywebview(win, name, file_types, start_dir):
    """pywebview 的保存框。返回选中的路径列表 / None（用户取消）；弹不出来会抛异常。"""
    import webview
    if win is None:
        raise RuntimeError("窗口句柄还没挂上（api._win 为空）")
    try:                                                        # pywebview 6.x
        kind = webview.FileDialog.SAVE
    except Exception:                                           # noqa: BLE001
        kind = getattr(webview, "SAVE_DIALOG", 1)                # 5.x/4.x 的老写法
        if callable(kind):
            kind = kind()
    return win.create_file_dialog(kind, directory=start_dir, save_filename=name,
                                  file_types=tuple(file_types))


def _dialog_win32(name, file_types, start_dir):
    """Win32 通用「另存为」框（ctypes / comdlg32）：不依赖 pywebview，任何线程都能弹。

    为什么要这条兜底：pywebview 的实现在 Windows 上走 WinForms；万一那条路因为线程/版本
    弹不出来，这里还能给现场一个能用的保存框。返回路径 / None（取消）。
    """
    import ctypes
    import ctypes.wintypes as wt

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [("lStructSize", wt.DWORD), ("hwndOwner", wt.HWND), ("hInstance", wt.HINSTANCE),
                    ("lpstrFilter", wt.LPCWSTR), ("lpstrCustomFilter", wt.LPWSTR),
                    ("nMaxCustFilter", wt.DWORD), ("nFilterIndex", wt.DWORD),
                    ("lpstrFile", wt.LPWSTR), ("nMaxFile", wt.DWORD),
                    ("lpstrFileTitle", wt.LPWSTR), ("nMaxFileTitle", wt.DWORD),
                    ("lpstrInitialDir", wt.LPCWSTR), ("lpstrTitle", wt.LPCWSTR),
                    ("Flags", wt.DWORD), ("nFileOffset", wt.WORD), ("nFileExtension", wt.WORD),
                    ("lpstrDefExt", wt.LPCWSTR), ("lCustData", ctypes.c_void_p),
                    ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wt.LPCWSTR),
                    ("pvReserved", ctypes.c_void_p), ("dwReserved", wt.DWORD), ("FlagsEx", wt.DWORD)]

    # "说明 (*.csv)\0*.csv\0说明2 (*.json)\0*.json\0\0"
    filt = ""
    for f in file_types:
        m = re.search(r"\((.*?)\)", f or "")
        if not m:
            continue
        pats = m.group(1)
        filt += "%s\0%s\0" % (f, pats)
    filt += "\0"

    buf = ctypes.create_unicode_buffer(1024)
    if name:
        buf.value = name
    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    ofn.lpstrFilter = filt
    ofn.lpstrFile = ctypes.cast(buf, wt.LPWSTR)
    ofn.nMaxFile = 1024
    ofn.lpstrTitle = "导出到…"
    ofn.lpstrInitialDir = start_dir
    # OVERWRITEPROMPT（同名问一句）+ EXPLORER + NOCHANGEDIR（不把进程工作目录带跑）
    ofn.Flags = 0x00000002 | 0x00080000 | 0x00000008
    ofn.lpstrDefExt = (os.path.splitext(name)[1] or "").lstrip(".").lower() or None
    ctypes.windll.comdlg32.GetSaveFileNameW.restype = wt.BOOL
    ok = ctypes.windll.comdlg32.GetSaveFileNameW(ctypes.byref(ofn))
    return buf.value if ok else None


def _write_text(path: str, text: str):
    """写文本：**原样**写（CSV 那串自带 UTF-8 BOM 字符，newline='' 免得 CRLF 再被翻译一遍）"""
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def _wait_js(w, expr, timeout=20.0, step=0.4):
    """轮询等一个 JS 条件成立（自检用；页面上的功能测试都走浏览器 + Playwright）"""
    end = time.time() + timeout
    while time.time() < end:
        try:
            if w.evaluate_js(expr):
                return True
        except Exception:                                       # noqa: BLE001
            pass
        time.sleep(step)
    return False


def _ready_expr() -> str:
    """「页面就绪」的判据（自检用）。⚠ 别拿 #canvas 之类**静态元素**当就绪信号：
    HTML 一解析出来就有，那时候 main.js 还没跑（body 上还没 run-only、window.app 也还没挂）。"""
    return ("document.readyState === 'complete' && ("
            "  !!document.querySelector('input[type=password]')"                       # 登录页
            "  || !document.getElementById('bootHint').classList.contains('hidden')"   # 没工程/报错提示
            "  || (!!window.app && document.body.classList.contains('run-only')"       # 现场运行页
            "      && !document.getElementById('runtimeRoot').classList.contains('hidden'))"
            "  || (!!window.app && !document.body.classList.contains('run-only')"      # 组态编辑器
            "      && !!(document.getElementById('workspace')||{}).offsetParent)"
            ")")


def _bind_editor_shortcuts(window):
    """从 Windows 顶层窗口切换编辑器，覆盖网页未获得按键的情况。"""
    if sys.platform != "win32":
        return
    form = getattr(window, "native", None)
    if form is None or not hasattr(form, "BeginInvoke"):
        return

    from System import Action

    def install():
        from ctypes import wintypes as wt

        hwnd = int(form.Handle.ToInt64())
        user32, controls = ctypes.windll.user32, ctypes.windll.comctl32
        intptr, uintptr = ctypes.c_ssize_t, ctypes.c_size_t
        proc_type = ctypes.WINFUNCTYPE(intptr, wt.HWND, wt.UINT, uintptr, intptr, uintptr, uintptr)
        controls.SetWindowSubclass.argtypes = [wt.HWND, proc_type, uintptr, uintptr]
        controls.RemoveWindowSubclass.argtypes = [wt.HWND, proc_type, uintptr]
        controls.DefSubclassProc.argtypes = [wt.HWND, wt.UINT, uintptr, intptr]
        controls.DefSubclassProc.restype = intptr
        user32.RegisterHotKey.argtypes = [wt.HWND, ctypes.c_int, wt.UINT, wt.UINT]
        user32.UnregisterHotKey.argtypes = [wt.HWND, ctypes.c_int]
        user32.GetForegroundWindow.restype = wt.HWND
        user32.GetSystemMenu.argtypes = [wt.HWND, wt.BOOL]
        user32.GetSystemMenu.restype = wt.HMENU
        user32.InsertMenuW.argtypes = [wt.HMENU, wt.UINT, wt.UINT, uintptr, wt.LPCWSTR]

        wm_hotkey, wm_syscommand, wm_ncdestroy = 0x0312, 0x0112, 0x0082
        menu_command, subclass_id = 0x1ED0, 1
        # MOD_NOREPEAT | MOD_CONTROL | MOD_SHIFT, VK_E；另提供 F8。
        hotkeys = {0x5201: (0x4006, ord("E")), 0x5202: (0x4000, 0x77)}
        registered = set()

        def activate(*_):
            for key_id, (modifiers, key) in hotkeys.items():
                if key_id not in registered and user32.RegisterHotKey(hwnd, key_id, modifiers, key):
                    registered.add(key_id)

        def deactivate(*_):
            for key_id in registered:
                user32.UnregisterHotKey(hwnd, key_id)
            registered.clear()

        def open_editor():
            try:
                window.run_js("window.app?.enterEditorFromRuntime?.()")
            except Exception as exc:
                print(f"[desktop] 进入编辑器失败：{exc}")

        @proc_type
        def subclass(handle, msg, param, data, _id, _ref):
            shortcut = (msg == wm_hotkey and param in registered
                        and user32.GetForegroundWindow() == handle)
            menu_selected = msg == wm_syscommand and (param & 0xFFF0) == menu_command
            if shortcut or menu_selected:
                threading.Thread(target=open_editor, daemon=True).start()
                return 0
            if msg == wm_ncdestroy:
                deactivate()
                controls.RemoveWindowSubclass(handle, subclass, subclass_id)
            return controls.DefSubclassProc(handle, msg, param, data)

        if not controls.SetWindowSubclass(hwnd, subclass, subclass_id, 0):
            print("[desktop] 无法接入窗口快捷键，继续使用网页快捷键")
            return
        # Win32 持有的是函数指针，Python 对象必须活到窗口销毁。
        window._editor_shortcut_proc = subclass
        form.Activated += activate
        form.Deactivate += deactivate
        if user32.GetForegroundWindow() == hwnd:
            activate()

        menu = user32.GetSystemMenu(hwnd, False)
        if menu:
            user32.InsertMenuW(menu, 0, 0x0400, menu_command, "进入编辑器(&E)\tF8")

    def install_on_ui_thread():
        try:
            install()
        except Exception as exc:
            print(f"[desktop] 窗口快捷键初始化失败：{exc}")

    try:
        form.BeginInvoke(Action(install_on_ui_thread))
    except Exception as exc:
        print(f"[desktop] 窗口快捷键初始化失败：{exc}")


def main():
    ap = argparse.ArgumentParser(description="WebHMI_设计器（原生窗口 + 内置后端，关窗口即停服务）")
    ap.add_argument("--port", type=int, default=8866, help="端口（占用时自动换空闲端口）")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（客户机一般不用改）")
    ap.add_argument("--edit", action="store_true", help="直接开管理员登录页（登录后同一个地址就是编辑器）")
    ap.add_argument("--fullscreen", action="store_true", help="全屏开窗")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--title", default="", help="窗口标题（默认取工程名）")
    ap.add_argument("--data-dir", default="", help="数据目录（默认 server/data）")
    ap.add_argument("--no-auth", action="store_true", help="关掉登录闸门（调试用）")
    ap.add_argument("--no-window", action="store_true", help="只起服务不开窗口")
    ap.add_argument("--debug", action="store_true", help="打开 WebView 调试（devtools）")
    ap.add_argument("--mcp-live", action="store_true", help="允许本机 hmi-mcp 接管当前可见页面并实时保存（仅监听本机）")
    ap.add_argument("--self-test", action="store_true", help="自检：开窗口→等页面就绪→关窗口→退出")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:                                           # noqa: BLE001
        pass

    if args.data_dir:
        os.environ["HMI_DATA_DIR"] = args.data_dir

    # 告诉后端"我是原生窗口客户端起来的"：编辑器里点「立即更新」时，它要按这个方式
    # 把服务（连带窗口）重新拉起来（见 server/_restart.py 的 spawn）
    os.environ["HMI_LAUNCH"] = "desktop"

    # ⚠ 必须在设置好数据目录之后导入：server.py 在模块级就按 HMI_DATA_DIR 建数据源/存档路径
    import server as hmi

    # ⚠ AUTH_ENABLED 的"家"在 core/auth.py（它是**会被改的**开关，见 core/__init__.py 铁律①）。
    #   写成 `hmi.AUTH_ENABLED = ...` 只是给 server 模块挂了个同名影子属性，
    #   core.auth 里那个被处理器真正读的值一点没变 —— 表现是「--no-auth 没生效、还要登录」。
    hmi.auth.AUTH_ENABLED = not args.no_auth
    if hmi.auth.AUTH_ENABLED:
        hmi.load_auth()
        hmi.load_sessions()      # 关掉窗口再打开还认得上一次的登录（会话存在 server/data 里）

    port = pick_port(args.port, args.host)
    if port != args.port:
        print(f"[desktop] 端口 {args.port} 被占用，改用空闲端口 {port}")
    srv = hmi.QuietThreadingHTTPServer((args.host, port), hmi.HMIServer)
    th = threading.Thread(target=srv.serve_forever, daemon=True, name="hmi-http")
    th.start()
    # 报到：把"实际绑在哪个端口"写进数据目录 —— 更新助手靠它确认新版起没起来。
    # 换端口时尤其重要：助手按老端口查不到会误判成"没起来"→ 自动回滚（踩过）
    hmi.write_up_report(args.host, port)

    cdp_port = pick_cdp_port(port) if args.mcp_live else 0
    if args.mcp_live and cdp_port:
        os.environ["HMI_MCP_CDP_PORT"] = str(cdp_port)
        print(f"[desktop] hmi-mcp 实时页面端口：{cdp_port}（仅本机）")
    elif args.mcp_live:
        os.environ.pop("HMI_MCP_CDP_PORT", None)
        print("[desktop] 找不到空闲的 MCP 调试端口；实时窗口操作不可用")
    else:
        os.environ.pop("HMI_MCP_CDP_PORT", None)

    path = "/login" if args.edit else "/run"   # 默认开强制运行页 /run（登录着也只看运行画面，不再被持久登录顶成编辑器）；--edit → 直接给登录页
    url = f"http://{args.host}:{port}{path}"
    base = f"http://{args.host}:{port}"
    api = DesktopApi(base)
    api.host, api.port = args.host, port
    print("=" * 56)
    print("  WebHMI_设计器")
    print(f"  页面   : {url}{'（组态编辑器，要登录）' if args.edit else '（现场运行页，不用登录）'}")
    print(f"  数据   : {hmi.DATA_DIR}")
    print(f"  设备   : 启动时按上次保存的配置自动连接（{'OPC UA' if hmi._protocol_of() == 'opcua' else 'Modbus'}）")
    print("  ⚠ 关掉窗口 = 停服务：端口、轮询、推送一起停（不留后台进程）")
    print("  进编辑器: 按 Ctrl+Shift+E 或 F8，也可从窗口标题栏菜单进入（需要管理员权限）")
    print("=" * 56)

    if not args.no_window or args.self_test:
        try:
            import webview
        except Exception as e:                                  # noqa: BLE001
            print(f"[desktop] 没有 pywebview（{e}）—— 装一下就能用原生窗口：")
            print("            pip install pywebview")
            print("          现在先退回浏览器打开（关浏览器不会停服务，请用 stop_server.bat 停）")
            import webbrowser
            webbrowser.open(url)
            args.no_window = True                               # 退回「只有服务」模式

    hmi._autoconnect_saved_plc()          # 客户机：开机就是连着的真实数据
    # FRP 内网穿透：**上次开着就接着开**（跟 server.py 那条启动路径一个口径）。
    # ⚠ 现场踩过：桌面窗口这条路是**自己起服务**的（不走 server.py 的 main），
    #   以前这里漏了这一步 —— 界面里明明开着 FRP，重开软件它不自己起来，还得人手点一次
    #   「保存并应用」。收尾同理：窗口一关就把 frpc 一起收掉，别留个孤儿进程。
    try:
        hmi.frp.ensure(port)
        atexit.register(hmi.frp.stop)
    except Exception as e:                                      # noqa: BLE001
        print(f"[frp] 启动检查失败（不影响其它功能）：{type(e).__name__}: {e}")

    if args.no_window:
        print("[desktop] 只起服务（--no-window）。Ctrl+C 结束。")
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        _shutdown(srv, hmi)
        return 0

    import webview
    webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = False
    if cdp_port:
        webview.settings["REMOTE_DEBUGGING_PORT"] = cdp_port
    title = args.title or project_title()
    # ⚠ js_api 传的必须是**同一个实例**：以前写成 js_api=DesktopApi(base)（另一个对象），
    #   下面那句 api._win = win 就落在了页面拿不到的那个对象上 —— 于是 save_text 里 self._win 是 None
    #   （导出弹框要用到窗口，这里必须对上）
    win = webview.create_window(title, url, width=args.width, height=args.height,
                                min_size=(900, 600), fullscreen=args.fullscreen,
                                text_select=False, js_api=api)
    api._win = win      # ⚠ 必须挂在**下划线**属性上，见 DesktopApi.__init__ 里的说明（不然开窗会卡死）
    win.events.shown += lambda: _bind_editor_shortcuts(win)

    result = {}

    def _selftest_worker(w):
        """等页面就绪 → 记下证据 → 关窗口（关窗口就该把服务/端口一起带走）"""
        deadline = time.time() + 25
        while time.time() < deadline:
            time.sleep(0.5)
            try:
                ready = w.evaluate_js(_ready_expr())
            except Exception:                                   # noqa: BLE001
                continue
            if ready:
                break
        time.sleep(1.0)
        try:
            result["runOnly"] = bool(w.evaluate_js("!!(window.app && window.app.runOnly)"))
            result["title"] = w.evaluate_js("document.title || ''")
            result["widgets"] = int(w.evaluate_js("document.querySelectorAll('#rtPage .wd').length") or 0)
            result["path"] = w.evaluate_js("location.pathname || ''")
            result["loginPage"] = bool(w.evaluate_js("!!document.querySelector('input[type=password]')"))
            result["jsApi"] = bool(w.evaluate_js("!!(window.pywebview && window.pywebview.api)"))
            # 导出用的保存框接口在不在（页面靠它决定"导出"是弹框还是下载）；
            # 顺手报一下这个 WebView2 有没有 File System Access 的保存框（实测：没有 → 桌面版只能走 Python）
            result["saveApi"] = bool(w.evaluate_js("!!(window.pywebview && window.pywebview.api && window.pywebview.api.save_text)"))
            result["picker"] = str(w.evaluate_js("typeof window.showSaveFilePicker"))
            # 屏幕吸管（属性面板取色的「吸管」）走的是 pywebview 的 js_api → Win32 采屏。
            # WebView2 里 EyeDropper 是个空壳（有构造函数、吸不到色），所以自检直接验这条桥：
            # start → read → stop 打一轮，把每次的返回都记下来（现场一眼能看出是接口没进包/被拦，还是采屏失败）
            result["sampleApi"] = bool(w.evaluate_js(
                "!!(window.pywebview && window.pywebview.api && window.pywebview.api.pick_color_start)"))
            if result["sampleApi"]:
                w.evaluate_js(
                    "window.__pick=[];(async()=>{try{"
                    "window.__pick.push(['start',await window.pywebview.api.pick_color_start()]);"
                    "await new Promise(r=>setTimeout(r,150));"
                    "window.__pick.push(['read',await window.pywebview.api.pick_color_read()]);"
                    "window.__pick.push(['stop',await window.pywebview.api.pick_color_stop()]);"
                    "}catch(e){window.__pick.push(['error',String(e)])}})();1")
                time.sleep(0.6)
                try:
                    result["sample"] = json.loads(w.evaluate_js("JSON.stringify(window.__pick)") or "[]")
                except Exception:                            # noqa: BLE001
                    result["sample"] = "?"
            # 「是不是编辑器」不能看 #canvas 存不存在 —— index.html 里两种页面都有这个元素，
            # 运行页只是把它藏起来（display:none → offsetParent 为 null）
            result["editor"] = bool(w.evaluate_js(
                "!document.body.classList.contains('run-only') "
                "&& !!(document.getElementById('workspace')||{}).offsetParent"))
            result["url"] = url
            # 窗口 profile 是不是**持久**的（private_mode=False + storage_path）：
            # 不持久的话关窗口就把 cookie/localStorage 删了 —— 每次打开都要重新登录，
            # 这是现场最烦的一件事，所以自检里直接把它报出来
            try:
                import webview as _wv
                st = getattr(_wv, "_state", {}) or {}
                result["persistent"] = (not st.get("private_mode", True)) and bool(st.get("storage_path"))
                result["store"] = str(st.get("storage_path") or "")
            except Exception:                                   # noqa: BLE001
                pass
        except Exception as e:                                  # noqa: BLE001
            result["error"] = str(e)
        print("[desktop] 自检：" + json.dumps(result, ensure_ascii=False))
        w.destroy()                                             # 相当于用户点了关闭

    try:
        # ⚠ private_mode=False + storage_path：**必须**。
        #   pywebview 默认 private_mode=True —— 关窗口就把 cookie/localStorage 删了，
        #   于是每次打开都要重新登录、OPC UA 的账号密码也记不住（现场最烦的就是这个）。
        #   落到数据目录里，跟工程/PLC 配置放一起，换机器一起拷走。
        # 实时 MCP 模式每个桌面实例独立 WebView2 profile；否则两个 EXE 会共用浏览器进程，
        # 调试端口无法一一对应，登录态也会串到另一个窗口。
        store = hmi.DATA_DIR / (f"webview-mcp-{port}" if cdp_port else "webview")
        store.mkdir(parents=True, exist_ok=True)
        start_kw = dict(debug=args.debug, private_mode=False, storage_path=str(store))
        if args.self_test:
            webview.start(_selftest_worker, win, **start_kw)
        else:
            webview.start(**start_kw)
    finally:
        _shutdown(srv, hmi)

    if args.self_test:
        # 就绪的三种样子：现场运行页 / 登录页 / 已经登录着的编辑器
        ok = (not result.get("error")) and (result.get("runOnly") or result.get("loginPage")
                                            or result.get("editor"))
        print(f"SELFTEST_{'OK' if ok else 'FAIL'} port={port} {json.dumps(result, ensure_ascii=False)}")
        return 0 if ok else 1
    print("[desktop] 窗口已关闭，服务已停止。")
    return 0


def _shutdown(srv, hmi):
    """停轮询 → 关监听 → 变量落盘（顺序别反：先把轮询停了再关 socket，免得刷一堆异常）

    ⚠ 当前数据源要用 `datasource.get_source()` 读，不能 `hmi._source`：
    它连/断设备时会被换成另一个对象（见 core/__init__.py 铁律①）——
    直接取模块属性拿到的是"上一次赋值的那个"，连上 PLC 之后停的还是内存那份。
    """
    try:
        if isinstance(hmi.datasource.get_source(), hmi._REMOTE_SRC):
            hmi.datasource.get_source().stop()
    except Exception:                                           # noqa: BLE001
        pass
    try:
        srv.shutdown()
        srv.server_close()
    except Exception:                                           # noqa: BLE001
        pass
    try:
        hmi.frp.stop()                    # 关窗口 = 把内网穿透也收掉（别留个孤儿 frpc 在外面跑）
    except Exception:                                           # noqa: BLE001
        pass
    try:
        hmi.datasource.get_source().flush()
    except Exception:                                           # noqa: BLE001
        pass


if __name__ == "__main__":
    sys.exit(main())
