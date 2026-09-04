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

// ------------------------------------------------------------ Codex rollout

// threads.tokens_used 는 캐시 입력까지 포함한 세션 총량이라 Claude 의 billable
// 과 같은 자로 잰 값이 아니다 (실측: 26,078,648 중 24,819,456 이 캐시 입력).
// rollout jsonl 의 token_count 이벤트에 내역이 그대로 들어 있으므로 그걸 읽는다.
const CODEX_TAIL_BYTES = 256 * 1024;   // 실측: 마지막 token_count 는 EOF 에서 3KB 안쪽

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// {"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{…}}}}
// 이 레코드는 턴마다 누계로 다시 찍히므로 "마지막 것 하나"가 세션 총량이다(합치면 안 된다).
//
// Codex 의 input_tokens 는 cached_input_tokens 를 "포함한" 값이다
// (실측: total_tokens === input_tokens + output_tokens, tokens_used 컬럼과도 일치).
// Claude 의 input_tokens 는 캐시 읽기를 뺀 값이라 의미가 정반대다. 그래서 여기서
// 캐시분을 빼내 Claude 와 같은 정의(비캐시 입력 + 출력 + 캐시쓰기)로 맞춘다.
// 읽지 못하면 null - 부르는 쪽이 폴백을 고른다.
function parseCodexTotals(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"total_token_usage"') < 0) continue;   // 싼 사전 필터
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const t = j?.payload?.info?.total_token_usage;
    if (!t || typeof t !== 'object') continue;
    const u = empty();
    const inAll = Number(t.input_tokens) || 0;
    u.cacheRead = Number(t.cached_input_tokens) || 0;
    u.cacheWrite = Number(t.cache_write_input_tokens) || 0;
    u.input = Math.max(0, inAll - u.cacheRead - u.cacheWrite);
    u.output = Number(t.output_tokens) || 0;
    u.billable = u.input + u.output + u.cacheWrite;   // Claude 와 같은 식
    u.samples = 1;
    return u;
  }
  return null;
}

const cache = new Map();       // file -> { mtimeMs, size, u }
const codexCache = new Map();  // rollout file -> { mtimeMs, size, u }  (u 가 null 이어도 캐시한다)

// rollout 은 최대 9.4MB(실측)라 통째로 읽지 않고 끝부분만 본다.
function forCodexFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = codexCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.u;
  const text = readTail(file, CODEX_TAIL_BYTES);
  const u = text === null ? null : parseCodexTotals(text);
  codexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, u });
  return u;
}

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

module.exports = { sumUsage, forClaudeFile, parseCodexTotals, forCodexFile, fmt, empty };
