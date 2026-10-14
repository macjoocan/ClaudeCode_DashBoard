'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { approvalPrompt, onOutput, setAutoYes, MAX_PER_MIN } = require('../auto-yes');

const NL = String.fromCharCode(10);
const lines = (...a) => a.join(NL);

const CLAUDE = lines(' Bash command', '   npm test', ' Do you want to proceed?',
  ' \u001b[36m❯\u001b[39m 1. Yes', '   2. Yes, and don\'t ask again for npm test commands', '   3. No');
const CODEX = lines('Would you like to run the following command?', '$ cargo test',
  '› 1. Yes, proceed (y)', '  2. Yes, and don\'t ask again (p)', '  3. No, and tell Codex what to do differently (esc)');

test('permission menus with the cursor on Yes are answered', () => {
  assert.equal(approvalPrompt(CLAUDE), true);
  assert.equal(approvalPrompt(CODEX), true);
  assert.equal(approvalPrompt(lines('Do you want to make this edit to a.js?', '❯ 1. Yes', '  2. No')), true);
});

test('anything that is not a plain permission prompt is left alone', () => {
  // 사용자가 커서를 No 로 옮겼다 - 마지막으로 그려진 커서가 기준
  assert.equal(approvalPrompt(CLAUDE + NL + lines('Do you want to proceed?', '  1. Yes', '❯ 2. No')), false);
  assert.equal(approvalPrompt(lines('Do you trust the contents of this directory?', '❯ 1. Yes, proceed', '  2. No, exit')), false);
  assert.equal(approvalPrompt(lines('✨ Update available!', '› 1. Update now', '  2. Skip')), false);
  assert.equal(approvalPrompt(lines('Would you like to proceed with this plan?', '❯ 1. Yes, and auto-accept edits', '  2. No')), false);
  assert.equal(approvalPrompt(lines('1. Yes this is just a list', '2. No')), false);   // 질문·커서 없음
  assert.equal(approvalPrompt('Do you want to proceed?'), false);                       // 메뉴 없음
  assert.equal(approvalPrompt(''), false);
});

function harness(t) {
  const writes = [];
  return { t, writes, feed(d) { onOutput(t, d, s => writes.push(s)); } };
}

test('answers once after the menu settles, only while enabled', ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness({});
  h.feed(CLAUDE);
  ctx.mock.timers.tick(1000);
  assert.deepEqual(h.writes, []);                    // 꺼져 있으면 아무것도 안 한다

  setAutoYes(h.t, true);
  h.feed(CLAUDE);
  ctx.mock.timers.tick(100);
  assert.deepEqual(h.writes, []);                    // 아직 그리는 중
  ctx.mock.timers.tick(400);
  assert.deepEqual(h.writes, ['\r']);
  assert.equal(h.t.ayCount, 1);

  // 답한 뒤 나온 출력에는 메뉴가 없다 - 옛 메뉴에 또 누르지 않는다
  ctx.mock.timers.tick(3000);
  h.feed(lines('⏺ Bash(npm test)', '  ⎿  ok'));
  ctx.mock.timers.tick(1000);
  assert.deepEqual(h.writes, ['\r']);

  // 다음 승인 요청은 다시 누른다
  h.feed(CLAUDE);
  ctx.mock.timers.tick(1000);
  assert.deepEqual(h.writes, ['\r', '\r']);
});

test('resume replay is ignored and a runaway loop switches itself off', ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness({});
  setAutoYes(h.t, true);
  h.t.hold = {};
  h.feed(CLAUDE);
  h.t.hold = null;
  h.feed(lines('replay done'));
  ctx.mock.timers.tick(1000);
  assert.deepEqual(h.writes, []);

  for (let i = 0; i < MAX_PER_MIN + 5; i++) {
    h.feed(CLAUDE);
    ctx.mock.timers.tick(2000);
  }
  assert.equal(h.writes.length, MAX_PER_MIN);
  assert.equal(h.t.autoYes, false);
});

test('banners and words outside the menu do not block it (was the "sometimes" miss)', () => {
  assert.equal(approvalPrompt(lines('✨ Update available! Run: claude update', CLAUDE)), true);
  assert.equal(approvalPrompt(lines(' Bash command', '   cat docs/superpowers/plans/x.md', CLAUDE)), true);
  assert.equal(approvalPrompt(lines('Do you trust the contents of this directory?', 'ok', CLAUDE)), true);
  // 플랜 승인 메뉴 자체는 여전히 건드리지 않는다
  assert.equal(approvalPrompt(lines('Do you want to proceed?', '❯ 1. Yes, and auto-accept edits', '  2. Yes, and manually approve edits', '  3. No, keep planning')), false);
});

test('a menu that appears right after a press is answered once the cooldown ends', ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness({});
  setAutoYes(h.t, true);
  h.feed(CLAUDE);
  ctx.mock.timers.tick(400);
  assert.equal(h.writes.length, 1);
  h.feed(CLAUDE);                                     // 바로 다음 메뉴, 그 뒤 출력 없음
  for (let i = 0; i < 30; i++) ctx.mock.timers.tick(100);
  assert.equal(h.writes.length, 2);
});

test('output that never pauses still gets checked', ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness({});
  setAutoYes(h.t, true);
  h.feed(CLAUDE);
  for (let i = 0; i < 20; i++) { ctx.mock.timers.tick(100); h.feed(' '); }   // 100ms 마다 한 글자
  assert.equal(h.writes.length, 1);
});
