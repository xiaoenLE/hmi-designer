#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify-log-dir.py — 日志目录默认放**安装目录下的 logs\\**（现场：%ProgramData% 不好找）

只盯这一件事（改动面）：
  ① HMI_LOG_DIR 显式指定 → 最高优先级，永远听它的（多套部署 / 自动化测试靠这条）
  ② 没指定 → **默认就在安装目录下的 logs\\**
  ③ 安装目录写不进去（老安装包没重装 / 权限极严）→ 退到 %ProgramData%\\HMI-Designer\\logs
  ④ 那儿也写不进去 → 退到数据目录下的 logs（**永远不让"写不了日志"把程序卡住**）
  ⑤ HMI_LOG_DIR 指向一个写不进去的地方 → 也照样往下退，不是直接退出
  ⑥ 顺带确认**数据目录没被动**：还是 %ProgramData%\\HMI-Designer\\data

跑法：python test/verify-log-dir.py        （不需要后端、不需要浏览器，秒回）
"""
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

try:                                    # 控制台按 UTF-8 输出（不然中文断言在 GBK 控制台里是乱码）
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                       # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent.parent
results = []


def ok(name, cond, extra=""):
    results.append(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def load_launcher():
    spec = importlib.util.spec_from_file_location("hmi_launcher_under_test",
                                                 str(ROOT / "packaging" / "launcher.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


L = load_launcher()
tmp = Path(tempfile.mkdtemp(prefix="hmi-logdir-"))


def fresh(name):
    """每一条用例一套干净的目录：安装目录 base / 数据目录 / ProgramData 都能单独摆布"""
    d = tmp / name
    base, data, pd = d / "install", d / "data", d / "ProgramData"
    for p in (base, data, pd):
        p.mkdir(parents=True, exist_ok=True)
    return base, data, pd


def blocked(path: Path):
    """把某个目录"占住"：放一个**同名文件**在那儿 —— mkdir 必然失败。
    （不靠 icacls 去撤权限：跑测试的常常是管理员，撤了自己照样写得进去，测不出东西）"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x", encoding="utf-8")


def run_case(name, base, data, pd, env_log=""):
    old = {k: os.environ.get(k) for k in ("HMI_LOG_DIR", "ProgramData")}
    if env_log:
        os.environ["HMI_LOG_DIR"] = env_log
    else:
        os.environ.pop("HMI_LOG_DIR", None)
    os.environ["ProgramData"] = str(pd)
    try:
        return L.pick_log_dir(base, data)
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ① 显式指定优先
base, data, pd = fresh("env")
want = tmp / "env" / "explicit-logs"
got, where = run_case("env", base, data, pd, env_log=str(want))
ok("① HMI_LOG_DIR 显式指定 → 听它的（优先级最高）", got == want and "HMI_LOG_DIR" in where,
   f"{got} / {where}")
ok("① 那个目录真被建出来了", want.is_dir())

# ② 默认 = 安装目录下的 logs
base, data, pd = fresh("default")
got, where = run_case("default", base, data, pd)
ok("② 没指定 → 默认用**安装目录下的 logs**（现场好找）",
   got == base / "logs" and where == "安装目录", f"{got} / {where}")
ok("② 不像以前那样往 %ProgramData% 里写日志", not str(got).startswith(str(pd)), str(got))

# ③ 安装目录写不进去 → 退到 %ProgramData%\HMI-Designer\logs
base, data, pd = fresh("fallback-pd")
blocked(base / "logs")
got, where = run_case("fallback-pd", base, data, pd)
ok("③ 安装目录写不进去 → 退到 %ProgramData%\\HMI-Designer\\logs",
   got == pd / L.PROGRAM_DATA_APP / "logs", f"{got} / {where}")

# ④ 两处都写不进去 → 退到数据目录下的 logs（不让程序卡住）
base, data, pd = fresh("fallback-data")
blocked(base / "logs")
blocked(pd / L.PROGRAM_DATA_APP / "logs")
got, where = run_case("fallback-data", base, data, pd)
ok("④ 安装目录 + %ProgramData% 都写不进去 → 退到数据目录下的 logs（不卡住程序）",
   got == data / "logs" and "数据目录" in where, f"{got} / {where}")

# ⑤ HMI_LOG_DIR 指到一个写不进去的地方 → 也照样往下退
base, data, pd = fresh("env-bad")
blocked(tmp / "env-bad" / "bad-logs")
got, where = run_case("env-bad", base, data, pd, env_log=str(tmp / "env-bad" / "bad-logs"))
ok("⑤ HMI_LOG_DIR 写不进去时照样往下退（不是直接退出）",
   got == base / "logs", f"{got} / {where}")

# ⑥ 数据目录没被动：还是 %ProgramData%\HMI-Designer\data
base, data, pd = fresh("data-untouched")
old = os.environ.get("HMI_DATA_DIR")
os.environ.pop("HMI_DATA_DIR", None)
oldpd = os.environ.get("ProgramData")
os.environ["ProgramData"] = str(pd)
try:
    d = L.pick_data_dir(base, lambda m: None)
finally:
    if old is not None:
        os.environ["HMI_DATA_DIR"] = old
    if oldpd is None:
        os.environ.pop("ProgramData", None)
    else:
        os.environ["ProgramData"] = oldpd
ok("⑥ 数据目录没被动：仍是 %ProgramData%\\HMI-Designer\\data（工程/配置不搬）",
   d == pd / L.PROGRAM_DATA_APP / "data", str(d))

