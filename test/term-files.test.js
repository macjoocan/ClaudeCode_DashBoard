'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/term.js'), 'utf8');
function fixture() {
  const listeners = {}, timers = new Map(), calls = [], pasted = [], notices = [];
  let timer = 0;
  const term = { paste: text => pasted.push(text), focus() {}, hasSelection: () => false,
    attachCustomKeyEventHandler(fn) { this.key = fn; } };
  const body = { addEventListener(name, fn) { listeners[name] = fn; } };
  const ctx = { Promise, navigator: { clipboard: { readText: async () => 'text' } },
    document: {}, CC: { toast: (...args) => notices.push(args) }, views: new Map(),
    setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); },
    post: async (url) => { calls.push(url); return { files: [{ path: 'C:\\one.png' }, { path: 'C:\\two file.pdf' }] }; },
    fetch: async url => ({ json: async () => ({ path: url.includes('one') ? 'C:\\one.png' : 'C:\\two.png', bytes: 3 }) }),
    sendMsg() { throw new Error('files must use bracketed term.paste'); },
    nudge() {}, onChange: null };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function note('), source.indexOf('  // ------------------------------------------------------------ 끌어다 놓기')), ctx);
  const v = { term, body, info: { id: 'proof' }, alive: true };
  ctx.wireClipboard(v, body);
  return { ctx, term, v, listeners, calls, pasted, timers, notices };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function key() { return { type: 'keydown', key: 'v', ctrlKey: true, shiftKey: false,
  preventDefault() { throw new Error('native Ctrl+V must remain available'); } }; }
function pasteEvent(data) { return { clipboardData: data, preventDefault() {}, stopPropagation() {} }; }

test('right-click paste inserts all Explorer file paths without falling back to text', async () => {
  const f = fixture();
  await f.ctx.pasteClipboard(f.v);
  assert.deepEqual(f.calls, ['/api/clipboard-files']);
  assert.deepEqual(f.pasted, ['C:\\one.png "C:\\two file.pdf" ']);
});
test('Ctrl+V missing a browser paste event falls back to Explorer file list', async () => {
  const f = fixture();
  assert.equal(f.term.key(key()), false);
  for (const fn of f.timers.values()) fn();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.pasted.length, 1);
});
test('native text paste cancels file fallback and remains untouched', async () => {
  const f = fixture(); f.term.key(key());
  f.listeners.paste(pasteEvent({ files: [], getData: () => 'normal text' }));
  for (const fn of f.timers.values()) fn(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.pasted.length, 0);
});
test('native multi-image paste inserts one bracketed paste and cancels fallback', async () => {
  const f = fixture(); f.ctx.post = async url => { f.calls.push(url); return { files: [] }; }; f.term.key(key());
  f.listeners.paste(pasteEvent({ files: [{ name: 'one.png' }, { name: 'two.png' }] }));
  for (const fn of f.timers.values()) fn(); await tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.pasted, ['C:\\one.png C:\\two.png ']);
});
test('a partial browser file payload uses the complete Explorer file list', async () => {
  const f = fixture(); f.term.key(key());
  f.listeners.paste(pasteEvent({ files: [{ name: 'one.png' }] }));
  for (const fn of f.timers.values()) fn(); await tick();
  assert.deepEqual(f.pasted, ['C:\\one.png "C:\\two file.pdf" ']);
  assert.equal(f.calls.length, 1);
});
test('late native paste cancels an in-flight Windows fallback result', async () => {
  const f = fixture(); let complete;
  f.ctx.post = () => new Promise(resolve => { complete = resolve; });
  f.term.key(key()); for (const fn of f.timers.values()) fn();
  f.listeners.paste(pasteEvent({ files: [], getData: () => 'text' }));
  complete({ files: [{ path: 'C:\\late.png' }] }); await tick();
  assert.equal(f.pasted.length, 0);
});
test('unavailable file bridge preserves right-click text paste', async () => {
  const f = fixture(); f.ctx.post = async () => { throw new Error('old server'); };
  await f.ctx.pasteClipboard(f.v);
  assert.deepEqual(f.pasted, ['text']);
});
