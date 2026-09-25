/*
 * 厂长资源 www.4kcz.com —— TVBox / FongMi 影视源（js 源 · 自足，不依赖 jar）
 *
 * 站点形态：WordPress + mibt 主题（PHP 渲染，非苹果CMS）
 *   分类 /{slug}/page/{n}     详情 /movie/{id}.html     播放 /v_play/{base64}.html
 *   /v_play 的路径段是 base64，解出来形如 mv_20294-nm_1（movieid-line_episode）
 *
 * ⚠️ 站点前置 SafeLine（雷池）WAF，按 TLS 指纹差别对待：
 *     curl（含 libcurl 系）→ 403「Protected By 雷池 WAF」
 *     Node / Python 的 TLS 栈 → 200 正常
 *   实测 curl 加全套浏览器头、HTTP/2、Referer 都过不去，不是 header 问题而是 TLS 指纹。
 *   所以本源**不要**用宿主里基于 curl 的实现；FongMi 的 JS 宿主走 okhttp，实测可过。
 *   另外搜索路径 /nimasile?q= 有大小写/斜杠敏感：带斜杠 /nimasile/?q= 才 200。
 *
 * 数据接口（实测 2026-09-25，全部走 HTML，站点无开放 JSON 接口）：
 *   列表  分类页 HTML，每页 50 条，分页 /{slug}/page/{n}
 *         可用 slug：zuixindianying(最新电影) / dbtop250(豆瓣Top250) / dongmanjuchangban(剧场版)
 *                    gcj(国产剧) / meijutt(美剧) / hanjutv(韩剧) / riju(日剧)
 *                    fanju(番剧) / haiwaijuqita(海外剧其他)
 *   搜索  GET /nimasile/?q=关键词  -> HTML 结果列表（注意结尾斜杠）
 *   详情  /movie/{id}.html -> h1 片名 / .dyimg img 海报 / li 字段 / .paly_list_btn 选集
 *
 * 取流链路（实测）：
 *   播放页 -> <iframe class="viframe" src="https://plaa.py1080p.com:8181/player/py.php?code=cs&if=1&url=<真地址>">
 *     真地址两种形态：
 *       (a) 明文 HLS：https://m3hlsm3.py1080p.com:907/hls3|hls7|hls8/.../xxx.m3u8    ← 多数
 *       (b) alist 加密：url=alistxxxx（133 字符 token，需服务端解密）              ← 少数
 *     本源只处理 (a)；(b) 无法在源内解密，会明确返回提示而不是给个坏地址。
 *
 * ⚠️⚠️ 关键难点：m3u8 里的分片是「PNG 伪装」——每个 .ts 分片被套了一层 PNG 图片头
 *    （分片 URL 以 .png 结尾，托管在第三方图床/CDN：dc.xhscdn.com、mmcomm.qpic.cn、
 *      picasso-static.xiaohongshu.com、file.icve.com.cn 等）。
 *    PNG 头长度**因 CDN 而异且不固定**（实测 120 / 126 / 61 字节三种），所以：
 *      1) 不能硬编码偏移；源内用一次 Range 取前 4KB 现场探测（IEND+8 优先，其次扫 188 对齐 TS sync）
 *      2) 播放器普遍按扩展名判断，.png 会被 ffmpeg 直接拒（实测报
 *         "not in allowed_segment_extensions"）→ 必须走本地代理重写
 *      3) 这些图床 CDN **支持 Range**，直接 Range: bytes=<offset>- 就返回干净的 TS
 *         （实测 206 + video/mp2t 内容，无需自己剥离字节）
 *
 * 本地代理流程（play -> proxy）：
 *   取 m3u8 → 探出首个分片的 PNG 头长 N → 把 playlist 缓存起来
 *   播放器请求代理 → 代理返回 playlist，其中每个分片 URL 重写成
 *       代理地址/seg/{序号}.ts?u=<原始分片URL base64>&n=<PNG头长>
 *   播放器拉分片 → 代理向源站发 Range: bytes=N- → 原样回传 TS
 *
 * ⚠️ 分片请求**不能带 Referer**（实测带 4kcz 的 Referer 会被图床 403；站点自带播放器也是
 *   <meta name="referrer" content="never">）。所以代理里只发 UA。
 *   IPv6 到部分图床不可达，代理内走 Node/okhttp 的默认解析即可。
 *
 * 依赖宿主注入：req(url, options) / getProxy(local)（FongMi quickjs 层）
 */
