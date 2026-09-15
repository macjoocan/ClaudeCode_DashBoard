// UI 와 HTTP 계층이 provider 별 저장 형식을 몰라도 되게 지표 응답을 한곳에서 조립한다.
'use strict';

const claudeLimits = require('./limits');
const claudeTokens = require('./tokens');
const codexMetrics = require('./codex-metrics');

async function limits(rows, opts) {
  const [claude, codex] = await Promise.all([
    claudeLimits.limits(opts),
    Promise.resolve(codexMetrics.limits(rows)),
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
