#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recipe.py — 配方（现场数据：配方名 + 一组变量值，**不进版本库**）

配方是现场换产/调试时用的一整套变量值：操作员把当前这套值存成「班次A」，
下次换产一键写回去。它和工程、报警、掉电保持值一样属于**这台机器的现场数据**，
存在数据目录（默认 `server/data/`，`HMI_DATA_DIR` 可指到别处）下的 `recipes.json`：

    {"recipes": {"班次A": {"vars": {"温度": 35.5, "速度": 1200},
                            "updated": "2026-10-18 15:20:00"}}}

→ `.gitignore` 里排除了 `server/data/recipes.json`（现场数据不进版本库）。

落盘规矩（和 retain.py / settings.py 一致，现场踩过"写一半断电"的坑）：
  · 写盘**原子**：先写同目录 `recipes.json.tmp`，再 `os.replace` 顶上 ——
    写一半断电/被杀不会留个半截表，最坏是这次保存没生效（旧表还在）；
  · 文件读不出来 / 结构不对 → 打一行 warn、按**空表**继续（配方坏了不能把后端起不来）；
  · 读改写都在进程内用 `threading.RLock` 串起来：两个页面同时点保存不会互相踩，
    也不会出现"内存里是新的、盘上却是旧的"。

应用配方（apply）**逐个变量走 varapi.var_write**（和运行页写值、脚本写值同一条路）：
内部变量、PLC 变量、广播、以及「没人看运行画面就不采设备」的门都照现有规矩，
不另开一套。写不进去的变量逐个收集成 {ok:false, error}，**不挡住其它变量**。
"""
from .paths import RECIPE_FILE
from . import datasource
from .varapi import var_write

import json
import hashlib
import os
import threading
import time
from pathlib import Path


# 配方名/变量名长度、单配方变量个数的上限：只是防手滑（正常工程远到不了）
NAME_MAX = 100
VARS_MAX = 5000


class RecipeConflict(ValueError):
    pass


def recipe_value(value, vtype):
    """配方兼容 BOOL 的 0/1 和 true/false。"""
    vtype = str(vtype or "").lower()
    if vtype == "bool[]" and isinstance(value, (tuple, list)):
        return [recipe_value(item, "bool") for item in value]
    if vtype != "bool":
        return value
    key = value.strip().lower() if isinstance(value, str) else value
    if key in (0, "0", "false"):
        return False
    if key in (1, "1", "true"):
        return True
    return value


def _revision(variables):
    encoded = json.dumps(variables, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _check_revision(rec, expected):
    if expected is not None and (rec is None or _revision(rec["vars"]) != expected):
        raise RecipeConflict("配方已在其它窗口修改或删除，请重新读取后再操作")


class RecipeStore:
    """一份 `recipes.json` 的读写门面（一个进程一个实例，见文件末尾的 `_recipes`）。

    对外：list_names() / count() / get(name) / snapshot() / save(name, vars) /
          delete(name) / apply(name)。

    ⚠ 别绕过这把锁直接改 `_recipes` 里的 dict：`save/delete` 是"整表写盘成功才换内存"
      的，顺序反了会出现内存与盘不一致。
    """

    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.RLock()
        self._recipes = {}          # {名称: {"vars": {变量名: 值}, "updated": "…"}}
        self._load()

    # ── 读盘 / 写盘（内部）─────────────────────────────────────────────
    def _load(self):
        """启动时读一次。读不出来不算错：按空表继续（配方是现场数据，坏了也不能拖垮服务）"""
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception as e:                                      # noqa: BLE001
            print(f"[warn] 配方文件读不出来（{e}）：先按空表继续，文件没动：{self.path}")
            return
        items = raw.get("recipes") if isinstance(raw, dict) else None
        if not isinstance(items, dict):
            print(f"[warn] 配方文件结构不对（没有 recipes 对象）：先按空表继续：{self.path}")
            return
        clean = {}
        for name, rec in items.items():
            if not isinstance(name, str) or not name:
                continue
            if isinstance(rec, dict) and isinstance(rec.get("vars"), dict):
                clean[name] = {"vars": dict(rec["vars"]),
                               "updated": str(rec.get("updated") or "")}
        self._recipes = clean
        print(f"[recipe] 已载入 {len(clean)} 个配方：{self.path}")

    def _write_locked(self, recipes):
        """把整表写盘（调用方**必须已持锁**）。原子替换；失败抛 OSError 给调用方转成接口错误。"""
        payload = json.dumps({"recipes": recipes}, ensure_ascii=False, indent=2)
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(payload, encoding="utf-8")
            os.replace(tmp, self.path)          # 原子：要么旧表、要么新表，不会半截
        finally:
            # 写失败（磁盘满/权限）时别把 .tmp 留在现场目录里；成功时 replace 已经把它搬走了
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass

    # ── 对外：读 ────────────────────────────────────────────────────────
    def list_names(self):
        """所有配方名（排过序，界面上顺序稳定）"""
        with self._lock:
            return sorted(self._recipes.keys())

    def count(self):
        with self._lock:
            return len(self._recipes)

    def summary(self):
        with self._lock:
            return [{"name": name, "count": len(rec["vars"]), "updated": rec["updated"]}
                    for name, rec in sorted(self._recipes.items())]

    def get(self, name):
        """取一个配方 → {"name", "vars", "updated"}；没有返回 None（返回的是副本，改不到存档）"""
        name = str(name or "").strip()
        if not name:
            return None
        with self._lock:
            rec = self._recipes.get(name)
            if rec is None:
                return None
            return {"name": name, "vars": dict(rec["vars"]), "updated": rec["updated"],
                    "revision": _revision(rec["vars"])}

    def snapshot(self):
        """整表（GET /api/recipes?full=1 用）→ {名称: {"vars": {...}, "updated": "…"}}"""
        with self._lock:
            return {name: {"vars": dict(rec["vars"]), "updated": rec["updated"]}
                    for name, rec in self._recipes.items()}

    # ── 对外：写 ────────────────────────────────────────────────────────
    def save(self, name, variables, *, expected=None, create_only=False):
        """保存/覆盖一个配方（同名直接覆盖）。返回 {"name", "vars", "updated"}。

        写得进内存不算数：**整表落盘成功才换内存**；盘写不进去抛 OSError，
        由接口层回 500（现场能看见"配方没存上"，而不是以为存了、重启却没）。
        """
        name = str(name or "").strip()
        if not name:
            raise ValueError("配方名不能为空")
        if len(name) > NAME_MAX:
            raise ValueError(f"配方名太长（最多 {NAME_MAX} 个字符）")
        if not isinstance(variables, dict):
            raise ValueError("vars 必须是一个对象：{变量名: 值}")
        if len(variables) > VARS_MAX:
            raise ValueError(f"一个配方最多 {VARS_MAX} 个变量")
        rec = {"vars": {str(k): v for k, v in variables.items()},
               "updated": time.strftime("%Y-%m-%d %H:%M:%S")}
        with self._lock:
            prev = self._recipes.get(name)
            if create_only and prev is not None:
                raise RecipeConflict("已经有同名配方，请改用其它名称")
            _check_revision(prev, expected)
            new = dict(self._recipes)
            new[name] = rec
            self._write_locked(new)
            self._recipes = new
        print(f"[recipe] 已保存配方「{name}」（{len(rec['vars'])} 个变量）")
        return {"name": name, "vars": dict(rec["vars"]), "updated": rec["updated"],
                "revision": _revision(rec["vars"])}

    def delete(self, name, *, expected=None):
        """删一个配方。返回 True=真删了、False=本来就没有（幂等，调用方不用先查）"""
        name = str(name or "").strip()
        if not name:
            raise ValueError("配方名不能为空")
        with self._lock:
            _check_revision(self._recipes.get(name), expected)
            if name not in self._recipes:
                return False
            new = dict(self._recipes)
            new.pop(name, None)
            self._write_locked(new)
            self._recipes = new
        print(f"[recipe] 已删除配方「{name}」")
        return True

    # ── 对外：应用 ──────────────────────────────────────────────────────
    def apply(self, name, *, expected=None):
        """把配方里的值逐个写回变量。

        → {"ok": bool, "name": 名称,
           "applied": [写成功的变量名…],
           "failed": [{"name": 变量名, "error": 原因}…],
           "error": 只有"配方不存在"这种整体失败才给}

        ⚠ 变量写入走 `varapi.var_write`（不持锁调用：PLC 写可能慢，不能让保存/列表跟着等）。
          "变量不存在"的判定交给 var_write 自己：接真 PLC 时未声明的变量会报
          「未在变量表声明」进 failed；内存模式下按现有规矩自动建档（运行页写值同款）。
        """
        name = str(name or "").strip()
        if not name:
            raise ValueError("配方名不能为空")
        rec = self.get(name)                    # 拿副本，写值期间不受其它保存影响
        if expected is not None and (rec is None or rec["revision"] != expected):
            raise RecipeConflict("配方已在其它窗口修改或删除，请重新读取后再操作")
        if rec is None:
            return {"ok": False, "name": name, "applied": [], "failed": [],
                    "error": f"没有这个配方：{name}"}
        applied, failed = [], []
        meta = datasource.get_source().meta()
        for vname, value in rec["vars"].items():
            ok, extra = var_write(vname, recipe_value(value, meta.get(vname, {}).get("type")))
            if ok:
                applied.append(vname)
            else:
                failed.append({"name": vname,
                               "error": str((extra or {}).get("error") or "写入失败")})
        if failed:
            print(f"[recipe] 应用配方「{name}」：成功 {len(applied)} 个、失败 {len(failed)} 个"
                  f"（{', '.join(f['name'] or '(空变量名)' for f in failed[:5])}）")
        else:
            print(f"[recipe] 应用配方「{name}」：{len(applied)} 个变量已写入")
        out = {"ok": not failed, "name": name, "applied": applied, "failed": failed}
        if failed:
            # 给个一句话总结：前端就算只把 error 弹出来，也知道"这次没全成"
            names = "、".join(f["name"] or "(空变量名)" for f in failed[:6])
            out["error"] = (f"{len(failed)} 个变量没写成功：{names}"
                            + (" 等" if len(failed) > 6 else ""))
        return out


# 全局一份（和 retain.py 的 `_retain` 一个用法）：数据目录路径从 core/paths.py 来，
# 不在本文件里写死；测试用独立 HMI_DATA_DIR 起后端时自然指向临时目录。
_recipes = RecipeStore(RECIPE_FILE)
