# -*- coding: utf-8 -*-
"""
雪落影视 (xl02.com.de) 取流 PoC —— 已实测跑通到「明文 m3u8」

链路：
  1) GET  /lines?t=&sg=&pid=         -> 线路表（含 m3u8 地址）
  2) GET  https://站点域名/<HASH>.m3u8 -> 丢掉前 3354 字节 -> gzip 解压 -> 明文 playlist
  3) POST /god/{pid}?type=1          -> 备用线路：CDN 直链（约 27 秒时效）

签名算法（复刻 xlplayer.js 的 getUrl / $.get("/lines")）：
  t  = 毫秒时间戳（必须是 int，float 会被服务端判 400）
  key = md5("<pid>-<t>").substring(0,16) 的 UTF-8 字节（16 字节 = AES-128）
  sg  = AES-128-ECB(PKCS7("<pid>-<t>"), key) 的十六进制，转大写

依赖：pip install cryptography
用法：python poc_xl02.py
"""
import gzip
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import padding as pad
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

SITE = "https://xl02.com.de"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
REFERER = SITE + "/play/"
PNG_HEAD = 3354          # 载荷前面伪装成 PNG 的填充长度
TS_HOST = "https://vod.xl01.me/"   # 播放器把 .ts 重写到这里（见下文「未打通」）


# ---------------------------------------------------------------- 签名
def sign(pid: int, t: int) -> str:
    key = hashlib.md5(f"{pid}-{t}".encode()).hexdigest()[:16].encode()
    p = pad.PKCS7(128).padder()
    data = p.update(f"{pid}-{t}".encode()) + p.finalize()
    enc = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return (enc.update(data) + enc.finalize()).hex().upper()


# ---------------------------------------------------------------- HTTP
def http(url, data=None, referer=REFERER, timeout=20):
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
        headers["Origin"] = SITE
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
        headers["X-Requested-With"] = "XMLHttpRequest"
        data = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- 三个接口
def get_lines(pid: int) -> dict:
    """线路表：url3 / m3u8 / m3u8_2 / tos / ptoken"""
    t = int(time.time() * 1000)
    q = urllib.parse.urlencode({"t": t, "sg": sign(pid, t), "pid": pid})
    return json.loads(http(f"{SITE}/lines?{q}"))["data"]


def get_cdn_url(pid: int) -> str:
    """备用线路：POST /god/{pid}?type=1 —— 不需要验证码（带 ?type=1 就跳过校验）"""
    t = int(time.time() * 1000)
    body = http(f"{SITE}/god/{pid}?type=1", data={"t": t, "sg": sign(pid, t)})
    return json.loads(body)["url"]


def get_playlist(m3u8_url: str) -> str:
    """取 m3u8：裸地址在 www.bde4.cc，换成站点域名才能出数据"""
    url = m3u8_url.split(",")[0].partition("#")[0].replace("www.bde4.cc", "xl02.com.de")
    raw = http(url)
    return gzip.decompress(raw[PNG_HEAD:]).decode("utf-8", "replace")


def rewrite_ts(playlist: str, tagged: str = "") -> str:
    """按 xlplayer 的规则把切片重写成绝对地址"""
    host = TS_HOST + ("hls/" if ("4102-us" in tagged or "ac5634-us" in tagged) else "")
    return re.sub(r".*?\.ts", lambda m: host + m.group(0), playlist)


# ---------------------------------------------------------------- 主流程
if __name__ == "__main__":
    PID = 202501           # 播放页内联变量 var pid，来自 /play/{vod_id}-{line}.htm

    lines = get_lines(PID)
    print("线路表：", {k: str(v)[:80] for k, v in lines.items()})

    cdn = get_cdn_url(PID)
    print("\n备用线路 CDN 直链：", cdn[:110], "...")

    first = lines["m3u8"].split(",")[0]
    playlist = get_playlist(first)
    tag = first.partition("#")[2]
    print(f"\nm3u8 解出 {len(playlist)} 字符 / {playlist.count('#EXTINF')} 个切片（标记 #{tag}）")
    print("-" * 62)
    print(playlist[:420])
    print("-" * 62)
    print("\n重写后的前 3 个切片地址：")
    for line in rewrite_ts(playlist, tag).splitlines():
        if line.endswith(".ts"):
            print("  ", line)
            if line.count("") and playlist:
                pass
            break

    with open("xl02_playlist.m3u8", "w", encoding="utf-8") as f:
        f.write(playlist)
    print("\n明文 playlist 已写出：xl02_playlist.m3u8")
