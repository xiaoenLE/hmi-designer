# -*- coding: utf-8 -*-
"""
verify-update-apply.py — 「立即更新」端到端自检（含**起不来自动回滚**那条路）

为什么是 .py 而不是像别的套件那样用 .mjs + Playwright：
  这个功能的主体是**换进程**（后端下载代码 → 退出 → 助手用新代码拉起来 → 起不来就回滚），
  浏览器里看不到进程这一层。所以这里直接起真的后端、真的重启、真的回滚。

⚠ 绝不在真仓库里跑：更新会**覆盖程序文件**。这个脚本先把工程整套复制到临时目录，
  在副本里做实验（--keep 可以留下副本自己看）。

用法：
    python test/verify-update-apply.py            # 跑完自动清理
    python test/verify-update-apply.py --keep     # 留副本（打印路径）

覆盖的场景：
  1. 更新成功：下载 → 只覆盖代码 → 自动重启 → 新版本号出现；**server/data 一个字节没动**
  2. 版本对不上（远端 version.json 说 1.0.3，包里却是 1.0.2）→ 拒绝更新，代码不动
  3. 新版起不来（包里 server.py 有语法错）→ 助手**自动回滚** → 服务用旧版本回来、代码退回原样
  4. 白名单：压缩包里塞的 server/data/hmi_project.json 不许覆盖现场工程；
     非白名单文件（如 shots/xxx.png）不落地
"""
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
import updater                                                    # noqa: E402
IS_WIN = os.name == "nt"
try:                                # 控制台默认是 GBK，中文输出会炸 —— 统一成 UTF-8
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                           # noqa: BLE001
    pass

results = []


def wait_state(data_dir: Path, want: str, timeout=15.0):
    """等助手写完这一跳的结果（它是在服务起来之后才写的，晚个零点几秒很正常）"""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        f = data_dir / "_update" / "status.json"
        if f.exists():
            try:
                last = json.loads(f.read_text(encoding="utf-8")).get("state")
                if last == want:
                    return True
            except Exception:                                   # noqa: BLE001
                pass
        time.sleep(0.4)
    print(f"    （等 status={want} 超时，最后是 {last}）")
    return False


