/*
 * girigiri愛動漫 ani.girigirilove.com —— TVBox / FongMi 影视源（js 源 · 自足，不依赖 jar）
 *
 * 站点形态：MacCMS（苹果CMS）v10 + dsn2 模板，伪静态路由
 *   详情 /GV{id}/          播放 /playGV{id}-{sid}-{nid}/          分类 /show/{tid}-----------/page/{n}/
 *
 * 数据接口（实测 2026-09-25）：
 *   列表  GET /index.php/ajax/data?mid=1&limit=N&page=P   -> {code,page,pagecount,total,list:[vod_*]}
 *         ⚠ 该接口**不认 tid / wd 参数**（传了也返回同一批默认列表），所以只用来做首页最新；
 *           分类必须走 HTML 分类页。
 *         ⚠ limit 是白名单，只认 10 / 20 / 30，其它值（3/15/24/25/40/50…）会被打回 10。
 *   搜索  GET /index.php/ajax/suggest?mid=1&limit=N&wd=关键词 -> {list:[{id,name,en,pic}]}
 *         站点 HTML 搜索页要图片验证码（页面里是「系统提示 / 提交验证」），源内过不去，所以走 suggest。
 *         实测 limit 可放到 100+，返回条数即命中数。
 *   分类  GET /show/{tid}-----------/page/{n}/  HTML，每页 48 条
 *         实测有内容的 tid：2 日番 / 3 美番 / 21 劇場版 / 20 真人番劇 / 24 BD副音軌
 *         （pager 给的页数会虚高：tid=2 标称 86 页，实际 60 页左右还有数据、70 页起为空）
 *
 * 取流链路（实测，站内播放页已把明文地址写进 player_aaaa，无需解析服务）：
 *   播放页 -> var player_aaaa = {from:"cht"|"chs", url:"<密文>", id, sid, nid}
 *   encrypt=2 的编码是 base64( percent编码后的URL )：
 *       1) base64 解码 -> "%68%74%74%70%73%3A%2F%2F..."
 *       2) decodeURIComponent -> https://akua.girigirilove.com/zijian/oldanime/.../01/playlist.m3u8
 *   ⚠ 该 m3u8 是标准 HLS，**无 EXT-X-KEY 加密、无防盗链、CORS 全开**，分片 0000.ts 实下 1.4 MB
 *     （video/mp2t）成功，不带 Referer 也 200，所以 play() 直接回传直链、parse=0。
 *   ⚠ 站点另有 atom.php 解析播放器（MacPlayer.Parse + PlayUrl 拼 iframe），本源不用它：
 *     直链更快，也少一跳。
 *
 * 弹幕（本站的弹幕是「每集一个静态 XML」）：
 *   繁中线路每集配一个弹幕文件，路径由 m3u8 直接推出（实测 4 部番全部命中 206）：
 *       /.../cht/<剧集目录>/01/playlist.m3u8  ->  /.../cht/<剧集目录>/01.xml
 *   XML 是 B 站格式（<d p="时间,模式,大小,颜色,时间戳,...,用户ID">文本</d>），单集约 1 MB。
 *   ⚠ 简中线路没有对应 xml（实测 404），所以只在路径含 /cht/ 时挂弹幕。
 *   ⚠ 站点播放器另有一个 POST 弹幕口 m3u8.girigirilove.com/danmu（读取口 ?id= 恒返回 null），
 *     不是这里用的数据源。
 *
 * 依赖宿主注入：req(url, options)（FongMi quickjs 层）
 */
var HOST = 'https://ani.girigirilove.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var PAGE_SIZE = 30;      /* ajax/data 的 limit 白名单：10 / 20 / 30 */
var SEARCH_SIZE = 50;
var CACHE = {};
var CONF = {};

/* 分类：/show/{tid}-----------/ 实测有内容的 tid */
var CLASSES = [
    ['2', '日番'],
    ['3', '美番'],
    ['21', '劇場版'],
    ['20', '真人番劇'],
    ['24', 'BD副音軌']
];

