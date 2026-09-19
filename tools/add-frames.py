# -*- coding: utf-8 -*-
"""把自备图片并入站点素材库，让访客也能看到。

背景：页面上的「上传」把图片存进浏览器的本地数据库（IndexedDB），那是
你这台机器的私有数据，换台机器、换个浏览器、或者部署到公网之后，别人
打开一律看不到。站点要给别人看，图片就必须变成**仓库里的文件** —— 这
个脚本负责这一步：

    原图  ->  assets/{hero,view,grid}/<前缀>-NN.webp   （与内置素材同一套规格）
          ->  登记进 scripts/frames-data.js            （含色调标签，供筛选条使用）

加工规则与页面里那套完全对齐：长边分别压到 1600 / 1200 / 800，WebP 质量
0.82，色调按 160×90 采样后走同一组阈值，保证新图与内置图在站内行为一致。

用法示例：
    python tools/add-frames.py --src "D:/我的图" --series "电锯人"
    python tools/add-frames.py --src 1.png 2.png --ring
    python tools/add-frames.py --src "D:/我的图" --dry-run     # 只看计划不落盘
"""

import argparse
import colorsys
import glob
import os
import re
import sys

try:
    from PIL import Image, ImageChops, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit("缺少 Pillow：请先执行 pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
DATA_FILE = os.path.join(ROOT, "scripts", "frames-data.js")

TIERS = (("hero", 1600), ("view", 1200), ("grid", 800))
HERO_MIN_EDGE = 1200      # 原图长边不足此数就不出 hero 档，环幕会自动退回 view
SAMPLE = (160, 90)        # 与页面里的采样尺寸一致
QUALITY = 82              # 与页面里 canvas.toBlob(..., 'image/webp', 0.82) 对齐
EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif")
DUP_CMP = (64, 64)        # 查重用的灰度尺寸
DUP_MAE = 10              # 与站内素材的平均像素差低于此值即判为同一张

# 平台水印：对同一来源的截图，位置与尺寸是固定的（用多张图投票定位得到）。
# 这里记的是「距右边缘 / 距底边 / 宽 / 高」。只对横图（视频截图）生效 ——
# 竖图多为漫画截图，水印是另一种样式、位置也不同，不做处理更安全。
WM_OFFSET = (38, 112, 54, 51)
WM_MIN_RATIO = 1.5


def watermark_box(size):
    w, h = size
    if w / float(h) < WM_MIN_RATIO:
        return None
    x2, y2 = w - WM_OFFSET[0], h - WM_OFFSET[1]
    return (x2 - WM_OFFSET[2], y2 - WM_OFFSET[3], x2, y2)


def strip_watermark(im):
    """把水印区用四边双线性插值填掉，再对边界做一次极轻的柔化。

    对大面积平涂 / 渐变的画面几乎无痕；在站内实际显示尺寸下肉眼不可辨。
    """
    box = watermark_box(im.size)
    if not box:
        return False
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    px = im.load()
    for y in range(y1, y2):
        fy = (y - y1 + 1) / float(h + 1)
        for x in range(x1, x2):
            fx = (x - x1 + 1) / float(w + 1)
            l, r = px[x1 - 1, y], px[x2, y]
            u, d = px[x, y1 - 1], px[x, y2]
            hx = [l[i] * (1 - fx) + r[i] * fx for i in range(3)]
            vy = [u[i] * (1 - fy) + d[i] * fy for i in range(3)]
            px[x, y] = (int((hx[0] + vy[0]) / 2),
                        int((hx[1] + vy[1]) / 2),
                        int((hx[2] + vy[2]) / 2))
    pad = 3
    region = im.crop((x1 - pad, y1 - pad, x2 + pad, y2 + pad)).filter(ImageFilter.GaussianBlur(0.8))
    im.paste(region, (x1 - pad, y1 - pad))
    return True


# --------------------------------------------------------------------------
# 查重：原图与站内素材逐张比对，避免同一画面进来两次
# --------------------------------------------------------------------------
def fingerprint(im):
    return im.convert("L").resize(DUP_CMP, Image.LANCZOS)


def pixel_diff(a, b):
    d = ImageChops.difference(a, b).tobytes()
    return sum(d) / float(len(d))


def load_existing():
    """站内已有素材的灰度指纹（取最小档 grid，够分辨了）。"""
    out = []
    for path in sorted(glob.glob(os.path.join(ASSETS, "grid", "*.webp"))):
        try:
            out.append((os.path.splitext(os.path.basename(path))[0], fingerprint(Image.open(path))))
        except Exception:
            pass
    return out


# --------------------------------------------------------------------------
# 读图
# --------------------------------------------------------------------------
def collect(srcs):
    """把命令行给的路径摊平成图片文件列表（目录递归，结果去重并保持稳定顺序）。"""
    found = []
    for src in srcs:
        if os.path.isdir(src):
            for base, _dirs, files in os.walk(src):
                for name in sorted(files):
                    if os.path.splitext(name)[1].lower() in EXTS:
                        found.append(os.path.join(base, name))
        elif os.path.isfile(src):
            found.append(src)
        else:
            print("  ! 跳过（路径不存在）：%s" % src)
    seen, uniq = set(), []
    for p in found:
        key = os.path.normcase(os.path.abspath(p))
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def resize_long(im, edge):
    """按长边缩到 edge；原图比 edge 小则原样返回（不放大，省得糊）。"""
    w, h = im.size
    long_edge = max(w, h)
    if long_edge <= edge:
        return im.copy()
    scale = edge / float(long_edge)
    return im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


# --------------------------------------------------------------------------
# 色调：与页面里的 shadeOf / tagsOf 逐条对齐
# --------------------------------------------------------------------------
def shade(im):
    W, H = SAMPLE
    small = im.convert("RGB").resize((W, H), Image.LANCZOS)
    raw = small.tobytes()                    # 逐像素 RGB 字节流，避开 getdata 的弃用
    n = float(W * H)
    val = sat = warm = cool = 0.0
    for i in range(0, len(raw), 3):
        h, s, v = colorsys.rgb_to_hsv(raw[i] / 255.0, raw[i + 1] / 255.0, raw[i + 2] / 255.0)
        h *= 360.0
        val += v
        sat += s
        if s > 0.10:
            if h < 90 or h > 300:
                warm += 1
            elif 150 < h < 300:
                cool += 1
    return {"v": val / n, "s": sat / n, "warm": warm / n, "cool": cool / n}


def tags_of(st):
    tags = []
    if st["v"] < 0.34:
        tags.append("夜色")
    elif st["v"] > 0.55:
        tags.append("明亮")
    if st["warm"] > 0.34:
        tags.append("暖调")
    if st["cool"] > 0.34:
        tags.append("冷调")
    if st["s"] < 0.18:
        tags.append("低饱和")
    if not tags:
        tags.append("中间调")
    return tags


# --------------------------------------------------------------------------
# 素材清单：定位插入点
# --------------------------------------------------------------------------
def read_data():
    with open(DATA_FILE, "r", encoding="utf-8", newline="") as fh:
        raw = fh.read()
    nl = "\r\n" if "\r\n" in raw else "\n"
    return raw.replace("\r\n", "\n"), nl


def next_index(prefix):
    """扫描现有素材名，算出下一个可用编号（mine-07 -> 下一个是 mine-08）。"""
    top = 0
    pat = re.compile(re.escape(prefix) + r"-(\d+)$")
    for tier, _edge in TIERS:
        folder = os.path.join(ASSETS, tier)
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            m = pat.match(os.path.splitext(name)[0])
            if m:
                top = max(top, int(m.group(1)))
    return top + 1


def current_count(src):
    m = re.search(r'"count"\s*:\s*(\d+)', src)
    return int(m.group(1)) if m else 0


def insert_entries(src, blocks, hero_names, new_count):
    """把新条目写进 frames 数组末尾，并同步 count 与 heroAssets。"""
    src = re.sub(r'("count"\s*:\s*)\d+', lambda m: m.group(1) + str(new_count), src, count=1)

    if hero_names:
        def add_hero(m):
            inner = m.group(2).rstrip()
            extra = "".join(',\n  "%s"' % n for n in hero_names)
            return m.group(1) + inner + extra + m.group(3)
        src = re.sub(r'("heroAssets"\s*:\s*\[)(.*?)(\n[ \t]*\])', add_hero, src,
                     count=1, flags=re.S)

    cut = src.rfind("\n ]")
    if cut < 0:
        raise SystemExit("没在 frames-data.js 里找到 frames 数组的结尾，请手动检查格式")
    head, tail = src[:cut], src[cut:]
    # head 结尾是最后一个条目的 “  }”，先补逗号；块与块之间同样要用逗号隔开
    body = ",\n".join(block.rstrip("\n") for block in blocks)
    src = head + ",\n" + body + tail
    return src


def js_entry(idx, name, hero, tags, v, date, series):
    """生成一条与现有素材同构的记录，缩进沿用文件里的 1 空格递进。"""
    lines = [
        "  {",
        '   "id": %d,' % idx,
        '   "name": "%s",' % name,
        '   "hero": %s,' % ("true" if hero else "false"),
        '   "title": "",',
        '   "en": "",',
    ]
    if series:
        lines.append('   "series": "%s",' % series)
    lines.append('   "tags": [')
    for i, t in enumerate(tags):
        lines.append('    "%s"%s' % (t, "" if i == len(tags) - 1 else ","))
    lines += [
        "   ],",
        '   "v": %s,' % ("%.3f" % v).rstrip("0").rstrip("."),
        '   "date": "%s"' % date,
        "  }",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="把自备图片加工成站点素材并登记进素材清单",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--src", nargs="+", required=True, help="图片文件或目录（可多个）")
    ap.add_argument("--series", default="", help="归类到的番剧名，留空则不写")
    ap.add_argument("--prefix", default="mine", help="素材名前缀，默认 mine")
    ap.add_argument("--ring", action="store_true", help="把这些图默认放上环幕")
    ap.add_argument("--date", default="", help="记录日期，默认取今天")
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少张，0 表示不限")
    ap.add_argument("--no-dup-check", action="store_true",
                    help="不做查重（默认会跳过与站内素材为同一画面的图）")
    ap.add_argument("--dup-threshold", type=float, default=DUP_MAE,
                    help="查重的像素差阈值，默认 %g，调大更宽松" % DUP_MAE)
    ap.add_argument("--no-watermark", action="store_true",
                    help="不处理平台水印（默认会抹掉横图右下角的水印）")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不写任何文件")
    args = ap.parse_args()

    import datetime
    date = args.date or datetime.date.today().strftime("%Y.%m.%d")

    files = collect(args.src)
    if args.limit:
        files = files[: args.limit]
    if not files:
        sys.exit("没有找到可处理的图片")

    src_text, nl = read_data()
    count = current_count(src_text)
    start = next_index(args.prefix)

    print("待处理 %d 张，素材名从 %s-%02d 起，当前素材总数 %d" % (len(files), args.prefix, start, count))

    existing = [] if args.no_dup_check else load_existing()
    if existing:
        print("站内 %d 张素材参与查重（像素差阈值 %g）" % (len(existing), args.dup_threshold))
    print("-" * 66)

    blocks, hero_assets, dupes, wm_skipped = [], [], [], []
    total_bytes = 0
    wm_done = 0

    for i, path in enumerate(files):
        try:
            im = Image.open(path).convert("RGB")
        except Exception as err:
            print("  ! %s 读不出来（%s），跳过" % (os.path.basename(path), err))
            continue

        if existing:
            fp = fingerprint(im)
            hit, hm = None, 999.0
            for en, eg in existing:
                m = pixel_diff(fp, eg)
                if m < hm:
                    hm, hit = m, en
            if hm < args.dup_threshold:
                dupes.append((os.path.basename(path), hit, hm))
                print("  = 重复  %-38s 与 %-13s 像素差 %4.1f，跳过"
                      % (os.path.basename(path)[:38], hit, hm))
                continue

        name = "%s-%02d" % (args.prefix, start + len(blocks))

        if not args.no_watermark:
            if strip_watermark(im):
                wm_done += 1
            else:
                wm_skipped.append(os.path.basename(path))

        long_edge = max(im.size)
        plan = []
        for tier, edge in TIERS:
            if tier == "hero" and long_edge <= HERO_MIN_EDGE:
                continue                     # 原图不够大，hero 档不出，环幕自动退回 view
            plan.append((tier, resize_long(im, edge)))

        st = shade(im)
        tags = tags_of(st)
        idx = count + len(blocks) + 1
        has_hero = any(t[0] == "hero" for t in plan)

        if not args.dry_run:
            for tier, out in plan:
                folder = os.path.join(ASSETS, tier)
                os.makedirs(folder, exist_ok=True)
                dest = os.path.join(folder, name + ".webp")
                out.convert("RGB").save(dest, "WEBP", quality=QUALITY, method=5)
                total_bytes += os.path.getsize(dest)

        blocks.append(js_entry(idx, name, args.ring, tags, st["v"], date, args.series))
        if has_hero:
            hero_assets.append(name)          # 只有真出了 1600 大图的才登记，环幕据此决定取哪一档

        print("  %-10s %-44s %5dx%-4d  v=%.3f  %s"
              % (name, os.path.basename(path)[:44], im.size[0], im.size[1],
                 st["v"], "/".join(tags)))
        print("             %s%s" % ("档位 ",
              " ".join("%s(%d)" % (t, max(o.size)) for t, o in plan)))

    print("-" * 66)
    if dupes:
        print("查重跳过 %d 张（与站内为同一画面），实际新增 %d 张" % (len(dupes), len(blocks)))
    if wm_done or wm_skipped:
        line = "水印处理：抹掉 %d 张" % wm_done
        if wm_skipped:
            line += "；%d 张非横图规格（竖图/方图）保留原样" % len(wm_skipped)
        print(line)
    if not blocks:
        sys.exit("没有需要新增的图，未改动任何文件")

    if args.dry_run:
        print("dry-run：以上为计划，未写入任何文件")
        return

    new_count = count + len(blocks)
    out_text = insert_entries(src_text, blocks, hero_assets, new_count)
    with open(DATA_FILE, "w", encoding="utf-8", newline="") as fh:
        fh.write(out_text.replace("\n", nl))

    print("已登记 %d 张，素材总数 %d -> %d" % (len(blocks), count, new_count))
    print("新增素材体积 %.2f MB" % (total_bytes / 1024 / 1024))
    if hero_assets:
        print("备了大图（可上环幕）：%s" % "、".join(hero_assets))
    print("下一步：git add assets scripts && git commit -m \"feat(assets): 并入自备图片\"")


if __name__ == "__main__":
    main()
