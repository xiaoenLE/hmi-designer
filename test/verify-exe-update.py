# -*- coding: utf-8 -*-
"""
verify-exe-update.py — 打包成 exe 之后的**真实验收**（壳 + app 两层 + 就地更新）

这不是单元测试，是把打包产物真装一遍、真跑一遍、真更新一次：

  %TEMP%\\hmi-exe-test-xxx\\
    ProgramData\\HMI-Designer\\data\\   ← 现场数据（工程/口令），全程不许被动
    box\\                               ← 安装目录（模拟 C:\\Program Files\\HMI-Designer）
      HMIDesigner.exe + _internal\\     ← 壳：**更新前后必须一模一样**（运行中的 exe 改不了）
      app\\                             ← 业务代码：更新只换这一层
    remote\\                            ← 假发布服务器（version.json + app zip）

验的就是四件事：
  1. exe 能起来（frozen + pywebview 那条路没崩）
  2. 点「立即更新」→ 新版本真的生效（app\\ 里的文件换了、健康检查报新版本号）
  3. **壳没被动**（exe 与 _internal 的哈希不变）—— 这正是"不用重装、不弹 UAC"的证据
  4. **现场数据一个字节都没动**（工程/口令/PLC 配置原样）

用法：先打壳与代码包，再跑这个脚本
    .\\tools\\build-release.ps1                # 产出 build\\pyinst\\HMIDesigner
    python test\\verify-exe-update.py          # 默认用 build\\pyinst\\HMIDesigner 与仓库当前代码
    python test\\verify-exe-update.py --box <已经装好的目录>   # 直接验一个已安装的目录
"""
import argparse
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
import urllib.error
import urllib.request
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                                       # noqa: BLE001
    pass

results = []


def ok(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def http_json(url, timeout=10, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8-sig"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8-sig"))
        except Exception:                                               # noqa: BLE001
            return {"ok": False, "error": f"HTTP {e.code}"}


def wait_version(port, want, timeout=120.0):
    end = time.time() + timeout
    seen = None
    while time.time() < end:
        time.sleep(1.0)
        try:
            j = http_json(f"http://127.0.0.1:{port}/api/health", timeout=3)
            seen = str((j.get("version") or {}).get("version") or "")
            if seen == want:
                return j
        except Exception:                                               # noqa: BLE001
            continue
    print(f"    （等 V{want} 超时；最后看到 V{seen or '?'}）")
    return None


def wait_log(log_dir: Path, needle: str, timeout=20.0) -> bool:
    """等日志里出现某句话。助手把「更新完成」写在最后一步（服务起来之后），
    断言早了会误报失败 —— 这是测试自己的竞态，不是功能问题。
    等不到就把目录实况打出来（省得为了"日志到底写哪儿了"再猜一轮）。"""
    end = time.time() + timeout
    d = Path(log_dir)
    while time.time() < end:
        try:
            for p in d.glob("*.log"):
                if needle in p.read_text(encoding="utf-8", errors="ignore"):
                    return True
        except Exception:                                               # noqa: BLE001
            pass
        time.sleep(0.4)
    print(f"    [诊断] 等「{needle}」超时。目录 {d} 存在={d.exists()}")
    for p in sorted(d.glob("*.log")) if d.exists() else []:
        t = p.read_text(encoding="utf-8", errors="ignore")
        print(f"      {p.name}  {len(t)} 字符；末 160 字：{t[-160:]!r}")
    return False


def kill_sandbox_exes(work: Path):
    """把**沙箱里**那个 exe 的所有进程收干净。

    为什么不能只按端口杀：更新之后服务是"助手拉起来的新进程"，端口一样但 PID 换了；
    而 spawn 出去的第一个进程可能已经退出/被替换 —— 只按端口杀会漏，
    于是上一轮的 exe 会留着继续跑、继续写它那个沙箱的日志（踩过：诊断时被这个坑带偏）。
    ⚠ 只杀可执行文件路径在沙箱里的，绝不碰别人机器上正常装着的 HMIDesigner.exe。"""
    try:
        out = subprocess.run(["wmic", "process", "where", "name='HMIDesigner.exe'",
                              "get", "ProcessId,ExecutablePath", "/format:csv"],
                             capture_output=True, text=True, encoding="utf-8", errors="ignore").stdout
    except Exception:                                                   # noqa: BLE001
        return
    key = str(work).lower()
    for ln in out.splitlines():
        if key not in ln.lower():
            continue
        parts = [p.strip() for p in ln.split(",") if p.strip()]
        pid = parts[-1] if parts else ""
        if pid.isdigit():
            subprocess.run(["taskkill", "/f", "/pid", pid], capture_output=True)


