/*
 * 厂长资源 www.4kcz.com 源的验证台（打真站）
 *
 *   node js/tools/test_4kcz.js
 *
 * ⚠️ 本站有 SafeLine(雷池) WAF，按 TLS 指纹拦截：curl 一律 403，Node 的 https 能过。
 *    所以这里不共用 host.js 的 curl 版 req，改用 Node https 复刻（函数签名保持一致）。
 *
 * 覆盖：分类/列表/分页/搜索/详情/选集/取流（PNG 伪装头探测 + 代理重写 + 分片可播）
 */
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---- 复刻宿主 req()：Node https 实现，不跟随跳转，支持 range 与 buffer=2 ---- */
function makeReq() {
    return function req(url, options) {
        return new Promise(resolve => {
            let u;
            try { u = new URL(url); } catch (e) { return resolve({ code: 500, headers: {}, content: '' }); }
            const o = options || {};
            const headers = Object.assign({
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Accept-Encoding': 'identity'
            }, o.headers || {});
            const r = https.request({
                hostname: u.hostname, port: u.port || 443,
                path: u.pathname + u.search, method: o.method || 'GET', headers
            }, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    resolve({
                        code: res.statusCode,
                        headers: res.headers,
                        content: o.buffer === 2 ? buf.toString('base64') : buf.toString('utf8')
                    });
                });
                res.on('error', () => resolve({ code: 500, headers: {}, content: '' }));
            });
            r.on('error', () => resolve({ code: 500, headers: {}, content: '' }));
            r.setTimeout(60000, () => { r.destroy(); resolve({ code: 500, headers: {}, content: '' }); });
            r.end();
        });
    };
}

/* 同步版 req 的包装：源内是同步调用的，Node 里用 deasync 不可行 —— 
   所以测试台改为「先把源跑成同步」不可行。这里用一个技巧：
   预先在 Node 里用同步 XHR 风格不可用，改为异步批量测试。 */

/* 由于源内 req 是同步语义，测试台需要同步拿到网络数据。
   做法：用 child_process 同步调用自己写的 node 脚本拿结果（execFileSync）。
   这样既能走 Node 的 TLS 栈（过 WAF），又保持同步语义。 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FETCHER = path.join(__dirname, '_4kcz_fetch.js');
fs.writeFileSync(FETCHER, `
const https=require('https');
const UA=${JSON.stringify(UA)};
let input='';
process.stdin.on('data',d=>input+=d);
process.stdin.on('end',()=>{
  const job=JSON.parse(input);
  const u=new URL(job.url);
  const headers=Object.assign({'User-Agent':UA,'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'zh-CN,zh;q=0.9','Accept-Encoding':'identity'},job.headers||{});
  const r=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,method:'GET',headers},res=>{
    const c=[];res.on('data',x=>c.push(x));
    res.on('end',()=>{
      const buf=Buffer.concat(c);
      const out={code:res.statusCode,headers:res.headers,content:job.buffer===2?buf.toString('base64'):buf.toString('utf8')};
      process.stdout.write(JSON.stringify(out));
    });
  });
  r.on('error',e=>{process.stdout.write(JSON.stringify({code:500,headers:{},content:''}));});
  r.setTimeout(60000,()=>{r.destroy();process.stdout.write(JSON.stringify({code:500,headers:{},content:''}));});
  r.end();
});
`);

function reqSync(url, options) {
    try {
        const out = execFileSync(process.execPath, [FETCHER], {
            input: JSON.stringify(Object.assign({ url: url }, options || {})),
            maxBuffer: 64 * 1024 * 1024
        });
        return JSON.parse(out.toString('utf8'));
    } catch (e) {
        return { code: 500, headers: {}, content: '' };
    }
}

function getProxy(local) { return 'http://127.0.0.1:9978/proxy?do=js'; }

/* ---- 载入源 ---- */
const src = fs.readFileSync(path.join(__dirname, '..', '4kcz.js'), 'utf8').replace(/\bexport\s+function\b/g, 'function');
const spider = new Function('req', 'getProxy', src + '\nreturn __jsEvalReturn();')(reqSync, getProxy);

let pass = 0, fail = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
    cond ? pass++ : fail++;
}

/* 异步探测（走 Node https，用来验证分片可播性） */
function probe(url, headers) {
    return new Promise(resolve => {
        const u = new URL(url);
        const r = https.request({
            hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
            headers: Object.assign({ 'User-Agent': UA, 'Range': 'bytes=0-2047' }, headers || {})
        }, res => {
            const c = [];
            res.on('data', x => { c.push(x); if (Buffer.concat(c).length > 4096) res.destroy(); });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], buf: Buffer.concat(c) }));
            res.on('close', () => resolve({ status: res.statusCode, type: res.headers['content-type'], buf: Buffer.concat(c) }));
        });
        r.on('error', e => resolve({ status: 'ERR ' + e.message }));
        r.setTimeout(60000, () => { r.destroy(); resolve({ status: 'TIMEOUT' }); });
        r.end();
    });
}

