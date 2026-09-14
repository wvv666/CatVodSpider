/* Node 测试台：模拟 FongMi 的 quickjs 宿主，跑真实的 cycani.org 站点。
 *
 *   node js/tools/test_cycani.js
 *   CYC_USER=账号 CYC_PASS=密码 node js/tools/test_cycani.js   # 额外跑通取流（登录）
 *
 * 匿名部分（分类/列表/搜索/详情/选集）无需账号即可验证；取流必须登录，没给账号就只验证「优雅降级」。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMP = path.join(require('os').tmpdir(), 'cyc_req.bin');

/* ---- 宿主注入：req(url, options) ---- */
function req(url, options) {
    const o = options || {};
    const args = ['-s', '-L', '--max-time', '40', '-o', TMP];
    const h = Object.assign({ 'User-Agent': UA }, o.headers || {});
    for (const k in h) args.push('-H', k + ': ' + h[k]);
    if (String(o.method || 'get').toLowerCase() === 'post') {
        args.push('-X', 'POST');
        args.push('--data', o.body === undefined || o.body === null ? '' : o.body);
    }
    args.push(url);
    try {
        execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024 });
        return { code: 200, headers: {}, content: fs.readFileSync(TMP).toString('utf8') };
    } catch (e) {
        return { code: 500, headers: {}, content: '' };
    }
}

/* ---- 宿主注入：local.get/set/delete（内存版） ---- */
const STORE = {};
const local = {
    get: (rule, key) => STORE[rule + '_' + key] || '',
    set: (rule, key, value) => { STORE[rule + '_' + key] = value; },
    delete: (rule, key) => { delete STORE[rule + '_' + key]; }
};

/* ---- 载入源 ---- */
const src = fs.readFileSync(path.join(__dirname, '..', 'cycani.js'), 'utf8').replace(/\bexport\s+function\b/g, 'function');
const spider = new Function('req', 'local', src + '\nreturn __jsEvalReturn();')(req, local);

let pass = 0, fail = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
    cond ? pass++ : fail++;
}

const USER = process.env.CYC_USER || '';
const PASS = process.env.CYC_PASS || '';
const TOKEN = process.env.CYC_TOKEN || '';

console.log('=== 1) init + home ===');
const ext = TOKEN ? JSON.stringify({ token: TOKEN }) : (USER && PASS ? JSON.stringify({ username: USER, password: PASS }) : '');
spider.init({ skey: 'cyctest', ext: ext });
const home = JSON.parse(spider.home());
check('分类数 >= 5', home.class.length >= 5, home.class.length + ' 个：' + home.class.slice(0, 4).map(c => c.type_name).join(' / '));
check('含追番周表', home.class.some(c => c.type_id === 'weekday'));
check('含分区（来自 /video-zones）', home.class.some(c => c.type_id.startsWith('zone:')));
check('含排行（来自 /ranks）', home.class.some(c => c.type_id.startsWith('rank:')));
check('含推荐（来自 /index/recommend）', home.class.some(c => c.type_id.startsWith('rec:')));
const zoneTid = home.class.find(c => c.type_id.startsWith('zone:')).type_id;
const zoneFilters = home.filters[zoneTid] || [];
check('分区带筛选（题材/年份）', zoneFilters.length >= 1, zoneFilters.map(f => f.name + '×' + f.value.length).join(' | '));

console.log('\n=== 2) homeVod（首页推荐）===');
const hv = JSON.parse(spider.homeVod());
check('拿到条目', hv.list.length > 0, hv.list.length + ' 条 | 首条=' + (hv.list[0] || {}).vod_name);
check('有封面和图注', !!(hv.list[0].vod_pic && hv.list[0].vod_remarks), String(hv.list[0].vod_pic).slice(0, 48));

console.log('\n=== 3) category（各分类）===');
const recTid = home.class.find(c => c.type_id.startsWith('rec:')).type_id;
const rankTid = home.class.find(c => c.type_id.startsWith('rank:')).type_id;
const c1 = JSON.parse(spider.category(zoneTid, '1', false, {}));
check('分区第 1 页有条目', c1.list.length > 0, c1.list.length + ' 条 | total=' + c1.total + ' | 首条=' + c1.list[0].vod_name);
check('分页信息合理', c1.page === 1 && c1.pagecount >= 1, 'page=' + c1.page + ' pagecount=' + c1.pagecount + ' limit=' + c1.limit);
const c2 = JSON.parse(spider.category(zoneTid, '2', false, {}));
check('第 2 页与第 1 页不同', c2.list.length > 0 && c2.list[0].vod_id !== c1.list[0].vod_id, c2.list[0].vod_name);
const cf = JSON.parse(spider.category(zoneTid, '1', false, { tag: '异世界' }));
check('题材筛选生效', cf.list.length > 0, cf.list[0].vod_name);
const cy = JSON.parse(spider.category(zoneTid, '1', false, { year: '2025' }));
check('年份筛选生效', cy.list.length > 0, cy.list[0].vod_name + ' (' + cy.list[0].vod_year + ')');
const co = JSON.parse(spider.category(zoneTid, '1', false, { order_by: 'score' }));
check('排序参数生效', co.list.length > 0, '首个=' + co.list[0].vod_name);
const cr = JSON.parse(spider.category(recTid, '1', false, {}));
check('推荐分类有条目', cr.list.length > 0, cr.list.length + ' 条');
const ck = JSON.parse(spider.category(rankTid, '1', false, {}));
check('排行分类有条目', ck.list.length > 0, ck.list.length + ' 条');
const cw = JSON.parse(spider.category('weekday', '1', false, {}));
check('追番周表有条目', cw.list.length > 0, cw.list.length + ' 条');