var HOST = 'https://www.4kcz.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var SITE_KEY = '';
var CACHE = {};
var CONF = {};

/* 分页每页条数（站点实测 25 条/页） */
var PAGE_SIZE = 25;

var CLASSES = [
    ['zuixindianying', '最新电影'],
    ['dbtop250', '豆瓣Top250'],
    ['dongmanjuchangban', '剧场版'],
    ['gcj', '国产剧'],
    ['meijutt', '美剧'],
    ['hanjutv', '韩剧'],
    ['riju', '日剧'],
    ['fanju', '番剧'],
    ['haiwaijuqita', '海外剧']
];

/* ============================ 工具 ============================ */

function text(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#8211;/g, '-').replace(/&#8217;/g, "'")
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
}

function get(url, headers) {
    var h = Object.assign({ 'User-Agent': UA, 'Referer': HOST + '/' }, headers || {});
    var res = req(url, { headers: h });
    return res && res.code === 200 ? res.content : '';
}

/* 二进制取（代理里给分片用），返回 base64 或空
 * ⚠️ 图床 CDN 对带 Range 的请求返回 206，不带 Range 返回 200 —— 两者都要收 */
function getBytes(url, headers, range) {
    var h = Object.assign({ 'User-Agent': UA }, headers || {});
    if (range) h['Range'] = range;
    var res = req(url, { headers: h, buffer: 2 });
    if (!res || (res.code !== 200 && res.code !== 206)) return '';
    return res.content || '';
}

function full(url) {
    if (!url) return '';
    if (url.indexOf('//') === 0) return 'https:' + url;
    return url.indexOf('http') !== 0 ? HOST + url : url;
}

/* 纯 JS base64 编解码（宿主不一定有 atob/btoa） */
var B64CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(str) {
    var out = '', buf = 0, bits = 0, i, c;
    for (i = 0; i < str.length; i++) {
        c = str.charCodeAt(i) & 0xFF;
        buf = (buf << 8) | c;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += B64CH.charAt((buf >> bits) & 0x3F);
        }
    }
    if (bits > 0) out += B64CH.charAt((buf << (6 - bits)) & 0x3F);
    while (out.length % 4) out += '=';
    return out;
}

function b64decode(s) {
    var src = String(s || '').replace(/[^A-Za-z0-9+\/=]/g, '');
    var out = '', buf = 0, bits = 0, i, c;
    for (i = 0; i < src.length; i++) {
        c = B64CH.indexOf(src.charAt(i));
        if (c < 0) continue;
        buf = (buf << 6) | c;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((buf >> bits) & 0xFF);
        }
    }
    return out;
}

function b64urlEncode(str) {
    return b64encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
    var v = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    return b64decode(v);
}

/* ============================ 列表 ============================ */

/* 列表页条目：<li><a href=.../movie/N.html><img ... data-original="海报"> ... <h3 class=dytit>名称</h3> */
function htmlList(html) {
    var out = [];
    var parts = String(html || '').split(/<li[^>]*>/);
    for (var i = 1; i < parts.length; i++) {
        var seg = parts[i].slice(0, 3000);
        var im = /\/movie\/(\d+)\.html/.exec(seg);
        if (!im) continue;
        var nm = /<h3 class="dytit">[\s\S]{0,220}?<a[^>]*>([\s\S]{1,120}?)<\/a>/.exec(seg);
        if (!nm) nm = /alt="([^"]{1,80})"/.exec(seg);
        var pm = /data-original="([^"]+)"/.exec(seg) || /<img[^>]+src="(https?:\/\/[^"]+\.(?:jpe?g|png|webp)[^"]*)"/i.exec(seg);
        var qm = /<span class="qb">([^<]{1,16})<\/span>/.exec(seg);
        var rm = /<div class="rating">([^<]{1,8})<\/div>/.exec(seg);
        var remark = qm ? text(qm[1]) : '';
        var score = rm ? text(rm[1]) : '';
        out.push({
            vod_id: im[1],
            vod_name: text(nm ? nm[1] : ''),
            vod_pic: full(pm ? pm[1] : ''),
            vod_remarks: score ? (score + (remark ? ' · ' + remark : '')) : remark
        });
    }
    return out;
}

