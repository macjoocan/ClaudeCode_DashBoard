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
// PTY 출력을 브라우저로 내보내기 전에 모으는 시간.
//
// 보통 CLI 는 한 프레임(16ms)이면 충분하다. 그런데 제자리에 덧그리는 TUI 는 화면 전체를
// 계속 새로 그리므로, 60fps 로 반영하면 눈에 어지럽고 렌더 비용도 그만큼 든다.
// TUI 에 60fps 는 과하다 - 사람이 읽는 화면이지 게임이 아니다. 바이트는 그대로 모이므로
// 정보가 빠지지는 않고, 한 번에 반영되는 양만 커진다.
const FLUSH_MS = 16;
const FLUSH_MS_TUI = 60;        // 제자리에 덧그리는 쪽(Codex)
// 이어하기 직후 쏟아지는 기록 재생을 화면에 흘리지 않고 붙잡아 두는 구간.
//
// 실측: Codex 로 세션을 이어하면 8초 동안 **2.5MB(덩어리 3만 개)** 를 쏟는다. 그동안의
// 대화를 처음부터 다시 출력하는 것이다. 맨 터미널에서도 똑같이 하므로 Codex 동작이지만,
// 그대로 브라우저에 흘리면 수만 줄이 지나가며 "무한 스크롤" 로 보인다. 열 때마다 반복된다.
//
// 그래서 조용해질 때까지 **보내지 않고 모으기만** 하고, 끝나면 화면을 비운 뒤 다시
// 그리게 시켜 **현재 화면 한 장만** 남긴다. 기록은 Codex 안에 그대로 있다.
// 조용한 시간으로 재면 안 된다 - 재생 중간에 1초 넘는 틈이 있어서 끝난 줄 알고 풀면
// 나머지가 그대로 쏟아진다(실측: 12초·18초에 1000줄이 새어 나왔다).
// 유입 **속도**로 가른다. 재생은 200~300KB/s, 대기 중 스피너는 10KB/s 안쪽이라 확연히 갈린다.
const HOLD_RATE_BPS = 20000;    // 1초에 이보다 적게 오면 '재생 아님' 으로 센다
const HOLD_CALM_TICKS = 3;      // 그런 초가 연달아 이만큼이면 끝난 것으로 본다
const HOLD_MAX_MS = 40000;      // 아무리 길어도 여기서는 푼다
// 재생이 시작되기 전에 붙잡기가 끝나 버리는 것을 막는다.
//
// 실측: 붙잡은 것이 576 바이트뿐이고 재생 1000줄은 그 뒤에 그대로 흘러갔다.
// Codex 가 뜨는 동안은 조용하니 '다 끝났다' 로 본 것이다. 이만큼 쏟아진 적이
// 있어야 비로소 '끝났는지' 를 따진다. 재생이 없는 세션은 아래 MAX 로 풀린다.
const HOLD_MIN_BYTES = 64 * 1024;

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
    lastRealAt: Date.now(),   // 스피너를 뺀 '진짜' 마지막 출력 시각
    paintRing: [],
    exitCode: null, exitedAt: null,
    cols: p.cols, rows: p.rows,
    proc: p,
    buf: '',
    restarts: 0,
    clients: new Set(),
  };
  terms.set(id, t);
  wire(t, p);
  // 이어하기로 띄운 Codex 는 기록 재생이 뒤따른다. 그 구간을 붙잡는다.
  if (isCodex && (action === 'resume' || action === 'fork')) startHold(t);
  return t;
}

