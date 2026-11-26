#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify-ai-backend.py — AI 后端的**纯标准库**单测（不需要浏览器）

覆盖：
  1. /api/ai/config 读写：key 掩码、只写不读回、`__keep__` 不改、数值夹取、thinking 归一
  2. hello 帧里的 ai 段（enabled / model / has_key）
  3. WS `{t:'ai'}`：正常流（ai_delta → ai_done）、工具调用（ai_tool）、取消、错误码
  4. 发出去的模型请求：stream:true、thinking:{type:"disabled"}. temperature/max_tokens 生效
  5. 明文 key 永不出现在任何 WS 帧里

跑法（在 hmi-designer-v2 目录下）：
  python test/verify-ai-backend.py
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from _wspy import connect, hello  # noqa: E402

PASS = 0
FAIL = 0
FAILED = []


def ok(cond, name, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        tail = "" if extra is None else "  ->  " + json.dumps(extra, ensure_ascii=False)[:400]
        print(f"  FAIL {name}{tail}")


def section(t):
    print(f"\n== {t} ==")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ───────────────────────── 假的小米模型（OpenAI 兼容 SSE） ─────────────────────────
class Fake:
    mode = "text"          # text | tools | slow
    calls = []             # [{'path':..., 'body':...}]
    hit = threading.Event()


TOOL_ARGS = json.dumps({"name": "AI后端测试页"}, ensure_ascii=False)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):     # 别把访问日志刷到控制台
        pass

    def do_POST(self):             # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw or b"{}")
        except Exception:                       # noqa: BLE001
            body = {}
        Fake.calls.append({"path": self.path, "body": body})
        Fake.hit.set()

        # 模拟"接口地址少 /v1"：LM Studio 这类服务会回 200 + 一行 error JSON（不是 SSE）
        if not self.path.startswith("/v1/"):
            blobs = json.dumps({"error": "Unexpected endpoint or method. (POST /chat/completions)"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(blobs)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(blobs)
            self.wfile.flush()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def w(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        def delta(d):
            w({"choices": [{"index": 0, "delta": d, "finish_reason": None}]})

        def finish(fr, usage=None):
            w({"choices": [{"index": 0, "delta": {}, "finish_reason": fr}]})
            if usage:
                w({"choices": [], "usage": usage})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

        mode = Fake.mode
        try:
            if mode == "slow":
                for _ in range(100):           # 10 秒内什么都不发（等前端/后端取消）
                    time.sleep(0.1)
                return finish("stop", {"prompt_tokens": 1, "completion_tokens": 1})
            if mode == "tools":
                w({"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [
                    {"index": 0, "id": "call_b1", "type": "function",
                     "function": {"name": "add_page", "arguments": ""}}]}, "finish_reason": None}]})
                for i in range(0, len(TOOL_ARGS), 7):        # 故意分片
                    delta({"tool_calls": [{"index": 0, "function": {"arguments": TOOL_ARGS[i:i + 7]}}]})
                return finish("tool_calls", {"prompt_tokens": 50, "completion_tokens": 9})
            delta({"role": "assistant", "content": "你好，"})
            delta({"content": "我是测试模型。"})
            return finish("stop", {"prompt_tokens": 11, "completion_tokens": 6,
                                   "prompt_tokens_details": {"cached_tokens": 7}})
        except (BrokenPipeError, ConnectionResetError):
            return                         # 被取消/断连：正常现象


def start_fake():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.daemon_threads = True
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, srv.server_address[1]


# ───────────────────────── 帧工具 ─────────────────────────
def recv_until(c, pred, timeout=20.0):
    """读到 pred(frame) 为真；返回读到的全部帧。"""
    frames = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = c.read_json(max(0.2, deadline - time.time()))
        frames.append(j)
        if pred(j):
            return frames
    raise TimeoutError("等不到期望的帧，已经收到：" + json.dumps(frames, ensure_ascii=False)[:600])


def wait_ready(port, tries=50):
    for _ in range(tries):
        h = hello(port)
        if h:
            return h
        time.sleep(0.25)
    raise RuntimeError("服务器没起来")


