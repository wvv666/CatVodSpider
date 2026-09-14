/*
 * 雪落影视 xl02.com.de —— TVBox / FongMi 影视源（js 源）
 *
 * 依赖宿主注入（FongMi/TV quickjs 层，均已确认存在）：
 *   req(url, options)   -> {code, headers, content}；options.buffer: 0=文本 2=base64
 *   md5X(text)          -> 小写 hex md5
 *   aesX(mode, encrypt, input, inBase64, key, iv, outBase64)
 *   getProxy(local)     -> 本地代理地址
 *
 * 取流链路（实测）：
 *   /play/{vod}-{line}.htm -> pid -> 签名 -> GET /lines -> 选线路
 *   -> GET m3u8（前 3354 字节为 PNG 伪装）-> 丢头 -> gunzip -> 明文 playlist
 *   -> 分片重写为 https://vod.xl01.me/[hls/]<name>.ts（无需鉴权）
 *
 * 已知限制：搜索需图片验证码（30 分钟一次），源内无法绕过，search 会返回空结果。
 */
var HOST = 'https://xl02.com.de';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var FAKE_HEAD = 3354;                              // 载荷前的 PNG 伪装长度
var TS_HOST = 'https://vod.xl01.me/';
var DEAD_LINES = ['maliva', 'yvqzo4'];             // 实测失效（返回占位图）
var PREFER_LINES = ['iplay', 'tos_hls3', 'ac5634-us'];
var HLS_PREFIX_LINES = ['4102-us', 'ac5634-us'];    // 这些线路的分片要加 /hls/
var LINES = [                                       // 暴露给播放器做「切换线路」的线路表
    { tag: 'iplay', name: '高清(iplay)' },
    { tag: 'tos_hls3', name: '备用(tos_hls3)' },
    { tag: 'ac5634-us', name: '备用2(ac5634-us)' }
];
var SITE_KEY = '';
var CACHE = {};

