// 훅 이벤트 수집 + 브라우저로 실시간 푸시(SSE) + 세션별 현재 상태 추론.
//
// Claude Code 의 http 훅이 이 서버로 직접 POST 한다 (프로세스 스폰 없음).
// 여기서는 링 버퍼에 쌓고, 붙어 있는 브라우저로 흘려보내고,
// "지금 무슨 툴을 돌리는 중인지 / 어떤 서브에이전트가 떠 있는지" 를 계산한다.
//
// 원칙: 훅은 Claude Code 를 기다리게 만든다. 여기서 하는 일은 전부 동기·메모리 작업이고
// 절대 예외를 밖으로 던지지 않는다.

const MAX_EVENTS = 400;         // 링 버퍼
const MAX_TEXT = 400;           // 저장할 문자열 길이 상한
const STALE_TOOL_MS = 5 * 60 * 1000;
const MAX_SPANS = 600;          // 타임라인용 툴 구간
const MAX_TURNS = 120;          // 프롬프트 단위 턴

let seq = 0;
const ring = [];
const clients = new Set();      // SSE 응답 객체
const sessions = new Map();     // sessionId -> 파생 상태

// ---- 타임라인용 자료
//
// 훅이 주는 필드로 누가 무엇을 언제 했는지 정확히 복원할 수 있다:
//   session_id  부모 세션 (서브에이전트가 돌 때도 부모 값이 온다)
//   agent_id    서브에이전트가 돌린 작업에만 붙는다 (부모 작업엔 없음)
//   agent_type  서브에이전트 종류 (Explore, code-reviewer …)
//   tool_use_id PreToolUse ↔ PostToolUse 짝짓기
//   duration_ms PostToolUse 에 실제 소요시간
//   prompt_id   한 프롬프트에서 파생된 모든 활동의 묶음 (= 턴)
const spans = [];               // 완료/진행 중인 툴 구간
const spanByTool = new Map();   // tool_use_id -> span
const turns = [];               // prompt_id 단위 턴
const turnById = new Map();
const agentRuns = [];           // 서브에이전트 실행 구간
const agentById = new Map();

function trim(arr, max) { while (arr.length > max) arr.shift(); }

// 레인 키: 부모는 세션, 서브에이전트는 세션+에이전트
function laneOf(sid, agentId) { return agentId ? sid + '/' + agentId : sid; }

function clip(v, n) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return null;
  return s.length > (n || MAX_TEXT) ? s.slice(0, (n || MAX_TEXT) - 1) + '…' : s;
}

// tool_input 에서 사람이 알아볼 한 줄을 뽑는다
function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return null;
  const pick = ['command', 'file_path', 'pattern', 'path', 'url', 'prompt', 'description',
                'query', 'subagent_type', 'skill', 'notebook_path'];
  for (const k of pick) {
    if (input[k]) return clip(String(input[k]).replace(/\s+/g, ' ').trim(), 160);
  }
  return clip(input, 160);
}

function state(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { sessionId, cwd: null, phase: 'idle', tools: new Map(), agents: new Map(),
          lastPrompt: null, lastTool: null, toolCount: 0, agentCount: 0,
          startedAt: Date.now(), updatedAt: Date.now(), model: null, permissionMode: null };
    sessions.set(sessionId, s);
  }
  return s;
}

// 훅이 실제로 보내는 필드를 이벤트 종류별로 모아둔다.
// 문서에 없는 필드(서브에이전트 식별자 등)가 오는지 확인하는 용도.
const rawKeys = {};
function noteKeys(name, ev) {
  const set = rawKeys[name] || (rawKeys[name] = {});
  for (const k of Object.keys(ev)) {
    if (!set[k]) set[k] = { n: 0, sample: null };
    set[k].n++;
    if (set[k].sample == null && ev[k] != null && typeof ev[k] !== 'object') {
      set[k].sample = String(ev[k]).slice(0, 60);
    }
  }
}

