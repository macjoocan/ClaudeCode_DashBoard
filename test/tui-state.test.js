// 화면이 조용해도 모달 프롬프트가 떠 있으면 입력을 넣으면 안 된다.
// 실측(2026-09-21): Codex 를 이어하자 업데이트 알림이 떴고, 전달 메시지의
// 붙여넣기가 대화창이 아니라 그 메뉴로 들어갔다(컴포저엔 '[' 한 글자만 남았다).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { pendingPrompt, menuLines } = require('../tui-state');

const ESC = String.fromCharCode(27);
const NL = String.fromCharCode(10);

test('실측: Codex 업데이트 알림이 떠 있으면 막힌 것으로 본다', () => {
  const screen = [
    '  Resuming session…',
    '› [',
    '  ✨ Update available! 0.155.0 -> 0.155.1',
    '› 1. Update now (runs `npm install -g @openai/codex`)',
    '  2. Skip',
    '  3. Skip until next version',
    '  Press enter to continue',
  ].join(NL);
  assert.equal(pendingPrompt(screen), '확인 프롬프트');
});

test('폴더 신뢰 확인도 막힌 것으로 본다', () => {
  const screen = 'You are in C:' + String.fromCharCode(92) + 'tmp' + NL
    + 'Do you trust the contents of this directory?' + NL
    + '› 1. Yes, continue' + NL + '  2. No, quit';
  assert.equal(pendingPrompt(screen), '폴더 신뢰 확인');
});

test('선택 커서가 붙은 번호 선택지는 메뉴로 본다', () => {
  assert.equal(pendingPrompt('› 1. 이어서 진행' + NL + '  2. 취소'), '선택 메뉴');
  assert.equal(menuLines('› 1. 가' + NL + '  2. 나' + NL + '  3. 다'), 3);
});

// 실측: 인수인계 요약문에 "1. 목표와 요구사항" 같은 줄이 그대로 들어가는데,
// 그걸 메뉴로 오인해 전환이 영구히 막혔다. 오검출은 미검출보다 나쁘다.
test('커서 없는 번호 목록은 메뉴가 아니다 (요약문 오검출 방지)', () => {
  const summary = '## 인수인계' + NL + '1. 목표와 요구사항' + NL + '2. 주요 결정' + NL + '3. 남은 작업';
  assert.equal(pendingPrompt(summary), null);
  assert.equal(menuLines(summary), 0);
});

test('준비된 컴포저는 막히지 않은 것으로 본다', () => {
  const screen = ESC + '[32m' + '› Ask Codex to do anything' + ESC + '[0m' + NL
    + '  gpt-6-astra medium · C:' + String.fromCharCode(92) + 'proj';
  assert.equal(pendingPrompt(screen), null);
});

test('본문에 번호 목록이 하나 있는 건 메뉴가 아니다', () => {
  // 대화 중 "1. 먼저 …" 같은 문장 하나로 전달이 멈추면 안 된다
  const screen = '정리하면 이렇습니다.' + NL + '1. 파일을 읽고' + NL + '그 다음 고칩니다.';
  assert.equal(pendingPrompt(screen), null);
});

test('스피너와 ANSI 는 판정에 영향을 주지 않는다', () => {
  const spin = ESC + '[0 q' + ' ⢀⠁⠂⠄⡀⠈⠁ ' + ESC + '[0 q';
  assert.equal(pendingPrompt(spin), null);
});

test('빈 화면은 막히지 않은 것으로 본다', () => {
  assert.equal(pendingPrompt(''), null);
  assert.equal(pendingPrompt(null), null);
});

test('화면 끝만 본다 - 위로 흘러간 옛 프롬프트는 무시한다', () => {
  const old = 'Press enter to continue' + NL + 'x'.repeat(4000) + NL + '› Ask Codex to do anything';
  assert.equal(pendingPrompt(old), null);
});
