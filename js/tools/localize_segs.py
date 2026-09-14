# -*- coding: utf-8 -*-
"""把前 3 段下载到本地，生成纯本地 m3u8，供 ffmpeg 做完整解码验证"""
import urllib.request, re, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
d = os.path.join(HERE, "segs")
os.makedirs(d, exist_ok=True)

lines = open(os.path.join(HERE, "xl02_可播.m3u8"), encoding="utf-8").read().splitlines()
head = [l for l in lines if l.startswith("#EXTM3U") or l.startswith("#EXT-X-VERSION")
        or l.startswith("#EXT-X-TARGETDURATION")]
out = list(head)
n = 0
i = 0
while i < len(lines) and n < 3:
    if lines[i].startswith("#EXTINF"):
        dur = lines[i]
        url = lines[i + 1].strip()
        fname = f"seg{n}.ts"
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://xl02.com.de/"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        open(os.path.join(d, fname), "wb").write(data)
        print(f"  seg{n}: {len(data):>9d} 字节  首字节={data[:1].hex()}  {dur}")
        out += [dur, fname]
        n += 1
        i += 2
    else:
        i += 1
out.append("#EXT-X-ENDLIST")
p = os.path.join(d, "local.m3u8")
open(p, "w", encoding="utf-8").write("\n".join(out) + "\n")
print("\n本地播放列表:", p)