// 재생이 끝날 때까지 출력을 붙잡았다가, **모아둔 것을 통째로** 한 번에 내보낸다.
//
// 예전에는 모아둔 재생을 버리고 화면 한 장만 다시 그리게 했다. 그랬더니 되짚을
// 것이 하나도 남지 않아서 마우스 휠이 아무 일도 하지 않았다. 재생 내용은 옛 화면
// 조각이 아니라 진짜 대화 기록이다(실측: 이어하기 뒤 스크롤백 1000줄이 전부 읽을
// 수 있는 대화였다). 버릴 것이 아니라 스크롤백에 남겨야 하는 것이다.
//
// 다만 흘려보내면 그리는 과정이 그대로 보인다 - 그게 '끝없이 스크롤되는' 증상이다.
// 그래서 조용해질 때까지 모았다가 한 덩어리로 보낸다. 브라우저는 그 동안 패인을
// 가려 두고 다 쓴 뒤에 맨 아래를 보여준다.
function startHold(t) {
  t.hold = { at: Date.now(), bytes: 0, buf: '' };
  send(t, { t: 'o', d: String.fromCharCode(13, 10)
    + '  이어하기 기록을 정리하는 중입니다…'
    + String.fromCharCode(13, 10) });
  t.hold.seen = 0;
  t.hold.calm = 0;
  t.holdTimer = setInterval(() => {
    if (!t.hold || t.exitCode != null) return endHold(t);
    const got = t.hold.bytes - t.hold.seen;     // 지난 1초 동안 들어온 양
    t.hold.seen = t.hold.bytes;
    t.hold.calm = got < HOLD_RATE_BPS ? t.hold.calm + 1 : 0;
    const spent = Date.now() - t.hold.at;
    const started = t.hold.bytes >= HOLD_MIN_BYTES;   // 재생이 실제로 시작됐나
    if ((started && t.hold.calm >= HOLD_CALM_TICKS) || spent >= HOLD_MAX_MS) endHold(t);
  }, 1000);
  if (t.holdTimer.unref) t.holdTimer.unref();
}

function endHold(t) {
  if (t.holdTimer) { clearInterval(t.holdTimer); t.holdTimer = null; }
  if (!t.hold) return;
  const replay = t.hold.buf;
  t.hold = null;
  // reset 은 보내지 않는다. 클라이언트의 term.reset() 은 스크롤백까지 지운다 -
  // 되짚을 기록을 없애는 것이 바로 그것이었다.
  // repaint 는 하지 않는다. 앱에게 다시 그리라고 시키면 Codex 는 화면이 아니라
  // **기록 전체를 처음부터 다시 그린다**(실측: 재생 뒤 950줄이 또 밀려 내려갔다).
  // 모아둔 재생의 마지막 부분이 이미 지금 화면이다.
  if (replay) send(t, { t: 'replay', d: replay });
}

// Codex 의 TUI 는 대기 중에도 점자(U+2800~U+28FF) 스피너를 매 프레임 다시 그린다.
// "바이트가 흘렀다 = 아직 작업 중" 으로 보면 이 터미널은 영원히 조용해지지 않아서
// 메시지 전달도 AI 전환도 시작되지 않는다. ANSI 제어열과 스피너를 걷어내고,
// 남은 글자가 직전과 똑같으면(같은 화면 다시 그리기) 멈춘 것으로 센다.
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Za-z0-9]|\u001b[=>]/g;
const SPINNER_RE = /[\u2800-\u28ff]/g;
const CTRL_RE = /[\u0000-\u001f\u007f]/g;

function paintOf(d) {
  return String(d).replace(ANSI_RE, '').replace(SPINNER_RE, '')
    .replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
}

// 이 출력이 화면을 실제로 바꿨는지.
//
// 직전 것 하나만 비교하면 두 프레임을 번갈아 그리는 애니메이션(X,Y,X,Y)에 계속
// 속는다. 최근 몇 개를 들고 그중 하나와 같으면 새 내용이 아닌 것으로 본다.
//
// 한계: PTY 덩어리 경계는 타이밍에 따라 갈리므로, 한 프레임이 여러 덩어리로 쪼개져
// 매번 다르게 잘리면 여전히 '새 내용' 으로 잡힐 수 있다. 그때는 예전처럼 전달이
// 늦어질 뿐이고, 잘못된 시점에 끼어들지는 않는다(안전한 쪽으로 틀린다).
const PAINT_RING = 4;
function changesScreen(t, d) {
  const paint = paintOf(d);
  if (!paint) return false;                 // 스피너·커서 이동뿐
  const ring = t.paintRing || (t.paintRing = []);
  if (ring.indexOf(paint) >= 0) return false;
  ring.push(paint);
  if (ring.length > PAINT_RING) ring.shift();
  return true;
}

