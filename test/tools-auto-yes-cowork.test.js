'use strict';
// tools/auto-yes-cowork - 빌드된 .plugin 을 풀어 hooks.json 의 명령 그대로 훅을 돌려 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, '..', 'tools', 'auto-yes-cowork');

// 빌드 없이 소스 그대로 쓰되, 빌드가 하는 것처럼 위험 명령 검사를 옆에 복사해 둔다.
function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ayc-'));
  fs.cpSync(path.join(DIR, '.claude-plugin'), path.join(root, '.claude-plugin'), { recursive: true });
  fs.cpSync(path.join(DIR, 'hooks'), path.join(root, 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(DIR, '..', 'auto-yes', 'auto-yes.js'), path.join(root, 'hooks', 'lib-auto-yes.js'));
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  return { root, work };
}

function call(s, input, withLib = true) {
  if (!withLib) fs.rmSync(path.join(s.root, 'hooks', 'lib-auto-yes.js'), { force: true });
  const cmd = JSON.parse(fs.readFileSync(path.join(s.root, 'hooks', 'hooks.json'), 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  // hooks.json 의 명령을 셸로 그대로 돌린다(코워크가 하는 것과 같게). 경로는 환경변수로만 받는다.
  const r = spawnSync(cmd, { shell: true, cwd: s.work, input: JSON.stringify(input), encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: s.root }) });
  const out = r.stdout ? JSON.parse(r.stdout) : null;
  return { status: r.status, allowed: !!(out && out.hookSpecificOutput.decision.behavior === 'allow') };
}

const pr = (tool_name, tool_input) => ({ hook_event_name: 'PermissionRequest', tool_name, tool_input, permission_mode: 'default' });

test('read-only work is allowed, writes and risky commands go back to the menu', () => {
  const s = stage();
  assert.equal(call(s, pr('mcp__hue-bi__run_impala_query', { query: 'select work_ymd, count(*) from t group by work_ymd' })).allowed, true);
  assert.equal(call(s, pr('Bash', { command: 'ls -la' })).allowed, true);
  for (const q of ['insert into t values (1)', 'DROP TABLE t', 'select 1; delete from t', '  truncate table t', '/* x */ update t set a=1'])
    assert.equal(call(s, pr('mcp__hue-bi__run_impala_query', { query: q })).allowed, false, q);
  assert.equal(call(s, pr('Bash', { command: 'rm -rf build' })).allowed, false);
  assert.equal(call(s, pr('ExitPlanMode', {})).allowed, false);
});

test('every call leaves a line in the work folder log, and other events only log', () => {
  const s = stage();
  call(s, { hook_event_name: 'SessionStart' });
  call(s, pr('Bash', { command: 'ls' }));
  const log = fs.readFileSync(path.join(s.work, 'auto-yes-cowork-log.txt'), 'utf8').trim().split(/\r?\n/);
  assert.equal(log.length, 2);
  assert.match(log[0], /SessionStart \| - \|/);
  assert.match(log[1], /PermissionRequest \| ALLOW \| Bash .*os=/);
});

test('without the risk check nothing is allowed, and bad input never fails the hook', () => {
  const s = stage();
  const r = call(s, pr('Bash', { command: 'ls' }), false);
  assert.equal(r.allowed, false);
  assert.equal(r.status, 0);
  const cmd = JSON.parse(fs.readFileSync(path.join(s.root, 'hooks', 'hooks.json'), 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const g = spawnSync(cmd, { shell: true, cwd: s.work, input: 'not json', encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: s.root }) });
  assert.equal(g.status, 0);
  assert.equal(g.stdout, '');
});
