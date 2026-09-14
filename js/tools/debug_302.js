/* 看分片 302 跳到哪，跟跳后能不能拿到 TS */
const fs = require('fs'), crypto = require('crypto'), { execFileSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function req(url, options) {
    const o = options || {};
    const args = ['-s', '-L', '--max-time', '40', '-o', '-'];
    const h = Object.assign({ 'User-Agent': UA }, o.headers || {});
    for (const k in h) args.push('-H', k + ': ' + h[k]);
    args.push(url);
    let body = Buffer.alloc(0);
    try { body = execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024 }); } catch (e) { }
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
const spider = new Function('req', 'md5X', 'aesX', 'getProxy', src + '\nreturn __jsEvalReturn();')(req, md5X, aesX, () => 'http://127.0.0.1:9978/proxy');
spider.init({ skey: 'xltest', ext: '' });

const p = JSON.parse(spider.play('', '/play/27099-0.htm', []));
const pl = String(spider.proxy({ k: decodeURIComponent(String(p.url).match(/[?&]k=([^&]+)/)[1]) })[2]);
const segs = pl.split('\n').map(s => s.trim()).filter(s => /^https?:\/\/\S+\.ts$/.test(s));
console.log('分片总数:', segs.length, '\n');

function curl(args) { return execFileSync('curl', args).toString().trim(); }

for (let i = 0; i < 2; i++) {
    const u = segs[i];
    console.log('#', i, u.slice(-46));
    console.log('   不跟跳转:', curl(['-s', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', '-A', UA, u]));
    console.log('   跟跳转  :', curl(['-sL', '-o', '/dev/null', '-w', '%{http_code} %{size_download} %{content_type} <- %{url_effective}',
        '-A', UA, '-H', 'Referer: https://xl02.com.de/', u]).slice(0, 200));
}
