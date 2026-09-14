# -*- coding: utf-8 -*-
"""逐条线路解密，找出哪条的分片能真正拉到视频数据"""
import gzip, hashlib, json, re, time, urllib.error, urllib.parse, urllib.request, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cryptography.hazmat.primitives import padding as pad
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

PID, SITE = 202501, "https://xl02.com.de"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
P = lambda *a: print(*a, flush=True)


def sign(pid, t):
    key = hashlib.md5(f"{pid}-{t}".encode()).hexdigest()[:16].encode()
    p = pad.PKCS7(128).padder()
    d = p.update(f"{pid}-{t}".encode()) + p.finalize()
    e = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return (e.update(d) + e.finalize()).hex().upper()


def req(url, referer=SITE + "/play/", tmo=20, rng=None):
    h = {"User-Agent": UA, "Referer": referer, "Origin": SITE}
    if rng:
        h["Range"] = rng
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=tmo) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300], dict(e.headers)
    except Exception as e:
        return -1, str(e)[:80].encode(), {}


def playlist_of(u):
    """把 .m3u8 线路解成明文"""
    u = u.replace("www.bde4.cc", "xl02.com.de").replace("https://vod.xl01.me", SITE)
    st, raw, hdr = req(u)
    if st != 200:
        return f"HTTP {st}", None
    if raw[:4] == b"\x89PNG":
        try:
            return "ok", gzip.decompress(raw[3354:]).decode("utf-8", "replace")
        except Exception as e:
            return f"解压失败 {str(e)[:40]}", None
    return "非伪装载荷", raw[:200].decode("utf-8", "replace")


t = int(time.time() * 1000)
q = urllib.parse.urlencode({"t": t, "sg": sign(PID, t), "pid": PID})
st, body, _ = req(f"{SITE}/lines?{q}", referer=SITE + "/play/")
data = json.loads(body)["data"]

lines = []
for key in ("m3u8", "m3u8_2", "url3"):
    for it in str(data.get(key, "")).split(","):
        if it.strip():
            u, _, tag = it.partition("#")
            lines.append((key, tag, u.strip()))

P(f"共 {len(lines)} 条线路\n" + "=" * 74)
for key, tag, u in lines:
    P(f"\n[{key}] tag={tag or '-'}")
    P(f"  url: {u[:105]}")
    if ".m3u8" not in u and "bde4" not in u:
        P("  跳过（非 m3u8 形态，属 TikTok CDN 直链分支）")
        continue
    status, txt = playlist_of(u)
    if txt is None:
        P(f"  → {status}")
        continue
    seg = re.search(r"^(\S+\.ts)\s*$", txt, re.M)
    P(f"  → 解出 {len(txt)} 字符 / {txt.count('#EXTINF')} 段")
    P(f"  首个分片行: {seg.group(1)[:120] if seg else '无'}")
    if not seg:
        continue
    name = seg.group(1)
    host = "https://vod.xl01.me/" + ("hls/" if ("4102-us" in tag or "ac5634-us" in tag) else "")
    st2, b2, h2 = req(host + name, rng="bytes=0-4095")
    kind = "PNG占位" if b2[:4] == b"\x89PNG" else ("视频数据" if b2[:8].hex().startswith("0000001") or b2[:4] in (b"moof", b"ftyp") else b2[:12].hex())
    P(f"  取分片 HTTP {st2}  type={str(h2.get('Content-Type'))[:26]}  len={len(b2)}  {kind}")
