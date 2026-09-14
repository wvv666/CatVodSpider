/* 分片下载专项诊断：前 5 个分片 × 有/无 Referer × 跟跳/不跟跳 */
const fs = require('fs'), os = require('os'), crypto = require('crypto'), { execFileSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OUT = os.tmpdir() + '/seg.bin';

function curl(args) {
    try { return execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024 }).toString().trim(); }
    catch (e) { return 'CURL_ERR(' + (e.status || '?') + ') ' + String((e.stdout || '').toString()).slice(0, 80); }
}
function dl(url, { redirect = true, referer = null, range = null } = {}) {
    const a = ['-s', '-o', OUT, '-w', '%{http_code} %{size_download} %{content_type}'];
    if (redirect) a.push('-L');
    a.push('-A', UA, '--max-time', '30');
    if (referer) a.push('-H', 'Referer: ' + referer);
    if (range) a.push('-H', 'Range: ' + range);
    a.push(url);
    const meta = curl(a);
    let head = '';
    try { const b = fs.readFileSync(OUT); head = b.slice(0, 1).toString('hex') + ' (' + b.length + 'B)'; } catch (e) { head = 'no file'; }
    return meta + '  head=' + head;
}

function req(url, options) {
    const o = options || {};
    const a = ['-s', '-L', '--max-time', '40', '-o', OUT];
    const h = Object.assign({ 'User-Agent': UA }, o.headers || {});
    for (const k in h) a.push('-H', k + ': ' + h[k]);
    a.push(url);
    let body = Buffer.alloc(0);
    try { execFileSync('curl', a, { maxBuffer: 64 * 1024 * 1024 }); body = fs.readFileSync(OUT); } catch (e) { }
    return { code: 200, headers: {}, content: o.buffer === 2 ? body.toString('base64') : body.toString('utf8') };
}
function md5X(t) { return crypto.createHash('md5').update(String(t), 'utf8').digest('hex'); }
function aesX(m, e, input, inB64, key, iv, outB64) {
    let kb = Buffer.from(key, 'utf8');
    if (kb.length < 16) { const b = Buffer.alloc(16); kb.copy(b); kb = b; }
    const c = crypto.createCipheriv('aes-128-ecb', kb, null); c.setAutoPadding(true);
    const out = Buffer.concat([c.update(Buffer.from(String(input), 'utf8')), c.final()]);
    return outB64 ? out.toString('base64') : out.toString('utf8');
}
const src = fs.readFileSync(require('path').join(__dirname, '..', 'xl02.js'), 'utf8').replace(/\bexport\s+function\b/g, 'function');
const spider = new Function('req', 'md5X', 'aesX', 'getProxy', src + '\nreturn __jsEvalReturn();')(req, md5X, aesX, () => 'http://127.0.0.1:9978/proxy?do=js');
spider.init({ skey: 'xltest', ext: '' });

const p = JSON.parse(spider.play('', '/play/27099-0.htm', []));
const pl = String(spider.proxy({ k: decodeURIComponent(String(p.url).match(/[?&]k=([^&]+)/)[1]) })[2]);
const segs = pl.split('\n').map(s => s.trim()).filter(s => /^https?:\/\/\S+\.ts$/.test(s));
console.log('分片总数:', segs.length, '\n');

for (let i = 0; i < 5; i++) {
    const u = segs[i];
    console.log(`#${i} ${u.slice(-24)}`);
    console.log('   跟跳+Referer   :', dl(u, { referer: 'https://xl02.com.de/' }));
    console.log('   跟跳 无Referer :', dl(u, {}));
    console.log('   不跟跳         :', dl(u, { redirect: false }));
}
