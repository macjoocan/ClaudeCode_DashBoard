// 대시보드 안에서 실제 claude 세션을 돌리는 터미널 관리자.
//
// 각 터미널은 서버가 소유한 ConPTY 프로세스다. 브라우저를 닫거나 새로고침해도
// 프로세스는 계속 살아있고, 다시 접속하면 스크롤백을 되살려 이어서 본다
// (Herdr 의 detach/attach 와 같은 구조).

const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCROLLBACK = 512 * 1024;   // 재접속 시 되살릴 출력량
const KEEP_DEAD_MS = 10 * 60 * 1000; // 종료된 터미널을 목록에 남겨두는 시간

const LIVE_DIR = path.join(os.homedir(), '.claude', 'sessions');

let seq = 0;
const terms = new Map();

// claude 를 중첩 실행할 때 부모 세션의 환경변수가 섞이지 않게 걸러낸다
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE(CODE)?(_|$)/i.test(k)) continue;
    if (k === 'FORCE_COLOR' || k === 'NO_COLOR') continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return Object.assign(env, extra || {});
}

function claudeArgs(action, sessionId) {
  if (action === 'resume') return ['--resume', sessionId];
  if (action === 'fork')   return ['--resume', sessionId, '--fork-session'];
  if (action === 'continue') return ['--continue'];
  return [];   // 'new'
}

function create({ action, cwd, sessionId, title, cols, rows, claudeBin, model, provider, codexBin }) {
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`폴더가 없습니다: ${cwd}`);

  const isCodex = provider === 'codex';
  const bin = isCodex ? codexBin : claudeBin;
  if (!bin) throw new Error(isCodex ? 'codex 를 찾을 수 없습니다' : 'claude 를 찾을 수 없습니다');

  const args = isCodex
    ? require('./codex.js').codexArgs(action, sessionId)
    : claudeArgs(action, sessionId);
  if (model && !isCodex) args.push('--model', model);

  const p = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols: Math.max(40, Math.min(400, cols || 120)),
    rows: Math.max(10, Math.min(200, rows || 32)),
    cwd,
    env: cleanEnv(),
    useConpty: true,
  });

  const id = 't' + (++seq) + '-' + Date.now().toString(36);
  const t = {
    id, action, cwd, sessionId: sessionId || null,
    provider: isCodex ? 'codex' : 'claude',
    title: title || path.basename(cwd),
    pid: p.pid,
    startedAt: Date.now(),
    lastAt: Date.now(),
    exitCode: null, exitedAt: null,
    cols: p.cols, rows: p.rows,
    proc: p,
    buf: '',
    clients: new Set(),
  };
  terms.set(id, t);

  p.onData(d => {
    t.buf += d;
    if (t.buf.length > SCROLLBACK) t.buf = t.buf.slice(-SCROLLBACK);
    t.lastAt = Date.now();
    send(t, { t: 'o', d });
  });

  p.onExit(({ exitCode }) => {
    t.exitCode = exitCode == null ? 0 : exitCode;
    t.exitedAt = Date.now();
    send(t, { t: 'x', code: t.exitCode });
  });

  return t;
}

function send(t, msg) {
  const s = JSON.stringify(msg);
  for (const ws of t.clients) {
    if (ws.readyState === 1) { try { ws.send(s); } catch {} }
  }
}

// pty 의 pid 는 claude.exe 의 pid 이므로, Claude Code 가 쓰는 상태 파일에서
// 이 터미널의 실제 세션 ID / busy·idle 상태를 그대로 읽어올 수 있다.
function liveInfo(pid) {
  try {
    const f = path.join(LIVE_DIR, pid + '.json');
    if (!fs.existsSync(f)) return null;
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { sessionId: o.sessionId || null, status: o.status || 'idle', name: o.name || null };
  } catch { return null; }
}

// Codex 터미널의 신원은 Claude 상태 파일이 아니라 우리 훅이 쓴
// ~/.codex/.cc-launcher-live/<sessionId>.json 에서 온다. 그 파일의 pid 는 훅
// 프로세스의 부모, 즉 우리가 띄운 codex 프로세스(= PTY 의 pid)라 pid 로 역인덱스를
// 만들면 그대로 매칭된다. list() 가 터미널마다 부르므로 1초 메모한다.
let codexLiveMemo = { at: 0, byPid: new Map() };
function codexLiveInfo(pid) {
  const now = Date.now();
  if (now - codexLiveMemo.at > 1000) {
    const byPid = new Map();
    try {
      for (const [sessionId, v] of require('./codex.js').liveMap()) {
        if (v && v.pid) byPid.set(Number(v.pid), { sessionId, status: v.status || 'idle', name: null });
      }
    } catch {}
    codexLiveMemo = { at: now, byPid };
  }
  return codexLiveMemo.byPid.get(Number(pid)) || null;
}

