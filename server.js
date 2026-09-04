// Claude Code Session Launcher - 로컬 전용 서버 (의존성 없음)
// ~/.claude/projects 를 스캔해 세션 목록을, ~/.claude/sessions 를 읽어 실행 상태를 만들고,
// 클릭하면 Windows Terminal 에 해당 프로젝트 폴더로 claude 를 띄운다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const terminals = require('./terminals');
const harness = require('./harness');
const events = require('./events');
const hooksInstall = require('./hooks-install');
const cfgWrite = require('./config-write');

const HOOK_URL = `http://${'127.0.0.1'}:${Number(process.env.CC_LAUNCHER_PORT || 7788)}/api/hook`;

const HOST = '127.0.0.1';
const PORT = Number(process.env.CC_LAUNCHER_PORT || 7788);
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const LIVE_DIR = path.join(CLAUDE_HOME, 'sessions'); // <pid>.json = 살아있는 세션 상태
const PUBLIC_DIR = path.join(__dirname, 'public');
const PINS_FILE = path.join(__dirname, 'pins.json');
const FAVS_FILE = path.join(__dirname, 'favorites.json'); // "<slug>/<sessionId>" 목록
const FOCUS_PS1 = path.join(__dirname, 'focus-window.ps1');

const HEAD_BYTES = 96 * 1024;
const HEAD_MAX = 2 * 1024 * 1024;   // 거대 레코드가 앞을 막고 있을 때 넓혀 읽는 한계
const TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_BYTES = 3 * 1024 * 1024;

const SAFE_SLUG = /^[A-Za-z0-9._\-]+$/;
const SAFE_ID = /^[A-Za-z0-9\-]+$/;

const CLAUDE_BIN = findClaudeBin();
const WT_BIN = findBin('wt.exe');

function findBin(name) {
  try {
    return execFileSync('where.exe', [name], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}
function findClaudeBin() {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return local;
  return findBin('claude.exe') || findBin('claude.cmd') || 'claude';
}

// ---------------------------------------------------------------- jsonl 읽기

function readChunk(file, start, length) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.slice(0, read).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function textOf(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
  return '';
}

// 사람이 직접 입력한 프롬프트만 (훅/시스템 주입/서브에이전트 제외)
function humanPrompt(obj) {
  if (!obj || obj.type !== 'user' || obj.isSidechain) return null;
  if (obj.origin && obj.origin.kind && obj.origin.kind !== 'human') return null;
  let t = textOf(obj.message).trim();
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null;
  if (t.startsWith('This session is being continued')) return null; // /compact 이어받기 요약
  if (t.startsWith('[Request interrupted')) return null;
  t = t.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 400) : null;
}

function eachLine(chunk, dropFirstPartial, fn) {
  const lines = chunk.split('\n');
  if (dropFirstPartial) lines.shift();
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (fn(obj) === false) return;
  }
}

// 서브에이전트 호출을 센다. Task/Agent 툴 인자에 subagent_type 이 들어가므로
// 읽어둔 청크에서 바로 뽑을 수 있다 (별도 스캔 비용 없음 - 앞/끝 표본 기준).
function countSubagents(chunk, into) {
  const re = /"subagent_type":"([^"]{1,60})"/g;
  let m;
  while ((m = re.exec(chunk))) into[m[1]] = (into[m[1]] || 0) + 1;
}

function parseSession(file, stat) {
  const info = { cwd: null, gitBranch: null, version: null, aiTitle: null,
                 firstPrompt: null, lastPrompt: null, firstAt: null, lastAt: null,
                 subagents: {} };

  let scanned = 0;
  while (scanned < Math.min(HEAD_MAX, stat.size)) {
    const want = Math.min(HEAD_BYTES, stat.size - scanned);
    const head = readChunk(file, scanned, want);
    eachLine(head, scanned > 0, obj => {
      if (!info.cwd && obj.cwd) {
        info.cwd = obj.cwd;
        info.gitBranch = obj.gitBranch || null;
        info.version = obj.version || null;
      }
      if (obj.type === 'ai-title' && obj.aiTitle) info.aiTitle = obj.aiTitle;
      if (!info.firstPrompt) {
        const p = humanPrompt(obj);
        if (p) { info.firstPrompt = p; info.firstAt = obj.timestamp || null; }
      }
    });
    countSubagents(head, info.subagents);
    scanned += want;
    if (info.cwd && info.firstPrompt) break;   // 필요한 건 다 찾았다
  }

  if (stat.size > HEAD_BYTES) {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const tail = readChunk(file, start, stat.size - start);
    eachLine(tail, start > 0, obj => {
      if (!info.cwd && obj.cwd) info.cwd = obj.cwd;
      if (obj.type === 'ai-title' && obj.aiTitle) info.aiTitle = obj.aiTitle;
      const p = humanPrompt(obj);
      if (p) { info.lastPrompt = p; info.lastAt = obj.timestamp || null; }
    });
    countSubagents(tail, info.subagents);
  }
  if (!info.lastPrompt) { info.lastPrompt = info.firstPrompt; info.lastAt = info.firstAt; }
  return info;
}

