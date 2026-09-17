const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const providerMetrics = require('../provider-metrics.js');

// Codex 한도는 두 곳에서 얻을 수 있다.
//   실시간  chatgpt.com/backend-api/codex/usage   - 지금 값, 네트워크가 필요하다
//   기록    rollout JSONL 의 rate_limits          - 마지막 Codex 턴 시점의 값
// 실시간을 먼저 쓰고 안 되면 기록으로 물러선다. 이 파일은 그 선택을 고정한다.

const LIVE = {
  plan_type: 'pro',
  rate_limit: { primary_window: { used_percent: 15, limit_window_seconds: 604800,
                                  reset_at: 1790000000 }, secondary_window: null },
  additional_rate_limits: [],
  credits: { has_credits: false, unlimited: false, balance: '0' },
};

// rollout 한 줄 - 기록 경로가 읽는 형식. 리셋이 지난 게이지는 버려지므로 넉넉히 뒤로 둔다.
function rolloutFile(usedPercent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-pm-'));
  const file = path.join(dir, 'rollout.jsonl');
  const resets = Math.floor(Date.now() / 1000) + 86400;
  fs.writeFileSync(file, JSON.stringify({
    timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
      rate_limits: { limit_id: 'codex', plan_type: 'prolite',
        primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resets },
        secondary: null } },
  }) + '\n');
  return { dir, rows: [{ id: 'x', cwd: dir, rolloutPath: file }] };
}

function homeWithAuth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-pmhome-'));
  fs.writeFileSync(path.join(dir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'T', account_id: 'A' } }));
  return dir;
}

test('limits 는 실시간 값을 먼저 쓴다', async () => {
  const { dir, rows } = rolloutFile(40);
  const home = homeWithAuth();
  try {
    const r = await providerMetrics.limits(rows, {
      force: true, codexHome: home,
      fetchUsage: async () => ({ status: 200, body: JSON.stringify(LIVE) }),
    });
    assert.equal(r.providers.codex.ok, true);
    assert.equal(r.providers.codex.data.source, 'live');
    assert.equal(r.providers.codex.data.gauges[0].percent, 15);   // 기록의 40% 가 아니다
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 서버가 안 될 때 칸을 비우면 퇴보다. 기록에 있는 값이라도 보여준다.
test('limits 는 실시간이 안 되면 기록으로 물러선다', async () => {
  const { dir, rows } = rolloutFile(40);
  const home = homeWithAuth();
  try {
    const r = await providerMetrics.limits(rows, {
      force: true, codexHome: home,
      fetchUsage: async () => { throw new Error('연결 실패'); },
    });
    assert.equal(r.providers.codex.ok, true);
    assert.equal(r.providers.codex.data.source, 'local-rollout');
    assert.equal(r.providers.codex.data.gauges[0].percent, 40);
    assert.match(r.providers.codex.data.liveReason, /연결 실패/);   // 왜 물러섰는지 남긴다
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('limits 는 둘 다 안 되면 기록 쪽 사유를 그대로 낸다', async () => {
  const home = homeWithAuth();
  try {
    const r = await providerMetrics.limits([], {
      force: true, codexHome: home,
      fetchUsage: async () => ({ status: 500, body: '' }),
    });
    assert.equal(r.providers.codex.ok, false);
    assert.ok(r.providers.codex.reason);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('limits 는 Claude 쪽을 그대로 함께 낸다', async () => {
  const { dir, rows } = rolloutFile(40);
  const home = homeWithAuth();
  try {
    const r = await providerMetrics.limits(rows, {
      force: true, codexHome: home,
      fetchUsage: async () => ({ status: 200, body: JSON.stringify(LIVE) }),
    });
    assert.ok(Object.prototype.hasOwnProperty.call(r.providers, 'claude'));
    assert.equal(typeof r.at, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
