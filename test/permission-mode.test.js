'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { permissionArgs, requestedMode } = require('../permission-mode');

test('full access requires explicit acknowledgement and invalid modes fail closed', () => {
  assert.throws(() => requestedMode({ permissionMode: 'full' }), /확인/);
  assert.throws(() => requestedMode({ permissionMode: '--yolo' }), /잘못/);
  assert.equal(requestedMode({}), 'inherit');
  assert.equal(requestedMode({ permissionMode: 'full', confirmFullAccess: true }), 'full');
  assert.deepEqual(permissionArgs('claude', 'auto'), ['--permission-mode', 'auto']);
  assert.deepEqual(permissionArgs('claude', 'full'), ['--dangerously-skip-permissions']);
  assert.deepEqual(permissionArgs('codex', 'full'), ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
  assert.ok(permissionArgs('codex', 'auto').includes('workspace-write'));
  assert.deepEqual(permissionArgs('claude', 'inherit'), []);
});

function fixture() {
  const file = path.join(__dirname, '../terminals.js');
  const localRequire = createRequire(file);
  const calls = [], processes = [];
  const pty = { spawn(bin, args) {
    calls.push({ bin, args: Array.from(args) });
    const exits = [];
    const proc = { pid: 99999999, cols: 80, rows: 24, killed: false,
      onData() {}, onExit(fn) { exits.push(fn); },
      kill() { this.killed = true; exits.forEach(fn => fn({ exitCode: 0 })); } };
    processes.push(proc); return proc;
  } };
  const context = { require: name => name === 'node-pty' ? pty : localRequire(name),
    module: { exports: {} }, process, Buffer, console,
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    setInterval: () => ({ unref() {} }), clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { terminals: context.module.exports, calls, processes };
}

for (const provider of ['claude', 'codex']) {
  test(provider + ': permission mode is retained on restart/clear and can return to inherited settings', async () => {
    const { terminals, calls } = fixture();
    const bins = { claudeBin: 'claude.exe', codexBin: 'codex.exe' };
    const t = terminals.create({ ...bins, provider, action: 'resume', cwd: __dirname,
      sessionId: 'session-test', permissionMode: 'auto' });
    assert.equal(t.permissionMode, 'auto');
    await terminals.restart(t.id, { ...bins, permissionMode: 'full' });
    assert.ok(calls[1].args.includes(provider === 'claude' ? '--dangerously-skip-permissions' : 'never'));
    assert.ok(calls[1].args.includes('session-test'));
    await terminals.restart(t.id, bins);
    assert.deepEqual(calls[2].args, calls[1].args);
    await terminals.restart(t.id, { ...bins, permissionMode: 'inherit' });
    assert.ok(!calls[3].args.includes('never') && !calls[3].args.includes('--dangerously-skip-permissions'));
    await terminals.restart(t.id, { ...bins, permissionMode: 'full' });
    await terminals.fresh(t.id, bins);
    assert.equal(t.permissionMode, 'full');
    assert.equal(t.sessionId, null);
    assert.ok(!calls.at(-1).args.includes('session-test'));
  });
}

test('invalid permission changes and unknown session identity do not kill the current process', async () => {
  const { terminals, processes } = fixture();
  const bins = { claudeBin: 'claude.exe' };
  const t = terminals.create({ ...bins, action: 'new', cwd: __dirname });
  assert.throws(() => terminals.restart(t.id, { ...bins, permissionMode: 'wrong' }), /잘못/);
  await assert.rejects(terminals.restart(t.id, { ...bins, permissionMode: 'auto' }), /세션 ID/);
  assert.equal(processes[0].killed, false);
});

test('duplicate restart is rejected while the first replacement is pending', async () => {
  const { terminals, calls } = fixture();
  const bins = { claudeBin: 'claude.exe' };
  const t = terminals.create({ ...bins, action: 'resume', sessionId: 'test', cwd: __dirname });
  const first = terminals.restart(t.id, bins);
  await assert.rejects(terminals.restart(t.id, bins), /이미/);
  await first;
  assert.equal(calls.length, 2);
});

test('permission selector cancellation never restarts; confirmation passes only the selected mode', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const start = source.indexOf("document.addEventListener('change', async function(e){");
  const end = source.indexOf('  // 문서 탭의 프로젝트 고르기', start);
  const calls = [], notices = [];
  let handler, approved = false;
  const context = { document: { addEventListener(name, fn) { handler = fn; } },
    TERMS: [{ id: 't1', permissionMode: 'inherit' }],
    confirm: () => approved, CC: { term: { restart: async (...args) => calls.push(args) } },
    loadTerms: async () => {}, toast: msg => notices.push(msg) };
  vm.runInNewContext(source.slice(start, end) + '});', context);
  const select = { dataset: { termpermission: 't1' }, value: 'full' };
  await handler({ target: select });
  assert.equal(calls.length, 0);
  assert.equal(select.value, 'inherit');
  approved = true; select.value = 'full';
  await handler({ target: select });
  assert.deepEqual(calls, [['t1', 'full']]);
  assert.equal(select.disabled, false);
});

test('old servers cannot silently ignore a permission change or restart the session', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/term.js'), 'utf8');
  const calls = [];
  const context = { views: new Map([['t1', { term: { write: () => calls.push('write') } }]]),
    fetch: async () => ({ json: async () => ({ ok: true, apiVersion: 8 }) }),
    post: () => calls.push('restart') };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function restart('), source.indexOf('  function post(')), context);
  await assert.rejects(context.restart('t1', 'full'), /서버 재시작/);
  assert.deepEqual(calls, []);
});