// ------------------------------------------------ 실행 중인 세션 (라이브 상태)
// ~/.claude/sessions/<pid>.json 을 읽는다. `claude agents --json` 과 같은 원본이지만
// 파일을 직접 읽으므로 즉시 응답한다 (CLI 호출은 1.5초).

let claudePidSet = null;          // tasklist 로 확인한 claude.exe PID 집합
let claudePidCheckedAt = 0;

function refreshClaudePids() {
  if (Date.now() - claudePidCheckedAt < 20000) return;
  claudePidCheckedAt = Date.now();
  execFile('tasklist.exe', ['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV'],
    { timeout: 5000 }, (err, stdout) => {
      if (err) return;
      const set = new Set();
      for (const m of stdout.matchAll(/"claude\.exe","(\d+)"/g)) set.add(Number(m[1]));
      claudePidSet = set;
    });
}

function pidAlive(pid) {
  if (claudePidSet) return claudePidSet.has(pid);  // 확실한 판정 (PID 재사용까지 걸러냄)
  try { process.kill(pid, 0); return true; }        // 첫 스캔용 임시 판정
  catch (e) { return e.code === 'EPERM'; }
}

function liveSessions() {
  refreshClaudePids();
  const bySession = new Map();
  let files = [];
  try { files = fs.readdirSync(LIVE_DIR).filter(f => f.endsWith('.json')); } catch { return bySession; }

  for (const f of files) {
    let o;
    try { o = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, f), 'utf8')); } catch { continue; }
    if (!o || !o.sessionId || !o.pid) continue;
    if (!pidAlive(o.pid)) continue;
    bySession.set(o.sessionId, {
      pid: o.pid,
      status: o.status || 'idle',          // busy | idle
      name: o.name || null,
      nameSource: o.nameSource || null,
      cwd: o.cwd || null,
      kind: o.kind || 'interactive',
      startedAt: o.startedAt || null,
      statusAt: o.statusUpdatedAt || o.updatedAt || null,
    });
  }
  return bySession;
}

// ---------------------------------------------------------------- 스캔 + 캐시

const cache = new Map(); // file -> { mtimeMs, size, info }

function scan() {
  const live = liveSessions();
  const favs = new Set(loadFavs());
  const projects = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch {}

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    for (const f of files) {
      const file = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.size === 0) continue;

      const hit = cache.get(file);
      let info;
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) info = hit.info;
      else {
        info = parseSession(file, stat);
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
      }
      // 사람 대화도 제목도 없는 껍데기 세션만 숨긴다
      if (!info.firstPrompt && !info.lastPrompt && !info.aiTitle) continue;

      const id = path.basename(f, '.jsonl');
      const cwd = info.cwd || d.name;
      const key = cwd.toLowerCase();
      if (!projects.has(key)) {
        projects.set(key, {
          key, cwd, name: path.basename(cwd) || cwd,
          exists: fs.existsSync(cwd),
          gitBranch: info.gitBranch, sessions: [],
        });
      }
      const p = projects.get(key);
      if (!p.gitBranch && info.gitBranch) p.gitBranch = info.gitBranch;
      p.sessions.push({
        id, slug: d.name,
        mtime: stat.mtimeMs,
        sizeKB: Math.round(stat.size / 1024),
        branch: info.gitBranch,
        version: info.version,
        title: info.aiTitle || info.firstPrompt || info.lastPrompt,
        firstPrompt: info.firstPrompt,
        last: info.lastPrompt,
        live: live.get(id) || null,
        fav: favs.has(d.name + '/' + id),
        subagents: info.subagents,
      });
    }
  }

  const pins = loadPins();
  const list = [...projects.values()];
  for (const p of list) {
    p.sessions.sort((a, b) => {
      const la = a.live ? 1 : 0, lb = b.live ? 1 : 0;
      return (lb - la) || (b.mtime - a.mtime);
    });
    p.mtime = p.sessions[0] ? p.sessions[0].mtime : 0;
    p.liveCount = p.sessions.filter(s => s.live).length;
    p.busyCount = p.sessions.filter(s => s.live && s.live.status === 'busy').length;
    p.favCount = p.sessions.filter(s => s.fav).length;
    p.pinned = pins.includes(p.key);
  }
  list.sort((a, b) => (b.pinned - a.pinned) || (b.liveCount - a.liveCount) || (b.mtime - a.mtime));
  return list;
}

