// ~/.claude/settings.json 의 hooks 에 "런처 관측용 http 훅" 을 설치/제거한다.
//
// type:"http" 훅이라 프로세스를 띄우지 않고 Claude Code 가 이 서버로 바로 POST 한다.
// 우리가 넣은 항목만 url 로 식별해서 지우므로, 사용자가 직접 넣은 훅은 건드리지 않는다.
//
// 설정 파일은 권한 규칙 등 중요한 내용이 들어 있으므로:
//   1) 쓰기 전에 타임스탬프 백업을 만든다
//   2) 임시 파일에 쓰고 다시 파싱해 확인한 뒤 교체한다 (반쯤 쓰인 파일이 남지 않게)

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARK = 'cc-launcher';          // 우리 훅을 식별하는 표시

// 관측에 쓰는 이벤트. 툴 단위까지 볼지는 mode 로 고른다.
const LIFECYCLE = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure',
                   'SubagentStart', 'SubagentStop', 'Notification', 'PreCompact', 'PostCompact'];
const TOOLS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];

function eventsFor(mode) {
  return mode === 'full' ? LIFECYCLE.concat(TOOLS) : LIFECYCLE.slice();
}

function hookEntry(url) {
  return {
    matcher: '*',
    hooks: [{
      type: 'http',
      url: url,
      timeout: 5,
      statusMessage: MARK,
    }],
  };
}

function isOurs(entry, url) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(h => h && h.type === 'http' && typeof h.url === 'string'
    && (h.url === url || h.url.indexOf('/api/hook') >= 0 && /127\.0\.0\.1|localhost/.test(h.url)));
}

function readSettings() {
  const text = fs.readFileSync(SETTINGS, 'utf8');
  return { text, data: JSON.parse(text) };
}

function backup(text) {
  const p = n => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  const file = SETTINGS + '.bak_' + stamp;
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

// 임시 파일 -> 재파싱 검증 -> 교체
function writeSafely(data) {
  const out = JSON.stringify(data, null, 2);
  const tmp = SETTINGS + '.tmp_' + process.pid;
  fs.writeFileSync(tmp, out, 'utf8');
  const back = JSON.parse(fs.readFileSync(tmp, 'utf8'));   // 다시 읽어서 유효성 확인
  if (!back || typeof back !== 'object') { fs.unlinkSync(tmp); throw new Error('검증 실패'); }
  fs.renameSync(tmp, SETTINGS);
  return out.length;
}

function status(url) {
  let data;
  try { data = readSettings().data; } catch (e) { return { ok: false, error: String(e.message) }; }
  const hooks = data.hooks || {};
  const installed = [];
  for (const [ev, entries] of Object.entries(hooks)) {
    for (const entry of (entries || [])) if (isOurs(entry, url)) installed.push(ev);
  }
  const otherHooks = {};
  for (const [ev, entries] of Object.entries(hooks)) {
    const n = (entries || []).filter(e => !isOurs(e, url)).length;
    if (n) otherHooks[ev] = n;
  }
  return {
    ok: true,
    installed: installed.sort(),
    mode: installed.some(e => TOOLS.indexOf(e) >= 0) ? 'full' : (installed.length ? 'lifecycle' : null),
    otherHooks,
    file: SETTINGS,
    available: { lifecycle: LIFECYCLE, tools: TOOLS },
  };
}

function install(url, mode) {
  const { text, data } = readSettings();
  const bak = backup(text);
  data.hooks = data.hooks || {};

  // 먼저 기존 우리 항목을 전부 걷어낸다 (모드 변경 시 중복되지 않게)
  for (const ev of Object.keys(data.hooks)) {
    data.hooks[ev] = (data.hooks[ev] || []).filter(e => !isOurs(e, url));
    if (!data.hooks[ev].length) delete data.hooks[ev];
  }

  const events = eventsFor(mode);
  for (const ev of events) {
    data.hooks[ev] = (data.hooks[ev] || []).concat([hookEntry(url)]);
  }
  if (!Object.keys(data.hooks).length) delete data.hooks;

  const bytes = writeSafely(data);
  return { ok: true, installed: events.sort(), mode: mode === 'full' ? 'full' : 'lifecycle',
           backup: bak, bytes };
}

function uninstall(url) {
  const { text, data } = readSettings();
  const bak = backup(text);
  let removed = 0;
  for (const ev of Object.keys(data.hooks || {})) {
    const before = (data.hooks[ev] || []).length;
    data.hooks[ev] = (data.hooks[ev] || []).filter(e => !isOurs(e, url));
    removed += before - data.hooks[ev].length;
    if (!data.hooks[ev].length) delete data.hooks[ev];
  }
  if (data.hooks && !Object.keys(data.hooks).length) delete data.hooks;
  const bytes = writeSafely(data);
  return { ok: true, removed, backup: bak, bytes };
}

module.exports = { status, install, uninstall, SETTINGS, LIFECYCLE, TOOLS };

// CLI: node hooks-install.js status|install [full]|uninstall
if (require.main === module) {
  const url = process.env.CC_HOOK_URL || 'http://127.0.0.1:7788/api/hook';
  const cmd = process.argv[2] || 'status';
  try {
    if (cmd === 'install') console.log(JSON.stringify(install(url, process.argv[3]), null, 2));
    else if (cmd === 'uninstall') console.log(JSON.stringify(uninstall(url), null, 2));
    else console.log(JSON.stringify(status(url), null, 2));
  } catch (e) {
    console.error('실패:', e.message);
    process.exit(1);
  }
}
