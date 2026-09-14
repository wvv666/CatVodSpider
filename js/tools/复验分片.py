# -*- coding: utf-8 -*-
"""分片下载复验（用 Python 的 TLS 栈，跟跳转），确认 vod.xl01.me -> CDN 链路"""
import re, sys, os, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from poc_final import get_lines, req, pick_line, decrypt_m3u8, HLS_PREFIX, TS_HOST

lines = get_lines(202501)
tag, url = pick_line(lines)
pl = decrypt_m3u8(url)
host = TS_HOST + ("hls/" if tag in HLS_PREFIX else "")
out = re.sub(r"^(\S+\.ts)\s*$", lambda m: host + m.group(1), pl, flags=re.M)
segs = [l for l in out.splitlines() if l.startswith("http")]
print(f"线路 #{tag}  分片总数 {len(segs)}\n")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
for i in range(3):
    u = segs[i]
    for label, hdr in (("带 Referer", {"Referer": "https://xl02.com.de/", "User-Agent": UA}),
                       ("无 header ", {"User-Agent": UA})):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=hdr), timeout=25) as r:
                body = r.read()
                sync = body.count(bytes([0x47])) / max(len(body), 1)
                print(f"  #{i} {label}: HTTP {r.status} {len(body):>9d} 字节 "
                      f"type={str(r.headers.get('Content-Type'))[:24]:24s} 首字节={body[:1].hex()} "
                      f"0x47占比={sync:.4f} {'✓TS' if body[0]==0x47 else ''}")
        except urllib.error.HTTPError as e:
            print(f"  #{i} {label}: HTTP {e.code}")
        except Exception as e:
            print(f"  #{i} {label}: {str(e)[:70]}")
