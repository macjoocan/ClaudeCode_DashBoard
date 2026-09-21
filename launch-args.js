// 외부 터미널로 세션을 띄울 때 쓰는 실행 인자.
//
// server.js 안에 두면 단위 테스트를 붙일 수 없다(require 만 해도 서버가 뜬다).
// 순수 함수라 따로 뺀다.
'use strict';

// Windows Terminal 실행 인자.
//
//   -w 0    이미 떠 있는 창에 **탭**으로 붙인다 - 헤더의 실행 위치 '새 창' 기존 동작
//   -w -1   매번 **새 창**을 연다 - 세션 카드의 '창으로' 버튼
//
// 실측(2026-09-18, wt 1.x): 보이는 CASCADIA 최상위 창 수가
//   -w -1 → 3개에서 4개로 늘고, -w 0 → 3개 그대로(탭으로 붙음).
//
// 세션 하나만 따로 떼어 보려는데 탭으로 쌓이면 의미가 없다. 그래서 버튼 쪽만
// 새 창을 쓰고 기존 토글 동작은 건드리지 않는다 - 이미 그렇게 쓰던 사람이 있다.
function wtArgs({ cwd, title, inner, newWindow }) {
  return ['-w', newWindow ? '-1' : '0',
          'new-tab', '--title', String(title == null ? '' : title), '-d', cwd,
          'powershell.exe', '-NoExit', '-NoLogo', '-Command', inner];
}

module.exports = { wtArgs };