# ⑦ 安装器那份也要一致：ensure_install_logs 建 <安装目录>\logs 并返回它
spec = importlib.util.spec_from_file_location("hmi_installer_under_test",
                                              str(ROOT / "packaging" / "installer.py"))
INS = importlib.util.module_from_spec(spec)
spec.loader.exec_module(INS)
base, data, pd = fresh("installer")
target = tmp / "installer" / "app-dir"
target.mkdir(parents=True, exist_ok=True)
logs = INS.ensure_install_logs(target, lambda m: None)
ok("⑦ 安装器会建 <安装目录>\\logs（默认日志位置）并返回它",
   logs == target / "logs" and (target / "logs").is_dir(), str(logs))
blocked(tmp / "installer" / "blocked-dir")
ok("⑦ 建不出来时不抛异常、返回 None（安装照常完成）",
   INS.ensure_install_logs(tmp / "installer" / "blocked-dir", lambda m: None) is None)

# ⑧ 安装器的数据目录里**不再**预先建 logs（日志不归 ProgramData 管了）
base, data, pd = fresh("installer-data")
oldpd = os.environ.get("ProgramData")
os.environ["ProgramData"] = str(pd)
try:
    INS.ensure_data_dirs(lambda m: None)
finally:
    if oldpd is None:
        os.environ.pop("ProgramData", None)
    else:
        os.environ["ProgramData"] = oldpd
ok("⑧ 安装器建数据目录时不再预建 %ProgramData%\\...\\logs（老的那个一概不删）",
   (pd / INS.DATA_ROOT / "data").is_dir() and not (pd / INS.DATA_ROOT / "logs").exists())

# ⑨ 真跑一遍**壳**（非 frozen 模式 = 直接 python 跑 launcher.py，见它自己的注释）：
#    端到端确认「安装目录下建了 logs\ + 真写了日志 + 传给 app 的就是这个目录」。
#    摆一个假安装目录：<root>\shell\launcher.py（壳）、<root>\app\server\hmi_desktop.py（假 app）
def run_shell(name, env_extra=None):
    root = tmp / name
    (root / "shell").mkdir(parents=True, exist_ok=True)
    (root / "app" / "server").mkdir(parents=True, exist_ok=True)
    import shutil as _sh
    _sh.copy2(ROOT / "packaging" / "launcher.py", root / "shell" / "launcher.py")
    (root / "app" / "server" / "hmi_desktop.py").write_text(
        "# -*- coding: utf-8 -*-\n"
        "import json, os\n"
        "def main():\n"
        "    print(json.dumps({'logs': os.environ.get('HMI_LOG_DIR', ''),\n"
        "                      'data': os.environ.get('HMI_DATA_DIR', ''),\n"
        "                      'launch': os.environ.get('HMI_LAUNCH', '')}, ensure_ascii=False))\n"
        "    return 0\n", encoding="utf-8")
    env = dict(os.environ)
    env.pop("HMI_LOG_DIR", None)
    env.pop("HMI_DATA_DIR", None)
    env["ProgramData"] = str(root / "pd")
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(env_extra or {})
    import subprocess
    r = subprocess.run([sys.executable, str(root / "shell" / "launcher.py")],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       cwd=str(root), env=env, timeout=90)
    info = {}
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{") and "logs" in line:
            try:
                import json
                info = json.loads(line)
            except Exception:               # noqa: BLE001
                pass
    return root, r, info


root9, r9, info9 = run_shell("shell-default")
ok("⑨ 壳真的能跑起来（假 app 正常退出）", r9.returncode == 0, f"rc={r9.returncode} {r9.stderr[-200:]}")
ok("⑨ 日志真的写在**安装目录下的 logs\\**（launcher.log 在那儿）",
   (root9 / "logs" / "launcher.log").is_file(), str(root9 / "logs" / "launcher.log"))
ok("⑨ 交给 app 的 HMI_LOG_DIR 就是安装目录下的 logs",
   info9.get("logs") and Path(info9["logs"]).resolve() == (root9 / "logs").resolve(),
   str(info9.get("logs")))
ok("⑨ 数据目录照旧在 %ProgramData%（工程/配置不搬）",
   info9.get("data") and Path(info9["data"]).resolve() == (root9 / "pd" / L.PROGRAM_DATA_APP / "data").resolve(),
   str(info9.get("data")))
ok("⑨ 启动日志里写明了「日志在哪儿」（现场问得最多的一句）",
   "logs=" in (root9 / "logs" / "launcher.log").read_text(encoding="utf-8", errors="ignore"),
   (root9 / "logs" / "launcher.log").read_text(encoding="utf-8", errors="ignore").strip()[:120])

envdir = tmp / "shell-env-logs"
root10, r10, info10 = run_shell("shell-envdir", {"HMI_LOG_DIR": str(envdir)})
ok("⑩ 部署显式指定 HMI_LOG_DIR 时，壳听它的（不往安装目录写）",
   info10.get("logs") and Path(info10["logs"]).resolve() == envdir.resolve() and not (root10 / "logs").exists(),
   f"{info10.get('logs')} / install-logs-exists={(root10 / 'logs').exists()}")

print("\n".join(results))
fails = sum(1 for r in results if r.startswith("FAIL"))
print(f"\n==== 日志目录（默认放安装目录下）：{len(results) - fails}/{len(results)} 通过 ====")
sys.exit(1 if fails else 0)
