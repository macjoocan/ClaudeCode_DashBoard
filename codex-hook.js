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
  let u;
  try { u = new URL(HOOK_URL); } catch { return done(); }
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length,
               Origin: `http://${u.host}` },
    timeout: 2000,
  }, res => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(data);
}

let body;
try { body = JSON.parse(readStdin()); } catch { process.exit(0); }
if (!body || typeof body !== 'object') process.exit(0);

body.provider = 'codex';
updateLive(body);
post(body, () => process.exit(0));
