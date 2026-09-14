# jvm-check —— Xl02 的桌面验证台

Android 工程不适合快速迭代源逻辑：一次改动要走 Gradle + R8 + apktool，还要装 Android SDK。
这个目录用**一组 android 框架桩**把仓库里的真实源码编译到桌面 JVM，直接打真实站点，秒级验证。

```bash
./tools/jvm-check/run.sh                            # 14 项断言
./tools/jvm-check/run.sh debug /play/27093-0.htm    # 打印原始 /lines 响应
```

需要 JDK 17+ 与 curl（首次运行会从 Maven Central 拉 jsoup/gson/okhttp/okio/org.json）。

## 覆盖什么

| 断言 | 说明 |
|---|---|
| 签名 | `sign(204736, 1789365531044)` 必须逐字节等于浏览器内 CryptoJS 现场算出的 `sg` |
| homeContent / homeVideoContent | 分类数 ≥ 5、首页列表非空 |
| categoryContent | 列表非空、第 2 页与第 1 页不同（分页真的在翻） |
| detailContent | 剧集详情能解析出多集播放列表 |
| playerContent | 返回本地代理地址（`siteKey` + `k=`）并回传浏览器 UA |
| proxy | 200 + `application/vnd.apple.mpegurl`，正文以 `#EXTM3U` 开头、`#EXTINF` > 100、分片已绝对化 |
| 分片 | 带浏览器 UA 拉首片：200、首字节 `0x47`（TS）；不带 UA 则 403 |
| searchContent | 站点需验证码，返回空列表而不报错 |

## 说明

- `stubs/` 只放 Xl02 编译路径上真正用到的 android 类（`TextUtils` 是可用实现，`Log` 打到 stdout，其余是签名壳）。
- `PLAY` 用的 video id 是从 `dongzuo` 分类首页动态取的，站点更新不会让它失效。
- 站点有频控（短时间大量请求会 429），用例之间留了间隔，别把并发拉起来。
- `Xl02Debug` 用来排查：打印某条播放页的 pid 与原始 `/lines` 返回。

验证记录（2026-09-14，真实站点）：

```
PASS  sign(204736,1789365531044) == 浏览器实测值   [985A2F48…F663A8D4]
PASS  homeContent 分类数 >= 5   [45 个分类]
PASS  homeVideoContent 列表非空   [147 条]
PASS  categoryContent(dongzuo,1) 列表非空   [24 条]
PASS  分页第 2 页与第 1 页不同   [/meiju/27093.htm vs /jingsong/27009.htm]
PASS  剧集详情有播放列表   [四手联弹，两首奏鸣曲 / 2 集]
PASS  playerContent 返回本地代理地址   [http://127.0.0.1:0/proxy?do=csp&siteKey=xl02&k=p204641_…]
PASS  playerContent 回传浏览器 UA   [{User-Agent: …Chrome/140…}]
PASS  proxy 状态 200 / mpegurl   [200 application/vnd.apple.mpegurl]
PASS  播放列表以 #EXTM3U 开头   [#EXTM3U #EXT-X-VERSION:3]
PASS  分片数 > 100   [278 个 #EXTINF]
PASS  分片已绝对化到 vod.xl01.me   [https://vod.xl01.me/D4A0581D…]
PASS  分片(浏览器 UA) 200 且首字节 0x47   [200 5767276 B, video/mp4;charset=UTF-8, f2.iplay.126.net]
INFO  不带 UA 取分片 -> HTTP 403
PASS  searchContent 返回空列表不报错   [{"list":[],"parse":0,"jx":0}]
结果: 14 通过 / 0 失败
```

注：`127.0.0.1:0` 是独立运行时的兜底地址（`Proxy.getPort()` 读的是宿主进程的 `com.github.catvod.Proxy`，真机上会给出真实端口）。
