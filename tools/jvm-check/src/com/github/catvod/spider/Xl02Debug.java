package com.github.catvod.spider;

import com.github.catvod.net.OkHttp;

import java.util.HashMap;
import java.util.Map;

/** 打印某条播放页的原始 /lines 响应，用来确认线路 URL 的真实形态。 */
public class Xl02Debug {

    private static final String SITE = "https://xl02.com.de";

    public static void main(String[] args) throws Exception {
        String playUrl = args.length > 0 ? args[0] : "/play/27093-0.htm";
        Map<String, String> header = new HashMap<>();
        header.put("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
        header.put("Referer", SITE + "/");

        String page = OkHttp.string(SITE + playUrl, header);
        String pid = page.replaceAll("(?s).*?var\\s+pid\\s*=\\s*(\\d+).*", "$1");
        System.out.println("playUrl = " + playUrl);
        System.out.println("page.length = " + page.length() + ", pid = " + pid);

        long t = System.currentTimeMillis();
        String sg = Xl02.sign(pid, t);
        String lines = OkHttp.string(SITE + "/lines?t=" + t + "&sg=" + sg + "&pid=" + pid, header);
        System.out.println("---- /lines (" + lines.length() + " chars) ----");
        System.out.println(lines);
    }
}
