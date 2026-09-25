# js 源（订阅入口）

TVBox / FongMi 的 **js 源**本体与订阅配置，和 `app/src/main/java/com/github/catvod/spider/Xl02.java`
（jar 源 `csp_Xl02`）是同一站点的两套等价实现。

| 源 | 站点 | 形态 | 取流 |
|---|---|---|---|
| `xl02.js` | 雪落影视 xl02.com.de | 自建站（HTML + 签名 + 载荷伪装） | 匿名可播（分片 CDN 校验 UA） |
| `cycani.js` | 次元城动画 cycani.org | React SPA + REST API（无混淆） | **需登录**（`/api/v2/sections/{id}/play-url` 要 Authorization） |
| `mgnacg.js` | 橘子动漫 mgnacg.com | MacCMS(苹果CMS) + Streamlab 模板 | 匿名可播（AES-128-CBC 解出直链） |
| `xifanacg.js` | 稀饭动漫 Next next.xifanacg.com | Next.js + Supabase（全走接口，不抠 HTML） | 匿名可播（Edge Function 签发 HLS） |
| `girigirilove.js` | girigiri愛動漫 ani.girigirilove.com | MacCMS(苹果CMS) + dsn2 模板 | 匿名可播（base64 解出 HLS 直链，带站内弹幕） |
| `4kcz.js` | 厂长资源 www.4kcz.com | WordPress + mibt 主题（HTML） | 匿名可播（**PNG 伪装分片**，走本地代理剥头） |

## 订阅地址（填播放器的「配置地址」）

```
# jsDelivr（国内一般最快）
https://cdn.jsdelivr.net/gh/wvv666/CatVodSpider@main/js/config.json

# GitHub 原始地址
https://raw.githubusercontent.com/wvv666/CatVodSpider/main/js/config.json

# 国内加速代理
https://gh-proxy.com/https://raw.githubusercontent.com/wvv666/CatVodSpider/main/js/config.json
```

`config.json` 里的 `api` 是相对路径（`./xl02.js`、`./cycani.js`），会跟随同一通道取源文件。

## cycani 需要账号（只影响播放）

该站点的播放接口必须登录，其它（分类 / 列表 / 搜索 / 详情 / 选集）匿名可用。

**订阅里已内置一个公用学习账号**（`ext` 里带 `username` / `password` / `token`），开箱即可播放；
想换成自己的号，改 `js/config.json` 里 `cycani` 那条的 `ext` 即可。源的处理逻辑：

- 有 `token` 就优先用令牌；被拒（401）时用 `username`/`password` 走 `/auth/login` 重新登录，
  并用 `/auth/refresh` 续期，令牌缓存进宿主存储
- 只给了 `token` 也没关系：过期后会自动降级成账号密码登录
- 什么都没给时浏览和搜索照常，点播放返回「未配置账号…」的提示而不是报错

```json
"ext": "{\"username\":\"你的账号\",\"password\":\"你的密码\",\"token\":\"Bearer eyJ...\"}"
```

> ⚠️ 内置账号是为学习交流公开的，**别把这个密码用在任何别的地方**；仓库公开意味着任何人都能用它。
> 想只留令牌的话，把 `password` 删掉即可（令牌 7 天有效，过期后需要重登）。

## 目录

| 文件 | 说明 |
|---|---|
| `xl02.js` / `cycani.js` | 两个源本体（自足，无外部依赖） |
| `config.json` | 订阅配置（xl02 + cycani + 上游内置的 Local/Market/Push + 两个直播） |
| `分析.md` | xl02 的完整逆向文档（签名算法、线路差异、伪装载荷、分片验证） |
| `tools/test_source.js` | xl02 的 Node 测试台（**29 项断言**，打真实站点） |
| `tools/test_cycani.js` | cycani 的 Node 测试台（**28 项断言**，打真实站点） |
| `tools/inflate.js` / `tools/test_inflate.js` | xl02 的内联解压件与对照测试 |
| `tools/复验分片.py` / `tools/poc_final.py` / `tools/逐线路验证.py` | xl02 的分片与线路验证 |
| `tools/debug_*.js` / `tools/diag_seg.js` / `tools/fetch_sample.py` | xl02 排查脚本；`fetch_sample.py` 生成 `sample_raw.bin`（未入库） |

脚本内部按 `__dirname` 找源文件，在哪个目录跑都行。

## 验证

```bash
node js/tools/test_source.js                        # xl02：29 项
node js/tools/test_cycani.js                        # cycani：28 项（匿名部分）
CYC_USER=账号 CYC_PASS=密码 node js/tools/test_cycani.js   # 额外验证取流
node js/tools/test_mgnacg.js                        # mgnacg：24 项（含 AES 解密 + 直链可播）
node js/tools/test_xifanacg.js                      # xifanacg：24 项（含 HLS 可播 + 弹幕）
node js/tools/test_girigirilove.js                  # girigirilove：40 项（含 base64 取流 + 分片 + 弹幕 xml）
node js/tools/test_4kcz.js                          # 4kcz：42 项（含 WAF 行为 + PNG 伪装探测 + 代理重写 + TS 校验）
python js/tools/复验分片.py                          # xl02 分片下载验证（用 Python 的 TLS 栈）
```

