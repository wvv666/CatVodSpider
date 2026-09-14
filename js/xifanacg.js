/*
 * 稀饭动漫 Next next.xifanacg.com —— TVBox / FongMi 影视源（js 源）
 *
 * 站点形态：Next.js（SSR + Supabase 后端），所有数据都走 Supabase（PostgREST + Edge Function），
 *          所以本源**不抠 HTML**，全部走官方接口（比解析页面稳）。
 *
 * 接口（实测）：
 *   列表/搜索  POST {SB}/rest/v1/rpc/search_animes
 *              body: {search_term, page_number, items_per_page, sort_by, sort_order,
 *                     filter_type_id, filter_meta_tags, filter_is_finished, filter_format,
 *                     filter_release_year, filter_only_published}
 *              返回数组，每行带 total_count（总条数）、id/title/cover_url/description/... 全字段
 *              排序取值实测：updated_at / view_count / bangumi_score
 *   详情      GET {SB}/rest/v1/animes?id=eq.{id}
 *   剧集      GET {SB}/rest/v1/episodes?anime_id=eq.{id}&select=id,episode_number,title,kind&order=episode_number
 *   取流      POST {SB}/functions/v1/issue-web-playback?forceFunctionRegion=ap-southeast-1
 *              body: {"action":"auto","episode_id":N} -> {ok, url(HLS 主播放列表), expires_at, ...}
 *              返回的 url 直接可播（实测返回 #EXTM3U），有效期约 30 分钟
 *   弹幕①站内 POST {SB}/rest/v1/rpc/get_danmaku_page  {p_episode_id, p_after_id, p_limit}
 *              -> [{id, v_time, content, color, mode}]（游标分页，站点上限 8000 条）
 *   弹幕②外部 POST {SB}/functions/v1/sync-dandan-mapping {anime_id, episode_id}
 *              -> {dandan_anime_id, dandan_episode_id}
 *              GET https://ext-danmaku.moedot.net/api/v2/comment/{dandan_episode_id}?withRelated=true&chConvert=1
 *              -> {count, comments:[{cid,p,m}]}（弹弹play 格式，p = "时间,类型,大小,颜色"）
 *
 * 弹幕挂载：本源把「弹弹play 那一路」按宿主 Result.danmaku 的格式挂上（[{name,url}]）。
 *           如果你的播放器不认弹弹play JSON（没弹幕或报错），把站点 ext 设成 {"danmaku":"0"} 关掉即可。
 *           站内弹幕是 POST RPC，无法作为弹幕文件 URL 交给播放器，只在文档里说明。
 *
 * 依赖宿主注入：req(url, options)（FongMi quickjs 层）
 */
var SB = 'https://rzmsnqblptbceicadbyd.supabase.co';
var KEY = 'sb_publishable_aCb7uwyLN6H-sMjze4dRGA_2MDuROLF';
var EXT_DANMAKU = 'https://ext-danmaku.moedot.net';
var SITE = 'https://next.xifanacg.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var RULE = 'xifanacg';
var PAGE_SIZE = 24;
var CONF = {};
var CACHE = {};

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

function headers() {
    return {
        'User-Agent': UA,
        'Accept': 'application/json',
        'apikey': KEY,
        'Authorization': 'Bearer ' + KEY,
        'Origin': SITE,
        'Referer': SITE + '/'
    };
}

function post(url, body) {
    var h = headers();
    h['Content-Type'] = 'application/json';
    var res = req(url, { method: 'post', headers: h, body: JSON.stringify(body) });
    if (!res || res.code !== 200) return null;
    try { return JSON.parse(res.content); } catch (e) { return null; }
}

function getJson(url, extra) {
    var h = headers();
    if (extra) for (var k in extra) h[k] = extra[k];
    var res = req(url, { headers: h });
    if (!res || res.code !== 200) return null;
    try { return JSON.parse(res.content); } catch (e) { return null; }
}

function rpc(name, body) {
    return post(SB + '/rest/v1/rpc/' + name, body || {});
}

/* ============================ 列表 ============================ */

function remarksOf(it) {
    var out = [];
    var cur = it.current_episodes, total = it.total_episodes;
    if (it.is_finished) out.push(total ? ('全 ' + total + ' 集') : '完结');
    else if (cur) out.push('更新至 ' + cur + (total ? ' / ' + total : ' 集'));
    else if (total) out.push(total + ' 集');
    if (it.bangumi_score) out.push(Number(it.bangumi_score).toFixed(1) + ' 分');
    return out.join(' · ');
}

function vodOf(it) {
    if (!it || it.id === undefined) return null;
    return {
        vod_id: String(it.id),
        vod_name: text(it.title),
        vod_pic: it.cover_url || '',
        vod_remarks: remarksOf(it),
        vod_year: it.release_year ? String(it.release_year) : '',
        type_name: text(it.anime_type || it.format || '')
    };
}

function query(kwargs) {
    var body = { page_number: 1, items_per_page: PAGE_SIZE };
    for (var k in kwargs) if (kwargs[k] !== undefined && kwargs[k] !== null) body[k] = kwargs[k];
    var arr = rpc('search_animes', body);
    if (!arr || !arr.length) return { list: [], total: 0, pagecount: 1 };
    var list = [];
    for (var i = 0; i < arr.length; i++) {
        var v = vodOf(arr[i]);
        if (v) list.push(v);
    }
    var total = Number(arr[0].total_count || list.length);
    return { list: list, total: total, pagecount: Math.ceil(total / body.items_per_page) };
}

