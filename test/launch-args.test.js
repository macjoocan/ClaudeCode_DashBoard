// 세션 하나를 따로 새 창으로 띄우는 '창으로' 버튼이 쓰는 인자.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { wtArgs } = require('../launch-args');

const base = { cwd: 'D:\\proj', title: '앱 작업', inner: '& claude --resume abc' };

test('기본은 -w 0 - 이미 떠 있는 창에 탭으로 붙는다', () => {
  const a = wtArgs(base);
  assert.equal(a[0], '-w');
  assert.equal(a[1], '0');
});

test('newWindow 면 -w -1 - 매번 새 창', () => {
  const a = wtArgs(Object.assign({}, base, { newWindow: true }));
  assert.equal(a[0], '-w');
  assert.equal(a[1], '-1');
});

test('실행 폴더·제목·명령을 그대로 싣는다', () => {
  const a = wtArgs(base);
  assert.equal(a[a.indexOf('-d') + 1], 'D:\\proj');
  assert.equal(a[a.indexOf('--title') + 1], '앱 작업');
  assert.equal(a[a.length - 1], '& claude --resume abc');
});

test('제목이 없어도 인자 자리는 비지 않는다', () => {
  // 자리 하나가 빠지면 뒤 인자가 밀려 -d 가 제목으로 먹힌다
  const a = wtArgs(Object.assign({}, base, { title: null }));
  assert.equal(a[a.indexOf('--title') + 1], '');
  assert.equal(a[a.indexOf('-d') + 1], 'D:\\proj');
});

test('powershell 은 -NoExit 로 띄운다 - 세션이 끝나도 창이 남아야 내용을 본다', () => {
  const a = wtArgs(base);
  assert.ok(a.includes('powershell.exe'));
  assert.ok(a.includes('-NoExit'));
});