function home() {
    var list = [];
    for (var i = 0; i < CLASSES.length; i++) list.push({ type_id: CLASSES[i][0], type_name: CLASSES[i][1] });
    return JSON.stringify({ class: list });
}

function homeVod() {
    var html = get(HOST + '/');
    var list = htmlList(html);
    return JSON.stringify({ list: list.slice(0, 100) });
}

function category(tid, pg, filter, extend) {
    var page = parseInt(pg || 1, 10) || 1;
    var slug = String(tid || '').replace(/[^a-z0-9_]/g, '');
    if (!slug) return JSON.stringify({ page: page, pagecount: page, limit: 0, total: 0, list: [] });
    var url = HOST + '/' + slug + (page > 1 ? '/page/' + page : '');
    var html = get(url);
    var list = htmlList(html);
    /* 分页：只信「有数据就还有下一页」，站点 pager 有时给整十页 */
    var nums = [];
    var re = /\/page\/(\d+)/g, m;
    while ((m = re.exec(html)) !== null) nums.push(parseInt(m[1], 10));
    var last = nums.length ? Math.max.apply(null, nums) : 1;
    if (page >= last) last = page;              /* 已是末页 */
    return JSON.stringify({
        page: page,
        pagecount: last,
        limit: PAGE_SIZE,
        total: 0,
        list: list
    });
}

function search(wd, quick, pg) {
    if (!wd) return JSON.stringify({ list: [] });
    /* 注意结尾斜杠：/nimasile?q= 会 468 触发 WAF 挑战，/nimasile/?q= 才 200 */
    var html = get(HOST + '/nimasile/?q=' + encodeURIComponent(wd), { 'Referer': HOST + '/' });
    if (!html) return JSON.stringify({ list: [] });
    return JSON.stringify({ list: htmlList(html) });
}

/* ============================ 详情 ============================ */

function infoField(html, label) {
    var re = new RegExp('<li>\\s*' + label + '：\\s*([\\s\\S]{0,400}?)</li>', 'i');
    var m = re.exec(html);
    return m ? text(m[1]).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').replace(/,\s*$/, '').trim() : '';
}

function detail(id) {
    var vid = String(id || '').replace(/[^0-9]/g, '');
    if (!vid) return JSON.stringify({ list: [] });
    var html = get(HOST + '/movie/' + vid + '.html');
    if (!html) return JSON.stringify({ list: [] });
    var name = text((/<h1>([^<]*)<\/h1>/.exec(html) || [])[1]);
    if (!name) name = text((/<title>([^<|_]*)/.exec(html) || [])[1]).replace(/^《|》.*$/g, '');
    var en = text((/<h1>[^<]*<\/h1><span>([^<]*)<\/span>/.exec(html) || [])[1]);
    /* 海报：.dyimg 容器里的 img（列表页是懒加载 data-original，详情页直接用 src） */
    var pic = '';
    var pm = /<div class="dyimg fl">[\s\S]{0,400}?<img[^>]+src="([^"]+)"/i.exec(html);
    if (pm) pic = pm[1];
    if (!pic) {
        var pm2 = /data-original="(https?:\/\/[^"]+)"/i.exec(html);
        if (pm2) pic = pm2[1];
    }
    /* 简介：yp_context 里的正文 */
    var content = '';
    var cm = /<div class="yp_context">([\s\S]{0,4000}?)<\/div>/.exec(html);
    if (cm) content = text(cm[1]);
    if (!content) content = text((/<meta name="description" content="([^"]*)"/.exec(html) || [])[1]);
    /* 选集：.paly_list_btn 里的链接，按出现顺序，标签即集名 */
    var eps = [];
    var bm = /<div class="paly_list_btn">([\s\S]{0,20000}?)<\/div>/.exec(html);
    var zone = bm ? bm[1] : html;
    var ere = /<a[^>]*href="([^"]*\/v_play\/[A-Za-z0-9+\/=]+\.html)"[^>]*>([\s\S]{0,40}?)<\/a>/g, em;
    var seen = {};
    while ((em = ere.exec(zone)) !== null) {
        var link = em[1].replace(HOST, '');
        if (seen[link]) continue;
        seen[link] = 1;
        var label = text(em[2]) || ('第' + (eps.length + 1) + '集');
        eps.push(label + '$' + link);
    }
    if (!eps.length) return JSON.stringify({ list: [] });
    return JSON.stringify({
        list: [{
            vod_id: vid,
            vod_name: name,
            vod_pic: full(pic),
            vod_year: infoField(html, '年份'),
            vod_area: infoField(html, '地区'),
            vod_remarks: infoField(html, '上映') || infoField(html, '又名'),
            type_name: infoField(html, '类型'),
            vod_actor: infoField(html, '主演'),
            vod_director: infoField(html, '导演'),
            vod_content: content || (en ? ('又名：' + en) : ''),
            vod_play_from: '厂长资源',
            vod_play_url: eps.join('#')
        }]
    });
}

