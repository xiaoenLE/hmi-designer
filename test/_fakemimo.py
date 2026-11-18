#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_fakemimo.py — 假的 MiMo（OpenAI 兼容）模型服务（纯标准库，零依赖）

为什么要有它：AI 助手的测试**不能打真接口**（要真 key、要花钱、还不稳定、还慢），
所以这里起一个本地 HTTP 服务，把 `POST {base_url}/chat/completions` 的**流式**响应
按脚本演一遍：正常文本流、思维链、工具调用分片、401/429、慢吞吞吐字（测取消）、
装死（测超时）…… 后端 `core/ai.py` 完全不知道对面是假的。

脚本化：`srv.set_script([spec, spec, …])`，**每个请求消费一条**（脚本用完回一条默认文本）。
spec 全可选：
  status      非 200：直接回 JSON 错误体（401/429/500），不发 SSE
  body        status 非 200 时的响应体
  stall       先 sleep 这么多秒、**一个字节都不发**（测超时：客户端该自己超时）
  delay       每发一块前 sleep 这么多秒（测取消：让它慢慢吐字）
  reasoning   [str]    reasoning_content 分片（拼起来是思维链）
  text        [str]    content 分片（拼起来是正文）
  tools       [dict]   逐块 tool_calls delta：{index, id?, name?, arguments?}
                       —— 真实模型是"首块带 id+name、后续块同 index 只给 arguments 分片"，
                       这里让你自己排布，两种都测得出来
  usage       dict     usage 块（就是那个 choices:[] 的收尾块）
  finish      结束块 finish_reason（给了 tools 默认 tool_calls，否则 stop）

用法：
  python test/_fakemimo.py              # 前台跑一个并打印端口（Lead 真机联调时可拿它顶替真模型）
  python test/_fakemimo.py 8899         # 指定端口
  import _fakemimo; srv = _fakemimo.start(); print(srv.base_url())
  srv.requests                          # 收到的请求（含 body / headers），断言"发出去的请求长什么样"
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_DEBUG = False            # 想看每个请求打一行：_fakemimo._DEBUG = True


class State:
    """一条假模型服务的全部可变状态（多线程：请求是并发进来的，都要加锁）"""

    def __init__(self):
        self.lock = threading.Lock()
        self.script = []          # 待消费的响应脚本（FIFO）
        self.requests = []        # 收到的请求（测试断言用）
        self.hits = 0             # 一共被打了几个请求

    def next_spec(self):
        with self.lock:
            self.hits += 1
            return dict(self.script.pop(0)) if self.script else {}

    def record(self, path, headers, body):
        with self.lock:
            self.requests.append({"path": str(path), "headers": dict(headers or {}),
                                  "body": body})
            return len(self.requests)

    def set_script(self, specs):
        with self.lock:
            self.script = [dict(s) for s in (specs or [])]


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"      # 流式响应靠连接关闭收尾（不搞 chunked，够用且简单）

    def log_message(self, fmt, *args):             # 别把测试输出刷满
        if _DEBUG:
            print("[fakemimo] " + (fmt % args))

    # 探活（手工排查时 curl 一下就知道服务活着没）
    def do_GET(self):
        self._json(200, {"ok": True, "fake": "mimo", "hits": self.server.state.hits})

    def do_POST(self):
        st = self.server.state
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:                                         # noqa: BLE001
            body = {"_raw": raw[:200].decode("utf-8", "replace")}
        st.record(self.path, self.headers, body)
        spec = st.next_spec()
        if not str(self.path).rstrip("/").endswith("/chat/completions"):
            self._json(404, {"error": {"message": "fake: 只认 …/chat/completions",
                                       "type": "fake_not_found"}})
            return
        status = int(spec.get("status") or 0)
        if status:
            self._json(status, spec.get("body") or
                       {"error": {"message": "fake 故意返回的错误", "type": "fake_error"}})
            return
        self._sse(spec)

    # ── 响应 ──
    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _sse(self, spec):
        """把 spec 演成一条 OpenAI 兼容的 SSE 流"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        delay = float(spec.get("delay") or 0)
        stall = float(spec.get("stall") or 0)
        if stall:
            # 一个字节都不发：客户端要么自己超时，要么一直等着 —— 这正是"超时"用例要的
            time.sleep(stall)

        def chunk(obj):
            self.wfile.write(b"data: " + json.dumps(obj, ensure_ascii=False).encode("utf-8")
                             + b"\n\n")
            self.wfile.flush()
            if delay:
                time.sleep(delay)

        def delta(d):
            chunk({"choices": [{"index": 0, "delta": d}]})

        try:
            delta({"role": "assistant"})
            for s in spec.get("reasoning") or []:
                delta({"reasoning_content": str(s)})
            for s in spec.get("text") or []:
                delta({"content": str(s)})
            for frag in spec.get("tools") or []:
                tc = {"index": int(frag.get("index") or 0)}
                if frag.get("id"):
                    tc["id"] = str(frag["id"])
                if frag.get("name"):
                    tc.setdefault("function", {})["name"] = str(frag["name"])
                if frag.get("arguments") is not None:
                    tc.setdefault("function", {})["arguments"] = str(frag["arguments"])
                chunk({"choices": [{"index": 0, "delta": {"tool_calls": [tc]}}]})
            finish = spec.get("finish") or ("tool_calls" if spec.get("tools") else "stop")
            chunk({"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
            if spec.get("usage"):
                chunk({"choices": [], "usage": dict(spec["usage"])})     # 收尾的 usage 块
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                    # 客户端已超时/取消关掉了连接 —— 假服务不该因此崩


class FakeMimo(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr=("127.0.0.1", 0)):
        super().__init__(addr, _Handler)
        self.state = State()

    @property
    def port(self):
        return int(self.server_address[1])

    def base_url(self):
        """直接能填进 ai.json 的 base_url（带 /v1）"""
        return f"http://127.0.0.1:{self.port}/v1"

    def set_script(self, specs):
        self.state.set_script(specs)

    @property
    def requests(self):
        with self.state.lock:
            return list(self.state.requests)

    @property
    def hits(self):
        return int(self.state.hits)

    def reset(self, specs=None):
        with self.state.lock:
            self.state.script = [dict(s) for s in (specs or [])]
            self.state.requests = []
            self.state.hits = 0


def start(port=0):
    """起一个后台线程里的假模型服务 → 返回 srv（srv.port / srv.base_url() / srv.set_script()）"""
    srv = FakeMimo(("127.0.0.1", int(port or 0)))
    threading.Thread(target=srv.serve_forever, name="fakemimo", daemon=True).start()
    return srv


def main(argv):
    port = 0
    if len(argv) > 1:
        try:
            port = int(argv[1])
        except ValueError:
            print(f"端口不对：{argv[1]!r}")
            return 2
    srv = FakeMimo(("127.0.0.1", port))
    print(f"假模型已在 http://127.0.0.1:{srv.port}/v1 上跑着"
          f"（base_url 填这个；脚本用例见 test/verify-ai-backend.py；Ctrl+C 结束）")
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
