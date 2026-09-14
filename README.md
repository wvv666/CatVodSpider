# CatVodSpider

### Based on CatVod

https://github.com/CatVodTVOfficial/CatVodTVSpider

---

## 自建源

| 类 | api | 站点 | 说明 |
|---|---|---|---|
| `Xl02` | `csp_Xl02` | xl02.com.de（雪落影视） | 签名 + PNG/gzip 载荷伪装 + 本地代理回传播放列表；搜索不可用（站点需图片验证码） |

用法（播放器配置里加站点，jar 指向本仓库构建出的 `custom_spider.jar`）：

```json
{
  "key": "xl02",
  "name": "雪落影视",
  "type": 3,
  "api": "csp_Xl02",
  "searchable": 0,
  "quickSearch": 0,
  "changeable": 0,
  "timeout": 60
}
```

### Xl02 取流链路

```
/play/{id}-{line}.htm          var pid
  → sg = AES-128-ECB(md5(pid-t) 前 16 位作密钥, pid-t).hex.upper()   // t 必须是整数毫秒
  → GET /lines?t=&sg=&pid=      线路表 {url3, m3u8, m3u8_2, tos, ptoken}
  → 选线：站点播放器里的 CDN 线路（iplay / tos_hls3 / ac5634-us）暴露成多 from，
    播放器切线路时 flag 带 tag → 按 flag 选；缺失则 iplay → tos_hls3 → ac5634-us 回退；
    跳过失效的 maliva / yvqzo4
  → GET 线路 url（前 3354 字节是 PNG 伪装）→ 丢头 → gunzip → 明文 playlist
  → 分片重写为 https://vod.xl01.me/[hls/]<name>.ts（ac5634-us / 4102-us 要加 /hls/）
  → 经本地代理（Proxy.getUrl + siteKey 路由）把 playlist 交给播放器
```

两点实测得到的必要处理：

- **分片 CDN 校验 User-Agent**：`play()` 必须回传浏览器 UA，否则播放器拉分片被 403
- **播放页路径有两种**：电影 `/play/{id}-{n}.htm`，剧集 `/{分类}/play/{id}-{n}.htm`，所以详情页解析出的 href 要原样使用

与同站 js 源 `wvv666/tvbox/xl02.js` 等价；站点侧链路于 2026-09-14 在真实站点复验（签名 `/lines` 200、播放列表 200 `image/png` 75,789 B、解出 710 个 `#EXTINF`、分片 200 `video/mp4` 3,429,496 B 首字节 `47`）。搜索需图片算术验证码且绑 `JSESSIONID` 会话，源内无法绕过（`searchable: 0`）。

### 构建

```bash
build.bat                 # gradlew spiderJar → jar/custom_spider.jar + .md5（Windows）
./gradlew spiderJar       # 同上（Linux/macOS，会跳过 PowerShell 校验步骤）
```

### 验证（不需要 Android SDK）

```bash
./tools/jvm-check/run.sh   # android 桩 + 真实源码编译到桌面 JVM，打真实站点跑 14 项断言
```

CI：`.github/workflows/spider.yml` 已在本地备好（push 后自动构建并上传 jar 产物），
但 GitHub 的 OAuth token 需要 `workflow` 权限才能推送该文件（本机 gh token 只有 `gist` / `read:org` / `repo`）。
