# js 源（订阅入口）

TVBox / FongMi 的 **js 源**本体与订阅配置，和 `app/src/main/java/com/github/catvod/spider/Xl02.java`
（jar 源 `csp_Xl02`）是同一站点的两套等价实现。

| 源 | 站点 | 形态 | 取流 |
|---|---|---|---|
| `xl02.js` | 雪落影视 xl02.com.de | 自建站（HTML + 签名 + 载荷伪装） | 匿名可播（分片 CDN 校验 UA） |
| `cycani.js` | 次元城动画 cycani.org | React SPA + REST API（无混淆） | **需登录**（`/api/v2/sections/{id}/play-url` 要 Authorization） |

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
python js/tools/复验分片.py                          # xl02 分片下载验证（用 Python 的 TLS 栈）
```

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
