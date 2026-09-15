'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { commandFor, pasted } = require('../session-actions');

test('Claude와 Codex 모두 컨텍스트 압축 명령을 지원한다', () => {
  assert.equal(commandFor('claude', 'compact'), '/compact');
  assert.equal(commandFor('codex', 'compact'), '/compact');
});

test('허용하지 않은 세션 명령은 거부한다', () => {
  assert.throws(() => commandFor('claude', 'clear'));
  assert.throws(() => commandFor('other', 'compact'));
});

test('터미널 입력은 bracketed paste와 Enter로 감싼다', () => {
  assert.equal(pasted('/compact'), '\x1b[200~/compact\x1b[201~\r');
  assert.equal(pasted('a\x1bb\x00c'), '\x1b[200~abc\x1b[201~\r');
});
