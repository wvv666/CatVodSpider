# 雪落影视 js 源（订阅入口）

TVBox / FongMi 的 **js 源**本体与订阅配置，和 `app/src/main/java/com/github/catvod/spider/Xl02.java`
（jar 源 `csp_Xl02`）是同一站点 xl02.com.de 的两套等价实现，取流链路一致。

## 订阅地址（填播放器的「配置地址」）

```
# jsDelivr（国内一般最快）
https://cdn.jsdelivr.net/gh/wvv666/CatVodSpider@main/js/config.json

# GitHub 原始地址
https://raw.githubusercontent.com/wvv666/CatVodSpider/main/js/config.json

# 国内加速代理
https://gh-proxy.com/https://raw.githubusercontent.com/wvv666/CatVodSpider/main/js/config.json
```

`config.json` 里的 `api` 是相对路径 `./xl02.js`，会跟随同一个通道取源文件。

## 目录

| 文件 | 说明 |
|---|---|
| `xl02.js` | js 源本体（自足：内联 RFC1951 inflate，不用 pako/CryptoJS/pdfh） |
| `config.json` | 订阅配置（一个站点 `xl02`） |
| `分析.md` | 完整逆向文档：签名算法、线路差异、伪装载荷、分片验证 |
| `tools/test_source.js` | Node 测试台：模拟宿主跑真实站点，**29 项断言** |
| `tools/inflate.js` / `tools/test_inflate.js` | 解压件与对照测试（对比 Node zlib） |
| `tools/复验分片.py` / `tools/poc_final.py` / `tools/逐线路验证.py` | 分片与线路的 Python 复现验证 |
| `tools/debug_*.js` / `tools/diag_seg.js` / `tools/fetch_sample.py` | 排查用脚本；`fetch_sample.py` 生成 `sample_raw.bin`（未入库） |

## 验证

```bash
node js/tools/test_source.js       # 29 项断言，打真实站点
python js/tools/复验分片.py         # 分片下载验证（mingw 的 curl 对该 CDN 有 TLS 问题，用 Python 的栈）
```

脚本内部按 `__dirname` 找源文件，在哪个目录跑都行。

## 已实现 / 已知限制

- **线路可切换**：`高潔(iplay)` / `备用(tos_hls3)` / `备用2(ac5634-us)` 三条线路暴露成多 `from`，
  `play(flag)` 按 flag 里的 tag 选线；站点的 `maliva` / `yvqzo4` 实测返回占位图，已过滤。
- **`vod_play_url` 按宿主约定 `名称$地址`**：顺序写反会让播放器拿「第1集」当地址去请求。
- **分片 CDN 校验 User-Agent**：`play()` 必须回传浏览器 UA，否则分片 403。
- **搜索不可用**：站点搜索需图片算术验证码，且验证码图会下发 `JSESSIONID`（绑会话），源内无 OCR 过不去
  → `searchable: 0`；遇到验证码页返回空列表而不报错。

站点侧链路最近一次复验：2026-09-14（签名 `/lines` 200、播放列表 200 `image/png`、710 个 `#EXTINF`、
分片 200 `video/mp4` 首字节 `0x47`）。