测试台用 `js/tools/host.js` 复刻宿主注入的 `req / md5X / aesX`（`aesX` 同时支持 ECB 与 CBC）。

## 已实现 / 已知限制

**xl02**
- 线路可切换：`高清(iplay)` / `备用(tos_hls3)` / `备用2(ac5634-us)` 暴露成多 `from`，`play(flag)` 按 flag 选线；
  站点实测失效的 `maliva` / `yvqzo4`（返回占位图）已过滤。
- `vod_play_url` 按宿主约定 `名称$地址`；顺序写反会让播放器拿「第1集」当地址去请求。
- 分片 CDN 校验 `User-Agent`，`play()` 会回传浏览器 UA，否则 403。
- 搜索不可用：站点搜索要图片算术验证码且绑 `JSESSIONID` 会话，源内无 OCR 过不去 → `searchable: 0`。

**cycani**
- 匿名即可搜索（`/videos/search?q=`，无验证码）、分类、详情、选集。
- 播放需要账号（见上）；`play()` 的取流字段按客户端源码复刻：`Authorization: Bearer <token>` +
  `X-App-Name: cyc_web` / `X-App-Version: cycweb` / `X-Time-Zone: Asia/Shanghai`（缺了会 400 `app_name is required`）。
- 分类覆盖：推荐（`/index/recommend`）、追番周表、排行（`/ranks`）、分区（`/video-zones`，带题材/年份筛选）。
- 站点目前每条番剧只有一个线路（`CYC_Main`），源按多线路实现，有第二条时会自动出现在线路切换里。

**mgnacg（橘子动漫）**
- MacCMS 站：列表/搜索走 `/index.php/ajax/data?mid=1&limit=&page=&tid=|wd=`（站点自带的 `/api.php/provide/vod/` 采集接口已关，返回 `closed`）。
- 分类：动漫(986 部)/剧场版(208 部)/4月新番/7月新番/10月新番；详情页只暴露站点标为可播的线路（读每条线路第一集的 `player_aaaa.from`，过滤 `ps=0` 的已下线线路）。
- 取流三步：播放页 `player_aaaa` → `playerconfig.js` 里该线路的解析前缀 → 解析页 `config.url` 用 **AES-128-CBC/Pkcs7** 解出 `.mknvideo` 直链
  （key/iv 由页面两个 `<meta id>` 派生：字母串按数字串升序重排 + 盐 `Mknacg123321` 做 MD5，再取十六进制前后 16 位，`vkey` 是幌子）。
- ⚠️ 直链会 302 到 `pan.wo.cn` 的 MP4，**播放时不能带 Referer**（带 Referer 返回 400，带 Origin 收到 CORS 403）→ `play()` 只回传 UA。
- 网页端没有弹幕（依据见 `弹幕接口.md`）。

**xifanacg（稀饭动漫 Next）**
- 全接口实现（Supabase PostgREST + Edge Function），不解析 HTML：分类 / 排序 / 筛选 / 搜索都是同一个 RPC `search_animes` 的不同参数。
- 分类的 `type_id` 形如 `list:{"sort_by":"updated_at"}` / `list:{"filter_format":"movie"}`，参数原样透传给 RPC（实测可用：`updated_at` / `view_count` / `bangumi_score` 三种排序，`filter_format` / `filter_is_finished` 筛选）。
- 取流 = Edge Function `issue-web-playback` 签发的 HLS 主播放列表（`#EXTM3U`，约 30 分钟有效）。
- 弹幕：把弹弹play 那一路按宿主 `Result.danmaku` 挂上（先 `sync-dandan-mapping` 拿弹弹剧集号），`count=0` 的集不挂；
  播放器不认弹弹play JSON 就设 `ext` = `{"danmaku":"0"}`。站内弹幕（`get_danmaku_page`）是 POST RPC，没法当弹幕文件 URL，只在 `弹幕接口.md` 里说明。

**girigirilove（girigiri愛動漫）**
- MacCMS 站，但 `/index.php/ajax/data` **不认 `tid` / `wd`**（传了也返回同一批默认列表），所以只用来做首页最新；
  分类必须走 HTML 分类页 `/show/{tid}-----------/page/{n}/`，每页 48 条。分类：日番(2) / 美番(3) / 劇場版(21) / 真人番劇(20) / BD副音軌(24)。
