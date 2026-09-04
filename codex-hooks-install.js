// ~/.codex/hooks.json 에 런처 훅을 설치/제거한다.
// 기존 hooks-install.js 와 같은 안전장치를 쓴다 - 백업, 임시 파일에 쓰고
// 다시 파싱해 검증한 뒤 rename, 우리 항목만 식별해 남의 훅은 안 건드린다.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const HOOKS_FILE = path.join(CODEX_HOME, 'hooks.json');
const SCRIPT = path.join(__dirname, 'codex-hook.js');
const DEFAULT_URL = 'http://127.0.0.1:7788/api/hook';

// SessionEnd 는 항상 동기이고 타임아웃이 1~3초다. 나머지는 async 로 뺀다.
const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
                'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
                'PreCompact', 'PostCompact'];

// url 을 명령줄 인자로 넘겨 codex-hook.js 에 박아 넣는다. CC_LAUNCHER_PORT 로
// 런처가 기본 포트(7788)가 아닌 포트에서 떠 있을 때도 훅이 올바른 곳으로 POST 하게 하려는 것.
// isOurs() 는 여전히 "codex-hook.js" 스크립트 경로로만 우리 항목을 식별하므로
// 여기 인자를 추가해도 식별에는 영향이 없다.
function entryFor(event, url) {
  const h = {
    type: 'command',
    command: `"${process.execPath}" "${SCRIPT}" "${url || DEFAULT_URL}"`,
    statusMessage: 'cc-launcher',
  };
  if (event === 'SessionEnd' || event === 'Interrupt') h.timeout = 3;
  else { h.async = true; h.timeout = 30; }
  return { matcher: '*', hooks: [h] };
}

function isOurs(entry) {
  return (entry?.hooks || []).some(h => String(h.command || '').includes('codex-hook.js'));
}

function readFile() {
  if (!fs.existsSync(HOOKS_FILE)) return { text: '', data: {} };
  const text = fs.readFileSync(HOOKS_FILE, 'utf8');
  if (!text.trim()) return { text, data: {} };
  return { text, data: JSON.parse(text) };   // 깨졌으면 여기서 던진다
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
  if (!back || typeof back !== 'object') { fs.unlinkSync(tmp); throw new Error('검증 실패'); }
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
  const { text, data } = readFile();
  const bak = backup(text);
  data.hooks = data.hooks || {};
  for (const ev of EVENTS) {
    const list = (data.hooks[ev] || []).filter(e => !isOurs(e));
    list.push(entryFor(ev, url));
    data.hooks[ev] = list;
  }
  const bytes = writeSafely(data);
  return { ok: true, installed: EVENTS.slice().sort(), backup: bak, bytes, file: HOOKS_FILE };
}

function uninstall() {
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

module.exports = { status, install, uninstall, HOOKS_FILE, EVENTS };
