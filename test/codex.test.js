const { test } = require('node:test');
const assert = require('node:assert');
const codex = require('../codex.js');

test('normalizeCwd 는 \\\\?\\ 접두사를 벗긴다', () => {
  assert.equal(codex.normalizeCwd('\\\\?\\D:\\00.project\\GameDevTeam'), 'D:\\00.project\\GameDevTeam');
});

test('normalizeCwd 는 접두사가 없으면 그대로 둔다', () => {
  assert.equal(codex.normalizeCwd('D:\\00.project\\GameDevTeam'), 'D:\\00.project\\GameDevTeam');
});

test('normalizeCwd 는 UNC 접두사도 벗긴다', () => {
  assert.equal(codex.normalizeCwd('\\\\?\\UNC\\server\\share'), '\\\\server\\share');
});

test('normalizeCwd 는 빈 값에 안전하다', () => {
  assert.equal(codex.normalizeCwd(''), '');
  assert.equal(codex.normalizeCwd(null), '');
});

test('safeTitle 은 첫 번째로 쓸만한 값을 쓴다', () => {
  assert.equal(codex.safeTitle(null, '두번째', '세번째'), '두번째');
});

test('safeTitle 은 공백만 있는 값을 건너뛴다', () => {
  assert.equal(codex.safeTitle('   ', '진짜 제목'), '진짜 제목');
});

test('safeTitle 은 200자로 자르고 말줄임표를 붙인다', () => {
  const long = 'x'.repeat(500);
  const out = codex.safeTitle(long);
  assert.equal(out.length, 201);          // 200 + '…'
  assert.ok(out.endsWith('…'));
});

test('safeTitle 은 개행을 공백으로 바꾼다', () => {
  assert.equal(codex.safeTitle('첫 줄\n둘째 줄'), '첫 줄 둘째 줄');
});

test('safeTitle 은 후보가 모두 비면 빈 문자열', () => {
  assert.equal(codex.safeTitle(null, '', '  '), '');
});
