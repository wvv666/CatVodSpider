/*
 * 次元城动画 cycani.org —— TVBox / FongMi 影视源（js 源）
 *
 * 站点是 React SPA，后端是标准 REST JSON API（基址 /api），无混淆、无签名。
 *
 * 必备请求头（缺了会 400 "app_name is required"）：
 *   X-App-Name: cyc_web     X-App-Version: cycweb     X-Time-Zone: Asia/Shanghai
 *
 * 接口（实测 2026-09-14）：
 *   GET  /api/index/recommend                     推荐番组（分区->番剧）
 *   GET  /api/index/weekday                       追番周表
 *   GET  /api/ranks             /api/ranks/{id}/videos                     排行
 *   GET  /api/video-zones                         分区 + 题材/年份筛选项
 *   GET  /api/videos?zone_id=&page=&page_size=&order_by=&tag=&area=&language=&year=
 *   GET  /api/videos/search?q=&page=&page_size=   搜索（匿名可用，无验证码）
 *   GET  /api/videos/{id}                         详情（play_from = 线路表）
 *   GET  /api/videos/{id}/sections?player_code=   选集（分页）
 *   GET  /api/v2/sections/{id}/play-url           取流（必须登录，返回 {name,url}）
 *
 * 匿名可用：分类 / 列表 / 搜索 / 详情 / 选集。
 * 需要登录：取流。在站点配置的 ext 里填账号，源会自己登录、缓存令牌、过期自动刷新：
 *   "ext": "{\"username\":\"你的账号\",\"password\":\"你的密码\"}"
 *   也可以直接给现成令牌："ext": "{\"token\":\"eyJ...\"}"
 * 没填时搜索/浏览照常，点播放会返回一条提示消息而不是报错。
 */
var HOST = 'https://www.cycani.org';
var API = HOST + '/api';
var APP_NAME = 'cyc_web';
var APP_VERSION = 'cycweb';
var TZ = 'Asia/Shanghai';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var PAGE_SIZE = 24;
var SECTION_PAGE_SIZE = 100;
var SECTION_MAX_PAGE = 6;
var RULE = 'cycani';
var CONF = {};
var MEM = {};

/* ============================ 宿主注入封装 ============================ */

function cacheGet(key) {
    try { return local.get(RULE, key) || MEM[key] || ''; } catch (e) { return MEM[key] || ''; }
}

function cacheSet(key, value) {
    MEM[key] = value;
    try { local.set(RULE, key, value); } catch (e) {}
}

function headers(token) {
    var h = {
        'Accept': 'application/json',
        'X-App-Name': APP_NAME,
        'X-App-Version': APP_VERSION,
        'X-Time-Zone': TZ,
        'User-Agent': UA,
        'Referer': HOST + '/'
    };
    if (token) h['Authorization'] = /^Bearer\s+/i.test(token) ? token : ('Bearer ' + token);
    return h;
}

