// 세션 종료 버튼이 500 으로 먹통이 됐던 자리.
// taskkill 메시지는 콘솔 코드페이지(CP949)라 Node 가 UTF-8 로 읽으면 깨진다.
// 한글 문자열로 판정하면 안 되고 종료 코드로 봐야 한다.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { taskkillOutcome, NOT_FOUND } = require('../kill-result');

test('성공하면 killed', () => {
  assert.equal(taskkillOutcome(null), 'killed');
  assert.equal(taskkillOutcome(undefined), 'killed');
});

test('없는 프로세스(128)는 실패가 아니다', () => {
  assert.equal(NOT_FOUND, 128);
  assert.equal(taskkillOutcome({ code: 128 }), 'absent');
});

test('그 밖의 코드는 진짜 실패', () => {
  assert.equal(taskkillOutcome({ code: 1 }), 'failed');
  assert.equal(taskkillOutcome({ code: null }), 'failed');
});

// 실측으로 들어온 깨진 메시지. 예전 코드는 여기서 '찾을 수 없' 을 못 찾아 500 을 냈다.
test('메시지가 깨져 있어도 코드로 판정한다', () => {
  const mojibake = {
    code: 128,
    message: '����: ���μ��� "17656"��(��) ã�� �� �����ϴ�.',
  };
  assert.equal(taskkillOutcome(mojibake), 'absent');
});

test('메시지에 영문 not found 가 있어도 코드가 실패면 실패다', () => {
  // 메시지는 참고일 뿐 판정 근거가 아니다
  assert.equal(taskkillOutcome({ code: 1, message: 'process not found' }), 'failed');
});
