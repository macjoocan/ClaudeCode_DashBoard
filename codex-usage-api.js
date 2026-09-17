// Codex 계정 한도를 서버에 직접 물어본다. codex-metrics.js 의 rollout 경로와 짝이다.
//
// codex-metrics.js 는 로컬 기록(rollout JSONL)에서 읽으므로 **Codex 를 한 번 더
// 돌리기 전까지 숫자가 움직이지 않는다.** ChatGPT 앱이나 다른 기기에서 쓴 분량은
// 다음 턴이 기록될 때까지 안 보인다. 여기가 그 간극을 메운다.
//
//   GET https://chatgpt.com/backend-api/codex/usage
//   { "plan_type": "pro",
//     "rate_limit": { "primary_window": { "used_percent": 15,
//                                         "limit_window_seconds": 604800,
//                                         "reset_at": 1790000000 },
//                     "secondary_window": null },
//     "additional_rate_limits": [ { "limit_name": "premium", "rate_limit": {…} } ],
//     "credits": {…}, "rate_limit_reached_type": null }
//
// 같은 정보라도 기록 쪽과 이름이 다르다 — 창 길이가 분이 아니라 **초**로 오고
// resets_at 이 reset_at 이다. 라벨·플랜 이름은 codex-metrics 의 것을 그대로 쓴다.
// 그래야 실시간 값과 기록 값이 화면에서 같은 말로 보인다.
//
// ⚠️ 비공식 endpoint 다. codex-metrics 와 같은 규칙으로 **실패를 정상 상태로 다룬다** —
//    예외를 밖으로 던지지 않고 ok:false 만 돌려주며, 부르는 쪽이 기록 경로로 물러선다.
//
// ⚠️ 로컬 OAuth 토큰(~/.codex/auth.json)을 읽어 보낸다. 토큰은 Authorization 헤더에만
//    싣고 로그·응답·캐시 어디에도 남기지 않는다. 밖으로 나가는 건 퍼센트와 시각뿐이다.
//    (limits.js 가 Claude 쪽에서 쓰는 것과 같은 규칙)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');

const { planName, windowLabel } = require('./codex-metrics');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage';
const TIMEOUT = 15000;

const TTL_OK = 60 * 1000;      // 한도는 분 단위로 급변하지 않는다
const TTL_FAIL = 5 * 60 * 1000;
const FORCE_MIN = 30 * 1000;   // 손으로 눌러도 이만큼은 쉰다

// 토큰은 이 함수 밖으로 값이 나가지 않게 조심해서 쓴다. 절대 찍지 않는다.
function readCredential(home) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(home || CODEX_HOME, 'auth.json'), 'utf8')); }
  catch { return null; }
  const t = raw && raw.tokens;
  if (!t || !t.access_token) return null;
  return { token: String(t.access_token), accountId: t.account_id ? String(t.account_id) : null };
}

function httpGetUsage(cred) {
  return new Promise((resolve, reject) => {
    const req = https.get(USAGE_URL, {
      headers: {
        Authorization: 'Bearer ' + cred.token,      // 토큰은 여기에만
        'chatgpt-account-id': cred.accountId || '',
        originator: 'codex_cli_rs',
        accept: 'application/json',
        'user-agent': 'cc-launcher',
      },
      timeout: TIMEOUT,
    }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('시간 초과')); });
    req.on('error', e => reject(new Error(e.message)));
  });
}

// 창 하나를 게이지로. codex-metrics 의 gauge() 와 같은 모양을 낸다.
function toGauge(w, at, prefix, active) {
  if (!w || typeof w.used_percent !== 'number') return null;
  let resetsAt = null;
  if (typeof w.reset_at === 'number') resetsAt = new Date(w.reset_at * 1000).toISOString();
  else if (typeof w.reset_after_seconds === 'number') {
    resetsAt = new Date(at + w.reset_after_seconds * 1000).toISOString();
  }
  const secs = Number(w.limit_window_seconds) || 0;
  const label = windowLabel(secs ? Math.round(secs / 60) : 0, '사용 한도');
  return {
    label: prefix ? prefix + ' · ' + label : label,
    percent: Math.round(w.used_percent * 10) / 10,
    resetsAt,
    active: !!active,
    model: null,
  };
}

function toData(body, at) {
  const b = body || {};
  const rl = b.rate_limit || {};
  const reached = b.rate_limit_reached_type || null;

  const gauges = [];
  const p = toGauge(rl.primary_window, at, null, reached ? reached === 'primary' : true);
  if (p) gauges.push(p);
  const s = toGauge(rl.secondary_window, at, null, reached === 'secondary');
  if (s) gauges.push(s);

  // 모델별·기능별 한도. 기록 경로가 여러 바구니를 "이름 · 창" 으로 붙이는 것과 같은 규칙.
  for (const e of (Array.isArray(b.additional_rate_limits) ? b.additional_rate_limits : [])) {
    const name = (e && e.limit_name) || null;
    const r = (e && e.rate_limit) || {};
    for (const w of [r.primary_window, r.secondary_window]) {
      const g = toGauge(w, at, name, false);
      if (g) gauges.push(g);
    }
  }

  return {
    plan: planName(b.plan_type),
    subscription: b.plan_type || null,
    tier: (rl && rl.limit_id) || null,
    gauges,
    buckets: [],
    credits: b.credits && typeof b.credits === 'object' ? {
      hasCredits: !!b.credits.has_credits,
      unlimited: !!b.credits.unlimited,
      balance: b.credits.balance == null ? null : String(b.credits.balance),
    } : null,
    reached,
    extra: null,
    at,
    source: 'live',
  };
}

let cache = { at: 0, home: null, ok: false, r: null };
let inflight = null;

async function load(home, fetchUsage) {
  const cred = readCredential(home);
  if (!cred) return { ok: false, reason: '자격증명을 찾지 못했습니다' };

  let res;
  try { res = await fetchUsage(cred); }
  catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }

  if (!res || res.status !== 200) {
    return { ok: false, reason: 'HTTP ' + ((res && res.status) || '?') };
  }
  let body;
  try { body = JSON.parse(res.body); }
  catch { return { ok: false, reason: '응답을 읽지 못했습니다' }; }

  const data = toData(body, Date.now());
  if (!data.gauges.length) return { ok: false, reason: '응답에 한도가 없습니다' };
  return { ok: true, data };
}

function limits(opts) {
  const home = (opts && opts.home) || CODEX_HOME;
  const force = !!(opts && opts.force);
  const fetchUsage = (opts && opts.fetchUsage) || httpGetUsage;

  const ttl = force ? FORCE_MIN : (cache.ok ? TTL_OK : TTL_FAIL);
  if (cache.r && cache.home === home && Date.now() - cache.at < ttl) return Promise.resolve(cache.r);
  if (inflight) return inflight;

  inflight = load(home, fetchUsage)
    .catch(e => ({ ok: false, reason: String((e && e.message) || e) }))
    .then(r => {
      cache = { at: Date.now(), home, ok: r.ok, r };
      inflight = null;
      return r;
    });
  return inflight;
}

module.exports = { readCredential, toGauge, toData, limits, CODEX_HOME };
