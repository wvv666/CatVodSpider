/*
 * 橘子动漫 www.mgnacg.com —— TVBox / FongMi 影视源（js 源 · 自足，不依赖 jar 的 pd/pdfh）
 *
 * 站点形态：MacCMS（苹果CMS）v10 + Streamlab 模板，伪静态路由
 *   分类 /category/{tid}-----------/    详情 /media/{id}/    播放 /bangumi/{vod}-{sid}-{nid}/
 *
 * 数据接口（实测）：
 *   列表  GET /index.php/ajax/data?mid=1&limit=N&page=P[&tid=T]  -> {code,page,pagecount,total,list:[vod_*]}
 *   搜索  GET /index.php/ajax/data?mid=1&limit=N&wd=关键词        -> 同上（全字段，比 /ajax/suggest 全）
 *   站点自带采集接口 /api.php/provide/vod/ 已关（返回 closed），所以走 ajax 通道。
 *
 * 取流链路（实测，三步）：
 *   1) 播放页 /bangumi/{vod}-{sid}-{nid}/ -> var player_aaaa = {from:"2_", url:"<密文>"}
 *   2) /static/js/playerconfig.js -> player_list[from].parse（该线路的解析前缀）
 *      GET parse+url -> 播放器页（"橘子播放器"）：var config = {url:"<密文>", vkey:...}
 *      页面还带两个 <meta id="now_xxx">（charset 那个是数字串，viewport 那个是字母串）
 *   3) 密钥派生：把字母串按数字串升序重排 -> perm
 *        hex = MD5(perm + "Mknacg123321")   // 32 位十六进制
 *        iv  = hex[0:16]  作为 UTF-8 字符串（16 字节）
 *        key = hex[16:32]
 *      AES-128-CBC/Pkcs7 解密 config.url -> 直链（形如 https://play.mknacg.top:9009/d/**.mknvideo?sign=**）
 *
 *   ⚠️ 该直链 302 到 pan.wo.cn 的 MP4，**绝不能带 Referer**（带 Referer 会被 400，
 *      带 Origin 会被 CORS 403）；不带 Referer 正常 200，所以 header 里只给 UA。
 *
 * 弹幕：本站网页播放器没有任何弹幕层（playerconfig.js / player.js / setting.js 里零 danmu 代码，
 *      播放页也没有弹幕 DOM），所以本源不挂弹幕。
 *
 * 依赖宿主注入：req(url, options) / md5X / aesX（FongMi quickjs 层）
 */
var HOST = 'https://www.mgnacg.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var SALT = 'Mknacg123321';
var RULE = 'mgnacg';
var PAGE_SIZE = 20;
var CACHE = {};
var CONF = {};

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

function listOf(s) {
    if (s === null || s === undefined) return [];
    if (Object.prototype.toString.call(s) === '[object Array]') return s;
    return [s];
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

function detailLink(url) {
    return url && url.indexOf('http') !== 0 ? HOST + url : url;
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
        vod_pic: detailLink(it.vod_pic || ''),
        vod_remarks: remarks.join(' · '),
        vod_year: text(it.vod_year || ''),
        type_name: text((it.type && it.type.type_name) || '')
    };
}

function ajaxList(query) {
    var url = HOST + '/index.php/ajax/data?mid=1&limit=' + PAGE_SIZE + '&' + query;
    var json = getJson(url, { 'Referer': HOST + '/' });
    if (!json || !json.list) return { list: [], page: 1, pagecount: 1, total: 0 };
    var out = [];
    for (var i = 0; i < json.list.length; i++) {
        var v = vodOf(json.list[i]);
        if (v) out.push(v);
    }
    return { list: out, page: json.page || 1, pagecount: json.pagecount || 1, total: json.total || 0 };
}

function home() {
    return JSON.stringify({
        class: [
            { type_id: '1', type_name: '动漫' },
            { type_id: '2', type_name: '剧场版' },
            { type_id: '5', type_name: '4月新番' },
            { type_id: '29', type_name: '7月新番' },
            { type_id: '32', type_name: '10月新番' }
        ]
    });
}

function homeVod() {
    var r = ajaxList('page=1');
    return JSON.stringify({ list: r.list });
}

function category(tid, pg, filter, extend) {
    var page = parseInt(pg || 1, 10) || 1;
    var tid_ = extend && extend.tid ? extend.tid : tid;
    var r = ajaxList('page=' + page + (tid_ && tid_ !== '' ? '&tid=' + tid_ : ''));
    return JSON.stringify({
        page: page,
        pagecount: r.pagecount <= page ? page : r.pagecount,
        limit: PAGE_SIZE,
        total: r.total,
        list: r.list
    });
}

