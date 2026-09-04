const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-hooks-'));
  delete require.cache[require.resolve('../codex-hooks-install.js')];
  process.env.CODEX_HOME = dir;
  return { dir, mod: require('../codex-hooks-install.js') };
}

test('install 은 12개 이벤트를 전부 건다', () => {
  const { dir, mod } = fresh();
  const r = mod.install();
  assert.equal(r.ok, true);
  assert.equal(r.installed.length, 12);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.ok(j.hooks.PreToolUse);
  assert.equal(j.hooks.PreToolUse[0].hooks[0].type, 'command');
});

test('SessionEnd 를 뺀 나머지는 async 다', () => {
  const { dir, mod } = fresh();
  mod.install();
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.equal(j.hooks.PreToolUse[0].hooks[0].async, true);
  assert.equal(j.hooks.SessionEnd[0].hooks[0].async, undefined);
  assert.ok(j.hooks.SessionEnd[0].hooks[0].timeout <= 3);
});

test('status 는 설치 전후를 구분한다', () => {
  const { mod } = fresh();
  assert.equal(mod.status().installed.length, 0);
  mod.install();
  assert.equal(mod.status().installed.length, 12);
});

test('uninstall 은 우리 것만 지우고 남의 훅은 둔다', () => {
  const { dir, mod } = fresh();
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'other.exe' }] }] },
  }), 'utf8');
  mod.install();
  mod.uninstall();
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.equal(j.hooks.PreToolUse.length, 1);
  assert.equal(j.hooks.PreToolUse[0].hooks[0].command, 'other.exe');
});

test('install 은 기존 파일을 백업한다', () => {
  const { dir, mod } = fresh();
  fs.writeFileSync(path.join(dir, 'hooks.json'), '{"hooks":{}}', 'utf8');
  const r = mod.install();
  assert.ok(r.backup);
  assert.ok(fs.existsSync(r.backup));
});

test('install 은 깨진 기존 파일에 던지고 덮어쓰지 않는다', () => {
  const { dir, mod } = fresh();
  fs.writeFileSync(path.join(dir, 'hooks.json'), '{깨짐', 'utf8');
  assert.throws(() => mod.install());
  assert.equal(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), '{깨짐');
});

// --- URL 스레딩(포트 오버라이드) ---

test('install 에 url 을 넘기면 명령에 그 url 이 박힌다', () => {
  const { dir, mod } = fresh();
  const url = 'http://127.0.0.1:9000/api/hook';
  mod.install(url);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.ok(j.hooks.PreToolUse[0].hooks[0].command.includes(url));
});

test('url 이 박혀 있어도 isOurs/uninstall 은 여전히 우리 항목으로 인식한다', () => {
  const { dir, mod } = fresh();
  const url = 'http://127.0.0.1:9000/api/hook';
  mod.install(url);
  assert.equal(mod.status().installed.length, 12);
  const r = mod.uninstall();
  assert.equal(r.removed.length, 12);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.equal(Object.keys(j.hooks).length, 0);
});

// --- Fix Round 1 ---

// Finding 1: 최상위가 배열/null/문자열/숫자면 install() 은 던져야 하고,
// 원본 파일은 바이트 단위로 그대로 남아야 한다 (조용한 무동작 금지).
for (const [label, raw] of [['배열([])', '[]'], ['null', 'null'], ['문자열', '"x"'], ['숫자', '123']]) {
  test(`install 은 최상위가 ${label} 인 hooks.json 에 던지고 덮어쓰지 않는다`, () => {
    const { dir, mod } = fresh();
    fs.writeFileSync(path.join(dir, 'hooks.json'), raw, 'utf8');
    assert.throws(() => mod.install());
    assert.equal(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), raw);
  });
}

// Finding 2: url 에 큰따옴표가 섞이면 명령 문자열이 깨질 수 있으니 install() 이
// 거부해야 한다. 검증이 파일을 건드리기 전에 일어나므로 기존 파일도 그대로다.
test('큰따옴표가 든 url 은 install() 이 거부하고 아무것도 쓰지 않는다', () => {
  const { dir, mod } = fresh();
  fs.writeFileSync(path.join(dir, 'hooks.json'), '{"hooks":{}}', 'utf8');
  assert.throws(() => mod.install('http://127.0.0.1:9000/"; calc; "'));
  assert.equal(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), '{"hooks":{}}');
});

test('URL 로 파싱되지 않는 url 도 install() 이 거부한다', () => {
  const { mod } = fresh();
  assert.throws(() => mod.install('not a url::::'));
});

// Finding 3: command 가 codex-hook.js 를 언급하더라도 우리 MARK(statusMessage)
// 가 없으면 남의 훅으로 보고 install()/uninstall() 모두 건드리면 안 된다.
test('codex-hook.js 를 언급하지만 MARK 가 없는 남의 훅은 install/uninstall 을 견딘다', () => {
  const { dir, mod } = fresh();
  const strangerCommand = '"C:\\tools\\my-wrapper.exe" "codex-hook.js" "--custom"';
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: strangerCommand }] }] },
  }), 'utf8');

  mod.install();
  let j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.equal(j.hooks.PreToolUse.length, 2);   // 남의 훅 + 우리 훅
  assert.ok(j.hooks.PreToolUse.some(e => e.hooks[0].command === strangerCommand));

  mod.uninstall();
  j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.equal(j.hooks.PreToolUse.length, 1);
  assert.equal(j.hooks.PreToolUse[0].hooks[0].command, strangerCommand);
});

// --- 최종 리뷰 (전체 브랜치) ---

// I3: 첫 설치는 hooks.json 이 없는 상태에서 일어난다. 그때 backup() 은 null 을
// 돌려주는 게 맞고(백업할 원본이 없다), 프론트가 그 null 을 다뤄야 한다.
test('install 은 기존 파일이 없으면 backup 이 null 이지만 성공한다', () => {
  const { dir, mod } = fresh();
  const r = mod.install();
  assert.equal(r.ok, true);
  assert.equal(r.backup, null);
  assert.equal(r.installed.length, 12);
  assert.ok(fs.existsSync(path.join(dir, 'hooks.json')));
});

// I3: hooks.json 이 없는데 uninstall() 이 {} 만 든 파일을 새로 만들면 안 된다.
// 지울 것도 없는데 없던 사용자 상태를 만들어내는 건 되돌리기가 아니다.
test('uninstall 은 hooks.json 이 없으면 파일을 만들지 않는다', () => {
  const { dir, mod } = fresh();
  const r = mod.uninstall();
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed, []);
  assert.equal(r.backup, null);
  assert.equal(fs.existsSync(path.join(dir, 'hooks.json')), false);
});

// I5: 관측을 끄면 실행 상태 디렉터리도 사라져야 한다. 남겨두면 파일을 지울
// SessionEnd 훅이 방금 사라졌으므로 24시간 동안 '작업 중' 이 굳는다.
test('uninstall 은 실행 상태 디렉터리(.cc-launcher-live)를 지운다', () => {
  const { dir, mod } = fresh();
  mod.install();
  const liveDir = path.join(dir, '.cc-launcher-live');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, 'aaa.json'), JSON.stringify({
    sessionId: 'aaa', status: 'busy', at: Date.now() }), 'utf8');
  assert.equal(mod.LIVE_DIR, liveDir);

  mod.uninstall();
  assert.equal(fs.existsSync(liveDir), false);
});

test('uninstall 은 실행 상태 디렉터리가 없어도 던지지 않는다', () => {
  const { mod } = fresh();
  mod.install();
  assert.doesNotThrow(() => mod.uninstall());
});
