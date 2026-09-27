// AI Coding Session Launcher - Claude Code/Codex 공용 로컬 서버
// ~/.claude/projects 를 스캔해 세션 목록을, ~/.claude/sessions 를 읽어 실행 상태를 만들고,
// 클릭하면 Windows Terminal 에 해당 프로젝트 폴더로 claude 를 띄운다.

// node:sqlite 는 아직 실험 API 라 로드될 때마다 ExperimentalWarning 을 찍는다.
// run.bat 로 띄우면 시작할 때마다 콘솔 첫 줄이 경고라 사용자가 오류로 읽는다.
// --no-warnings 로 통째로 끄지 않는 이유: 진짜 봐야 할 deprecation 경고까지 사라진다.
// Node 가 부트스트랩에서 붙여 둔 기본 출력 리스너를 떼고, SQLite 실험 경고만
// 삼키는 우리 리스너를 대신 붙인다. codex.js(→ node:sqlite) 를 require 하기 전에
// 실행돼야 하므로 반드시 이 파일 맨 위에 있어야 한다.
process.removeAllListeners('warning');
process.on('warning', w => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message || '')) return;
  console.error(w.stack || String(w));
});

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
const codexHooks = require('./codex-hooks-install.js');
const cfgWrite = require('./config-write');
const codex = require('./codex.js');
const usage = require('./usage.js');   // 세션 하나의 사용량 (카드·대화 헤더)
const providerMetrics = require('./provider-metrics'); // Claude/Codex 공통 한도·기간 사용량
const { createBridge } = require('./bridge');
const { commandFor, submitPaste } = require('./session-actions');
const { createHandoff } = require('./handoff');
const { wtArgs } = require('./launch-args');
const { taskkillOutcome } = require('./kill-result');
const { pendingPrompt } = require('./tui-state');
const scribe = require('./scribe');
const documents = require('./documents');
const { createGuard } = require('./ask-guard');
const { createRunner } = require('./ask-run');
const { createAsk } = require('./ask');    // 마크다운 편집기 (SCRIBE 빌드물 + 파일 브리지)

const HOOK_URL = `http://${'127.0.0.1'}:${Number(process.env.CC_LAUNCHER_PORT || 7788)}/api/hook`;

const HOST = '127.0.0.1';
const PORT = Number(process.env.CC_LAUNCHER_PORT || 7788);
const API_VERSION = 7; // launchers use this to distinguish a stale in-memory server
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const LIVE_DIR = path.join(CLAUDE_HOME, 'sessions'); // <pid>.json = 살아있는 세션 상태
const PUBLIC_DIR = path.join(__dirname, 'public');
const PINS_FILE = path.join(__dirname, 'pins.json');
const FAVS_FILE = path.join(__dirname, 'favorites.json'); // "<slug>/<sessionId>" 목록
const HIDDEN_FILE = path.join(__dirname, 'hidden.json');  // 목록에서 숨긴 세션 (같은 형식)
const FOCUS_PS1 = path.join(__dirname, 'focus-window.ps1');

// state DB 의 rolloutPath 는 외부 입력처럼 취급한다. 지표 파서는 숫자만 돌려주지만,
// 애초에 ~/.codex/sessions 밖의 파일을 읽을 이유가 없다.
function codexMetricRows() {
  return codex.sessions().filter(s => s.rolloutPath && codex.isInsideSessions(s.rolloutPath));
}

// 여러 브라우저 탭이 같은 주기로 대용량 세션 파일을 다시 읽으면 Node의 단일
// 이벤트 루프가 지표 계산만 하다가 health 요청조차 처리하지 못한다. 짧은 서버 공용
// 캐시로 탭 수와 무관하게 실제 디스크 스캔 횟수를 제한한다.
const metricResponseCache = new Map();
function cachedMetric(name, ttlMs, build) {
  const now = Date.now();
  const hit = metricResponseCache.get(name);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = build();
  metricResponseCache.set(name, { at: now, value });
  return value;
}

const HEAD_BYTES = 96 * 1024;
const HEAD_MAX = 2 * 1024 * 1024;   // 거대 레코드가 앞을 막고 있을 때 넓혀 읽는 한계
const TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_BYTES = 3 * 1024 * 1024;

const SAFE_SLUG = /^[A-Za-z0-9._\-]+$/;
const SAFE_ID = /^[A-Za-z0-9\-]+$/;
// Codex 라이브 표시를 '지금 돌고 있다' 로 믿어주는 시간. 훅이 이벤트마다
// 갱신하므로 실제로 쓰고 있으면 이 안에 들어온다.
const EXTERNAL_LIVE_MS = 2 * 60 * 1000;

const CLAUDE_BIN = findClaudeBin();
const CODEX_BIN = codex.findCodexBin();
const WT_BIN = findBin('wt.exe');

// 로컬 두뇌 (/api/ask). 구독 로그인 그대로 쓰므로 API 키가 없다.
//
// 기본값은 보수적으로 잡았다 - 이 엔드포인트는 화면이 부르고, 화면을 잘못 짜면
// 무한 호출이 돈다. 호출당 약 20k 토큰(실측: codex 19,689 / claude 3,628)이라
// 300k 면 하루 15회 안팎이다. 환경변수로 올릴 수 있게 두되 기본은 넘치지 않는 쪽.
const ASK_LEDGER = path.join(os.homedir(), '.claude', '.cc-launcher-ask.json');
const askGuard = createGuard({
  now: () => Date.now(),
  load() {
    try { return JSON.parse(fs.readFileSync(ASK_LEDGER, 'utf8')); } catch (e) { return null; }
  },
  save(o) {
    try { fs.writeFileSync(ASK_LEDGER, JSON.stringify(o), 'utf8'); } catch (e) { /* 못 써도 이번 판정엔 지장 없다 */ }
  },
  limits: {
    perMinute: Number(process.env.CC_ASK_PER_MINUTE || 5),
    perDayTokens: Number(process.env.CC_ASK_DAY_TOKENS || 300000),
    cacheTtlMs: Number(process.env.CC_ASK_CACHE_MS || 10 * 60 * 1000),
  },
});
const ask = createAsk({
  guard: askGuard,
  runner: createRunner({
    spawn: require('child_process').spawn,
    // 이미 찾아 둔 경로를 넘긴다. Windows 에서 'claude' 는 없고 claude.cmd 다.
    bin: { claude: CLAUDE_BIN, codex: CODEX_BIN },
    // 실측: claude -p 한 번이 56초 걸렸다. 60초로 두면 정상 호출이 타임아웃으로 죽는다.
    timeoutMs: Number(process.env.CC_ASK_TIMEOUT_MS || 180000),
  }),
});