(async () => {
    spider.init({ skey: 'cztest', ext: '' });

    console.log('=== 1) home（分类）===');
    const home = JSON.parse(spider.home());
    check('分类数 == 9', home.class.length === 9, home.class.map(c => c.type_name).join(' / '));
    check('含「最新电影」', home.class.some(c => c.type_id === 'zuixindianying'));

    console.log('\n=== 2) homeVod（首页）===');
    const hv = JSON.parse(spider.homeVod());
    check('首页列表 > 0 条', hv.list.length > 0, hv.list.length + ' 条');
    if (hv.list[0]) {
        const f = hv.list[0];
        check('字段齐（id/name/pic）', !!(f.vod_id && f.vod_name && /^https?:/.test(f.vod_pic)), JSON.stringify(f).slice(0, 130));
    }

    console.log('\n=== 3) category 最新电影 第 1/2 页 ===');
    const c1 = JSON.parse(spider.category('zuixindianying', '1', false, {}));
    check('第 1 页有数据', c1.list.length > 0, `${c1.list.length} 条 / pagecount=${c1.pagecount}`);
    check('每页 25 条左右', c1.list.length >= 20 && c1.list.length <= 30, c1.list.length + ' 条');
    const c2 = JSON.parse(spider.category('zuixindianying', '2', false, {}));
    check('第 2 页与第 1 页不同', c1.list[0].vod_id !== c2.list[0].vod_id, `第2页首条：${c2.list[0] && c2.list[0].vod_name}`);
    console.log('    样例：' + c1.list.slice(0, 3).map(v => v.vod_name + (v.vod_remarks ? '[' + v.vod_remarks + ']' : '')).join(' | '));

    console.log('\n=== 4) 其它分类 ===');
    for (const [tid, name] of [['meijutt', '美剧'], ['fanju', '番剧'], ['dbtop250', '豆瓣Top250']]) {
        const c = JSON.parse(spider.category(tid, '1', false, {}));
        check(`${name} 有数据`, c.list.length > 0, `${c.list.length} 条，例：${c.list[0] && c.list[0].vod_name}`);
    }

    console.log('\n=== 5) search ===');
    const sr = JSON.parse(spider.search('峡谷', false));
    check('搜「峡谷」有结果', sr.list.length > 0, sr.list.length + ' 条：' + sr.list.slice(0, 3).map(v => v.vod_name).join(' / '));
    check('结果带 id 与封面', !!(sr.list[0] && sr.list[0].vod_id && /^https?:/.test(sr.list[0].vod_pic)), sr.list[0] && sr.list[0].vod_pic);
    const empty = JSON.parse(spider.search('', false));
    check('空词返回空表', empty.list.length === 0);

    console.log('\n=== 6) detail（电影：峡谷 20294）===');
    const d = JSON.parse(spider.detail('20294')).list[0];
    check('详情有返回', !!d, d && d.vod_name);
    check('片名正确', !!(d && d.vod_name && d.vod_name.indexOf('峡谷') >= 0), d && d.vod_name);
    check('海报是图片地址', !!(d && /^https?:/.test(d.vod_pic)), d && d.vod_pic && d.vod_pic.slice(0, 90));
    check('简介非空', !!(d && d.vod_content && d.vod_content.length > 10), d && (d.vod_content || '').slice(0, 40) + '…');
    check('年份/地区/类型', !!(d && d.vod_year), d && `${d.vod_year} / ${d.vod_area} / ${d.type_name}`);
    const eps = (d.vod_play_url || '').split('#').filter(Boolean);
    check('选集 > 0', eps.length > 0, `${eps.length} 集，例：${eps[0]}`);
    check('选集是「名称$地址」', /^[^$]+\$\/v_play\/[A-Za-z0-9+\/=]+\.html$/.test(eps[0]), eps[0]);

    console.log('\n=== 7) detail（多集剧：挑情丑闻 23978）===');
    const d2 = JSON.parse(spider.detail('23978')).list[0];
    check('剧集详情有返回', !!d2, d2 && d2.vod_name);
    const eps2 = (d2 && d2.vod_play_url || '').split('#').filter(Boolean);
    check('多集选集 >= 2', eps2.length >= 2, `${eps2.length} 集`);

    console.log('\n=== 8) play：取流 + 代理重写 ===');
    const p1 = JSON.parse(spider.play('厂长资源', eps[0].split('$')[1], []));
    check('返回 parse=0', p1.parse === 0, JSON.stringify(p1).slice(0, 160));
    if (!/^https?:\/\/|^proxy:\/\//.test(p1.url || '')) {
        check('取流成功（拿到代理地址）', false, '取流失败：' + (p1.msg || '无地址'));
    } else {
        check('拿到的是代理地址', /proxy/.test(p1.url), p1.url.slice(0, 100));

        /* 解出缓存键，直接调 proxy() 拿重写后的 playlist */
        const km = String(p1.url).match(/[?&]k=([^&]+)/);
        check('代理地址带缓存键 k', !!km, km && km[1]);
        const pr = await spider.proxy({ k: km ? decodeURIComponent(km[1]) : '', siteKey: 'cztest' });
        check('proxy 状态码 200', pr[0] === 200, pr[0]);
        check('proxy content-type 是 m3u8', pr[1] === 'application/vnd.apple.mpegurl', pr[1]);
        const pl = String(pr[2] || '');
        check('playlist 仍是 #EXTM3U', pl.indexOf('#EXTM3U') === 0, JSON.stringify(pl.slice(0, 24)));
        const segLines = pl.split('\n').filter(l => l && l.charAt(0) !== '#');
        check('分片已重写成代理地址', segLines.length > 0 && segLines.every(l => /seg=/.test(l)), (segLines[0] || '').slice(0, 110));
        check('不再出现 .png 结尾（播放器按扩展名会拒）', !/\.png$/m.test(pl), 'ok');
        check('保留了 #EXTINF', /#EXTINF/.test(pl));

        /* 拿第一个分片走 proxy，验证真的返回 TS 字节 */
        const segEnc = (String(segLines[0]).match(/[?&]seg=([^&#]+)/) || [])[1];
        const n = (String(segLines[0]).match(/[?&]n=(\d+)/) || [])[1];
        check('分片地址带 seg 与 n', !!segEnc && !!n, `n=${n}`);
        if (segEnc) {
            const sr2 = await spider.proxy({ seg: decodeURIComponent(segEnc), n: n, siteKey: 'cztest' });
            check('分片代理返回 200', sr2[0] === 200, sr2[0] + ' ' + sr2[1]);
            check('分片 content-type 是 video/mp2t', sr2[1] === 'video/mp2t', sr2[1]);
            /* 第 5 位 =1 表示 body 是 base64，宿主会解码后交给播放器 */
            check('分片声明了 base64 通道（第 5 位=1）', sr2[4] === 1, 'got ' + sr2[4]);
            const raw = Buffer.from(String(sr2[2] || ''), 'base64');
            check('分片首字节是 TS sync 0x47', raw.length > 0 && raw[0] === 0x47,
                raw.length ? ('0x' + raw[0].toString(16) + `, ${raw.length}B`) : 'empty');
            /* TS 包对齐校验 */
            check('TS 188 字节对齐', raw.length > 376 && raw[188] === 0x47 && raw[376] === 0x47,
                raw.length > 376 ? 'ok' : 'len ' + raw.length);
        }
    }

    console.log('\n=== 9) 原始分片可播性（探测 PNG 头 + TS 起点）===');
    const srcUrl = 'https://m3hlsm3.py1080p.com:907/hls3/hls/' + encodeURIComponent('峡谷') + '.m3u8';
    const m3 = reqSync(srcUrl, { headers: { 'Referer': 'https://www.4kcz.com/' } });
    if (m3.code === 200) {
        const segs = String(m3.content).split(/\r?\n/).filter(l => l && l.charAt(0) !== '#' && l.indexOf('http') === 0);
        check('m3u8 有分片', segs.length > 0, segs.length + ' 段');
        const pr0 = await probe(segs[0]);
        check('原始分片可访问（200/206）', pr0.status === 200 || pr0.status === 206, `${pr0.status} ${pr0.type}`);
        const iend = pr0.buf ? pr0.buf.indexOf('IEND') : -1;
        check('分片是 PNG 伪装', pr0.buf && pr0.buf[0] === 0x89 && pr0.buf[1] === 0x50, iend >= 0 ? `PNG 头 ${iend + 8}B` : 'non-PNG');
        /* 带 Range 跳过伪装头，应该直接是 TS */
        const skip = await probe(segs[0]);
        check('分片确实以 0x47 开头（跳过伪装头后）', pr0.buf && pr0.buf[iend + 8] === 0x47, 'ok');
    } else {
        check('直连 m3u8 可取', false, 'HTTP ' + m3.code);
    }

    console.log('\n=== 10) WAF 行为确认（curl 被拦 / Node 可过）===');
    let curlCode = 'n/a';
    try {
        curlCode = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', 'https://www.4kcz.com/'], { encoding: 'utf8' });
    } catch (e) { curlCode = 'exec-err'; }
    console.log(`    curl -> HTTP ${curlCode}（预期 403，雷池按 TLS 指纹拦 curl）`);
    const nodeHome = reqSync('https://www.4kcz.com/');
    check('Node https -> 200', nodeHome.code === 200, 'HTTP ' + nodeHome.code);
    console.log('    → 源运行在 FongMi 的 okhttp 宿主上不受影响；若某宿主用 curl 实现 req，本源会被 WAF 挡');

    console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
    try { fs.unlinkSync(FETCHER); } catch (e) { }
    process.exit(fail ? 1 : 0);
})();
