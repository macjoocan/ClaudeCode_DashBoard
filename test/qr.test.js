'use strict';
// public/qr.js - 만든 QR 을 거꾸로 읽어 원문이 돌아오는지, 오류정정 값이 맞는지 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, toSvg } = require('../public/qr.js');

const NUM_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];

function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; }
function gfPow(e) { let r = 1; for (let i = 0; i < e; i++) r = gfMul(r, 2); return r; }

// 기능 패턴 자리를 다시 계산한다(인코더와 따로 짠 코드).
function functionMask(ver, size) {
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) f[y][x] = true; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  const pos = ver === 1 ? [] : ({ 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] })[ver];
  for (const a of pos) for (const b of pos) {
    if ((a === 6 && b === 6) || (a === 6 && b === pos[pos.length - 1]) || (a === pos[pos.length - 1] && b === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(a + dx, b + dy);
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (ver >= 7) for (let i = 0; i < 18; i++) { mark(size - 11 + i % 3, Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + i % 3); }
  return f;
}

function readFormat(q) {
  let bits = 0;
  const m = q.modules;
  for (let i = 0; i <= 5; i++) bits |= (m[i][8] ? 1 : 0) << i;
  bits |= (m[7][8] ? 1 : 0) << 6; bits |= (m[8][8] ? 1 : 0) << 7; bits |= (m[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) bits |= (m[8][14 - i] ? 1 : 0) << i;
  const d = (bits ^ 0x5412) >>> 10;
  return { ecl: d >>> 3, mask: d & 7 };
}

const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];

function decode(q) {
  const { size, version: ver } = q;
  const fmt = readFormat(q);
  const f = functionMask(ver, size);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!f[y][x]) bits.push(q.modules[y][x] !== MASKS[fmt.mask](x, y));
    }
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k]; cw.push(b); }
  const nb = NUM_BLOCKS_M[ver], ecc = ECC_M[ver], total = cw.length;
  const shortLen = Math.floor(total / nb), numShort = nb - total % nb;
  const blocks = Array.from({ length: nb }, (_, i) => []);
  let k = 0;
  // 짧은 블록은 데이터 끝(오류정정 바로 앞) 한 칸이 비어 있다. 맨 끝이 아니다.
  for (let i = 0; i < shortLen + 1; i++) for (let j = 0; j < nb; j++) {
    if (i === shortLen - ecc && j < numShort) continue;
    blocks[j].push(cw[k++]);
  }
  const data = [];
  for (const b of blocks) {
    // 신드롬: 모든 근 a^0..a^(ecc-1) 에서 다항식 값이 0 이어야 한다
    for (let r = 0; r < ecc; r++) {
      let s = 0; const x = gfPow(r);
      for (const c of b) s = gfMul(s, x) ^ c;
      assert.equal(s, 0, 'RS syndrome ' + r + ' must be 0');
    }
    data.push(...b.slice(0, b.length - ecc));
  }
  const bitsOf = data.flatMap(b => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (b >>> i) & 1));
  const read = (at, n) => bitsOf.slice(at, at + n).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(read(0, 4), 4, 'byte mode');
  const ccLen = ver < 10 ? 8 : 16, len = read(4, ccLen);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(read(4 + ccLen + i * 8, 8));
  return { fmt, text: Buffer.from(bytes).toString('utf8') };
}

test('generated QR codes decode back to the original text with valid error correction', () => {
  for (const text of (process.env.ONLY ? [process.env.ONLY] : ['hi', 'http://192.168.0.10:7789/m#pair=Q2xhdWRlLWRhc2hib2FyZA-xyz_123',
    'http://10.20.30.40:7789/m#pair=' + 'a'.repeat(43), '폰으로 이어서 하기 ' + 'x'.repeat(120)])) {
    const q = encode(text, 'M');
    assert.equal(q.size, q.version * 4 + 17);
    const d = decode(q);
    assert.equal(d.fmt.ecl, 0, 'format says M');
    assert.equal(d.fmt.mask, q.mask);
    assert.equal(d.text, text);
  }
});

test('finder patterns sit in three corners and the SVG has a quiet zone', () => {
  const q = encode('http://192.168.0.10:7789/m#pair=abc', 'M');
  const ring = (cx, cy) => [[-3, -3], [3, 3], [0, -3], [-3, 0]].every(([dx, dy]) => q.modules[cy + dy][cx + dx]) && !q.modules[cy - 2][cx];
  assert.ok(ring(3, 3) && ring(q.size - 4, 3) && ring(3, q.size - 4));
  assert.ok(toSvg(q, 4).startsWith('<svg') && toSvg(q, 4).includes('viewBox="0 0 ' + (q.size + 8)));
  assert.throws(() => encode('x'.repeat(400), 'M'), /너무 깁니다/);
});
