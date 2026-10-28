'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStudio, git } = require('../studio');
const { localUrl } = require('../studio-preview');

async function fixture(t, repository = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-studio-'));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'hello.txt'), 'original\n');
  if (repository) {
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await git(root, ['config', 'user.name', 'Studio Test']);
    await git(root, ['config', 'core.autocrlf', 'false']);
    await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  }
  const terms = new Map(); let seq = 0, clock = 100000;
  const writes = [];
  const terminals = { get: id => terms.get(id), info: term => ({ ...term }),
    write: (id, data) => { writes.push({ id, data }); return true; } };
  const stateDir = path.join(dir, 'state');
  const studio = createStudio({ stateDir, terminals, now: () => clock,
    startTerminal(opts) {
      const term = { ...opts, id: 'test-' + ++seq, alive: true, startedAt: clock,
        lastAt: clock, lastRealAt: clock, status: 'idle', buf: 'ready '.repeat(100) };
      terms.set(term.id, term); return term;
    } });
  t.after(() => { studio.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const create = (extra = {}) => studio.create({ title: 'Test task', root, prompt: 'Improve the greeting', providers: ['claude', 'codex'], ...extra });
  return { dir, root, stateDir, studio, create, terms, terminals, writes, tick: n => { clock += n; } };
}

test('parallel agents get isolated worktrees based on the committed source, persisted across restarts', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'hello.txt'), 'local unsaved work\n');
  const task = await f.create(); assert.equal(task.sourceDirty, true);
  assert.notEqual(task.candidates[0].cwd, task.candidates[1].cwd);
  for (const c of task.candidates) assert.equal(fs.readFileSync(path.join(c.cwd, 'hello.txt'), 'utf8'), 'original\n');
  fs.writeFileSync(path.join(task.candidates[0].cwd, 'hello.txt'), 'claude changes\n');
  assert.equal(fs.readFileSync(path.join(task.candidates[1].cwd, 'hello.txt'), 'utf8'), 'original\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'hello.txt'), 'utf8'), 'local unsaved work\n');
  f.studio.close();
  const restored = createStudio({ stateDir: f.stateDir, terminals: f.terminals, startTerminal() {} });
  t.after(() => restored.close());
  assert.equal(restored.list()[0].id, task.id);
  assert.equal(restored.list()[0].candidates.length, 2);
});

test('review includes committed, uncommitted and new files; editor rejects stale saves and escapes', async t => {
  const f = await fixture(t); const task = await f.create(); const c = task.candidates[0];
  const before = f.studio.readFile(task.id, c.id, 'hello.txt');
  f.studio.writeFile(task.id, c.id, 'hello.txt', 'new text\n', before.version);
  assert.throws(() => f.studio.writeFile(task.id, c.id, 'hello.txt', 'stale', before.version), /변경/);
  assert.throws(() => f.studio.readFile(task.id, c.id, '../tasks.json'), /폴더/);
  assert.throws(() => f.studio.readFile(task.id, c.id, '.git'), /폴더/);
  fs.writeFileSync(path.join(c.cwd, 'legacy.txt'), Buffer.from([0x80, 0x81]));
  assert.throws(() => f.studio.readFile(task.id, c.id, 'legacy.txt'), /UTF-8/);
  fs.unlinkSync(path.join(c.cwd, 'legacy.txt'));
  fs.writeFileSync(path.join(c.cwd, '새 파일.txt'), 'hello new file\n');
  let changes = await f.studio.changes(task.id, c.id);
  assert.equal(changes.files.length, 2); assert.equal(changes.files.find(x => x.path === '새 파일.txt').untracked, true);
  assert.match((await f.studio.diff(task.id, c.id, 'hello.txt')).patch, /\+new text/);
  assert.match((await f.studio.diff(task.id, c.id, '새 파일.txt')).patch, /\+hello new file/);
  await f.studio.commit(task.id, c.id, 'candidate changes');
  changes = await f.studio.changes(task.id, c.id);
  assert.equal(changes.files.length, 2, 'candidate commits remain visible against task baseline');
});