const sessionBridge = createBridge({
  terminals,
  startTarget(target) {
    return terminals.create({
      action: 'resume', cwd: target.cwd, sessionId: target.id, title: target.title,
      claudeBin: CLAUDE_BIN, codexBin: CODEX_BIN, provider: target.provider,
    });
  },
  // 정말 상대 대화에 들어갔는지 **기록으로** 확인한다.
  //
  // PTY 에 썼다는 것과 상대가 받았다는 것은 다르다 - 상태는 delivered 인데 Codex 세션
  // 기록에는 없는 경우를 실제로 봤다. 타이밍 규칙을 더 얹어 추측을 정교하게 만드는
  // 대신 결과를 본다. envelope 에 박힌 메시지 ID 가 기록에 나타나면 도착한 것이다.
  //
  // 못 읽는 것과 안 들어간 것을 구분하지 않는다 - 둘 다 "아직 확인 안 됨" 이고,
  // 재시도가 알아서 처리한다. 예외는 밖으로 던지지 않는다.
  async verify(message) {
    const id = message && message.id;
    const t = message && message.target;
    if (!id || !t || !t.id) return false;
    try {
      let msgs = [];
      if (t.provider === 'codex') {
        msgs = (codex.transcript(t.id, 20) || {}).msgs || [];
      } else {
        const found = findScannedSession('claude', t.id);
        if (!found) return false;
        msgs = (transcript(found.s.slug, found.s.id, 20) || {}).messages || [];
      }
      return msgs.some(m => m && m.role === 'user' && String(m.text || '').indexOf(id) >= 0);
    } catch { return false; }
  },
});

const handoffManager = createHandoff({
  terminals,
  readTranscript(job) {
    if (job.sourceProvider === 'codex') return codex.transcript(job.sourceSessionId, 80).msgs;
    const found = findScannedSession('claude', job.sourceSessionId);
    if (!found) throw new Error('Claude 세션 기록을 찾지 못했습니다');
    return transcript(found.s.slug, found.s.id, 80).messages;
  },
  startTarget(target) {
    return terminals.create({
      action: 'new', cwd: target.cwd, title: target.title,
      claudeBin: CLAUDE_BIN, codexBin: CODEX_BIN, provider: target.provider,
    });
  },
});

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

// 끊은 PID 는 캐시에서도 바로 뺀다. tasklist 캐시는 20초짜리라
// 그냥 두면 이미 죽인 세션이 20초 동안 '실행 중' 으로 남는다.
function forgetClaudePid(pid) {
  if (claudePidSet) claudePidSet.delete(Number(pid));
  claudePidCheckedAt = 0;
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
    const rec = {
      provider: 'claude',   // /api/live 에서 Codex 상태와 한 맵에 섞이므로 출처를 남긴다
      pid: o.pid,
      status: o.status || 'idle',          // busy | idle
      name: o.name || null,
      nameSource: o.nameSource || null,
      cwd: o.cwd || null,
      kind: o.kind || 'interactive',
      startedAt: o.startedAt || null,
      statusAt: o.statusUpdatedAt || o.updatedAt || null,
      pids: [o.pid],                       // 같은 세션을 물고 있는 모든 프로세스
    };
    // 같은 대화를 프로세스 두 개가 물고 있을 수 있다 (예: 이어하기로 두 번째 창을
    // 띄웠는데 첫 창이 아직 살아 있는 경우). 그냥 덮어쓰면 readdir 순서로 승자가
    // 정해져서, 옛 창의 'idle' 이 지금 작업 중인 창을 가려버린다.
    // 상태는 가장 최근에 갱신된 쪽을 쓰고, pid 는 전부 들고 간다.
    const prev = bySession.get(o.sessionId);
    if (!prev) { bySession.set(o.sessionId, rec); continue; }
    const winner = Number(rec.statusAt || 0) >= Number(prev.statusAt || 0) ? rec : prev;
    const loser = winner === rec ? prev : rec;
    winner.pids = loser.pids.concat(winner.pids.filter(x => loser.pids.indexOf(x) < 0));
    bySession.set(o.sessionId, winner);
  }
  return bySession;
}

// ---------------------------------------------------------------- 스캔 + 캐시

const cache = new Map(); // file -> { mtimeMs, size, info }

