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
  --no-window        只起服务不开窗口（调试 / 自动化）
  --self-test        自检：起服务 → 开窗口 → 等页面就绪 → 关窗口 → 打印结果并退出
"""
import argparse
import json
import os
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
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def project_title(default: str = "WebHMI_设计器 · 运行") -> str:
    """窗口标题用工程名（没工程就用默认）"""
    try:
        import server as hmi
        if hmi.PROJECT_FILE.exists():
            d = json.loads(hmi.PROJECT_FILE.read_text(encoding="utf-8"))
            name = (d.get("meta") or {}).get("name")
            if name:
                return f"{name} · 运行"
    except Exception:                                           # noqa: BLE001
        pass
    return default


class DesktopApi:
    """暴露给页面的一小撮接口（window.pywebview.api.*）——目前只用来**表明"这是原生窗口"**
    （页面据此决定「去运行画面」是同一个窗口换页、还是浏览器里另开标签）。

    ⚠ 这些方法里**不要**去操作窗口（load_url / evaluate_js）：
      js_api 调用期间页面的 JS 是阻塞的，Python 再回头调页面会死锁（实测过）。
      页面自己用 location.href 换页就行了 —— 浏览器和 WebView 都灵。
    """

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.win = None
        self.host = ""
        self.port = 0

    def where(self):
        """让页面问一句「这是原生窗口吗、开的是哪个页」"""
        return {"desktop": True, "base": self.base}

    def goto_editor(self):      # 兼容旧调用：只回话，换页由页面自己做
        return {"path": "/login"}

    def goto_runtime(self):
        return {"path": "/run"}

    def goto_login(self):
        return {"path": "/login"}


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
    print("  进编辑器: 运行页里按 Ctrl+Shift+E（没登录会先弹登录页）；编辑器里「工程 ▾ → 去运行画面」切回")
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
    title = args.title or project_title()
    win = webview.create_window(title, url, width=args.width, height=args.height,
                                min_size=(900, 600), fullscreen=args.fullscreen,
                                text_select=False, js_api=DesktopApi(base))
    api.win = win

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
        store = hmi.DATA_DIR / "webview"
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
        hmi.datasource.get_source().flush()
    except Exception:                                           # noqa: BLE001
        pass


if __name__ == "__main__":
    sys.exit(main())
