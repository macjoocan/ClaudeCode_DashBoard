const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runHook(payload, env) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'codex-hook.js')], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('훅은 받은 JSON 을 그대로 POST 한다', async () => {
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => { got = JSON.parse(b); res.writeHead(200); res.end('{}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/hook`;
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));

  runHook({ hook_event_name: 'PreToolUse', session_id: 'aaa', cwd: 'D:\\x', tool_name: 'Bash' },
          { CCL_HOOK_URL: url, CCL_LIVE_DIR: live });

  await new Promise(r => setTimeout(r, 300));
  srv.close();
  assert.equal(got.hook_event_name, 'PreToolUse');
  assert.equal(got.session_id, 'aaa');
  assert.equal(got.provider, 'codex');     // 훅이 provider 를 붙인다
});

test('SessionStart 는 실행 상태 파일을 만든다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  runHook({ hook_event_name: 'SessionStart', session_id: 'bbb', cwd: 'D:\\x' },
          { CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook', CCL_LIVE_DIR: live });
  const f = path.join(live, 'bbb.json');
  assert.ok(fs.existsSync(f));
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(j.sessionId, 'bbb');
  assert.equal(j.status, 'idle');
});

test('UserPromptSubmit 은 busy, Stop 은 idle 로 바꾼다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  const env = { CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook', CCL_LIVE_DIR: live };
  runHook({ hook_event_name: 'SessionStart', session_id: 'ccc', cwd: 'D:\\x' }, env);
  runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'ccc', cwd: 'D:\\x' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'ccc.json'), 'utf8')).status, 'busy');
  runHook({ hook_event_name: 'Stop', session_id: 'ccc', cwd: 'D:\\x' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'ccc.json'), 'utf8')).status, 'idle');
});

test('SessionEnd 는 실행 상태 파일을 지운다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  const env = { CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook', CCL_LIVE_DIR: live };
  runHook({ hook_event_name: 'SessionStart', session_id: 'ddd', cwd: 'D:\\x' }, env);
  runHook({ hook_event_name: 'SessionEnd', session_id: 'ddd', cwd: 'D:\\x' }, env);
  assert.ok(!fs.existsSync(path.join(live, 'ddd.json')));
});

test('서버가 죽어 있어도 exit 0 이고 stdout 은 비어 있다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  const out = runHook({ hook_event_name: 'PreToolUse', session_id: 'eee', cwd: 'D:\\x' },
                      { CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook', CCL_LIVE_DIR: live });
  assert.equal(out, '');
});

test('stdin 이 깨진 JSON 이어도 exit 0', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'codex-hook.js')], {
    input: '{깨짐', encoding: 'utf8',
    env: { ...process.env, CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook' },
  });
  assert.equal(out, '');
});
