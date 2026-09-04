const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const usage = require('../usage.js');

test('sumUsage 는 usage 레코드를 합친다', () => {
  const text = [
    JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 5,
      cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 2, output_tokens: 7,
      cache_creation_input_tokens: 50, cache_read_input_tokens: 2000 } } }),
  ].join('\n');
  const u = usage.sumUsage(text);
  assert.equal(u.input, 12);
  assert.equal(u.output, 12);
  assert.equal(u.cacheWrite, 150);
  assert.equal(u.cacheRead, 3000);
  assert.equal(u.samples, 2);
});

test('billable 은 캐시 읽기를 빼고 센다', () => {
  // cache_read 는 이미 있는 컨텍스트를 다시 읽는 것이라 매 턴 누적되어
  // 합치면 실제 소비량을 크게 부풀린다. 별도로 두고 billable 에서는 뺀다.
  const text = JSON.stringify({ message: { usage: {
    input_tokens: 10, output_tokens: 5,
    cache_creation_input_tokens: 100, cache_read_input_tokens: 999999 } } });
  assert.equal(usage.sumUsage(text).billable, 115);
});

test('sumUsage 는 usage 없는 줄과 깨진 줄을 건너뛴다', () => {
  const text = ['{깨짐', JSON.stringify({ type: 'user' }),
    JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 1 } } })].join('\n');
  const u = usage.sumUsage(text);
  assert.equal(u.samples, 1);
  assert.equal(u.billable, 2);
});

test('sumUsage 는 빈 입력에 0', () => {
  const u = usage.sumUsage('');
  assert.equal(u.samples, 0);
  assert.equal(u.billable, 0);
});

test('forClaudeFile 은 같은 파일을 두 번째엔 캐시로 준다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-usage-'));
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, JSON.stringify({ message: { usage: {
    input_tokens: 3, output_tokens: 4 } } }) + '\n', 'utf8');
  const a = usage.forClaudeFile(f);
  const b = usage.forClaudeFile(f);
  assert.equal(a.billable, 7);
  assert.strictEqual(a, b);      // 캐시라 같은 객체가 나온다
});

test('forClaudeFile 은 없는 파일에 0', () => {
  assert.equal(usage.forClaudeFile('C:\\없는\\s.jsonl').billable, 0);
});

test('fmt 는 사람이 읽을 크기로 줄인다', () => {
  assert.equal(usage.fmt(512), '512');
  assert.equal(usage.fmt(340000), '340K');
  assert.equal(usage.fmt(1200000), '1.2M');
  assert.equal(usage.fmt(0), '0');
});
