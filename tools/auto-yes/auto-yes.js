#!/usr/bin/env node
// 자동 Yes - Claude Code / Codex 의 권한 승인 메뉴를 훅으로 자동 허용한다.
//
//   Do you want to proceed?            Would you like to run the following command?
//   ❯ 1. Yes                           › 1. Yes, proceed (y)
//
// 두 CLI 모두 그 메뉴를 띄우기 직전에 PermissionRequest 훅을 부른다. 훅이
// {"decision":{"behavior":"allow"}} 를 돌려주면 메뉴 없이 진행된다. 같은 설정을 쓰므로
// 일반 터미널, Claude 데스크톱 앱의 Code 탭, Codex 앱에 모두 걸린다.
//
// 스위치는 파일 하나(%USERPROFILE%\.auto-yes\on)다. 없으면 훅은 아무 말도 하지 않고
// 평소처럼 메뉴가 뜬다. 설치만 해서는 켜지지 않는다.
//
// 사용법:  node auto-yes.js install | uninstall | on | off | status
//          node auto-yes.js hook      (CLI 가 부르는 것 - 직접 쓸 일 없음)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// AUTO_YES_HOME 은 시험용이다. 실제 스위치를 켜지 않고 한 프로세스에서만 확인할 때 쓴다.
const HOME = process.env.AUTO_YES_HOME || path.join(os.homedir(), '.auto-yes');
const FLAG = path.join(HOME, 'on');
const LOG = path.join(HOME, 'log.txt');
const INSTALLED = path.join(HOME, 'auto-yes.js');
const CLAUDE_SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const CODEX_HOOKS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
const MARK = 'auto-yes';

// 켜져 있어도 자동으로 넘기지 않는 것. 이때는 평소처럼 메뉴가 떠서 사람이 고른다.
//  - 플랜 승인·질문: 권한이 아니라 사용자의 판단을 묻는 것
//  - 되돌리기 어려운 명령: 통째 삭제, 강제 푸시, 하드 리셋, 포맷, DB 삭제
const ALWAYS_ASK_TOOLS = /^(ExitPlanMode|AskUserQuestion)$/;
const ALWAYS_ASK_COMMANDS = [
  /\brm\s+(-\w*r\w*f|-\w*f\w*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/i,
  /\bRemove-Item\b[^|;]*-Recurse/i,
  /\b(rd|rmdir)\s+\/s\b/i,
  /\bdel\s+(\/\w\s+)*\/s\b/i,
  /\bgit\s+push\b[^|;]*(--force\b|--force-with-lease\b|\s-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\w*f/i,
  /\bformat\s+[a-z]:/i,
  /\bdrop\s+(table|database|schema)\b/i,
];

function alwaysAsk(input) {
  const tool = String(input.tool_name || '');
  if (ALWAYS_ASK_TOOLS.test(tool)) return 'tool ' + tool;
  const ti = input.tool_input || {};
  const cmd = typeof ti === 'string' ? ti : String(ti.command || ti.cmd || '');
  for (const re of ALWAYS_ASK_COMMANDS) if (re.test(cmd)) return 'risky command';
  return null;
}

function log(line) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + os.EOL);
    if (fs.statSync(LOG).size > 512 * 1024) {
      const rest = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).slice(-2000).join(os.EOL);
      fs.writeFileSync(LOG, rest);
    }
  } catch { /* 기록 실패로 승인 흐름을 막지 않는다 */ }
}

// CLI 가 부르는 부분. 무슨 일이 있어도 exit 0 이고, 판단이 안 서면 아무것도 출력하지
// 않는다 - 그러면 평소처럼 메뉴가 뜬다(안전한 쪽).
function hook() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  if (input.hook_event_name && input.hook_event_name !== 'PermissionRequest') return;
  if (!fs.existsSync(FLAG)) return;
  const who = (input.transcript_path && /[\\/]\.codex[\\/]/.test(input.transcript_path)) ? 'codex' : 'claude';
  const brief = String((input.tool_input && (input.tool_input.command || input.tool_input.file_path)) || '')
    .replace(/\s+/g, ' ').slice(0, 160);
  const why = alwaysAsk(input);
  if (why) { log('ASK   ' + who + ' ' + input.tool_name + ' (' + why + ') ' + brief); return; }
  log('ALLOW ' + who + ' ' + input.tool_name + ' ' + brief);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  }));
}

// ---------------------------------------------------------------- 설치 / 제거

// 남의 설정 파일을 고치므로 조심한다: 못 읽으면 손대지 않고, 백업을 남기고,
// 임시 파일에 쓴 뒤 다시 읽어 검증하고 나서 바꿔치기한다.
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(file + ' 을(를) JSON 으로 읽지 못해 건드리지 않았습니다: ' + e.message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(file + ' 형식이 예상과 다릅니다');
  return data;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.auto-yes.bak');
  const tmp = file + '.auto-yes.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + os.EOL);
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
}