/* ============================ inflate（RFC1951，内联自足） ============================ */
function deflateRaw(input) {
    var pos = 0, bitbuf = 0, bitcnt = 0;
    var out = new Uint8Array(Math.max(1024, input.length * 4)), outLen = 0;
    function grow(need) {
        if (outLen + need <= out.length) return;
        var cap = out.length;
        while (cap < outLen + need) cap *= 2;
        var nb = new Uint8Array(cap);
        nb.set(out.subarray(0, outLen));
        out = nb;
    }
    function bits(n) {
        while (bitcnt < n) { bitbuf |= input[pos++] << bitcnt; bitcnt += 8; }
        var v = bitbuf & ((1 << n) - 1);
        bitbuf >>>= n; bitcnt -= n;
        return v;
    }
    function buildHuff(lengths) {
        var i, maxBits = 0;
        for (i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
        var blCount = new Array(maxBits + 1);
        for (i = 0; i <= maxBits; i++) blCount[i] = 0;
        for (i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
        var nextCode = new Array(maxBits + 2), code = 0;
        for (var b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
        var map = {};
        for (i = 0; i < lengths.length; i++) {
            var len = lengths[i];
            if (!len) continue;
            map[(len << 16) | nextCode[len]] = i;
            nextCode[len]++;
        }
        return { map: map, maxBits: maxBits };
    }
    function decode(h) {
        var code = 0;
        for (var len = 1; len <= h.maxBits; len++) {
            code = (code << 1) | bits(1);
            var s = h.map[(len << 16) | code];
            if (s !== undefined) return s;
        }
        throw new Error('bad huffman code');
    }
    var LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    var LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    var DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    var DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    var CLORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
    var FIXED_LIT = null, FIXED_DIST = null;
    function fixedTables() {
        if (FIXED_LIT) return;
        var l = new Array(288), i;
        for (i = 0; i < 144; i++) l[i] = 8;
        for (; i < 256; i++) l[i] = 9;
        for (; i < 280; i++) l[i] = 7;
        for (; i < 288; i++) l[i] = 8;
        FIXED_LIT = buildHuff(l);
        var d = new Array(30);
        for (i = 0; i < 30; i++) d[i] = 5;
        FIXED_DIST = buildHuff(d);
    }
    var final = 0;
    while (!final) {
        final = bits(1);
        var type = bits(2);
        if (type === 0) {
            bitbuf = 0; bitcnt = 0;
            var len = input[pos] | (input[pos + 1] << 8); pos += 4;
            grow(len);
            for (var i2 = 0; i2 < len; i2++) out[outLen++] = input[pos++];
        } else {
            var lit, dist;
            if (type === 1) { fixedTables(); lit = FIXED_LIT; dist = FIXED_DIST; }
            else if (type === 2) {
                var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4, k;
                var cl = new Array(19);
                for (k = 0; k < 19; k++) cl[k] = 0;
                for (k = 0; k < hclen; k++) cl[CLORDER[k]] = bits(3);
                var clHuff = buildHuff(cl);
                var lens = new Array(hlit + hdist), n = 0;
                while (n < hlit + hdist) {
                    var sym = decode(clHuff);
                    if (sym < 16) lens[n++] = sym;
                    else {
                        var rep, val = 0;
                        if (sym === 16) { val = lens[n - 1]; rep = 3 + bits(2); }
                        else if (sym === 17) { rep = 3 + bits(3); }
                        else { rep = 11 + bits(7); }
                        while (rep-- > 0) lens[n++] = val;
                    }
                }
                lit = buildHuff(lens.slice(0, hlit));
                dist = buildHuff(lens.slice(hlit));
            } else throw new Error('bad block type');
            for (;;) {
                var s = decode(lit);
                if (s === 256) break;
                if (s < 256) { grow(1); out[outLen++] = s; continue; }
                var li = s - 257;
                var mlen = LBASE[li] + bits(LEXT[li]);
                var ds = decode(dist);
                var md = DBASE[ds] + bits(DEXT[ds]);
                grow(mlen);
                var from = outLen - md;
                for (var m = 0; m < mlen; m++) out[outLen++] = out[from + m];
            }
        }
    }
    return out.subarray(0, outLen);
}

function gunzip(bytes) {
    var off = 0;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        off = 10;
        var flg = bytes[3];
        if (flg & 4) off += 2 + (bytes[off] | (bytes[off + 1] << 8));
        if (flg & 8) { while (bytes[off++] !== 0) {} }
        if (flg & 16) { while (bytes[off++] !== 0) {} }
        if (flg & 2) off += 2;
    } else if (bytes[0] === 0x78) {
        off = 2;
        if (bytes[1] & 0x20) off += 4;
    }
    return deflateRaw(bytes.subarray(off));
}

/* ============================ 工具 ============================ */
var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64MAP = null;

function b64ToBytes(str) {
    if (!B64MAP) {
        B64MAP = {};
        for (var i = 0; i < B64CHARS.length; i++) B64MAP[B64CHARS.charAt(i)] = i;
    }
    var clean = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
    var len = clean.length, pad = 0;
    if (len && clean.charAt(len - 1) === '=') pad++;
    if (len > 1 && clean.charAt(len - 2) === '=') pad++;
    var outLen = Math.floor(len * 3 / 4) - pad;
    var out = new Uint8Array(outLen), o = 0, buf = 0, bitsCount = 0;
    for (var j = 0; j < len; j++) {
        var c = clean.charAt(j);
        if (c === '=') break;
        buf = (buf << 6) | B64MAP[c];
        bitsCount += 6;
        if (bitsCount >= 8) {
            bitsCount -= 8;
            out[o++] = (buf >> bitsCount) & 0xff;
        }
    }
    return out;
}

function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
}

function bytesToText(bytes) {
    var s = '', CH = 8192;
    for (var i = 0; i < bytes.length; i += CH) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    try {
        return decodeURIComponent(escape(s));
    } catch (e) {
        return s;
    }
}

function get(url, options) {
    var o = options || {};
    o.headers = o.headers || {};
    o.headers['User-Agent'] = UA;
    o.headers['Referer'] = HOST + '/';
    var res = req(url, o);
    return res && res.content !== undefined ? res.content : '';
}

function getText(url, options) { return get(url, options); }

function getBytes(url, options) {
    var o = options || {};
    o.buffer = 2;                                  // base64
    return b64ToBytes(get(url, o));
}

function fullUrl(path) {
    return path.indexOf('http') === 0 ? path : HOST + path;
}

/* ============================ 签名（复刻 xlplayer.js） ============================ */
function sign(pid, t) {
    var key = String(md5X(pid + '-' + t)).substring(0, 16);
    var b64 = aesX('AES/ECB', true, pid + '-' + t, false, key, '', true);
    return bytesToHex(b64ToBytes(b64)).toUpperCase();
}

/* ============================ 列表解析 ============================ */
function parseCards(html) {
    var out = [], parts = String(html).split('<div class="movie-card">');
    for (var i = 1; i < parts.length; i++) {
        var seg = parts[i];
        var m = seg.match(/<a[^>]+href="([^"]+\.htm)"[^>]*title="([^"]*)"/);
        if (!m) m = seg.match(/<a[^>]+title="([^"]*)"[^>]*href="([^"]+\.htm)"/);
        var href = '', title = '';
        if (m) { href = m[1]; title = m[2]; }
        if (href && href.indexOf('.htm') < 0) { var t2 = m ? m[1] : ''; href = m[2]; title = t2; }
        var name = (seg.match(/<h4>([\s\S]*?)<\/h4>/) || [0, ''])[1].replace(/<[^>]+>/g, '').trim();
        var pic = (seg.match(/data-src="([^"]+)"/) || seg.match(/<img[^>]+src="([^"]+)"/) || [0, ''])[1];
        var remark = (seg.match(/<div class="card-meta">[\s\S]*?<span>([^<]*)<\/span>/) || [0, ''])[1].trim();
        var rating = (seg.match(/class="rating-badge"[^>]*>([\s\S]*?)<\/div>/) || [0, ''])[1].replace(/<[^>]+>/g, '').trim();
        if (!href) continue;
        out.push({
            vod_id: href,
            vod_name: name || title,
            vod_pic: pic,
            vod_remarks: remark || rating
        });
    }
    return out;
}

/* ============================ 线路选择 ============================ */
function pickLine(data, wanted) {
    var cands = [];
    var groups = ['m3u8_2', 'm3u8'];
    for (var g = 0; g < groups.length; g++) {
        var raw = String(data[groups[g]] || '');
        if (!raw) continue;
        var items = raw.split(',');
        for (var i = 0; i < items.length; i++) {
            if (!items[i]) continue;
            var idx = items[i].indexOf('#');
            var url = idx >= 0 ? items[i].substring(0, idx) : items[i];
            var tag = idx >= 0 ? items[i].substring(idx + 1) : '';
            if (DEAD_LINES.indexOf(tag) >= 0) continue;
            cands.push({ tag: tag, url: url.trim() });
        }
    }
    // 播放器里选的线路优先（flag 里带 tag）
    if (wanted) {
        for (var w = 0; w < cands.length; w++) if (cands[w].tag === wanted) return cands[w];
    }
    for (var p = 0; p < PREFER_LINES.length; p++) {
        for (var c = 0; c < cands.length; c++) {
            if (cands[c].tag === PREFER_LINES[p]) return cands[c];
        }
    }
    return cands.length ? cands[0] : null;
}

function tagOf(flag) {
    for (var i = 0; i < LINES.length; i++) if (String(flag || '').indexOf(LINES[i].tag) >= 0) return LINES[i].tag;
    return '';
}

function decryptPlaylist(lineUrl) {
    var url = String(lineUrl).replace('www.bde4.cc', HOST.replace('https://', '')).replace('https://vod.xl01.me', HOST);
    var bytes = getBytes(url);
    if (!bytes || bytes.length < FAKE_HEAD + 2) return '';
    return bytesToText(gunzip(bytes.subarray(FAKE_HEAD)));
}

function rewriteSegments(playlist, tag) {
    var base = TS_HOST + (HLS_PREFIX_LINES.indexOf(tag) >= 0 ? 'hls/' : '');
    var lines = String(playlist).split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');
        if (line && line.indexOf('#') !== 0 && /\.ts$/.test(line.trim())) {
            out.push(base + line.trim());
        } else {
            out.push(line);
        }
    }
    return out.join('\n');
}