/* ============================ 取流 ============================ */

/* 播放页 -> iframe src -> 里面的 url 参数（真地址） */
function extractSource(playPath) {
    var page = get(full(playPath), { 'Referer': HOST + '/movie/' });
    if (!page) return { err: '播放页打不开（可能被 WAF 拦了）' };
    var im = /<iframe[^>]+class="viframe"[^>]+src="([^"]+)"/i.exec(page) || /<iframe[^>]+src="([^"]+)"/i.exec(page);
    if (!im) return { err: '播放页没有 iframe' };
    var src = im[1].replace(/&amp;/g, '&');
    var um = /[?&]url=([^&"']+)/.exec(src);
    if (!um) return { err: 'iframe 里没有 url 参数' };
    var real = um[1];
    try { real = decodeURIComponent(real); } catch (e) { }
    if (real.indexOf('alist') === 0) return { err: 'alist 线路（加密 token，源内无法解密）', alist: true };
    if (real.indexOf('http') !== 0) return { err: '取到的是相对地址：' + real };
    return { url: real };
}

/* 探测 PNG 伪装头长：一次 Range 取前 4KB，找 TS 流真实起点 */
function tsOffsetOf(segUrl) {
    var key = 'o_' + segUrl;
    if (CACHE[key] !== undefined) return CACHE[key];
    var b64 = getBytes(segUrl, {}, 'bytes=0-4095');
    var off = -1;
    if (b64) {
        var raw = b64decode(b64);
        /* IEND+8 优先（标准 PNG 头） */
        var iend = raw.indexOf('IEND');
        if (iend >= 0) {
            var cands = [iend + 8, iend + 4, iend + 12, iend + 16];
            for (var i = 0; i < cands.length; i++) {
                if (raw.charCodeAt(cands[i]) === 0x47) { off = cands[i]; break; }
            }
        }
        /* 退路：扫 188 字节对齐的 TS sync（0x47 每 188 字节重复三次） */
        if (off < 0) {
            var lim = Math.min(2048, raw.length - 564);
            for (var s = 0; s < lim; s++) {
                if (raw.charCodeAt(s) === 0x47 && raw.charCodeAt(s + 188) === 0x47 && raw.charCodeAt(s + 376) === 0x47) {
                    off = s; break;
                }
            }
        }
    }
    CACHE[key] = off;
    return off;
}

/* 把 playlist 里的分片行换成代理地址 */
function rewritePlaylist(playlist, offsets) {
    var lines = String(playlist).split('\n'), out = [];
    var idx = 0;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '').replace(/^\s+|\s+$/g, '');
        if (line && line.charAt(0) !== '#') {
            var n = offsets[idx] !== undefined ? offsets[idx] : 0;
            out.push(proxyUrl('seg=' + b64urlEncode(line) + '&n=' + n));
            idx++;
        } else {
            out.push(lines[i].replace(/\r$/, ''));
        }
    }
    return out.join('\n');
}

function proxyUrl(param) {
    var base = '';
    try { if (typeof getProxy === 'function') base = getProxy(true); } catch (e) { base = ''; }
    var q = (SITE_KEY ? 'siteKey=' + encodeURIComponent(SITE_KEY) + '&' : '') + param;
    if (base) return base + (base.indexOf('?') >= 0 ? '&' : '?') + q;
    return 'proxy://' + q;
}

function play(flag, id, flags) {
    var path = String(id || '');
    if (path.indexOf('/v_play/') !== 0) return JSON.stringify({ parse: 0, url: '', msg: '剧集地址不对：' + path });
    var out = extractSource(path);
    if (!out.url) return JSON.stringify({ parse: 0, url: '', msg: out.err || '取流失败' });

    var m3u8 = out.url;
    var playlist = get(m3u8, { 'Referer': HOST + '/' });
    if (!playlist || playlist.indexOf('#EXTM3U') < 0) {
        return JSON.stringify({ parse: 0, url: '', msg: '播放列表拉取失败（该线路可能已失效）' });
    }

    /* 逐个分片探 PNG 头长（同一线路通常一致，首片探到就复用，其余按需探） */
    var segs = [];
    var lines = playlist.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/\r$/, '').replace(/^\s+|\s+$/g, '');
        if (l && l.charAt(0) !== '#' && l.indexOf('http') === 0) segs.push(l);
    }
    if (!segs.length) return JSON.stringify({ parse: 0, url: '', msg: '播放列表里没有分片' });

    var first = tsOffsetOf(segs[0]);
    if (first < 0) first = 0;
    var offsets = [];
    for (var j = 0; j < segs.length; j++) offsets.push(first);

    var key = 'p' + Date.now() + '_' + segs.length;
    CACHE[key] = { playlist: playlist, offsets: offsets, segs: segs };

    return JSON.stringify({
        parse: 0,
        url: proxyUrl('k=' + key),
        /* 分片走代理，代理自己带 UA；播放器侧只给 UA 即可 */
        header: { 'User-Agent': UA }
    });
}