/* ============================ 工具 ============================ */

function text(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
}

function get(url, headers) {
    var h = Object.assign({ 'User-Agent': UA }, headers || {});
    var res = req(url, { headers: h });
    return res && res.code === 200 ? res.content : '';
}

function getJson(url, headers) {
    var body = get(url, headers);
    if (!body) return null;
    try { return JSON.parse(body); } catch (e) { return null; }
}

/* 站点偶发返回空体（实测有约 1/10 概率），取不到就重试 */
function getRetry(url, headers, tries) {
    var n = tries || 2;
    for (var i = 0; i < n; i++) {
        var body = get(url, headers);
        if (body) return body;
    }
    return '';
}

function getJsonRetry(url, headers, tries) {
    var body = getRetry(url, headers, tries);
    if (!body) return null;
    try { return JSON.parse(body); } catch (e) { return null; }
}

function full(url) {
    return url && url.indexOf('http') !== 0 ? HOST + url : url;
}

/* 纯 JS base64 解码：宿主不一定有 atob，且密文里带 + / = 都可能 */
function b64(s) {
    var CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var src = String(s).replace(/[^A-Za-z0-9+\/=]/g, '');
    var out = '', buf = 0, bits = 0;
    for (var i = 0; i < src.length; i++) {
        var c = CH.indexOf(src.charAt(i));
        if (c < 0) continue;                       /* '=' 或非法字符：跳过 */
        buf = (buf << 6) | c;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((buf >> bits) & 0xFF);
        }
    }
    return out;
}

function unesc(s) {
    try { return decodeURIComponent(s); } catch (e) { }
    return String(s).replace(/%([0-9A-Fa-f]{2})/g, function (_, h) {
        return String.fromCharCode(parseInt(h, 16));
    });
}

/* ============================ 列表 ============================ */

function vodOf(it) {
    if (!it) return null;
    var remarks = [];
    var score = parseFloat(it.vod_score || 0);
    if (score > 0) remarks.push(score.toFixed(1));
    var rk = text(it.vod_remarks);
    if (rk) remarks.push(rk);
    return {
        vod_id: String(it.vod_id || it.vod_en || ''),
        vod_name: text(it.vod_name),
        vod_pic: full(it.vod_pic || ''),
        vod_remarks: remarks.join(' · '),
        vod_year: text(it.vod_year || ''),
        type_name: text((it.type && it.type.type_name) || '')
    };
}

/* ajax/data：只支持 limit / page，不支持 tid / wd */
function ajaxList(query) {
    var url = HOST + '/index.php/ajax/data?mid=1&limit=' + PAGE_SIZE + '&' + query;
    var json = getJsonRetry(url, { 'Referer': HOST + '/' });
    if (!json || !json.list) return { list: [], page: 1, pagecount: 1, total: 0 };
    var out = [];
    for (var i = 0; i < json.list.length; i++) {
        var v = vodOf(json.list[i]);
        if (v) out.push(v);
    }
    return { list: out, page: json.page || 1, pagecount: json.pagecount || 1, total: json.total || 0 };
}

/* 分类页 / 首页的条目块 */
function htmlList(html) {
    var out = [];
    var parts = String(html || '').split('<div class="public-list-box');
    for (var i = 1; i < parts.length; i++) {
        var seg = parts[i].slice(0, 2400);
        var idm = /href="\/GV(\d+)\//.exec(seg);
        if (!idm) continue;
        var tm = /title="([^"]*)"/.exec(seg);
        var pm = /data-src="([^"]+)"/.exec(seg);
        var rm = /class="public-list-prb[^"]*"[^>]*>([^<]*)</.exec(seg);
        out.push({
            vod_id: idm[1],
            vod_name: text(tm ? tm[1] : ''),
            vod_pic: full(pm ? pm[1] : ''),
            vod_remarks: text(rm ? rm[1] : '')
        });
    }
    return out;
}

