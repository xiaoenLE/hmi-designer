# -*- coding: utf-8 -*-
"""
updater.py — 「点一下自己更新」：下载新版代码包 → **只覆盖代码** → 现场数据一个字节都不动

为什么单独一个文件：这块是**会动自己代码**的逻辑，必须能和「检查版本」那种只读逻辑分开看、
分开测。它不 import server.py（server.py import 它），参数全部显式传进来。

流程（配合 server/_restart.py 与 start_server.bat）：

    POST /api/update/apply
      → download_archive()      拉 archive/master.zip（标准库 http.client + zipfile，不用 git）
      → apply_archive()         按白名单覆盖代码；**先备份**将被替换/新增的文件
      → 写 state/pending.json + restart.request 标记
      → 后端退出 → 由 start_server.bat 循环（或 _restart.py 助手）用新代码重新拉起
      → 新进程起不来 → _restart.py 用备份**自动回滚**并再拉一次旧代码

三条铁律（改这个文件之前先读一遍）：
  1. **绝不碰 server/data/**：现场画面工程（hmi_project.json）、变量表（vars.json）、
     PLC 配置（plc.json）、报警记录（alarm_history.json）、口令（auth.json）、掉电保持值
     都在那儿 —— 更新是"换程序"，不是"换现场"。压缩包里**确实带着**这几个文件
     （它们在版本库里），所以这里必须显式跳过，不能靠"碰巧没覆盖到"。
  2. **覆盖前先备份**：备份目录 data/_code_backup/<时间>_<旧版本>/，带 _manifest.json
     （哪些是替换的、哪些是新加的）—— 回滚靠它：替换过的还原、新加的删掉。
  3. **只认白名单**：代码/文档/脚本；压缩包里多出来的东西（截图、日志、缓存）一律不落地。
     删除的文件这里**不会**跟着删（保守：宁可留一个没用的旧文件，也别误删现场要用的）。
"""
import hashlib
import http.client
import json
import os
import re
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import urlparse

# ── 白名单：压缩包里哪些东西允许落到现场机器上 ─────────────────────────
# 目录（相对仓库根）：这些目录下的文件都算"程序"
KEEP_DIRS = ("css/", "js/", "server/", "docs/", "tools/", "test/")
# 根目录下允许更新的大写文件名 / 后缀
KEEP_ROOT_FILES = {"index.html", "version.json", "README.md", ".gitignore", "favicon.ico"}
KEEP_ROOT_EXT = (".bat", ".py", ".txt", ".xml", ".json", ".ico")
# 无视上面的规则，一律不动（现场数据、缓存、日志、开发用截图）
SKIP_PREFIXES = ("server/data/", "server/__pycache__/", "logs/", "shots/", "webview/")
SKIP_ANYWHERE = ("__pycache__/",)
SKIP_EXT = (".png", ".jpg", ".zip", ".log", ".pyc")

# 备份保留几份（现场磁盘不大，留最近几份够回滚/追查了）
KEEP_BACKUPS = 3

UPDATE_STATE_DIRNAME = "_update"     # 状态文件：data/_update/
BACKUP_DIRNAME = "_code_backup"      # 备份：data/_code_backup/
RESTART_FLAG = "restart.request"     # 这个文件在 = 服务是被"更新"弄退出的，起来时要接着重启


def is_code_path(rel: str) -> bool:
    """这个相对路径允不允许更新（白名单 + 黑名单）。rel 用 / 分隔、相对仓库根"""
    rel = rel.replace("\\", "/").lstrip("./")
    if not rel:
        return False
    if any(rel.startswith(p) for p in SKIP_PREFIXES):
        return False
    if any(p in rel for p in SKIP_ANYWHERE):
        return False
    if rel.lower().endswith(SKIP_EXT):
        return False
    if rel in KEEP_ROOT_FILES:
        return True
    if "/" not in rel:                       # 根目录下的散装文件：只认指名和后缀
        return rel.lower().endswith(KEEP_ROOT_EXT)
    return any(rel.startswith(d) for d in KEEP_DIRS)


