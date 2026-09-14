/* Node 测试台：模拟 FongMi 的 quickjs 宿主，跑真实的源 */
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---- 宿主注入的函数（按 FongMi/TV 的实现语义复刻）---- */
const TMP = require('os').tmpdir() + '/xl_req.bin';
function req(url, options) {
    const o = options || {};
    const args = ['-s', '-L', '--max-time', '40', '-o', TMP];
    const h = Object.assign({ 'User-Agent': UA }, o.headers || {});
    for (const k in h) args.push('-H', k + ': ' + h[k]);
    if (String(o.method || 'get').toLowerCase() === 'post') {
        args.push('-X', 'POST');
        if (o.body) args.push('--data', o.body);
    }
    args.push(url);
    let body = Buffer.alloc(0);
    try {
        execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024 });
        body = fs.readFileSync(TMP);
    } catch (e) {
        return { code: 500, headers: {}, content: '' };
    }
    const content = o.buffer === 2 ? body.toString('base64') : body.toString('utf8');
    return { code: 200, headers: {}, content: content };
}

function md5X(text) {
    return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

function aesX(mode, encrypt, input, inputBase64, key, iv, outBase64) {
    let keyBuf = Buffer.from(key, 'utf8');
    if (keyBuf.length < 16) { const b = Buffer.alloc(16); keyBuf.copy(b); keyBuf = b; }
    const data = inputBase64 ? Buffer.from(input, 'base64') : Buffer.from(String(input), 'utf8');
    const c = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
    c.setAutoPadding(true);
    const out = Buffer.concat([c.update(data), c.final()]);
    return outBase64 ? out.toString('base64') : out.toString('utf8');
}

function getProxy(local) { return 'http://127.0.0.1:9978/proxy?do=js'; }

/* ---- 载入源（去掉 export 关键字后 eval）---- */
const src = fs.readFileSync(require('path').join(__dirname, '..', 'xl02.js'), 'utf8').replace(/\bexport\s+function\b/g, 'function');
const spider = new Function('req', 'md5X', 'aesX', 'getProxy', src + '\nreturn __jsEvalReturn();')(req, md5X, aesX, getProxy);

let pass = 0, fail = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
    cond ? pass++ : fail++;
}

console.log('=== 1) init + home ===');
spider.init({ skey: 'xltest', ext: '' });
const home = JSON.parse(spider.home(true));
check('分类数 > 10', home.class.length > 10, home.class.length + ' 个，首个=' + home.class[0].type_name);

console.log('\n=== 2) homeVod（首页推荐）===');
const hv = JSON.parse(spider.homeVod());
check('拿到条目', hv.list.length > 0, hv.list.length + ' 条');
console.log('  首条:', JSON.stringify(hv.list[0]));

console.log('\n=== 3) category（分类列表）===');
const c1 = JSON.parse(spider.category('dongzuo', '1', false, {}));
check('第 1 页有条目', c1.list.length > 0, c1.list.length + ' 条 | 首条=' + (c1.list[0] || {}).vod_name);
const c2 = JSON.parse(spider.category('all?type=0', '2', false, {}));
check('带 ?type= 的分类第 2 页有条目', c2.list.length > 0, c2.list.length + ' 条 | 首条=' + (c2.list[0] || {}).vod_name);
check('第 1/2 页内容不同', (c1.list[0] || {}).vod_name !== (c2.list[0] || {}).vod_name);

console.log('\n=== 4) detail（详情）===');
const d = JSON.parse(spider.detail('/donghua/27099.htm'));
const vod = d.list[0];
check('片名', !!vod.vod_name, vod.vod_name);
check('海报', /^https?:/.test(vod.vod_pic), String(vod.vod_pic).slice(0, 60));
check('简介非空', vod.vod_content.length > 10, vod.vod_content.slice(0, 40) + '...');
check('播放地址', vod.vod_play_url.indexOf('$') > 0, vod.vod_play_url.slice(0, 60));
// 按宿主的解析顺序还原：先按 $$$ 分线路，再按 # 分剧集，最后 名称$地址 -> split('$', 2)
const fromLines = String(vod.vod_play_from).split('$$$');
const urlLines = String(vod.vod_play_url).split('$$$');
check('暴露了多条线路（播放器可切换）', fromLines.length >= 2, fromLines.join('  |  '));
check('线路数与剧集组数一致', fromLines.length === urlLines.length, fromLines.length + ' / ' + urlLines.length);
check('每条线路下的剧集一致', urlLines.every(u => u === urlLines[0]), urlLines[0].slice(0, 46) + '...');
const hostParts = urlLines[0].split('#')[0].split('$');
const hostPlayUrl = hostParts[1] || '';
check('vod_play_url 是 名称$地址（宿主能取到地址）', /^(\/|https?:)/.test(hostPlayUrl), hostParts.join('  $  '));
check('剧集名不是地址（顺序没写反）', !/^(\/|https?:)/.test(hostParts[0] || ''), String(hostParts[0]));

