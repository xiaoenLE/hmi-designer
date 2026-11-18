# -*- coding: utf-8 -*-
"""make-icon.py — 生成应用图标（exe / 安装包 / 快捷方式都用它）

设计（为什么是这样，改之前先看）：
  · 圆形底"显示屏 + 波形"：一眼看出是"看数据的工业界面"，不是某个通用软件
  · 深蓝→青的斜向渐变：跟界面主色（--primary #2563eb）同族，摆在桌面/任务栏里不突兀
  · 白色屏幕里放一条蓝色趋势线 + 一个绿色状态点：这两个元素在 **16px** 下仍然分得清；
    再多的细节（文字、刻度、多个控件）缩到 16px 就糊成一团，等于没有
  · 4 倍超采样再缩小：边缘才不会有锯齿（ICO 各尺寸都从同一张大图缩）

用法：python tools/make-icon.py            # 生成 packaging/hmi.ico 和 docs/icon-preview.png
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_ICO = ROOT / "packaging" / "hmi.ico"
OUT_FAVICON = ROOT / "favicon.ico"          # 网页方式的 favicon（浏览器页签）
OUT_PNG = ROOT / "docs" / "icon-preview.png"
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
FAVICON_SIZES = [16, 32, 48]                # 页签用不了大图，别把 256 塞进去白占体积
SS = 8                                  # 超采样倍数

BLUE_TOP = (37, 99, 235)                # --primary
BLUE_BOT = (14, 165, 233)               # cyan
SCREEN = (248, 250, 252)
LINE = (37, 99, 235)
LED = (34, 197, 94)


def rounded_mask(size: int, radius_ratio: float = 0.22) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def gradient(size: int) -> Image.Image:
    """斜向渐变（左上深蓝 → 右下青）"""
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x / max(size - 1, 1) * 0.55 + y / max(size - 1, 1) * 0.45)
            px[x, y] = (
                int(BLUE_TOP[0] + (BLUE_BOT[0] - BLUE_TOP[0]) * t),
                int(BLUE_TOP[1] + (BLUE_BOT[1] - BLUE_TOP[1]) * t),
                int(BLUE_TOP[2] + (BLUE_BOT[2] - BLUE_TOP[2]) * t),
            )
    return g


def build(size: int) -> Image.Image:
    S = size * SS
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 圆角底 + 渐变
    base = gradient(S).convert("RGBA")
    base.putalpha(rounded_mask(S))
    icon.alpha_composite(base)

    d = ImageDraw.Draw(icon)

    # 屏幕（白底圆角矩形）
    m = int(S * 0.17)                                  # 外边距
    sw, sh = S - 2 * m, int((S - 2 * m) * 0.72)        # 屏幕比 4:3 略扁
    top = (S - sh) // 2
    box = [m, top, m + sw, top + sh]
    d.rounded_rectangle(box, radius=int(S * 0.075), fill=SCREEN)

    # 趋势线：左低 → 两个峰 → 右高（折线在小尺寸下最清楚）
    pad = int(sw * 0.16)
    x0, x1 = m + pad, m + sw - pad
    y_base = top + sh - pad
    y_hi = top + pad
    pts = []
    kn = 4
    heights = [0.15, 0.95, 0.45, 0.80]                 # 相对高度（0=底 1=顶）
    for i, h in enumerate(heights):
        x = x0 + (x1 - x0) * i / (kn - 1)
        y = y_base - (y_base - y_hi) * h
        pts.append((x, y))
    d.line(pts, fill=LINE, width=max(int(S * 0.035), 2), joint="curve")

    # 画一条基线（像坐标轴，让"在看数据"更明确）
    d.line([(x0, y_base + int(S * 0.02)), (x1, y_base + int(S * 0.02))],
           fill=(148, 163, 184), width=max(int(S * 0.018), 1))

    # 状态点：右上角，绿色（"设备在线"的通用语言）
    r = int(S * 0.055)
    cx, cy = m + sw - int(S * 0.075), top + int(S * 0.075)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=LED)

    return icon.resize((size, size), Image.LANCZOS)


def main() -> int:
    OUT_ICO.parent.mkdir(parents=True, exist_ok=True)
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    imgs = [build(s) for s in SIZES]
    # ICO 里放多尺寸：任务栏/桌面/文件列表各取所需，不用系统去缩大图
    imgs[-1].save(OUT_ICO, format="ICO", sizes=[(s, s) for s in SIZES])
    build(48).save(OUT_FAVICON, format="ICO", sizes=[(s, s) for s in FAVICON_SIZES])
    # 预览图：把几个关键尺寸并排放大，方便肉眼检查
    preview = Image.new("RGBA", (256 + 128 + 64 + 48 + 32 + 24 + 16 + 7 * 24, 300), (245, 247, 250, 255))
    x = 24
    for s in (256, 128, 64, 48, 32, 24, 16):
        img = build(s)
        preview.alpha_composite(img, (x, 20))
        x += s + 24
    preview.save(OUT_PNG)
    print(f"图标已生成：{OUT_ICO}（{len(SIZES)} 个尺寸）")
    print(f"网页页签图标：{OUT_FAVICON}（{len(FAVICON_SIZES)} 个尺寸）")
    print(f"预览：{OUT_PNG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