function loadPins() {
  try { return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')); } catch { return []; }
}
function savePins(pins) {
  try { fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2), 'utf8'); } catch {}
}
function loadFavs() {
  try { return JSON.parse(fs.readFileSync(FAVS_FILE, 'utf8')); } catch { return []; }
}
function saveFavs(favs) {
  try { fs.writeFileSync(FAVS_FILE, JSON.stringify(favs, null, 2), 'utf8'); } catch {}
}

// -------------------------------------------------------- 대화 내용 (트랜스크립트)

function transcript(slug, id, limit) {
  if (!SAFE_SLUG.test(slug) || !SAFE_ID.test(id)) throw new Error('잘못된 세션 경로');
  const file = path.join(PROJECTS_DIR, slug, id + '.jsonl');
  if (!file.startsWith(PROJECTS_DIR) || !fs.existsSync(file)) throw new Error('세션 파일이 없습니다');
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - TRANSCRIPT_BYTES);
  const chunk = readChunk(file, start, stat.size - start);

  const msgs = [];
  const push = m => {
    const prev = msgs[msgs.length - 1];
    // 연속된 같은 역할의 텍스트는 하나로 합친다
    if (prev && prev.role === m.role && (m.role === 'assistant' || m.role === 'thinking')) {
      prev.text += '\n' + m.text;
      prev.ts = m.ts || prev.ts;
      return;
    }
    msgs.push(m);
  };

  eachLine(chunk, start > 0, obj => {
    if (obj.isSidechain) return;                    // 서브에이전트 대화는 제외
    if (obj.type === 'user') {
      const t = humanPrompt(obj);
      if (t) push({ role: 'user', text: textOf(obj.message).trim().slice(0, 4000), ts: obj.timestamp });
      return;
    }
    if (obj.type === 'assistant' && obj.message) {
      const c = obj.message.content;
      if (typeof c === 'string') { if (c.trim()) push({ role: 'assistant', text: c.trim(), ts: obj.timestamp }); return; }
      if (!Array.isArray(c)) return;
      const tools = [];
      for (const part of c) {
        if (!part) continue;
        if (part.type === 'text' && part.text && part.text.trim())
          push({ role: 'assistant', text: part.text.trim(), ts: obj.timestamp });
        else if (part.type === 'thinking' && part.thinking)
          push({ role: 'thinking', text: String(part.thinking).trim().slice(0, 2000), ts: obj.timestamp });
        else if (part.type === 'tool_use' && part.name) tools.push(part.name);
      }
      if (tools.length) push({ role: 'tool', text: tools.join(', '), ts: obj.timestamp });
    }
  });

  const n = Math.max(5, Math.min(300, limit || 40));
  return {
    truncated: start > 0 || msgs.length > n,
    total: msgs.length,
    sizeKB: Math.round(stat.size / 1024),
    mtime: stat.mtimeMs,
    messages: msgs.slice(-n),
  };
}

// ---------------------------------------------------------------- 실행

function claudeCommand(action, sessionId, extra) {
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const parts = [`& ${q(CLAUDE_BIN)}`];
  if (action === 'resume') parts.push('--resume', sessionId);
  else if (action === 'fork') parts.push('--resume', sessionId, '--fork-session');
  else if (action === 'continue') parts.push('--continue');
  // 'new' 는 인자 없음
  if (extra && extra.model) parts.push('--model', extra.model);
  return parts.join(' ');
}

function launch({ action, cwd, sessionId, title, extra }) {
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`폴더가 없습니다: ${cwd}`);
  if ((action === 'resume' || action === 'fork') && !SAFE_ID.test(String(sessionId || '')))
    throw new Error('세션 ID 가 올바르지 않습니다');
  const inner = claudeCommand(action, sessionId, extra);
  const tabTitle = title || path.basename(cwd);

  if (WT_BIN) {
    spawn(WT_BIN, ['-w', '0', 'new-tab', '--title', tabTitle, '-d', cwd,
                   'powershell.exe', '-NoExit', '-NoLogo', '-Command', inner],
          { detached: true, stdio: 'ignore' }).unref();
    return 'wt';
  }
  spawn('powershell.exe', ['-NoLogo', '-Command',
    `Start-Process powershell -ArgumentList '-NoExit','-NoLogo','-Command',${JSON.stringify(inner)} -WorkingDirectory ${JSON.stringify(cwd)}`,
  ], { detached: true, stdio: 'ignore' }).unref();
  return 'powershell';
}

