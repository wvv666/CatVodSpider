/* inflate.js —— RFC1951 raw DEFLATE 解压（QuickJS 可用，无依赖）
 * 供 TVBox js 源内联使用：源环境没有 pako，必须自带解压。
 * 用法：deflateRaw(bytes) -> Uint8Array；gunzip(bytes) 自动跳过 gzip/zlib 头。
 */
function deflateRaw(input) {
  var pos = 0, bitbuf = 0, bitcnt = 0;
  var out = new Uint8Array(Math.max(1024, input.length * 4)), outLen = 0;
  function grow(need) {
    if (outLen + need <= out.length) return;
    var cap = out.length;
    while (cap < outLen + need) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(out.subarray(0, outLen));
    out = nb;
  }
  function bits(n) {
    while (bitcnt < n) { bitbuf |= input[pos++] << bitcnt; bitcnt += 8; }
    var v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n; bitcnt -= n;
    return v;
  }
  function buildHuff(lengths) {
    var i, maxBits = 0;
    for (i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
    var blCount = new Array(maxBits + 1);
    for (i = 0; i <= maxBits; i++) blCount[i] = 0;
    for (i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
    var nextCode = new Array(maxBits + 2);
    var code = 0;
    for (var b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
    var map = {};
    for (i = 0; i < lengths.length; i++) {
      var len = lengths[i];
      if (!len) continue;
      map[(len << 16) | nextCode[len]] = i;
      nextCode[len]++;
    }
    return { map: map, maxBits: maxBits };
  }
  function decode(h) {
    var code = 0;
    for (var len = 1; len <= h.maxBits; len++) {
      code = (code << 1) | bits(1);
      var s = h.map[(len << 16) | code];
      if (s !== undefined) return s;
    }
    throw new Error('bad huffman code');
  }

  var LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  var LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  var DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  var CLORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
  var FIXED_LIT, FIXED_DIST;
  function fixedTables() {
    if (FIXED_LIT) return;
    var l = new Array(288), i;
    for (i = 0; i < 144; i++) l[i] = 8;
    for (; i < 256; i++) l[i] = 9;
    for (; i < 280; i++) l[i] = 7;
    for (; i < 288; i++) l[i] = 8;
    FIXED_LIT = buildHuff(l);
    var d = new Array(30);
    for (i = 0; i < 30; i++) d[i] = 5;
    FIXED_DIST = buildHuff(d);
  }

  var final = 0;
  while (!final) {
    final = bits(1);
    var type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;                      // 对齐到字节
      var len = input[pos] | (input[pos + 1] << 8); pos += 4;
      grow(len);
      for (var i2 = 0; i2 < len; i2++) out[outLen++] = input[pos++];
    } else {
      var lit, dist;
      if (type === 1) { fixedTables(); lit = FIXED_LIT; dist = FIXED_DIST; }
      else if (type === 2) {
        var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        var cl = new Array(19), k;
        for (k = 0; k < 19; k++) cl[k] = 0;
        for (k = 0; k < hclen; k++) cl[CLORDER[k]] = bits(3);
        var clHuff = buildHuff(cl);
        var lens = new Array(hlit + hdist), n = 0;
        while (n < hlit + hdist) {
          var sym = decode(clHuff);
          if (sym < 16) lens[n++] = sym;
          else {
            var rep, val = 0;
            if (sym === 16) { val = lens[n - 1]; rep = 3 + bits(2); }
            else if (sym === 17) { rep = 3 + bits(3); }
            else { rep = 11 + bits(7); }
            while (rep-- > 0) lens[n++] = val;
          }
        }
        lit = buildHuff(lens.slice(0, hlit));
        dist = buildHuff(lens.slice(hlit));
      } else throw new Error('bad block type ' + type);

      for (;;) {
        var s = decode(lit);
        if (s === 256) break;
        if (s < 256) { grow(1); out[outLen++] = s; continue; }
        var li = s - 257;
        var mlen = LBASE[li] + bits(LEXT[li]);
        var ds = decode(dist);
        var md = DBASE[ds] + bits(DEXT[ds]);
        grow(mlen);
        var from = outLen - md;
        for (var m = 0; m < mlen; m++) out[outLen++] = out[from + m];
      }
    }
  }
  return out.subarray(0, outLen);
}

/* 自动识别 zlib / gzip / raw deflate 并跳过头部 */
function gunzip(bytes) {
  var off = 0;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {          // gzip
    off = 10;
    var flg = bytes[3];
    if (flg & 4) { off += 2 + (bytes[off] | (bytes[off + 1] << 8)); }   // FEXTRA
    if (flg & 8) { while (bytes[off++] !== 0) {} }                       // FNAME
    if (flg & 16) { while (bytes[off++] !== 0) {} }                      // FCOMMENT
    if (flg & 2) { off += 2; }                                           // FHCRC
  } else if (bytes[0] === 0x78) {                        // zlib
    off = 2;
    if (bytes[1] & 0x20) off += 4;                       // FDICT
  }
  return deflateRaw(bytes.subarray(off));
}

/* 跳过伪装头（默认 3354 字节）后解压；头长度可传 */
function unmaskAndUnzip(bytes, headLen) {
  return gunzip(bytes.subarray(headLen === undefined ? 3354 : headLen));
}

if (typeof module !== 'undefined') module.exports = { deflateRaw: deflateRaw, gunzip: gunzip, unmaskAndUnzip: unmaskAndUnzip };
