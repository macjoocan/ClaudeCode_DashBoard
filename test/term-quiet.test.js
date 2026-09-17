// Codex TUI 는 대기 중에도 점자 스피너를 매 프레임 다시 그린다.
// "바이트가 흘렀다 = 아직 작업 중" 으로 보면 이 터미널은 영영 조용해지지 않아서
// 메시지 전달(bridge)도 AI 전환(handoff)도 시작되지 않는다.
const { test } = require('node:test');
const assert = require('node:assert');

const HOME = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'ccl-quiet-'));
process.env.CODEX_HOME = HOME;

const terminals = require('../terminals.js');
const { paintOf, sameDir } = terminals;

const ESC = String.fromCharCode(27);

test('스피너 프레임만 든 출력은 화면 내용이 없다', () => {
  // 실제로 잡아 본 Codex 대기 프레임: 커서 모양 변경 + 점자 + 공백
  const frame = ESC + '[0 q' + ' ⢀⠁ ⠂⠄ ⠄⡀⠈⠁⠈⢀⠁⠠⢀⠄⠠⢀⢀⡀⠂' + ESC + '[0 q';
  assert.equal(paintOf(frame), '');
});

test('ANSI 색·커서 제어만 든 출력도 화면 내용이 없다', () => {
  assert.equal(paintOf(ESC + '[2J' + ESC + '[1;1H' + ESC + '[38;5;244m' + ESC + '[0m'), '');
});

test('진짜 글자가 섞이면 화면 내용으로 잡는다', () => {
  const out = ESC + '[32m' + '⠄⡀ Working on it' + ESC + '[0m';
  assert.equal(paintOf(out), 'Working on it');
});

test('OSC 제목 변경은 화면 내용이 아니다', () => {
  assert.equal(paintOf(ESC + ']0;codex' + String.fromCharCode(7)), '');
});

test('같은 화면을 다시 그리면 같은 paint 가 나온다 (변화 없음 판정용)', () => {
  const a = ESC + '[1;1H' + 'gpt-6-astra medium' + ESC + '[0m';
  const b = ESC + '[2;1H' + 'gpt-6-astra   medium';   // 커서 위치·공백만 다름
  assert.equal(paintOf(a), paintOf(b));
});

test('sameDir 은 구분자와 대소문자를 무시하고 비교한다', () => {
  assert.ok(sameDir('C:/tmp/codexprobe', 'C:\\tmp\\CodexProbe'));
  assert.ok(sameDir('D:\\99.기타\\', 'D:\\99.기타'));
  assert.ok(!sameDir('C:\\a', 'C:\\b'));
  assert.ok(!sameDir('', ''));            // 빈 cwd 끼리 우연히 맞는 일은 없어야 한다
});

// 같은 폴더에 Codex 터미널을 둘 이상 띄우면, 훅 없이 세션을 찾는 폴백이 셋 다
// '가장 최근 세션' 으로 몰릴 수 있다. 그러면 전달·AI 전환이 엉뚱한 패인으로 가고
// ID 복사도 남의 것을 준다.
test('같은 폴더의 두 Codex 패인이 한 세션을 같이 주장하지 않는다', () => {
  const dir = 'D:' + String.fromCharCode(92) + 'ccl-two-panes';
  const mk = (id, sessionId) => ({
    id, action: 'new', cwd: dir, sessionId, provider: 'codex', title: 'x', pid: 1,
    startedAt: 1000, lastAt: 1000, exitCode: null, exitedAt: null,
    cols: 80, rows: 24, buf: '', clients: new Set(),
  });
  // A 는 이미 세션을 잡았고, B 는 아직 못 잡은 상태
  const a = mk('tA', 'sess-1');
  const b = mk('tB', null);
  terminals._terms.set('tA', a);
  terminals._terms.set('tB', b);
  try {
    assert.equal(terminals.info(a).sessionId, 'sess-1');
    // B 는 A 가 쓰는 세션을 주워오면 안 된다 (후보가 그것뿐이면 null 이어야 한다)
    assert.notEqual(terminals.info(b).sessionId, 'sess-1');
  } finally {
    terminals._terms.delete('tA');
    terminals._terms.delete('tB');
  }
});
