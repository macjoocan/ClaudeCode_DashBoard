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
