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

// ------------------------------------------------------- Codex rollout 총량
//
// 최종 리뷰 I4: Codex 의 billable 을 threads.tokens_used(캐시 입력 포함 총량)로
// 잡으면 Claude 의 billable(캐시 읽기 제외)과 같은 자로 잰 값이 아니다.
// rollout 의 token_count 레코드에서 내역을 뽑아 같은 정의로 맞춘다.

function tokenCountLine(t) {
  return JSON.stringify({
    timestamp: '2026-08-16T09:59:07.791Z', type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: t, last_token_usage: {} } },
  });
}

test('parseCodexTotals 는 캐시 입력을 빼고 Claude 와 같은 billable 을 만든다', () => {
  // 실측 형태: input_tokens 는 cached_input_tokens 를 "포함한" 값이고
  // total_tokens === input_tokens + output_tokens 다.
  const u = usage.parseCodexTotals(tokenCountLine({
    input_tokens: 6699811, cached_input_tokens: 6215808, cache_write_input_tokens: 0,
    output_tokens: 29354, reasoning_output_tokens: 10908, total_tokens: 6729165 }));
  assert.equal(u.cacheRead, 6215808);
  assert.equal(u.input, 6699811 - 6215808);
  assert.equal(u.output, 29354);
  assert.equal(u.billable, (6699811 - 6215808) + 29354);
  assert.notEqual(u.billable, 6729165);   // tokens_used 컬럼 값과는 달라야 한다
  assert.equal(u.samples, 1);
});

test('parseCodexTotals 는 마지막 레코드만 쓴다 (누계라 더하면 안 된다)', () => {
  const text = [
    tokenCountLine({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }),
    tokenCountLine({ input_tokens: 300, cached_input_tokens: 200, output_tokens: 30 }),
  ].join('\n');
  const u = usage.parseCodexTotals(text);
  assert.equal(u.billable, (300 - 200) + 30);
});

test('parseCodexTotals 는 cache_write 를 Claude 처럼 따로 세고 billable 에 넣는다', () => {
  const u = usage.parseCodexTotals(tokenCountLine({
    input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100,
    output_tokens: 50 }));
  assert.equal(u.cacheWrite, 100);
  assert.equal(u.input, 300);              // 1000 - 600(캐시읽기) - 100(캐시쓰기)
  assert.equal(u.billable, 300 + 50 + 100);
});

test('parseCodexTotals 는 레코드가 없거나 깨졌으면 null', () => {
  assert.equal(usage.parseCodexTotals(''), null);
  assert.equal(usage.parseCodexTotals('{깨짐'), null);
  assert.equal(usage.parseCodexTotals(JSON.stringify({ type: 'event_msg', payload: {} })), null);
  // 키 이름만 있고 값이 객체가 아니면 건너뛴다
  assert.equal(usage.parseCodexTotals('{"total_token_usage":5}'), null);
});

test('forCodexFile 은 파일 끝만 읽고 mtime+size 로 캐시한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-cxusage-'));
  const f = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(f, [
    tokenCountLine({ input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }),
    tokenCountLine({ input_tokens: 20, cached_input_tokens: 8, output_tokens: 3 }),
  ].join('\n') + '\n', 'utf8');
  const a = usage.forCodexFile(f);
  const b = usage.forCodexFile(f);
  assert.equal(a.billable, (20 - 8) + 3);
  assert.strictEqual(a, b);   // 캐시라 같은 객체
});

test('forCodexFile 은 없는 파일과 token_count 없는 파일에 null', () => {
  assert.equal(usage.forCodexFile('C:\\없는\\rollout.jsonl'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-cxusage-'));
  const f = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: {} }) + '\n', 'utf8');
  assert.equal(usage.forCodexFile(f), null);
});
