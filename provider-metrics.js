// UI 와 HTTP 계층이 provider 별 저장 형식을 몰라도 되게 지표 응답을 한곳에서 조립한다.
'use strict';

const claudeLimits = require('./limits');
const claudeTokens = require('./tokens');
const codexMetrics = require('./codex-metrics');
const codexApi = require('./codex-usage-api');

// Codex 한도는 두 곳에서 얻을 수 있고, 둘은 신선도가 다르다.
//   실시간  서버에 직접 물어본다        - 지금 값. 다른 기기·앱에서 쓴 분량까지 들어있다.
//   기록    rollout 의 rate_limits     - 마지막 Codex 턴 시점의 값. 그 뒤 사용분은 빠진다.
// 그래서 실시간을 먼저 쓰고, 안 될 때만 기록으로 물러선다. 기록으로 물러선 경우에는
// liveReason 을 남겨 화면이 "왜 옛 값인지" 를 말할 수 있게 한다.
async function codexLimits(rows, opts) {
  const live = await codexApi.limits({
    force: opts && opts.force,
    home: opts && opts.codexHome,
    fetchUsage: opts && opts.fetchUsage,
  });
  if (live.ok) return live;

  const local = codexMetrics.limits(rows);
  if (local && local.ok && local.data) local.data.liveReason = live.reason || null;
  return local;
}

async function limits(rows, opts) {
  const [claude, codex] = await Promise.all([
    claudeLimits.limits(opts),
    codexLimits(rows, opts),
  ]);
  return { providers: { claude, codex }, at: Date.now() };
}

function tokens(rows) {
  return {
    providers: {
      claude: Object.assign({ provider: 'claude' }, claudeTokens.usage()),
      codex: codexMetrics.usage(rows),
    },
    at: Date.now(),
  };
}

module.exports = { limits, tokens };
