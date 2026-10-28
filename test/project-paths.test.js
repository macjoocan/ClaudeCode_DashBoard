'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createProjectPaths } = require('../project-paths');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-reconnect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'old'), target = path.join(root, 'new'), third = path.join(root, 'third');
  fs.mkdirSync(target); fs.mkdirSync(third);
  const file = path.join(root, 'aliases.json');
  return { root, old, target, third, file, store: createProjectPaths(file) };
}
test('missing old folder can reconnect, persists aliases, only exact project is regrouped', t => {
  const f = fixture(t); f.store.set(f.old, f.target);
  assert.equal(f.store.resolve(f.old), f.target);
  assert.equal(f.store.resolve(f.old + path.sep), f.target);
  assert.equal(f.store.resolve(path.join(f.old, 'subproject')), path.join(f.old, 'subproject'));
  assert.equal(createProjectPaths(f.file).resolve(f.old), f.target);
  assert.equal(fs.existsSync(f.old), false);
});
test('document remapping uses folder boundaries; unrelated prefixes and relative paths stay unchanged', t => {
  const f = fixture(t); f.store.set(f.old, f.target);
  assert.equal(f.store.resolveFile(path.join(f.old, 'docs', 'test.md')), path.join(f.target, 'docs', 'test.md'));
  assert.equal(f.store.resolveFile(f.old + '-other' + path.sep + 'test.md'), f.old + '-other' + path.sep + 'test.md');
  assert.equal(f.store.resolveFile('docs/test.md'), 'docs/test.md');
});
test('successive moves resolve old histories and reject cycles without changing stored config', t => {
  const f = fixture(t); f.store.set(f.old, f.target); f.store.set(f.target, f.third);
  assert.equal(f.store.resolve(f.old), f.third);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.store.set(f.third, f.target), /순환/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.throws(() => f.store.set(f.third, path.join(f.third, 'sub')), /ENOENT/);
});
test('bad targets, roots and identical paths are rejected, including recursive descendant mappings', t => {
  const f = fixture(t);
  assert.throws(() => f.store.set('relative', f.target), /절대/);
  assert.throws(() => f.store.set(f.old, path.join(f.root, 'missing')), /ENOENT/);
  assert.throws(() => f.store.set(f.old, f.target + path.sep + '..' + path.sep + 'old'), /같습니다/);
  assert.throws(() => f.store.set(path.parse(f.old).root, f.target), /드라이브/);
  fs.writeFileSync(path.join(f.root, 'file'), 'test');
  assert.throws(() => f.store.set(f.old, path.join(f.root, 'file')), /폴더/);
  fs.mkdirSync(f.old); fs.mkdirSync(path.join(f.old, 'nested'));
  assert.throws(() => f.store.set(f.old, path.join(f.old, 'nested')), /깊습니다/);
});
test('scan merges Claude and Codex by new cwd without replacing stable session/favorite identities', t => {
  const f = fixture(t); f.store.set(f.old, f.target);
  const claudeDir = path.join(f.root, 'claude', 'old-slug'); fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'claude-id.jsonl'), 'transcript');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const ctx = { fs, path, PROJECTS_DIR: path.dirname(claudeDir), cache: new Map(), projectPaths: f.store,
    liveSessions: () => new Map(), loadFavs: () => ['old-slug/claude-id', 'codex:codex-id'],
    loadHidden: () => ['proj:' + f.old.toLowerCase()], loadPins: () => [f.old.toLowerCase()],
    parseSession: () => ({ cwd: f.old, firstPrompt: 'old transcript' }),
    codex: { liveMap: () => new Map(), sessions: () => [{ id: 'codex-id', cwd: f.target, mtime: 1 }] } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function scan()'), source.indexOf('function loadPins()')) + '\nresult=scan();', ctx);
  assert.equal(ctx.result.length, 1); const p = ctx.result[0];
  assert.equal(p.cwd, f.target); assert.equal(p.sessions.length, 2);
  assert.equal(p.favCount, 2); assert.equal(p.pinned, true); assert.equal(p.hidden, true);
  assert.equal(p.sessions.find(s => s.id === 'claude-id').slug, 'old-slug');
  assert.equal(fs.readFileSync(path.join(claudeDir, 'claude-id.jsonl'), 'utf8'), 'transcript');
});
test('latest continue selects saved session ID after move for both providers', t => {
  const f = fixture(t); f.store.set(f.old, f.target);
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const ctx = { projectPaths: f.store, scan: () => [{ key: f.target.toLowerCase(), sessions: [
    { id: 'claude-old', provider: 'claude', mtime: 2 }, { id: 'claude-new', provider: 'claude', mtime: 5 },
    { id: 'codex-session', provider: 'codex', mtime: 3 } ] }] };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function prepareProjectLaunch('), source.indexOf('const { createGuard }')), ctx);
  for (const [provider, id] of [['claude', 'claude-new'], ['codex', 'codex-session']]) {
    const result = ctx.prepareProjectLaunch({ cwd: f.old, provider, action: 'continue' });
    assert.equal(result.cwd, f.target); assert.equal(result.action, 'resume'); assert.equal(result.sessionId, id);
  }
});

test('both terminal providers launch and restart in relocated cwd; missing target never kills old process', async t => {
  const f = fixture(t); f.store.set(f.old, f.target);
  const spawns = []; let kills = 0;
  const actualRequire = require('node:module').createRequire(path.join(__dirname, '../terminals.js'));
  const ctx = { module: { exports: {} }, process, Buffer, console,
    setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {},
    require(name) {
      if (name === 'node-pty') return { spawn(bin, args, options) {
        spawns.push({ bin, args, options }); return { pid: 999999, cols: 80, rows: 24, onData() {}, onExit() {}, kill() { kills++; } };
      } };
      return actualRequire(name);
    } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../terminals.js'), 'utf8'), ctx);
  const terminals = ctx.module.exports;
  terminals.configurePaths(o => ({ ...o, cwd: f.store.resolve(o.cwd) }));
  for (const provider of ['claude', 'codex']) {
    const bins = { claudeBin: 'claude.exe', codexBin: 'codex.exe' };
    const term = terminals.create({ ...bins, action: 'resume', sessionId: 'old-id', cwd: f.old, provider });
    assert.equal(spawns.at(-1).options.cwd, f.target);
    assert.ok(spawns.at(-1).args.includes('old-id'));
    if (provider === 'codex') {
      const args = spawns.at(-1).args;
      assert.equal(args[args.indexOf('--cd') + 1], f.target);
    }
    assert.equal(kills, 0);
    term.exitCode = 0; // fake exited process; never launch a real CLI
    await terminals.restart(term.id, bins);
    assert.equal(spawns.at(-1).options.cwd, f.target);
    term.cwd = path.join(f.root, 'missing');
    const before = spawns.length;
    await assert.rejects(terminals.restart(term.id, bins), /다시 연결/);
    assert.equal(spawns.length, before); assert.equal(kills, 0);
  }
});
