package com.github.catvod.spider;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/** 在桌面 JVM 上跑 Xl02 的真实链路（android 框架用桩），用来验证源码逻辑与线上站点。 */
public class Xl02Harness {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Xl02 spider = new Xl02();
        spider.siteKey = "xl02";

        // 1. 签名必须与浏览器内 CryptoJS 现场算出的值逐字节一致
        String sg = Xl02.sign("204736", 1789365531044L);
        check("sign(204736,1789365531044) == 浏览器实测值", "985A2F48DFC371BA8A29DA9A04D3AACD7A623069811ACF992526D6C6F663A8D4".equals(sg), sg);

        // 2. 首页
        JsonObject home = json(spider.homeContent(false));
        int classes = home.has("class") ? home.getAsJsonArray("class").size() : 0;
        check("homeContent 分类数 >= 5", classes >= 5, classes + " 个分类");
        JsonObject video = json(spider.homeVideoContent());
        int vods = video.has("list") ? video.getAsJsonArray("list").size() : 0;
        check("homeVideoContent 列表非空", vods > 0, vods + " 条");

        // 3. 分类 + 分页
        JsonObject category = json(spider.categoryContent("dongzuo", "1", false, new HashMap<>()));
        JsonArray list = category.getAsJsonArray("list");
        check("categoryContent(dongzuo,1) 列表非空", list != null && list.size() > 0, (list == null ? 0 : list.size()) + " 条");
        JsonObject p2 = json(spider.categoryContent("dongzuo", "2", false, new HashMap<>()));
        String id1 = list.get(0).getAsJsonObject().get("vod_id").getAsString();
        String id2 = p2.getAsJsonArray("list").get(0).getAsJsonObject().get("vod_id").getAsString();
        check("分页第 2 页与第 1 页不同", !id1.equals(id2), id1 + " vs " + id2);

        // 4. 详情（剧集：验证 /{分类}/play/ 形态）
        Thread.sleep(1200);
        String tvId = json(spider.categoryContent("hanju", "1", false, new HashMap<>())).getAsJsonArray("list").get(0).getAsJsonObject().get("vod_id").getAsString();
        JsonObject tv = json(spider.detailContent(Collections.singletonList(tvId)));
        JsonObject tvVod = tv.getAsJsonArray("list").get(0).getAsJsonObject();
        String tvPlay = tvVod.get("vod_play_url").getAsString();
        check("剧集详情有播放列表", tvPlay.contains("$") && tvPlay.contains(".htm"), tvVod.get("vod_name").getAsString() + " / " + tvPlay.split("#").length + " 集");

        // 5. 取流（选一部电影，走完整签名/线路/解密/代理链路）
        JsonObject detail = json(spider.detailContent(Collections.singletonList(id1)));
        String playUrl = firstPlayUrl(detail.getAsJsonArray("list").get(0).getAsJsonObject().get("vod_play_url").getAsString());
        String body = spider.playerContent("雪落影视", playUrl, Collections.emptyList());
        System.out.println("[DEBUG] playUrl=" + playUrl);
        System.out.println("[DEBUG] playerContent => " + body);
        JsonObject player = json(body);
        String url = player.has("url") ? player.get("url").getAsString() : "";
        String header = player.has("header") ? player.get("header").getAsString() : "";
        check("playerContent 返回本地代理地址", url.contains("siteKey=xl02") && url.contains("k=p"), url);
        check("playerContent 回传浏览器 UA", header.contains("User-Agent") && header.contains("Chrome"), header);

        // 6. 代理回传的播放列表
        Map<String, String> params = new HashMap<>();
        for (String item : url.substring(url.indexOf('?') + 1).split("&")) {
            int i = item.indexOf('=');
            if (i > 0) params.put(item.substring(0, i), item.substring(i + 1));
        }
        Object[] proxy = spider.proxy(params);
        String playlist = read((InputStream) proxy[2]);
        int extinf = playlist.split("#EXTINF").length - 1;
        check("proxy 状态 200 / mpegurl", Integer.valueOf(200).equals(proxy[0]) && "application/vnd.apple.mpegurl".equals(proxy[1]), proxy[0] + " " + proxy[1]);
        check("播放列表以 #EXTM3U 开头", playlist.startsWith("#EXTM3U"), playlist.substring(0, Math.min(24, playlist.length())));
        check("分片数 > 100", extinf > 100, extinf + " 个 #EXTINF");
        String segment = null;
        for (String line : playlist.split("\n")) if (line.startsWith("https://")) { segment = line; break; }
        check("分片已绝对化到 vod.xl01.me", segment != null && segment.startsWith("https://vod.xl01.me/"), segment == null ? "null" : segment.substring(0, 60) + "...");

        // 7. 分片级验证：带浏览器 UA 拉真实分片，首字节必须是 TS 同步字节 0x47
        String browserUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
        okhttp3.OkHttpClient client = new okhttp3.OkHttpClient();
        okhttp3.Response withUa = client.newCall(new okhttp3.Request.Builder().url(segment).header("User-Agent", browserUa).build()).execute();
        byte[] segmentBytes = withUa.body() == null ? new byte[0] : withUa.body().bytes();
        check("分片(浏览器 UA) 200 且首字节 0x47", withUa.isSuccessful() && segmentBytes.length > 1000 && (segmentBytes[0] & 0xFF) == 0x47, withUa.code() + " " + segmentBytes.length + " B, 首字节 0x" + Integer.toHexString(segmentBytes.length > 0 ? segmentBytes[0] & 0xFF : 0) + ", Content-Type " + withUa.header("Content-Type") + ", 请求主机 " + withUa.request().url().host());
        okhttp3.Response bare = client.newCall(new okhttp3.Request.Builder().url(segment).build()).execute();
        System.out.println("INFO  不带 UA 取分片 -> HTTP " + bare.code() + "（站点对 UA 有校验，故 play() 必须回传浏览器 UA）");

        // 8. 搜索优雅降级
        String search = spider.searchContent("浪浪山", false);
        check("searchContent 返回空列表不报错", search.contains("\"list\":[]"), search);

        System.out.println();
        System.out.println("结果: " + pass + " 通过 / " + fail + " 失败");
        if (fail > 0) System.exit(1);
    }

    private static void check(String name, boolean ok, Object detail) {
        System.out.println((ok ? "PASS  " : "FAIL  ") + name + "   [" + detail + "]");
        if (ok) pass++;
        else fail++;
    }

    private static JsonObject json(String body) {
        return JsonParser.parseString(body).getAsJsonObject();
    }

    private static String firstPlayUrl(String playUrl) {
        String episode = playUrl.split("\\$\\$\\$", 2)[0].split("#", 2)[0];
        return episode.substring(episode.indexOf('$') + 1);
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int len;
        while ((len = in.read(buffer)) > 0) out.write(buffer, 0, len);
        return out.toString("UTF-8");
    }
}
