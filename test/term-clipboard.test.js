'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/term.js'), 'utf8');

// DOM and OS clipboard are external boundaries; run the real clipboard handlers.
function fixture(clipboard) {
  const listeners = {}, notices = [], children = [];
  const input = { focus() { document.activeElement = input; } };
  const document = {
    activeElement: input,
    body: {
      appendChild(el) { children.push(el); },
      removeChild(el) { children.splice(children.indexOf(el), 1); document.activeElement = null; },
    },
    createElement() {
      const el = { style: {}, setAttribute() {}, select() { document.activeElement = el; } };
      return el;
    },
    execCommand() { return true; },
  };
  const term = {
    selection: 'first selection',
    getSelection() { return this.selection; },
    hasSelection() { return !!this.selection; },
    clearSelection() { this.selection = ''; },
    selectAll() { this.selection = 'all terminal output'; },
    paste(text) { this.pasted = text; },
    focus() { input.focus(); },
    attachCustomKeyEventHandler(fn) { this.key = fn; },
  };
  const body = { addEventListener(name, fn, options) { listeners[name] = { fn, options }; } };
  const ctx = { document, navigator: { clipboard }, Promise,
    CC: { toast: (...args) => notices.push(args) }, views: new Map(),
    wireFiles() {}, nudge() {}, onChange: null, setTimeout() { return 0; }, clearTimeout() {} };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function note('), source.indexOf('  // ------------------------------------------------------ 이미지')), ctx);
  const v = { term, body, info: { id: 'test' } };
  ctx.wireClipboard(v, body);
  return { ctx, document, input, term, listeners, notices, children, v };
}
function key(key, extras) {
  return Object.assign({ type: 'keydown', key, ctrlKey: true, altKey: false,
    metaKey: false, shiftKey: false, prevented: false,
    preventDefault() { this.prevented = true; } }, extras);
}

test('legacy copy restores terminal input focus so the next native paste reaches xterm', () => {
  const f = fixture();
  assert.equal(f.ctx.legacyCopy('copy me'), true);
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.children.length, 0);
});

test('legacy copy cleans up and restores focus even if execCommand throws', () => {
  const f = fixture();
  f.document.execCommand = () => { throw new Error('denied'); };
  assert.equal(f.ctx.legacyCopy('copy me'), false);
  assert.equal(f.children.length, 0);
  assert.equal(f.document.activeElement, f.input);
});

test('a delayed copy cannot clear a newer selection', async () => {
  let complete;
  const f = fixture({ writeText: () => new Promise(resolve => { complete = resolve; }) });
  f.ctx.copySelection(f.v);
  f.term.selection = 'a newer selection';
  complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.term.selection, 'a newer selection');
});

test('copy shortcut blocks browser default and retains selection for repeated copying', async () => {
  const copied = [];
  const f = fixture({ writeText: text => { copied.push(text); return Promise.resolve(); } });
  const e = key('c');
  assert.equal(f.term.key(e), false);
  assert.equal(e.prevented, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.term.selection, 'first selection');
  assert.deepEqual(copied, ['first selection']);
});

test('Ctrl+C without a selection still reaches the CLI as interrupt', () => {
  const f = fixture();
  f.term.selection = '';
  const e = key('c');
  assert.equal(f.term.key(e), true);
  assert.equal(e.prevented, false);
});

