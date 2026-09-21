// CLI 화면이 "지금 입력을 받아도 되는 상태인지" 판정한다.
//
// 왜 필요한가: 메시지 전달(bridge)과 AI 전환(handoff)은 "출력이 잠잠해지면 쓴다" 로
// 시점을 잡았다. 그런데 Codex 는 시작 직후 **모달 프롬프트**를 띄우는 일이 잦다.
//
//   Resuming session…
//   ✨ Update available! 0.155.0 -> 0.155.1
//   › 1. Update now   2. Skip   3. Skip until next version
//     Press enter to continue
//
// 이때 화면은 조용하다. 그래서 전달이 나가고, 붙여넣기는 대화창이 아니라 **메뉴로**
// 들어간다(실측: 컴포저에 '[' 한 글자만 남고 나머지는 먹혔다). 뒤따르는 Enter 가
// 메뉴 항목을 골라버리는 것까지가 한 세트다. 겉으로는 delivered 로 보이는데 상대는
// 아무것도 못 받은 상태 - Claude -> Codex 전달이 안 되던 진짜 이유다.
//
// 자동으로 answer 하지 않는다. 업데이트 설치·폴더 신뢰는 사용자가 정할 일이지
// 전달 기능이 대신 누를 일이 아니다. 여기서는 **기다려야 한다는 사실만** 알린다.
'use strict';

const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Za-z0-9]|\u001b[=>]/g;
const SPINNER_RE = /[⠀-⣿]/g;

// 화면 끝 쪽만 본다. 위로 흘러간 옛 출력에 같은 문구가 있었다고 지금 막혀 있는 건 아니다.
const TAIL = 2000;

// 실측한 프롬프트들. 문구가 바뀌어도 오검출로 기울지 않게 짧고 특징적인 것만 쓴다.
const MARKERS = [
  { re: /Press enter to continue/i,              why: '확인 프롬프트' },
  { re: /Do you trust the contents of this dir/i, why: '폴더 신뢰 확인' },
  { re: /Update available/i,                      why: '업데이트 알림' },
  { re: /Do you want to proceed\?/i,              why: '권한 승인' },
  { re: /\bl\. Yes,? (continue|proceed)/i,        why: '선택 메뉴' },
];

function screenTail(raw) {
  const s = String(raw || '')
    .replace(ANSI_RE, '')
    .replace(SPINNER_RE, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return s.length > TAIL ? s.slice(-TAIL) : s;
}

// 번호 매긴 선택지가 보이면 메뉴가 떠 있는 것으로 본다.
//
// 번호 목록만으로는 못 가른다 - 인수인계 요약문에도 "1. 목표와 요구사항", "2. 주요 결정"
// 같은 줄이 그대로 들어간다(실측: 그것 때문에 전환이 영구히 막혔다). 오검출은 기능을
// 통째로 세우므로 미검출보다 나쁘다.
// 실제 메뉴는 선택 커서(› ❯ >)가 번호 줄에 붙는다:
//     › 1. Update now (...)
//       2. Skip
// 그래서 **번호 줄이 둘 이상이고, 그중 하나에 선택 커서가 붙어 있을 때만** 메뉴로 본다.
const NUMBERED = /^\s*([>›❯*]\s*)?([1-9])[.)]\s+\S/;
function menuLines(tail) {
  let n = 0;
  let cursor = false;
  for (const line of tail.split(String.fromCharCode(10))) {
    const m = NUMBERED.exec(line);
    if (!m) continue;
    n++;
    if (m[1]) cursor = true;
  }
  return cursor ? n : 0;
}

// 막혀 있으면 사유 문자열, 입력해도 되면 null.
function pendingPrompt(raw) {
  const tail = screenTail(raw);
  if (!tail.trim()) return null;
  for (const m of MARKERS) if (m.re.test(tail)) return m.why;
  if (menuLines(tail) >= 2) return '선택 메뉴';
  return null;
}

module.exports = { pendingPrompt, screenTail, menuLines };
