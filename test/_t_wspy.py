# -*- coding: utf-8 -*-
"""自检 _wspy.py：起一个隔离后端，验握手 / hello / 调接口 / 请求带 query / 探活。"""
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _wspy                                                       # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def free_port():
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


port = free_port()
data = tempfile.mkdtemp(prefix="hmi-wspy-")
srv = subprocess.Popen([PY, "server/server.py", "--port", str(port), "--no-browser", "--no-auth"],
                       cwd=str(ROOT), env={**__import__("os").environ, "HMI_DATA_DIR": data},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
out = []
ok = lambda n, c, e="": out.append(f"{'PASS' if c else 'FAIL'}  {n}" + (f"  [{e}]" if e else ""))   # noqa: E731
try:
    up = False
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).read()
            up = True
            break
        except Exception:
            time.sleep(0.3)
    ok("探针后端起来了", up)
    if not up:
        raise SystemExit(1)

    h = _wspy.hello(port)
    ok("hello() 读回 hello 帧", bool(h) and h.get("t") == "hello" and h.get("build"), str(h)[:80])
    ok("hello 里有 version/features/auth/plc", all(k in (h or {}) for k in ("version", "features", "auth", "plc")))

    p = _wspy.api(port, "/api/vars", method="GET")
    ok("api() GET /api/vars 拿到 payload", isinstance(p, dict) and "vars" in p, str(p)[:80])

    p2 = _wspy.api(port, "/api/project", method="GET")
    ok("api() GET /api/project 拿到 data", isinstance(p2, dict) and "data" in p2, str(p2)[:60])

    p3 = _wspy.api(port, "/api/update/check?force=1", method="GET")
    ok("带 query 的路径也认（/api/update/check?force=1）",
       isinstance(p3, dict) and "state" in p3, str(p3)[:80])

    c = _wspy.connect(port)
    a = c.api("/api/vars", method="GET")
    b = c.api("/api/logsettings", method="GET")
    ok("一条连接上连着调两次都行", "vars" in a and "keep_days" in b, f"{str(a)[:30]} / {str(b)[:40]}")
    ok("conn.hello 也在", bool(c.hello))
    c.close()

    ok("连不上的端口 → hello() 返回 None（不抛）", _wspy.hello(free_port()) is None)
finally:
    srv.kill()
    import shutil
    time.sleep(0.2)
    shutil.rmtree(data, ignore_errors=True)

print("\n".join(out))
print(f"\n{sum(1 for x in out if x.startswith('PASS'))}/{len(out)} 通过")
sys.exit(0 if all(x.startswith("PASS") for x in out) else 1)
