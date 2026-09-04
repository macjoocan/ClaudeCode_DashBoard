// ~/.codex/hooks.json 에 런처 훅을 설치/제거한다.
// 기존 hooks-install.js 와 같은 안전장치를 쓴다 - 백업, 임시 파일에 쓰고
// 다시 파싱해 검증한 뒤 rename, 우리 항목만 식별해 남의 훅은 안 건드린다.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const HOOKS_FILE = path.join(CODEX_HOME, 'hooks.json');
// codex-hook.js 가 실행 상태를 쓰는 디렉터리. codex.js 의 LIVE_DIR 과 같은 곳이지만
// 여기서 다시 계산한다 - codex.js 를 require 하면 그쪽 CODEX_HOME 이 먼저 로드된
// 시점의 값으로 굳어, 테스트처럼 CODEX_HOME 을 바꿔가며 이 모듈만 다시 require 하는
// 경우 엉뚱한 디렉터리를 가리킨다 (codex-hook.js 도 같은 이유로 따로 계산한다).
const LIVE_DIR = path.join(CODEX_HOME, '.cc-launcher-live');
const SCRIPT = path.join(__dirname, 'codex-hook.js');
const DEFAULT_URL = 'http://127.0.0.1:7788/api/hook';
const MARK = 'cc-launcher';   // 우리 항목만 골라내는 표시. isOurs() 가 이 값과 스크립트 경로를 함께 본다.

// SessionEnd 는 항상 동기이고 타임아웃이 1~3초다. 나머지는 async 로 뺀다.
const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
                'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
                'PreCompact', 'PostCompact'];

// 명령 문자열에 큰따옴표로 감싸 넣을 값이라 큰따옴표가 섞이면 명령이 깨지거나
// (Windows 에서는 인자 경계가 이스케이프 없이 밀릴 수 있다) 의도치 않은 인자
// 주입으로 이어질 수 있다. 이스케이프 대신 애초에 큰따옴표가 든 url 을 거부하고,
// url 자체가 URL 로서 유효한지도 확인한다. install() 이 export 되는 함수라
// 누가 어떤 문자열을 넘길지 보장할 수 없으므로 여기서 막는다.
function resolveUrl(url) {
  if (url === undefined || url === null) return DEFAULT_URL;
  const s = String(url);
  if (s.includes('"')) throw new Error(`훅 URL 에 큰따옴표(")를 포함할 수 없다: ${s}`);
  try { new URL(s); } catch { throw new Error(`훅 URL 이 올바르지 않다: ${s}`); }
  return s;
}

// url 을 명령줄 인자로 넘겨 codex-hook.js 에 박아 넣는다. CC_LAUNCHER_PORT 로
// 런처가 기본 포트(7788)가 아닌 포트에서 떠 있을 때도 훅이 올바른 곳으로 POST 하게 하려는 것.
// isOurs() 는 스크립트 경로 + MARK 로 우리 항목을 식별하므로 여기 인자를
// 추가해도(그리고 어떤 url 이 박히든) 식별에는 영향이 없다.
function entryFor(event, url) {
  const h = {
    type: 'command',
    command: `"${process.execPath}" "${SCRIPT}" "${url}"`,
    statusMessage: MARK,
  };
  if (event === 'SessionEnd' || event === 'Interrupt') h.timeout = 3;
  else { h.async = true; h.timeout = 30; }
  return { matcher: '*', hooks: [h] };
}

// command 가 codex-hook.js 를 가리키는 것 "그리고" 우리가 심은 MARK 가 있어야
// 우리 항목으로 본다. command 만 보면, 사용자가 직접 만든 훅이 우연히
// "codex-hook.js" 라는 글자를 포함하기만 해도(예: 그 파일을 감싸는 자기만의
// 래퍼 스크립트) 우리 것으로 오인해 install()/uninstall() 이 지워버릴 수 있다.
function isOurs(entry) {
  return (entry?.hooks || []).some(h =>
    String(h?.command || '').includes('codex-hook.js') && h?.statusMessage === MARK);
}