// 이벤트 하나를 받아 파생 상태를 갱신하고, 브라우저로 보낼 요약을 만든다
function ingest(raw) {
  const ev = raw && typeof raw === 'object' ? raw : {};
  const name = String(ev.hook_event_name || 'Unknown');
  const sid = ev.session_id || null;
  const now = Date.now();
  noteKeys(name, ev);

  const out = {
    n: ++seq, at: now, event: name,
    sessionId: sid, cwd: ev.cwd || null,
    tool: ev.tool_name || null,
    toolUseId: ev.tool_use_id || null,
    agentType: ev.agent_type || null,
    agentId: ev.agent_id || null,
    promptId: ev.prompt_id || null,
    durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
    permissionMode: ev.permission_mode || null,
    matcher: ev.notification_type || ev.compaction_reason || ev.error_type || null,
    text: null,
  };
  out.lane = sid ? laneOf(sid, out.agentId) : null;

  if (!sid) { push(out); return out; }
  const s = state(sid);
  s.updatedAt = now;
  if (ev.cwd) s.cwd = ev.cwd;
  if (ev.model) s.model = ev.model;
  if (ev.permission_mode) s.permissionMode = ev.permission_mode;

  switch (name) {
    case 'SessionStart':
      s.phase = 'idle'; s.startedAt = now; s.tools.clear(); s.agents.clear();
      break;

    case 'SessionEnd':
      s.phase = 'ended'; s.tools.clear(); s.agents.clear();
      break;

    case 'UserPromptSubmit':
      s.phase = 'thinking';
      s.lastPrompt = clip(ev.user_prompt, 240);
      out.text = s.lastPrompt;
      break;

    case 'PreToolUse':
      s.phase = 'tool';
      out.text = toolSummary(ev.tool_name, ev.tool_input);
      if (out.toolUseId) {
        s.tools.set(out.toolUseId, { name: ev.tool_name, at: now, summary: out.text });
      }
      s.lastTool = ev.tool_name;
      s.toolCount++;
      break;

    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (out.toolUseId) s.tools.delete(out.toolUseId);
      out.text = toolSummary(ev.tool_name, ev.tool_input);
      out.failed = name === 'PostToolUseFailure';
      if (!s.tools.size && s.phase === 'tool') s.phase = 'thinking';
      break;

    case 'SubagentStart':
      s.agentCount++;
      s.agents.set(out.agentId || ('a' + s.agentCount),
        { type: ev.agent_type || '?', at: now });
      out.text = ev.agent_type || null;
      break;

    case 'SubagentStop':
      if (out.agentId) s.agents.delete(out.agentId);
      else if (s.agents.size) s.agents.delete([...s.agents.keys()][0]);
      out.text = ev.agent_type || null;
      break;

    case 'Stop':
    case 'StopFailure':
    case 'Interrupt':
      s.phase = 'idle'; s.tools.clear();
      out.text = clip(ev.last_assistant_message, 240);
      break;

    case 'Notification':
    case 'PermissionRequest':
      out.text = ev.notification_type || null;
      // 권한 승인 대기 = 사람이 봐야 하는 상태.
      // Claude 는 Notification 이벤트에 notification_type: 'permission_prompt' 로 실어 보내고,
      // Codex 는 별도의 PermissionRequest 이벤트 자체가 승인 요청이라 이름만으로 판정한다.
      if (name === 'PermissionRequest' || ev.notification_type === 'permission_prompt') s.phase = 'waiting';
      break;

    case 'PreCompact':
    case 'PostCompact':
      out.text = ev.compaction_reason || null;
      break;

    default:
      out.text = clip(ev.file_path || ev.notification_type || null, 160);
  }

  // 오래 매달려 있는 툴은 정리한다 (PostToolUse 를 놓친 경우)
  for (const [k, v] of s.tools) if (now - v.at > STALE_TOOL_MS) s.tools.delete(k);

  timeline(name, ev, out, now);
  push(out);
  return out;
}