function home() {
    var list = [];
    for (var i = 0; i < CLASSES.length; i++) {
        list.push({ type_id: CLASSES[i][0], type_name: CLASSES[i][1] });
    }
    return JSON.stringify({ class: list });
}

function homeVod() {
    var r = ajaxList('page=1');
    return JSON.stringify({ list: r.list });
}

function category(tid, pg, filter, extend) {
    var page = parseInt(pg || 1, 10) || 1;
    var tid_ = String((extend && extend.tid) || tid || '').replace(/[^0-9]/g, '');
    if (!tid_) return JSON.stringify({ page: page, pagecount: page, limit: 0, total: 0, list: [] });
    var html = getRetry(HOST + '/show/' + tid_ + '-----------/page/' + page + '/', { 'Referer': HOST + '/' });
    var list = htmlList(html);
    /* pager 页数虚高（实测尾部若干页为空），取「标称页数」与「本页有数据」的较保守值 */
    var pm = /(\d+)&nbsp;\/&nbsp;(\d+)页/.exec(html);
    var total = pm ? parseInt(pm[2], 10) : 0;
    if (!list.length && total > page) total = page;   /* 已经翻到空页：告诉宿主到头了 */
    return JSON.stringify({
        page: page,
        pagecount: total || page,
        limit: list.length,
        total: 0,
        list: list
    });
}

function search(wd, quick) {
    if (!wd) return JSON.stringify({ list: [] });
    var url = HOST + '/index.php/ajax/suggest?mid=1&limit=' + SEARCH_SIZE + '&wd=' + encodeURIComponent(wd);
    var json = getJsonRetry(url, { 'Referer': HOST + '/' });
    var arr = (json && json.list) || [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        out.push({
            vod_id: String(it.id || ''),
            vod_name: text(it.name),
            /* suggest 的 pic 是相对路径；没有简介/状态字段，播放器会显示成空 */
            vod_pic: full(it.pic || ''),
            vod_remarks: ''
        });
    }
    return JSON.stringify({ list: out });
}

/* ============================ 详情 ============================ */

function field(html, label, max) {
    var re = new RegExp('<em[^>]*>\\s*' + label + '：\\s*</em>([\\s\\S]{0,' + (max || 240) + '}?)<\\/li>', 'i');
    var m = re.exec(html);
    return m ? text(m[1]) : '';
}

/* 线路名（.anthology-tab 的页签）按顺序对应选集块（.anthology-list-box） */
function playList(html, vodId) {
    var names = [];
    var tabBlock = /<div class="anthology-tab[\s\S]*?<\/div><\/div>/.exec(html);
    if (tabBlock) {
        var tre = /<a class="swiper-slide">([\s\S]*?)<\/a>/g, tm;
        while ((tm = tre.exec(tabBlock[0])) !== null) {
            /* 页签文本形如「繁中13」（badge 里的集数直接接在后面），去掉尾部数字 */
            names.push(text(tm[1]).replace(/\d+$/, '') || ('线路' + (names.length + 1)));
        }
    }
    var boxes = String(html).split('class="anthology-list-box');
    var from = [], url = [];
    for (var i = 1; i < boxes.length; i++) {
        /* 每个块只认自己的 /playGV{id}-{sid}-{nid}/ */
        var re = new RegExp('/playGV' + vodId + '-(\\d+)-(\\d+)/"[^>]*>([^<]{0,24})<', 'g');
        var eps = [], m;
        while ((m = re.exec(boxes[i])) !== null) {
            eps.push(text(m[3]) + '$/playGV' + vodId + '-' + m[1] + '-' + m[2] + '/');
        }
        if (!eps.length) continue;
        from.push(names[i - 1] || ('线路' + i));
        url.push(eps.join('#'));
    }
    return { from: from.join('$$$'), url: url.join('$$$') };
}

