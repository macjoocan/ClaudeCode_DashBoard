const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../codex-usage-api.js');

// https://chatgpt.com/backend-api/codex/usage 가 돌려주는 모양 (실측).
// rollout 기록과 달리 창 길이가 분이 아니라 **초**로 오고, 필드 이름도 다르다
// (used_percent 는 같지만 window_minutes -> limit_window_seconds, resets_at -> reset_at).
const LIVE = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 15, limit_window_seconds: 604800,
                      reset_after_seconds: 330000, reset_at: 1790000000 },
    secondary_window: null,
  },
  additional_rate_limits: [
    { limit_name: 'premium',
      rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1789900000 },
                    secondary_window: null } },
  ],
  credits: { has_credits: false, unlimited: false, balance: '0' },
  rate_limit_reached_type: null,
};

// ------------------------------------------------------------ 응답 -> 게이지

test('toData 는 주 한도를 게이지로 만든다', () => {
  const d = api.toData(LIVE, Date.parse('2026-09-17T10:00:00.000Z'));
  assert.equal(d.gauges[0].label, '주간');          // 604800초 = 10080분
  assert.equal(d.gauges[0].percent, 15);
  assert.equal(d.gauges[0].resetsAt, new Date(1790000000 * 1000).toISOString());
  assert.equal(d.gauges[0].active, true);
  assert.equal(d.plan, 'Pro');
  assert.equal(d.source, 'live');
});

test('toData 는 reset_at 이 없으면 reset_after_seconds 로 계산한다', () => {
  const at = Date.parse('2026-09-17T10:00:00.000Z');
  const body = { ...LIVE, rate_limit: { primary_window:
    { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 600 } } };
  const d = api.toData(body, at);
  assert.equal(d.gauges[0].resetsAt, new Date(at + 600 * 1000).toISOString());
});

// codex-metrics 의 local 경로가 여러 바구니를 "이름 · 창" 으로 붙이는 것과 같은 규칙.
test('toData 는 모델별 한도에 이름을 붙여 게이지로 만든다', () => {
  const d = api.toData(LIVE, Date.now());
  const extra = d.gauges.find(g => g.label.startsWith('premium'));
  assert.equal(extra.label, 'premium · 5시간 세션');
  assert.equal(extra.percent, 100);
});

test('toData 는 secondary_window 도 게이지로 만든다', () => {
  const body = { ...LIVE, rate_limit: { ...LIVE.rate_limit,
    secondary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: 1789900000 } } };
  const d = api.toData(body, Date.now());
  assert.equal(d.gauges[1].label, '5시간 세션');
  assert.equal(d.gauges[1].active, false);
});

test('toData 는 used_percent 가 없는 창을 버린다', () => {
  const d = api.toData({ ...LIVE, rate_limit: { primary_window: { limit_window_seconds: 300 } },
    additional_rate_limits: [] }, Date.now());
  assert.equal(d.gauges.length, 0);
});

// codex-metrics.limits() 와 같은 모양이어야 화면이 둘을 구분 없이 그린다.
test('toData 는 local 경로와 같은 형태의 credits 를 낸다', () => {
  const off = api.toData(LIVE, Date.now());
  assert.deepEqual(off.credits, { hasCredits: false, unlimited: false, balance: '0' });
  const on = api.toData({ ...LIVE,
    credits: { has_credits: true, unlimited: false, balance: '12.50' } }, Date.now());
  assert.equal(on.credits.hasCredits, true);
  assert.equal(on.credits.balance, '12.50');
});

test('toData 는 한도에 걸린 종류를 그대로 전한다', () => {
  const d = api.toData({ ...LIVE, rate_limit_reached_type: 'primary' }, Date.now());
  assert.equal(d.reached, 'primary');
});

// ------------------------------------------------------------ 자격증명

test('readCredential 은 auth.json 에서 토큰을 꺼낸다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codexapi-'));
  try {
    fs.writeFileSync(path.join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'T', account_id: 'A' } }));
    const c = api.readCredential(dir);
    assert.equal(c.token, 'T');
    assert.equal(c.accountId, 'A');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readCredential 은 파일이 없거나 토큰이 없으면 null 이다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codexapi2-'));
  try {
    assert.equal(api.readCredential(dir), null);
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: {} }));
    assert.equal(api.readCredential(dir), null);
    fs.writeFileSync(path.join(dir, 'auth.json'), '깨진 JSON');
    assert.equal(api.readCredential(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ 바깥에서 부르는 모양

function homeWithAuth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codexapi3-'));
  fs.writeFileSync(path.join(dir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'T', account_id: 'A' } }));
  return dir;
}

test('limits 는 서버 응답을 data 로 돌려준다', async () => {
  const dir = homeWithAuth();
  try {
    const r = await api.limits({ home: dir, force: true,
      fetchUsage: async () => ({ status: 200, body: JSON.stringify(LIVE) }) });
    assert.equal(r.ok, true);
    assert.equal(r.data.source, 'live');
    assert.equal(r.data.gauges[0].percent, 15);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 실패는 정상 상태다. 부르는 쪽(provider-metrics)이 파일 경로로 물러설 수 있어야 한다.
test('limits 는 자격증명이 없으면 ok:false 로 조용히 물러난다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codexapi4-'));
  try {
    const r = await api.limits({ home: dir, force: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /자격증명/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits 는 HTTP 오류를 이유로 남기고 물러난다', async () => {
  const dir = homeWithAuth();
  try {
    const r = await api.limits({ home: dir, force: true,
      fetchUsage: async () => ({ status: 401, body: '{}' }) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /401/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits 는 연결 예외를 밖으로 던지지 않는다', async () => {
  const dir = homeWithAuth();
  try {
    const r = await api.limits({ home: dir, force: true,
      fetchUsage: async () => { throw new Error('연결 실패'); } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /연결 실패/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits 는 게이지가 하나도 없는 응답을 성공으로 치지 않는다', async () => {
  const dir = homeWithAuth();
  try {
    const r = await api.limits({ home: dir, force: true,
      fetchUsage: async () => ({ status: 200, body: JSON.stringify({ plan_type: 'pro' }) }) });
    assert.equal(r.ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
