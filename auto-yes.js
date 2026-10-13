// 터미널별 "자동 Yes": 권한 승인 메뉴가 뜨면 대신 Enter 를 누른다.
//
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. No
//
// permission-mode.js 의 '묻지 않기' 는 CLI 플래그로 질문 자체를 없앤다. 재시작이 필요하고
// Codex 는 샌드박스까지 풀린다. 이건 반대로 CLI 설정은 그대로 두고, 화면에 뜬 승인
// 메뉴만 골라 1번(Yes)을 고른다. 켜고 끄는 데 재시작이 없다.
//
// 오검출 방향을 정해 둔다: 애매하면 **누르지 않는다**. 못 누르면 사용자가 직접 누르면
// 그만이지만, 엉뚱한 메뉴(업데이트·폴더 신뢰·플랜 승인)를 고르거나 대화창에 Enter 가
// 들어가면 되돌릴 수 없다.
'use strict';

// 화면 글자만 남긴다. tui-state 의 screenTail 은 제어열을 지우기만 하는데, 실측해 보니
// Claude 는 띄어쓰기를 커서 전진(ESC[1C)으로, 줄바꿈을 절대 위치(ESC[14;2H)로 그린다.
// 지우기만 하면 "Doyouwanttoproceed?" 한 줄이 돼서 아무것도 안 맞는다.
// 그래서 전진은 공백으로, 위치 지정은 줄바꿈으로 바꾼 뒤 나머지를 지운다.
const TAIL = 3000;
function screenTail(raw) {
  const NL = String.fromCharCode(10);
  const s = String(raw || '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')          // OSC (하이퍼링크 등)
    .replace(/\u001b\[\d*(;\d*)?[Hf]/g, NL)                               // 커서 위치 지정
    .replace(/\u001b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(Number(n) || 1, 200)))
    .replace(/\u001b\[[0-9;?<>=]*[ -\/]*[@-~]|\u001b[()][A-Za-z0-9]|\u001b[=>]/g, '')
    .replace(/[⠀-⣿]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return s.length > TAIL ? s.slice(-TAIL) : s;
}

// 승인 질문. Claude: "Do you want to proceed?" / "Do you want to make this edit to x?"
// Codex: "Would you like to run the following command?" / "... make the following edits?"
const QUESTION = /Do you want to (proceed|make|create|allow|run|use|delete|overwrite)\b|Would you like to (run|make|apply)\b/i;

// 이 말이 같이 보이면 권한 승인이 아니다. 사용자가 정할 일이라 건드리지 않는다.
const NOT_APPROVAL = /trust (the|this)|Update (available|now)|\bplan\b/i;

// 선택 커서가 마지막으로 그려진 줄. 사용자가 화살표로 No 로 옮겼으면 거기가 마지막이다.
const CURSOR = /[❯›>]\s*([1-9])[.)]\s*(\S+)/g;

// 이 출력 조각에 "지금 1번 Yes 에 커서가 있는 승인 메뉴" 가 있나.
function approvalPrompt(raw) {
  const tail = screenTail(raw);
  if (!QUESTION.test(tail) || NOT_APPROVAL.test(tail)) return false;
  if (!/\b2[.)]\s*\S/.test(tail)) return false;            // 선택지가 둘 이상이어야 메뉴다
  let last = null, m;
  CURSOR.lastIndex = 0;
  while ((m = CURSOR.exec(tail))) last = m;
  return !!last && last[1] === '1' && /^Yes\b/i.test(last[2]);
}

const SETTLE_MS = 350;       // 메뉴가 다 그려질 때까지 기다린다
const COOLDOWN_MS = 1500;    // 한 번 누른 뒤 화면이 바뀔 시간
const MAX_PER_MIN = 20;      // 넘으면 무언가 잘못 돌고 있는 것 - 끈다
const FRESH_MAX = 16 * 1024;

// PTY 출력마다 부른다. 마지막으로 누른 뒤에 **새로 나온 출력만** 본다.
// 스크롤백 전체를 보면 이미 답한 옛 메뉴를 보고 또 Enter 를 친다.
function onOutput(t, d, write) {
  if (!t.autoYes) return;
  // 이어하기 재생은 지난 대화다. 그 안의 옛 메뉴에 답하면 안 된다.
  if (t.hold) { t.ayFresh = ''; return; }
  t.ayFresh = ((t.ayFresh || '') + d).slice(-FRESH_MAX);
  if (t.ayTimer) clearTimeout(t.ayTimer);
  t.ayTimer = setTimeout(() => {
    t.ayTimer = null;
    if (!t.autoYes || t.hold || t.exitCode != null) return;
    const now = Date.now();
    if (now - (t.ayLastAt || 0) < COOLDOWN_MS) return;
    if (!approvalPrompt(t.ayFresh)) return;
    t.ayLog = (t.ayLog || []).filter(at => now - at < 60000);
    if (t.ayLog.length >= MAX_PER_MIN) { t.autoYes = false; return; }
    t.ayLog.push(now);
    t.ayLastAt = now;
    t.ayFresh = '';
    t.ayCount = (t.ayCount || 0) + 1;
    write(String.fromCharCode(13));
  }, SETTLE_MS);
  if (t.ayTimer.unref) t.ayTimer.unref();
}

function setAutoYes(t, on) {
  t.autoYes = !!on;
  t.ayFresh = '';
  if (!on && t.ayTimer) { clearTimeout(t.ayTimer); t.ayTimer = null; }
}

module.exports = { approvalPrompt, screenTail, onOutput, setAutoYes, MAX_PER_MIN };
