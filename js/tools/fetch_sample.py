# -*- coding: utf-8 -*-
"""抓一份真实的 m3u8 载荷（PNG伪装+gzip）存盘，供 JS inflate 做对照测试"""
import hashlib, json, time, urllib.parse, urllib.request, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from poc_final import get_lines, req, pick_line, SITE

lines = get_lines(202501)
tag, url = pick_line(lines)
u = url.replace("www.bde4.cc", "xl02.com.de")
st, raw, hdr = req(u)
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_raw.bin"), "wb").write(raw)
print(f"线路 #{tag}  HTTP {st}  落盘 {len(raw)} 字节 -> sample_raw.bin")
print("前 8 字节:", raw[:8].hex(), " | gzip 起点:", raw.find(b"\x1f\x8b"))
