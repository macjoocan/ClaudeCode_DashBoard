'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const metrics = require('../codex-metrics');

function line(timestamp, last, total, rateLimits) {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: {
    type: 'token_count',
    info: { last_token_usage: last, total_token_usage: total || last },
    rate_limits: rateLimits,
  } });
}

test('usageFromTokenCount 는 캐시 입력을 분리하고 총량은 보존한다', () => {
  const j = JSON.parse(line('2026-09-14T01:00:00Z', {
    input_tokens: 1000, cached_input_tokens: 700, cache_write_input_tokens: 100,
    output_tokens: 50, reasoning_output_tokens: 20,
  }));
  const u = metrics.usageFromTokenCount(j);
  assert.equal(u.input, 200);
  assert.equal(u.cacheRead, 700);
  assert.equal(u.cacheWrite, 100);
  assert.equal(u.output, 50);
  assert.equal(u.thinking, 20);
  assert.equal(u.total, 1050);
});

test('parseUsageEntries 는 같은 누계 스냅샷의 반복 기록을 한 번만 센다', () => {
  const l = line('2026-09-14T01:00:00Z', { input_tokens: 10, output_tokens: 2 },
    { input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  assert.equal(metrics.parseUsageEntries(l + '\n' + l, false).length, 1);
});

test('usage 는 오늘과 최근 5시간을 나눠 집계한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-metrics-'));
  const file = path.join(dir, 'rollout.jsonl');
  const now = Date.parse('2026-09-14T12:00:00Z');
  fs.writeFileSync(file, [
    line('2026-09-14T02:00:00Z', { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 }, { total_tokens: 110 }),
    line('2026-09-14T10:00:00Z', { input_tokens: 200, cached_input_tokens: 150, output_tokens: 20 }, { total_tokens: 330 }),
  ].join('\n') + '\n');
  fs.utimesSync(file, new Date(now), new Date(now));
  const out = metrics.usage([{ id: 's1', cwd: 'C:\\work', rolloutPath: file }], now);
  assert.equal(out.today.total, 330);
  assert.equal(out.today.calls, 2);
  assert.equal(out.win5h.total, 220);
  assert.equal(out.win5h.calls, 1);
  assert.equal(out.sessions[0].sessionId, 's1');
});

test('parseRateLimits 는 Codex 시간 창을 공통 게이지 형태로 바꾼다', () => {
  const text = line('2026-09-14T10:00:00Z', {}, {}, {
    limit_id: 'codex', plan_type: 'team',
    primary: { used_percent: 17.25, window_minutes: 300, resets_at: 1780000000 },
    secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1780500000 },
    credits: { has_credits: true, unlimited: false, balance: '12.5' },
    individual_limit: null, rate_limit_reached_type: null,
  });
  const out = metrics.parseRateLimits(text);
  assert.equal(out.plan, 'Team');
  assert.deepEqual(out.gauges.map(g => g.label), ['5시간 세션', '주간']);
  assert.deepEqual(out.gauges.map(g => g.percent), [17.3, 4]);
  assert.equal(out.gauges[0].resetsAt, new Date(1780000000 * 1000).toISOString());
  assert.equal(out.credits.balance, '12.5');
});

test('limits 는 최신 rollout 의 한도를 사용하고 없으면 조용히 실패한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-limits-'));
  const oldFile = path.join(dir, 'old.jsonl');
  const newFile = path.join(dir, 'new.jsonl');
  const make = p => line('2026-09-14T10:00:00Z', {}, {}, {
    limit_id: 'codex', plan_type: 'prolite',
    primary: { used_percent: p, window_minutes: 10080, resets_at: 1780000000 },
  });
  fs.writeFileSync(oldFile, make(10));
  fs.writeFileSync(newFile, make(20));
  fs.utimesSync(oldFile, new Date(1000), new Date(1000));
  fs.utimesSync(newFile, new Date(2000), new Date(2000));
  const out = metrics.limits([{ rolloutPath: oldFile }, { rolloutPath: newFile }]);
  assert.equal(out.ok, true);
  assert.equal(out.data.plan, 'Pro');
  assert.equal(out.data.gauges[0].percent, 20);
  assert.equal(metrics.limits([]).noData, true);
});
