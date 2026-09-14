# -*- coding: utf-8 -*-
"""截取前 N 段生成小播放列表，供 ffmpeg 快速解码验证"""
import os
HERE = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(HERE, "xl02_可播.m3u8")
dst = os.path.join(HERE, "xl02_测试6段.m3u8")
N = 6

lines = open(src, encoding="utf-8").read().splitlines()
head = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-TARGETDURATION:14"]
out, count = list(head), 0
i = 0
while i < len(lines) and count < N:
    if lines[i].startswith("#EXTINF"):
        out.append(lines[i])
        if i + 1 < len(lines) and lines[i + 1].strip():
            out.append(lines[i + 1].strip())
            count += 1
            i += 2
            continue
    i += 1
out.append("#EXT-X-ENDLIST")
open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
print(f"已写出 {dst}：{count} 段")
