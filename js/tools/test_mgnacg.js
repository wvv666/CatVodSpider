/*
 * 橘子动漫 mgnacg.com 源的验证台（打真站）
 *
 *   node js/tools/test_mgnacg.js
 *
 * 覆盖：分类/列表/分页/搜索/详情/选集顺序/取流（含 AES 解密 + 直链可播性探测）
 */
const https = require('https');
const { loadSpider, UA } = require('./host');

const spider = loadSpider('mgnacg.js');

let pass = 0, fail = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
    cond ? pass++ : fail++;
}

/* 用 Node 自带 https 跟随跳转取首段字节（MSYS 的 curl 连 pan.wo.cn 会 TLS 报错，所以这里不用 curl） */
function probe(url, headers, hops) {
    return new Promise(resolve => {
        hops = hops || 0;
        if (hops > 6) return resolve({ status: 'TOO_MANY_HOPS', url });
        const u = new URL(url);
        const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
            headers: Object.assign({ 'User-Agent': UA, 'Range': 'bytes=0-2047' }, headers || {}) }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const next = res.headers.location.startsWith('http') ? res.headers.location : (u.origin + res.headers.location);
                return resolve(probe(next, headers, hops + 1).then(r => Object.assign(r, { via: (r.via || []).concat(res.statusCode) })));
            }
            const chunks = [];
            res.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 4096) res.destroy(); });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], url: url,
                head: Buffer.concat(chunks).slice(0, 32), hops: hops }));
            res.on('error', () => resolve({ status: res.statusCode, type: res.headers['content-type'], url: url, head: Buffer.concat(chunks).slice(0, 32) }));
        });
        req.on('error', e => resolve({ status: 'ERR ' + e.message, url }));
        req.setTimeout(60000, () => { req.destroy(); resolve({ status: 'TIMEOUT', url }); });
        req.end();
    });
}

(async () => {
    spider.init({ skey: 'mgnacgtest', ext: '' });

    console.log('=== 1) home ===');
    const home = JSON.parse(spider.home());
    check('分类数 == 5', home.class.length === 5, home.class.map(c => c.type_name).join(' / '));

    console.log('\n=== 2) homeVod（首页列表）===');
    const hv = JSON.parse(spider.homeVod());
    check('列表 >= 10 条', hv.list.length >= 10, hv.list.length + ' 条');
    const first = hv.list[0];
    check('字段齐（id/name/pic）', !!(first && first.vod_id && first.vod_name && /^https?:/.test(first.vod_pic)), JSON.stringify(first).slice(0, 120));
    console.log('    样例：' + hv.list.slice(0, 3).map(v => v.vod_name + '[' + v.vod_remarks + ']').join(' | '));

    console.log('\n=== 3) category 动漫(tid=1) 第 1/2 页 ===');
    const c1 = JSON.parse(spider.category('1', '1', false, {}));
    check('第 1 页有数据（pagecount > 1）', c1.list.length > 0 && c1.pagecount > 1, `${c1.list.length} 条 / pagecount=${c1.pagecount} / total=${c1.total}`);
    const c2 = JSON.parse(spider.category('1', '2', false, {}));
    const n1 = c1.list.map(v => v.vod_id).join(','), n2 = c2.list.map(v => v.vod_id).join(',');
    check('第 2 页与第 1 页不同', n1 !== n2 && c2.list.length > 0, `第2页首条：${c2.list[0] && c2.list[0].vod_name}`);

    console.log('\n=== 4) category 剧场版(tid=2) ===');
    const c3 = JSON.parse(spider.category('2', '1', false, {}));
    check('剧场版有数据', c3.list.length > 0, c3.list[0] && c3.list[0].vod_name);
    check('剧场版与动漫不是同一批', c3.list[0] && c1.list[0] && c3.list[0].vod_id !== c1.list[0].vod_id);

    console.log('\n=== 5) search ===');
    const sr = JSON.parse(spider.search('进击', false));
    check('搜「进击」有结果', sr.list.length > 0, sr.list.length + ' 条：' + sr.list.slice(0, 3).map(v => v.vod_name).join(' / '));
    check('搜索结果带 id', !!(sr.list[0] && sr.list[0].vod_id));

    console.log('\n=== 6) detail ===');
    const vodId = c1.list[0].vod_id;
    const d = JSON.parse(spider.detail(vodId)).list[0];
    check('详情有返回', !!d, d && d.vod_name);
    check('片名非空', !!(d && d.vod_name && d.vod_name.length > 1), d && d.vod_name);
    check('封面是图片地址', !!(d && /^https?:.*\.(jpg|jpeg|png|webp)/i.test(d.vod_pic)), d && d.vod_pic);
    check('简介非空', !!(d && d.vod_content && d.vod_content.length > 10), d && (d.vod_content || '').slice(0, 50) + '…');
    check('状态/年份', !!(d && (d.vod_remarks || d.vod_year)), d && (d.vod_remarks + ' / ' + d.vod_year + ' / ' + d.type_name));
    const froms = (d.vod_play_from || '').split('$$$').filter(Boolean);
    const urls = (d.vod_play_url || '').split('$$$').filter(Boolean);
    check('线路数 >= 2', froms.length >= 2, froms.join(' / '));
    check('线路与选集一一对应', froms.length === urls.length, froms.length + ' vs ' + urls.length);
    const eps = (urls[0] || '').split('#').filter(Boolean);
    check('第 1 条线路有选集', eps.length > 0, eps.length + ' 集，例：' + eps[0]);
    check('选集是「名称$地址」', /^[^$]+\$\/bangumi\/\d+-\d+-\d+\/$/.test(eps[0]), eps[0]);
    const badOrder = urls.join('#').split('#').filter(e => !/^\d*[^\$]+\$\/bangumi\//.test(e));
    check('全部选集顺序正确', badOrder.length === 0, badOrder.slice(0, 2).join(' '));

    console.log('\n=== 7) play（取流 + AES 解密 + 直链探测）===');
    const epPath = eps[eps.length - 1].split('$')[1];
    console.log('    选中：' + eps[eps.length - 1].split('$')[0] + ' -> ' + epPath);
    const p = JSON.parse(spider.play(froms[0], epPath, []));
    check('返回可播地址', /^https?:/.test(p.url || ''), (p.url || p.msg || '').slice(0, 110));
    check('地址是 .mknvideo 直链', /\.mknvideo\?sign=/.test(p.url || ''), '');
    check('header 不带 Referer（pan.wo.cn 跳转必须）', !!(p.header && !p.header['Referer']), JSON.stringify(p.header || {}));
    if (p.url) {
        const r = await probe(p.url, {});
        console.log(`    探测：status=${r.status} type=${r.type} 跳转=${(r.via || []).join('>')}`);
        check('直链可播（2xx + MP4 容器）', /^2\d\d$/.test(String(r.status)) && r.head && r.head.slice(4, 8).toString('ascii') === 'ftyp',
            r.head ? r.head.slice(4, 12).toString('ascii') : String(r.status));
    }

    console.log('\n=== 8) 错误路径 ===');
    const bad = JSON.parse(spider.play('1', '/media/1/', []));
    check('不对的剧集地址优雅报错', bad.url === '' && !!bad.msg, bad.msg);

    console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
})();