// 실행 중인 세션의 터미널 창을 앞으로 가져온다 (claude.exe → 부모 창 추적)
function focusWindow(pid) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(pid) || pid <= 0) return reject(new Error('잘못된 PID'));
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_PS1, '-TargetPid', String(pid)],
      { timeout: 8000 }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const ok = out.match(/^OK (\S+) (\d+)/);
        if (ok) return resolve(`${ok[1]} 창(PID ${ok[2]})을 앞으로 가져왔습니다`);
        if (/^NOTFOUND/.test(out))
          return reject(new Error(`PID ${pid} 의 터미널 창을 찾지 못했습니다 (창 없이 실행 중일 수 있습니다)`));
        const failed = out.match(/^FAILED (\S+)/);
        if (failed) return reject(new Error(`${failed[1]} 창을 찾았지만 전면으로 올리지 못했습니다`));
        reject(new Error(out || String(stderr || (err && err.message) || '').trim() || '창 포커스 실패'));
      });
  });
}

function openFolder(cwd) {
  if (!fs.existsSync(cwd)) throw new Error(`폴더가 없습니다: ${cwd}`);
  spawn('explorer.exe', [cwd], { detached: true, stdio: 'ignore' }).unref();
}
function openVSCode(cwd) {
  if (!fs.existsSync(cwd)) throw new Error(`폴더가 없습니다: ${cwd}`);
  spawn('cmd.exe', ['/c', 'code', cwd], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------- HTTP

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
               '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
// 청크를 문자열로 이어붙이면 UTF-8 멀티바이트 문자가 청크 경계에서 깨진다
// (한글 프롬프트가 물음표로 나온다). Buffer 로 모아서 마지막에 한 번 디코딩한다.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', c => { chunks.push(c); len += c.length; if (len > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolve(s ? JSON.parse(s) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 훅 본문은 tool_result 때문에 아주 커질 수 있다. 끊지 않고 상한까지 받되,
// 넘치면 뒤를 버리고 파싱을 포기한다 (훅이 실패하면 Claude Code 에 오류가 뜬다).
const HOOK_MAX = 12 * 1024 * 1024;
function readHookBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let len = 0, over = false;
    req.on('data', c => {
      if (over) return;
      len += c.length;
      if (len > HOOK_MAX) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return resolve({ hook_event_name: 'Oversize' });
      try {
        const s = Buffer.concat(chunks).toString('utf8');   // 경계에서 깨지지 않게 한 번에 디코딩
        resolve(s ? JSON.parse(s) : {});
      } catch { resolve({ hook_event_name: 'Unparsed' }); }
    });
    req.on('error', () => resolve({ hook_event_name: 'Error' }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const origin = req.headers.origin;
  if (req.method === 'POST' && origin &&
      !origin.startsWith(`http://${HOST}:${PORT}`) && !origin.startsWith(`http://localhost:${PORT}`)) {
    return json(res, 403, { error: 'origin not allowed' });
  }

  try {
    if (url.pathname === '/api/projects') {
      return json(res, 200, {
        projects: scan(),
        env: { claude: CLAUDE_BIN, wt: WT_BIN, projectsDir: PROJECTS_DIR },
      });
    }

    // 실행 상태만 (jsonl 스캔 없음 → 수 ms). 짧은 주기로 폴링해도 부담 없다.
    if (url.pathname === '/api/live') {
      const live = {};
      for (const [id, v] of liveSessions()) live[id] = v;
      return json(res, 200, { live, at: Date.now() });
    }

    if (url.pathname === '/api/transcript') {
      return json(res, 200, transcript(
        url.searchParams.get('slug') || '',
        url.searchParams.get('id') || '',
        Number(url.searchParams.get('limit')) || 40));
    }

    if (url.pathname === '/api/launch' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: true, via: launch(b) });
    }

    if (url.pathname === '/api/focus' && req.method === 'POST') {
      const b = await readBody(req);
      const info = await focusWindow(Number(b.pid));
      return json(res, 200, { ok: true, info });
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.target === 'vscode') openVSCode(b.cwd); else openFolder(b.cwd);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/fav' && req.method === 'POST') {
      const b = await readBody(req);
      if (!SAFE_SLUG.test(String(b.slug || '')) || !SAFE_ID.test(String(b.id || '')))
        throw new Error('잘못된 세션 지정');
      const token = `${b.slug}/${b.id}`;
      const favs = loadFavs();
      const i = favs.indexOf(token);
      if (i >= 0) favs.splice(i, 1); else favs.push(token);
      saveFavs(favs);
      return json(res, 200, { ok: true, fav: i < 0 });
    }

    if (url.pathname === '/api/pin' && req.method === 'POST') {
      const b = await readBody(req);
      const pins = loadPins();
      const i = pins.indexOf(b.key);
      if (i >= 0) pins.splice(i, 1); else pins.push(b.key);
      savePins(pins);
      return json(res, 200, { ok: true, pinned: i < 0 });
    }

    // ------- 훅 이벤트 수신 (Claude Code 의 http 훅) -------
    //
    // 훅은 Claude Code 를 기다리게 만든다. 그래서 여기서는 아무것도 기다리지 않고
    // 곧바로 200 을 돌려준다. Origin 검사도 하지 않는다 (훅에는 Origin 이 없다).
    if (url.pathname === '/api/hook' && req.method === 'POST') {
      const body = await readHookBody(req);
      try { events.ingest(body); } catch { /* 관측이 세션을 깨뜨리면 안 된다 */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }

    if (url.pathname === '/api/events') {                 // SSE 스트림
      return events.subscribe(req, res);
    }
    if (url.pathname === '/api/events/timeline') {
      return json(res, 200, events.timelineData(Number(url.searchParams.get('window')) || 120000));
    }
    if (url.pathname === '/api/events/keys') {      // 훅이 실제로 보내는 필드
      return json(res, 200, events.keys());
    }
    if (url.pathname === '/api/events/recent') {
      return json(res, 200, events.snapshot(Number(url.searchParams.get('limit')) || 120));
    }

    // ------- 훅 설치 상태 / 설치 / 제거 -------
    if (url.pathname === '/api/hooks/status') {
      return json(res, 200, Object.assign(hooksInstall.status(HOOK_URL), { url: HOOK_URL }));
    }
    if (url.pathname === '/api/hooks/install' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, hooksInstall.install(HOOK_URL, b.mode));
    }
    if (url.pathname === '/api/hooks/uninstall' && req.method === 'POST') {
      await readBody(req);
      return json(res, 200, hooksInstall.uninstall(HOOK_URL));
    }

    // ------- 설정 쓰기 -------
    // 임의 JSON 을 받지 않는다. op 마다 타입·허용값이 정해져 있고,
    // settings.json 은 매번 백업 + 재파싱 검증 후 교체된다 (config-write.js).
    if (url.pathname === '/api/cfg/backups') {
      return json(res, 200, { backups: cfgWrite.listBackups(
        url.searchParams.get('scope') || 'user', url.searchParams.get('cwd') || null) });
    }
    // 시각 편집기용: 만질 수 있는 항목 정의 + 스코프별 현재 값 + 실제 적용값
    if (url.pathname === '/api/cfg/schema') {
      return json(res, 200, {
        settable: cfgWrite.SETTABLE, envSwitches: cfgWrite.ENV_SWITCHES,
        scopes: cfgWrite.SCOPES,
      });
    }
    if (url.pathname === '/api/cfg/effective') {
      return json(res, 200, cfgWrite.effective(url.searchParams.get('cwd') || null));
    }
    if (url.pathname === '/api/cfg/doc') {
      return json(res, 200, cfgWrite.readDoc(
        url.searchParams.get('kind') || 'agent', url.searchParams.get('name') || ''));
    }
    if (url.pathname === '/api/mcp/list') {
      return json(res, 200, await cfgWrite.mcpList(url.searchParams.get('force') === '1'));
    }

    if (url.pathname === '/api/cfg' && req.method === 'POST') {
      const b = await readBody(req);
      const op = String(b.op || '');
      let out;
      switch (op) {
        case 'set':          out = cfgWrite.setSetting(b.key, b.value, b.scope, b.cwd); break;
        case 'env':          out = cfgWrite.setEnvSwitch(b.key, b.value, b.scope, b.cwd); break;
        case 'perm-add':     out = cfgWrite.addPermission(b.kind, b.rule, b.scope, b.cwd); break;
        case 'perm-remove':  out = cfgWrite.removePermission(b.kind, b.rule, b.scope, b.cwd); break;
        case 'dir-add':      out = cfgWrite.addDirectory(b.dir, b.scope, b.cwd); break;
        case 'dir-remove':   out = cfgWrite.removeDirectory(b.dir, b.scope, b.cwd); break;
        case 'restore':      out = cfgWrite.restoreBackup(b.name, b.scope, b.cwd); break;
        case 'agent-create': out = cfgWrite.createAgent(b); break;
        case 'agent-delete': out = cfgWrite.deleteAgent(b.name); break;
        case 'skill-create': out = cfgWrite.createSkill(b); break;
        case 'skill-delete': out = cfgWrite.deleteSkill(b.name); break;
        case 'doc-write':    out = cfgWrite.writeDoc(b.kind, b.name, b.text); break;
        case 'mcp-add':      out = await cfgWrite.mcpAdd(b); break;
        case 'mcp-remove':   out = await cfgWrite.mcpRemove(b.name, b.scope); break;
        case 'mcp-project':  out = cfgWrite.setProjectMcp(b.cwd, b.name, b.enabled); break;
        case 'plugin':       out = await cfgWrite.setPluginEnabled(b.name, b.enabled, b.scope, b.cwd); break;
        default: throw new Error('알 수 없는 작업: ' + op);
      }
      return json(res, 200, Object.assign({ ok: true, op }, out));
    }

    // ------- 하네스 구성 / 그래프 -------
    if (url.pathname === '/api/config') {
      const projects = scan();
      return json(res, 200, harness.config(projects.map(p => p.cwd)));
    }

    if (url.pathname === '/api/graph') {
      const projects = scan();
      const cfg = harness.config(projects.map(p => p.cwd));
      return json(res, 200, harness.graph(projects, cfg, terminals.list(), PROJECTS_DIR));
    }

    // ------- 대시보드 내장 터미널 -------
    if (url.pathname === '/api/terms') {
      return json(res, 200, { terms: terminals.list() });
    }

    if (url.pathname === '/api/term/new' && req.method === 'POST') {
      const b = await readBody(req);
      if ((b.action === 'resume' || b.action === 'fork') && !SAFE_ID.test(String(b.sessionId || '')))
        throw new Error('세션 ID 가 올바르지 않습니다');
      const t = terminals.create({
        action: b.action || 'new', cwd: b.cwd, sessionId: b.sessionId,
        title: b.title, cols: b.cols, rows: b.rows, model: b.model,
        claudeBin: CLAUDE_BIN,
      });
      return json(res, 200, { ok: true, term: terminals.info(t) });
    }

    if (url.pathname === '/api/term/kill' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: terminals.kill(String(b.id || '')) });
    }

    if (url.pathname === '/api/term/close' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: terminals.close(String(b.id || '')) });
    }

    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    file = path.normalize(file).replace(/^(\.\.[\\/])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

// 터미널 입출력용 WebSocket. 로컬 페이지에서 온 것만 받는다.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
  if (url.pathname !== '/term' || !okOrigin) { socket.destroy(); return; }
  const id = url.searchParams.get('id') || '';
  wss.handleUpgrade(req, socket, head, ws => terminals.attach(ws, id));
});

function shutdown() {
  console.log('');
  console.log('종료합니다 - 내장 터미널의 claude 프로세스를 정리합니다.');
  terminals.killAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

server.listen(PORT, HOST, () => {
  const addr = `http://${HOST}:${PORT}`;
  console.log('Claude Code Session Launcher');
  console.log(`  주소     : ${addr}`);
  console.log(`  claude   : ${CLAUDE_BIN}`);
  console.log(`  terminal : ${WT_BIN || 'Windows Terminal 없음 → PowerShell 창 사용'}`);
  console.log(`  세션 경로: ${PROJECTS_DIR}`);
  console.log(`  실행 상태: ${LIVE_DIR}`);
  console.log('  내장 터미널: node-pty (ConPTY) - 브라우저를 닫아도 세션은 계속 살아 있습니다');
  console.log('\n창을 닫으면 서버가 종료됩니다. (Ctrl+C 로 종료 - 내장 터미널도 함께 정리)');
  if (!process.env.CC_LAUNCHER_NO_OPEN) {
    spawn('cmd.exe', ['/c', 'start', '', addr], { detached: true, stdio: 'ignore' }).unref();
  }
});
