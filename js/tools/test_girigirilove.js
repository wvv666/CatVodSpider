/*
 * girigiri愛動漫 ani.girigirilove.com 源的验证台（打真站）
 *
 *   node js/tools/test_girigirilove.js
 *
 * 覆盖：分类/列表/分页/搜索/详情/多线路选集/取流（base64 解码 + m3u8 可播 + 分片）+ 弹幕 xml 挂载
 */
const { loadSpider, probe, UA } = require('./host');

const spider = loadSpider('girigirilove.js');

let pass = 0, fail = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
    cond ? pass++ : fail++;
}

(async () => {
    spider.init({ skey: 'giritest', ext: '' });

    console.log('=== 1) home（分类）===');
    const home = JSON.parse(spider.home());
    check('分类数 == 5', home.class.length === 5, home.class.map(c => c.type_name).join(' / '));
    check('含「日番」(tid=2)', home.class.some(c => c.type_id === '2' && c.type_name === '日番'));

    console.log('\n=== 2) homeVod（最新）===');
    const hv = JSON.parse(spider.homeVod());
    check('列表 >= 20 条', hv.list.length >= 20, hv.list.length + ' 条');
    const f0 = hv.list[0];
    check('字段齐（id/name/pic）', !!(f0 && f0.vod_id && f0.vod_name && /^https?:/.test(f0.vod_pic)), JSON.stringify(f0).slice(0, 130));
    check('封面是可访问的站内图', /^https:\/\/ani\.girigirilove\.com\/upload\//.test(f0.vod_pic), f0.vod_pic);
    console.log('    样例：' + hv.list.slice(0, 3).map(v => v.vod_name + '[' + v.vod_remarks + ']').join(' | '));

    console.log('\n=== 3) category 日番(tid=2) 第 1/2 页 ===');
    const c1 = JSON.parse(spider.category('2', '1', false, {}));
    check('第 1 页有数据', c1.list.length > 0, `${c1.list.length} 条 / pagecount=${c1.pagecount}`);
    check('每页约 48 条', c1.list.length >= 40 && c1.list.length <= 60, c1.list.length + ' 条');
    const c2 = JSON.parse(spider.category('2', '2', false, {}));
    const i1 = c1.list.map(v => v.vod_id).join(',');
    const i2 = c2.list.map(v => v.vod_id).join(',');
    check('第 2 页与第 1 页不同', i1 !== i2 && c2.list.length > 0, `第2页首条：${c2.list[0] && c2.list[0].vod_name}`);
    check('条目带选集状态', !!(c1.list[0] && c1.list[0].vod_remarks), c1.list[0].vod_remarks);

    console.log('\n=== 4) category 美番(3) / 劇場版(21) / 真人番劇(20) ===');
    const c3 = JSON.parse(spider.category('3', '1', false, {}));
    check('美番有数据', c3.list.length > 0, `${c3.list.length} 条，例：${c3.list[0] && c3.list[0].vod_name}`);
    const c21 = JSON.parse(spider.category('21', '1', false, {}));
    check('劇場版有数据', c21.list.length > 0, `${c21.list.length} 条，例：${c21.list[0] && c21.list[0].vod_name}`);
    check('劇場版与日番不是同一批', c21.list[0].vod_id !== c1.list[0].vod_id);
    const c20 = JSON.parse(spider.category('20', '1', false, {}));
    check('真人番劇有数据', c20.list.length > 0, `${c20.list.length} 条`);

    console.log('\n=== 5) search（走 suggest）===');
    const sr = JSON.parse(spider.search('海贼', false));
    check('搜「海贼」有结果', sr.list.length > 0, sr.list.length + ' 条：' + sr.list.slice(0, 3).map(v => v.vod_name).join(' / '));
    check('结果带 id 与封面', !!(sr.list[0] && sr.list[0].vod_id && /^https?:/.test(sr.list[0].vod_pic)), sr.list[0] && sr.list[0].vod_pic);
    const sr2 = JSON.parse(spider.search('恋', false));
    check('宽泛词命中更多', sr2.list.length > sr.list.length, `${sr2.list.length} 条`);
    check('空词返回空表', JSON.parse(spider.search('', false)).list.length === 0);

    console.log('\n=== 6) detail ===');
    const vodId = c1.list[0].vod_id;
    const d = JSON.parse(spider.detail(vodId)).list[0];
    check('详情有返回', !!d, d && d.vod_name);
    check('片名非空', !!(d && d.vod_name && d.vod_name.length > 1), d && d.vod_name);
    check('封面是图片地址', !!(d && /^https?:\/\/ani\.girigirilove\.com\/upload\/.+\.(jpg|jpeg|png|webp)$/i.test(d.vod_pic)), d && d.vod_pic);
    check('简介非空', !!(d && d.vod_content && d.vod_content.length > 10), d && (d.vod_content || '').slice(0, 46) + '…');
    check('状态/年份/类型', !!(d && (d.vod_remarks || d.vod_year) && d.type_name), d && `${d.vod_remarks} / ${d.vod_year} / ${d.type_name} / ${d.vod_area}`);
    const froms = (d.vod_play_from || '').split('$$$').filter(Boolean);
    const urls = (d.vod_play_url || '').split('$$$').filter(Boolean);
    check('线路数 >= 1', froms.length >= 1, froms.join(' / '));
    check('线路与选集一一对应', froms.length === urls.length, froms.length + ' vs ' + urls.length);
    check('线路名是中文页签名', froms.every(n => /[\u4e00-\u9fa5]/.test(n)), froms.join(' / '));
    const eps = (urls[0] || '').split('#').filter(Boolean);
    check('第 1 条线路有选集', eps.length > 0, `${eps.length} 集，例：${eps[0]}`);
    check('选集是「名称$地址」', /^[^$]+\$\/playGV\d+-\d+-\d+\/$/.test(eps[0]), eps[0]);
    const badOrder = urls.join('#').split('#').filter(e => !/^\d*[^\$]+\$\/playGV\d+-\d+-\d+\/$/.test(e));
    check('没有「地址$名称」写反的条目', badOrder.length === 0, badOrder.slice(0, 2).join(' | ') || 'ok');

    console.log('\n=== 7) play：base64 解码 + 直链 ===');
    const epPath = eps[0].split('$')[1];
    const p1 = JSON.parse(spider.play(froms[0], epPath, []));
    check('返回 parse=0', p1.parse === 0, JSON.stringify(p1).slice(0, 150));
    check('解出 akua 直链', /^https:\/\/akua\.girigirilove\.com\/.+\.m3u8$/.test(p1.url || ''), p1.url);
    check('回传 UA（不带 Referer）', !!(p1.header && p1.header['User-Agent'] && !p1.header['Referer']), JSON.stringify(p1.header));

    console.log('\n=== 8) m3u8 / 分片 可播性 ===');
    if (!/^https?:\/\//.test(p1.url || '')) {
        check('m3u8 可播性（取流成功后才能测）', false, '取流没拿到地址，跳过');
    } else {
        /* probe() 带 Range: bytes=0-2047，所以 200/206 都算正常 */
        const m = await probe(p1.url, { 'User-Agent': UA });
        check('m3u8 可取（200/206）', m.status === 200 || m.status === 206, `${m.status} ${m.type}`);
        check('首字节是 #EXTM3U', String(m.head).indexOf('#EXTM3U') === 0, JSON.stringify(String(m.head).slice(0, 24)));
        const segUrl = p1.url.replace(/\/playlist\.m3u8$/, '/0000.ts');
        const seg = await probe(segUrl, { 'User-Agent': UA });
        check('分片可取且是视频流', (seg.status === 200 || seg.status === 206) && /video|octet-stream/.test(seg.type || ''), `${seg.status} ${seg.type}`);
    }

    console.log('\n=== 9) 弹幕 xml（只挂繁中线路）===');
    check('繁中线路挂了弹幕', !!(p1.danmaku && p1.danmaku.length), JSON.stringify(p1.danmaku));
    if (p1.danmaku && p1.danmaku.length) {
        const dm = await probe(p1.danmaku[0].url, { 'User-Agent': UA });
        check('弹幕 xml 可取（200/206）', dm.status === 200 || dm.status === 206, `${dm.status} ${dm.type}`);
        check('弹幕地址由 m3u8 推出', p1.danmaku[0].url === p1.url.replace(/\/([^\/]+)\/playlist\.m3u8$/, '/$1.xml'), p1.danmaku[0].url);
    }
    /* 简中线路：挑一部有第二条线路的番验证「不挂弹幕」 */
    let chsChecked = false;
    for (const v of c1.list.slice(0, 6)) {
        const dd = JSON.parse(spider.detail(v.vod_id)).list[0];
        if (!dd) continue;
        const fs = (dd.vod_play_from || '').split('$$$').filter(Boolean);
        const us = (dd.vod_play_url || '').split('$$$').filter(Boolean);
        if (fs.length < 2) continue;
        const ep2 = us[1].split('#')[0].split('$')[1];
        const p2 = JSON.parse(spider.play(fs[1], ep2, []));
        if (!/^https:/.test(p2.url || '')) continue;
        const isCht = p2.url.indexOf('/cht/') >= 0;
        check(`第 2 线路（${fs[1]}${isCht ? '' : '，非 /cht/ 路径'}）${isCht ? '有' : '无'}弹幕`, isCht ? !!(p2.danmaku && p2.danmaku.length) : !p2.danmaku, (p2.danmaku ? '已挂' : '未挂') + ' | ' + p2.url.slice(-46));
        chsChecked = true;
        break;
    }
    if (!chsChecked) console.log('  - 跳过：样本里没找到双线路番');

    console.log('\n=== 10) 弹幕开关 ext={"danmaku":"0"} ===');
    spider.init({ skey: 'giritest', ext: '{"danmaku":"0"}' });
    const p3 = JSON.parse(spider.play(froms[0], epPath, []));
    check('关掉后不挂弹幕', !p3.danmaku, (p3.danmaku ? '仍挂了' : '已关'));
    check('关掉后仍能取流', /^https:\/\//.test(p3.url || ''), (p3.url || '').slice(-40));
    spider.init({ skey: 'giritest', ext: '' });

    console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
})();