def write_cfg(data_dir, **over):
    cfg = {
        "enabled": True,
        "base_url": FAKE_URL,
        "model": "mimo-v2.6-flash",
        "api_key": "sk-test-secret-9999",
        "temperature": 0.2,
        "max_tokens": 4000,
        "thinking": "disabled",
        "timeout": 10,
        "max_rounds": 8,
    }
    cfg.update(over)
    (Path(data_dir) / "ai.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


FAKE_URL = ""      # main() 里填
PORT = 0
DATA = ""
CFG = {}


def cfg_get(c):
    r = c.api("/api/ai/config", method="GET")
    return r


def cfg_post(c, patch):
    return c.api("/api/ai/config", method="POST", body=patch)


def main():
    global FAKE_URL, PORT, DATA, CFG
    fake_srv, fake_port = start_fake()
    FAKE_URL = f"http://127.0.0.1:{fake_port}/v1"
    PORT = free_port()
    DATA = tempfile.mkdtemp(prefix="hmi-ai-backend-")
    write_cfg(DATA)

    env = dict(os.environ)
    env["HMI_DATA_DIR"] = DATA
    srv = subprocess.Popen(
        [sys.executable, "server/server.py", "--port", str(PORT), "--no-browser", "--no-auth"],
        cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    c = None
    try:
        h = wait_ready(PORT)
        c = connect(PORT)

        section("1. hello 里的 ai 段（能力位）")
        ai = (h or {}).get("ai") or {}
        ok(bool(ai), "hello.ai 存在", h and list(h.keys()))
        ok(ai.get("enabled") is True, "hello.ai.enabled = true", ai)
        ok(ai.get("model") == "mimo-v2.6-flash", "hello.ai.model 是配置里的模型", ai)
        ok(ai.get("has_key") is True, "hello.ai.has_key = true", ai)
        ok("features" not in ai and "api_key" not in json.dumps(ai), "hello.ai 不带 key/地址", ai)

        section("2. GET /api/ai/config（只读掩码）")
        r = cfg_get(c)
        ok(r.get("ok") is True, "GET 返回 ok", {k: v for k, v in r.items() if k == "cfg"})
        CFG = r.get("cfg") or {}
        ok(CFG.get("model") == "mimo-v2.6-flash", "model 读回来", CFG.get("model"))
        ok(CFG.get("base_url") == FAKE_URL, "base_url 读回来", CFG.get("base_url"))
        ok(CFG.get("api_key_masked") == "sk-****9999", "api_key 是掩码", CFG.get("api_key_masked"))
        ok("api_key" not in CFG, "响应里没有明文 api_key", list(CFG.keys()))
        ok(CFG.get("has_key") is True, "has_key = true", CFG.get("has_key"))
        ok(CFG.get("thinking") == "disabled", "thinking = disabled", CFG.get("thinking"))

        section("3. POST /api/ai/config（写、夹取、key 只写）")
        r = cfg_post(c, {"model": "mimo-test-x", "temperature": 1.5})
        CFG = r.get("cfg") or {}
        ok(CFG.get("model") == "mimo-test-x", "model 改掉了", CFG.get("model"))
        ok(CFG.get("temperature") == 1.5, "temperature 生效", CFG.get("temperature"))
        ok(CFG.get("api_key_masked") == "sk-****9999", "没传 key：旧 key 还在", CFG.get("api_key_masked"))

        r = cfg_post(c, {"api_key": "__keep__"})
        ok((r.get("cfg") or {}).get("api_key_masked") == "sk-****9999", "__keep__ 不改 key", r.get("cfg"))
        r = cfg_post(c, {"api_key": ""})
        ok((r.get("cfg") or {}).get("api_key_masked") == "sk-****9999", "空串也不改 key", r.get("cfg"))
        r = cfg_post(c, {"api_key": "sk-newkey-12345678"})
        ok((r.get("cfg") or {}).get("api_key_masked") == "sk-****5678", "新 key 写进去了", r.get("cfg"))

        r = cfg_post(c, {"temperature": 9, "max_tokens": 1, "timeout": 999999, "max_rounds": 999999,
                         "thinking": "乱填"})
        CFG = r.get("cfg") or {}
        ok(CFG.get("temperature") == 2.0, "temperature 夹到 2.0", CFG.get("temperature"))
        ok(CFG.get("max_tokens") == 64, "max_tokens 夹到 64", CFG.get("max_tokens"))
        ok(CFG.get("timeout") == 3600, "timeout 夹到 3600（上限放宽）", CFG.get("timeout"))
        ok(CFG.get("max_rounds") == 9999, "max_rounds 夹到 9999（轮数基本不限）", CFG.get("max_rounds"))
        ok(CFG.get("thinking") == "disabled", "thinking 乱填 → disabled", CFG.get("thinking"))

        # 轮数 0 = 不限制；负数也被夹到 0
        r = cfg_post(c, {"max_rounds": 0})
        ok((r.get("cfg") or {}).get("max_rounds") == 0, "max_rounds=0 表示不限轮数", r.get("cfg"))
        r = cfg_post(c, {"max_rounds": -5})
        ok((r.get("cfg") or {}).get("max_rounds") == 0, "max_rounds 负数夹到 0", r.get("cfg"))

        # 测试用配置改回温和值
        cfg_post(c, {"model": "mimo-v2.6-flash", "temperature": 0.2, "max_tokens": 4000,
                     "timeout": 10, "max_rounds": 0})

        section("3.5 服务商 profiles（保存 / 切换，key 不丢）")
        CFG = (cfg_get(c).get("cfg") or {})
        profs = CFG.get("profiles") or []
        ok(len(profs) >= 1, "保存后至少有一条服务商配置", len(profs))
        ok(bool(CFG.get("active")), "有当前选中的服务商", CFG.get("active"))
        p0 = {}
        for p in profs:
            if str(p.get("id")) == str(CFG.get("active")):
                p0 = p
        ok(bool(p0), "active 指向列表里的某一条", CFG.get("active"))
        ok(p0.get("has_key") is True, "服务商条目带 has_key", p0.get("has_key"))
        ok("api_key" not in p0, "服务商条目不带明文 key", list(p0.keys()))
        ok((p0.get("model") or "") == CFG.get("model"), "active 那条 = 当前配置", (p0.get("model"), CFG.get("model")))
        ok("sk-" in str(p0.get("api_key_masked") or ""), "服务商 key 只给掩码", p0.get("api_key_masked"))
        pid0 = p0.get("id")
        n_before = len(profs)

        # 新增第二个服务商（DeepSeek）→ 自动切成它
        r = cfg_post(c, {"base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat"})
        CFG = r.get("cfg") or {}
        profs = CFG.get("profiles") or []
        ok(len(profs) == n_before + 1, "新增服务商后多一条", (n_before, len(profs)))
        ok(CFG.get("base_url") == "https://api.deepseek.com/v1", "顶层地址切到新服务商", CFG.get("base_url"))
        ok(any((p.get("base_url") or "") == "https://api.deepseek.com/v1" for p in profs), "新服务商进 profiles")

        # 切回第一条：地址/模型回去，key 沿用（不用重填）
        r = cfg_post(c, {"select_profile": pid0})
        CFG = r.get("cfg") or {}
        ok(CFG.get("base_url") == FAKE_URL, "切回旧服务商：地址回来", CFG.get("base_url"))
        ok(CFG.get("api_key_masked") == "sk-****5678", "切回旧服务商：key 沿用（不用重填）", CFG.get("api_key_masked"))

        r = cfg_post(c, {"select_profile": "no-such-id"})
        ok((r.get("ok") is False) and ("没找到" in str(r.get("error") or "")), "切到不存在的服务商会报错", r.get("error"))

        # 恢复成测试用配置（后面 chat 用例仍要指向假模型）
        cfg_post(c, {"base_url": FAKE_URL, "model": "mimo-v2.6-flash", "timeout": 30,
                     "max_rounds": 0, "temperature": 0.2, "max_tokens": 4000})

        section("4. WS chat：正常流（ai_delta → ai_done）")
        Fake.mode = "text"
        Fake.calls.clear()
        c.send_json({"t": "ai", "op": "chat", "id": "c1",
                     "body": {"messages": [{"role": "user", "content": "你好"}]}})
        frames = recv_until(c, lambda j: j.get("t") == "ai_done" and j.get("id") == "c1", timeout=20)
        texts = "".join(f.get("text") or "" for f in frames if f.get("t") == "ai_delta")
        done = frames[-1]
        ok(texts == "你好，我是测试模型。", "ai_delta 拼出完整正文", texts)
        ok(done.get("finish_reason") == "stop", "ai_done.finish_reason = stop", done.get("finish_reason"))
        ok((done.get("usage") or {}).get("prompt_tokens") == 11, "ai_done 带 usage", done.get("usage"))
        ok((done.get("usage") or {}).get("cached_tokens") == 7,
           "ai_done 带缓存命中数（prompt_tokens_details.cached_tokens 透传）", done.get("usage"))
        ok(isinstance(done.get("elapsed_ms"), int), "ai_done 带 elapsed_ms", done.get("elapsed_ms"))

        section("5. 发出去的模型请求（stream / thinking / 模型名）")
        call = Fake.calls[-1]["body"] if Fake.calls else {}
        ok(Fake.calls and Fake.calls[-1]["path"].endswith("/chat/completions"), "请求打到 /chat/completions",
           Fake.calls[-1]["path"] if Fake.calls else None)
        ok(call.get("stream") is True, "stream = true", call.get("stream"))
        ok((call.get("thinking") or {}).get("type") == "disabled", 'thinking = {"type":"disabled"}', call.get("thinking"))
        ok(call.get("model") == "mimo-v2.6-flash", "模型名透传", call.get("model"))
        ok(call.get("temperature") == 0.2, "temperature 透传", call.get("temperature"))
        ok(call.get("max_tokens") == 4000, "max_tokens 透传", call.get("max_tokens"))
        ok(isinstance(call.get("messages"), list) and call["messages"], "messages 非空", call.get("messages"))
        ok("tools" not in call, "没传 tools 的请求不带 tools", list(call.keys()))
        ok((call.get("stream_options") or {}).get("include_usage") is True,
           "非小米地址带 stream_options.include_usage（LM Studio/OpenAI 才回 usage）",
           call.get("stream_options"))


        cfg_post(c, {"base_url": FAKE_URL, "model": "qwen3-vl", "thinking": "disabled"})
        parts = [
            {"type": "text", "text": "看一下截图"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,dGVzdA=="}},
        ]
        c.send_json({"t": "ai", "op": "chat", "id": "vision",
                     "body": {"messages": [{"role": "user", "content": parts}]}})
        recv_until(c, lambda j: j.get("t") == "ai_done" and j.get("id") == "vision", timeout=20)
        content = Fake.calls[-1]["body"]["messages"][-1]["content"]
        ok(content == parts + [{"type": "text", "text": "/no_think"}],
           "本机模型保留图文内容块，单独追加 /no_think")
        cfg_post(c, {"base_url": FAKE_URL, "model": "mimo-v2.6-flash"})

        section("6. WS chat：工具调用（ai_tool 分片累积）")
        Fake.mode = "tools"
        Fake.calls.clear()
        c.send_json({"t": "ai", "op": "chat", "id": "c2",
                     "body": {"messages": [{"role": "user", "content": "建页"}],
                              "tools": [{"type": "function", "function": {"name": "add_page", "parameters": {}}}]}})
        frames = recv_until(c, lambda j: j.get("t") == "ai_done" and j.get("id") == "c2", timeout=20)
        tool_frames = [f for f in frames if f.get("t") == "ai_tool"]
        ok(len(tool_frames) == 1, "ai_tool 只发一次（收齐后）", len(tool_frames))
        calls = (tool_frames[0].get("calls") or []) if tool_frames else []
        ok(len(calls) == 1 and calls[0].get("name") == "add_page", "工具名 = add_page", calls)
        ok(calls and calls[0].get("id") == "call_b1", "工具 id 累积出来", calls and calls[0].get("id"))
        try:
            args = json.loads(calls[0].get("arguments") or "{}")
        except Exception:                       # noqa: BLE001
            args = None
        ok(args == {"name": "AI后端测试页"}, "arguments 是完整 JSON 字符串", calls and calls[0].get("arguments"))
        ok(frames[-1].get("finish_reason") == "tool_calls", "finish_reason = tool_calls",
           frames[-1].get("finish_reason"))

        section("7. 错误面：坏 op / 空 messages / 取消 / 关闭 / 没 key")
        c.send_json({"t": "ai", "op": "nope", "id": "e1"})
        j = recv_until(c, lambda x: x.get("id") == "e1", timeout=5)[-1]
        ok(j.get("t") == "ai_error" and j.get("code") == "bad_request", "不认识的 op → bad_request", j)

        c.send_json({"t": "ai", "op": "chat", "id": "e2", "body": {"messages": []}})
        j = recv_until(c, lambda x: x.get("id") == "e2", timeout=5)[-1]
        ok(j.get("t") == "ai_error" and j.get("code") == "bad_request", "空 messages → bad_request", j)

        Fake.mode = "slow"
        c.send_json({"t": "ai", "op": "chat", "id": "e3",
                     "body": {"messages": [{"role": "user", "content": "慢慢来"}]}})
        time.sleep(0.4)
        c.send_json({"t": "ai", "op": "cancel", "id": "e3"})
        j = recv_until(c, lambda x: x.get("id") == "e3" and x.get("t") == "ai_error", timeout=5)[-1]
        ok(j.get("code") == "cancel", "取消 → ai_error code=cancel", j)

        cfg_post(c, {"enabled": False})
        c.send_json({"t": "ai", "op": "chat", "id": "e4",
                     "body": {"messages": [{"role": "user", "content": "你好"}]}})
        j = recv_until(c, lambda x: x.get("id") == "e4", timeout=5)[-1]
        ok(j.get("code") == "disabled", "enabled=false → code=disabled", j)
        cfg_post(c, {"enabled": True})

        # 没 key：直接改文件（api_key 空 = 不改，所以只能从文件走）
        write_cfg(DATA, api_key="")
        c.send_json({"t": "ai", "op": "chat", "id": "e5",
                     "body": {"messages": [{"role": "user", "content": "你好"}]}})
        j = recv_until(c, lambda x: x.get("id") == "e5", timeout=5)[-1]
        ok(j.get("code") == "no_key", "没有 key → code=no_key", j)
        write_cfg(DATA)

        section("8. 安全：明文 key 不出现在任何 WS 帧里")
        leaked = False
        sample = json.dumps(frames, ensure_ascii=False)
        for needle in ("sk-test-secret-9999", "sk-newkey-12345678"):
            if needle in sample:
                leaked = True
        ok(not leaked, "帧里没有明文 key")

        section("9. 测试连接：地址少 /v1 不再误报成功")
        Fake.mode = "text"           # 上一节把 fake 切成 slow 了，这里切回来
        fake_port = FAKE_URL.split("//")[-1].split("/")[0].split(":")[-1]
        bad_base = "http://127.0.0.1:" + fake_port
        cfg_post(c, {"base_url": bad_base, "model": "mimo-v2.6-flash"})
        r = c.api("/api/ai/test", method="POST", body={})
        ok(r.get("ok") is False, "地址少 /v1 时测试连接 = 失败（不再误报）",
           {k: r.get(k) for k in ("ok", "code", "error")})
        ok("/v1" in str(r.get("error") or ""), "错误里提示要用 /v1 结尾", r.get("error"))
        cfg_post(c, {"base_url": FAKE_URL})
        r2 = c.api("/api/ai/test", method="POST", body={})
        ok(r2.get("ok") is True, "地址改对之后测试连接恢复成功",
           r2.get("error") or r2.get("model"))

    finally:
        try:
            if c is not None:
                c.close()
        except Exception:                       # noqa: BLE001
            pass
        srv.kill()
        fake_srv.shutdown()
        try:
            import shutil
            shutil.rmtree(DATA, ignore_errors=True)
        except Exception:                       # noqa: BLE001
            pass

    print(f"\n===== AI 后端单测：{PASS} 通过 / {FAIL} 失败 =====")
    if FAILED:
        print("失败项：" + "、".join(FAILED))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
