#!/usr/bin/env python3
"""生成扩展图标和商店图标。

图案：靛蓝圆角方块，几道浅色纬线，白色向下箭头落在橙色梭子上。
- extension/icons/icon16/32/48.png：铺满画布（工具栏、扩展管理页使用）
- extension/icons/icon128.png：图案 96×96，四周各留 16 像素透明边（Chrome 应用商店的要求）
- store/images/edge-logo-300.png：Edge 加载项商店的徽标（300×300）

用法：python3 scripts/make-icons.py   （需要 Pillow）
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
INDIGO = (30, 43, 79, 255)
WEFT = (47, 63, 110, 255)
WHITE = (255, 255, 255, 255)
SAFFRON = (240, 140, 0, 255)


def art(size):
    S = size * 8  # 超采样后缩小，边缘更平滑
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=INDIGO)
    detailed = size >= 32
    if detailed:
        for y in (0.24, 0.36, 0.48):
            d.line([(S * 0.14, S * y), (S * 0.86, S * y)], fill=WEFT, width=max(1, int(S * 0.025)))
    cx = S / 2
    shaft_w = S * (0.15 if detailed else 0.2)
    top = S * 0.14
    head_y = S * (0.47 if detailed else 0.44)
    tip_y = S * 0.70
    d.rectangle([cx - shaft_w / 2, top, cx + shaft_w / 2, head_y + 2], fill=WHITE)
    head_w = S * (0.46 if detailed else 0.62)
    d.polygon([(cx - head_w / 2, head_y), (cx + head_w / 2, head_y), (cx, tip_y)], fill=WHITE)
    sy = S * (0.82 if detailed else 0.84)
    sh = S * (0.075 if detailed else 0.10)
    sw = S * (0.62 if detailed else 0.76)
    d.polygon([(cx - sw / 2, sy), (cx - sw / 2 + sw * 0.18, sy - sh), (cx + sw / 2 - sw * 0.18, sy - sh), (cx + sw / 2, sy),
               (cx + sw / 2 - sw * 0.18, sy + sh), (cx - sw / 2 + sw * 0.18, sy + sh)], fill=SAFFRON)
    return im.resize((size, size), Image.LANCZOS)


def padded(canvas, inner):
    im = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    off = (canvas - inner) // 2
    im.alpha_composite(art(inner), (off, off))
    return im


def main():
    icons = ROOT / 'extension' / 'icons'
    for s in (16, 32, 48):
        art(s).save(icons / f'icon{s}.png', optimize=True)
    padded(128, 96).save(icons / 'icon128.png', optimize=True)
    store = ROOT / 'store' / 'images'
    store.mkdir(parents=True, exist_ok=True)
    padded(300, 276).save(store / 'edge-logo-300.png', optimize=True)
    print('icons written')


if __name__ == '__main__':
    main()