# ── 版本号 / 包地址 / 校验 ────────────────────────────────────────────
def version_key(text):
    """'1.0.10' → (1,0,10)。比大小用（字符串比会把 1.0.10 判成比 1.0.9 小）"""
    nums = re.findall(r"\d+", str(text or ""))
    return tuple(int(n) for n in nums[:4]) if nums else ()


def package_url(manifest: dict, key: str, base_url: str = "") -> str:
    """从清单里取某个包的下载地址。

    清单两种写法都认：
      "app_zip": "HMI-Designer-1.0.4-app.zip"                        （相对清单同目录）
      "app_zip": {"url": "...", "file": "...", "sha256": "...", ...}  （推荐：带校验）
    ⚠ 字典形式**优先用 url**：发布仓库里包是 Release 附件（url 是 .../releases/download/<tag>/<文件>），
      而 file 只是个文件名 —— 优先 file 会把它当成"清单同目录下的文件"去 raw 路径找，
      结果 404（真实链路验证时踩到；假远端测试因为包就放在清单旁边，反而看不出来）。
    返回绝对 URL；都没有就返回空串（调用方退回默认地址）。"""
    v = (manifest or {}).get(key)
    if isinstance(v, dict):
        v = v.get("url") or v.get("file") or ""
    v = str(v or "").strip()
    if not v:
        return ""
    if v.startswith(("http://", "https://")):
        return v
    if not base_url:
        return v
    return base_url.rsplit("/", 1)[0] + "/" + v.lstrip("/")


