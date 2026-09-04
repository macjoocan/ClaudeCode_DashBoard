const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
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

// execFileSync 는 부모 프로세스의 이벤트 루프를 완전히 멈춘다 — 같은 프로세스
// 안에 살아있는 목(mock) 서버를 쓰는 테스트에서는 그동안 서버의 콜백(타이머 포함)이
// 전혀 돌지 못한다. 트리클(조금씩 흘려보내며 절대 끝내지 않는) 서버처럼 서버 쪽
// 타이밍이 실제로 살아 움직여야 검증되는 시나리오는 execFileSync 로는 제대로 못
// 테스트한다 — 그래서 여기서만 non-blocking spawn 을 쓴다.
function runHookAsync(payload, env, killAfterMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'codex-hook.js')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    // killAfterMs 는 회귀(하드 데드라인이 사라지는 경우) 로부터 테스트 스위트
    // 자체가 영원히 매달리는 것을 막는 안전망일 뿐, 정상 동작 여부는 이 타이머가
    // 아니라 아래 assert 들이 판단한다.
    const safety = killAfterMs ? setTimeout(() => child.kill('SIGKILL'), killAfterMs) : null;
    child.on('exit', (code, signal) => {
      if (safety) clearTimeout(safety);
      resolve({ code, signal, stdout, stderr, elapsed: Date.now() - start });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
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

test('서버가 트리클만 하고 절대 끝내지 않아도 하드 데드라인으로 종료된다', async () => {
  const intervals = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');                         // 응답을 절대 끝내지 않는다
      intervals.push(setInterval(() => { try { res.write('.'); } catch {} }, 500));
    });
    res.on('close', () => intervals.forEach(clearInterval));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/hook`;
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));

  // 안전망: 하드 데드라인이 아예 없다면(회귀) 이 테스트 자체가 영원히 매달리지
  // 않도록 spawn 이 죽지 않을 경우를 대비해 강제 kill 타이머를 둔다.
  const result = await runHookAsync(
    { hook_event_name: 'PreToolUse', session_id: 'trickle', cwd: 'D:\\x' },
    { CCL_HOOK_URL: url, CCL_LIVE_DIR: live },
    8000,
  );

  intervals.forEach(clearInterval);
  srv.close();

  assert.equal(result.stdout, '');
  assert.equal(result.code, 0);
  // 하드 데드라인은 ~3s. 소켓 타임아웃(2s)보다 위, 트리클이 "영원히" 계속되는 것보다는 훨씬 아래.
  assert.ok(result.elapsed < 5000, `expected hard-deadline exit well under 5s, took ${result.elapsed}ms`);
  assert.ok(result.elapsed > 2000, `expected the hard deadline (not the 2s socket timeout) to be what fired, took ${result.elapsed}ms`);
});

test('CCL_HOOK_URL 이 깨진 URL 이어도 exit 0 이고 stdout 은 비어 있다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'codex-hook.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'badurl', cwd: 'D:\\x' }),
    encoding: 'utf8',
    env: { ...process.env, CCL_HOOK_URL: 'not a valid url::::', CCL_LIVE_DIR: live },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