// hooks.json 최상위는 반드시 순수 객체여야 한다. 배열은 typeof 가 'object' 라
// 어설픈 검사를 통과하면서 data.hooks = data.hooks || {} 같은 대입은 조용히
// 받아주지만, JSON.stringify 는 배열의 비-인덱스 프로퍼티(.hooks 등)를 그냥
// 버린다 — 그러면 install() 이 "성공"을 보고하면서 실제로는 아무것도 쓰지
// 못하는 조용한 무동작이 된다. null/문자열/숫자도 같은 이유로 거부한다.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readFile() {
  if (!fs.existsSync(HOOKS_FILE)) return { text: '', data: {} };
  const text = fs.readFileSync(HOOKS_FILE, 'utf8');
  if (!text.trim()) return { text, data: {} };
  const data = JSON.parse(text);   // 깨졌으면 여기서 던진다
  if (!isPlainObject(data)) {
    throw new Error('hooks.json 최상위는 객체여야 한다 (배열/문자열/숫자/null 은 안 된다)');
  }
  return { text, data };
}

function backup(text) {
  if (!text) return null;
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const base = `${HOOKS_FILE}.bak_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_`
             + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let file = base, i = 1;
  while (fs.existsSync(file)) file = `${base}_${i++}`;
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function writeSafely(data) {
  const out = JSON.stringify(data, null, 2);
  const tmp = HOOKS_FILE + '.tmp_' + process.pid;
  fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });
  fs.writeFileSync(tmp, out, 'utf8');
  const back = JSON.parse(fs.readFileSync(tmp, 'utf8'));   // 재파싱 검증
  if (!isPlainObject(back)) { fs.unlinkSync(tmp); throw new Error('검증 실패'); }
  fs.renameSync(tmp, HOOKS_FILE);
  return out.length;
}

function status() {
  let data;
  try { data = readFile().data; } catch (e) { return { ok: false, error: String(e.message) }; }
  const hooks = data.hooks || {};
  const installed = [];
  const otherHooks = {};
  for (const [ev, entries] of Object.entries(hooks)) {
    for (const entry of (entries || [])) if (isOurs(entry)) installed.push(ev);
    const n = (entries || []).filter(e => !isOurs(e)).length;
    if (n) otherHooks[ev] = n;
  }
  return { ok: true, installed: installed.sort(), otherHooks, file: HOOKS_FILE, available: EVENTS };
}

function install(url) {
  const resolvedUrl = resolveUrl(url);   // 파일을 건드리기 전에 먼저 검증한다
  const { text, data } = readFile();
  const bak = backup(text);
  data.hooks = data.hooks || {};
  for (const ev of EVENTS) {
    const list = (data.hooks[ev] || []).filter(e => !isOurs(e));
    list.push(entryFor(ev, resolvedUrl));
    data.hooks[ev] = list;
  }
  const bytes = writeSafely(data);
  return { ok: true, installed: EVENTS.slice().sort(), backup: bak, bytes, file: HOOKS_FILE };
}

// 관측을 끄면 실행 상태 파일도 같이 치운다. 파일을 지우는 건 SessionEnd 훅인데
// 그 훅이 방금 사라졌으므로, 남겨두면 진행 중이던 세션이 LIVE_MAX_AGE(24시간)
// 동안 계속 '작업 중' 으로 보인다 - 그걸 지울 수단이 더는 없다.
function clearLive() {
  try { fs.rmSync(LIVE_DIR, { recursive: true, force: true }); } catch {}
}

function uninstall() {
  clearLive();
  // hooks.json 이 아예 없으면 아무것도 하지 않는다. 예전에는 그대로 진행해
  // writeSafely 가 {} 만 든 hooks.json 을 "새로 만들었다" - 지울 것도 없는데
  // 없던 사용자 파일을 만들어내는 건 되돌리기가 아니다.
  if (!fs.existsSync(HOOKS_FILE)) {
    return { ok: true, removed: [], backup: null, bytes: 0, file: HOOKS_FILE };
  }
  const { text, data } = readFile();
  const bak = backup(text);
  const removed = [];
  for (const [ev, entries] of Object.entries(data.hooks || {})) {
    const kept = (entries || []).filter(e => !isOurs(e));
    if (kept.length !== (entries || []).length) removed.push(ev);
    if (kept.length) data.hooks[ev] = kept; else delete data.hooks[ev];
  }
  const bytes = writeSafely(data);
  return { ok: true, removed: removed.sort(), backup: bak, bytes };
}

module.exports = { status, install, uninstall, HOOKS_FILE, LIVE_DIR, EVENTS };
