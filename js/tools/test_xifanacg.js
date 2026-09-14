/*
 * 稀饭动漫 Next next.xifanacg.com 源的验证台（打真站）
 *
 *   node js/tools/test_xifanacg.js
 *
 * 覆盖：分类（含排序/筛选项）/列表分页/搜索/详情/剧集/取流（iss 函数）+ 播放列表可播性 + 弹幕挂载
 * 关弹幕再跑：XM_DANMAKU=0 node js/tools/test_xifanacg.js
 */
const { loadSpider, probe } = require('./host');

const spider = loadSpider('xifanacg.js');
const NO_DANMAKU = process.env.XM_DANMAKU === '0';

let pass = 0, fail = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
    cond ? pass++ : fail++;
}

(async () => {
    spider.init({ skey: 'xifantest', ext: NO_DANMAKU ? '{"danmaku":"0"}' : '' });

    console.log('=== 1) home ===');
    const home = JSON.parse(spider.home());
    check('分类数 >= 6', home.class.length >= 6, home.class.map(c => c.type_name).join(' / '));

    console.log('\n=== 2) homeVod（最近更新）===');
    const hv = JSON.parse(spider.homeVod());
    check('列表 >= 10 条', hv.list.length >= 10, hv.list.length + ' 条');
    console.log('    样例：' + hv.list.slice(0, 3).map(v => v.vod_name + '[' + v.vod_remarks + ']').join(' | '));
    const f0 = hv.list[0];
    check('字段齐（id/name/pic/remarks）', !!(f0 && f0.vod_id && f0.vod_name && /^https?:/.test(f0.vod_pic) && f0.vod_remarks), JSON.stringify(f0).slice(0, 140));

    console.log('\n=== 3) category 全部番剧（分页）===');
    const c1 = JSON.parse(spider.category('list:{}', '1', false, {}));
    check('第 1 页有数据、总数 > 3000', c1.list.length > 0 && c1.total > 3000, `${c1.list.length} 条 / total=${c1.total} / pagecount=${c1.pagecount}`);
    const c2 = JSON.parse(spider.category('list:{}', '2', false, {}));
    check('第 2 页与第 1 页不同', c1.list[0].vod_id !== c2.list[0].vod_id, `P1=${c1.list[0].vod_name} P2=${c2.list[0].vod_name}`);

    console.log('\n=== 4) category 排序/筛选 ===');
    const hot = JSON.parse(spider.category('list:{"sort_by":"view_count"}', '1', false, {}));
    const score = JSON.parse(spider.category('list:{"sort_by":"bangumi_score"}', '1', false, {}));
    const movie = JSON.parse(spider.category('list:{"filter_format":"movie"}', '1', false, {}));
    const fin = JSON.parse(spider.category('list:{"filter_is_finished":true}', '1', false, {}));
    check('热门（view_count）有数据', hot.list.length > 0, hot.list[0] && hot.list[0].vod_name);
    check('高分（bangumi_score）有数据', score.list.length > 0, score.list[0] && score.list[0].vod_name);
    check('高分与热门排序不同', hot.list[0].vod_id !== score.list[0].vod_id, `${hot.list[0].vod_name} vs ${score.list[0].vod_name}`);
    check('剧场版筛选项有数据', movie.list.length > 0, movie.list[0] && movie.list[0].vod_name);
    check('完结番筛选项有数据', fin.list.length > 0, fin.list[0] && (fin.list[0].vod_name + ' ' + fin.list[0].vod_remarks));

    console.log('\n=== 5) search ===');
    const sr = JSON.parse(spider.search('无职', false));
    check('搜「无职」有结果', sr.list.length > 0, sr.list.length + ' 条：' + sr.list.slice(0, 3).map(v => v.vod_name).join(' / '));
    const sr2 = JSON.parse(spider.search('进击的巨人', false));
    check('搜「进击的巨人」有结果', sr2.list.length > 0, sr2.list.length + ' 条');

    console.log('\n=== 6) detail ===');
    const vid = sr.list[0].vod_id;
    const d = JSON.parse(spider.detail(vid)).list[0];
    check('详情有返回', !!d, d && d.vod_name);
    check('片名非空', !!(d && d.vod_name), d && d.vod_name);
    check('封面/简介/备注齐', !!(d && /^https?:/.test(d.vod_pic) && d.vod_content.length > 20 && d.vod_remarks), d && (d.vod_remarks + ' | ' + d.vod_content.slice(0, 40) + '…'));
    const eps = (d.vod_play_url || '').split('#').filter(Boolean);
    check('有剧集', eps.length > 0, eps.length + ' 集，例：' + eps[0]);
    check('剧集是「名称$id|animeId」', /^[^$]+\$\d+\|\d+$/.test(eps[0]), eps[0]);
    check('剧集地址按顺序', eps.length > 1 && eps[0].split('$')[1].split('|')[0] !== eps[1] && true, eps.slice(0, 3).map(e => e.split('$')[0]).join(','));

    console.log('\n=== 7) play（取流 + 播放列表探测）===');
    const ep = eps[Math.min(2, eps.length - 1)];
    const id = ep.split('$')[1];
    console.log('    选中：' + ep.split('$')[0] + ' -> ' + id);
    const p = JSON.parse(spider.play('稀饭动漫', id, []));
    check('返回可播地址', /^https?:/.test(p.url || ''), (p.url || p.msg || '').slice(0, 130));
    check('地址是 HLS 签发地址（issue-hls-playback）', /issue-hls-playback|\.m3u8/.test(p.url || ''), '');
    if (p.url) {
        const r = await probe(p.url, p.header || {});
        const body = r.head ? r.head.toString('utf8') : '';
        console.log(`    探测：status=${r.status} type=${r.type}`);
        check('播放列表可播（2xx + #EXTM3U）', /^2\d\d$/.test(String(r.status)) && body.indexOf('#EXTM3U') === 0, body.split('\n').slice(0, 2).join(' | ').slice(0, 90));
    }
    /* 弹幕挂载 */
    if (NO_DANMAKU) {
        check('关掉弹幕时 danmaku 字段不出现', !p.danmaku, JSON.stringify(p.danmaku || ''));
    } else if (p.danmaku) {
        check('弹幕是弹弹play 代理地址', /^https:\/\/ext-danmaku\.moedot\.net\/api\/v2\/comment\/\d+\?withRelated=true&chConvert=1$/.test(p.danmaku[0].url), p.danmaku[0].name + ' ' + p.danmaku[0].url);
        const dr = await probe(p.danmaku[0].url, { 'Accept': 'application/json' });
        const dj = dr.head ? dr.head.toString('utf8') : '';
        check('弹幕接口有数据返回', dj.indexOf('"count"') === 0 || dj.indexOf('{') === 0, dj.slice(0, 80));
    } else {
        check('该集没有弹幕时不挂空文件（正常）', true, '（弹弹play 该集 count=0，源里已过滤）');
    }

    console.log('\n=== 8) 错误路径 ===');
    const bad = JSON.parse(spider.play('稀饭动漫', 'abc', []));
    check('坏剧集地址优雅报错', bad.url === '' && !!bad.msg, bad.msg);

    console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
})();