function detail(id) {
    var vodId = String(id || '').replace(/[^0-9]/g, '');
    if (!vodId) return JSON.stringify({ list: [] });
    var html = getRetry(HOST + '/GV' + vodId + '/', { 'Referer': HOST + '/' });
    if (!html) return JSON.stringify({ list: [] });
    var name = field(html, '片名') || text((/<title>([^<|]*)/.exec(html) || [])[1]).replace(/_[^_]*$/, '');
    /* 海报是懒加载：真地址在 data-src；页面里还有一堆 .xml 的 data-src，所以先挑 /upload/ */
    var pic = (
        /data-src="(\/upload\/[^"]+)"/i.exec(html) ||
        /data-src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i.exec(html) || []
    )[1] || '';
    var content = field(html, '简介', 4000);
    var pl = playList(html, vodId);
    if (!pl.from) return JSON.stringify({ list: [] });
    return JSON.stringify({
        list: [{
            vod_id: vodId,
            vod_name: name,
            vod_pic: full(pic),
            vod_year: field(html, '年份'),
            vod_area: field(html, '地区'),
            vod_remarks: field(html, '状态'),
            /* 类型是若干个 <a> 标签（每个都带一长串 /search/ URL），给足长度否则截断 */
            type_name: field(html, '类型', 900),
            vod_actor: field(html, '主演', 600),
            vod_director: field(html, '导演', 600),
            vod_content: content,
            vod_play_from: pl.from,
            vod_play_url: pl.url
        }]
    });
}

/* ============================ 取流 ============================ */

/* encrypt=2：base64( percent 编码后的 URL )；顺带兼容直接给明文的情况 */
function decodePlayUrl(enc) {
    var s = String(enc || '');
    if (!s) return '';
    if (/^https?:\/\//.test(s)) return s;
    var u = unesc(b64(s));
    return /^https?:\/\//.test(u) ? u : '';
}

/* 弹幕：只有繁中线路（路径含 /cht/）每集配一个同名 xml */
function danmakuOf(m3u8) {
    if (m3u8.indexOf('/cht/') < 0) return '';
    var x = m3u8.replace(/\/([^\/]+)\/playlist\.m3u8$/, '/$1.xml');
    return x !== m3u8 ? x : '';
}

function play(flag, id, flags) {
    var path = String(id || '');
    if (path.indexOf('/playGV') !== 0) return JSON.stringify({ parse: 0, url: '', msg: '剧集地址不对：' + path });
    var page = getRetry(HOST + path, { 'Referer': HOST + '/GV' }, 3);
    if (!page) return JSON.stringify({ parse: 0, url: '', msg: '播放页打不开' });
    var pm = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/.exec(page);
    if (!pm) return JSON.stringify({ parse: 0, url: '', msg: '播放页没有 player_aaaa' });
    var pa;
    try { pa = JSON.parse(pm[1]); } catch (e) { return JSON.stringify({ parse: 0, url: '', msg: 'player_aaaa 解析失败' }); }
    var m3u8 = decodePlayUrl(pa.url);
    if (!m3u8) return JSON.stringify({ parse: 0, url: '', msg: '这一集没有可用的播放地址' });
    var out = {
        parse: 0,
        url: m3u8,
        /* 分片实测不带 Referer 也 200，只回传 UA */
        header: { 'User-Agent': UA }
    };
    var off = CONF.danmaku === 0 || CONF.danmaku === '0' || CONF.danmaku === false;
    var dm = off ? '' : danmakuOf(m3u8);
    if (dm) out.danmaku = [{ name: '站内弹幕', url: dm }];
    return JSON.stringify(out);
}

/* ============================ 导出 ============================ */

function init(ext) {
    CONF = {};
    var raw = ext && ext.ext !== undefined ? ext.ext : ext;
    if (raw && typeof raw === 'object') {
        CONF = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
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
        search: search
    };
}
