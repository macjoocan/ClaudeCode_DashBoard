// Claude 사용 한도(%) 와 리셋 시각. `/usage` 가 보여주는 그 정보다.
//
// 토큰 사용량(tokens.js)은 세션 기록을 세서 만든 값이라 "내가 얼마나 썼나"는 알아도
// **한도까지 얼마나 남았는지는 모른다.** 그건 서버만 안다. 그래서 따로 물어본다.
//
// ⚠️ 비공식 endpoint 다. 실패해도 나머지 표시에 영향이 없어야 하므로, 안 되면
//    한도 칸만 숨긴다 (오류를 화면에 띄우지 않는다).
//
// ⚠️ 로컬 OAuth 토큰을 읽어 Anthropic 서버로 보낸다. 토큰은 Authorization 헤더에만
//    싣고, 로그·응답·캐시 어디에도 남기지 않는다. 밖으로 나가는 건 퍼센트와 시각뿐이다.
//
// 자격증명 위치와 응답 형태는 Token_Poketmon 의 oauth_limits.rs 에서 확인된 것을 따랐다
// (팀 계정 실측). Windows 는 토큰이 파일에 있어 파일만 읽으면 된다.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

// 이 endpoint 는 자주 부르면 429 를 준다 (실측으로 걸려봤다).
// 한도 수치는 분 단위로 급변하지 않으니 넉넉히 쉰다.
const TTL_OK = 3 * 60 * 1000;     // 성공하면 3분
const TTL_FAIL = 5 * 60 * 1000;   // 그냥 실패는 5분
const TTL_429 = 20 * 60 * 1000;   // 한도 초과는 훨씬 길게 - 더 두드리면 더 막힌다
const TIMEOUT = 15000;

// 캐시를 파일에도 남긴다.
//
// 메모리에만 두면 서버를 다시 띄울 때마다 곧장 다시 물어본다. 오늘 대시보드를 여러 번
// 재시작했더니 그 때문에 429 를 맞았다. 재시작이 백오프를 지우면 안 된다.
// 마지막으로 성공한 값도 같이 남긴다 - 못 가져올 때 화면을 `—` 로 비우는 대신
// 그 값을 보여주려면 재시작 뒤에도 들고 있어야 한다.
const CACHE_FILE = path.join(os.homedir(), '.claude', '.cc-launcher-limits.json');

let cache = { at: 0, ok: false, data: null };
let lastGood = null;              // { at, data } - 마지막으로 성공한 응답의 본문
let inflight = null;

try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (saved && typeof saved.at === 'number') cache = { at: saved.at, ok: !!saved.ok, data: saved.data || null };
  if (saved && saved.lastGood && saved.lastGood.data) lastGood = saved.lastGood;
} catch (e) { /* 없거나 깨졌으면 그냥 새로 시작한다 */ }

function persist() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      at: cache.at, ok: cache.ok, data: cache.data, lastGood,
    }), 'utf8');
  } catch (e) { /* 못 써도 동작에는 지장이 없다 */ }
}

// 자격증명을 읽는다. accessToken 은 이 함수 밖으로 값이 나가지 않게 조심해서 쓴다.
function readCredential() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { return null; }
  const o = raw && raw.claudeAiOauth;
  if (!o || !o.accessToken) return null;

  // expiresAt 은 초일 수도 밀리초일 수도 있다
  let exp = Number(o.expiresAt) || 0;
  if (exp > 1e10) exp = Math.floor(exp / 1000);

  return {
    token: String(o.accessToken),
    expiresAt: exp || null,
    subscription: o.subscriptionType || null,
    tier: o.rateLimitTier || null,
  };
}

// "default_claude_max_5x" 에서 배수만 뽑는다
function tierMultiplier(tier) {
  for (const part of String(tier || '').split('_')) {
    if (/^\d+x$/.test(part)) return part;
  }
  return null;
}
// team + default_claude_max_5x -> "Team 5x"
function planName(subscription, tier) {
  const s = String(subscription || '').trim();
  if (!s) return null;
  const base = s.charAt(0).toUpperCase() + s.slice(1);
  const mult = tierMultiplier(tier);
  return mult ? base + ' ' + mult : base;
}

function get(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Authorization: 'Bearer ' + token,      // 토큰은 여기에만
        'anthropic-beta': 'oauth-2025-04-20',
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

// 창 하나를 게이지로. utilization 이 없으면 버린다.
function gauge(label, w, opts) {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    label,
    percent: Math.round(w.utilization * 10) / 10,
    resetsAt: w.resets_at || null,
    active: !!(opts && opts.active),
    model: (opts && opts.model) || null,
  };
}

