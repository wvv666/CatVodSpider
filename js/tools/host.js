/*
 * 测试台共用的「宿主注入」模拟（Node 侧复刻 FongMi TV quickjs 提供的函数）
 *
 *   req(url, options)  -> {code, headers, content}
 *        options.method: 'get' | 'post'，options.body: 字符串，options.buffer: 2 = 返回 base64
 *        实现用 curl，加 --compressed 让 curl 自己处理 gzip（站点常常无条件 gzip）。
 *   md5X(text)         -> 小写 hex
 *   aesX(mode, encrypt, input, inputBase64, key, iv, outBase64)
 *        mode 支持 'AES/ECB'、'AES/CBC'（以及带 /PKCS5Padding 的写法）
 *   getProxy(local)    -> 本地代理前缀（源里给 m3u8 用）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function makeReq(tag) {
    const TMP = path.join(require('os').tmpdir(), 'host_' + tag + '.bin');
    return function req(url, options) {
        const o = options || {};
        const args = ['-s', '-L', '--compressed', '--max-time', '45', '-o', TMP];
        const h = Object.assign({ 'User-Agent': UA }, o.headers || {});
        for (const k in h) args.push('-H', k + ': ' + h[k]);
        if (String(o.method || 'get').toLowerCase() === 'post') {
            args.unshift('-X', 'POST');
            if (o.body !== undefined && o.body !== null) {
                /* 中文 body 走 argv 会被 MSYS 转码搞坏 —— 写成文件再 --data-binary @file */
                const bf = TMP + '.body';
                fs.writeFileSync(bf, String(o.body), 'utf8');
                args.push('--data-binary', '@' + bf);
            }
        }
        args.push(url);
        try {
            execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024 });
            const body = fs.readFileSync(TMP);
            return { code: 200, headers: {}, content: o.buffer === 2 ? body.toString('base64') : body.toString('utf8') };
        } catch (e) {
            return { code: 500, headers: {}, content: '' };
        }
    };
}

function md5X(text) {
    return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

function aesX(mode, encrypt, input, inputBase64, key, iv, outBase64) {
    const m = String(mode || 'AES/ECB').toUpperCase();
    const cbc = m.indexOf('CBC') >= 0;
    let keyBuf = Buffer.from(String(key), 'utf8');
    if (keyBuf.length < 16) { const b = Buffer.alloc(16); keyBuf.copy(b); keyBuf = b; }
    const data = inputBase64 ? Buffer.from(String(input), 'base64') : Buffer.from(String(input), 'utf8');
    const c = encrypt
        ? crypto.createCipheriv(cbc ? 'aes-128-cbc' : 'aes-128-ecb', keyBuf, cbc ? Buffer.from(String(iv), 'utf8') : null)
        : crypto.createDecipheriv(cbc ? 'aes-128-cbc' : 'aes-128-ecb', keyBuf, cbc ? Buffer.from(String(iv), 'utf8') : null);
    c.setAutoPadding(true);
    const out = Buffer.concat([c.update(data), c.final()]);
    return outBase64 ? out.toString('base64') : out.toString('utf8');
}

function getProxy(local) {
    return 'http://127.0.0.1:9978/proxy?do=js';
}

function loadSpider(file, extra) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\bexport\s+function\b/g, 'function');
    const names = ['req', 'md5X', 'aesX', 'getProxy'].concat(Object.keys(extra || {}));
    const values = [makeReq(path.basename(file, '.js')), md5X, aesX, getProxy].concat(Object.values(extra || {}));
    return new Function(...names, src + '\nreturn __jsEvalReturn();')(...values);
}

/* 用 Node 自带 https 跟随跳转取首段字节（MSYS 的 curl 连某些国内 CDN 会 TLS 报错，所以探测走 Node） */
function probe(url, headers, hops) {
    return new Promise(resolve => {
        hops = hops || 0;
        if (hops > 6) return resolve({ status: 'TOO_MANY_HOPS', url });
        const u = new URL(url);
        const req = require('https').request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
            headers: Object.assign({ 'User-Agent': UA, 'Range': 'bytes=0-2047' }, headers || {}) }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const next = res.headers.location.startsWith('http') ? res.headers.location : (u.origin + res.headers.location);
                return resolve(probe(next, headers, hops + 1).then(r => Object.assign(r, { via: (r.via || []).concat(res.statusCode) })));
            }
            const chunks = [];
            res.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 4096) res.destroy(); });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], url: url, head: Buffer.concat(chunks).slice(0, 64), via: hops }));
            res.on('close', () => resolve({ status: res.statusCode, type: res.headers['content-type'], url: url, head: Buffer.concat(chunks).slice(0, 64), via: hops }));
        });
        req.on('error', e => resolve({ status: 'ERR ' + e.message, url: url }));
        req.setTimeout(60000, () => { req.destroy(); resolve({ status: 'TIMEOUT', url: url }); });
        req.end();
    });
}

module.exports = { req: makeReq('shared'), makeReq, md5X, aesX, getProxy, loadSpider, probe, UA };