// PTY 하나를 배선한다. create 와 restart 가 같이 쓴다.
//
// `t.proc !== p` 검사가 핵심이다. 재시작하면 옛 프로세스의 onExit 이 kill 직후가
// 아니라 **새 프로세스를 꽂은 뒤에** 도착할 수 있다. 그때 걸러내지 않으면 방금 띄운
// 터미널이 "종료됨"으로 표시된다.
function wire(t, p) {
  p.onData(d => {
    if (t.proc !== p) return;
    t.buf += d;
    if (t.buf.length > SCROLLBACK) t.buf = t.buf.slice(-SCROLLBACK);
    t.lastAt = Date.now();
    if (changesScreen(t, d)) t.lastRealAt = t.lastAt;

    // 덩어리마다 WS 메시지를 하나씩 보내지 않는다.
    //
    // 실측: Codex 가 그리는 중일 때 **초당 1100개** 덩어리가 나온다. 동기화 구간
    // (ESC[?2026h … ESC[?2026l)과 커서 모양(ESC[0 q)을 프레임마다 쏘기 때문인데,
    // 길이 1짜리 덩어리도 수백 개다. 그걸 그대로 하나씩 보내면 브라우저가 JSON 파싱과
    // xterm write 를 초당 천 번 하느라 화면이 밀린다 - 스크롤이 끝없이 도는 것처럼 보인다.
    //
    // 한 프레임(16ms) 동안 모았다가 한 번에 보낸다. 바이트는 그대로고 순서도 그대로다.
    // 이어하기 재생 구간이면 모으기만 한다. 끝나면 한 덩어리로 내보낸다.
    if (t.hold) {
      t.hold.bytes += d.length;
      t.hold.buf += d;
      if (t.hold.buf.length > SCROLLBACK) t.hold.buf = t.hold.buf.slice(-SCROLLBACK);
      return;
    }

    t.out = (t.out || '') + d;
    if (!t.flush) {
      t.flush = setTimeout(() => {
        t.flush = null;
        const chunk = t.out; t.out = '';
        if (chunk) send(t, { t: 'o', d: chunk });
      }, repaintsInPlace(t) ? FLUSH_MS_TUI : FLUSH_MS);
      if (t.flush.unref) t.flush.unref();
    }
  });

  p.onExit(({ exitCode }) => {
    if (t.proc !== p) return;
    t.exitCode = exitCode == null ? 0 : exitCode;
    t.exitedAt = Date.now();
    send(t, { t: 'x', code: t.exitCode });
  });
}

