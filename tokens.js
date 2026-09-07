// 토큰 사용량 집계.
//
// 출처는 이미 스캔하고 있는 세션 기록이다:
//   ~/.claude/projects/<슬러그>/<sessionId>.jsonl          부모 세션
//   ~/.claude/projects/<슬러그>/<sessionId>/subagents/*.jsonl  서브에이전트
//
// `type:"assistant"` 라인의 `message.usage` 를 읽는다:
//   input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
//   output_tokens_details.thinking_tokens          (사고 토큰 - output 에 포함된 값)
//   cache_creation.ephemeral_1h/5m_input_tokens    (캐시 쓰기 단가가 갈린다)
//
// 주의할 점 세 가지 (Token_Poketmon 의 M0 검증 문서에서 확인된 것):
//   1) 같은 응답이 스트리밍·재개로 여러 번 기록되고 output 이 점점 커진다.
//      그래서 (message.id | requestId) 별로 **합이 가장 큰 항목**만 남긴다.
//      먼저 나온 것을 남기면 부분 output 만 잡혀 과소집계된다.
//   2) `<synthetic>` 모델 라인은 실제 호출이 아니므로 제외한다.
//   3) `iterations[]` 는 내부 분해 값이라 더하면 이중 계산이 된다. 최상위 값만 쓴다.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = process.env.CC_CLAUDE_HOME
  ? path.join(process.env.CC_CLAUDE_HOME, 'projects')
  : path.join(os.homedir(), '.claude', 'projects');

const WIN5H_MS = 5 * 60 * 60 * 1000;
const TAIL_START = 2 * 1024 * 1024;    // 꼬리부터 이만큼 읽어보고
const TAIL_MAX = 32 * 1024 * 1024;     // 필요하면 여기까지 넓힌다
const CACHE_MAX = 400;

// path -> { mtime, size, entries }
const cache = new Map();

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function readChunk(file, start, length) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// projects 아래 모든 jsonl (서브에이전트 포함). mtime 이 cutoff 이후인 것만.
function jsonlFiles(cutoff) {
  const out = [];
  const walk = dir => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) { walk(p); continue; }
      if (!it.name.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.size === 0) continue;
      if (cutoff && st.mtimeMs < cutoff) continue;   // 관심 구간에 활동이 없는 파일
      out.push({ path: p, size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(PROJECTS_DIR);
  return out;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

// 라인 하나 -> 사용량 항목. 아니면 null.
function parseLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) return null;
  const model = o.message.model || 'unknown';
  if (model === '<synthetic>') return null;          // 실제 호출이 아니다
  const u = o.message.usage;
  const at = Date.parse(o.timestamp || '');
  if (!isFinite(at)) return null;

  const cc = u.cache_creation || {};
  return {
    id: (o.message.id || '') + '|' + (o.requestId || ''),
    at, model,
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    thinking: num(u.output_tokens_details && u.output_tokens_details.thinking_tokens),
    cache1h: num(cc.ephemeral_1h_input_tokens),
    cache5m: num(cc.ephemeral_5m_input_tokens),
    sessionId: o.sessionId || null,
    cwd: o.cwd || null,
  };
}

function entryTotal(e) { return e.input + e.output + e.cacheWrite + e.cacheRead; }

// 같은 id 는 합이 가장 큰 것만 남긴다
function dedupKeepMax(list) {
  const by = new Map();
  for (const e of list) {
    const prev = by.get(e.id);
    if (!prev || entryTotal(e) > entryTotal(prev)) by.set(e.id, e);
  }
  return [...by.values()];
}

// 파일 꼬리에서 cutoff 이후 항목을 찾는다.
// jsonl 은 시간순 append 라, 꼬리에서 거꾸로 넓혀 읽다가 cutoff 보다 오래된 걸 만나면 멈춘다.
function entriesFromFile(f, cutoff) {
  const hit = cache.get(f.path);
  if (hit && hit.mtime === f.mtime && hit.size === f.size) return hit.entries;

  let want = Math.min(TAIL_START, f.size);
  let entries = [];
  while (true) {
    const start = Math.max(0, f.size - want);
    const text = readChunk(f.path, start, f.size - start);
    const lines = text.split('\n');
    if (start > 0) lines.shift();          // 잘린 첫 줄 버림

    entries = [];
    let oldest = Infinity;
    for (const line of lines) {
      // 두 리터럴이 다 있는 줄만 JSON 파싱 (전체 파싱은 너무 느리다)
      if (!line || line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) continue;
      const e = parseLine(line);
      if (!e) continue;
      entries.push(e);
      if (e.at < oldest) oldest = e.at;
    }

    // 아직 cutoff 이전까지 못 갔고 더 읽을 게 남았으면 창을 넓힌다
    const needMore = oldest > cutoff && start > 0 && want < TAIL_MAX;
    if (!needMore) break;
    want = Math.min(want * 4, TAIL_MAX, f.size);
  }

  entries = dedupKeepMax(entries);
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(f.path, { mtime: f.mtime, size: f.size, entries });
  return entries;
}

function emptyBucket() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0,
           cache1h: 0, cache5m: 0, total: 0, calls: 0 };
}
function addTo(b, e) {
  b.input += e.input; b.output += e.output;
  b.cacheWrite += e.cacheWrite; b.cacheRead += e.cacheRead;
  b.thinking += e.thinking; b.cache1h += e.cache1h; b.cache5m += e.cache5m;
  b.total += entryTotal(e); b.calls++;
}

function usage() {
  const t0 = Date.now();
  const dayStart = startOfToday();
  const winStart = Date.now() - WIN5H_MS;
  const cutoff = Math.min(dayStart, winStart);

  const files = jsonlFiles(cutoff);
  let all = [];
  let bytes = 0;
  for (const f of files) {
    bytes += f.size;
    all = all.concat(entriesFromFile(f, cutoff));
  }
  all = dedupKeepMax(all);      // 파일 간 중복(재개로 다른 파일에 같은 응답)까지 제거

  const today = emptyBucket();
  const win5h = emptyBucket();
  const models = {};
  const sessions = {};

  for (const e of all) {
    if (e.at >= dayStart) {
      addTo(today, e);
      const m = models[e.model] || (models[e.model] = emptyBucket());
      addTo(m, e);
      if (e.sessionId) {
        const s = sessions[e.sessionId] || (sessions[e.sessionId] = { cwd: e.cwd, b: emptyBucket() });
        addTo(s.b, e);
      }
    }
    if (e.at >= winStart) addTo(win5h, e);
  }

  // 세션은 많을 수 있으니 상위만
  const topSessions = Object.entries(sessions)
    .map(([id, v]) => ({ sessionId: id, cwd: v.cwd, ...v.b }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return {
    at: Date.now(),
    today, win5h,
    models: Object.entries(models)
      .map(([model, b]) => ({ model, ...b }))
      .sort((a, b) => b.total - a.total),
    sessions: topSessions,
    win5hStart: winStart,
    dayStart,
    scanned: { files: files.length, bytes, ms: Date.now() - t0, entries: all.length },
  };
}

module.exports = { usage, PROJECTS_DIR };