def ok(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def snapshot(d: Path) -> dict:
    """目录快照：相对路径 → 内容哈希（判断"动没动"）"""
    out = {}
    for p in sorted(d.rglob("*")):
        if p.is_file():
            out[str(p.relative_to(d)).replace("\\", "/")] = sha(p)
    return out


def http_get_json(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8-sig"))


def http_post_json(url, payload=None, timeout=30):
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"},
                                method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8-sig"))
    except urllib.error.HTTPError as e:                         # noqa: PERF203
        try:
            return json.loads(e.read().decode("utf-8-sig"))
        except Exception:                                       # noqa: BLE001
            return {"ok": False, "error": f"HTTP {e.code}"}


def wait_version(port, want, timeout=90.0, log=print):
    """等 /api/health 应答且版本 == want（重启期间连不上是正常的）"""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        time.sleep(1.0)
        try:
            j = http_get_json(f"http://127.0.0.1:{port}/api/health", timeout=3)
            last = str(((j.get("version") or {}).get("version")) or "")
            if last == want:
                return j
        except Exception:                                       # noqa: BLE001
            continue
    log(f"（等 V{want} 超时；最后看到的是 V{last or '?'}）")
    return None


def kill_port(port):
    """按端口找 PID 杀掉（更新后服务是 detached 的，不在本脚本的进程树里）"""
    try:
        if IS_WIN:
            out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                                 encoding="utf-8", errors="ignore").stdout
            pids = {ln.split()[-1] for ln in out.splitlines()
                    if f":{port} " in ln and "LISTENING" in ln}
            for pid in pids:
                subprocess.run(["taskkill", "/f", "/pid", pid], capture_output=True)
    except Exception as e:                                      # noqa: BLE001
        print(f"  清理端口 {port} 失败：{e}")


def copy_tree(src: Path, dst: Path):
    """把工程复制一份（不带 .git / 日志 / webview 缓存）"""
    ignore = shutil.ignore_patterns(".git", "logs", "webview", "__pycache__", "*.pyc")
    shutil.copytree(src, dst, ignore=ignore)


# ── 假的"远端"：一个 http 服务，同时给 version.json 和代码包 ──────────────
class FakeRemote:
    def __init__(self, root: Path):
        self.root = root
        self.port = free_port()
        root.mkdir(parents=True, exist_ok=True)
        handler = lambda *a, **kw: SimpleHTTPRequestHandler(*a, directory=str(root), **kw)  # noqa: E731
        self.srv = ThreadingHTTPServer(("127.0.0.1", self.port), handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def manifest(self):
        return f"http://127.0.0.1:{self.port}/version.json"

    @property
    def archive(self):
        return f"http://127.0.0.1:{self.port}/archive.zip"

    def publish(self, version: str, notes: str, archive: Path):
        (self.root / "version.json").write_text(json.dumps(
            {"app": "HMI 组态设计器", "version": version, "notes": notes,
             "url": "http://fake.local/hmi-designer"}, ensure_ascii=False), encoding="utf-8")
        shutil.copy2(archive, self.root / "archive.zip")

    def stop(self):
        self.srv.shutdown()


def build_archive(src: Path, out_zip: Path, version: str, extra: dict = None, break_server: bool = False):
    """从 src 打一个"新版本"代码包（顶层目录和 Gitea 归档一样是 hmi-designer/）"""
    sys.path.insert(0, str(src / "server"))
    import updater                                              # noqa: PLC0415
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(src.rglob("*")):
            if not p.is_file():
                continue
            rel = str(p.relative_to(src)).replace("\\", "/")
            if rel.startswith("server/data/") or rel.startswith("logs/"):
                continue
            if not updater.is_code_path(rel):
                continue
            data = p.read_bytes()
            if break_server and rel == "server/server.py":
                data = data + b"\nthis is not python(((\n"     # 故意的语法错：装成"坏版本"
            if rel == "version.json":
                data = json.dumps({"app": "HMI 组态设计器", "version": version,
                                   "notes": f"测试版本 {version}"}, ensure_ascii=False).encode("utf-8")
            z.writestr("hmi-designer/" + rel, data)
        for rel, text in (extra or {}).items():
            z.writestr("hmi-designer/" + rel, text)
    return out_zip


def start_backend(app: Path, port: int, manifest: str, archive: str, launcher: str = "console"):
    env = dict(os.environ)
    env.update({
        "HMI_DATA_DIR": str(app / "server" / "data"),
        "HMI_UPDATE_URL": manifest,
        "HMI_UPDATE_ARCHIVE": archive,
        "HMI_LAUNCH": launcher,           # console / console-bat / desktop，见 server._update_launcher
        "PYTHONIOENCODING": "utf-8",
    })
    (app / "logs").mkdir(exist_ok=True)
    log = open(app / "logs" / "test-runner.log", "a", encoding="utf-8")
    p = subprocess.Popen([sys.executable, str(app / "server" / "server.py"),
                          "--port", str(port), "--no-browser", "--no-auth"],
                         cwd=str(app), env=env, stdout=log, stderr=log, stdin=subprocess.DEVNULL)
    p._hmi_log = log                                            # noqa: SLF001
    return p


def diag(base, fake, what):
    """每次动手前把"两边各说自己是哪版"打出来 —— 判断失败时不用猜是谁的错"""
    try:
        remote = http_get_json(fake.manifest, timeout=5).get("version")
    except Exception as e:                                      # noqa: BLE001
        remote = f"读不到（{e}）"
    try:
        chk = http_get_json(base + "/api/update/check?force=1", timeout=15)
        state, lv, rv = chk.get("state"), (chk.get("local") or {}).get("version"), (chk.get("remote") or {}).get("version")
    except Exception as e:                                      # noqa: BLE001
        state, lv, rv = f"查不到（{e}）", "?", "?"
    print(f"    [diag] {what}：远端清单 V{remote} | 后端看：本地 V{lv} 远端 V{rv} → {state}")


def settle(sec=2.5):
    """等过后端那道"挡连点"的 2 秒间隔。
    为什么测试必须等：后台检查成功后 6 小时内不再拉远端（省流量），
    而**人主动点**的检查只挡 2 秒内的连点。所以"发新版 → 立刻查"这件事，
    只有等过 2 秒才是真的去拉 —— 不等的话测的是缓存，不是逻辑。"""
    time.sleep(sec)


def bump(ver: str, n: int = 1) -> str:
    """把版本号最后一位 +n：测试里的"新版"必须**永远比本机高**，
    否则发一次版这个套件就失效（远端不比本地新 → 压根不会去更新）"""
    parts = [int(x) for x in str(ver).split(".")]
    parts[-1] += n
    return ".".join(str(p) for p in parts)


def marker(ver: str) -> str:
    """这一版更新成功才会出现的标记文件（用版本号命名，回滚时才能验证"被删掉了"）"""
    return f"js/__from_update_{ver.replace('.', '_')}.js"


def main() -> int:
    keep = "--keep" in sys.argv
    work = Path(tempfile.mkdtemp(prefix="hmi-upd-test-"))
    app = work / "app"
    print(f"沙箱：{app}\n")
    copy_tree(ROOT, app)
    fake = FakeRemote(work / "remote")

    # 现场数据（更新**绝对不能**碰它）：放一份"工程"和一份假的口令文件
    data_dir = app / "server" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "hmi_project.json").write_text(json.dumps(
        {"meta": {"name": "现场工程-别动我"}, "pages": [{"id": "p1", "name": "主页", "widgets": []}],
         "variables": []}, ensure_ascii=False), encoding="utf-8")
    (data_dir / "auth.json").write_text('{"salt":"x","hash":"y"}', encoding="utf-8")
    data_before = snapshot(data_dir)
    code_before = {rel: sha(app / rel) for rel in ("index.html", "server/server.py", "js/main.js")}

    port = free_port()
    try:
        # 本机（沙箱）就是"现场那台旧版本"；测试要发的"新版"全部按它往上推
        local_ver = json.loads((app / "version.json").read_text(encoding="utf-8"))["version"]
        NEXT, NEXT2, BROKEN = bump(local_ver, 1), bump(local_ver, 2), bump(local_ver, 3)
        print(f"本机 V{local_ver}；这一步发的新版：{NEXT} / {NEXT2} / 坏版本 {BROKEN}\n")
        zip_ok = build_archive(app, work / f"new-{NEXT}.zip", NEXT,
                               extra={marker(NEXT): "// 只有更新成功才会有这个文件\n"})
        fake.publish(NEXT, "测试：一键更新", zip_ok)
        proc = start_backend(app, port, fake.manifest, fake.archive)
        base = f"http://127.0.0.1:{port}"
        j = wait_version(port, local_ver, timeout=40)
        ok("旧版本后端起来了（/api/health 有版本号）", j is not None, f"V{local_ver}")
        if j is None:
            return 1
        ok("health 里报告「立即更新」可用（update_apply）", "update_apply" in (j.get("features") or []))

        chk = http_get_json(base + "/api/update/check")
        ok(f"检查更新：发现远端 {NEXT}",
           chk.get("available") and (chk.get("remote") or {}).get("version") == NEXT, chk.get("state"))

        # 清单里 app_zip 的两种写法都要认（发布仓库是 {"url": "….zip", "file": "….zip", "sha256": …}）
        ok("清单里给了绝对 url 时优先用 url（不然会去 raw 路径找包 → 404）",
           updater.package_url({"app_zip": {"url": "http://a/b/c.zip", "file": "c.zip"}},
                               "app_zip", "http://a/manifest/version.json") == "http://a/b/c.zip",
           updater.package_url({"app_zip": {"url": "http://a/b/c.zip", "file": "c.zip"}},
                               "app_zip", "http://a/manifest/version.json"))
        ok("只给文件名时按清单同目录拼（自建文件服务器的用法）",
           updater.package_url({"app_zip": {"file": "c.zip"}}, "app_zip",
                               "http://a/manifest/version.json") == "http://a/manifest/c.zip")

        # ── 场景 2：包里版本跟远端说的对不上 → 必须拒绝、代码一点都不动 ──
        zip_bad_ver = build_archive(app, work / "wrong.zip", local_ver)
        fake.publish(NEXT, "测试：版本对不上", zip_bad_ver)
        settle()
        diag(base, fake, "apply#1（包里版本对不上）")
        r = http_post_json(base + "/api/update/apply")
        ok("包里版本对不上 → 拒绝更新并说明原因", (not r.get("ok")) and "对不上" in (r.get("error") or ""),
           (r.get("error") or "")[:40])
        ok("被拒绝时代码没有被动过",
           (app / "index.html").exists() and not (app / marker(NEXT)).exists()
           and all(sha(app / rel) == code_before[rel] for rel in code_before))

        # ── 场景 1：正常更新（本机 → NEXT），服务自动重启 ──
        fake.publish(NEXT, "测试：一键更新", zip_ok)
        settle()
        diag(base, fake, f"apply#2（正常更新到 {NEXT}）")
        r = http_post_json(base + "/api/update/apply")
        ok("点了「立即更新」→ 接口返回成功", r.get("ok"), r.get("error") or "")
        if r.get("ok"):
            ok("返回里报清了从哪版到哪版", r.get("from_version") == local_ver and r.get("to_version") == NEXT,
               f"{r.get('from_version')} → {r.get('to_version')}")
        j2 = wait_version(port, NEXT, timeout=90)
        ok("服务用新版本自己回来了（重启成功）", j2 is not None)
        ok(f"新版本的文件真的落地了（{marker(NEXT)}）", (app / marker(NEXT)).exists())
        ok(f"版本清单也换成了新版（version.json = {NEXT}）",
           json.loads((app / "version.json").read_text(encoding="utf-8"))["version"] == NEXT)
        ok("更新前的代码有备份（data/_code_backup/*/_manifest.json）",
           any(p.name == "_manifest.json" for p in (data_dir / "_code_backup").rglob("*")))
        ok("助手把这一跳的结果写下来了（status.json = ok）", wait_state(data_dir, "ok"), "")
        ok("更新日志写下来了（logs/update-*.log 里有「更新完成」）",
           any("更新完成" in p.read_text(encoding="utf-8", errors="ignore")
               for p in (app / "logs").glob("update-*.log")))

        # ── 现场数据：一个字节都不能动 ──
        data_after = snapshot(data_dir)
        changed = [k for k in data_before if data_after.get(k) != data_before[k]]
        ok("**现场数据（工程/口令）一个字节都没动**", not changed, ",".join(changed[:3]))
        ok("现场工程内容还是原来那份",
           "现场工程-别动我" in (data_dir / "hmi_project.json").read_text(encoding="utf-8"))

        # ── 场景 4：白名单 —— 包里塞的现场数据和杂项不许落地 ──
        zip_with_data = build_archive(app, work / f"with-data-{NEXT2}.zip", NEXT2, extra={
            "server/data/hmi_project.json": '{"meta":{"name":"恶意/误打包的工程"}}',
            "shots/junk.png": "not really a png",
            marker(NEXT2): f"// {NEXT2} 的标记\n",
        })
        fake.publish(NEXT2, "测试：包里带现场数据", zip_with_data)
        # 回归：刚才这一版是**服务自己重启完**的（新进程启动时会预热拉一次远端，那会儿远端还是 NEXT）。
        # 这时发 NEXT2 再点检查 —— 必须按最新的远端判断，不能拿预热那次缓存回一句"已经是最新"。
        settle()
        chk2 = http_get_json(base + "/api/update/check?force=1", timeout=15)
        ok("刚重启完就点「检查更新」：看到的是最新远端，不是预热缓存（回归：force 不被 30 秒间隔挡住）",
           ((chk2.get("remote") or {}).get("version") == NEXT2) and chk2.get("available"),
           f"state={chk2.get('state')} remote={(chk2.get('remote') or {}).get('version')}")
        diag(base, fake, f"apply#3（更新到 {NEXT2}）")
        r = http_post_json(base + "/api/update/apply")
        j3 = wait_version(port, NEXT2, timeout=90)
        ok(f"更新到 {NEXT2} 成功（白名单包里带杂项也能更）", bool(r.get("ok")) and j3 is not None,
           r.get("error") or "")
        ok("**包里夹带的 server/data/hmi_project.json 没有被写进来**（现场工程完好）",
           "现场工程-别动我" in (data_dir / "hmi_project.json").read_text(encoding="utf-8"))
        ok("非白名单文件（shots/junk.png）没有落地", not (app / "shots" / "junk.png").exists())

        # ── 场景 3：坏版本 → 自动回滚 ──
        zip_broken = build_archive(app, work / f"broken-{BROKEN}.zip", BROKEN, break_server=True, extra={
            marker(BROKEN): f"// {BROKEN} 的标记（回滚后这个文件应该被删掉）\n"})
        fake.publish(BROKEN, "测试：坏版本（server.py 语法错）", zip_broken)
        server_py_before = (app / "server" / "server.py").read_text(encoding="utf-8")
        settle()
        diag(base, fake, f"apply#4（坏版本 {BROKEN}）")
        r = http_post_json(base + "/api/update/apply")
        ok("坏版本也能把代码覆盖下去（接口本身是成功的）", r.get("ok"), r.get("error") or "")
        j4 = wait_version(port, NEXT2, timeout=150)
        ok(f"**新版起不来 → 自动回滚到 {NEXT2}，服务照样能用**", j4 is not None,
           "现在跑的是 V" + str(((j4 or {}).get('version') or {}).get('version')))
        ok("回滚把 server.py 还原成了更新前那份（不是那份语法错的）",
           (app / "server" / "server.py").read_text(encoding="utf-8") == server_py_before)
        ok(f"回滚把新版新增的文件删掉了（{marker(BROKEN)} 不在了）",
           not (app / marker(BROKEN)).exists())
        rolled = wait_state(data_dir, "rolled_back", 20)
        st = json.loads((data_dir / "_update" / "status.json").read_text(encoding="utf-8"))
        ok("状态文件写明这次是回滚（rolled_back）", rolled, str(st.get("state")))
        ok("回滚后现场数据依然是原样",
           all(snapshot(data_dir).get(k) == v for k, v in data_before.items()))
        ok("这一跳的失败原因有日志（logs/update-*.log 里有「回滚」）",
           any("回滚" in p.read_text(encoding="utf-8", errors="ignore")
               for p in (app / "logs").glob("update-*.log")))

        # ── 场景 5：start_server.bat 启动的（console-bat）也必须能自己回来 ──
        #    回归：曾经在这里留了个口子 —— console-bat 不拉助手，而 bat 里又没有重启循环，
        #    结果用 start_server.bat 起的服务点一次「立即更新」就再也不起来了。现在一律走助手。
        NEXT3 = bump(local_ver, 4)
        zip_bat = build_archive(app, work / f"bat-{NEXT3}.zip", NEXT3,
                                extra={marker(NEXT3): "// console-bat 这一跳的标记\n"})
        fake.publish(NEXT3, "测试：命令行启动的那台也要能自己回来", zip_bat)
        kill_port(port)
        time.sleep(1.5)
        proc = start_backend(app, port, fake.manifest, fake.archive, launcher="console-bat")
        j5 = wait_version(port, NEXT2, timeout=60)
        ok("换用 start_server.bat 那种启动方式再起一个（console-bat）", j5 is not None)
        settle()
        r = http_post_json(base + "/api/update/apply")
        j6 = wait_version(port, NEXT3, timeout=120)
        ok("**console-bat 启动的：点「立即更新」后服务也能自己回来**（回归：不能留『没人拉起来』的口子）",
           bool(r.get("ok")) and j6 is not None)

        # ── 逃生口：手动回滚 ──
        r2 = subprocess.run([sys.executable, str(app / "server" / "_restart.py"), "--rollback"],
                            cwd=str(app), capture_output=True, text=True, encoding="utf-8",
                            errors="ignore",
                            env={**os.environ, "HMI_DATA_DIR": str(data_dir),
                                 "PYTHONIOENCODING": "utf-8"})
        print("    [diag] --rollback 退出码:", r2.returncode,
              "| 输出末行:", ((r2.stdout or "").strip().splitlines() or [""])[-1][:80])
        ok("逃生口 `_restart.py --rollback` 能用（退出码 0 且报告结果）",
           r2.returncode == 0 and "回滚结果" in (r2.stdout or ""),
           (r2.stdout or "").strip().splitlines()[-1][:50] if r2.stdout else "")

    finally:
        kill_port(port)
        try:
            proc.kill()                                          # noqa: F821
        except Exception:                                        # noqa: BLE001
            pass
        fake.stop()
        time.sleep(0.5)
        kill_port(port)
        if keep:
            print(f"\n副本留在：{work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    failed = [n for n, good in results if not good]
    print(f"\n==== 「立即更新」自检：{len(results) - len(failed)}/{len(results)} 通过 ====")
    if failed:
        for n in failed:
            print(f"  FAIL  {n}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