function info(t) {
  // provider 로 갈라야 한다. Codex 터미널이 liveInfo() 를 타면 (1) 자기 sessionId 를
  // 영영 못 찾아 카드와 연결되지 않고, (2) Windows 의 PID 재사용으로 죽은 Claude
  // 세션의 상태 파일을 주워 그 Claude 카드가 Codex 터미널을 가리키게 된다.
  const live = t.exitCode != null ? null
    : (t.provider === 'codex' ? codexLiveInfo(t.pid) : liveInfo(t.pid));
  if (live && live.sessionId && !t.sessionId) t.sessionId = live.sessionId;  // 새 세션의 ID 확보
  return {
    id: t.id, title: t.title, cwd: t.cwd, action: t.action,
    provider: t.provider || 'claude',
    sessionId: t.sessionId, pid: t.pid,
    cols: t.cols, rows: t.rows,
    startedAt: t.startedAt, lastAt: t.lastAt,
    alive: t.exitCode == null,
    exitCode: t.exitCode, exitedAt: t.exitedAt,
    status: live ? live.status : null,
    name: live ? live.name : null,
    clients: t.clients.size,
    bytes: t.buf.length,
  };
}

function list() {
  reap();
  return [...terms.values()].map(info).sort((a, b) => a.startedAt - b.startedAt);
}

// 종료된 지 오래되고 아무도 안 보고 있는 터미널은 목록에서 정리한다
function reap() {
  const now = Date.now();
  for (const [id, t] of terms) {
    if (t.exitCode != null && t.clients.size === 0 && now - t.exitedAt > KEEP_DEAD_MS) terms.delete(id);
  }
}

function get(id) { return terms.get(id) || null; }

function write(id, data) {
  const t = terms.get(id);
  if (!t || t.exitCode != null) return false;
  t.proc.write(data);
  t.lastAt = Date.now();
  return true;
}

function resize(id, cols, rows) {
  const t = terms.get(id);
  if (!t || t.exitCode != null) return false;
  const c = Math.max(40, Math.min(400, Math.floor(cols) || t.cols));
  const r = Math.max(10, Math.min(200, Math.floor(rows) || t.rows));
  if (c === t.cols && r === t.rows) return true;
  try { t.proc.resize(c, r); t.cols = c; t.rows = r; return true; } catch { return false; }
}

function kill(id) {
  const t = terms.get(id);
  if (!t) return false;
  if (t.exitCode == null) { try { t.proc.kill(); } catch {} }
  return true;
}

// 목록에서 완전히 제거 (살아있으면 먼저 종료)
function close(id) {
  const t = terms.get(id);
  if (!t) return false;
  if (t.exitCode == null) { try { t.proc.kill(); } catch {} }
  for (const ws of t.clients) { try { ws.close(); } catch {} }
  terms.delete(id);
  return true;
}

// WebSocket 한 개를 터미널에 붙인다. 여러 개가 같은 터미널을 봐도 된다.
function attach(ws, id) {
  const t = terms.get(id);
  if (!t) { try { ws.send(JSON.stringify({ t: 'e', m: '터미널이 없습니다' })); ws.close(); } catch {} return; }

  t.clients.add(ws);
  try {
    ws.send(JSON.stringify({ t: 'm', info: info(t) }));
    if (t.buf) ws.send(JSON.stringify({ t: 'o', d: t.buf, replay: true }));
    if (t.exitCode != null) ws.send(JSON.stringify({ t: 'x', code: t.exitCode }));
  } catch {}

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'i') write(id, m.d);
    else if (m.t === 'r') { if (resize(id, m.c, m.r)) send(t, { t: 'm', info: info(t) }); }
    else if (m.t === 'p') { try { ws.send(JSON.stringify({ t: 'm', info: info(t) })); } catch {} }
  });

  ws.on('close', () => { t.clients.delete(ws); });
  ws.on('error', () => { t.clients.delete(ws); });
}

// 서버 종료 시 자식 프로세스를 남기지 않는다
function killAll() {
  for (const t of terms.values()) { if (t.exitCode == null) { try { t.proc.kill(); } catch {} } }
}

module.exports = { create, list, get, info, write, resize, kill, close, attach, killAll };
