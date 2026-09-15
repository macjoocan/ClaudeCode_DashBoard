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

function pasted(text) {
  const clean = String(text == null ? '' : text)
    .replace(/\x1b/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return '\x1b[200~' + clean + '\x1b[201~\r';
}

module.exports = { commandFor, pasted, COMMANDS };