- ⚠️ `ajax/data` 的 `limit` 是白名单，**只认 10 / 20 / 30**，其它值（3/15/24/25/40/50…）会被打回 10。
- 搜索走 `/index.php/ajax/suggest?mid=1&limit=&wd=`（站点 HTML 搜索页要图片验证码，页面是「系统提示 / 提交验证」）；
  `suggest` 的 `limit` 可放大到 100+，返回条数即命中数，但字段少（只有 id/name/en/pic），没有状态和简介。
- 取流只要一步：播放页 `player_aaaa`（站内已把明文写进对象）→ `encrypt=2` 的解码是 **base64(percent 编码的 URL)**，
  两层解完就是 `akua.girigirilove.com/.../playlist.m3u8`。站点另有 atom.php 解析播放器，本源不用它（少一跳，直链更快）。
- ⚠️ 该 m3u8 **无 `EXT-X-KEY` 加密、无防盗链（不带 Referer 也 200）、CORS 全开**，分片实测 `video/mp2t` 1.4 MB 可下 → `play()` 回传直链、`parse=0`。
- 弹幕：每集一个静态 XML（B 站格式 `<d p="时间,模式,大小,颜色,时间戳,...,用户ID">`，单集约 1 MB），
  路径由 m3u8 直接推出：`.../cht/<目录>/01/playlist.m3u8` → `.../cht/<目录>/01.xml`（实测 4 部番全部命中）。
  **只有繁中线路有**（简中路径实测 404），所以源只在路径含 `/cht/` 时挂；不想挂就设 `ext` = `{"danmaku":"0"}`。
- ⚠️ 站点偶发返回空体（播放页约 1/10 概率），源内 `getRetry()` 自动重试；测试台里已加「第 2 页与第 1 页不同」等断言兜住这类抖动。

**4kcz（厂长资源）**
- ⚠️ **本站有 SafeLine（雷池）WAF，按 TLS 指纹拦截**：curl 一律 403（返回「Protected By 雷池 WAF」拦截页），
  Node / Python / Android okhttp 的 TLS 栈能过。实测 curl 加全套浏览器头 + HTTP/2 + Referer 都过不去，
  所以这不是 header 问题。**若某播放器的 JS 宿主 req() 是基于 curl 实现的，本源会被 WAF 挡**（FongMi 走 okhttp，正常）。
- 分类走 HTML：`/zuixindianying`(最新电影) / `dbtop250` / `dongmanjuchangban` / `gcj` / `meijutt` / `hanjutv` /
  `riju` / `fanju` / `haiwaijuqita`，分页 `/{slug}/page/{n}`，**每页 25 条**。
- ⚠️ 搜索路径对斜杠敏感：`/nimasile?q=` 会 468（触发 WAF 挑战），必须用 **`/nimasile/?q=`**。
- 详情 `/movie/{id}.html`；播放 `/v_play/{base64}.html`（解出形如 `mv_20294-nm_1`）。
  集名从 `.paly_list_btn` 里取（电影是 `1080P-1/1080P-2`，剧集是 `第1集…`）。
- 取流：播放页 → `<iframe class="viframe" src="...py.php?...&url=<真地址>">`。
  真地址两种：**明文 HLS**（`m3hlsm3.py1080p.com:907/hls3|7|8/…m3u8`，多数）和 **alist 加密 token**（少数）。
  本源只处理明文那种；遇到 alist 会返回明确提示而不是给个坏地址（源内无法解密 133 字符 token）。
- ⚠️⚠️ **分片是 PNG 伪装**：每个 `.ts` 分片套了一层 PNG 图片头，托管在第三方图床 CDN
  （`dc.xhscdn.com` 小红书 / `mmcomm.qpic.cn` 腾讯 / `picasso-static.xiaohongshu.com` / `file.icve.com.cn`）。
  **PNG 头长度因 CDN 而异且不固定**（实测 120 / 126 / 61 三种），所以源内不硬编码：
  用一次 `Range: bytes=0-4095` 取前 4KB 现场探测（优先 `IEND+8`，退路扫 188 字节对齐的 `0x47` TS sync）。
- **播放器会拒 PNG 分片**（实测 ffmpeg 报 `not in allowed_segment_extensions`，加 `?ext=.ts` 也会被内容嗅探挡下），
  所以必须走本地代理：play() 返回代理地址 → 代理返回重写过的 playlist（分片指向代理、去掉 `.png`）→
  播放器拉分片时代理用 `Range: bytes=<N>-` 向图床取，**图床支持 Range，直接回干净 TS**（206，无需自己剥字节）。
- ⚠️ 分片请求**绝不能带 Referer**（带 4kcz 的 Referer 图床返 403；站点自带播放器也是 `referrer: never`），代理内只发 UA。
- 代理返回格式按 FongMi `quickjs/crawler/Spider.proxy1()` 约定：
  `[status, contentType, body, headers, isBase64]` —— 第 5 位为 `1` 时宿主会 base64 解码后再交给播放器（二进制分片必须走这条）。
