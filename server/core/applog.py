#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""applog.py — 运行日志：按天轮转、自动清理、控制台同时落盘

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

现场机是无人值守的：日志既要在 cmd 里看得见，也要留在盘上事后查，还不能把盘写满。
`_Tee` 把 print / stderr 同时写控制台和 logs/hmi-日期.log；
清理只删文件名带日期、且超出保留窗口的那三种日志（hmi-* / update-* / script-*）。
"""

from .paths import LOG_DIR
from .settings import _LOG_NAME_RE
from .settings import log_keep_days

import atexit
import queue
import sys
import threading
import time


_LOG_FILE = None

_LOG_DAY = ""

_LOG_PRUNED_DAY = ""



def _log_prune(force=False):
    """删掉保留窗口之外的日志文件（默认留最近 3 天）。返回删掉几个。

    · 只认 `hmi-YYYY-MM-DD.log` / `update-YYYY-MM-DD.log`：日期从**文件名**取，
      不看 mtime（拷来拷去、备份还原会把 mtime 改掉，文件名不会）；
    · 一天只清一次（force=True 立刻清：启动那一次用）；
    · 任何异常都吞掉：清日志失败绝不能让服务起不来。
    """
    global _LOG_PRUNED_DAY
    day = time.strftime("%Y-%m-%d")
    if not force and _LOG_PRUNED_DAY == day:
        return 0
    _LOG_PRUNED_DAY = day
    keep = log_keep_days()                       # 每次现算：界面上改了立刻按新窗口清（不用重启）
    try:
        cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - (keep - 1) * 86400))
    except Exception:                                           # noqa: BLE001
        return 0
    removed = []
    try:
        for f in LOG_DIR.iterdir():
            if not f.is_file():
                continue
            m = _LOG_NAME_RE.match(f.name)
            if not m:
                continue                                    # 不是我们写的日志：不动
            if m.group(1) < cutoff:                         # 文件名是 YYYY-MM-DD：字符串比大小就是比日期
                try:
                    f.unlink()
                    removed.append(f.name)
                except Exception:                           # noqa: BLE001
                    pass
    except Exception:                                           # noqa: BLE001
        return 0
    if removed:
        _log_line(f"[log] 清掉 {len(removed)} 个超过 {keep} 天的旧日志："
                  f"{', '.join(sorted(removed)[:6])}{' …' if len(removed) > 6 else ''}")
    return len(removed)



def _log_ensure():
    """返回「今天」的日志文件句柄；日期变了就换新文件（顺手清一次过期日志）"""
    global _LOG_FILE, _LOG_DAY
    day = time.strftime("%Y-%m-%d")
    if _LOG_FILE is not None and day == _LOG_DAY:
        return _LOG_FILE
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if _LOG_FILE is not None:
            _LOG_FILE.close()
        _LOG_FILE = open(LOG_DIR / f"hmi-{day}.log", "a", encoding="utf-8")
        _LOG_DAY = day
        _log_prune()                       # 跨天换文件时清一次（每天一次，够了）
    except Exception:                                           # noqa: BLE001
        _LOG_FILE = None
    return _LOG_FILE



def _log_line(text):
    f = _log_ensure()
    if f is not None:
        try:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {text}\n")
            f.flush()
        except Exception:                                       # noqa: BLE001
            pass



_TEES = []          # 装好的 _Tee（退出时要把队列里剩的话写完，见 _drain_at_exit）


def _drain_at_exit():
    """进程要退了：把控制台队列里剩下的话**尽量**写完再走。

    为什么需要：控制台走的是「后台线程 + 有界队列」（控制台被点住时不卡请求线程，
    见 _ConsoleWriter），而那个线程是 daemon —— 进程一退它就没了，队列里没写完的
    **直接丢**。表现就是"最后几行日志怎么没打出来"，以及
    `python -c "import server; ...; print(...)"` 这种脚本里 print 的东西少一半
    （测试里的 Python 探针就踩在这儿：明明跑对了，输出却是空的）。

    ⚠ 只等很短一会儿（0.5 秒）：控制台真被点住时也绝不拖住退出。
    """
    for tee in _TEES:
        try:
            tee.flush()                     # 半行也落进日志文件
        except Exception:                   # noqa: BLE001
            pass
    end = time.time() + 0.5
    for tee in _TEES:
        w = getattr(tee, "console", None)
        if w is None or not getattr(w, "enabled", False):
            continue
        while time.time() < end:
            try:
                if w.q.empty():
                    break
            except Exception:               # noqa: BLE001
                break
            time.sleep(0.01)


class _ConsoleWriter:
    """往控制台写字的**后台**线程：有界队列 + 满了就丢 —— **绝不回头等控制台**。

    为什么非要这一层（现场真踩过，整个后端"死"了那种）：
      Windows 控制台一旦被点住就进入「标记/选择」模式（窗口标题会变成「选择 …」），
      这时**谁往它写谁就卡住**，直到有人在那个窗口里按 Esc/回车。
      而这个后端是多线程处理请求的：写变量那个请求里有一句 print（"[var] x = 1"），
      控制台一被点住，那个线程就永远停在 write 上 —— 浏览器那边请求一直不返回，
      界面上就是「下发失败」刷屏 + 页面卡住，连刷新都刷不动（以为是软件坏了）。
      把控制台挪到后台线程 + 有界队列之后：队列满就丢日志，请求线程一秒都不等。
    """

    def __init__(self, console, name="hmi-log"):
        self.console = console
        self.q = queue.Queue(maxsize=500)
        self.dropped = 0
        self.enabled = console is not None
        self.t = None
        if self.enabled:
            self.t = threading.Thread(target=self._loop, name=name, daemon=True)
            self.t.start()

    def _loop(self):
        while True:
            s = self.q.get()
            if s is None:
                return
            try:
                self.console.write(s)
                self.console.flush()
                n, self.dropped = self.dropped, 0
                if n:
                    # 控制台刚才写不动（多半是被点住进了「选择」模式）：恢复正常后说一声，
                    # 免得用户以为日志里"少的那一段"是程序自己没打
                    self.console.write(f"[warn] 控制台刚才写不动（窗口被点住/暂停？），丢了 {n} 行日志；"
                                       f"在那个窗口里按一下 Esc 就能恢复\n")
                    self.console.flush()
            except Exception:                                   # noqa: BLE001
                pass

    def write(self, s):
        if not self.enabled or not s:
            return
        try:
            self.q.put_nowait(s)
        except queue.Full:
            # 控制台被点住/卡住：丢日志，绝不阻塞调用方（丢了多少次，恢复后说一声）
            self.dropped += 1

    def flush(self):
        pass



class _Tee:
    """把 stdout/stderr 同时写进**日志文件**（同步）和**控制台**（后台线程，不阻塞）

    ⚠ 控制台那半边走 _ConsoleWriter：控制台被点住时只丢日志、不卡请求线程（见它的说明）。
    """

    def __init__(self, console):
        self.console = _ConsoleWriter(console)
        self.pending = ""
        # 兼容老写法（万一有人还读 .console.write）
        self.raw_console = console

    def reconfigure(self, *a, **kw):
        # 兼容 main() 里的 sys.stdout.reconfigure(encoding="utf-8")：转给真正的控制台
        if self.raw_console is not None:
            try:
                return self.raw_console.reconfigure(*a, **kw)
            except Exception:                                   # noqa: BLE001
                pass
        return self

    def write(self, s):
        self.console.write(s)                                   # 后台线程写控制台（满了就丢）
        self.pending += s
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            if line.strip():
                _log_line(line)

    def flush(self):
        if self.pending.strip():
            _log_line(self.pending.rstrip("\n"))
            self.pending = ""
        f = _log_ensure()
        if f is not None:
            try:
                f.flush()
            except Exception:                                   # noqa: BLE001
                pass



def _install_daily_log():
    console_out, console_err = sys.stdout, sys.stderr
    out_tee, err_tee = _Tee(console_out), _Tee(console_err)
    sys.stdout, sys.stderr = out_tee, err_tee
    _TEES[:] = [out_tee, err_tee]
    # 退出前把控制台队列排空（daemon 线程一走，队列里剩下的就丢了 —— 见 _drain_at_exit）
    atexit.register(_drain_at_exit)

    def _hook(t, v, tb):
        import traceback
        msg = "".join(traceback.format_exception(t, v, tb)).rstrip()
        for line in msg.splitlines():
            _log_line(line)
        err_tee.write(msg + "\n")       # 也走"后台写控制台"那条路：控制台卡住不连累异常处理
    sys.excepthook = _hook



_install_daily_log()

# 启动就清一次过期日志（只留最近 N 天，N 见「工程 ▾ → 日志设置…」）—— 之后跨天换文件时会自己再清一次
_log_prune(force=True)
