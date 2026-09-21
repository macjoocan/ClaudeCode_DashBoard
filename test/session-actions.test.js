'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { commandFor, pasted, submitPaste } = require('../session-actions');

test('Claude와 Codex 모두 컨텍스트 압축 명령을 지원한다', () => {
  assert.equal(commandFor('claude', 'compact'), '/compact');
  assert.equal(commandFor('codex', 'compact'), '/compact');
});

test('허용하지 않은 세션 명령은 거부한다', () => {
  assert.throws(() => commandFor('claude', 'clear'));
  assert.throws(() => commandFor('other', 'compact'));
});

// Codex 는 201~ 바로 뒤에 이어붙인 CR 을 제출로 받지 않는다(실측 2026-09-21).
// 그래서 pasted() 는 붙여넣기까지만 만들고, Enter 는 submitPaste 가 따로 보낸다.
test('pasted 는 bracketed paste 로만 감싸고 Enter 는 붙이지 않는다', () => {
  assert.equal(pasted('/compact'), '\x1b[200~/compact\x1b[201~');
  assert.equal(pasted('a\x1bb\x00c'), '\x1b[200~abc\x1b[201~');
});

test('submitPaste 는 붙여넣기와 Enter 를 나눠 보낸다', async () => {
  const seen = [];
  const ok = submitPaste((id, d) => { seen.push(d); return true; }, 't1', 'hello', 5);
  assert.equal(ok, true);
  assert.equal(seen.length, 1, '먼저 붙여넣기만 보낸다');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(seen.length, 2);
  assert.equal(seen[1], '\r', '뒤이어 Enter 를 따로 보낸다');
});

test('submitPaste 는 붙여넣기가 실패하면 Enter 를 보내지 않는다', async () => {
  const seen = [];
  const ok = submitPaste((id, d) => { seen.push(d); return false; }, 't1', 'hello', 5);
  assert.equal(ok, false);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(seen.length, 1);
});