// 이벤트를 타임라인 구간으로 옮긴다
function timeline(name, ev, out, now) {
  const sid = out.sessionId;

  // ---- 턴 (프롬프트 단위)
  if (out.promptId) {
    let t = turnById.get(out.promptId);
    if (!t) {
      t = { id: out.promptId, sess: sid, t0: now, t1: null, prompt: null,
            tools: 0, agents: 0, failed: 0 };
      turnById.set(out.promptId, t);
      turns.push(t);
      trim(turns, MAX_TURNS);
    }
    if (name === 'UserPromptSubmit') { t.t0 = now; t.prompt = clip(ev.user_prompt, 200); }
    if (name === 'PreToolUse') t.tools++;
    if (name === 'PostToolUseFailure') t.failed++;
    if (name === 'SubagentStart') t.agents++;
    if (name === 'Stop' || name === 'StopFailure') t.t1 = now;
  }

  // ---- 툴 구간
  if (name === 'PreToolUse' && out.toolUseId) {
    const span = {
      id: out.toolUseId, sess: sid, lane: out.lane,
      agentId: out.agentId, agentType: out.agentType,
      tool: out.tool, summary: out.text, promptId: out.promptId,
      t0: now, t1: null, dur: null, failed: false,
    };
    spanByTool.set(span.id, span);
    spans.push(span);
    trim(spans, MAX_SPANS);
  } else if ((name === 'PostToolUse' || name === 'PostToolUseFailure') && out.toolUseId) {
    const span = spanByTool.get(out.toolUseId);
    if (span) {
      span.t1 = now;
      // duration_ms 가 오면 그걸 쓴다 (훅 왕복 지연이 안 섞인 실제 시간)
      span.dur = out.durationMs != null ? out.durationMs : (now - span.t0);
      span.failed = name === 'PostToolUseFailure';
      if (!span.summary) span.summary = out.text;
      spanByTool.delete(out.toolUseId);
    } else {
      // Pre 를 놓친 경우(런처를 늦게 켰거나 재시작) 길이만 아는 구간으로 만든다
      const dur = out.durationMs != null ? out.durationMs : 0;
      spans.push({ id: out.toolUseId, sess: sid, lane: out.lane,
                   agentId: out.agentId, agentType: out.agentType,
                   tool: out.tool, summary: out.text, promptId: out.promptId,
                   t0: now - dur, t1: now, dur: dur,
                   failed: name === 'PostToolUseFailure', partial: true });
      trim(spans, MAX_SPANS);
    }
  }

  // ---- 서브에이전트 구간
  if (name === 'SubagentStart' && out.agentId) {
    const run = { id: out.agentId, sess: sid, lane: out.lane, type: out.agentType,
                  promptId: out.promptId, t0: now, t1: null, dur: null, result: null };
    agentById.set(out.agentId, run);
    agentRuns.push(run);
    trim(agentRuns, 120);
  } else if (name === 'SubagentStop' && out.agentId) {
    const run = agentById.get(out.agentId);
    if (run) {
      run.t1 = now; run.dur = now - run.t0;
      run.result = clip(ev.last_assistant_message, 300);
      agentById.delete(out.agentId);
    }
  }
}

function push(ev) {
  ring.push(ev);
  if (ring.length > MAX_EVENTS) ring.shift();
  broadcast('event', ev);
}

// --------------------------------------------------------------- SSE

function broadcast(type, data) {
  if (!clients.size) return;
  const payload = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function subscribe(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  // 붙는 즉시 최근 기록과 현재 상태를 한 번 내려준다
  res.write('event: snapshot\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
  clients.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); clients.delete(res); }
  }, 25000);

  req.on('close', () => { clearInterval(ping); clients.delete(res); });
  req.on('error', () => { clearInterval(ping); clients.delete(res); });
}

// --------------------------------------------------------------- 조회

function liveState() {
  const out = {};
  for (const [sid, s] of sessions) {
    if (s.phase === 'ended' && Date.now() - s.updatedAt > 60000) continue;
    out[sid] = {
      phase: s.phase, cwd: s.cwd,
      tools: [...s.tools.values()].map(t => ({ name: t.name, summary: t.summary, ms: Date.now() - t.at })),
      agents: [...s.agents.values()].map(a => ({ type: a.type, ms: Date.now() - a.at })),
      toolCount: s.toolCount, agentCount: s.agentCount,
      lastPrompt: s.lastPrompt, lastTool: s.lastTool,
      model: s.model, permissionMode: s.permissionMode,
      updatedAt: s.updatedAt,
    };
  }
  return out;
}

function snapshot(limit) {
  const n = Math.max(1, Math.min(MAX_EVENTS, limit || 120));
  return { events: ring.slice(-n), live: liveState(), clients: clients.size, total: seq };
}

// 타임라인용: 최근 windowMs 안에 걸쳐 있는 구간만 준다
function timelineData(windowMs) {
  const now = Date.now();
  const from = now - (windowMs || 120000);
  const inWin = s => (s.t1 == null ? s.t0 <= now : s.t1 >= from) && s.t0 <= now;
  const sess = {};
  for (const [sid, s] of sessions) {
    sess[sid] = { phase: s.phase, cwd: s.cwd, toolCount: s.toolCount,
                  agentCount: s.agentCount, lastPrompt: s.lastPrompt,
                  model: s.model, permissionMode: s.permissionMode, updatedAt: s.updatedAt };
  }
  return {
    now, from,
    spans: spans.filter(inWin),
    agents: agentRuns.filter(inWin),
    turns: turns.filter(t => (t.t1 == null ? true : t.t1 >= from)),
    sessions: sess,
    total: seq,
  };
}

function reset() {
  ring.length = 0; sessions.clear(); seq = 0;
  spans.length = 0; spanByTool.clear();
  turns.length = 0; turnById.clear();
  agentRuns.length = 0; agentById.clear();
}

function keys() { return rawKeys; }

module.exports = { ingest, subscribe, snapshot, liveState, timelineData, reset, keys,
                   get clientCount() { return clients.size; } };