function search(wd, quick) {
    if (!wd) return JSON.stringify({ list: [] });
    var r = ajaxList('page=1&wd=' + encodeURIComponent(wd));
    if (!r.list.length) {
        /* 退路：站点自带的搜索建议接口（字段少但仍可用） */
        var json = getJson(HOST + '/index.php/ajax/suggest?mid=1&wd=' + encodeURIComponent(wd), { 'Referer': HOST + '/' });
        var arr = (json && json.list) || [];
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            out.push({ vod_id: String(arr[i].id), vod_name: text(arr[i].name), vod_pic: detailLink(arr[i].pic || ''), vod_remarks: '' });
        }
        return JSON.stringify({ list: out });
    }
    return JSON.stringify({ list: r.list });
}

/* ============================ 详情 ============================ */

function playList(html, vodId) {
    /* 选集：按 sid 分组、保持文档顺序；同时记住每条线路的第一集 */
    var re = new RegExp('/bangumi/' + vodId + '-(\\d+)-(\\d+)/"[^>]*>([^<]{1,24})<', 'g');
    var order = [];
    var lines = {};
    var m;
    while ((m = re.exec(html)) !== null) {
        var sid = m[1];
        if (!lines[sid]) { lines[sid] = { first: m[2], eps: [] }; order.push(sid); }
        lines[sid].eps.push(text(m[3]) + '$' + '/bangumi/' + vodId + '-' + sid + '-' + m[2] + '/');
    }
    /* 线路名与「是否可播」只有播放页知道：读每条线路第一集的 player_aaaa.from，
       再查 playerconfig 里这条线路的名字与 ps（ps=0 表示站点自己标注的已下线线路）。 */
    var cfg = playerConfig();
    var from = [], url = [];
    for (var k = 0; k < order.length; k++) {
        var sid2 = order[k];
        var info = lines[sid2];
        if (!info.eps.length) continue;
        var key = fromOf(vodId, sid2, info.first);
        var meta = (key && cfg[key]) || null;
        if (meta && String(meta.ps) === '0') continue;                 /* 站点标注已下线 */
        if (meta && String(meta.parse || '').indexOf('http') !== 0) continue;
        from.push((meta && meta.show) ? text(meta.show) : ('线路' + sid2));
        url.push(info.eps.join('#'));
    }
    return { from: from.join('$$$'), url: url.join('$$$') };
}

function fromOf(vodId, sid, nid) {
    var key = 'f' + vodId + '_' + sid;
    if (CACHE[key] !== undefined) return CACHE[key];
    var page = get(HOST + '/bangumi/' + vodId + '-' + sid + '-' + nid + '/', { 'Referer': HOST + '/media/' + vodId + '/' });
    var pm = page ? /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(page) : null;
    var f = '';
    if (pm) {
        try { f = String(JSON.parse(pm[1]).from || ''); } catch (e) { f = ''; }
    }
    CACHE[key] = f;
    return f;
}

function detail(id) {
    var vodId = String(id || '').replace(/[^0-9]/g, '');
    if (!vodId) return JSON.stringify({ list: [] });
    var html = get(HOST + '/media/' + vodId + '/');
    if (!html) return JSON.stringify({ list: [] });
    var info = function (label, max) {
        var r = new RegExp('<em[^>]*>\\s*' + label + '：\\s*</em>([\\s\\S]{0,' + (max || 240) + '}?)<\\/li>', 'i').exec(html);
        return r ? text(r[1]) : '';
    };
    var name = info('片名') || text((/<title>([^<|]*)/.exec(html) || [])[1]);
    name = name.replace(/^《|》.*$/g, '');
    /* 海报是懒加载：真地址在 data-src 里（src 是 base64 占位图），容器 .detail-pic */
    var pic = (
        /<div class="detail-pic">[\s\S]{0,600}?data-src="(https?:\/\/[^"]+)"/i.exec(html) ||
        /data-src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i.exec(html) ||
        /<meta[^>]+property="og:image"[^>]+content="(https?:\/\/[^"]+)"/i.exec(html) || []
    )[1] || '';
    var content = info('简介', 3000) || text((/<meta name="description" content="[^"]*剧情介绍：([^"]*)"/.exec(html) || [])[1]);
    var remarks = info('状态');
    var year = info('年份');
    var area = info('地区');
    var type = info('类型');
    var pl = playList(html, vodId);
    if (!pl.from) return JSON.stringify({ list: [] });
    return JSON.stringify({
        list: [{
            vod_id: vodId,
            vod_name: name,
            vod_pic: pic,
            vod_year: year,
            vod_area: area,
            vod_remarks: remarks,
            type_name: type,
            vod_content: content,
            vod_play_from: pl.from,
            vod_play_url: pl.url
        }]
    });
}