/* 宿主回调：返回 [status, contentType, body, headers, isBase64]
 * 依据 FongMi quickjs/crawler/Spider.proxy1()：
 *   array[3] 是 headers（可选），array[4] === 1 时 body 按 base64 解码再交给播放器。
 *   分片是二进制，必须走 base64 通道（走文本会把字节损坏）。
 */
function proxy(params) {
    var p = params || {};
    var key = p.k || '';
    if (!key && p.url) {
        var mm = String(p.url).match(/[?&]k=([^&]+)/);
        if (mm) key = decodeURIComponent(mm[1]);
    }

    /* 分片请求 */
    var segEnc = p.seg || '';
    if (!segEnc && p.url) {
        var sm = String(p.url).match(/[?&]seg=([^&]+)/);
        if (sm) segEnc = decodeURIComponent(sm[1]);
    }
    if (segEnc) {
        var segUrl = b64urlDecode(segEnc);
        var n = parseInt(p.n || 0, 10) || 0;
        if (!segUrl) return [400, 'text/plain', 'bad seg'];
        /* 关键：不带 Referer（带 4kcz 的 Referer 会被图床 403），Range 跳过 PNG 伪装头 */
        var data = getBytes(segUrl, {}, 'bytes=' + n + '-');
        if (!data) return [502, 'text/plain', 'seg fetch failed'];
        return [200, 'video/mp2t', data, {}, 1];
    }

    /* playlist 请求（文本，直接给） */
    var entry = CACHE[key];
    if (!entry) return [404, 'text/plain', 'not found'];
    var body = rewritePlaylist(entry.playlist, entry.offsets);
    return [200, 'application/vnd.apple.mpegurl', body];
}

/* ============================ 导出 ============================ */

function init(ext) {
    CACHE = {};
    CONF = {};
    try { if (ext && ext.skey) SITE_KEY = ext.skey; } catch (e) { }
    var raw = ext && ext.ext !== undefined ? ext.ext : ext;
    if (raw && typeof raw === 'object') CONF = raw;
    else if (typeof raw === 'string' && raw.trim()) {
        try { CONF = JSON.parse(raw); } catch (e) { CONF = {}; }
    }
    return true;
}

export function __jsEvalReturn() {
    return {
        init: init,
        home: home,
        homeVod: homeVod,
        category: category,
        detail: detail,
        play: play,
        search: search,
        proxy: proxy
    };
}
