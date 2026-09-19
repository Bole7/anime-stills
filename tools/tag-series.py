# -*- coding: utf-8 -*-
"""把「原图目录」的归属同步进素材清单。

早先并入的素材（例如最初那批 frame-*）在清单里没有分类信息，但它们本来
就是某个目录里的图。这个脚本按画面比对把它们认回去，给对应条目补上
series 字段 —— 页面的分类筛选这才装得下完整内容。

用法：
    python tools/tag-series.py "cs=D:/图片/cs" "wz=D:/图片/wz"

判定标准与入库脚本一致：缩到 64x64 灰度后平均像素差 < 10 视为同一张。
"""
import glob
import importlib.util
import os
import re
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    "addframes", os.path.join(ROOT, "tools", "add-frames.py"))
af = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(af)


def set_series(src, name, series):
    """给指定素材条目写入 series；已存在则先移除再写，保证可重复执行。"""
    src = re.sub(r'("name"\s*:\s*"%s"\s*,\s*\n\s*)"series"\s*:\s*"[^"]*"\s*,\s*\n'
                 % re.escape(name), r'\1', src)
    return re.sub(r'("name"\s*:\s*"%s"\s*,)' % re.escape(name),
                  lambda m: m.group(1) + '\n   "series": "%s",' % series,
                  src, count=1)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)

    groups = {}
    for arg in sys.argv[1:]:
        if "=" not in arg:
            sys.exit("参数要写成 名字=目录 的形式：%s" % arg)
        name, folder = arg.split("=", 1)
        prints = []
        for p in sorted(glob.glob(os.path.join(folder, "*"))):
            try:
                prints.append((os.path.basename(p), af.fingerprint(Image.open(p))))
            except Exception:
                pass
        groups[name] = prints
        print("%-4s %-40s %d 张" % (name, folder, len(prints)))

    src, nl = af.read_data()
    names = re.findall(r'"name"\s*:\s*"([^"]+)"', src)
    print("\n素材清单共 %d 条" % len(names))

    out, hits, misses = src, 0, []
    for name in names:
        path = os.path.join(af.ASSETS, "grid", name + ".webp")
        if not os.path.isfile(path):
            misses.append(name)
            continue
        fp = af.fingerprint(Image.open(path))
        best, bm = None, 999.0
        for series, prints in groups.items():
            for _fn, gp in prints:
                d = af.pixel_diff(fp, gp)
                if d < bm:
                    bm, best = d, series
        if bm < af.DUP_MAE:
            out = set_series(out, name, best)
            hits += 1
        else:
            misses.append(name)

    print("认回归属 %d 条；未匹配 %d 条：%s"
          % (hits, len(misses), "、".join(misses[:12]) if misses else "无"))

    with open(af.DATA_FILE, "w", encoding="utf-8", newline="") as fh:
        fh.write(out.replace("\n", nl))
    print("已写回 scripts/frames-data.js")


if __name__ == "__main__":
    main()