function hookCommand() { return 'node "' + INSTALLED + '" hook'; }
function isOurs(entry) {
  return (entry && entry.hooks || []).some(h => String(h && h.command || '').includes(path.join('.auto-yes', 'auto-yes.js')));
}

// 우리 항목을 빼고, add 가 있으면 **맨 뒤에** 붙인다. Codex 는 훅 신뢰를 위치(0:0, 1:0 …)로
// 기억하므로 앞에 끼우면 기존 훅까지 "바뀌었다" 며 다시 신뢰를 묻는다.
function setEntry(file, add) {
  const data = readJson(file);
  if (data.hooks != null && (typeof data.hooks !== 'object' || Array.isArray(data.hooks)))
    throw new Error(file + ' 의 hooks 형식이 예상과 다릅니다');
  const hooks = data.hooks || {};
  const list = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest.filter(e => !isOurs(e)) : [];
  if (add) list.push(add);
  if (list.length) hooks.PermissionRequest = list; else delete hooks.PermissionRequest;
  if (Object.keys(hooks).length) data.hooks = hooks; else delete data.hooks;
  writeJson(file, data);
}

function install() {
  fs.mkdirSync(HOME, { recursive: true });
  if (path.resolve(__filename) !== path.resolve(INSTALLED)) fs.copyFileSync(__filename, INSTALLED);
  const cmd = hookCommand();
  setEntry(CLAUDE_SETTINGS, { matcher: '', hooks: [{ type: 'command', command: cmd, timeout: 10 }] });
  setEntry(CODEX_HOOKS, { matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 10, statusMessage: MARK }] });
  console.log('설치했습니다.');
  console.log('  Claude: ' + CLAUDE_SETTINGS);
  console.log('  Codex : ' + CODEX_HOOKS);
  console.log('');
  console.log('아직 꺼져 있습니다. on.bat 으로 켜세요.');
  console.log('Codex 는 다음 실행 때 "1 hook is new or changed" 가 뜹니다. 내용을 확인하고 Trust 를 골라야 동작합니다.');
  console.log('이미 열려 있는 Claude / Codex 세션과 앱은 다시 켜야 적용됩니다.');
}

function uninstall() {
  setEntry(CLAUDE_SETTINGS, null);
  setEntry(CODEX_HOOKS, null);
  try { fs.rmSync(FLAG, { force: true }); } catch {}
  console.log('제거했습니다. 기록은 ' + LOG + ' 에 남겨 두었습니다.');
}

function registered() {
  const has = file => { try { return (readJson(file).hooks?.PermissionRequest || []).some(isOurs); } catch { return false; } };
  return { claude: has(CLAUDE_SETTINGS), codex: has(CODEX_HOOKS) };
}

function status() {
  const r = registered();
  console.log('자동 Yes: ' + (fs.existsSync(FLAG) ? '켜짐' : '꺼짐'));
  console.log('  Claude 훅 ' + (r.claude ? '설치됨' : '없음') + '   Codex 훅 ' + (r.codex ? '설치됨' : '없음'));
  try {
    const tail = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/).slice(-5);
    console.log('최근 기록:');
    tail.forEach(l => console.log('  ' + l));
  } catch {}
}

function on() {
  const r = registered();
  if (!r.claude && !r.codex) { console.log('먼저 install.bat 을 실행하세요.'); process.exitCode = 1; return; }
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(FLAG, new Date().toISOString());
  console.log('자동 Yes 켜짐 - 권한 승인 메뉴를 자동으로 허용합니다. (재시작 필요 없음)');
  console.log('삭제·강제 푸시 같은 위험 명령과 플랜 승인은 계속 직접 고릅니다.');
}

function off() {
  try { fs.rmSync(FLAG, { force: true }); } catch {}
  console.log('자동 Yes 꺼짐 - 평소처럼 메뉴가 뜹니다.');
}

const cmd = process.argv[2];
const run = { hook, install, uninstall, on, off, status }[cmd];
if (require.main !== module) {
  // 테스트에서 require 한 경우
} else if (!run) {
  console.log('사용법: node auto-yes.js install | uninstall | on | off | status');
  process.exitCode = 1;
} else if (cmd === 'hook') {
  try { hook(); } catch { /* 훅은 절대 실패로 끝나지 않는다 */ }
} else {
  try { run(); } catch (e) { console.error('실패: ' + e.message); process.exitCode = 1; }
}

module.exports = { alwaysAsk };