/* ============================ 取流 ============================ */

function playerConfig() {
    if (CACHE.player) return CACHE.player;
    var js = get(HOST + '/static/js/playerconfig.js');
    var m = /MacPlayerConfig\.player_list=(\{[\s\S]*?\}),MacPlayerConfig/.exec(js);
    if (!m) return {};
    try { CACHE.player = JSON.parse(m[1]); } catch (e) { CACHE.player = {}; }
    return CACHE.player;
}

function parsePrefix(from) {
    var list = playerConfig();
    var order = ['2_', '5_', '6_', '3_', '4_'];
    var cands = [];
    if (from && list[from] && list[from].parse && list[from].parse.indexOf('http') === 0) cands.push(list[from].parse);
    for (var i = 0; i < order.length; i++) {
        var k = order[i];
        if (list[k] && list[k].parse && list[k].parse.indexOf('http') === 0) cands.push(list[k].parse);
    }
    for (var j = 0; j < cands.length; j++) {
        var p = cands[j];
        if (p.indexOf('{') < 0) {                            /* 跳过带模板占位的 */
            if (cands.length === 1 || /\/\?url=$|\?url=$/.test(p) || p.indexOf('?') > 0) return p;
        }
    }
    return cands.length ? cands[0] : '';
}

function permute(digits, letters) {
    var pairs = [];
    for (var i = 0; i < letters.length; i++) pairs.push({ id: digits.charAt(i), t: letters.charAt(i) });
    pairs.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
    var out = '';
    for (var j = 0; j < pairs.length; j++) out += pairs[j].t;
    return out;
}

function decodeUrl(cipher, digits, letters) {
    var hex = md5X(permute(digits, letters) + SALT);
    var key = hex.substring(16, 32);
    var iv = hex.substring(0, 16);
    try {
        var plain = aesX('AES/CBC', false, cipher, true, key, iv, false);
        if (plain && plain.indexOf('http') === 0) return plain;
        var plain2 = aesX('AES/CBC/PKCS5Padding', false, cipher, true, key, iv, false);
        if (plain2 && plain2.indexOf('http') === 0) return plain2;
    } catch (e) {
    }
    return '';
}

function playerPage(prefix, enc, ref) {
    var url = prefix + enc;
    var html = get(url, { 'Referer': ref || HOST + '/' });
    if (!html) return '';
    var m = /"url"\s*:\s*"([A-Za-z0-9+\/=]{20,})"/.exec(html);
    if (!m) return '';
    var dm = /<meta[^>]*charset="UTF-8"[^>]*id="now_([^"]+)"/i.exec(html);
    var lm = /<meta[^>]*(?:name="viewport")[^>]*id="now_([^"]+)"/i.exec(html) || /<meta[^>]*id="now_([^"]+)"[^>]*name="viewport"/i.exec(html);
    if (!dm || !lm) return '';
    return decodeUrl(m[1], dm[1], lm[1]);
}

function play(flag, id, flags) {
    var path = String(id || '');
    if (path.indexOf('/bangumi/') !== 0) return JSON.stringify({ parse: 0, url: '', msg: '剧集地址不对：' + path });
    var page = get(HOST + path, { 'Referer': HOST + '/media/' });
    if (!page) return JSON.stringify({ parse: 0, url: '', msg: '播放页打不开' });
    var pm = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(page);
    if (!pm) return JSON.stringify({ parse: 0, url: '', msg: '播放页没有 player_aaaa' });
    var pa;
    try { pa = JSON.parse(pm[1]); } catch (e) { return JSON.stringify({ parse: 0, url: '', msg: 'player_aaaa 解析失败' }); }
    var enc = String(pa.url || '');
    if (!enc) return JSON.stringify({ parse: 0, url: '', msg: '这一集没有播放地址' });
    var prefix = parsePrefix(pa.from);
    if (!prefix) return JSON.stringify({ parse: 0, url: '', msg: '线路解析配置读不到' });
    var url = playerPage(prefix, enc, HOST + path);
    if (!url) return JSON.stringify({ parse: 0, url: '', msg: '取流失败：解析服务没有返回可播地址（线路可能已下线）' });
    return JSON.stringify({
        parse: 0,
        url: url,
        /* 关键：不带 Referer，pan.wo.cn 的跳转才给 200 */
        header: { 'User-Agent': UA }
    });
}

/* ============================ 导出 ============================ */

function init(ext) {
    CONF = {};
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
