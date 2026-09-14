# -*- coding: utf-8 -*-
"""
雪落影视 (xl02.com.de) —— 最终取流 PoC
端到端实测可用：线路探测 -> 签名 -> m3u8 解密 -> 分片重写 -> 验证分片可下载

用法: python poc_final.py [pid]
默认 pid=202501（播放页内联 var pid；/play/{vod_id}-{line}.htm）
"""
import gzip, hashlib, json, re, sys, time, urllib.error, urllib.parse, urllib.request
from cryptography.hazmat.primitives import padding as pad
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

SITE = "https://xl02.com.de"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
REF = SITE + "/play/"
PNG_HEAD = 3354                     # 载荷前的 PNG 伪装长度
TS_HOST = "https://vod.xl01.me/"
# 实测已失效的线路（分片返回占位图），优先排除
DEAD = ("maliva", "yvqzo4")
# 这些线路的分片要加 /hls/ 前缀
HLS_PREFIX = ("4102-us", "ac5634-us")
# 线路优先级（实测 iplay 就是播放器在用的那条）
PREFER = ("iplay", "tos_hls3", "ac5634-us")
P = lambda *a: print(*a, flush=True)


def sign(pid, t):
    """xlplayer.js: key=md5(pid-t)[:16]; AES-128-ECB(pid-t) -> 大写 hex"""
    key = hashlib.md5(f"{pid}-{t}".encode()).hexdigest()[:16].encode()
    p = pad.PKCS7(128).padder()
    d = p.update(f"{pid}-{t}".encode()) + p.finalize()
    e = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return (e.update(d) + e.finalize()).hex().upper()


def req(url, data=None, referer=REF, tmo=25, rng=None):
    h = {"User-Agent": UA, "Referer": referer, "Origin": SITE}
    if rng:
        h["Range"] = rng
    if data is not None:
        h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
        h["X-Requested-With"] = "XMLHttpRequest"
        data = urllib.parse.urlencode(data).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=tmo) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def get_lines(pid):
    t = int(time.time() * 1000)
    q = urllib.parse.urlencode({"t": t, "sg": sign(pid, t), "pid": pid})
    return json.loads(req(f"{SITE}/lines?{q}")[1])["data"]


def get_god(pid):
    """备用线路：带 ?type=1 跳过验证码，返回约 27 秒时效的 CDN 直链"""
    t = int(time.time() * 1000)
    return json.loads(req(f"{SITE}/god/{pid}?type=1", data={"t": t, "sg": sign(pid, t)})[1])["url"]


def decrypt_m3u8(u):
    """www.bde4.cc -> 站点域名；丢前 3354 字节 PNG 伪装；gunzip"""
    st, raw, _ = req(u.replace("www.bde4.cc", "xl02.com.de").replace("https://vod.xl01.me", SITE))
    if st != 200 or raw[:4] != b"\x89PNG":
        return None
    return gzip.decompress(raw[PNG_HEAD:]).decode("utf-8", "replace")


def pick_line(lines):
    """按 tag 挑一条能用的线路"""
    cands = []
    for key in ("m3u8_2", "m3u8"):
        for it in str(lines.get(key, "")).split(","):
            if not it.strip():
                continue
            u, _, tag = it.partition("#")
            if tag in DEAD:
                continue
            cands.append((tag, u.strip()))
    for want in PREFER:
        for tag, u in cands:
            if tag == want:
                return tag, u
    return (cands[0] if cands else (None, None))


if __name__ == "__main__":
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else 202501
    lines = get_lines(pid)
    P("线路键:", list(lines.keys()))
    for k, v in lines.items():
        P(f"  {k:8s} {str(v)[:96]}")

    try:
        P("\n备用直链 (?type=1):", get_god(pid)[:100])
    except Exception as e:
        P("\n备用直链失败:", str(e)[:60])

    tag, url = pick_line(lines)
    P(f"\n选中线路: #{tag}")
    pl = decrypt_m3u8(url)
    if not pl:
        raise SystemExit("这条线路解不出来，换一条")

    n = pl.count("#EXTINF")
    first = re.search(r"^(\S+\.ts)\s*$", pl, re.M).group(1)
    P(f"解密成功: {len(pl)} 字符 / {n} 段")
    P(f"首个分片: {first[:80]}...")

    host = TS_HOST + ("hls/" if tag in HLS_PREFIX else "")
    out = re.sub(r"^(\S+\.ts)\s*$", lambda m: host + m.group(1), pl, flags=re.M)

    P(f"\n--- 验证分片（{host}）---")
    st, body, hdr = req(host + first)
    sync = body.count(bytes([0x47])) / max(len(body), 1)
    P(f"  HTTP {st}  {len(body)} 字节  type={hdr.get('Content-Type')}")
    P(f"  前 12 字节: {body[:12].hex()}   TS 同步字节 0x47 占比: {sync:.3f}")
    P(f"  {'✓ 是真实 TS 流' if sync > 0.001 else '✗ 疑似占位数据'}")

    with open("xl02_可播.m3u8", "w", encoding="utf-8") as f:
        f.write(out)
    P(f"\n已写出重写后的播放列表: xl02_可播.m3u8（{n} 段，地址已绝对化）")
