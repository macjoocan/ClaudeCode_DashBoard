// QR 코드 생성기 (바이트 모드, 1~10버전). 폰 연결 주소를 QR 로 보여주는 데만 쓴다.
//
// 외부 라이브러리를 들이지 않으려고 직접 짰다. 표준(ISO/IEC 18004) 절차 그대로다:
// 데이터 → 패딩 → 블록별 Reed-Solomon 오류정정 → 섞어 넣기 → 기능 패턴 →
// 8가지 마스크 중 벌점이 가장 낮은 것 → 형식 정보.
// 표와 순서는 Project Nayuki 의 공개 구현을 따랐다.
(function (root) {
  'use strict';

  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var FORMAT_BITS = [1, 0, 3, 2];          // L, M, Q, H 의 형식 정보 값
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
  ];
  var MAX_VERSION = 10;

  function rawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver, ecl) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
  }

  // GF(2^8), 원시 다항식 x^8+x^4+x^3+x^2+1
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    var r = [];
    for (var i = 0; i < degree - 1; i++) r.push(0);
    r.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < r.length; j++) {
        r[j] = gfMul(r[j], root);
        if (j + 1 < r.length) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, divisor) {
    var r = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ r.shift();
      r.push(0);
      divisor.forEach(function (coef, i) { r[i] ^= gfMul(coef, factor); });
    });
    return r;
  }

  function utf8Bytes(text) {
    var s = unescape(encodeURIComponent(String(text)));
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function encode(text, eclName) {
    var ecl = ECL[eclName || 'M'];
    var bytes = utf8Bytes(text);
    var ver = 0;
    for (var v = 1; v <= MAX_VERSION; v++) {
      var ccBits = v < 10 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(v, ecl) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('QR 에 담기에 너무 깁니다');

    // 비트열: 모드(0100) + 길이 + 데이터 + 종료/패딩
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    var capacity = dataCodewords(ver, ecl) * 8;
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
      data.push(b);
    }

    // 블록으로 나눠 오류정정 붙이고 섞는다
    var numBlocks = NUM_BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(rawDataModules(ver) / 8);
    var numShort = numBlocks - rawCodewords % numBlocks;
    var shortLen = Math.floor(rawCodewords / numBlocks);
    var divisor = rsDivisor(eccLen), blocks = [], at = 0;
    for (i = 0; i < numBlocks; i++) {
      var dat = data.slice(at, at + shortLen - eccLen + (i < numShort ? 0 : 1));
      at += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var codewords = [];
    for (i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i !== shortLen - eccLen || j >= numShort) codewords.push(blocks[j][i]);
      }
    }

    var size = ver * 4 + 17, m = [], fn = [];
    for (i = 0; i < size; i++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function setFn(x, y, dark) { m[y][x] = dark; fn[y][x] = true; }

    // 기능 패턴: 타이밍, 찾기 패턴 3개, 정렬 패턴, 형식/버전 정보 자리
    for (i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var align = [];
    if (ver > 1) {
      var n = Math.floor(ver / 7) + 2;
      var step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      align = [6];
      for (var pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
    }
    for (i = 0; i < align.length; i++) for (j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++)
        setFn(align[i] + ax, align[j] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
    }
    function formatBits(mask) {
      var d = (FORMAT_BITS[ecl] << 3) | mask, rem = d;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var f = ((d << 10) | rem) ^ 0x5412;
      function bit(i) { return ((f >>> i) & 1) !== 0; }
      for (i = 0; i <= 5; i++) setFn(8, i, bit(i));
      setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
      for (i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
      for (i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
      for (i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
      setFn(8, size - 8, true);
    }
    formatBits(0);
    if (ver >= 7) {
      var rem = ver;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var vb = (ver << 12) | rem;
      for (i = 0; i < 18; i++) {
        var on = ((vb >>> i) & 1) !== 0, a = size - 11 + i % 3, c = Math.floor(i / 3);
        setFn(a, c, on); setFn(c, a, on);
      }
    }

    // 데이터 채우기: 오른쪽 아래에서 2칸 폭 지그재그
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        var x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && idx < codewords.length * 8) {
          m[y][x] = ((codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
          idx++;
        }
      }
    }

    function applyMask(mask) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        var inv;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: inv = ((x + y) % 2 + (x * y) % 3) % 2 === 0;
        }
        if (inv) m[y][x] = !m[y][x];
      }
    }
    // 벌점: 같은 색 5칸 이상 연속, 2x2 같은 색 덩어리, 찾기 패턴 닮은꼴, 어두운 칸 비율
    function penalty() {
      var p = 0, x, y, run, dark = 0;
      function finderLike(line) {
        var s = line.map(function (v) { return v ? 1 : 0; }).join(''), hit = 0, re = /(?=(10111010000|00001011101))/g;
        while (re.exec(s)) { hit++; re.lastIndex++; }
        return hit;
      }
      for (y = 0; y < size; y++) {
        run = 1;
        for (x = 1; x <= size; x++) {
          if (x < size && m[y][x] === m[y][x - 1]) run++;
          else { if (run >= 5) p += 3 + run - 5; run = 1; }
        }
        p += 40 * finderLike(m[y]);
      }
      for (x = 0; x < size; x++) {
        run = 1;
        var col = [];
        for (y = 0; y < size; y++) col.push(m[y][x]);
        for (y = 1; y <= size; y++) {
          if (y < size && col[y] === col[y - 1]) run++;
          else { if (run >= 5) p += 3 + run - 5; run = 1; }
        }
        p += 40 * finderLike(col);
      }
      for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
        var c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
      }
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
      var total = size * size;
      p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return p;
    }
    var best = 0, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      applyMask(mask); formatBits(mask);
      var score = penalty();
      if (score < bestScore) { bestScore = score; best = mask; }
      applyMask(mask);
    }
    applyMask(best); formatBits(best);
    return { version: ver, size: size, mask: best, modules: m };
  }

  // 흰 바탕 검은 칸 SVG. 둘레 4칸 여백은 표준 요구 사항이다.
  function toSvg(qr, scale) {
    var s = scale || 6, q = 4, n = qr.size + q * 2, path = '';
    for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++)
      if (qr.modules[y][x]) path += 'M' + (x + q) + ',' + (y + q) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" width="' + n * s + '" height="' + n * s +
      '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
  }

  var api = { encode: encode, toSvg: toSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCQR = api;
})(this);