function home() {
    return JSON.stringify({
        class: [
            { type_id: 'list:{}', type_name: '全部番剧' },
            { type_id: 'list:{"sort_by":"updated_at"}', type_name: '最近更新' },
            { type_id: 'list:{"sort_by":"view_count"}', type_name: '热门' },
            { type_id: 'list:{"sort_by":"bangumi_score"}', type_name: '高分' },
            { type_id: 'list:{"filter_format":"tv"}', type_name: 'TV动画' },
            { type_id: 'list:{"filter_format":"movie"}', type_name: '剧场版' },
            { type_id: 'list:{"filter_is_finished":true}', type_name: '完结番' }
        ]
    });
}

function homeVod() {
    return JSON.stringify({ list: query({ sort_by: 'updated_at' }).list });
}

function kvOf(tid) {
    var s = String(tid || '');
    var i = s.indexOf(':');
    if (i < 0) return {};
    try { return JSON.parse(s.substring(i + 1)) || {}; } catch (e) { return {}; }
}

function category(tid, pg, filter, extend) {
    var page = parseInt(pg || 1, 10) || 1;
    var kwargs = kvOf(tid);
    kwargs.page_number = page;
    kwargs.items_per_page = PAGE_SIZE;
    var r = query(kwargs);
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
    var r = query({ search_term: wd });
    return JSON.stringify({ list: r.list });
}

/* ============================ 详情 ============================ */

function detail(id) {
    var vid = String(id || '').replace(/[^0-9]/g, '');
    if (!vid) return JSON.stringify({ list: [] });
    var arr = getJson(SB + '/rest/v1/animes?id=eq.' + vid + '&limit=1');
    var a = (arr && arr[0]) || null;
    if (!a) return JSON.stringify({ list: [] });
    var eps = getJson(SB + '/rest/v1/episodes?anime_id=eq.' + vid +
        '&select=id,episode_number,title,kind&order=episode_number&limit=2000') || [];
    var items = [];
    for (var i = 0; i < eps.length; i++) {
        var e = eps[i];
        if (!e || e.id === undefined) continue;
        var nm = text(e.title) || ('第' + (e.episode_number || (i + 1)) + '集');
        /* 剧集地址同时带上 anime_id，取流与弹幕映射都要用 */
        items.push(nm + '$' + e.id + '|' + vid);
    }
    if (!items.length) return JSON.stringify({ list: [] });
    var tags = text(a.meta_tags || ''), actors = text(a.actors || ''), director = text(a.director || '');
    var metas = [];
    if (a.release_year) metas.push(String(a.release_year));
    if (a.format) metas.push(text(a.format));
    if (a.view_count) metas.push(Number(a.view_count) + ' 次播放');
    if (a.bangumi_score) metas.push('评分 ' + Number(a.bangumi_score).toFixed(1));
    return JSON.stringify({
        list: [{
            vod_id: vid,
            vod_name: text(a.title),
            vod_pic: a.cover_url || '',
            vod_year: a.release_year ? String(a.release_year) : '',
            vod_area: text(a.country_of_origin || '日本'),
            vod_remarks: remarksOf(a),
            type_name: tags || text(a.anime_type || ''),
            vod_content: [
                text(a.description),
                director ? '导演：' + director : '',
                actors ? '声优：' + actors : ''
            ].filter(Boolean).join('\n'),
            vod_play_from: '稀饭动漫',
            vod_play_url: items.join('#')
        }]
    });
}

/* ============================ 弹幕 ============================ */

function dandanUrl(animeId, episodeId) {
    var m = post(SB + '/functions/v1/sync-dandan-mapping', { anime_id: Number(animeId), episode_id: Number(episodeId) });
    if (!m || !m.ok || !m.dandan_episode_id) return '';
    /* 先试一下有没有弹幕，避免给播放器挂一个空文件 */
    var url = EXT_DANMAKU + '/api/v2/comment/' + m.dandan_episode_id + '?withRelated=true&chConvert=1';
    var res = req(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': SITE + '/' } });
    if (res && res.code === 200) {
        try {
            var d = JSON.parse(res.content);
            if (d && Number(d.count) > 0) return url;
        } catch (e) {
        }
    }
    return '';
}

/* ============================ 取流 ============================ */

function play(flag, id, flags) {
    var parts = String(id || '').split('|');
    var episodeId = parts[0] ? parts[0].replace(/[^0-9]/g, '') : '';
    var animeId = parts[1] ? parts[1].replace(/[^0-9]/g, '') : '';
    if (!episodeId) return JSON.stringify({ parse: 0, url: '', msg: '剧集地址不对：' + id });
    var r = post(SB + '/functions/v1/issue-web-playback?forceFunctionRegion=ap-southeast-1',
        { action: 'auto', episode_id: Number(episodeId) });
    if (!r || !r.url) return JSON.stringify({ parse: 0, url: '', msg: '取流失败：站点没有下发播放地址' });
    var out = {
        parse: 0,
        url: r.url,
        header: { 'User-Agent': UA }
    };
    var dm = (CONF.danmaku === 0 || CONF.danmaku === '0' || CONF.danmaku === false) ? '' : (animeId ? dandanUrl(animeId, episodeId) : '');
    if (dm) out.danmaku = [{ name: '弹弹play', url: dm }];
    return JSON.stringify(out);
}

/* ============================ 导出 ============================ */

function init(ext) {
    CONF = {};
    var raw = ext && ext.ext !== undefined ? ext.ext : ext;
    if (raw && typeof raw === 'object') {
        CONF = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
        try { CONF = JSON.parse(raw.trim()); } catch (e) { CONF = {}; }
    }
    if (CONF.key) KEY = String(CONF.key);
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