def kill_port(port):
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="ignore").stdout
        for pid in {ln.split()[-1] for ln in out.splitlines()
                    if f":{port} " in ln and "LISTENING" in ln}:
            subprocess.run(["taskkill", "/f", "/pid", pid], capture_output=True)
    except Exception as e:                                              # noqa: BLE001
        print(f"    清理端口失败：{e}")


def stage_app(dst: Path):
    """把"业务代码"摆成 app\\（和打包脚本一致：运行所需的那几样）

    ⚠ 排除规则必须**精确**：`ignore_patterns("data")` 这种一刀切会把
      js/data/pinyin.js（拼音数据）也跳过 → 前端模块 404 → 页面白板。
      这个套件专门断言"app 里的前端文件一个都不能少"，就是防这类事。
    """
    dst.mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "version.json", "README.md", ".gitignore"):
        p = ROOT / name
        if p.exists():
            shutil.copy2(p, dst / name)
    for d in ("css", "js", "server", "docs"):
        src = ROOT / d
        if not src.is_dir():
            continue
        shutil.copytree(src, dst / d,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "webview"))
    # 精确清掉现场数据/日志（只在这两处）
    for junk in ("server/data", "logs", "server/__pycache__"):
        p = dst / junk
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)


def build_app_zip(src_app: Path, out_zip: Path, version: str, marker: str):
    """打一个"新版本"的代码包（顶层不套目录，和 build-release.ps1 一致）"""
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(src_app.rglob("*")):
            if not p.is_file() or "__pycache__" in p.parts:
                continue
            rel = str(p.relative_to(src_app)).replace("\\", "/")
            if rel == "version.json":
                continue                      # 版本清单单独写（带新版本号），别写两遍
            z.write(p, rel)
        z.writestr(marker, f"// {version} 的标记：更新成功才会有这个文件\n")
        z.writestr("version.json", json.dumps(
            {"app": "HMI 组态设计器", "version": version, "date": "2026-10-04",
             "notes": f"测试版本 {version}"}, ensure_ascii=False))
    return out_zip


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--box", default="", help="已装好的安装目录（默认用 build/pyinst/HMIDesigner 现装一个）")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    shell = Path(args.box) if args.box else (ROOT / "build" / "pyinst" / "HMIDesigner")
    if not (shell / "HMIDesigner.exe").exists():
        print(f"没找到打包产物：{shell}\\HMIDesigner.exe\n先跑：.\\tools\\build-release.ps1")
        return 2

    work = Path(tempfile.mkdtemp(prefix="hmi-exe-test-"))
    box = work / "box"
    data_dir = work / "ProgramData" / "HMI-Designer" / "data"
    remote = work / "remote"
    print(f"沙箱：{work}\n")

    port = free_port()
    proc = None
    try:
        # ── 装一遍：壳 + app\ ──
        print("组装安装目录（壳 + app\\）…")
        box.mkdir(parents=True)
        shutil.copytree(shell, box, dirs_exist_ok=True)
        stage_app(box / "app")
        data_dir.mkdir(parents=True, exist_ok=True)

        # 现场数据：工程 + 口令 + PLC 配置（更新**绝对不能**碰）
        (data_dir / "hmi_project.json").write_text(json.dumps(
            {"meta": {"name": "现场工程-别动我"}, "pages": [{"id": "p1", "name": "主页", "widgets": []}],
             "variables": []}, ensure_ascii=False), encoding="utf-8")
        (data_dir / "auth.json").write_text('{"salt":"x","hash":"y"}', encoding="utf-8")
        (data_dir / "plc.json").write_text('{"host":"192.168.1.10","port":502}', encoding="utf-8")
        data_before = {p.name: sha(p) for p in data_dir.iterdir() if p.is_file()}

        local_ver = json.loads((box / "app" / "version.json").read_text(encoding="utf-8"))["version"]
        parts = [int(x) for x in local_ver.split(".")]
        parts[-1] += 1
        NEXT = ".".join(str(x) for x in parts)
        marker = f"js/__exe_update_{NEXT.replace('.', '_')}.js"

        # 壳的指纹：更新前后必须一致
        shell_before = {str(p.relative_to(box)): sha(p) for p in box.rglob("*")
                        if p.is_file() and (p.name == "HMIDesigner.exe" or "_internal" in p.parts)}

        # ── 假发布服务器 ──
        remote.mkdir(parents=True, exist_ok=True)
        zip_path = build_app_zip(box / "app", work / f"HMI-Designer-{NEXT}-app.zip", NEXT, marker)
        zsha = hashlib.sha256(zip_path.read_bytes()).hexdigest()
        rport = free_port()
        handler = lambda *a, **kw: SimpleHTTPRequestHandler(*a, directory=str(remote), **kw)  # noqa: E731
        srv = ThreadingHTTPServer(("127.0.0.1", rport), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        rbase = f"http://127.0.0.1:{rport}"
        shutil.copy2(zip_path, remote / zip_path.name)
        (remote / "version.json").write_text(json.dumps({
            "app": "HMI 组态设计器", "version": NEXT, "date": "2026-10-04",
            "notes": "测试：exe 就地更新", "url": rbase,
            "min_launcher": "1.0.0",
            "app_zip": {"file": zip_path.name, "sha256": zsha, "size": zip_path.stat().st_size},
        }, ensure_ascii=False), encoding="utf-8")

        # ── 起 exe（--no-window：自动化里不开窗口，但那套 frozen/重启/更新的代码路径完全一样）──
        env = dict(os.environ)
        env.update({
            "HMI_DATA_DIR": str(data_dir),
            "HMI_LOG_DIR": str(work / "ProgramData" / "HMI-Designer" / "logs"),
            "HMI_UPDATE_URL": f"{rbase}/version.json",
            "HMI_UPDATE_ARCHIVE": f"{rbase}/{zip_path.name}",
            "HMI_LAUNCHER_VERSION": "1.0.0",
        })
        log = open(work / "exe.log", "a", encoding="utf-8")
        print(f"启动 {box / 'HMIDesigner.exe'} --port {port} --no-window --no-auth")
        # --no-auth：自动化里不折腾登录（/api/update/apply 本来就要管理员 —— 那条门禁由
        # verify-update.mjs / verify-run-only.mjs 覆盖；现场用的时候是在编辑器里点的，天然已登录）
        proc = subprocess.Popen([str(box / "HMIDesigner.exe"), "--port", str(port),
                                 "--no-window", "--no-auth"],
                                cwd=str(box), env=env, stdout=log, stderr=log, stdin=subprocess.DEVNULL)
        j = wait_version(port, local_ver, timeout=90)
        ok("打包出来的 exe 能起来并对外服务（frozen + 内置 pywebview 这条路通了）",
           j is not None, f"V{local_ver}")
        if j is None:
            print((work / "exe.log").read_text(encoding="utf-8", errors="ignore")[-1500:])
            return 1
        ok("health 里带版本号与「立即更新」能力", bool(j.get("version")) and "update_apply" in (j.get("features") or []))

        # ── 前端文件必须一个都不少、而且真的取得到 ──
        #    回归：安装器曾经拿"目录名里带 data 就跳过"当保险，把 js/data/pinyin.js 也跳了，
        #    结果窗口能开、接口全对，就是页面白板（模块 404）。这里两道都验。
        want_js = sorted(str(p.relative_to(ROOT / "js")) for p in (ROOT / "js").rglob("*.js"))
        have_js = sorted(str(p.relative_to(box / "app" / "js")) for p in (box / "app" / "js").rglob("*.js"))
        ok(f"app\\js 里的前端文件一个不少（{len(want_js)} 个）", want_js == have_js,
           f"少了：{sorted(set(want_js) - set(have_js))[:3]}")
        served = {}
        for u in ("/js/main.js", "/js/data/pinyin.js", "/css/base.css", "/run"):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}{u}", timeout=5) as r:
                    served[u] = r.status
            except Exception as e:                                      # noqa: BLE001
                served[u] = f"ERR {e}"
        ok("关键静态文件都取得到（含 js/data/pinyin.js —— 白板就是它 404 引起的）",
           all(v == 200 for v in served.values()), str(served))
        html = urllib.request.urlopen(f"http://127.0.0.1:{port}/run", timeout=5).read().decode("utf-8", "ignore")
        ok("/run 是运行页（注入了 __HMI_RUN_ONLY__）", "__HMI_RUN_ONLY__" in html)

        chk = http_json(f"http://127.0.0.1:{port}/api/update/check?force=1")
        ok(f"检查更新看到远端 {NEXT}（并且带 sha256）",
           (chk.get("remote") or {}).get("version") == NEXT and chk.get("available"), chk.get("state"))
        ok("清单里的 sha256 传到了后端", bool(((chk.get("remote") or {}).get("app_zip") or {}).get("sha256")))

        # ── 点「立即更新」──
        print("触发更新…")
        r = http_json(f"http://127.0.0.1:{port}/api/update/apply", method="POST", payload={}, timeout=60)
        ok("「立即更新」返回成功", r.get("ok"), r.get("error") or "")
        j2 = wait_version(port, NEXT, timeout=150)
        ok("**exe 被助手拉起来了，而且跑的是新版本**", j2 is not None)

        ok(f"新的业务代码生效了（{marker}）", (box / "app" / marker).exists())
        ok("app\\version.json 换成了新版", json.loads(
            (box / "app" / "version.json").read_text(encoding="utf-8"))["version"] == NEXT)

        shell_after = {str(p.relative_to(box)): sha(p) for p in box.rglob("*")
                       if p.is_file() and (p.name == "HMIDesigner.exe" or "_internal" in p.parts)}
        changed_shell = [k for k in shell_before if shell_after.get(k) != shell_before[k]]
        ok("**壳一个字节都没变**（exe + _internal 哈希全一致 → 证明「不用重装、不弹 UAC」）",
           not changed_shell, ",".join(changed_shell[:3]))

        data_after = {p.name: sha(p) for p in data_dir.iterdir() if p.is_file()}
        changed = [k for k in data_before if data_after.get(k) != data_before[k]]
        ok("**现场数据（工程/口令/PLC 配置）一个字节都没动**", not changed, ",".join(changed[:3]))
        ok("工程内容还是原来那份",
           "现场工程-别动我" in (data_dir / "hmi_project.json").read_text(encoding="utf-8"))
        ok("更新前的 app\\ 有备份（数据目录下的 _code_backup）",
           any(p.name == "_manifest.json" for p in (data_dir / "_code_backup").rglob("*")))
        ok("更新日志写下来了（在数据旁边的 logs 里，不在安装目录）",
           wait_log(work / "ProgramData" / "HMI-Designer" / "logs", "更新完成"))
        ok("安装目录里没有被写进日志（Program Files 下写不进去，也不该写）",
           not (box / "app" / "logs").exists())
    finally:
        kill_port(port)
        try:
            if proc:
                proc.kill()
        except Exception:                                               # noqa: BLE001
            pass
        time.sleep(0.5)
        kill_port(port)
        kill_sandbox_exes(work)          # 更新后起来的那个新进程也要收掉
        try:
            srv.shutdown()                                              # noqa: F821
        except Exception:                                               # noqa: BLE001
            pass
        if args.keep:
            print(f"\n沙箱留着：{work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    failed = [n for n, good in results if not good]
    print(f"\n==== exe 就地更新验收：{len(results) - len(failed)}/{len(results)} 通过 ====")
    for n in failed:
        print(f"  FAIL  {n}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
