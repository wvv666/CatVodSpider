package com.github.catvod.spider;

import com.google.gson.JsonObject;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import static com.github.catvod.spider.TestSupport.first;
import static com.github.catvod.spider.TestSupport.firstPlayUrl;
import static com.github.catvod.spider.TestSupport.nonEmptyArray;
import static com.github.catvod.spider.TestSupport.object;
import static com.github.catvod.spider.TestSupport.string;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class Xl02Test {

    private static final String TYPE_ID = "dongzuo";
    private static final String LINE_MAIN = "高清(iplay)";
    private static final String LINE_ALT = "备用2(ac5634-us)";
    private static final Xl02 spider = new Xl02();
    private static JsonObject category;
    private static JsonObject detail;

    @Test
    public void homeContent() {
        JsonObject result = object(spider.homeContent(false));
        assertTrue("Expected at least 5 classes", result.getAsJsonArray("class").size() >= 5);
    }

    @Test
    public void homeVideoContent() {
        nonEmptyArray(object(spider.homeVideoContent()), "list");
    }

    @Test
    public void categoryContent() {
        JsonObject result = category();
        nonEmptyArray(result, "list");
        assertEquals("Failed page number", 1, result.get("page").getAsInt());
    }

    @Test
    public void detailContent() {
        // 宿主约定为 名称$地址（Flag.setEpisodes: split("\\$", 2) -> Episode.create(name, url)）
        String playUrl = string(first(detail(), "list"), "vod_play_url");
        assertTrue("Missing play page: " + playUrl, playUrl.contains("$/"));
        // 多线路：按宿主顺序先 $$$ 分线路，再 # 分剧集
        String[] from = string(first(detail(), "list"), "vod_play_from").split("\\$\\$\\$");
        String[] urls = playUrl.split("\\$\\$\\$");
        assertTrue("Expected switchable lines: " + String.join(" | ", from), from.length >= 2);
        assertEquals("Line/episode group mismatch", from.length, urls.length);
        for (String group : urls) assertEquals("Episode groups differ per line", urls[0], group);
    }

    @Test
    public void playerContent() {
        JsonObject result = object(spider.playerContent(LINE_MAIN, firstPlayUrl(detail()), Collections.emptyList()));
        String url = string(result, "url");
        assertTrue("Expected local proxy url: " + url, url.contains("siteKey=") && url.contains("k=p"));
        assertTrue("Missing User-Agent (segment CDN rejects non-browser UA): " + string(result, "header"), string(result, "header").contains("User-Agent"));
    }

    @Test
    public void proxyContent() throws Exception {
        String playlist = playlist(LINE_MAIN);
        assertTrue("Not a playlist: " + playlist.substring(0, Math.min(32, playlist.length())), playlist.startsWith("#EXTM3U"));
        assertTrue("No #EXTINF entries", playlist.contains("#EXTINF"));
        assertTrue("Segments not absolute", playlist.contains("https://vod.xl01.me/"));
        assertTrue("No ts segment", playlist.contains(".ts"));
        assertFalse("iplay must not use the /hls/ prefix", playlist.contains("vod.xl01.me/hls/"));
    }

    @Test
    public void lineSwitch() throws Exception {
        // 选 ac5634-us 这条线路，分片应带 /hls/ 前缀 —— 证明 playerContent 真的按 flag 选线
        assertTrue("Expected /hls/ prefix on ac5634-us", playlist(LINE_ALT).contains("vod.xl01.me/hls/"));
    }

    @Test
    public void searchContent() {
        // 站点搜索需要图片验证码（且绑定 JSESSIONID 会话），源内无法绕过 —— 返回空列表，不报错
        assertTrue("Expected empty list: " + spider.searchContent("浪浪山", false), spider.searchContent("浪浪山", false).contains("\"list\":[]"));
    }

    private static String playlist(String flag) throws Exception {
        JsonObject result = object(spider.playerContent(flag, firstPlayUrl(detail()), Collections.emptyList()));
        Object[] proxy = spider.proxy(params(string(result, "url")));
        assertEquals("Unexpected proxy status", 200, proxy[0]);
        assertEquals("Unexpected content type", "application/vnd.apple.mpegurl", proxy[1]);
        return read((InputStream) proxy[2]);
    }

    private static JsonObject category() {
        if (category == null) category = object(spider.categoryContent(TYPE_ID, "1", false, new HashMap<>()));
        return category;
    }

    private static JsonObject detail() {
        if (detail == null) detail = object(spider.detailContent(Collections.singletonList(string(first(category(), "list"), "vod_id"))));
        return detail;
    }

    private static Map<String, String> params(String url) {
        Map<String, String> params = new HashMap<>();
        int index = url.indexOf('?');
        if (index < 0) return params;
        for (String item : url.substring(index + 1).split("&")) {
            int split = item.indexOf('=');
            if (split < 0) continue;
            params.put(item.substring(0, split), item.substring(split + 1));
        }
        return params;
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int len;
        while ((len = in.read(buffer)) > 0) out.write(buffer, 0, len);
        return out.toString("UTF-8");
    }
}
