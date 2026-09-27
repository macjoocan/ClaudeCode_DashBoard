'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const metrics = require('../codex-metrics');

// limits() 는 리셋 시각이 이미 지난 게이지를 '옛 수치' 로 보고 버린다.
// 한도 픽스처는 지금 기준 미래여야 살아 있는 창을 흉내 낸다.
const SOON = Math.floor(Date.now() / 1000) + 3 * 3600;
const LATER = Math.floor(Date.now() / 1000) + 5 * 86400;

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

test('usage 는 읽는 중 rollout 이 커져도 반복을 끝낸다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-growing-'));
  const file = path.join(dir, 'rollout.jsonl');
  const at = new Date().toISOString();
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024) + '\n' +
    line(at, { input_tokens: 10, output_tokens: 2 }, { total_tokens: 12 }) + '\n');
  const script = `
    const fs = require('node:fs');
    const metrics = require(${JSON.stringify(path.resolve(__dirname, '../codex-metrics'))});
    const file = process.argv[1];
    const original = fs.statSync;
    let reads = 0;
    fs.statSync = function (target, ...args) {
      const stat = original.call(this, target, ...args);
      if (target === file && ++reads === 2) fs.appendFileSync(file, 'more\\n');
      return stat;
    };
    const out = metrics.usage([{ id: 'growing', cwd: process.cwd(), rolloutPath: file }]);
    console.log(JSON.stringify({ calls: out.today.calls, reads }));
  `;
  const child = spawnSync(process.execPath, ['-e', script, file],
    { encoding: 'utf8', timeout: 2000 });
  assert.equal(child.error?.code, undefined, `usage hung while reading ${file}: ${child.error?.message}`);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { calls: 1, reads: 2 });
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
    primary: { used_percent: p, window_minutes: 10080, resets_at: LATER },
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

// 실측: 2026-09-16 에 모델을 바꾸자 Codex 가 limit_id 를 'codex' -> 'codex_bengalfox' 로
// 갈아탔다. 새 바구니는 0%/0% 라, 마지막 레코드만 보던 예전 코드는 실제로 36% 차 있던
// 기존 한도를 가리고 '0%' 만 보여줬다.
test('limits 는 모델 계열(limit_id)별로 한도를 따로 모은다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-buckets-'));
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, [
    line('2026-09-16T00:00:00Z', {}, {}, {
      limit_id: 'codex', plan_type: 'prolite',
      primary: { used_percent: 36, window_minutes: 10080, resets_at: LATER },
    }),
    // 나중에 기록됐지만 텅 빈 다른 바구니
    line('2026-09-17T05:00:00Z', {}, {}, {
      limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark', plan_type: 'prolite',
      primary: { used_percent: 0, window_minutes: 300, resets_at: SOON },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: LATER },
    }),
  ].join(String.fromCharCode(10)));

  const out = metrics.limits([{ rolloutPath: file }]);
  assert.equal(out.ok, true);
  assert.equal(out.data.buckets.length, 2);
  // 실제로 찬 바구니가 먼저 와야 헤더의 두 칸에 그게 잡힌다
  assert.equal(out.data.gauges[0].percent, 36);
  // 바구니가 둘 이상이면 어느 계열 수치인지 라벨에 박는다
  assert.ok(out.data.gauges.some(g => g.label.indexOf('GPT-5.3-Codex-Spark') === 0));
});

test('바구니가 하나면 라벨에 계열 이름을 붙이지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-one-'));
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, line('2026-09-16T00:00:00Z', {}, {}, {
    limit_id: 'codex', limit_name: 'Codex', plan_type: 'prolite',
    primary: { used_percent: 12, window_minutes: 300, resets_at: SOON },
  }));
  const out = metrics.limits([{ rolloutPath: file }]);
  assert.deepEqual(out.data.gauges.map(g => g.label), ['5시간 세션']);
});

// 한 모델로 90% 까지 쓰고 다른 모델로 갈아타면, 옛 바구니는 새 기록이 안 쓰인다.
// 창이 실제로 리셋된 뒤에도 90% 로 박제돼 헤더 두 칸을 차지하면 안 된다.
test('limits 는 창이 이미 리셋된 옛 바구니를 버린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-stale-'));
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, [
    line('2026-09-01T00:00:00Z', {}, {}, {
      limit_id: 'old-model', limit_name: '옛 모델', plan_type: 'prolite',
      primary: { used_percent: 90, window_minutes: 10080, resets_at: 1780000000 },
    }),
    line('2026-09-17T00:00:00Z', {}, {}, {
      limit_id: 'new-model', limit_name: '새 모델', plan_type: 'prolite',
      primary: { used_percent: 5, window_minutes: 10080, resets_at: LATER },
    }),
  ].join(String.fromCharCode(10)));

  const out = metrics.limits([{ rolloutPath: file }]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.data.buckets.map(b => b.limitId), ['new-model']);
  assert.equal(out.data.gauges[0].percent, 5);
});

// 시각을 못 읽는 레코드를 '지금' 으로 찍으면 그 바구니가 진짜 최신 기록을 영영 이긴다.
test('limits 는 timestamp 가 깨진 레코드를 무시한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-badts-'));
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, [
    line('2026-09-17T00:00:00Z', {}, {}, {
      limit_id: 'codex', plan_type: 'prolite',
      primary: { used_percent: 41, window_minutes: 10080, resets_at: LATER },
    }),
    line('깨진 시각', {}, {}, {
      limit_id: 'codex', plan_type: 'prolite',
      primary: { used_percent: 3, window_minutes: 10080, resets_at: LATER },
    }),
  ].join(String.fromCharCode(10)));

  const out = metrics.limits([{ rolloutPath: file }]);
  assert.equal(out.data.gauges[0].percent, 41);
});
