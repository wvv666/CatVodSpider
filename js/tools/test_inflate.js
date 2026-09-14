/* Node 对照测试：用真实的 m3u8 载荷验证 inflate.js 的正确性 */
const fs = require('fs');
const zlib = require('zlib');
const { deflateRaw, gunzip, unmaskAndUnzip } = require('./inflate.js');

const raw = new Uint8Array(fs.readFileSync(require('path').join(__dirname, 'sample_raw.bin')));
console.log('载荷大小:', raw.length, '字节, 前 4 字节:', Buffer.from(raw.slice(0, 4)).toString('hex'));

const truth = zlib.gunzipSync(Buffer.from(raw.slice(3354)));
console.log('Node 参考解压结果:', truth.length, '字符');

const mine = Buffer.from(unmaskAndUnzip(raw));
console.log('我的 inflate 结果 :', mine.length, '字符');
console.log('★ 完全一致:', Buffer.compare(truth, mine) === 0);

const txt = mine.toString('utf8');
console.log('#EXTINF 段数:', (txt.match(/#EXTINF/g) || []).length);
console.log('首行:', txt.split('\n')[0], '| 含 #EXTM3U:', txt.indexOf('#EXTM3U') === 0);

// 边界用例：随机数据 + 各级压缩
let ok = 0, fail = 0;
for (let lvl of [1, 5, 9]) {
  for (let n of [0, 1, 100, 5000, 200000]) {
    const src = Buffer.alloc(n);
    for (let i = 0; i < n; i++) src[i] = (i * 7 + (i % 13) * 31) & 0xff;
    const gz = zlib.gzipSync(src, { level: lvl });
    const got = Buffer.from(unmaskAndUnzip(new Uint8Array(gz), 0));
    if (Buffer.compare(src, got) === 0) ok++; else { fail++; console.log('  ✗ fail lvl=' + lvl + ' n=' + n); }
  }
}
console.log(`\n边界用例: ${ok} 通过 / ${fail} 失败`);
