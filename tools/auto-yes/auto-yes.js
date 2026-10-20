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
const VERSION = '1.2.0';

// 통째 삭제는 옵션을 쓰는 방식이 너무 많아 정규식 대신 토막을 나눠 본다.
//   rm -rf, rm -rfv, rm -R -f, rm -r --force, rm -Recurse -Force, rm -r -fo, ri x -Recurse ...
// rm 은 재귀+강제가 같이 있어야, Remove-Item / ri 는 재귀만 있어도 묻는다(PowerShell 의 rm 도
// Remove-Item 별칭이지만 rm -r 만 쓰는 일은 흔해서 예전처럼 둔다).
// 한 글자 옵션 묶음은 유닉스 rm 의 옵션 글자만 인정한다. 그래야 -Filter 같은 PowerShell 인자를
// -f -r 로 잘못 읽지 않는다. PowerShell 은 인자 이름을 앞부분만 써도 되므로(-rec, -fo) 접두로 본다.
const RECURSIVE_DELETE = {
  test(cmd) {
    for (const seg of cmd.split(/[|;&\r\n]+/)) {
      const words = seg.trim().split(/\s+/).map(w => w.replace(/^["'(]+/, ''));
      const at = words.findIndex(w => /^(rm|ri|remove-item)$/i.test(path.basename(w)));
      if (at < 0) continue;
      let r = false, f = false;
      for (const w of words.slice(at + 1)) {
        const o = w.toLowerCase();
        if (o === '--recursive') r = true;
        else if (o === '--force') f = true;
        else if (/^-[a-z]+$/.test(o)) {
          const b = o.slice(1);
          if ('recurse'.startsWith(b)) r = true;
          else if ('force'.startsWith(b)) f = true;
          else if (/^[rfidv]+$/.test(b)) { r = r || b.includes('r'); f = f || b.includes('f'); }
        }
      }
      if (r && (f || !/^rm$/i.test(path.basename(words[at])))) return true;
    }
    return false;
  },
};

// 켜져 있어도 자동으로 넘기지 않는 것. 이때는 평소처럼 메뉴가 떠서 사람이 고른다.
//  - 플랜 승인·질문: 권한이 아니라 사용자의 판단을 묻는 것
//  - 되돌리기 어려운 명령: 통째 삭제, 강제 푸시·원격 브랜치 삭제, 작업 내용 버리기, 포맷, DB 삭제
const ALWAYS_ASK_TOOLS = /^(ExitPlanMode|AskUserQuestion)$/;
const ALWAYS_ASK_COMMANDS = [
  RECURSIVE_DELETE,
  /\b(rd|rmdir)\b[^|;&]*\s\/s\b/i,               // /s 가 어디에 있든 (rmdir /q /s)
  /\b(del|erase)\b[^|;&]*\s\/s\b/i,
  /\bfind\b[^|;&]*\s-delete\b/i,
  // origin +main 도 강제 푸시, origin :main 은 --delete 와 같다
  /\bgit\s+push\b[^|;]*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S|--delete\b|\s-d\b|--mirror\b|--prune\b|\s:\S)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\w*f/i,
  // 커밋 안 한 변경을 버리는 것. -D / -S 는 대소문자가 뜻을 가르므로 i 를 붙이지 않는다.
  /\bgit\s+checkout\b[^|;&]*\s(--(\s|$)|\.(\s|$)|-f\b|--force\b)/,
  /\bgit\s+restore\b(?![^|;&]*\s(--staged|-S)\b)/,  // --staged 만 쓰면 스테이징만 푸는 것
  /\bgit\s+restore\b[^|;&]*\s(--worktree|-W)\b/,
  /\bgit\s+branch\b[^|;&]*\s(-D\b|--delete\b[^|;&]*\s(--force|-f)\b|(--force|-f)\b[^|;&]*\s--delete\b)/,
  /\bformat\s+[a-z]:/i,
  /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i,
];

// Codex 는 명령을 ["bash", "-lc", "..."] 같은 배열로 줄 수도 있다. 그대로 String() 하면
// "rm,-rf,x" 가 되어 어떤 식에도 안 걸리므로 공백으로 잇는다.
function commandOf(ti) {
  if (typeof ti === 'string') return ti;
  const c = ti.command || ti.cmd || '';
  return Array.isArray(c) ? c.join(' ') : String(c);
}

function alwaysAsk(input) {
  const tool = String(input.tool_name || '');
  if (ALWAYS_ASK_TOOLS.test(tool)) return 'tool ' + tool;
  const cmd = commandOf(input.tool_input || {});
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
  const ti = input.tool_input || {};
  const brief = (commandOf(ti) || String(ti.file_path || ''))
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
  // 백업은 처음 한 번만 만든다. 매번 덮으면 설치 -> 제거 뒤 남는 건 설치된 상태의 파일이라
  // 원래 설정으로 돌아갈 길이 사라진다.
  const bak = file + '.auto-yes.orig.bak';
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  const tmp = file + '.auto-yes.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + os.EOL);
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
}

function hookCommand() { return 'node "' + INSTALLED + '" hook'; }
// 기본 위치(.auto-yes) 와 실제 설치 위치(AUTO_YES_HOME 을 쓰면 다르다) 둘 다 우리 것으로 본다.
// 하나만 보면 설치할 때마다 항목이 쌓이고 제거도 안 된다.
function isOurs(entry) {
  const mine = [path.join('.auto-yes', 'auto-yes.js'), INSTALLED].map(s => s.toLowerCase());
  return (entry && entry.hooks || []).some(h => {
    const c = String(h && h.command || '').toLowerCase();
    return mine.some(m => c.includes(m));
  });
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
  console.log('Codex 는 훅을 "신뢰" 해야 동작합니다. 터미널에서 codex 를 한 번 켜서');
  console.log('  "1 hook is new or changed" 가 뜨면 Trust all and continue 를 고르세요.');
  console.log('  Codex 앱은 이 확인을 띄우지 않으므로, 앱만 쓰더라도 터미널에서 한 번은 해야 합니다.');
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
  console.log('자동 Yes ' + VERSION + ': ' + (fs.existsSync(FLAG) ? '켜짐' : '꺼짐'));
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