/* ============================ 接口实现 ============================ */
function init(ext) {
    try { if (ext && ext.skey) SITE_KEY = ext.skey; } catch (e) {}
    try { if (ext && ext.ext) SITE_KEY = SITE_KEY || ''; } catch (e) {}
}

var CLASSES = [
    { type_id: 'all?type=0', type_name: '电影' },
    { type_id: 'all?type=1', type_name: '剧集' },
    { type_id: 'dongzuo', type_name: '动作' },
    { type_id: 'aiqing', type_name: '爱情' },
    { type_id: 'xiju', type_name: '喜剧' },
    { type_id: 'kehuan', type_name: '科幻' },
    { type_id: 'kongbu', type_name: '恐怖' },
    { type_id: 'zhanzheng', type_name: '战争' },
    { type_id: 'wuxia', type_name: '武侠' },
    { type_id: 'juqing', type_name: '剧情' },
    { type_id: 'donghua', type_name: '动画' },
    { type_id: 'jingsong', type_name: '惊悚' },
    { type_id: 'xuanyi', type_name: '悬疑' },
    { type_id: 'fanzui', type_name: '犯罪' },
    { type_id: 'maoxian', type_name: '冒险' },
    { type_id: 'jilu', type_name: '纪录' },
    { type_id: 'guzhuang', type_name: '古装' },
    { type_id: 'qihuan', type_name: '奇幻' },
    { type_id: 'zongyi', type_name: '综艺' },
    { type_id: 'yuanchuang', type_name: '原创压制' },
    { type_id: 'meiju', type_name: '美剧' },
    { type_id: 'hanju', type_name: '韩剧' },
    { type_id: 'riju', type_name: '日剧' },
    { type_id: 'guoju', type_name: '国产剧' },
    { type_id: 'gangtaiju', type_name: '港台剧' },
    { type_id: 'duanju', type_name: '短剧' }
];