test('output copy recognizes the physical C key during Korean IME input', async () => {
  const copied = [];
  const f = fixture({ writeText: text => { copied.push(text); return Promise.resolve(); } });
  const e = key('Process', { code: 'KeyC', keyCode: 229, isComposing: true });
  assert.equal(f.term.key(e), false);
  assert.equal(e.prevented, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(copied, ['first selection']);
  assert.match(f.notices[0][0], /복사됨/);
});

test('terminal surface catches output copy before xterm input handling', async () => {
  const copied = [];
  const f = fixture({ writeText: text => { copied.push(text); return Promise.resolve(); } });
  const e = key('c', { stopped: false, stopPropagation() { this.stopped = true; } });
  assert.ok(f.listeners.keydown, 'copy must work outside the hidden input');
  assert.equal(f.listeners.keydown.options, true);
  f.listeners.keydown.fn(e);
  assert.equal(e.prevented, true);
  assert.equal(e.stopped, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(copied, ['first selection']);
});

test('surface copy handler leaves unselected Ctrl+C and other keys alone', () => {
  const f = fixture();
  assert.ok(f.listeners.keydown);
  f.term.selection = '';
  const e = key('c', { code: 'KeyC', stopPropagation() { throw new Error('intercepted SIGINT'); } });
  f.listeners.keydown.fn(e);
  assert.equal(e.prevented, false);
  const paste = key('v', { stopPropagation() { throw new Error('intercepted paste'); } });
  f.listeners.keydown.fn(paste);
  assert.equal(paste.prevented, false);
});

function screen(f, texts, cursorY, cursorX = 5, wrapped = []) {
  f.term.cols = 40;
  f.term.rows = texts.length;
  f.term.buffer = { active: { baseY: 0, cursorY, cursorX,
    getLine(y) { return texts[y] == null ? undefined : {
      isWrapped: wrapped.includes(y), translateToString() { return texts[y]; },
      getCell(x) { return { getChars() { return texts[y][x] || ''; } }; },
    }; } } };
  f.term.select = (x, y, length) => { f.term.range = { x, y, length }; };
}

test('Ctrl+A selects only the current prompt, including text after the cursor', () => {
  const f = fixture();
  screen(f, ['old response', '────────', '❯ hello world', '────────', 'status'], 2);
  const e = key('a');
  assert.equal(f.term.key(e), false);
  assert.deepEqual(f.term.range, { x: 2, y: 2, length: 11 });
  assert.equal(e.prevented, true);
});

test('prompt selection includes multiline input but excludes borders and footer', () => {
  const f = fixture();
  screen(f, ['────────', '› first line', '  second line', '  last line', '────────', 'status'], 2);
  f.term.key(key('a'));
  assert.deepEqual(f.term.range, { x: 2, y: 1, length: 89 });
});

test('boxed prompts retain blank lines inside the input', () => {
  const f = fixture();
  screen(f, ['────────', '❯ first', '', '  last', '────────', 'status'], 1);
  f.term.key(key('a'));
  assert.deepEqual(f.term.range, { x: 2, y: 1, length: 84 });
});

test('prompt selection measures wide Korean characters in terminal cells', () => {
  const f = fixture();
  screen(f, ['────────', '❯ 한글', '────────'], 1);
  const line = f.term.buffer.active.getLine(1);
  line.getCell = x => ({ getChars: () => ({ 0: '❯', 1: ' ', 2: '한', 4: '글' }[x] || ''),
    getWidth: () => x === 2 || x === 4 ? 2 : 1 });
  f.term.buffer.active.getLine = y => y === 1 ? line : { translateToString: () => '────────' };
  f.term.key(key('a'));
  assert.deepEqual(f.term.range, { x: 2, y: 1, length: 4 });
});

test('Ctrl+A does not select conversation output when there is no identifiable prompt', () => {
  const f = fixture();
  screen(f, ['old response', 'Choose an option'], 1);
  f.term.key(key('a'));
  assert.equal(f.term.range, undefined);
  assert.notEqual(f.term.selection, 'all terminal output');
});

test('Ctrl+Shift+A retains whole terminal output selection', () => {
  const f = fixture();
  f.term.key(key('a', { shiftKey: true }));
  assert.equal(f.term.selection, 'all terminal output');
});

test('Ctrl+V and Shift+Insert keep native paste available without clipboard permission', () => {
  const f = fixture();
  for (const e of [key('v'), key('Insert', { ctrlKey: false, shiftKey: true })]) {
    assert.equal(f.term.key(e), false);
    assert.equal(e.prevented, false);
  }
});

test('right-click is captured before xterm repositions and selects its hidden textarea', () => {
  const f = fixture({ writeText: () => Promise.resolve() });
  const e = { prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  f.listeners.contextmenu.fn(e);
  assert.equal(e.prevented, true);
  assert.equal(e.stopped, true);
  assert.equal(f.listeners.contextmenu.options, true);
});
