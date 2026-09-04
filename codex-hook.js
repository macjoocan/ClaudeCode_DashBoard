// Codex 훅이 실행하는 다리. stdin 으로 훅 JSON 을 받아 런처로 POST 하고
// 실행 상태 파일을 갱신한다.
//
// Codex 는 type:"http" 훅을 지원하지 않는다 (핸들러는 command 와 mcp_tool 뿐).
// 그래서 Claude 쪽처럼 프로세스 없이 갈 수가 없다. hooks.json 에서
// "async": true 로 걸어 이 프로세스가 턴을 막지 않게 한다.
//
// 무슨 일이 있어도 exit 0 이어야 한다. 0 이 아니면 Codex 가 턴을 막는다.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOOK_URL = process.env.CCL_HOOK_URL || 'http://127.0.0.1:7788/api/hook';
const LIVE_DIR = process.env.CCL_LIVE_DIR
  || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.cc-launcher-live');

// 이벤트별로 실행 상태를 어떻게 바꿀지
const STATUS = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  PostToolUse: 'busy',
  PermissionRequest: 'waiting',
  Stop: 'idle',
  Interrupt: 'idle',
};

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function updateLive(body) {
  const id = String(body.session_id || '');
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return;
  const file = path.join(LIVE_DIR, id + '.json');
  try {
    if (body.hook_event_name === 'SessionEnd') { fs.rmSync(file, { force: true }); return; }
    const status = STATUS[body.hook_event_name];
    if (!status) return;
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      sessionId: id, status, cwd: body.cwd || null,
      pid: process.ppid, at: Date.now(),
    }), 'utf8');
  } catch {}
}

function post(body, done) {
  // done() 은 정확히 한 번만 — 아래 여러 이벤트가 겹쳐서 걸려도 안전하게.
  let fired = false;
  const finish = () => {
    if (fired) return;
    fired = true;
    clearTimeout(hardDeadline);
    done();
  };

  // timeout: 2000 은 소켓 "비활동" 타임아웃이라 활동이 있으면 계속 리셋된다.
  // 서버가 응답을 끝내지 않고 몇 바이트씩 계속 흘려보내면(trickle) 그 타임아웃은
  // 영원히 안 걸릴 수 있다. 그래서 어떤 소켓 이벤트가 오가든 상관없이 무조건
  // 끝내는 하드 데드라인을 따로 둔다. unref() 하면 안 된다 — 반드시 발화해야 한다.
  //
  // finish() 를 부를 수 있는 첫 코드(바로 아래 URL 파싱 실패 케이스)보다 반드시
  // 먼저 선언해야 한다 — 그렇지 않으면 finish() 안의 clearTimeout(hardDeadline) 이
  // hardDeadline 이 아직 초기화되기 전(TDZ) 에 실행되어 ReferenceError 로 죽는다.
  const hardDeadline = setTimeout(finish, 3000);

  let u;
  try { u = new URL(HOOK_URL); } catch { return finish(); }
  const data = Buffer.from(JSON.stringify(body), 'utf8');

  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length,
               Origin: `http://${u.host}` },
    timeout: 2000,
  }, res => {
    res.resume();
    res.on('end', finish);
    res.on('error', finish);   // 스트림 'error' 를 처리 안 하면 프로세스가 죽는다
  });
  req.on('error', finish);
  req.on('timeout', () => { req.destroy(); finish(); });
  req.on('close', finish);     // 위 이벤트들이 다 안 잡아도 마지막 안전망
  req.end(data);
}

let body;
try { body = JSON.parse(readStdin()); } catch { process.exit(0); }
if (!body || typeof body !== 'object') process.exit(0);

body.provider = 'codex';
updateLive(body);
post(body, () => process.exit(0));