def sha256_file(path: Path, chunk: int = 256 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def read_manifest_from_zip(z: zipfile.ZipFile, strip: str = ""):
    """从压缩包里读 version.json（用来核对"下到的这份是不是我要的那个版本"）"""
    name = f"{strip}version.json" if strip else "version.json"
    try:
        return json.loads(z.read(name).decode("utf-8-sig"))
    except Exception:                                           # noqa: BLE001
        return None


def _common_top_dir(names) -> str:
    """压缩包里的顶层目录名（Gitea 的归档是 hmi-designer/ 开头的）。
    没有共同顶层（或就是散文件）→ 返回空串，按原样处理"""
    tops = {n.split("/", 1)[0] for n in names if n and not n.endswith("/")}
    if len(tops) == 1:
        only = tops.pop()
        if all(n == only or n.startswith(only + "/") for n in names):
            return only + "/"
    return ""


def download_archive(url: str, dest: Path, timeout: float = 120.0, log=print) -> dict:
    """把代码包下到 dest。用 http.client 直连（不用 urllib：它会走 http_proxy 环境变量，
    车间代理会把内网地址也代理掉 → "莫名下不动"）。**不下完不落地**：先写 .part 再改名。"""
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        return {"ok": False, "error": f"下载地址不合法：{url}"}
    port = u.port or (443 if u.scheme == "https" else 80)
    path = (u.path or "/") + (f"?{u.query}" if u.query else "")
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    part = dest.with_suffix(dest.suffix + ".part")
    total = 0
    try:
        conn = cls(u.hostname, port, timeout=timeout)
        try:
            conn.request("GET", path, headers={"Accept": "application/zip",
                                               "User-Agent": "hmi-designer-updater"})
            resp = conn.getresponse()
            if resp.status != 200:
                return {"ok": False, "error": f"HTTP {resp.status}（{url}）"}
            want = int(resp.getheader("Content-Length") or 0)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(part, "wb") as f:
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    total += len(chunk)
        finally:
            conn.close()
        if want and total != want:
            part.unlink(missing_ok=True)
            return {"ok": False, "error": f"下载不完整（{total}/{want} 字节），已丢弃"}
        os.replace(part, dest)          # 下载完整才改名 —— 半截文件绝不能当成果
        log(f"[update] 代码包已下载：{dest.name}（{total / 1024 / 1024:.1f} MB）")
        return {"ok": True, "bytes": total, "path": str(dest)}
    except Exception as e:                                      # noqa: BLE001
        try:
            part.unlink(missing_ok=True)
        except Exception:                                       # noqa: BLE001
            pass
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _backup_dir(data_dir: Path, old_version: str) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    safe = "".join(c for c in str(old_version or "unknown") if c.isalnum() or c in ".-_") or "unknown"
    return data_dir / BACKUP_DIRNAME / f"{stamp}_{safe}"


def prune_backups(data_dir: Path, keep: int = KEEP_BACKUPS, log=print) -> int:
    """备份只留最近 keep 份（磁盘有限；回滚只用得到最近那份）"""
    root = data_dir / BACKUP_DIRNAME
    if not root.is_dir():
        return 0
    dirs = sorted([d for d in root.iterdir() if d.is_dir()], key=lambda p: p.name)
    removed = 0
    for d in dirs[:-keep] if keep > 0 else dirs:
        try:
            shutil.rmtree(d)
            removed += 1
        except Exception as e:                                  # noqa: BLE001
            log(f"[update] 备份清理失败（{d.name}）：{e}")
    return removed


def apply_archive(zip_path: Path, root: Path, data_dir: Path, old_version: str,
                  expect_version: str = "", expect_sha256: str = "", log=print) -> dict:
    """把压缩包里的**代码**覆盖到 root。返回 {ok, copied, created, backup_dir, version, error}

    · 先整包读一遍清单（顺便核对版本号与 sha256），确认没问题再动任何文件 —— 宁可不动，不可动一半
    · **硬断言：写出去的每一个路径都不许落在数据目录里**（现场工程/变量表/配置在 data_dir）——
      白名单已经跳过 server/data，这条是"万一布局变了"的第二道保险：宁可整个更新失败，
      也绝不允许碰到现场数据（见文件开头铁律 1）
    · 每个文件：先备份旧内容 → 写 xxx.hmi-new → os.replace 顶上（单个文件要么旧的要么新的）
    """
    root, data_dir = Path(root), Path(data_dir)
    try:
        z = zipfile.ZipFile(zip_path)
    except Exception as e:                                      # noqa: BLE001
        return {"ok": False, "error": f"代码包打不开：{type(e).__name__}: {e}"}

    # sha256：确认下到的东西就是发布方给的那一份（传输截断/被中间设备改过都能当场发现）
    if expect_sha256:
        got = sha256_file(zip_path)
        if got.lower() != str(expect_sha256).lower():
            return {"ok": False, "error": f"代码包校验不过（sha256 对不上：下到的 {got[:12]}…，"
                                          f"清单里是 {str(expect_sha256)[:12]}…）—— 已丢弃，代码没动"}

    with z:
        names = z.namelist()
        strip = _common_top_dir(names)
        man = read_manifest_from_zip(z, strip)
        new_version = str((man or {}).get("version") or "")
        if expect_version and new_version and new_version != expect_version:
            return {"ok": False, "error": f"下到的代码包版本是 {new_version}，跟要更新的 {expect_version} 对不上（中途又发版了？再点一次）"}
        if not new_version:
            log("[update] 代码包里没有 version.json —— 版本号核对跳过（老仓库/手打包）")

        # ── 先算出这次要动哪些文件（不动压缩包，先干活前把清单定死）──
        plan = []
        data_res = data_dir.resolve()
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = info.filename[len(strip):] if strip and info.filename.startswith(strip) else info.filename
            rel = rel.replace("\\", "/").lstrip("/")
            if not is_code_path(rel):
                continue
            target = (root / rel).resolve()
            if target == data_res or data_res in target.parents:
                return {"ok": False, "error": f"代码包里有个文件要写到**现场数据目录**里（{rel}）—— "
                                              f"已拒绝整个更新（数据目录：{data_res}）"}
            plan.append((rel, info))
        if not plan:
            return {"ok": False, "error": "代码包里没有可更新的文件（白名单没匹配上，检查 _common_top_dir/目录结构）"}

        backup = _backup_dir(data_dir, old_version)
        restored, created = [], []
        try:
            backup.mkdir(parents=True, exist_ok=True)
            for rel, info in plan:
                target = root / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    bk = backup / rel
                    bk.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, bk)        # 备份旧内容（回滚就靠它）
                    restored.append(rel)
                else:
                    created.append(rel)
                tmp = target.with_name(target.name + ".hmi-new")
                with z.open(info) as src, open(tmp, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                os.replace(tmp, target)             # 单文件原子替换：不会出现"写了一半的 js"
        except Exception as e:                                  # noqa: BLE001
            # 中途失败：尽量把自己已经改过的还原回去，别留个半新半旧的现场
            log(f"[update] 覆盖中途出错：{type(e).__name__}: {e} —— 正在还原")
            rb = rollback(backup, root, log=log)
            return {"ok": False, "error": f"{type(e).__name__}: {e}", "rollback": rb}

        (backup / "_manifest.json").write_text(json.dumps({
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "from_version": old_version, "to_version": new_version,
            "replaced": restored, "created": created,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        log(f"[update] 代码已更新到 {new_version or '?'}：替换 {len(restored)} 个、新增 {len(created)} 个；"
            f"备份在 {backup}")
        return {"ok": True, "version": new_version, "copied": len(restored), "created": len(created),
                "backup_dir": str(backup), "skipped_data": True}


def rollback(backup_dir: Path, root: Path, log=print) -> dict:
    """按备份把代码退回旧版：**替换过的还原、新加的删掉**。
    只动备份清单里列的文件 —— 现场数据不在这份清单里，所以回滚也碰不到它们。"""
    backup_dir, root = Path(backup_dir), Path(root)
    man_file = backup_dir / "_manifest.json"
    try:
        man = json.loads(man_file.read_text(encoding="utf-8"))
    except Exception as e:                                      # noqa: BLE001
        return {"ok": False, "error": f"读不到备份清单（{man_file}）：{e}"}
    fixed, removed, failed = 0, 0, []
    for rel in man.get("replaced", []):
        src, dst = backup_dir / rel, root / rel
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            fixed += 1
        except Exception as e:                                  # noqa: BLE001
            failed.append(f"{rel}: {e}")
    for rel in man.get("created", []):
        try:
            (root / rel).unlink(missing_ok=True)
            removed += 1
        except Exception as e:                                  # noqa: BLE001
            failed.append(f"{rel}: {e}")
    ok = not failed
    log(f"[update] 回滚到 {man.get('from_version') or '?'}：还原 {fixed} 个、删掉新增 {removed} 个"
        + ("" if ok else f"；{len(failed)} 个没弄成：{failed[:3]}"))
    return {"ok": ok, "restored": fixed, "removed": removed, "failed": failed[:5],
            "from_version": man.get("from_version"), "to_version": man.get("to_version")}


# ── 状态文件（data/_update/）────────────────────────────────────────────
# 为什么放 data 下：更新时**只覆盖代码**，data 是现场的、不被覆盖 →
# 更新前后的状态文件、备份、重启标记都能安全地跨"重启"这一跳活下来。
def state_dir(data_dir: Path) -> Path:
    d = Path(data_dir) / UPDATE_STATE_DIRNAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_state(data_dir: Path, name: str, obj: dict) -> Path:
    p = state_dir(data_dir) / name
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def read_state(data_dir: Path, name: str):
    try:
        return json.loads((Path(data_dir) / UPDATE_STATE_DIRNAME / name).read_text(encoding="utf-8"))
    except Exception:                                           # noqa: BLE001
        return None


def clear_state(data_dir: Path, name: str):
    try:
        (Path(data_dir) / UPDATE_STATE_DIRNAME / name).unlink(missing_ok=True)
    except Exception:                                           # noqa: BLE001
        pass


def temp_download_path() -> Path:
    """下载临时文件放系统临时目录（别放工程目录：下载中被看到会让人以为是工程文件）"""
    fd, name = tempfile.mkstemp(prefix="hmi-update-", suffix=".zip")
    os.close(fd)
    return Path(name)