function scan() {
  const live = liveSessions();
  const favs = new Set(loadFavs());
  const hid = new Set(loadHidden());
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
        provider: 'claude',
        mtime: stat.mtimeMs,
        sizeKB: Math.round(stat.size / 1024),
        branch: info.gitBranch,
        version: info.version,
        title: info.aiTitle || info.firstPrompt || info.lastPrompt,
        firstPrompt: info.firstPrompt,
        last: info.lastPrompt,
        live: live.get(id) || null,
        fav: favs.has(d.name + '/' + id),
        hidden: hid.has(d.name + '/' + id),
        subagents: info.subagents,
      });
    }
  }

  // Codex 세션을 같은 프로젝트 맵에 병합한다. 키가 cwd 소문자라
  // 같은 폴더면 Claude 카드와 자연히 합쳐진다.
  const codexLive = codex.liveMap();
  for (const s of codex.sessions()) {
    if (!s.cwd) continue;
    const key = s.cwd.toLowerCase();
    if (!projects.has(key)) {
      projects.set(key, {
        key, cwd: s.cwd, name: path.basename(s.cwd) || s.cwd,
        exists: fs.existsSync(s.cwd),
        gitBranch: s.branch, sessions: [],
      });
    }
    const p = projects.get(key);
    if (!p.gitBranch && s.branch) p.gitBranch = s.branch;
    let sizeKB = 0;
    try { sizeKB = Math.round(fs.statSync(s.rolloutPath).size / 1024); } catch {}
    p.sessions.push({
      id: s.id, slug: null, provider: 'codex',
      mtime: s.mtime, sizeKB,
      branch: s.branch, version: null,
      title: s.title, firstPrompt: s.firstPrompt, last: s.last,
      live: codexLive.get(s.id) || null,
      fav: favs.has('codex:' + s.id),
      hidden: hid.has('codex:' + s.id),
      subagents: null,
      threadSource: s.threadSource, parentId: s.parentId,
      tokens: s.tokens,
    });
  }

  const pins = loadPins();
  const list = [...projects.values()];
  for (const p of list) {
    p.hidden = hid.has('proj:' + p.key);
    p.sessions.sort((a, b) => {
      const la = a.live ? 1 : 0, lb = b.live ? 1 : 0;
      return (lb - la) || (b.mtime - a.mtime);
    });
    p.mtime = p.sessions[0] ? p.sessions[0].mtime : 0;
    p.liveCount = p.sessions.filter(s => s.live).length;
    p.busyCount = p.sessions.filter(s => s.live && s.live.status === 'busy').length;
    p.waitCount = p.sessions.filter(s => s.live && s.live.status === 'waiting').length;
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
// 숨긴 세션. 파일은 그대로 두고 목록에서만 뺀다 (삭제와 달리 되돌리기 쉽다).
function loadHidden() {
  try { return JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8')); } catch { return []; }
}
function saveHidden(list) {
  try { fs.writeFileSync(HIDDEN_FILE, JSON.stringify(list, null, 2), 'utf8'); } catch {}
}
// 즐겨찾기와 같은 토큰 형식을 쓴다: codex 는 "codex:<id>", claude 는 "<slug>/<id>"
function sessionToken(provider, slug, id) {
  if (!SAFE_ID.test(String(id || ''))) throw new Error('잘못된 세션 지정');
  if (provider === 'codex') return 'codex:' + id;
  if (!SAFE_SLUG.test(String(slug || ''))) throw new Error('잘못된 세션 지정');
  return `${slug}/${id}`;
}

function findScannedSession(provider, id, projects) {
  for (const p of (projects || scan())) for (const s of p.sessions) {
    if (s.provider === provider && s.id === id) return { p, s };
  }
  return null;
}

function termsWithFavorites() {
  const projects = scan();
  return terminals.list().map(t => {
    if (!t.sessionId) return Object.assign({}, t, { fav: false, slug: null });
    const found = findScannedSession(t.provider, t.sessionId, projects);
    return Object.assign({}, t, {
      fav: !!(found && found.s.fav),
      slug: found && found.s.slug || null,
    });
  });
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

// claudeCommand 와 형제 함수. codex CLI 를 외부 터미널에서 실행할 명령 문자열을 만든다.
function codexCommand(action, sessionId) {
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  if (!CODEX_BIN) throw new Error('codex 를 찾을 수 없습니다 (npm i -g @openai/codex)');
  return [`& ${q(CODEX_BIN)}`, ...codex.codexArgs(action, sessionId)].join(' ');
}

function launch({ action, cwd, sessionId, title, extra, provider, newWindow }) {
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`폴더가 없습니다: ${cwd}`);
  if ((action === 'resume' || action === 'fork') && !SAFE_ID.test(String(sessionId || '')))
    throw new Error('세션 ID 가 올바르지 않습니다');
  const inner = provider === 'codex'
    ? codexCommand(action, sessionId)
    : claudeCommand(action, sessionId, extra);
  const tabTitle = title || path.basename(cwd);

  if (WT_BIN) {
    spawn(WT_BIN, wtArgs({ cwd, title: tabTitle, inner, newWindow }),
          { detached: true, stdio: 'ignore' }).unref();
    return newWindow ? 'wt-window' : 'wt';
  }
  spawn('powershell.exe', ['-NoLogo', '-Command',
    `Start-Process powershell -ArgumentList '-NoExit','-NoLogo','-Command',${JSON.stringify(inner)} -WorkingDirectory ${JSON.stringify(cwd)}`,
  ], { detached: true, stdio: 'ignore' }).unref();
  return 'powershell';   // Windows Terminal 이 없으면 원래부터 세션마다 창이 따로 뜬다
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

// 실행 중인 CLI 프로세스를 끊는다.
//
// 대시보드를 강제 종료하면 내장 터미널이 띄운 claude/codex 프로세스가 고아로 남는다.
// 창도 없고 붙을 터미널 패인도 없어서, 다시 켜면 '실행 중' 으로만 보이고 손댈 방법이
// 없다. taskkill /T 로 자식까지 함께 끊는다 - CLI 가 띄운 MCP 서버·서브프로세스가
// 남으면 포트를 물고 있는다. 콘솔 앱이라 WM_CLOSE 가 안 먹으므로 /F 가 필요하다.
// 기록(jsonl)은 그때그때 append 되므로 끊어도 대화 내용은 남는다.
// taskkill 의 종료 코드로 판정한다. **메시지 문자열로 판정하면 안 된다** -
// taskkill 은 콘솔 코드페이지(한글 Windows 는 CP949)로 출력하는데 Node 는 UTF-8 로
// 읽으므로 한글이 깨진다. 실측: "오류: 프로세스 "17656"을(를) 찾을 수 없습니다." 가
// "����: ���μ��� ..." 로 들어와 '찾을 수 없' 검사가 빗나갔고, 이미 죽은 프로세스를
// 끊으려던 것이 500 으로 튀었다(세션 종료 버튼이 통째로 먹통).
//
//   0    끊었다
//   128  그런 프로세스가 없다 (실측)
//   그 외 진짜 실패
// provider 를 가리지 않는 생존 확인.
// pidAlive() 는 claude.exe 목록(claudePidSet)으로 판정하므로 Codex pid 에는 쓸 수 없다 -
// 살아 있어도 '없음' 이 나온다.
function procAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // 권한이 없을 뿐 살아는 있다
}

function killTree(pid) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(pid) || pid <= 0) return reject(new Error('잘못된 PID'));
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 8000 },
      (err) => {
        const out = taskkillOutcome(err);
        if (out === 'killed') return resolve(true);
        if (out === 'absent') return resolve(false);   // 이미 없다 = 실패 아님
        // 메시지는 깨져 있을 수 있으니 코드만 싣는다.
        reject(new Error('프로세스 ' + pid + ' 를 종료하지 못했습니다 (taskkill 코드 '
          + (err && err.code == null ? '?' : err.code) + ')'));
      });
  });
}

// 세션 ID 로 실제 CLI 프로세스를 찾는다.
//
// Codex 상태 파일의 pid 는 훅 프로세스의 **부모**라 이미 죽어 있다(실측: 기록된 pid
// 둘 다 죽었는데 codex.exe 는 돌고 있었다). 그 pid 만 보고 끊으면 아무것도 안 죽고
// '이미 종료된 세션' 이라고 답한다 - 버튼이 먹통으로 보이는 진짜 이유다.
//
// 다행히 이어하기/포크로 띄운 프로세스는 명령줄에 세션 ID 가 그대로 남는다:
//   codex.exe fork 01a0a4c9-44a6-7d20-ada6-f2434bfc3929
// 목록만 받아와 **Node 에서** 걸러낸다(세션 ID 를 스크립트에 끼워 넣지 않는다).
function findSessionPids(sessionId) {
  return new Promise(resolve => {
    if (!SAFE_ID.test(String(sessionId || ''))) return resolve([]);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='codex.exe' or Name='claude.exe'\""
      + " | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        let rows;
        try { rows = JSON.parse(String(stdout || '[]')); } catch { return resolve([]); }
        if (!Array.isArray(rows)) rows = [rows];
        const hits = [];
        for (const r of rows) {
          if (!r || !r.CommandLine || !r.ProcessId) continue;
          if (String(r.CommandLine).indexOf(sessionId) < 0) continue;
          hits.push(Number(r.ProcessId));
        }
        resolve(hits);
      });
  });
}

// ------------------------------------------------ 붙여넣은 파일 저장 / 내려받기

const PASTE_DIR = path.join(os.tmpdir(), 'cc-launcher', 'paste');

// 바이트를 붙여넣기 폴더에 저장하고 경로를 돌려준다.
// 이름은 클라이언트가 주므로 경로 요소·금지문자를 모두 떨어내고 쓴다.
function savePaste(raw, givenName) {
  let base = path.basename(String(givenName || '').trim().replace(/[\\/]/g, '_')) || 'paste';
  base = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(-120);
  if (!path.extname(base)) base += '.bin';

  fs.mkdirSync(PASTE_DIR, { recursive: true });
  const d = new Date();
  const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0') + '-'
    + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')
    + String(d.getSeconds()).padStart(2, '0');

  let full = path.join(PASTE_DIR, stamp + '-' + base);
  for (let i = 2; fs.existsSync(full); i++) {
    full = path.join(PASTE_DIR, stamp + '-' + i + '-' + base);
  }
  // 조립이 어긋나 폴더 밖으로 나가는 일이 없게 마지막으로 확인한다
  if (!path.resolve(full).startsWith(path.resolve(PASTE_DIR) + path.sep)) {
    throw new Error('저장 경로가 올바르지 않습니다');
  }
  fs.writeFileSync(full, raw);
  return { path: full, bytes: raw.length };
}

