'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/term.js'), 'utf8');
const start = source.indexOf('  function codexScrollback(');
const end = source.indexOf('  function writeOutput(', start);
assert.ok(start > 0 && end > start);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);

test('대화 내용을 ANSI 제어문자 없이 터미널 스크롤백용 줄로 만든다', () => {
  const output = ctx.codexScrollback([
    { role: 'user', text: '질문\n다음 줄' },
    { role: 'tool', text: '도구 출력' },
    { role: 'assistant', text: '\x1b[31m답변' },
  ]);
  assert.match(output, /나\r\n질문\r\n다음 줄/);
  assert.match(output, /Codex\r\n\[31m답변/);
  assert.doesNotMatch(output, /도구 출력|\x1b/);
});

test('이전 대화를 같은 xterm 버퍼에 복원해도 현재 TUI 화면은 그대로다', async () => {
  global.self = global;
  const { Terminal } = require('../public/vendor/xterm.js');
  const options = { cols: 40, rows: 10, scrollback: 1000 };
  const plain = new Terminal(options);
  const restored = new Terminal(options);
  const write = (term, data) => new Promise(resolve => term.write(data, resolve));
  const current = '\x1b[H현재 Codex 화면\r\n작업 중\x1b[10;1H> ';
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', text: `답변 ${i}` }));
  await write(plain, current);
  await write(restored, ctx.codexScrollback(messages) + '\x1b[2J\x1b[H' + current);
  const screen = term => Array.from({ length: 10 }, (_, i) =>
    term.buffer.active.getLine(term.buffer.active.baseY + i).translateToString(true));
  assert.ok(restored.buffer.active.baseY > 0, '마우스 휠로 올라갈 스크롤백이 생겨야 한다');
  assert.deepEqual(screen(restored), screen(plain));
  plain.dispose();
  restored.dispose();
});