function qs(query) {
    if (!query) return '';
    var out = [];
    for (var k in query) {
        var v = query[k];
        if (v === undefined || v === null || v === '') continue;
        out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return out.length ? ('?' + out.join('&')) : '';
}

/** 原始请求，返回解析后的 JSON（失败返回 null） */
function raw(path, query, body, token) {
    var options = { method: body ? 'post' : 'get', headers: headers(token) };
    if (body) options.body = JSON.stringify(body);
    var res = req(API + path + qs(query), options);
    var text = res && res.content !== undefined ? res.content : '';
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/** 匿名请求，只取 data（code!==0 视为失败） */
function get(path, query) {
    var r = raw(path, query, null, null);
    return r && r.code === 0 ? r.data : null;
}

/* ============================ 登录与令牌 ============================ */

function token() {
    if (CONF.token) return CONF.token;
    var t = cacheGet('token');
    if (!t) return '';
    var expire = parseInt(cacheGet('expire') || '0', 10);
    if (expire > 0 && expire * 1000 < Date.now() + 60000) return '';
    return t;
}

function saveAuth(d) {
    if (!d || !d.token) return '';
    cacheSet('token', d.token);
    cacheSet('expire', String(d.expires_at || 0));
    return d.token;
}

function login() {
    if (!CONF.username || !CONF.password) return '';
    var r = raw('/auth/login', null, { username: CONF.username, password: CONF.password }, null);
    return r && r.code === 0 ? saveAuth(r.data) : '';
}

function refresh(old) {
    if (!old) return '';
    var r = raw('/auth/refresh', null, {}, old);
    return r && r.code === 0 ? saveAuth(r.data) : '';
}

/** 需要登录的请求：自动带令牌、401 先刷新再重登 */
function auth(path, query, body) {
    var t = token() || login();
    if (!t) return null;
    var r = raw(path, query, body, t);
    if (r && (r.code === 401 || r.code === 403)) {
        var next = refresh(t) || login();
        if (next) r = raw(path, query, body, next);
    }
    return r;
}

/* ============================ 数据映射 ============================ */

function listOf(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.list || data.items || data.sections || [];
}

/** 字段可能是字符串也可能是字符串数组（director/actor/tags…），统一成可读文本 */
function text(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(function (x) { return String(x).trim(); }).filter(function (x) { return x; }).join(', ');
    return String(value).trim();
}

function pagerOf(data) {
    return data && data.pager ? data.pager : null;
}

function vod(item) {
    if (!item) return null;
    var total = item.total > 0 ? item.total : 0;
    var remarks = text(item.remarks);
    if (!remarks && total > 1) remarks = total + ' 话';
    if (!remarks && item.score) remarks = '★ ' + item.score;
    return {
        vod_id: String(item.video_id != null ? item.video_id : item.id),
        vod_name: text(item.title),
        vod_pic: item.cover_url || '',
        vod_remarks: remarks,
        vod_year: item.year ? String(item.year) : ''
    };
}

function pageResult(list, page, total) {
    var size = PAGE_SIZE;
    return JSON.stringify({
        page: page,
        pagecount: Math.max(1, Math.ceil((total || list.length || 1) / size)),
        limit: size,
        total: total || list.length,
        list: list
    });
}

/* ============================ 接口实现 ============================ */

function init(ext) {
    CONF = {};
    var raw = ext && ext.ext !== undefined ? ext.ext : ext;
    if (raw && typeof raw === 'object') {
        CONF = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
        var s = raw.trim();
        try {
            CONF = JSON.parse(s);
        } catch (e) {
            if (s.indexOf('=') > 0) {
                s.split('&').forEach(function (kv) {
                    var p = kv.split('=');
                    if (p[0]) CONF[p[0].trim()] = decodeURIComponent(p[1] || '');
                });
            } else if (s.indexOf(':') > 0) {
                var c = s.split(':');
                CONF.username = c[0];
                CONF.password = c.slice(1).join(':');
            } else {
                CONF.token = s;
            }
        }
    }
    // 令牌可能已过期，先清掉过期的缓存
    token();
}

function home() {
    var classes = [], filters = {};
    listOf(get('/index/recommend')).forEach(function (s) {
        if (s && s.id != null) classes.push({ type_id: 'rec:' + s.id, type_name: (s.name || '推荐').trim() });
    });
    classes.push({ type_id: 'weekday', type_name: '追番周表' });
    listOf(get('/ranks')).forEach(function (r) {
        if (r && r.id != null) classes.push({ type_id: 'rank:' + r.id, type_name: '排行·' + (r.name || r.id).trim() });
    });
    listOf(get('/video-zones')).forEach(function (z) {
        if (!z || z.id == null) return;
        var tid = 'zone:' + z.id;
        classes.push({ type_id: tid, type_name: '分区·' + (z.name || z.id).trim() });
        var f = z.filters || {}, values = [];
        if (f.categories && f.categories.length) values.push({ key: 'tag', name: '题材', value: f.categories.map(function (c) { return { n: c, v: c }; }) });
        if (f.years && f.years.length) values.push({ key: 'year', name: '年份', value: f.years.map(function (y) { return { n: String(y), v: String(y) }; }) });
        if (values.length) filters[tid] = values;
    });
    return JSON.stringify({ class: classes, filters: filters });
}

function homeVod() {
    var list = [];
    listOf(get('/index/recommend')).slice(0, 2).forEach(function (s) {
        listOf(s.videos).forEach(function (v) {
            var item = vod(v);
            if (item && item.vod_name) list.push(item);
        });
    });
    return JSON.stringify({ list: list });
}

function category(tid, pg, filter, extend) {
    var page = parseInt(pg, 10) || 1;
    var parts = String(tid).split(':'), kind = parts[0], id = parts[1];
    var list = [], total = 0;
    if (kind === 'rec') {
        listOf(get('/index/recommend')).forEach(function (s) {
            if (String(s.id) !== id) return;
            listOf(s.videos).forEach(function (v) {
                var item = vod(v);
                if (item && item.vod_name) list.push(item);
            });
        });
    } else if (kind === 'rank') {
        listOf(get('/ranks/' + id + '/videos')).forEach(function (v) {
            var item = vod(v);
            if (item && item.vod_name) list.push(item);
        });
    } else if (kind === 'weekday') {
        listOf(get('/index/weekday')).forEach(function (day) {
            listOf(day.videos).forEach(function (v) {
                var item = vod(v);
                if (item && item.vod_name) list.push(item);
            });
        });
    } else if (kind === 'zone') {
        var query = { zone_id: id, page: page, page_size: PAGE_SIZE, order_by: (extend && extend.order_by) || 'update_time' };
        ['tag', 'area', 'language', 'year'].forEach(function (k) {
            if (extend && extend[k]) query[k] = extend[k];
        });
        var d = get('/videos', query);
        listOf(d).forEach(function (v) {
            var item = vod(v);
            if (item && item.vod_name) list.push(item);
        });
        var pager = pagerOf(d);
        total = pager && pager.total ? pager.total : list.length;
    }
    return pageResult(list, page, total);
}

/** 某条线路的选集列表，返回 ["第01集$code:sectionId", ...] */
function sections(videoId, code) {
    var out = [], page = 1;
    for (var i = 0; i < SECTION_MAX_PAGE; i++) {
        var d = get('/videos/' + videoId + '/sections', { player_code: code, page: page, page_size: SECTION_PAGE_SIZE });
        var items = listOf(d);
        if (!items.length) break;
        items.forEach(function (s) {
            if (!s || s.id == null) return;
            var title = (s.title || ('第 ' + (out.length + 1) + ' 集')).trim();
            out.push(title + '$' + code + ':' + s.id);
        });
        var pager = pagerOf(d);
        if (!pager || !pager.total || page * (pager.page_size || SECTION_PAGE_SIZE) >= pager.total) break;
        page++;
    }
    return out;
}

function detail(id) {
    var d = get('/videos/' + id);
    if (!d) return JSON.stringify({ list: [] });
    var froms = [], urls = [];
    listOf(d.play_from).forEach(function (line) {
        var code = (line && line.code ? line.code : '').trim();
        if (!code) return;
        var episodes = sections(id, code);
        if (!episodes.length) return;
        froms.push((line.title || code).trim());
        urls.push(episodes.join('#'));
    });
    var item = {
        vod_id: String(id),
        vod_name: text(d.title),
        vod_pic: d.cover_url || '',
        vod_year: d.year ? String(d.year) : '',
        vod_area: text(d.area),
        vod_remarks: text(d.remarks),
        vod_director: text(d.director),
        vod_actor: text(d.actor),
        vod_content: text(d.description),
        vod_play_from: froms.join('$$$'),
        vod_play_url: urls.join('$$$')
    };
    return JSON.stringify({ list: [item] });
}

function play(flag, id, flags) {
    var text = String(id), code = '', sectionId = text, cut = text.indexOf(':');
    if (cut > 0) {
        code = text.substring(0, cut);
        sectionId = text.substring(cut + 1);
    }
    if (!sectionId) return JSON.stringify({ parse: 0, url: '', msg: '无效的选集' });
    var r = auth('/v2/sections/' + encodeURIComponent(sectionId) + '/play-url', null, null);
    if (!r) return JSON.stringify({ parse: 0, url: '', msg: '取流需要登录：请在站点配置的 ext 里填 {"username":"…","password":"…"}（或 token）' });
    if (r.code !== 0) return JSON.stringify({ parse: 0, url: '', msg: '取流失败：' + (r.msg || r.code) });
    var d = r.data || {};
    if (!d.url) return JSON.stringify({ parse: 0, url: '', msg: '该集暂时没有可用视频' });
    return JSON.stringify({ parse: 0, url: d.url, header: { 'User-Agent': UA, 'Referer': HOST + '/' } });
}

function search(wd, quick, pg) {
    var page = parseInt(pg, 10) || 1;
    var d = get('/videos/search', { q: wd, page: page, page_size: PAGE_SIZE });
    var list = [];
    listOf(d).forEach(function (v) {
        var item = vod(v);
        if (item && item.vod_name) list.push(item);
    });
    var pager = pagerOf(d);
    return pageResult(list, page, pager && pager.total ? pager.total : list.length);
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
