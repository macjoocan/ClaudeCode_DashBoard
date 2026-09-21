// taskkill 결과 판정.
//
// server.js 안에 두면 단위 테스트를 붙일 수 없어 따로 뺀다(require 만 해도 서버가 뜬다).
//
// **메시지 문자열로 판정하면 안 된다.** taskkill 은 콘솔 코드페이지로 출력하는데
// (한글 Windows 는 CP949) Node 는 UTF-8 로 읽으므로 한글이 깨진다. 실측:
//
//   오류: 프로세스 "17656"을(를) 찾을 수 없습니다.
//   -> "����: ���μ��� \"17656\"��(��) ã�� �� �����ϴ�."
//
// '찾을 수 없' 검사가 빗나가면서, 이미 죽은 프로세스를 끊으려던 것이 500 으로 튀었다.
// 세션 종료 버튼이 통째로 먹통이 된 원인이다. 종료 코드는 로케일을 타지 않는다.
'use strict';

const NOT_FOUND = 128;   // 실측: 없는 PID 에 taskkill 하면 128

// err 는 execFile 의 오류(성공이면 null/undefined).
//   'killed'  끊었다
//   'absent'  그런 프로세스가 없다 - 실패가 아니다. 결과는 어차피 '안 돌고 있음'
//   'failed'  진짜 실패
function taskkillOutcome(err) {
  if (!err) return 'killed';
  return err.code === NOT_FOUND ? 'absent' : 'failed';
}

module.exports = { taskkillOutcome, NOT_FOUND };