// 같은 자리에서 CLI 프로세스만 갈아끼운다.
//
// 터미널 id 를 그대로 쓰기 때문에 패인 위치·크기·탭 순서가 유지된다.
// 세션 ID 를 확보한 상태면 `--resume` 으로 대화를 이어서 켠다. 세션 기록은 파일에
// 계속 쌓이고 있으므로 재시작해도 대화가 남는다. 다만 **응답 중이던 내용은 사라진다.**
function restart(id, { claudeBin, codexBin }, freshStart) {
  const t = terms.get(id);
  if (!t) return Promise.resolve(null);

  const isCodex = t.provider === 'codex';
  const bin = isCodex ? codexBin : claudeBin;
  if (!bin) return Promise.reject(new Error(isCodex ? 'codex 를 찾을 수 없습니다' : 'claude 를 찾을 수 없습니다'));

  const dying = t.proc;
  const wait = new Promise(resolve => {
    if (t.exitCode != null) return resolve();
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { dying.onExit(fin); } catch { fin(); }
    try { dying.kill(); } catch { fin(); }
    // 안 죽어도 계속 간다. 여기서 멈추면 버튼이 먹통이 된다.
    setTimeout(fin, 3000);
  });

  return wait.then(() => {
    // 이어서 켤 세션이 있는지 본다. 시작 직후 죽어 세션 ID 를 못 받았으면 새로 시작한다.
    const sid = freshStart ? null : t.sessionId;
    const action = sid ? 'resume' : 'new';
    const args = isCodex
      ? require('./codex.js').codexArgs(action, sid)
      : claudeArgs(action, sid);
    const p = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: t.cols, rows: t.rows,
      cwd: t.cwd,
      env: cleanEnv(),
      useConpty: true,
    });

    t.proc = p;
    t.pid = p.pid;
    t.action = action;
    t.sessionId = sid;
    t.exitCode = null;
    t.exitedAt = null;
    t.startedAt = Date.now();
    t.lastAt = Date.now();
    t.lastRealAt = Date.now();
    t.paintRing = [];
    t.buf = '';                       // 옛 프로세스의 출력은 버린다
    t.restarts = (t.restarts || 0) + 1;
    wire(t, p);

    send(t, { t: 'reset' });          // 붙어 있는 화면을 비우게 한다
    send(t, { t: 'm', info: info(t) });
    return t;
  });
}

// 기존 패인과 provider는 유지하고 저장된 대화는 이어받지 않는 새 CLI를 띄운다.
// provider마다 다른 /clear 계열 명령에 의존하지 않아 같은 의미를 보장한다.
function fresh(id, bins) { return restart(id, bins, true); }

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
// ~/.codex/.cc-launcher-live/<sessionId>.json 에서 온다. pid 로 역인덱스를 만든다.
// list() 가 터미널마다 부르므로 1초 메모한다.
//
// 주의: 이 경로는 Codex 가 우리 훅을 실제로 실행해 줄 때만 동작한다. 훅이 안 돌면
// (버전이 바뀌었거나 hooks.json 이 신뢰 목록에서 빠졌거나) 파일 자체가 안 생기므로
// 아래 codexSessionByCwd() 로 넘어간다.
let codexLiveMemo = { at: 0, byPid: new Map() };
function codexLiveInfo(t) {
  const now = Date.now();
  if (now - codexLiveMemo.at > 1000) {
    const byPid = new Map();
    try {
      for (const [sessionId, v] of require('./codex.js').liveMap()) {
        if (!v || !v.pid) continue;
        const key = Number(v.pid);
        const prev = byPid.get(key);
        // 강제 종료로 남은 상태 파일은 최대 하루를 버틴다. 그 사이 Windows 가 같은
        // PID 를 재사용하면 한 pid 를 여러 파일이 주장한다. 가장 최근 것만 남긴다
        // (readdir 순서로 이기게 두면 죽은 세션이 이길 수 있다).
        if (prev && Number(prev.at || 0) >= Number(v.at || 0)) continue;
        byPid.set(key, { sessionId, status: v.status || 'idle', name: null, at: Number(v.at || 0) });
      }
    } catch {}
    codexLiveMemo = { at: now, byPid };
  }
  const hit = codexLiveMemo.byPid.get(Number(t.pid));
  if (!hit) return null;
  // 이 터미널이 켜지기 전에 쓰인 기록이면 PID 재사용으로 걸린 남의 세션이다.
  // 그대로 받으면 패인이 죽은 세션에 영구히 묶인다(전달·AI 전환이 엉뚱한 곳으로 간다).
  if (hit.at && hit.at < Number(t.startedAt || 0)) return null;
  return hit;
}