console.log('\n=== 4) detail（详情 + 线路 + 选集）===');
const detailId = c1.list[0].vod_id;
const d = JSON.parse(spider.detail(detailId));
const vod = d.list[0];
check('片名', !!vod.vod_name, vod.vod_name);
check('海报', /^https?:/.test(vod.vod_pic), String(vod.vod_pic).slice(0, 48));
check('简介非空', (vod.vod_content || '').length > 10, String(vod.vod_content).slice(0, 36) + '...');
const fromLines = String(vod.vod_play_from).split('$$$');
const urlLines = String(vod.vod_play_url).split('$$$');
check('暴露线路（播放器可切换）', fromLines.length >= 1 && fromLines[0] !== '', fromLines.join(' | '));
check('线路数与选集组数一致', fromLines.length === urlLines.length, fromLines.length + ' / ' + urlLines.length);
const firstEps = urlLines[0].split('#');
check('选集可解析（名称$地址）', /^\$/.test(firstEps[0].slice(firstEps[0].indexOf('$'))) && firstEps[0].indexOf('$') > 0, firstEps[0]);
check('选集地址带线路 code（取流要用）', /:\d+$/.test(firstEps[0]), firstEps[0].slice(firstEps[0].indexOf('$') + 1));
const playId = firstEps[0].slice(firstEps[0].indexOf('$') + 1);
const playFlag = fromLines[0];

console.log('\n=== 5) search（搜索，匿名可用）===');
const s = JSON.parse(spider.search('进击的巨人', false, '1'));
check('搜到结果', s.list.length > 0, s.list.length + ' 条 | 首条=' + s.list[0].vod_name);
check('搜索结果能直接进详情', /^\d+$/.test(s.list[0].vod_id), 'vod_id=' + s.list[0].vod_id);
const s2 = JSON.parse(spider.search('进击的巨人', false, '2'));
check('搜索分页与首页不同', s2.list.length === 0 || s2.list[0].vod_id !== s.list[0].vod_id, '第 2 页首条=' + (s2.list[0] || {}).vod_name);

console.log('\n=== 6) play（取流）===');
const p = JSON.parse(spider.play(playFlag, playId, []));
const hasCreds = !!(TOKEN || (USER && PASS));
if (hasCreds) {
    check('带账号/令牌时取到播放地址', /^https?:/.test(p.url || ''), String(p.url).slice(0, 96));
    check('播放地址带签名（expires/md5）', /[?&](expires|md5)=/.test(p.url || '') || /\.m3u8/.test(p.url || ''), (String(p.url).match(/[?&][a-z]+=/g) || []).join(' '));
    check('回传 header', !!(p.header && p.header['User-Agent']), JSON.stringify(p.header || {}));
    if (p.url) {
        const head = execFileSync('curl', ['-s', '-I', '-L', '--max-time', '30', '-A', UA, '-H', 'Referer: https://www.cycani.org/', '-o', '-', '-w', 'HTTP=%{http_code} TYPE=%{content_type} SIZE=%{size_download}', p.url], { maxBuffer: 8 * 1024 * 1024 }).toString();
        console.log('  · 播放地址探测（HEAD）：' + head.split('\n').slice(-1)[0]);
    }
} else {
    check('没填账号时提示「未配置账号」', p.url === '' && /未配置账号/.test(p.msg || ''), p.msg);
    console.log('  · 填 CYC_USER / CYC_PASS 环境变量可额外验证取流');
    // 填了错的账号：应当把服务端的失败原因带出来（证明登录链路真的在跑，而不是静默失败）
    spider.init({ skey: 'cyctest', ext: JSON.stringify({ username: '__hermes_probe__', password: 'invalid-probe' }) });
    const bad = JSON.parse(spider.play(playFlag, playId, []));
    check('填错账号时提示具体失败原因', bad.url === '' && /登录失败/.test(bad.msg || ''), bad.msg);
    spider.init({ skey: 'cyctest', ext: ext });
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