// 끌어다 놓은 이미지 주소를 내려받아 저장한다.
// 브라우저에서 직접 받으면 남의 사이트는 CORS 에 막히므로 서버가 받는다.
function downloadToPaste(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new Error('주소를 읽을 수 없습니다'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('http/https 주소만 받습니다');
  }
  const mod = u.protocol === 'https:' ? require('https') : require('http');

  return new Promise((resolve, reject) => {
    const hops = [];
    const go = (target, depth) => {
      if (depth > 5) return reject(new Error('리다이렉트가 너무 많습니다'));
      hops.push(target.href);
      const r = mod.get(target, { timeout: 20000 }, resp => {
        // 리다이렉트 따라가기
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          resp.resume();
          let next;
          try { next = new URL(resp.headers.location, target); } catch { return reject(new Error('리다이렉트 주소가 잘못됐습니다')); }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return reject(new Error('http/https 주소만 받습니다'));
          }
          return go(next, depth + 1);
        }
        if (resp.statusCode !== 200) {
          resp.resume();
          return reject(new Error('받기 실패 (HTTP ' + resp.statusCode + ')'));
        }
        const len = Number(resp.headers['content-length'] || 0);
        if (len > PASTE_MAX) {
          resp.destroy();
          return reject(new Error('파일이 너무 큽니다 (' + Math.round(len / 1048576) + 'MB)'));
        }
        const chunks = [];
        let got = 0;
        resp.on('data', c => {
          got += c.length;
          if (got > PASTE_MAX) { resp.destroy(); return reject(new Error('파일이 너무 큽니다')); }
          chunks.push(c);
        });
        resp.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (!buf.length) return reject(new Error('빈 파일입니다'));
          // 이름은 주소의 마지막 조각에서. 없으면 content-type 으로 확장자를 짓는다.
          let name = '';
          try { name = path.basename(decodeURIComponent(target.pathname || '')); } catch { name = ''; }
          if (!name || !path.extname(name)) {
            const ct = String(resp.headers['content-type'] || '').split(';')[0].trim();
            const ext = ct && ct.indexOf('/') > 0 ? '.' + ct.split('/')[1].split('+')[0] : '.bin';
            name = (name || 'dropped') + ext;
          }
          try { resolve(savePaste(buf, name)); } catch (e) { reject(e); }
        });
        resp.on('error', () => reject(new Error('받는 중 끊겼습니다')));
      });
      r.on('timeout', () => { r.destroy(); reject(new Error('시간이 초과됐습니다')); });
      r.on('error', e => reject(new Error(e.message)));
    };
    go(u, 0);
  });
}

// 오래된 붙여넣기 파일은 서버가 뜰 때 정리한다. 안 지우면 계속 쌓인다.
const PASTE_KEEP_DAYS = 7;
function reapPasteDir() {
  try {
    const cut = Date.now() - PASTE_KEEP_DAYS * 24 * 60 * 60 * 1000;
    let n = 0;
    for (const f of fs.readdirSync(PASTE_DIR)) {
      const p = path.join(PASTE_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cut) { fs.unlinkSync(p); n++; }
      } catch {}
    }
    if (n) console.log(`붙여넣기 임시 파일 ${n}개 정리 (${PASTE_KEEP_DAYS}일 경과)`);
  } catch {}
}

// 윈도 기본 폴더 선택 창을 띄우고 고른 경로를 돌려준다.
// 브라우저에는 진짜 폴더 경로를 주는 표준 방법이 없다(<input webkitdirectory> 는
// 파일 이름만 준다). 그래서 서버가 네이티브 대화상자를 띄운다.
//
// 스크립트는 ASCII 로만 쓴다. PS 5.1 은 BOM 없는 입력을 ANSI 로 읽어 한글이 깨진다.
// 한국어 안내는 서버 쪽 메시지로 처리한다.
function pickFolder(start) {
  const safeStart = start && fs.existsSync(start) ? String(start).replace(/'/g, "''") : '';
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
    '$d.Description = "Pick a project folder to run Claude Code in";',
    '$d.ShowNewFolderButton = $true;',
    safeStart ? `$d.SelectedPath = '${safeStart}';` : '',
    // 대화상자가 브라우저 뒤로 숨지 않게 맨 앞 폼을 소유자로 준다
    '$top = New-Object System.Windows.Forms.Form;',
    '$top.TopMost = $true; $top.ShowInTaskbar = $false;',
    '$top.Size = New-Object System.Drawing.Size(1,1);',
    '$r = $d.ShowDialog($top);',
    '$top.Dispose();',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
  ].filter(Boolean).join(' ');

  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps],
      { timeout: 180000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        const p = String(stdout || '').trim();
        if (!p) return resolve(null);              // 취소했거나 시간 초과
        resolve(p);
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
               '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
               // SCRIBE 빌드물이 KaTeX 폰트를 woff/ttf 로도 싣는다
               '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
               // 보관 폴더의 이미지를 미리보기에 내려줄 때
               '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
               '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
               '.bmp': 'image/bmp' };

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