function home() {
    return JSON.stringify({ class: CLASSES, filters: {} });
}

function homeVod() {
    var html = getText(HOST + '/');
    return JSON.stringify({ list: parseCards(html) });
}

function category(tid, pg, filter, extend) {
    var page = parseInt(pg, 10) || 1;
    var url;
    if (String(tid).indexOf('?') >= 0) {
        var seg = String(tid).split('?');
        url = HOST + '/s/' + seg[0] + (page > 1 ? '/' + page : '') + '?' + seg[1];
    } else {
        url = HOST + '/s/' + tid + (page > 1 ? '/' + page : '');
    }
    var html = getText(url);
    return JSON.stringify({
        page: page,
        pagecount: 999,
        limit: 24,
        total: 9999,
        list: parseCards(html)
    });
}

function detail(id) {
    var html = getText(fullUrl(id));
    var name = (html.match(/<h1 class="movie-title">([\s\S]*?)<\/h1>/) || [0, ''])[1].replace(/<[^>]+>/g, '').trim();
    name = name.replace(/\s*\((\d{4})\)\s*$/, '');
    var pic = (html.match(/<div class="movie-info">[\s\S]*?<img[^>]+src="([^"]+)"/) || html.match(/<img[^>]+src="(https:\/\/wework\.qpic\.cn[^"]+)"/) || [0, ''])[1];
    var desc = (html.match(/<div class="desc">([\s\S]*?)<\/div>/) || [0, ''])[1].replace(/<[^>]+>/g, '').trim();
    var remark = (html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [0, ''])[1].replace(/<[^>]+>/g, '').trim();
    var urls = [];
    var re = /<a class="play-item"[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, m;
    while ((m = re.exec(html)) !== null) {
        // 宿主约定：名称$地址（Flag.setEpisodes(): urls[i].split('$', 2) -> Episode.create(name, url)）
        urls.push(m[2].trim() + '$' + m[1]);
    }
    var episodes = urls.join('#');
    var vod = {
        vod_id: id,
        vod_name: name,
        vod_pic: pic,
        vod_remarks: remark,
        vod_content: desc,
        // 站点的 CDN 线路暴露成 TVBox 的多 from -> 播放器里能切换线路；
        // 每条线路下重复同一套剧集，play(flag) 按 flag 里的 tag 选线（缺失则回退到优先顺序）
        vod_play_from: LINES.map(function (l) { return l.name; }).join('$$$'),
        vod_play_url: LINES.map(function () { return episodes; }).join('$$$')
    };
    return JSON.stringify({ list: [vod] });
}

function play(flag, id, flags) {
    var page = getText(fullUrl(id));
    var m = page.match(/var\s+pid\s*=\s*(\d+)/);
    if (!m) return JSON.stringify({ parse: 0, url: '', header: {} });
    var pid = m[1];

    var t = Date.now();
    var lines = JSON.parse(getText(HOST + '/lines?t=' + t + '&sg=' + sign(pid, t) + '&pid=' + pid));
    var data = lines && lines.data ? lines.data : {};
    var line = pickLine(data, tagOf(flag));
    if (!line) return JSON.stringify({ parse: 0, url: '', header: {} });

    var playlist = decryptPlaylist(line.url);
    if (!playlist) return JSON.stringify({ parse: 0, url: '', header: {} });

    var key = 'p' + pid + '_' + t;
    CACHE[key] = rewriteSegments(playlist, line.tag);

    // ⚠️ 关键：分片 CDN 校验 User-Agent，非浏览器 UA 一律 403（实测 ffmpeg 默认 Lavf/… 被拒）。
    // 所以必须把 UA 通过 header 交给播放器，让它取分片时带上。
    return JSON.stringify({ parse: 0, url: proxyUrl('k=' + key), header: { 'User-Agent': UA } });
}

function proxyUrl(param) {
    // 宿主 BaseLoader.proxy(): 只要带上 siteKey 就直接路由到本源，不需要 do 参数。
    // 注意 getProxy() 返回的地址**已经自带 ?do=js**，所以这里只能用 & 追加，不能再拼 do。
    var base = '';
    try { if (typeof getProxy === 'function') base = getProxy(true); } catch (e) { base = ''; }
    var q = (SITE_KEY ? 'siteKey=' + encodeURIComponent(SITE_KEY) + '&' : '') + param;
    if (base) return base + (base.indexOf('?') >= 0 ? '&' : '?') + q;
    return 'proxy://' + q;
}

function proxy(params) {
    var p = params || {};
    var key = p.k || '';
    if (!key && p.url) {
        var mm = String(p.url).match(/[?&]k=([^&]+)/);
        if (mm) key = decodeURIComponent(mm[1]);
    }
    var body = CACHE[key];
    if (!body && key && key.indexOf('p') === 0) body = CACHE[key];
    if (!body) return [404, 'text/plain', 'not found'];
    return [200, 'application/vnd.apple.mpegurl', body];
}

function search(wd, quick, pg) {
    // 站点搜索需要图片验证码（30 分钟一次），源内无法绕过 —— 返回空结果而不报错
    try {
        var html = getText(HOST + '/search/' + encodeURIComponent(wd));
        if (html.indexOf('需要输入验证码') >= 0) return JSON.stringify({ list: [] });
        return JSON.stringify({ list: parseCards(html) });
    } catch (e) {
        return JSON.stringify({ list: [] });
    }
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
