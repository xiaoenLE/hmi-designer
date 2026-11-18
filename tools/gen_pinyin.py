#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen_pinyin.py — 生成 js/data/pinyin.js（运行态软键盘的中文输入用）

为什么要有这个脚本：HMI 现场是触摸屏，没有实体键盘、也没有输入法。
中文输入只能自己在页面上做「拼音 → 候选字」，那就需要一张离线的 拼音→汉字 表。
表不能手写（错一个字就是打不出来），必须由公开数据生成，所以留这个脚本备查/可重跑。

数据来源：
  1. pinyin-data/pinyin.txt  （多音字齐全：一个字可能对应多个拼音）
       https://github.com/mozillazg/pinyin-data
  2. hanziDB.csv             （汉字按使用频率排序，用来把常用字排到候选最前面）
       https://github.com/ruddfawcett/hanziDB.csv
       （依据 Jun Da《Modern Chinese Character Frequency List》）
  3. GB2312 一级+二级字库     （Python 内置 codec 现算，不用下载）

用法：
  py -3 tools/gen_pinyin.py <pinyin.txt> <hanziDB.csv> [输出路径]
默认输出 js/data/pinyin.js
"""
import csv
import io
import json
import os
import re
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "js", "data", "pinyin.js")

# 拼音里 ü 的两种写法；表里统一记成 'v'（键盘上只有 26 个字母，手机上也是打 v）
U_UMLAUT = ("ü", "u:", "v")


def toneless(py: str) -> str:
    """把带声调的拼音压成「只有字母」的形式：shì → shi，nǚ → nv，ê → e

    ⚠ ü 有好几种写法：带调的 ǖǘǚǜ 是预组合字符（U+01D5..U+01DC），
      直接 replace('ü') 抓不到，NFD 拆开后又被当成声调丢掉 → 女会跑到 nu 里。
      所以拆开后要盯着「u + 分音符」这一个组合，把它并成 v。
    """
    s = py.strip().lower().replace("u:", "v")
    out = []
    for ch in unicodedata.normalize("NFD", s):
        if unicodedata.combining(ch):
            if ch == "\u0308" and out and out[-1] == "u":     # u + ̈ = ü
                out[-1] = "v"
            continue                                          # 其余（声调）丢掉
        out.append("v" if ch == "ü" else ch)
    return re.sub(r"[^a-z]", "", "".join(out))


def load_pinyin(path):
    """pinyin.txt → {汉字: {拼音…}}（多音字全收）"""
    table = {}
    with io.open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^U\+([0-9A-Fa-f]{4,6}):\s*([^#]+)", line)
            if not m:
                continue
            ch = chr(int(m.group(1), 16))
            pys = {toneless(p) for p in m.group(2).split(",") if toneless(p)}
            if pys:
                table[ch] = pys
    return table


def load_rank(path):
    """hanziDB.csv → {汉字: 频率名次}（越小越常用）

    表头：frequency_rank,charcter,pinyin,definition,radical,radical_code,stroke_count,...
    """
    rank = {}
    with io.open(path, encoding="utf-8", errors="replace", newline="") as f:
        for row in csv.reader(f):
            if len(row) < 3:
                continue
            ch = row[1].strip()
            if len(ch) != 1:
                continue
            try:
                r = int(row[0])
            except (ValueError, IndexError):
                continue
            if ch not in rank or r < rank[ch]:
                rank[ch] = r
    return rank


def gb2312_chars():
    """GB2312 一级（3755 常用）+ 二级（3008 次常用）字库 —— 只用内置 codec 现算"""
    out = []
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return set(out)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    py_path, rank_path = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_OUT

    pinyin = load_pinyin(py_path)
    rank = load_rank(rank_path)
    keep = gb2312_chars()                       # 只留日常会用到的字，表小、候选短

    buckets = {}
    for ch, pys in pinyin.items():
        if ch not in keep:
            continue
        for py in pys:
            if not py:
                continue
            buckets.setdefault(py, []).append(ch)
            # ü 的那几个音同时挂到 u 的写法上：用户打 nu 也能找到 女（打 nv 更准）
            if "v" in py:
                buckets.setdefault(py.replace("v", "u"), []).append(ch)

    # 排序：常用字在前（Jun Da 频率名次），没名次的按笔画无关的码位兜底
    BIG = 10 ** 9
    lines = []
    total = 0
    for py in sorted(buckets):
        chars = sorted(set(buckets[py]), key=lambda c: (rank.get(c, BIG), ord(c)))
        lines.append('  %s: %s,' % (json.dumps(py), json.dumps("".join(chars), ensure_ascii=False)))
        total += len(chars)

    header = """/**
 * pinyin.js — 汉字拼音表（**自动生成，别手改**）
 *
 * 用途：运行态软键盘的中文输入（拼音 → 候选字）。触摸屏现场没有实体键盘、
 *   也没有系统输入法，中文只能页面上自己拼。数据是离线打包的，不联网。
 *
 * 生成：py -3 tools/gen_pinyin.py <pinyin.txt> <hanziDB.csv>
 *   1. https://github.com/mozillazg/pinyin-data  （多音字）
 *   2. https://github.com/ruddfawcett/hanziDB.csv （Jun Da 汉字频率，常用字排前）
 *   3. GB2312 一/二级字库（内置 codec 现算）
 * 每个音节里的字按使用频率排序 —— 常用的第一个就是，不用翻。
 * key 里的 v 就是 ü（nǚ → nv）；同时挂了 u 的写法（nu 也能找到 女）。
 */
export const PINYIN = {
"""
    footer = """};

/** 这个音节（前缀）有哪些字；查不到就返回空数组 */
export function pinyinCandidates(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return [];
  if (PINYIN[k]) return [...PINYIN[k]];
  const alt = k.includes('u') ? k.replace(/u/g, 'v') : '';
  if (alt && PINYIN[alt]) return [...PINYIN[alt]];
  return [];
}

/** 打了一半（如 zhang 打到 zh）：能接下去的音节，给用户提个醒 */
export function pinyinComplete(prefix, max = 8) {
  const p = String(prefix || '').toLowerCase().replace(/[^a-z]/g, '');
  if (p.length < 1) return [];
  return Object.keys(PINYIN).filter(k => k !== p && k.startsWith(p)).slice(0, max);
}

/** 音节表里有没有这个字（调试/自检用） */
export function pinyinOf(ch) {
  const hit = [];
  for (const [k, s] of Object.entries(PINYIN)) if (s.includes(ch)) hit.push(k);
  return hit;
}
"""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with io.open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(header)
        f.write("\n".join(lines))
        f.write("\n")
        f.write(footer)

    common = [b for b in buckets.get("shi", [])][:6]
    print(f"音节 {len(buckets)} 个 / 字 {total} 个 → {out_path}")
    print("样例 shi:", "".join(sorted(set(buckets.get('shi', [])), key=lambda c: (rank.get(c, BIG), ord(c)))[:8]))
    print("样例 ni:", "".join(sorted(set(buckets.get('ni', [])), key=lambda c: (rank.get(c, BIG), ord(c)))[:6]))
    print("样例 nv:", "".join(sorted(set(buckets.get('nv', [])), key=lambda c: (rank.get(c, BIG), ord(c)))[:6]))
    print(f"文件大小 {os.path.getsize(out_path)} 字节")
    return 0


if __name__ == "__main__":
    sys.exit(main())
