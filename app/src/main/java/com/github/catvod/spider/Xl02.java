package com.github.catvod.spider;

import android.text.TextUtils;

import com.github.catvod.bean.Class;
import com.github.catvod.bean.Result;
import com.github.catvod.bean.Vod;
import com.github.catvod.crawler.Spider;
import com.github.catvod.crawler.SpiderDebug;
import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.Util;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.GZIPInputStream;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * 雪落影视 xl02.com.de —— TVBox / FongMi 影视源（csp_Xl02）
 * <p>
 * 与同站 js 源（wvv666/tvbox 的 xl02.js）等价的 Java 实现，取流链路：
 * /play/{id}-{line}.htm -> var pid -> sg = AES-128-ECB(md5(pid-t)[:16], pid-t).hex.upper()
 * -> GET /lines -> 选线（跳过失效的 maliva / yvqzo4）
 * -> GET 线路 url（前 3354 字节是 PNG 伪装）-> 丢头 -> gunzip -> 明文 playlist
 * -> 分片重写为 https://vod.xl01.me/[hls/]<name>.ts -> 经本地代理回传给播放器
 * <p>
 * 实测（2026-09-14 于真实站点）：
 * - 首页 147 张卡片、分类页 24 张/页
 * - /lines 返回 {url3, m3u8, m3u8_2, tos, ptoken}，m3u8_2 内含 ac5634-us / iplay / yvqzo4
 * - 播放列表 HTTP 200 image/png、75,789 B、头 8 字节 89 50 4e 47 0d 0a 1a 0a -> PNG + gzip
 * - 解出 710 个 #EXTINF；分片 200 video/mp4、3,429,496 B、首字节 47（TS）、302 到 f2.iplay.126.net
 * <p>
 * 已知限制：站点搜索需图片验证码（30 分钟一次），源内无法绕过 -> searchable: 0
 */
public class Xl02 extends Spider {

    private static final String SITE = "https://xl02.com.de";
    private static final String FAKE_HOST = "www.bde4.cc";
    private static final String TS_HOST = "https://vod.xl01.me/";
    private static final int FAKE_HEAD = 3354;                          // 载荷前的 PNG 伪装长度
    private static final List<String> DEAD = Arrays.asList("maliva", "yvqzo4");
    private static final List<String> PREFER = Arrays.asList("iplay", "tos_hls3", "ac5634-us");
    private static final List<String> HLS_PREFIX = Arrays.asList("4102-us", "ac5634-us");

    /** 暴露给播放器做「切换线路」的线路表：{tag, 显示名}，tag 同时用于 play(flag) 识别用户选的那条 */
    private static final String[][] LINES = {
            {"iplay", "高清(iplay)"},
            {"tos_hls3", "备用(tos_hls3)"},
            {"ac5634-us", "备用2(ac5634-us)"}
    };

    private static final Map<String, String> CACHE = new ConcurrentHashMap<>();
    private static final int CACHE_MAX = 8;

    private static volatile String homeHtml = "";
    private static volatile long homeTime = 0L;

    private static volatile OkHttpClient local;

    @Override
    public String homeContent(boolean filter) {
        return Result.string(parseClasses(), parseVods(home()));
    }

    @Override
    public String homeVideoContent() {
        return Result.string(parseVods(home()));
    }