test('winner requires explicit confirmation, clean unchanged source and stopped candidate; applies only selected branch', async t => {
  const f = await fixture(t), task = await f.create(), c = task.candidates[0];
  fs.writeFileSync(path.join(c.cwd, 'hello.txt'), 'winner\n');
  await f.studio.commit(task.id, c.id, 'winner');
  await assert.rejects(f.studio.apply(task.id, c.id, false), /확인/);
  fs.writeFileSync(path.join(f.root, 'hello.txt'), 'keep local changes\n');
  await assert.rejects(f.studio.apply(task.id, c.id, true), /원본/);
  assert.equal(fs.readFileSync(path.join(f.root, 'hello.txt'), 'utf8'), 'keep local changes\n');
  fs.writeFileSync(path.join(f.root, 'hello.txt'), 'original\n');
  await f.studio.start(task.id, c.id);
  await assert.rejects(f.studio.apply(task.id, c.id, true), /중지/);
  await assert.rejects(f.studio.commit(task.id, c.id, 'running'), /중지/);
  f.terms.values().next().value.alive = false;
  const applied = await f.studio.apply(task.id, c.id, true);
  assert.equal(applied.winner, c.id);
  assert.equal(fs.readFileSync(path.join(f.root, 'hello.txt'), 'utf8'), 'winner\n');
  assert.equal(fs.readFileSync(path.join(task.candidates[1].cwd, 'hello.txt'), 'utf8'), 'original\n');
});

test('source branch advancement blocks applying a stale result', async t => {
  const f = await fixture(t), task = await f.create(), c = task.candidates[0];
  fs.writeFileSync(path.join(c.cwd, 'hello.txt'), 'candidate\n'); await f.studio.commit(task.id, c.id, 'candidate');
  fs.writeFileSync(path.join(f.root, 'other.txt'), 'later source'); await git(f.root, ['add', '.']); await git(f.root, ['commit', '-m', 'source changed']);
  await assert.rejects(f.studio.apply(task.id, c.id, true), /原本|원본/);
});

test('non-Git projects allow one shared-folder agent but reject parallel shared writes', async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.create(), /Git/);
  await assert.rejects(f.create({ isolated: false }), /한 AI/);
  const task = await f.create({ isolated: false, providers: ['codex'] });
  assert.equal(task.candidates[0].cwd, f.root);
  assert.deepEqual(await f.studio.files(task.id, task.candidates[0].id), ['hello.txt']);
});

test('starting twice creates one PTY; prompt waits for readiness and does not answer a confirmation screen', async t => {
  const f = await fixture(t), task = await f.create(), c = task.candidates[0];
  await Promise.all([f.studio.start(task.id, c.id), f.studio.start(task.id, c.id)]);
  assert.equal(f.terms.size, 1);
  const term = f.terms.values().next().value;
  f.tick(6000); term.status = 'waiting'; await f.studio.pump(); assert.equal(f.writes.length, 0);
  term.status = 'busy'; await f.studio.pump(); assert.equal(f.writes.length, 0);
  term.status = 'idle'; await f.studio.pump();
  assert.equal(f.writes.length, 1); assert.match(f.writes[0].data, /Improve the greeting/);
  await f.studio.pump(); assert.equal(f.writes.length, 1, 'prompt must not be pasted twice');
  assert.equal(f.studio.get(task.id).candidates[0].messages[0].status, 'sent');
  term.alive = false;
  await f.studio.start(task.id, c.id);
  assert.equal(f.studio.get(task.id).candidates[0].messages.filter(m => m.kind === 'task').length, 2,
    'a new session without a saved session ID must receive the task again');
  f.studio.note(task.id, c.id, 'hello.txt', 1, 'Please keep this accessible');
  assert.equal(f.studio.get(task.id).notes[0].line, 1);
});

test('preview URL accepts only explicit local HTTP development servers', () => {
  assert.equal(localUrl('http://localhost:3000/page'), 'http://localhost:3000/page');
  assert.equal(localUrl('http://127.0.0.1:5173'), 'http://127.0.0.1:5173/');
  for (const value of ['https://example.com', 'file:///C:/secret', 'http://localhost.example.com', 'http://user:pass@localhost']) assert.throws(() => localUrl(value));
});