console.log('\n=== 5) play（取流 + 解密）===');
// 用宿主选中的线路 + 解析出来的地址去 play，覆盖 detail → play 的真实交接
const p = JSON.parse(spider.play(fromLines[0], hostPlayUrl, []));
check('返回了代理地址', /proxy/.test(p.url || ''), String(p.url).slice(0, 90));
check('地址含 siteKey', /siteKey=xltest/.test(p.url));
check('地址没有重复的 do=', (String(p.url).match(/do=/g) || []).length <= 1, String(p.url));
// 模拟宿主 BaseLoader.proxy() 的路由判定
{
    const qs = {};
    new URL(String(p.url)).searchParams.forEach((v, k) => { qs[k] = v; });
    const route = qs.siteKey ? 'by-siteKey → getSpider().proxy()' : (qs.do === 'js' ? 'jsLoader' : 'jarLoader');
    check('宿主路由命中本源', route.startsWith('by-siteKey'), route);
    check('缓存键能传给 proxy', !!qs.k, qs.k);
}
check('play 返回带 UA header（分片 CDN 要求）', /Mozilla/.test(JSON.stringify(p.header || {})), JSON.stringify(p.header));
const km = String(p.url).match(/[?&]k=([^&]+)/);
check('带缓存键', !!km);
const pr = spider.proxy({ k: km ? decodeURIComponent(km[1]) : '', siteKey: 'xltest' });
check('proxy 状态码 200', pr[0] === 200, pr[0]);
check('proxy content-type', pr[1] === 'application/vnd.apple.mpegurl', pr[1]);
const pl = String(pr[2] || '');
const segs = (pl.match(/\.ts/g) || []).length;
const infs = (pl.match(/#EXTINF/g) || []).length;
check('playlist 以 #EXTM3U 开头', pl.indexOf('#EXTM3U') === 0);
check('分片数与 #EXTINF 一致', segs === infs && segs > 0, segs + ' 段 / ' + infs + ' 个 #EXTINF');
check('分片已绝对化', /https:\/\/vod\.xl01\.me\//.test(pl), (pl.match(/https:\/\/vod\.xl01\.me\/\S{0,20}/) || [''])[0] + '...');
check('默认线路(iplay)分片不带 /hls/', !/vod\.xl01\.me\/hls\//.test(pl), (pl.match(/https:\/\/vod\.xl01\.me\/\S{0,22}/) || [''])[0]);
// 切换线路：选最后一条 ac5634-us，分片应带 /hls/ 前缀 —— 证明 flag 真的被用上了
const p2 = JSON.parse(spider.play(fromLines[fromLines.length - 1], hostPlayUrl, []));
const k2 = (String(p2.url).match(/[?&]k=([^&]+)/) || [])[1] || '';
const pr2 = spider.proxy({ k: decodeURIComponent(k2), siteKey: 'xltest' });
const pl2 = String(pr2[2] || '');
check('切到 ac5634-us 后分片带 /hls/', /vod\.xl01\.me\/hls\//.test(pl2), (pl2.match(/https:\/\/vod\.xl01\.me\/\S{0,26}/) || [''])[0]);
// 分片的最终验证交给 Python（mingw 版 curl 连该 CDN 会 TLS error 35，不可靠）
// 见 复验分片.py：前 3 片均 HTTP 200 / video/mp4 / 首字节 0x47 / 1.6~6.8MB
console.log('  · 分片下载验证见 复验分片.py（本环境 curl 的 TLS 不稳，不作断言）');

console.log('\n=== 6) search（预期被验证码挡）===');
const s = JSON.parse(spider.search('沙丘', false, '1'));
check('不抛异常且返回结构正确', Array.isArray(s.list), s.list.length + ' 条（站点限制）');

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
