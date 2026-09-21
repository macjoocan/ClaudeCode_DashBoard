'use strict';

// Slash commands are submitted through ConPTY exactly like a user paste + Enter.
// Clear is intentionally not mapped here: the server starts a fresh CLI process so
// both providers get a truly empty context even if their slash-command names drift.
const COMMANDS = Object.freeze({
  claude: Object.freeze({ compact: '/compact' }),
  codex: Object.freeze({ compact: '/compact' }),
});

function commandFor(provider, action) {
  const commands = COMMANDS[provider];
  if (!commands || !commands[action]) throw new Error('지원하지 않는 세션 명령입니다');
  return commands[action];
}

// 붙여넣기 뒤 Enter 를 **따로** 보낸다.
//
// 실측(2026-09-21): Codex 는 붙여넣기 종료 표시(ESC[201~) 바로 뒤에 이어붙인 CR 을
// 제출로 받지 않는다. 본문이 컴포저에 남아 있다가, 별도로 Enter 를 한 번 더 보내자
// 그제야 대화로 들어갔다(세션 기록에 그때 처음 남았다). Claude Code 는 이어붙여도
// 제출되므로, 이 차이 때문에 Codex -> Claude 는 되고 Claude -> Codex 만 안 됐다.
//
// write 는 성공 여부를 돌려주는 함수(terminals.write)를 그대로 받는다.
function submitPaste(write, id, text, delayMs) {
  if (!write(id, pasted(text))) return false;
  const wait = delayMs == null ? 250 : delayMs;
  setTimeout(() => { try { write(id, ENTER); } catch {} }, wait);
  return true;
}

const ENTER = '\r';

function pasted(text) {
  const clean = String(text == null ? '' : text)
    .replace(/\x1b/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return '\x1b[200~' + clean + '\x1b[201~';
}

module.exports = { commandFor, pasted, submitPaste, ENTER, COMMANDS };