// 훅이 안 돌면 Codex 터미널이 자기 sessionId 를 영영 못 찾고, 그러면 AI 전환도
// 메시지 전달도 시작조차 못 한다(둘 다 sessionId 로 대상을 맞춘다).
// 대안: 우리가 띄운 폴더에서 이 터미널이 켜진 뒤에 갱신된 Codex 세션 중
// 가장 최근 것을 이 터미널의 세션으로 본다. Codex 는 첫 메시지가 오가야 세션을
// 만들므로, 그 전까지 null 인 것은 기존과 같다.
function sameDir(a, b) {
  const norm = v => String(v || '')
    .replace(/[\u002f\u005c]+$/, '')
    .replace(/\u002f/g, String.fromCharCode(92))
    .toLowerCase();
  const x = norm(a);
  return !!x && x === norm(b);
}

// 같은 폴더에 Codex 터미널을 둘 이상 띄우면 셋 다 '가장 최근 세션' 으로 몰린다.
// 그러면 한 세션 ID 를 여러 패인이 자기 것이라 주장해서 전달·AI 전환이 엉뚱한
// 패인으로 가고, ID 복사도 남의 것을 준다. 이미 임자가 있는 세션은 건너뛴다.
function claimedByOther(id, self) {
  for (const other of terms.values()) {
    if (other === self) continue;
    if (other.exitCode == null && other.sessionId === id) return true;
  }
  return false;
}

let codexRowMemo = { at: 0, rows: [] };
function codexSessionByCwd(t) {
  const now = Date.now();
  if (now - codexRowMemo.at > 2000) {
    let rows = [];
    try { rows = require('./codex.js').sessions(); } catch {}
    codexRowMemo = { at: now, rows };
  }
  let best = null;
  for (const r of codexRowMemo.rows) {
    if (!r || !sameDir(r.cwd, t.cwd)) continue;
    // 이 터미널이 켜진 **뒤에 만들어진** 세션만 본다. updated 만 보면 남이 다른
    // 창에서 켜 둔 옛 세션도 걸려서, 패인이 모르는 사람 대화에 묶인다.
    const born = Number(r.createdAt) || Number(r.mtime) || 0;
    if (!(born >= Number(t.startedAt))) continue;
    if (claimedByOther(r.id, t)) continue;                     // 옆 패인이 이미 쓰는 세션
    if (!best || Number(r.mtime) > Number(best.mtime)) best = r;
  }
  return best ? best.id : null;
}

