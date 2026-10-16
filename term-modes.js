// 터미널 모드(대체 화면·마우스·커서 키 등)를 출력에서 따라가며 기억한다.
//
// 왜 필요한가: 서버는 패인마다 최근 출력(SCROLLBACK)만 들고 있다가 다시 붙을 때 그대로
// 재생한다. Codex 는 0.16x 부터 기본이 전체 화면 모드라 시작할 때 한 번 ESC[?1049h(대체 화면)
// 와 마우스 켜기를 보내고는 계속 화면만 다시 그린다. 그 첫 신호가 버퍼 앞에서 잘려 나가면,
// 새로고침한 브라우저는 일반 화면에 옛 프레임 조각을 쌓고 휠은 Codex 대신 그 조각을 굴린다
// - "위로 올리면 문장이 뒤죽박죽" 의 원인이었다.
//
// 그래서 잘려 나간 부분이 남긴 모드를 기억해 두고, 재생 앞에 그 상태를 다시 깔아 준다.
'use strict';

const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;
// 1 커서 키 · 25 커서 표시 · 47/1047/1049 대체 화면 · 1000/1002/1003/1006/1015 마우스 · 2004 붙여넣기
const TRACKED = new Set(['1', '25', '47', '1047', '1049', '1000', '1002', '1003', '1006', '1015', '2004']);
const DEFAULT_ON = new Set(['25']);

function applyModes(state, text) {
  MODE_RE.lastIndex = 0;
  let m;
  while ((m = MODE_RE.exec(String(text || '')))) {
    for (const n of m[1].split(';')) if (TRACKED.has(n)) state[n] = m[2];
  }
  return state;
}

// 기본값과 다른 것만 다시 켠다. 순서: 대체 화면 먼저(그 위에 그려야 하므로), 나머지는 뒤.
function modePrefix(state) {
  const keys = Object.keys(state || {}).sort((a, b) =>
    (['47', '1047', '1049'].includes(b) ? 1 : 0) - (['47', '1047', '1049'].includes(a) ? 1 : 0));
  let s = '';
  for (const n of keys) {
    const def = DEFAULT_ON.has(n) ? 'h' : 'l';
    if (state[n] !== def) s += '\x1b[?' + n + state[n];
  }
  return s;
}

// buf 에 d 를 붙이고 max 를 넘으면 앞을 잘라낸다. 잘려 나간 부분의 모드는 startModes 에 남긴다.
function appendTrim(buf, d, max, startModes) {
  buf += d;
  if (buf.length <= max) return buf;
  let cut = buf.length - max;
  // 자르는 자리가 제어열 한가운데면 그 제어열 앞에서 자른다. 반쪽짜리 ESC[?104 는
  // 어느 쪽에서도 모드로 읽히지 않아 대체 화면 신호가 통째로 사라진다.
  const esc = buf.lastIndexOf('\x1b', cut - 1);
  if (esc >= 0 && cut - esc < 32 && /^\x1b(\[[0-9;?]*)?$/.test(buf.slice(esc, cut))) cut = esc;
  applyModes(startModes, buf.slice(0, cut));
  return buf.slice(cut);
}

module.exports = { applyModes, modePrefix, appendTrim };
