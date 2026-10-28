'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCleanup } = require('../session-cleanup');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cleanup-'));
  const claudeDir = path.join(dir, 'claude'), codexDir = path.join(dir, 'codex'), backupDir = path.join(dir, 'backups');
  fs.mkdirSync(claudeDir); fs.mkdirSync(codexDir);
  const state = { now: Date.now(), processes: [], terms: [], killed: [], closed: [], hidden: [] };
  const manager = createCleanup({ claudeDir, codexDir, backupDir, now: () => state.now,
    listProcesses: async () => { if (state.processes === null) throw new Error('Access denied'); return state.processes; },
    terminals: { list: () => state.terms, close: id => { state.closed.push(id); } },
    sessions: () => [{ provider: 'claude', id: 'session-a', title: 'A', slug: 'project' }],
    killTree: async pid => { state.killed.push(pid); return true; }, hide: row => { state.hidden.push(row.key); },
  });
  const record = (provider, id = 'session-a', extra = {}) => {
    const file = path.join(provider === 'claude' ? claudeDir : codexDir, provider === 'claude' ? '100.json' : id + '.json');
    fs.writeFileSync(file, JSON.stringify({ sessionId: id, pid: 100, at: state.now - 7200000, status: 'idle', ...extra }));
    return file;
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, manager, state, record };
}

test('ended state records are backed up and removed without killing processes or deleting session history', async t => {
  const f = fixture(t), file = f.record('claude');
  const history = path.join(f.dir, 'conversation.jsonl'); fs.writeFileSync(history, 'important conversation');
  const inventory = await f.manager.inventory(); assert.equal(inventory.rows[0].type, 'stale');
  const result = await f.manager.execute({ token: inventory.token, keys: ['claude:session-a'], mode: 'clean' });
  assert.deepEqual(result.done, ['claude:session-a']); assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(history, 'utf8'), 'important conversation'); assert.equal(f.state.killed.length, 0);
  const backup = fs.readdirSync(result.backupDir)[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backupDir, backup, '100.json'))).sessionId, 'session-a');
});

test('Codex ephemeral hook PID cannot prove a session has ended when a Codex process is still running', async t => {
  const f = fixture(t); f.record('codex');
  f.state.processes = [{ pid: 500, name: 'codex.exe', command: 'codex', born: '2026-01-01' }];
  const inventory = await f.manager.inventory(); assert.equal(inventory.rows[0].type, 'unknown');
  const result = await f.manager.execute({ token: inventory.token, keys: ['codex:session-a'], mode: 'clean' });
  assert.equal(result.done.length, 0); assert.equal(result.failed.length, 1); assert.equal(f.state.killed.length, 0);
});

test('missing process visibility is unknown, not an invitation to remove records', async t => {
  const f = fixture(t); f.record('claude'); f.state.processes = null;
  assert.equal((await f.manager.inventory()).rows[0].type, 'unknown');
});

test('bulk stop requires confirmation and rechecks process identity, not a client-supplied PID', async t => {
  const f = fixture(t); f.record('claude');
  f.state.processes = [{ pid: 100, name: 'claude.exe', command: 'claude --resume session-a', born: '2026-01-01' }];
  const inventory = await f.manager.inventory(); assert.equal(inventory.rows[0].killable, true);
  const input = { token: inventory.token, keys: ['claude:session-a'], mode: 'stop', pid: 99999 };
  await assert.rejects(f.manager.execute(input), /확인/);
  const done = await f.manager.execute({ ...input, confirmed: true });
  assert.equal(done.done.length, 1); assert.deepEqual(f.state.killed, [100]);
});

test('PID reuse between preview and execution is rejected', async t => {
  const f = fixture(t); f.record('claude');
  f.state.processes = [{ pid: 100, name: 'claude.exe', command: 'claude --resume session-a', born: '2026-01-01' }];
  const inventory = await f.manager.inventory();
  f.state.processes[0] = { ...f.state.processes[0], born: '2026-02-01' };
  const result = await f.manager.execute({ token: inventory.token, keys: ['claude:session-a'], mode: 'stop', confirmed: true });
  assert.equal(result.done.length, 0); assert.equal(f.state.killed.length, 0);
});

test('a new busy response or renewed state file is not swept away by an old selection', async t => {
  const f = fixture(t); const file = f.record('claude');
  const inventory = await f.manager.inventory();
  f.record('claude', 'session-a', { status: 'busy', at: f.state.now });
  const result = await f.manager.execute({ token: inventory.token, keys: ['claude:session-a'], mode: 'clean' });
  assert.equal(result.failed.length, 1); assert.equal(fs.existsSync(file), true);
});

test('unverified sessions can be hidden without changing processes or live records', async t => {
  const f = fixture(t), file = f.record('codex');
  f.state.processes = null;
  const inventory = await f.manager.inventory();
  const result = await f.manager.execute({ token: inventory.token, keys: ['codex:session-a'], mode: 'hide' });
  assert.equal(result.done.length, 1); assert.equal(fs.existsSync(file), true);
  assert.deepEqual(f.state.hidden, ['codex:session-a']); assert.equal(f.state.killed.length, 0);
});

test('explicitly dismissing an unknown running indicator does not kill its possible process', async t => {
  const f = fixture(t), file = f.record('codex');
  f.state.processes = [{ pid: 900, name: 'codex.exe', command: 'codex app-server', born: '2026-01-01' }];
  const inventory = await f.manager.inventory(); assert.equal(inventory.rows[0].type, 'unknown');
  const input = { token: inventory.token, keys: ['codex:session-a'], mode: 'dismiss' };
  await assert.rejects(f.manager.execute(input), /확인/);
  const result = await f.manager.execute({ ...input, confirmed: true });
  assert.equal(result.done.length, 1); assert.equal(fs.existsSync(file), false); assert.equal(f.state.killed.length, 0);
});