function info(t) {
  // provider 로 갈라야 한다. Codex 터미널이 liveInfo() 를 타면 (1) 자기 sessionId 를
  // 영영 못 찾아 카드와 연결되지 않고, (2) Windows 의 PID 재사용으로 죽은 Claude
  // 세션의 상태 파일을 주워 그 Claude 카드가 Codex 터미널을 가리키게 된다.
  const live = t.exitCode != null ? null
    : (t.provider === 'codex' ? codexLiveInfo(t) : liveInfo(t.pid));
  if (live && live.sessionId) t.sessionId = live.sessionId;  // 컨텍스트 초기화 뒤 바뀐 ID도 반영
  else if (!t.sessionId && t.provider === 'codex' && t.exitCode == null) {
    const guess = codexSessionByCwd(t);
    if (guess) t.sessionId = guess;
  }
  return {
    id: t.id, title: t.title, cwd: t.cwd, action: t.action,
    provider: t.provider || 'claude',
    sessionId: t.sessionId, pid: t.pid,
    cols: t.cols, rows: t.rows,
    startedAt: t.startedAt, lastAt: t.lastAt, lastRealAt: t.lastRealAt || t.lastAt,
    alive: t.exitCode == null,
    exitCode: t.exitCode, exitedAt: t.exitedAt,
    restarts: t.restarts || 0,
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
  t.lastRealAt = t.lastAt;
  return true;
}

function resize(id, cols, rows) {
  const t = terms.get(id);
  if (!t || t.exitCode != null) return false;
  const c = Math.max(40, Math.min(400, Math.floor(cols) || t.cols));
  const r = Math.max(10, Math.min(200, Math.floor(rows) || t.rows));
  if (c === t.cols && r === t.rows) return true;
  try {
    t.proc.resize(c, r); t.cols = c; t.rows = r;
    // 여기서 화면을 비우지 않는다. 한때 그렇게 했는데, 리사이즈로 Codex 가 새로 뱉는
    // 출력이 0바이트인 경우가 있어(실측) 빈 화면만 남았다. 쌓임 자체는 Codex 패인의
    // 스크롤백을 0으로 둬서 막는다 - 밀려날 곳이 없으면 쌓이지도 않는다.
    return true;
  } catch { return false; }
}

// 화면을 처음부터 다시 그리게 시킨다.
//
// 왜 필요한가: Codex TUI 는 **대체화면(alt screen)을 쓰지 않는다**(실측: ?1049h 가 0).
// [2J 로 한 번 지운 뒤 [행;열H 절대좌표로 제자리에 덧그린다. 그래서 서버가 모아둔
// 바이트 로그를 재접속 때 그대로 재생하면, 그동안의 **모든 프레임이 차례로 다시
// 그려져 화면이 위에서 아래로 주르륵 쌓인다**. 사용자가 본 그 증상이다.
//
// 바이트 로그로는 "지금 화면" 을 복원할 수 없다(그러려면 서버가 터미널 에뮬레이터를
// 들고 있어야 하는데 이 프로젝트는 새 의존성을 금지한다). 대신 **앱에게 다시 그리라고
// 시킨다** - 크기를 한 칸 줄였다 되돌리면 SIGWINCH 가 가고, Codex 는 현재 화면 전체를
// 새로 뱉는다(실측: 버퍼를 비우고 크기를 툭 건드리니 현재 화면이 그대로 재구성됐다).
//
// 클라이언트에는 알리지 않는다. 브라우저 xterm 의 크기는 그대로고 PTY 도 제자리로
// 돌아오므로 둘은 계속 같은 크기다 - 리사이즈가 되돌아오는 되먹임이 생기지 않는다.
function repaint(id) {
  const t = terms.get(id);
  if (!t || t.exitCode != null) return false;
  const c = t.cols, r = t.rows;
  try {
    t.proc.resize(Math.max(40, c - 1), r);
    setTimeout(function () { try { t.proc.resize(c, r); } catch {} }, 60);
    return true;
  } catch { return false; }
}

// 제자리에 덧그리는 TUI 인가. 이런 앱은 바이트 로그 재생이 의미가 없다.
// 지금은 Codex 뿐이다. Claude Code 는 로그처럼 아래로 덧붙이므로 재생이 맞다
// (스크롤백이 그대로 살아나야 이전 대화를 볼 수 있다).
function repaintsInPlace(t) { return t && t.provider === 'codex'; }

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
  if (t.flush) { clearTimeout(t.flush); t.flush = null; }
  if (t.holdTimer) { clearInterval(t.holdTimer); t.holdTimer = null; }
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
    if (repaintsInPlace(t) && t.buf) {
      // 다시 그리라고 시키지 않는다. Codex 는 그 말을 들으면 기록 전체를 처음부터
      // 다시 그리고, 그게 새로고침할 때마다 화면이 쓸려 내려가던 원인이었다.
      // reset 도 보내지 않는다 - 클라이언트의 term.reset() 은 스크롤백을 지운다.
      // 우리가 들고 있는 출력을 그대로 넘긴다. 브라우저는 가린 채로 한 번에 쓴다.
      ws.send(JSON.stringify({ t: 'replay', d: t.buf }));
    } else if (t.buf) {
      // 죽은 터미널은 다시 그려줄 주체가 없다. 마지막 모습이라도 보여준다.
      ws.send(JSON.stringify({ t: 'o', d: t.buf, replay: true }));
    }
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

module.exports = { create, restart, fresh, list, get, info, write, resize, repaint, repaintsInPlace,
  kill, close, attach, killAll,
  // 아래 둘은 테스트용 - paintOf/sameDir 는 순수 함수, _terms 는 등록된 터미널 맵이다.
  paintOf, sameDir, _terms: terms };
