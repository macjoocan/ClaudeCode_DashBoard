// 세션 토큰 사용량. Claude 는 파일을 통째로 읽어야 나오므로
// scan() 에서 부르지 않는다 - /api/usage 에서 요청 시에만 계산하고 캐시한다.
'use strict';

const fs = require('node:fs');

function empty() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0, samples: 0 };
}

function sumUsage(text) {
  const u = empty();
  for (const line of String(text || '').split('\n')) {
    if (!line || line.indexOf('"usage"') < 0) continue;   // 싼 사전 필터
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const g = j?.message?.usage;
    if (!g || typeof g !== 'object') continue;
    u.input += Number(g.input_tokens) || 0;
    u.output += Number(g.output_tokens) || 0;
    u.cacheWrite += Number(g.cache_creation_input_tokens) || 0;
    u.cacheRead += Number(g.cache_read_input_tokens) || 0;
    u.samples++;
  }
  // cache_read 는 매 턴 같은 컨텍스트를 다시 읽는 값이라 누적하면
  // 실제 소비량을 크게 부풀린다. 따로 보여주되 billable 에서는 뺀다.
  u.billable = u.input + u.output + u.cacheWrite;
  return u;
}

const cache = new Map();   // file -> { mtimeMs, size, u }

function forClaudeFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return empty(); }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.u;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return empty(); }
  const u = sumUsage(text);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, u });
  return u;
}

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(v);
}

module.exports = { sumUsage, forClaudeFile, fmt, empty };
