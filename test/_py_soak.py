"""后端内存体检台（直指 Python 那侧）。

现场那条链路是「脚本每秒写十几次变量」→ 后端一直被 POST /api/vars 打。
这个脚本把后端起在**当前进程里**，再用一个 keep-alive 的客户端按现场节奏压，
期间只做三件事：量 RSS、量线程/连接/各表长度、用 tracemalloc 抓"到底谁在涨"。

用法：
    python test/_py_soak.py                 # 默认 8 分钟、12 次写/秒（当前代码：HTTP/1.1 复用）
    python test/_py_soak.py 8 12 legacy     # 同样条件，但把协议改回 HTTP/1.0（改之前的样子）
"""
import ctypes
import ctypes.wintypes as wt
import gc
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import tracemalloc
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "server"))
os.environ["HMI_DATA_DIR"] = tempfile.mkdtemp(prefix="pysoak-")

MINUTES = float(sys.argv[1]) if len(sys.argv) > 1 else 8
RATE = float(sys.argv[2]) if len(sys.argv) > 2 else 12
MODE = sys.argv[3] if len(sys.argv) > 3 else ""

# 报告同时写一份到文件：控制台是 GBK，中文行在管道里会变乱码（读文件更稳）
OUT = HERE / "out" / f"py-soak-{MODE or 'current'}.txt"
OUT.parent.mkdir(parents=True, exist_ok=True)
_OUT = open(OUT, "w", encoding="utf-8")


def say(line=""):
    print(line)
    _OUT.write(line + "\n")
    _OUT.flush()

import server as hmi                                                  # noqa: E402

if MODE == "legacy":
    hmi.HMIServer.protocol_version = "HTTP/1.0"                       # 改之前：一问一答一连接
    say("模式：legacy（HTTP/1.0，每个请求一条连接）")
else:
    say("模式：当前代码（HTTP/1.1 连接复用）")
if MODE == "err":
    say("模式：故意写坏地址")


class PMC(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]


def rss_mb():
    """工作集 / 私有提交（MB）。用 K32GetProcessMemoryInfo（psapi 的导出在 kernel32 里，
    psapi.dll 那份在新系统上不一定能直接调）。"""
    c = PMC()
    c.cb = ctypes.sizeof(PMC)
    fn = ctypes.windll.kernel32.K32GetProcessMemoryInfo
    fn.restype = wt.BOOL
    fn.argtypes = [wt.HANDLE, ctypes.POINTER(PMC), wt.DWORD]
    ok = fn(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    if not ok:
        return (-1.0, -1.0)
    return c.WorkingSetSize / 1048576, c.PagefileUsage / 1048576


# 起后端（当前进程内）
port = 8913
srv = hmi.QuietThreadingHTTPServer(("127.0.0.1", port), hmi.HMIServer)
threading.Thread(target=srv.serve_forever, daemon=True, name="hmi-http").start()
# 备一张变量表（现场那台是 49~280 个变量，取个中间值）：
# 走前端的正规路径下发变量表（内存模式不轮询，只是把表建起来）
# ⚠ 当前数据源要用 datasource.get_source() 读：拆成 core/ 之后 `hmi._source` 已经不存在了
#   （_source 住在 core.datasource 里，而且连/断设备时会被换对象，见 server/core/__init__.py 铁律①）
hmi.datasource.get_source().declare([{"name": f"v{i}", "type": "real", "address": f"%MW{100 + i * 2}", "value": 0}
                                     for i in range(120)])
time.sleep(0.5)

CONN = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
stop = threading.Event()
sent = [0]
errors = [0]


def driver():
    """按现场节奏写变量：全走同一条连接（keep-alive），HTTP/1.0 时后端会自己关掉"""
    n = 0
    global CONN
    while not stop.is_set():
        name = "badAddrVar" if MODE == "err" else f"v{n % 120}"
        body = json.dumps({"name": name, "value": n % 1000})
        try:
            CONN.request("POST", "/api/vars", body=body, headers={"Content-Type": "application/json"})
            CONN.getresponse().read()
            sent[0] += 1
        except Exception:
            errors[0] += 1
            try:
                CONN.close()
            except Exception:
                pass
            CONN = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        n += 1
        time.sleep(max(0.0, 1.0 / RATE - 0.0015))


tracemalloc.start(12)
threading.Thread(target=driver, daemon=True, name="driver").start()

t0 = time.time()
prev = None
say("\n  时间   工作集MB 私有MB  线程  请求数/秒  conns   reqs   _extra  _errSeen  对象数")
snap_prev = tracemalloc.take_snapshot()
rows = []
while time.time() - t0 < MINUTES * 60:
    time.sleep(30)
    ws, priv = rss_mb()
    s = sent[0]
    rate = (s - (prev or 0)) / 30
    prev = s
    rows.append((time.time() - t0, ws, priv, s))
    say(f"  {(time.time()-t0)/60:5.1f}分 {ws:9.1f} {priv:7.1f} {threading.active_count():5d} {rate:10.1f}"
          f" {hmi.QuietThreadingHTTPServer.conns:6d} {hmi.HMIServer.reqs:6d}"
          f" {len(hmi._extra_internal):7d} {len(hmi._err_seen):9d} {len(gc.get_objects()):8d}")

if len(rows) >= 2:
    d_ws = rows[-1][1] - rows[0][1]
    mins = (rows[-1][0] - rows[0][0]) / 60
    say(f"\n{MINUTES:.1f} 分钟：工作集 {rows[0][1]:.1f} → {rows[-1][1]:.1f} MB"
          f"（{d_ws / mins:+.2f} MB/分 → 8 小时 {d_ws / mins * 480:+.0f} MB）")
    say(f"总请求 {sent[0]}（连接错误重试 {errors[0]}）· 接受连接 {hmi.QuietThreadingHTTPServer.conns}"
          f" · 每连接平均请求 {hmi.HMIServer.reqs / max(1, hmi.QuietThreadingHTTPServer.conns):.1f}")

snap = tracemalloc.take_snapshot()
diff = snap.compare_to(snap_prev, "lineno")[:12]
say("\n这期间**还活着**的内存，涨得最多的分配点：")
for st in diff:
    if st.size_diff <= 0:
        continue
    say(f"  {st.size_diff/1024:+9.1f} KB  {st.traceback.format()[-1].strip()}")
stop.set()
srv.shutdown()