// 붙여넣기·드롭으로 올라온 파일 원본 바이트. JSON 이 아니라 그대로 받는다.
const PASTE_MAX = 32 * 1024 * 1024;
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let over = false;
    req.on('data', c => {
      len += c.length;
      if (len > limit) { over = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return reject(new Error('파일이 너무 큽니다'));
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => reject(over ? new Error('파일이 너무 큽니다') : new Error('업로드가 끊겼습니다')));
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
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, app: 'cc-launcher', apiVersion: API_VERSION, port: PORT });
    }

    if (url.pathname === '/api/projects') {
      return json(res, 200, {
        projects: scan(),
        env: { claude: CLAUDE_BIN, codex: CODEX_BIN, wt: WT_BIN, projectsDir: PROJECTS_DIR },
      });
    }

    // 사용량은 Claude 쪽이 파일 전체 읽기라 비싸다. scan() 과 분리해 여기서만 계산한다.
    if (url.pathname === '/api/usage') {
      const cached = metricResponseCache.get('usage');
      if (cached && Date.now() - cached.at < 10000) return json(res, 200, cached.value);
      const out = { projects: {}, sessions: {} };
      // Codex 는 rollout 파일 끝의 token_count 레코드를 읽어야 Claude 와 같은 정의의
      // billable 이 나온다. rolloutPath 는 scan() 결과에 없으므로 여기서 한 번만 만든다
      // (codex.sessions() 는 DB stamp 캐시라 값싸다).
      const rollouts = new Map();
      for (const s of codex.sessions()) if (s.rolloutPath) rollouts.set(s.id, s.rolloutPath);

      for (const p of scan()) {
        let billable = 0, cacheRead = 0, approx = false;
        for (const s of p.sessions) {
          let u = null;
          if (s.provider === 'codex') {
            const rp = rollouts.get(s.id);
            if (rp && codex.isInsideSessions(rp)) u = usage.forCodexFile(rp);
            // rollout 을 못 읽으면 threads.tokens_used 로 물러선다. 그 값은 캐시 입력을
            // 포함한 총량이라 Claude 의 billable 과 같은 자로 잰 값이 아니다.
            // approx 로 표시해서 UI 툴팁이 그 사실을 말하게 한다.
            if (!u) u = Object.assign(usage.empty(), { billable: s.tokens || 0, approx: true });
          } else {
            u = usage.forClaudeFile(path.join(PROJECTS_DIR, s.slug, s.id + '.jsonl'));
          }
          out.sessions[s.provider + ':' + s.id] = u;
          billable += u.billable;
          cacheRead += u.cacheRead;
          if (u.approx && u.billable) approx = true;
        }
        out.projects[p.key] = { billable, cacheRead, approx };
      }
      metricResponseCache.set('usage', { at: Date.now(), value: out });
      return json(res, 200, out);
    }

    // 실행 상태만 (jsonl 스캔 없음 → 수 ms). 짧은 주기로 폴링해도 부담 없다.
    //
    // Codex 상태도 반드시 같이 넣는다. 프론트의 pollLive() 는 4초마다 provider 를
    // 가리지 않고 모든 세션에 대해 s.live = j.live[s.id] || null 을 하므로, 여기서
    // Codex 를 빼면 훅이 만들어 준 실행 상태가 4초마다 지워지고 60초 전체 갱신까지
    // 사라진 채로 남는다. liveMap() 은 readdirSync + 작은 JSON 몇 개라 DB 접근이 없다.
    //
    // 두 provider 가 한 id 공간을 공유하지 않지만(Claude UUID vs Codex thread id)
    // 만에 하나 겹쳐도 남의 상태를 덮어쓰지 않게 이미 들어있는 키는 건너뛴다.
    // 각 항목에 provider 를 실어 보내 프론트가 자기 provider 것만 붙이게 한다.
    if (url.pathname === '/api/live') {
      const live = {};
      for (const [id, v] of liveSessions()) live[id] = v;
      for (const [id, v] of codex.liveMap()) if (!live[id]) live[id] = v;
      return json(res, 200, { live, at: Date.now() });
    }

    if (url.pathname === '/api/transcript') {
      const limit = Number(url.searchParams.get('limit')) || 40;
      if (url.searchParams.get('provider') === 'codex') {
        const id = url.searchParams.get('id') || '';
        if (!SAFE_ID.test(id)) throw new Error('세션 ID 가 올바르지 않습니다');
        const t = codex.transcript(id, limit);
        // codex.transcript() 는 {msgs,total} 이다 (codex.js/test 계약) - 프론트는
        // Claude 쪽 transcript() 와 같은 {messages,total} 모양을 읽으므로 여기서 맞춰준다.
        return json(res, 200, { messages: t.msgs, total: t.total, truncated: t.total > t.msgs.length });
      }
      return json(res, 200, transcript(
        url.searchParams.get('slug') || '',
        url.searchParams.get('id') || '', limit));
    }

    if (url.pathname === '/api/launch' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: true, via: launch(b), newWindow: !!b.newWindow });
    }

    if (url.pathname === '/api/focus' && req.method === 'POST') {
      const b = await readBody(req);
      const info = await focusWindow(Number(b.pid));
      return json(res, 200, { ok: true, info });
    }

    // 터미널에 붙여넣거나 끌어다 놓은 파일을 받아 디스크에 저장하고 경로를 돌려준다.
    //
    // PTY 는 텍스트만 흘려보내므로 이미지·파일 자체는 터미널로 못 보낸다.
    // 대신 파일을 저장하고 그 **경로**를 프롬프트에 찍어주면 CLI 가 읽는다
    // (공식 문서의 "Provide an image path to Claude" 방식).
    if (url.pathname === '/api/paste-file' && req.method === 'POST') {
      // 다 받고 나서 끊으면 클라이언트는 그냥 "네트워크 오류"만 본다.
      // 길이를 미리 보고 제대로 된 메시지로 거절한다.
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > PASTE_MAX) {
        json(res, 413, {
          error: '파일이 너무 큽니다 (' + Math.round(declared / 1048576) + 'MB · 최대 '
               + (PASTE_MAX / 1048576) + 'MB)'
        });
        req.resume();      // 소켓을 끊지 말고 남은 본문을 흘려보낸다.
        return;            // 끊으면 클라이언트가 응답 대신 네트워크 오류만 본다.
      }
      const raw = await readRawBody(req, PASTE_MAX);
      if (!raw.length) throw new Error('빈 파일입니다');
      const saved = savePaste(raw, url.searchParams.get('name'));
      return json(res, 200, { ok: true, path: saved.path, bytes: saved.bytes });
    }

    // ------- 로컬 마크다운 문서 편집기 -------
    if (url.pathname === '/api/docs' && req.method === 'POST') {
      const raw = await readRawBody(req, 16 * 1024 * 1024);
      let b;
      try { b = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
      catch { throw new Error('요청 본문을 읽지 못했습니다'); }
      return json(res, 200, { ok: true, result: documents.run(String(b.op || ''), b) });
    }

    if (url.pathname === '/api/docs/image' && req.method === 'POST') {
      const raw = await readRawBody(req, 8 * 1024 * 1024);
      const result = documents.saveImage(url.searchParams.get('root'), url.searchParams.get('file'), raw);
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === '/api/docs/asset' && req.method === 'GET') {
      const asset = documents.assetPath(url.searchParams.get('root'), url.searchParams.get('file'));
      res.writeHead(200, { 'content-type': asset.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(asset.full).pipe(res);
    }

    // ------- 마크다운 편집기 (SCRIBE) -------

    // 브리지 동작 하나. 프런트의 window.scribe 가 여기로 보낸다.
    //
    // readBody 는 1MB 에서 끊는다. 문서 저장은 SCRIBE 상한인 8MB 까지 올 수 있어
    // 그대로 쓰면 큰 문서가 조용히 잘린다. 넉넉히 받고 여기서 파싱한다.
    if (url.pathname === '/api/md' && req.method === 'POST') {
      const raw = await readRawBody(req, 16 * 1024 * 1024);
      let b;
      try { b = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
      catch { throw new Error('요청 본문을 읽지 못했습니다'); }
      return json(res, 200, { ok: true, result: scribe.run(String(b.op || ''), b) });
    }

    // 붙여넣은 이미지. JSON 이 아니라 원본 바이트로 받는다.
    // 터미널에 찍힌 .md 경로를 Ctrl+클릭했을 때 쓰는 경로 확인.
    //
    // 브라우저는 그 경로가 진짜 있는지, 상대경로가 어느 폴더 기준인지 모른다.
    // 터미널의 cwd 를 기준으로 풀어서 폴더와 파일 이름을 돌려준다.
    // 여는 것 자체는 SCRIBE 의 보관 폴더를 그 폴더로 바꿔서 한다.
    if (url.pathname === '/api/md/resolve' && req.method === 'POST') {
      const b = await readBody(req);
      const raw = String(b.path || '').trim().replace(/^["'`]|["'`]$/g, '');
      if (!raw) throw new Error('경로가 비어 있습니다');
      if (!/\.(md|markdown)$/i.test(raw)) throw new Error('마크다운 파일이 아닙니다');
      const base = String(b.cwd || '');
      const full = path.resolve(path.isAbsolute(raw) ? raw : path.join(base, raw));
      let st;
      try { st = fs.statSync(full); } catch { throw new Error('파일을 찾지 못했습니다: ' + full); }
      if (!st.isFile()) throw new Error('파일이 아닙니다: ' + full);
      return json(res, 200, {
        ok: true, full, dir: path.dirname(full), file: path.basename(full),
      });
    }

    if (url.pathname === '/api/md/image' && req.method === 'POST') {
      const raw = await readRawBody(req, PASTE_MAX);
      const saved = scribe.saveImage(String(url.searchParams.get('p') || ''), raw);
      return json(res, 200, { ok: true, result: saved });
    }

    // 보관 폴더 안의 이미지를 미리보기에 내려준다
    if (url.pathname === '/api/md/asset') {
      const file = scribe.assetPath(String(url.searchParams.get('p') || ''));
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      return fs.createReadStream(file).pipe(res);
    }

    // SCRIBE 빌드물. index.html 에만 브리지 스크립트를 끼워 넣는다.
    if (url.pathname === '/scribe' || url.pathname.startsWith('/scribe/')) {
      if (!scribe.available()) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(scribe.status().error || 'SCRIBE 를 쓸 수 없습니다');
      }
      const rel = url.pathname.replace(/^\/scribe\/?/, '') || 'index.html';
      if (rel === 'index.html') {
        const html = scribe.indexHtml();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      const full = scribe.distFile(rel);
      if (!full) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        // 해시가 붙은 파일이라 오래 캐시해도 된다 (7.9MB 를 매번 받으면 느리다)
        'cache-control': 'public, max-age=86400',
      });
      return fs.createReadStream(full).pipe(res);
    }

    // 웹페이지에서 끌어온 이미지는 파일이 아니라 URL 로 온다. 받아서 저장한다.
    //
    // 브라우저에서 직접 받아오면 남의 사이트는 CORS 에 막히므로 서버가 받는다.
    // 대신 사용자가 끌어다 놓은 그 주소만 받고, http/https 로 제한한다.
    if (url.pathname === '/api/paste-url' && req.method === 'POST') {
      const b = await readBody(req);
      const saved = await downloadToPaste(String(b.url || ''));
      return json(res, 200, { ok: true, path: saved.path, bytes: saved.bytes });
    }

    // 폴더 선택 창. 고른 경로와 함께 "여기에 이미 세션이 있는지"도 알려준다.
    if (url.pathname === '/api/pickfolder' && req.method === 'POST') {
      const b = await readBody(req);
      const picked = await pickFolder(b.start);
      if (!picked) return json(res, 200, { ok: true, cancelled: true });
      if (!fs.existsSync(picked)) throw new Error(`폴더가 없습니다: ${picked}`);
      let known = false;
      try {
        const slug = picked.replace(/[\\/:]/g, '-');
        known = fs.existsSync(path.join(PROJECTS_DIR, slug))
             || fs.readdirSync(PROJECTS_DIR).some(d =>
                  d.toLowerCase() === slug.toLowerCase());
      } catch {}
      return json(res, 200, { ok: true, path: picked, known });
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.target === 'vscode') openVSCode(b.cwd); else openFolder(b.cwd);
      return json(res, 200, { ok: true });
    }

    // 숨기기 토글. 파일은 건드리지 않는다. 세션 하나 또는 프로젝트 통째로.
    if (url.pathname === '/api/hide' && req.method === 'POST') {
      const b = await readBody(req);
      const list = loadHidden();
      if (b.clear) { saveHidden([]); return json(res, 200, { ok: true, hidden: [] }); }
      // 프로젝트는 'proj:<cwd 소문자>' 로 넣는다. 세션 토큰과 섞이지 않는다.
      const token = b.project
        ? 'proj:' + String(b.project).toLowerCase()
        : sessionToken(b.provider, b.slug, b.id);
      const i = list.indexOf(token);
      if (i >= 0) list.splice(i, 1); else list.push(token);
      saveHidden(list);
      return json(res, 200, { ok: true, hidden: list, on: i < 0 });
    }

    // 세션 삭제. 지우지 않고 휴지통으로 옮긴다 (되돌릴 수 있게).
    if (url.pathname === '/api/session/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = Array.isArray(b.sessions) ? b.sessions : [b];
      const done = [], failed = [];
      for (const s of ids) {
        try {
          if (s.provider === 'codex') throw new Error('Codex 세션은 아직 삭제할 수 없습니다');
          if (!SAFE_SLUG.test(String(s.slug || '')) || !SAFE_ID.test(String(s.id || '')))
            throw new Error('잘못된 세션 지정');
          const file = path.join(PROJECTS_DIR, s.slug, s.id + '.jsonl');
          if (!path.resolve(file).startsWith(path.resolve(PROJECTS_DIR) + path.sep))
            throw new Error('경로가 올바르지 않습니다');
          if (!fs.existsSync(file)) throw new Error('세션 파일이 없습니다');
          const moved = cfgWrite.trashPath(file, 'session-' + s.id.slice(0, 8));
          // 서브에이전트 기록 폴더가 있으면 같이 옮긴다
          const subDir = path.join(PROJECTS_DIR, s.slug, s.id);
          if (fs.existsSync(subDir)) {
            try { cfgWrite.trashPath(subDir, 'session-' + s.id.slice(0, 8) + '-sub'); } catch {}
          }
          // 즐겨찾기·숨김 목록에서도 뺀다
          const token = sessionToken(s.provider, s.slug, s.id);
          const favs = loadFavs(); const fi = favs.indexOf(token);
          if (fi >= 0) { favs.splice(fi, 1); saveFavs(favs); }
          const hid = loadHidden(); const hi = hid.indexOf(token);
          if (hi >= 0) { hid.splice(hi, 1); saveHidden(hid); }
          done.push({ id: s.id, trashed: moved });
        } catch (e) {
          failed.push({ id: s && s.id, error: String((e && e.message) || e) });
        }
      }
      // scan() 은 매번 디렉터리를 다시 읽으므로 삭제분은 저절로 빠진다
      return json(res, 200, { ok: true, deleted: done.length, done, failed });
    }

    // 실행 중인 세션 끊기. 고아로 남은 CLI 프로세스를 목록에서 직접 종료한다.
    if (url.pathname === '/api/session/kill' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '');
      if (!SAFE_ID.test(id)) throw new Error('잘못된 세션 지정');
      const isCodex = b.provider === 'codex';

      // PID 는 클라이언트 말을 믿지 않고 라이브 상태에서 다시 찾는다.
      // 아무 PID 나 받아서 죽이면 대시보드가 임의 프로세스 킬러가 된다.
      const live = isCodex ? codex.liveMap().get(id) : liveSessions().get(id);

      // 이 대시보드가 띄운 터미널이면 패인째로 정리한다. 프로세스만 끊으면
      // 죽은 화면이 탭에 남는다.
      const emb = terminals.list().find(t => t.alive && t.sessionId === id);
      if (emb) terminals.close(emb.id);

      if (!live) {
        // Codex 는 훅이 쓴 상태 파일이 남아 있을 수 있다. 치워야 목록에서 빠진다.
        const cleaned = isCodex ? codex.dropLive(id) : false;
        return json(res, 200, {
          ok: true, killed: false, closedTerminal: !!emb, cleaned,
          message: emb ? '대시보드 터미널을 닫았습니다'
                       : '이미 종료된 세션입니다' + (cleaned ? ' · 목록에서 정리했습니다' : ''),
        });
      }

      // 한 세션을 프로세스 여러 개가 물고 있을 수 있다. 하나만 끊으면 남은 쪽이
      // 계속 상태 파일을 써서 곧바로 '실행 중' 으로 되살아난다 - 버튼이 먹통처럼 보인다.
      const recorded = Array.isArray(live.pids) && live.pids.length
        ? live.pids.map(Number) : (live.pid ? [Number(live.pid)] : []);
      // 기록된 pid 가 이미 죽었으면 그걸로는 아무것도 못 끊는다. Codex 는 늘 그렇다
      // (상태 파일의 pid 가 훅 프로세스의 부모라서). 그때는 명령줄에 세션 ID 가 남아
      // 있는 실제 프로세스를 찾아서 끊는다.
      const alive = recorded.filter(procAlive);
      const found = alive.length ? [] : await findSessionPids(id);
      const pids = [...new Set([...alive, ...found])];
      const done = [];
      for (const pid of pids) {
        if (await killTree(Number(pid))) done.push(pid);
        if (!isCodex) forgetClaudePid(pid);
      }
      const killed = done.length > 0;
      const cleaned = isCodex ? codex.dropLive(id) : false;
      return json(res, 200, {
        ok: true, killed, closedTerminal: !!emb, cleaned,
        pid: done[0] || null, pids: done, viaCommandLine: found.length > 0,
        message: killed
          ? '세션을 종료했습니다 (PID ' + done.join(', ') + ')'
          : '이미 종료된 세션입니다 · 목록에서 정리했습니다',
      });
    }

    if (url.pathname === '/api/fav' && req.method === 'POST') {
      const b = await readBody(req);
      if (!SAFE_ID.test(String(b.id || ''))) throw new Error('잘못된 세션 지정');
      let token;
      if (b.provider === 'codex') token = 'codex:' + b.id;
      else {
        if (!SAFE_SLUG.test(String(b.slug || ''))) throw new Error('잘못된 세션 지정');
        token = `${b.slug}/${b.id}`;      // 기존 형식 유지 - favorites.json 하위호환
      }
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

    // ------- 훅 설치 상태 / 설치 / 제거 (provider 로 Claude / Codex 분기) -------
    if (url.pathname === '/api/hooks/status') {
      return json(res, 200, {
        claude: Object.assign(hooksInstall.status(HOOK_URL), { url: HOOK_URL }),
        codex: codexHooks.status(),
      });
    }
    if (url.pathname === '/api/hooks/install' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, b.provider === 'codex'
        ? codexHooks.install(HOOK_URL)
        : hooksInstall.install(HOOK_URL, b.mode));
    }
    if (url.pathname === '/api/hooks/uninstall' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, b.provider === 'codex'
        ? codexHooks.uninstall()
        : hooksInstall.uninstall(HOOK_URL));
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
    // Codex 구성 읽기 (읽기 전용). codex doctor 가 네트워크 확인까지 해서 수 초가 걸리므로
    // 구성 탭 로딩에 끼워 넣지 않고, 프론트가 버튼을 눌렀을 때만 호출한다.
    if (url.pathname === '/api/cfg/codex') {
      return new Promise(resolve => {
        codex.doctor((err, report) => {
          resolve(json(res, 200, err ? { ok: false, error: String(err.message) } : report));
        });
      });
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
        case 'agent-team':   out = cfgWrite.createAgentTeam(b); break;
        case 'agent-delete': out = cfgWrite.deleteAgent(b.name, b.scope, b.cwd); break;
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

    // ------- 토큰 사용량 -------
    // 사용 한도. 비공식 endpoint 라 실패해도 200 으로 ok:false 만 돌려준다 -
    // 헤더 바가 오류로 깨지면 안 된다.
    // 로컬 두뇌. 화면이 fetch 한 번으로 스키마에 맞는 JSON 을 받아 간다.
    //
    // 가드를 우회할 길은 두지 않는다 - 실행기는 ask() 안에서만 불린다.
    // 무한 호출이 돌면 분당 5회에서 먼저 걸리고, 그래도 계속되면 일일 토큰 상한에서
    // 약 2.5분 만에 멈춘다 (분당 5회 x 20k = 100k/분, 상한 300k).
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      const b = await readBody(req);
      let run = null;
      req.on('close', () => { if (run && run.cancel) run.cancel(); });
      const out = await ask(b, { onStart: (p) => { run = p; } });
      return json(res, out.status || (out.ok ? 200 : 502), out);
    }

    if (url.pathname === '/api/limits') {
      return json(res, 200, await providerMetrics.limits(codexMetricRows(), {
        force: url.searchParams.get('force') === '1',
      }));
    }

    if (url.pathname === '/api/tokens') {
      return json(res, 200, cachedMetric('tokens', 15000,
        () => providerMetrics.tokens(codexMetricRows())));
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
      return json(res, 200, { terms: termsWithFavorites() });
    }

    if (url.pathname === '/api/term/fav' && req.method === 'POST') {
      const b = await readBody(req);
      const t = terminals.get(String(b.id || ''));
      if (!t || t.exitCode != null) throw new Error('실행 중인 터미널이 없습니다');
      const inf = terminals.info(t);
      if (!inf.sessionId) throw new Error('첫 메시지를 보낸 뒤 세션 ID가 확인되면 즐겨찾기할 수 있습니다');
      const found = findScannedSession(inf.provider, inf.sessionId);
      if (!found) throw new Error('세션 기록을 찾지 못했습니다');
      const token = sessionToken(inf.provider, found.s.slug, inf.sessionId);
      const favs = loadFavs();
      const i = favs.indexOf(token);
      if (i >= 0) favs.splice(i, 1); else favs.push(token);
      saveFavs(favs);
      return json(res, 200, { ok: true, fav: i < 0 });
    }

    if (url.pathname === '/api/term/context' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '');
      const t = terminals.get(id);
      if (!t || t.exitCode != null) throw new Error('실행 중인 터미널이 없습니다');
      const inf = terminals.info(t);
      if (inf.status === 'busy' || inf.status === 'waiting') {
        throw new Error('작업 또는 승인 대기가 끝난 뒤 실행해 주세요');
      }
      // lastAt 이 아니라 lastRealAt 을 본다 - Codex TUI 는 대기 중에도 스피너를
      // 다시 그려서 lastAt 기준으로는 영영 잠잠해지지 않고, 그러면 압축·초기화
      // 버튼이 Codex 터미널에서만 영구히 막힌다.
      if (!inf.status && Date.now() - Number(t.lastRealAt || t.lastAt || 0) < 1500) {
        throw new Error('터미널 출력이 멈춘 뒤 실행해 주세요');
      }
      // 모달 프롬프트가 떠 있으면 /compact 가 대화창이 아니라 메뉴로 들어간다.
      const ctxBlocked = pendingPrompt(t.buf);
      if (ctxBlocked) {
        throw new Error('이 세션이 ' + ctxBlocked + ' 에서 멈춰 있습니다. 터미널에서 먼저 응답해 주세요');
      }
      if (b.action === 'compact') {
        // 붙여넣기와 Enter 를 나눠 보낸다 - Codex 는 201~ 뒤의 CR 을 제출로 안 받는다.
        if (!submitPaste(terminals.write, id, commandFor(inf.provider, 'compact')))
          throw new Error('컨텍스트 압축 명령을 입력하지 못했습니다');
        return json(res, 200, { ok: true, action: 'compact' });
      }
      if (b.action === 'clear') {
        const fresh = await terminals.fresh(id, { claudeBin: CLAUDE_BIN, codexBin: CODEX_BIN });
        if (!fresh) throw new Error('터미널이 없습니다');
        return json(res, 200, { ok: true, action: 'clear', term: terminals.info(fresh) });
      }
      throw new Error('지원하지 않는 컨텍스트 작업입니다');
    }

    if (url.pathname === '/api/term/handoff' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: true, job: await handoffManager.start(String(b.id || '')) });
    }

    if (url.pathname === '/api/handoff/status') {
      const job = handoffManager.get(url.searchParams.get('id'));
      if (!job) return json(res, 404, { error: '세션 전환 작업을 찾지 못했습니다' });
      return json(res, 200, { ok: true, job });
    }

    // ------- Claude ↔ Codex 수동 메시지 브리지 -------
    if (url.pathname === '/api/bridge/send' && req.method === 'POST') {
      const b = await readBody(req);
      const projects = scan();
      const source = findScannedSession(b.sourceProvider, String(b.sourceId || ''), projects);
      const target = findScannedSession(b.targetProvider, String(b.targetId || ''), projects);
      if (!source || !target) throw new Error('세션을 찾지 못했습니다. 목록을 새로고침해 주세요');
      if (source.s.provider === target.s.provider) throw new Error('Claude와 Codex 사이에서만 전달할 수 있습니다');
      const embedded = terminals.list().find(t => t.alive && t.provider === target.s.provider
        && t.sessionId === target.s.id);
      // Codex 의 라이브 표시는 훅이 남긴 파일이고, 세션이 끝나도 최대 하루를 버틴다
      // (그 파일의 pid 는 훅 프로세스의 부모라 생사 판정에 쓸 수 없다). 그대로 믿으면
      // 최근에 한 번이라도 돌린 Codex 세션이 전부 '외부 창에서 실행 중' 이 되어 전달이
      // 통째로 막힌다 - Claude -> Codex 만 안 되던 이유 중 하나다.
      // 그래서 Codex 는 **최근에 갱신된 표시만** 믿는다. Claude 는 pid 로 생사를
      // 확인하므로 예전처럼 그대로 믿는다.
      const liveAt = Number((target.s.live && target.s.live.at) || 0);
      const trustLive = target.s.provider !== 'codex'
        || (liveAt > 0 && Date.now() - liveAt < EXTERNAL_LIVE_MS);
      if (target.s.live && trustLive && !embedded) {
        throw new Error('대상 세션이 외부 창에서 실행 중입니다. 대시보드 터미널로 연 뒤 전달해 주세요');
      }
      const message = await sessionBridge.send({
        source: { provider: source.s.provider, id: source.s.id,
          title: source.s.title, project: source.p.cwd },
        target: { provider: target.s.provider, id: target.s.id,
          title: target.s.title, cwd: target.p.cwd },
        text: b.text,
      });
      if (message.status === 'failed') throw new Error(message.error || '전달하지 못했습니다');
      return json(res, 200, { ok: true, message });
    }

    if (url.pathname === '/api/bridge/status') {
      const message = sessionBridge.get(url.searchParams.get('id'));
      if (!message) return json(res, 404, { error: '브리지 메시지를 찾지 못했습니다' });
      return json(res, 200, { ok: true, message });
    }

    if (url.pathname === '/api/term/new' && req.method === 'POST') {
      const b = await readBody(req);
      if ((b.action === 'resume' || b.action === 'fork') && !SAFE_ID.test(String(b.sessionId || '')))
        throw new Error('세션 ID 가 올바르지 않습니다');
      const t = terminals.create({
        action: b.action || 'new', cwd: b.cwd, sessionId: b.sessionId,
        title: b.title, cols: b.cols, rows: b.rows, model: b.model,
        claudeBin: CLAUDE_BIN,
        provider: b.provider === 'codex' ? 'codex' : 'claude',
        codexBin: CODEX_BIN,
      });
      return json(res, 200, { ok: true, term: terminals.info(t) });
    }

    if (url.pathname === '/api/term/restart' && req.method === 'POST') {
      const b = await readBody(req);
      const t = await terminals.restart(String(b.id || ''),
        { claudeBin: CLAUDE_BIN, codexBin: CODEX_BIN });
      if (!t) throw new Error('터미널이 없습니다');
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
  console.log('종료합니다 - 내장 터미널의 AI 프로세스를 정리합니다.');
  terminals.killAll();
  sessionBridge.close();
  handoffManager.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// 중복 실행에서도 Node의 Unhandled 'error' 스택을 그대로 내보내지 않는다.
// 기존 프로세스에는 내장 터미널이 있을 수 있으므로 절대 종료하지 않는다.
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    const addr = `http://${HOST}:${PORT}`;
    console.log(`이미 대시보드가 실행 중입니다: ${addr}`);
    console.log('기존 서버와 내장 터미널은 그대로 유지합니다.');
    sessionBridge.close();
    handoffManager.close();
    if (!process.env.CC_LAUNCHER_NO_OPEN) {
      try { spawn('cmd.exe', ['/c', 'start', '', addr], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
    return process.exit(0);
  }
  console.error('서버를 시작하지 못했습니다:', (err && err.message) || err);
  sessionBridge.close();
  handoffManager.close();
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const addr = `http://${HOST}:${PORT}`;
  console.log('AI Coding Session Launcher');
  console.log(`  주소     : ${addr}`);
  console.log(`  claude   : ${CLAUDE_BIN}`);
  console.log(`  terminal : ${WT_BIN || 'Windows Terminal 없음 → PowerShell 창 사용'}`);
  console.log(`  세션 경로: ${PROJECTS_DIR}`);
  console.log(`  실행 상태: ${LIVE_DIR}`);
  console.log('  내장 터미널: node-pty (ConPTY) - 브라우저를 닫아도 세션은 계속 살아 있습니다');
  console.log('\n창을 닫으면 서버가 종료됩니다. (Ctrl+C 로 종료 - 내장 터미널도 함께 정리)');
  reapPasteDir();
  if (!process.env.CC_LAUNCHER_NO_OPEN) {
    spawn('cmd.exe', ['/c', 'start', '', addr], { detached: true, stdio: 'ignore' }).unref();
  }
});