    @Override
    public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) {
        int page = parseInt(pg);
        return Result.get().vod(parseVods(OkHttp.string(categoryUrl(tid, page), headers()))).page(page, PAGE_COUNT, PAGE_LIMIT, PAGE_TOTAL).string();
    }

    @Override
    public String detailContent(List<String> ids) throws Exception {
        String id = ids.get(0);
        Document doc = Jsoup.parse(OkHttp.string(fullUrl(id), headers()));
        Vod vod = new Vod();
        vod.setVodId(id);
        vod.setVodName(text(doc.selectFirst("h1.movie-title")).replaceAll("\\s*\\(\\d{4}\\)\\s*$", ""));
        Element img = doc.selectFirst("div.movie-info img");
        if (img == null) img = doc.selectFirst("img[src^=\"https://wework.qpic.cn\"]");
        vod.setVodPic(img == null ? "" : img.attr("data-src").isEmpty() ? img.attr("src") : img.attr("data-src"));
        vod.setVodContent(text(doc.selectFirst("div.desc")));
        vod.setVodRemarks(text(doc.selectFirst("h2")));
        // 播放页路径两形态都出现：电影 /play/{id}-{n}.htm，剧集 /{分类}/play/{id}-{n}.htm —— 直接沿用 href
        List<String> plays = new ArrayList<>();
        for (Element a : doc.select("a.play-item")) {
            String href = a.attr("href").trim();
            if (href.isEmpty()) continue;
            plays.add(a.text().trim() + "$" + href);
        }
        // 站点的线路（CDN 维度）暴露成 TVBox 的多 from -> 播放器里能切换线路；
        // 每条线路下重复同一套剧集，播放时按 flag 里的 tag 选线（缺失则回退到优先顺序）
        List<String> from = new ArrayList<>();
        List<String> urls = new ArrayList<>();
        for (String[] line : LINES) {
            from.add(line[1]);
            urls.add(TextUtils.join("#", plays));
        }
        vod.setVodPlayFrom(TextUtils.join("$$$", from));
        vod.setVodPlayUrl(TextUtils.join("$$$", urls));
        return Result.string(vod);
    }

    @Override
    public String playerContent(String flag, String id, List<String> vipFlags) {
        try {
            String page = OkHttp.string(fullUrl(id), headers());
            String pid = match(page, "var\\s+pid\\s*=\\s*(\\d+)");
            if (pid.isEmpty()) return Result.error("未取到 pid");

            long t = System.currentTimeMillis();
            String body = OkHttp.string(SITE + "/lines?t=" + t + "&sg=" + sign(pid, t) + "&pid=" + pid, headers());
            JsonObject data = data(body);
            String[] line = pickLine(data, tagOf(flag));
            if (line == null) return Result.error("线路表为空");

            String playlist = decryptPlaylist(line[0]);
            if (playlist.isEmpty()) return Result.error("播放列表解密失败");

            String key = "p" + pid + "_" + t;
            put(key, rewriteSegments(playlist, line[1]));

            // 分片 CDN 校验 User-Agent（ffmpeg 默认 UA 会被 403），必须交给播放器带去
            Map<String, String> header = new HashMap<>();
            header.put("User-Agent", UA);
            return Result.get().url(proxyUrl("&k=" + key)).header(header).string();
        } catch (Throwable e) {
            SpiderDebug.log(e);
            return Result.error(e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    @Override
    public String searchContent(String key, boolean quick) {
        // 站点搜索需图片验证码（30 分钟一次），源内无法绕过
        return Result.get().vod(new ArrayList<>()).string();
    }

    @Override
    public Object[] proxy(Map<String, String> params) {
        String key = params == null ? null : params.get("k");
        String body = key == null ? null : CACHE.get(key);
        byte[] bytes = (body == null ? "not found" : body).getBytes(StandardCharsets.UTF_8);
        return new Object[]{body == null ? 404 : 200, body == null ? "text/plain; charset=utf-8" : "application/vnd.apple.mpegurl", new ByteArrayInputStream(bytes)};
    }

    /* ============================ 页面解析 ============================ */

    private List<Class> parseClasses() {
        List<Class> classes = new ArrayList<>();
        try {
            for (Element a : Jsoup.parse(home()).select("a[href^=\"/s/\"]")) {
                String href = a.attr("href").trim();
                String name = a.text().trim();
                if (href.isEmpty() || name.isEmpty() || name.contains("更多")) continue;
                Class item = new Class(href.substring(3), name);
                if (!classes.contains(item)) classes.add(item);
            }
        } catch (Throwable e) {
            SpiderDebug.log(e);
        }
        if (classes.size() < 5) {
            classes.clear();
            for (String[] item : FALLBACK) classes.add(new Class(item[0], item[1]));
        }
        return classes;
    }

    private List<Vod> parseVods(String html) {
        List<Vod> list = new ArrayList<>();
        for (Element card : Jsoup.parse(html).select("div.movie-card")) {
            Element a = card.selectFirst("a[href]");
            if (a == null) continue;
            String href = a.attr("href").trim();
            if (href.isEmpty()) continue;
            Element h4 = card.selectFirst("h4");
            Element img = card.selectFirst("img");
            String pic = img == null ? "" : img.attr("data-src").isEmpty() ? img.attr("src") : img.attr("data-src");
            String remark = text(card.selectFirst("div.card-meta span"));
            if (remark.isEmpty()) remark = text(card.selectFirst("div.rating-badge"));
            list.add(new Vod(href, h4 == null ? a.attr("title").trim() : h4.text().trim(), pic, remark));
        }
        return list;
    }

    private String home() {
        long now = System.currentTimeMillis();
        if (homeHtml.isEmpty() || now - homeTime > CACHE_TTL) {
            homeHtml = OkHttp.string(SITE + "/", headers());
            homeTime = now;
        }
        return homeHtml;
    }

    private String categoryUrl(String tid, int page) {
        int query = tid.indexOf('?');
        String path = query >= 0 ? tid.substring(0, query) : tid;
        String suffix = query >= 0 ? "?" + tid.substring(query + 1) : "";
        return SITE + "/s/" + path + (page > 1 ? "/" + page : "") + suffix;
    }

    /* ============================ 取流链路 ============================ */

    /** sg = AES-128-ECB(md5(pid-t) 前 16 位作密钥, pid-t).hex 大写；t 必须是整数毫秒，浮点会被服务端 400 */
    static String sign(String pid, long t) throws Exception {
        String plain = pid + "-" + t;
        String key = md5(plain).substring(0, 16);
        Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"));
        StringBuilder sb = new StringBuilder();
        for (byte b : cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8))) sb.append(String.format(Locale.ROOT, "%02X", b));
        return sb.toString();
    }

    private String decryptPlaylist(String lineUrl) {
        String url = lineUrl.trim().replace(FAKE_HOST, "xl02.com.de").replace("https://vod.xl01.me", SITE);
        byte[] data = bytes(url, headers());
        if (data == null) return "";
        int offset = gzipOffset(data);
        if (offset < 0) {
            SpiderDebug.log("未找到 gzip 载荷, length=" + data.length + ", head=" + head(data));
            return "";
        }
        return gunzip(data, offset);
    }

    private String rewriteSegments(String playlist, String tag) {
        String base = TS_HOST + (HLS_PREFIX.contains(tag) ? "hls/" : "");
        List<String> out = new ArrayList<>();
        for (String raw : playlist.split("\n")) {
            String line = raw.replace("\r", "").trim();
            out.add(!line.isEmpty() && !line.startsWith("#") && line.endsWith(".ts") ? base + line : line);
        }
        return TextUtils.join("\n", out);
    }

    private String proxyUrl(String param) {
        String base = "";
        try {
            base = Proxy.getUrl();
        } catch (Throwable e) {
            SpiderDebug.log(e);
        }
        String query = "do=csp&siteKey=" + (siteKey == null ? "" : siteKey) + param;
        if (base == null || base.isEmpty()) return "proxy://" + query;
        return base + (base.contains("?") ? "&" : "?") + query;
    }

    /** 选线：播放器指定的线路优先，其次按 PREFER 顺序，最后取第一条；失效线路（返回占位图）跳过 */
    private static String[] pickLine(JsonObject data, String wanted) {
        List<String[]> candidates = new ArrayList<>();
        for (String group : new String[]{"m3u8_2", "m3u8"}) {
            String raw = json(data, group);
            for (String item : raw.split(",")) {
                int index = item.indexOf('#');
                String url = (index >= 0 ? item.substring(0, index) : item).trim();
                String tag = index >= 0 ? item.substring(index + 1).trim() : "";
                if (!url.startsWith("http") || DEAD.contains(tag)) continue;
                candidates.add(new String[]{url, tag});
            }
        }
        if (wanted != null && !wanted.isEmpty()) for (String[] candidate : candidates) if (wanted.equals(candidate[1])) return candidate;
        for (String prefer : PREFER) for (String[] candidate : candidates) if (prefer.equals(candidate[1])) return candidate;
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    /** 从播放器传回的 flag（即 vod_play_from 的显示名）里认出线路 tag */
    private static String tagOf(String flag) {
        for (String[] line : LINES) if (flag != null && flag.contains(line[0])) return line[0];
        return "";
    }

    private static JsonObject data(String body) {
        try {
            JsonObject object = JsonParser.parseString(body).getAsJsonObject().getAsJsonObject("data");
            return object == null ? new JsonObject() : object;
        } catch (Throwable e) {
            return new JsonObject();
        }
    }

    private static String json(JsonObject object, String key) {
        try {
            return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : "";
        } catch (Throwable e) {
            return "";
        }
    }

    /* ============================ 工具 ============================ */

    private static Map<String, String> headers() {
        Map<String, String> header = new HashMap<>();
        header.put("User-Agent", UA);
        header.put("Referer", SITE + "/");
        return header;
    }

    private static String fullUrl(String url) {
        return url.startsWith("http") ? url : SITE + url;
    }

    private static String text(Element element) {
        return element == null ? "" : element.text().trim();
    }

    private static int parseInt(String text) {
        try {
            return Math.max(1, Integer.parseInt(text.trim()));
        } catch (Throwable e) {
            return 1;
        }
    }

    private static String match(String text, String regex) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(regex).matcher(text == null ? "" : text);
        return matcher.find() ? matcher.group(1) : "";
    }

    private static String md5(String text) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("MD5");
        StringBuilder sb = new StringBuilder();
        for (byte b : digest.digest(text.getBytes(StandardCharsets.UTF_8))) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    /** PNG 伪装 + gzip：定位 gzip 魔数，找不到返回 -1 */
    private static int gzipOffset(byte[] data) {
        if (data.length > FAKE_HEAD + 2 && data[FAKE_HEAD] == 0x1f && data[FAKE_HEAD + 1] == (byte) 0x8b) return FAKE_HEAD;
        if (data.length > 2 && data[0] == 0x1f && data[1] == (byte) 0x8b) return 0;
        if (data.length > 2 && data[0] == 0x78) return 0;
        int limit = Math.min(data.length - 1, 65536);
        for (int i = 0; i < limit; i++) if (data[i] == 0x1f && data[i + 1] == (byte) 0x8b) return i;
        return -1;
    }

    private static String gunzip(byte[] data, int offset) {
        try (InputStream in = data[offset] == 0x78
                ? new InflaterInputStream(new ByteArrayInputStream(data, offset, data.length - offset), new Inflater())
                : new GZIPInputStream(new ByteArrayInputStream(data, offset, data.length - offset))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Throwable e) {
            SpiderDebug.log(e);
            return "";
        }
    }

    private static String head(byte[] data) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(8, data.length); i++) sb.append(String.format(Locale.ROOT, "%02x ", data[i]));
        return sb.toString().trim();
    }

    private static void put(String key, String value) {
        if (CACHE.size() >= CACHE_MAX) for (String item : CACHE.keySet()) {
            CACHE.remove(item);
            break;
        }
        CACHE.put(key, value);
    }

    private static byte[] bytes(String url, Map<String, String> header) {
        try {
            OkHttpClient client = Spider.client();
            if (client == null) client = local();
            Request.Builder builder = new Request.Builder().url(url);
            for (Map.Entry<String, String> entry : header.entrySet()) builder.header(entry.getKey(), entry.getValue());
            try (Response response = client.newCall(builder.build()).execute()) {
                if (!response.isSuccessful() || response.body() == null) {
                    SpiderDebug.log("HTTP " + response.code() + " " + url);
                    return null;
                }
                return response.body().bytes();
            }
        } catch (Throwable e) {
            SpiderDebug.log(e);
            return null;
        }
    }

    /** 宿主会通过 Spider.client() 提供带 DoH / 信任全部证书的客户端；独立运行时兜底自建一个 */
    private static OkHttpClient local() {
        if (local != null) return local;
        return local = new OkHttpClient.Builder().connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS).readTimeout(30, java.util.concurrent.TimeUnit.SECONDS).hostnameVerifier((hostname, session) -> true).sslSocketFactory(sslContext().getSocketFactory(), trustAll()).build();
    }

    private static SSLContext sslContext() {
        try {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[]{trustAll()}, new SecureRandom());
            return context;
        } catch (Throwable e) {
            throw new RuntimeException(e);
        }
    }

    private static X509TrustManager trustAll() {
        return new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
    }

    /* ============================ 常量 ============================ */

    private static final String UA = Util.CHROME;
    private static final int PAGE_LIMIT = 24;
    private static final int PAGE_COUNT = 999;
    private static final int PAGE_TOTAL = 9999;
    private static final long CACHE_TTL = 60 * 1000L;

    /** 站点导航兜底（首页解析失败时使用，2026-09-14 实测 45 个分类） */
    private static final String[][] FALLBACK = {
            {"all?type=0", "电影"}, {"all?type=1", "剧集"}, {"dongzuo", "动作"}, {"aiqing", "爱情"}, {"xiju", "喜剧"},
            {"kehuan", "科幻"}, {"kongbu", "恐怖"}, {"zhanzheng", "战争"}, {"wuxia", "武侠"}, {"mohuan", "魔幻"},
            {"juqing", "剧情"}, {"donghua", "动画"}, {"jingsong", "惊悚"}, {"3D", "3D"}, {"zainan", "灾难"},
            {"xuanyi", "悬疑"}, {"jingfei", "警匪"}, {"wenyi", "文艺"}, {"qingchun", "青春"}, {"maoxian", "冒险"},
            {"fanzui", "犯罪"}, {"jilu", "纪录"}, {"guzhuang", "古装"}, {"qihuan", "奇幻"}, {"guoyu", "国语"},
            {"zongyi", "综艺"}, {"lishi", "历史"}, {"yundong", "运动"}, {"yuanchuang", "原创压制"}, {"meiju", "美剧"},
            {"hanju", "韩剧"}, {"guoju", "国产电视剧"}, {"riju", "日剧"}, {"yingju", "英剧"}, {"deju", "德剧"},
            {"eju", "俄剧"}, {"baju", "巴剧"}, {"jiaju", "加剧"}, {"spanish", "西剧"}, {"yidaliju", "意大利剧"},
            {"taiju", "泰剧"}, {"gangtaiju", "港台剧"}, {"faju", "法剧"}, {"aoju", "澳剧"}, {"duanju", "短剧"}
    };
}
