'use strict';
// tools/auto-yes (팀 공유용 훅 설치기) - 위험 명령 거르기와 설치/제거가 남의 설정을 지키는지.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'tools', 'auto-yes', 'auto-yes.js');
const { alwaysAsk } = require(SCRIPT);
const bash = command => ({ tool_name: 'Bash', tool_input: { command } });

test('risky commands always fall through to the normal menu', () => {
  for (const c of [
    'rm -rf build', 'rm -fr build', 'rm -r -f build',
    'rm -r -fo build', 'rm -Recurse -Force build', 'Remove-Item -Recurse dist',
    'rmdir /s /q build', 'rmdir /q /s build', 'rd /Q /S C:\\proj', 'del /f /s /q *.tmp',
    'git push --force', 'git push -f origin main', 'git push origin +main', 'git push --force-with-lease',
    'git reset --hard HEAD~1', 'git clean -fd', 'format D:', 'psql -c "DROP TABLE users"',
  ]) assert.equal(alwaysAsk(bash(c)), 'risky command', c);
  assert.equal(alwaysAsk({ tool_name: 'ExitPlanMode', tool_input: {} }), 'tool ExitPlanMode');
});

test('ordinary commands are not mistaken for risky ones', () => {
  for (const c of ['npm test', 'git push origin main', 'git push -u origin feature', 'rm notes.txt',
    'del notes.txt', 'git status --short', 'rmdir empty-dir', 'node scripts/build.js --release'])
    assert.equal(alwaysAsk(bash(c)), null, c);
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-yes-'));
  const env = Object.assign({}, process.env, {
    AUTO_YES_HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'),
  });
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR); fs.mkdirSync(env.CODEX_HOME);
  const claude = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  const codex = path.join(env.CODEX_HOME, 'hooks.json');
  fs.writeFileSync(claude, JSON.stringify({ model: 'x', hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'node other.js' }] }] } }));
  fs.writeFileSync(codex, JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'node codex-hook.js' }] }] } }));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { env, claude, codex, run, original: { claude: fs.readFileSync(claude, 'utf8'), codex: fs.readFileSync(codex, 'utf8') } };
}

test('install is idempotent, keeps foreign hooks last-in-line, and uninstall restores them', () => {
  const s = sandbox();
  assert.equal(s.run('install').status, 0);
  const once = fs.readFileSync(s.claude, 'utf8');
  assert.equal(s.run('install').status, 0);                      // 두 번 깔아도
  assert.equal(fs.readFileSync(s.claude, 'utf8'), once);          // 항목이 쌓이지 않는다
  const list = JSON.parse(once).hooks.PermissionRequest;
  assert.equal(list.length, 2);
  assert.equal(list[0].hooks[0].command, 'node other.js');        // 남의 훅은 앞에 그대로
  assert.equal(JSON.parse(fs.readFileSync(s.codex, 'utf8')).hooks.PermissionRequest.length, 2);

  assert.equal(s.run('uninstall').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.claude, 'utf8')), JSON.parse(s.original.claude));
  assert.deepEqual(JSON.parse(fs.readFileSync(s.codex, 'utf8')), JSON.parse(s.original.codex));
  // 처음 백업은 설치 전 원본 그대로 남는다 (예전엔 매번 덮여 사라졌다)
  assert.equal(fs.readFileSync(s.claude + '.auto-yes.orig.bak', 'utf8'), s.original.claude);
});

test('the hook allows only while switched on, and never for risky commands', () => {
  const s = sandbox();
  s.run('install');
  const hook = input => spawnSync(process.execPath, [path.join(s.env.AUTO_YES_HOME, 'auto-yes.js'), 'hook'],
    { env: s.env, input: JSON.stringify(Object.assign({ hook_event_name: 'PermissionRequest' }, input)), encoding: 'utf8' });
  assert.equal(hook(bash('npm test')).stdout, '');                // 꺼져 있으면 아무 말 없음
  s.run('on');
  const allowed = hook(bash('npm test'));
  assert.equal(allowed.status, 0);
  assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(hook(bash('rmdir /q /s build')).stdout, '');
  assert.equal(hook(bash('git push origin +main')).stdout, '');
  const garbage = spawnSync(process.execPath, [path.join(s.env.AUTO_YES_HOME, 'auto-yes.js'), 'hook'], { env: s.env, input: 'not json', encoding: 'utf8' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
  s.run('off');
  assert.equal(hook(bash('npm test')).stdout, '');
});
