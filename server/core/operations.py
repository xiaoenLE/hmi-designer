# -*- coding: utf-8 -*-
"""按字节循环保存运行操作记录，沿用已有的 UTF-8 JSONL 存档。"""

from collections import deque
from itertools import islice
import json
import os
import threading
import time

from . import auth
from .broadcast import broadcast
from .paths import DATA_DIR


MAX_BYTES = 20 * 1024 * 1024
# 写满时一次腾出少量空间，避免每次追加都重写整个文件。
COMPACT_RESERVE = 1024 * 1024
_file = DATA_DIR / "operations.jsonl"
_lock = threading.Lock()
_rows = None                           # (原始记录, UTF-8 行, 本地日期)
_size = 0
_revision = 0


def _replace_locked(entries):
    tmp = _file.with_suffix(".tmp")
    with tmp.open("wb") as out:
        out.writelines(line for _, line, _ in entries)
    os.replace(tmp, _file)


def _load_locked():
    global _rows, _size
    if _rows is not None:
        return
    rows = deque()
    size = 0
    repair = False
    if _file.exists():
        with _file.open("rb") as src:
            for line in src:
                try:
                    row = json.loads(line)
                except ValueError:
                    repair = True
                    continue
                if not isinstance(row, dict) or len(line) >= MAX_BYTES:
                    repair = True
                    continue
                if not line.endswith(b"\n"):
                    repair = True
                    line += b"\n"
                rows.append((row, line, _day_of(row)))
                size += len(line)
                while size > MAX_BYTES:
                    size -= len(rows.popleft()[1])
                    repair = True
    if repair:
        _replace_locked(rows)
    _rows, _size = rows, size


def _may_read(conn):
    if not auth.AUTH_ENABLED:
        return True
    role = str(getattr(conn, "role", "") or "").lower()
    return bool(getattr(conn, "authed", False)) and role not in ("operator", "viewer")


def record(actor, action, target, ok, detail=""):
    row = {
        "at": int(time.time() * 1000),
        "actor": str(actor or "未登录")[:100],
        "action": action,
        "target": str(target or "")[:200],
        "ok": bool(ok),
        "detail": str(detail)[:360],
    }
    line = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8", errors="replace")
    entry = row, line, _day_of(row)
    global _rows, _size, _revision
    with _lock:
        try:
            _load_locked()
            size = _size + len(line)
            if size > MAX_BYTES:
                target_size = max(len(line), MAX_BYTES - COMPACT_RESERVE)
                keep = deque(_rows)
                while size > target_size:
                    size -= len(keep.popleft()[1])
                keep.append(entry)
                _replace_locked(keep)
                _rows = keep
            else:
                with _file.open("ab") as out:
                    out.write(line)
                _rows.append(entry)
            _size = size
        except OSError as exc:
            _rows = None
            print(f"[operations] 保存操作记录失败：{exc}")
            return False
        _revision += 1
        broadcast({"t": "operations_changed", "revision": _revision, "row": row}, allow=_may_read)
    return True


def recent(limit=None, day=None, *, offset=0, query="", actions=(), results=()):
    """按本地日期与搜索条件分页。每页限制用于控制长连接帧大小。"""
    try:
        limit = max(1, min(500, int(limit)))
    except (ValueError, TypeError):
        limit = 200
    try:
        offset = max(0, int(offset))
    except (ValueError, TypeError):
        offset = 0
    query = query.casefold().strip()
    with _lock:
        _load_locked()
        if not day and not query:
            rows = [row for row, _, _ in islice(reversed(_rows), min(offset, len(_rows)), min(offset + limit, len(_rows)))]
            total = len(_rows)
        else:
            rows = []
            total = 0
            for row, _, row_day in reversed(_rows):
                if day and row_day != day:
                    continue
                if query:
                    action = row.get("action")
                    matched_result = action != "button" and row.get("ok") in results
                    if action not in actions and not matched_result and not any(
                        query in str(row.get(key) or "").casefold() for key in ("actor", "target", "detail", "action")
                    ):
                        continue
                if offset <= total < offset + limit:
                    rows.append(row)
                total += 1
        return {"rows": rows, "total": total, "revision": _revision}


def clear(day=None):
    """清空指定日期的记录（未指定时清空全部），返回实际删除条数。"""
    global _rows, _size, _revision
    with _lock:
        _load_locked()
        keep = deque(entry for entry in _rows if entry[2] != day) if day else deque()
        removed = len(_rows) - len(keep)
        _replace_locked(keep)
        _rows = keep
        _size = sum(len(line) for _, line, _ in keep)
        _revision += 1
        broadcast({"t": "operations_changed", "revision": _revision}, allow=_may_read)
        return removed


def _day_of(row):
    try:
        at = float(row.get("at") or 0) / 1000.0
        if at <= 0:
            return ""
        return time.strftime("%Y-%m-%d", time.localtime(at))
    except (TypeError, ValueError, OSError, OverflowError):
        return ""