function parseBody(body, cred) {
  const j = JSON.parse(body);
  const gauges = [];

  const g5 = gauge('5시간 세션', j.five_hour);
  if (g5) gauges.push(g5);
  const g7 = gauge('주간', j.seven_day);
  if (g7) gauges.push(g7);

  // limits[] 에는 모델별로 좁혀진 창이 더 온다. 위 둘과 겹치지 않는 것만 더한다.
  const KIND_KO = { session: '5시간 세션', weekly_all: '주간', weekly_scoped: '주간(모델별)' };
  for (const e of (Array.isArray(j.limits) ? j.limits : [])) {
    if (typeof e.percent !== 'number') continue;
    const model = e.scope && e.scope.model && e.scope.model.display_name;
    const label = (KIND_KO[e.kind] || e.kind || '한도') + (model ? ' · ' + model : '');
    // five_hour / seven_day 로 이미 넣은 것과 같은 창이면 활성 여부만 반영하고 넘어간다
    const same = gauges.find(x => x.label === label && x.percent === Math.round(e.percent * 10) / 10);
    if (same) { same.active = same.active || !!e.is_active; continue; }
    gauges.push({
      label,
      percent: Math.round(e.percent * 10) / 10,
      resetsAt: e.resets_at || null,
      active: !!e.is_active,
      model: model || null,
    });
  }

  // 추가 사용량(초과분 결제)이 켜져 있으면 같이 알려준다
  let extra = null;
  if (j.extra_usage && j.extra_usage.is_enabled) {
    extra = {
      enabled: true,
      percent: typeof j.extra_usage.utilization === 'number' ? j.extra_usage.utilization : null,
      monthlyLimit: j.extra_usage.monthly_limit || null,
    };
  }

  return {
    plan: planName(cred.subscription, cred.tier),
    subscription: cred.subscription,
    tier: cred.tier,
    gauges,
    extra,
    at: Date.now(),
  };
}

async function load() {
  const cred = readCredential();
  if (!cred) return { ok: false, reason: '자격증명을 찾지 못했습니다', noCredential: true };

  // 만료 60초 전이면 만료로 본다. Claude Code 가 곧 갱신하므로 다음 번에 다시 된다.
  if (cred.expiresAt && cred.expiresAt <= Math.floor(Date.now() / 1000) + 60) {
    return { ok: false, reason: '토큰이 만료됐습니다 (Claude Code 가 갱신하면 다시 보입니다)' };
  }

  let res;
  try { res = await get(USAGE_URL, cred.token); }
  catch (e) { return { ok: false, reason: String(e.message) }; }

  if (res.status !== 200) {
    // 429 는 따로 표시해서 더 오래 쉬게 한다
    return { ok: false, reason: 'HTTP ' + res.status, rateLimited: res.status === 429 };
  }
  try {
    return { ok: true, data: parseBody(res.body, cred) };
  } catch (e) {
    return { ok: false, reason: '응답을 읽지 못했습니다' };
  }
}

// 캐시를 앞에 둔다. 화면이 얼마나 자주 물어도 endpoint 는 위 TTL 만큼만 두드린다.
const FORCE_MIN = 30 * 1000;   // 손으로 눌러도 이만큼은 쉰다

// 결과를 캐시에 넣고 파일에 남긴다.
//
// 못 가져왔으면 **마지막으로 성공한 값**을 함께 딸려 보낸다. 429 는 20분을 쉬는데
// 그동안 화면이 `—` 로만 남으면 "잘 보이던 게 사라졌다" 로 보인다. 지난 값이라도
// 언제 것인지 밝혀서 보여주는 편이 낫다 - 한도는 분 단위로 급변하지 않는다.
function withStale(r) {
  if (!r || r.ok || !lastGood || r.stale) return r;
  return Object.assign({}, r, { stale: lastGood });
}

function finish(r) {
  if (r.ok && r.data) lastGood = { at: Date.now(), data: r.data };
  r = withStale(r);
  cache = { at: Date.now(), ok: !!r.ok, data: r };
  inflight = null;
  persist();
  return r;
}

function limits(opts) {
  const force = !!(opts && opts.force);
  const ttl = force ? FORCE_MIN
    : (cache.ok ? TTL_OK
      : (cache.data && cache.data.rateLimited ? TTL_429 : TTL_FAIL));
  // 같은 것을 돌려줄 때도 지난 값을 같이 붙인다. 429 는 20분을 쉬는데
  // 그 동안은 여기로만 나간다 - 여기서 빼먹으면 화면은 계속 비어 있다.
  if (cache.data && Date.now() - cache.at < ttl) return Promise.resolve(withStale(cache.data));
  if (inflight) return inflight;

  inflight = load().then(r => finish(r)).catch(e => finish({
    ok: false, reason: String((e && e.message) || e),
  }));
  return inflight;
}

module.exports = { limits };
