// 설정 쓰기 계층. 대시보드에서 하네스·에이전트·스킬·MCP·플러그인을 바꾼다.
//
// 안전 원칙 (모든 쓰기에 공통 적용):
//   1) settings.json 은 쓰기 전에 타임스탬프 백업을 만든다
//   2) 임시 파일에 쓰고 다시 파싱해 확인한 뒤 rename 으로 교체한다 (반쯤 쓰인 파일이 안 남게)
//   3) 삭제는 지우지 않고 휴지통 폴더로 옮긴다 (되돌릴 수 있게)
//   4) 임의 JSON 을 받지 않는다. 연산마다 타입과 허용 키가 정해져 있다
//   5) 이름은 화이트리스트 정규식만 통과한다 (경로 탈출 차단)
//
// MCP·플러그인은 공식 CLI(claude mcp / claude plugin)에 맡긴다. 검증과 형식을
// 우리가 다시 구현하지 않는 게 안전하다.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// 테스트에서 진짜 설정을 건드리지 않도록 경로를 바꿔 끼울 수 있게 한다
const CLAUDE_HOME = process.env.CC_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_HOME, 'settings.json');
const GLOBAL_JSON = process.env.CC_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
const AGENTS_DIR = path.join(CLAUDE_HOME, 'agents');
const SKILLS_DIR = path.join(CLAUDE_HOME, 'skills');
const TRASH_DIR = path.join(CLAUDE_HOME, '.cc-launcher-trash');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PERM_KINDS = ['allow', 'deny', 'ask'];

// 시각적으로 만질 수 있는 설정 항목.
// kind: enum(고정 선택) | bool | text | num
// 문서(settings-reference)에 있는 키만 넣는다. 없는 키를 쓰면 조용히 무시되므로 위험하다.
const SETTABLE = {
  model:               { kind: 'enum', values: ['opus[1m]', 'opus', 'sonnet', 'haiku', 'default'],
                         label: '모델', hint: '세션이 시작할 모델' },
  effortLevel:         { kind: 'enum', values: ['low', 'medium', 'high', 'max'],
                         label: '노력 수준', hint: '높으면 더 오래 생각한다' },
  'permissions.defaultMode': { kind: 'enum', values: ['ask', 'plan', 'auto', 'bypassPermissions'],
                         label: '기본 권한 모드', hint: '새 세션이 시작할 권한 모드',
                         warnScopes: { project: 'auto · bypassPermissions 는 프로젝트 설정에서는 적용되지 않습니다' } },
  agent:               { kind: 'text', label: '세션 기본 에이전트',
                         hint: '세션 전체를 이 서브에이전트로 시작한다 (비우면 해제)' },
  teammateMode:        { kind: 'enum', values: ['in-process', 'auto', 'tmux', 'iterm2'],
                         label: '팀원 표시 방식',
                         hint: 'in-process = 한 터미널 안에서 방향키로 전환. 분할 패인은 tmux/iTerm2 필요 (Windows Terminal 미지원)' },
  fastMode:            { kind: 'bool', label: '패스트 모드', hint: '가능한 세션에서 빠른 출력' },
  alwaysThinkingEnabled: { kind: 'bool', label: '확장 사고 항상 켜기' },
  autoCompactEnabled:  { kind: 'bool', label: '자동 압축', hint: '컨텍스트가 차면 알아서 압축' },
  autoMemoryEnabled:   { kind: 'bool', label: '자동 메모리' },
  disableAllHooks:     { kind: 'bool', label: '훅 전체 끄기',
                         hint: '켜면 상태줄·@파일 제안까지 함께 꺼진다',
                         danger: '이 프로젝트의 모든 훅이 멈춥니다 (관측 훅 포함)' },
  disableBundledSkills:{ kind: 'bool', label: '내장 스킬 끄기' },
  enableAllProjectMcpServers: { kind: 'bool', label: '프로젝트 .mcp.json 자동 승인',
                         hint: '프로젝트의 MCP 서버를 확인 없이 켠다' },
  defaultShell:        { kind: 'enum', values: ['bash', 'powershell'], label: '기본 셸',
                         hint: '! 로 실행하는 명령의 셸' },
  editorMode:          { kind: 'enum', values: ['normal', 'vim'], label: '입력 편집 모드' },
  language:            { kind: 'text', label: '응답 언어', hint: '예: Korean (비우면 기본)' },
  autoUpdatesChannel:  { kind: 'enum', values: ['stable', 'latest'], label: '업데이트 채널' },
  cleanupPeriodDays:   { kind: 'num', min: 1, max: 3650, label: '기록 보관 일수' },
  subagentPromptCacheTtl: { kind: 'enum', values: ['5m', '1h'], label: '서브에이전트 캐시 유지',
                         hint: '1h 로 두면 팀원 캐시가 오래 살지만 캐시 쓰기 단가가 올라간다' },
  promptCacheTtl:      { kind: 'enum', values: ['5m', '1h'], label: '메인 대화 캐시 유지' },
};

// env 로만 켜지는 기능 스위치 (설정 키가 아니라 환경변수다)
const ENV_SWITCHES = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: {
    kind: 'onoff', label: '에이전트 팀 (실험 기능)',
    hint: '켜면 팀원끼리 직접 메시지·공유 작업목록을 쓴다. 토큰을 훨씬 많이 쓴다. '
        + '켜져 있으면 Claude 가 이름 붙인 일반 서브에이전트도 팀원으로 뜬다',
  },
  CLAUDE_CODE_SUBAGENT_MODEL: {
    kind: 'enum', values: ['inherit', 'haiku', 'sonnet', 'opus'],
    label: '서브에이전트 모델', hint: 'inherit = 메인과 같은 모델',
  },
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE: {
    kind: 'onoff', label: '서브에이전트 모델 강제',
    hint: '에이전트 정의의 model 을 무시하고 위 값으로 통일한다',
  },
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: {
    kind: 'num', min: 1, max: 50, label: '동시 서브에이전트 상한', hint: '기본 20',
  },
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: {
    kind: 'num', min: 1, max: 5, label: '서브에이전트 중첩 깊이', hint: '기본 3',
  },
};

function stamp() {
  const p = n => String(n).padStart(2, '0');
  const d = new Date();
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 백업 이름은 초 단위라, 같은 초에 두 번 쓰면 앞 백업이 덮여 되돌리기 기록이 사라진다.
// 이미 있으면 뒤에 번호를 붙여 남긴다.
function backup(file) {
  const prefix = file + '.bak_' + stamp();
  let bak = prefix;
  for (let i = 2; fs.existsSync(bak) && i < 100; i++) bak = prefix + '_' + i;
  fs.copyFileSync(file, bak);
  return bak;
}

// 임시 파일 -> 재파싱 검증 -> rename
function writeSafely(file, data) {
  const out = JSON.stringify(data, null, 2);
  const tmp = file + '.tmp_' + process.pid;
  fs.writeFileSync(tmp, out, 'utf8');
  try {
    const back = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (!back || typeof back !== 'object') throw new Error('빈 객체');
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error('쓰기 검증 실패: ' + e.message);
  }
  fs.renameSync(tmp, file);
  return out.length;
}

// ------------------------------------------------------------ 설정 스코프
//
// Claude Code 는 여러 설정 파일을 우선순위대로 합친다 (위가 아래를 덮는다):
//   1 관리형(managed)                       조직
//   2 claude --settings                     이번 세션
//   3 <프로젝트>/.claude/settings.local.json  나 · 이 프로젝트 (커밋 안 함)
//   4 <프로젝트>/.claude/settings.json        팀 공유 (커밋함)
//   5 ~/.claude/settings.json               나 · 전체 프로젝트
//
// 여기서 쓸 수 있는 건 3·4·5 세 개다.
const SCOPES = {
  user:    { label: '전역 (내 모든 프로젝트)', rel: null },
  project: { label: '프로젝트 공유 (커밋됨)', rel: path.join('.claude', 'settings.json') },
  local:   { label: '프로젝트 로컬 (커밋 안 됨)', rel: path.join('.claude', 'settings.local.json') },
};

// 아무 경로에나 쓰지 못하게, 런처가 아는 프로젝트인지 확인한다
function knownProject(cwd) {
  const want = String(cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!want) return false;
  try {
    const g = readJson(GLOBAL_JSON);
    for (const k of Object.keys(g.projects || {})) {
      if (k.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '') === want) return true;
    }
  } catch {}
  // ~/.claude/projects 에 기록이 있는 폴더도 허용한다
  try {
    const dir = path.join(CLAUDE_HOME, 'projects');
    for (const d of fs.readdirSync(dir)) {
      const slug = d.toLowerCase().replace(/^([a-z])--/, '$1:/').replace(/-/g, '/');
      if (slug === want.replace(/^([a-z]):/, '$1:')) return true;
    }
  } catch {}
  return false;
}

function settingsPath(scope, cwd) {
  const spec = SCOPES[scope || 'user'];
  if (!spec) throw new Error('스코프는 user / project / local 중 하나여야 합니다');
  if (!spec.rel) return SETTINGS;
  if (!cwd) throw new Error('프로젝트 설정에는 폴더 경로가 필요합니다');
  if (!fs.existsSync(cwd)) throw new Error('없는 폴더입니다: ' + cwd);
  if (!knownProject(cwd)) throw new Error('런처가 모르는 폴더입니다 (세션 기록이 있는 프로젝트만 가능): ' + cwd);
  const f = path.join(cwd, spec.rel);
  if (!f.startsWith(path.resolve(cwd))) throw new Error('경로가 올바르지 않습니다');
  return f;
}

// 설정 파일을 백업하고 mutate 를 적용한다. 파일이 없으면 새로 만든다.
function editSettings(mutate, scope, cwd) {
  const file = settingsPath(scope, cwd);
  let data, bak = null;
  if (fs.existsSync(file)) {
    data = readJson(file);
    bak = backup(file);
  } else {
    data = {};                                   // 프로젝트 설정을 처음 만드는 경우
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const result = mutate(data) || {};
  const bytes = writeSafely(file, data);
  return Object.assign({
    ok: true, scope: scope || 'user', file,
    created: !bak, backup: bak ? path.basename(bak) : null, bytes,
  }, result);
}

// 삭제 대신 휴지통으로 옮긴다
function trash(target, label) {
  if (!fs.existsSync(target)) throw new Error('대상이 없습니다: ' + target);
  const dir = path.join(TRASH_DIR, stamp() + '_' + (label || 'item'));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(target));
  fs.renameSync(target, dest);
  return dest;
}

// ------------------------------------------------------------ 하네스 설정

// "permissions.defaultMode" 처럼 점으로 중첩된 키를 다룬다
function setDeep(obj, dotted, value) {
  const parts = dotted.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  if (value === null) delete cur[last];
  else cur[last] = value;
}
function getDeep(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// value 가 null 이면 그 키를 지운다 (= 상위 스코프 값을 따르게 되돌린다)
function setSetting(key, value, scope, cwd) {
  const spec = SETTABLE[key];
  if (!spec) throw new Error('바꿀 수 없는 항목입니다: ' + key);

  if (value !== null) {
    if (spec.kind === 'enum') {
      if (spec.values.indexOf(value) < 0)
        throw new Error(spec.label + ' 은 ' + spec.values.join(' / ') + ' 중 하나여야 합니다');
    } else if (spec.kind === 'bool') {
      if (typeof value !== 'boolean') throw new Error(spec.label + ' 은 true/false 여야 합니다');
    } else if (spec.kind === 'num') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(spec.label + ' 은 숫자여야 합니다');
      if (spec.min != null && n < spec.min) throw new Error(spec.label + ' 은 ' + spec.min + ' 이상이어야 합니다');
      if (spec.max != null && n > spec.max) throw new Error(spec.label + ' 은 ' + spec.max + ' 이하여야 합니다');
      value = n;
    } else {
      if (typeof value !== 'string') throw new Error(spec.label + ' 은 문자열이어야 합니다');
      value = value.trim();
      if (!value) value = null;                 // 빈 문자열은 해제로 본다
      else if (value.length > 200) throw new Error(spec.label + ' 이 너무 깁니다');
    }
  }

  const warn = spec.warnScopes && spec.warnScopes[scope] ? spec.warnScopes[scope] : null;
  return editSettings(d => {
    setDeep(d, key, value);
    // permissions 가 빈 객체가 되면 지운다
    if (key.indexOf('permissions.') === 0 && d.permissions
        && !Object.keys(d.permissions).length) delete d.permissions;
    return { key, value, warning: warn };
  }, scope, cwd);
}

// env 스위치 (에이전트 팀 등). value 가 null 이면 해제.
function setEnvSwitch(key, value, scope, cwd) {
  const spec = ENV_SWITCHES[key];
  if (!spec) throw new Error('알 수 없는 스위치입니다: ' + key);
  if (value !== null) {
    if (spec.kind === 'onoff') {
      value = value === true || value === '1' ? '1' : '0';
    } else if (spec.kind === 'enum') {
      if (spec.values.indexOf(value) < 0)
        throw new Error(spec.label + ' 은 ' + spec.values.join(' / ') + ' 중 하나여야 합니다');
    } else if (spec.kind === 'num') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(spec.label + ' 은 숫자여야 합니다');
      if (spec.min != null && n < spec.min) throw new Error(spec.label + ' 은 ' + spec.min + ' 이상이어야 합니다');
      if (spec.max != null && n > spec.max) throw new Error(spec.label + ' 은 ' + spec.max + ' 이하여야 합니다');
      value = String(n);
    }
  }
  return editSettings(d => {
    d.env = d.env || {};
    if (value === null) delete d.env[key];
    else d.env[key] = String(value);
    if (!Object.keys(d.env).length) delete d.env;
    return { key, value };
  }, scope, cwd);
}

// 스코프별 현재 값 + 합쳐진 결과(= 실제 적용되는 값)를 돌려준다
function effective(cwd) {
  const files = {};
  const order = ['user', 'project', 'local'];    // 뒤가 앞을 덮는다
  for (const scope of order) {
    let f;
    try { f = settingsPath(scope, cwd); } catch { continue; }
    files[scope] = { file: f, exists: fs.existsSync(f), data: fs.existsSync(f) ? readJson(f) : null };
  }
  const out = { scopes: files, keys: {}, env: {} };

  for (const key of Object.keys(SETTABLE)) {
    const row = { value: undefined, from: null, perScope: {} };
    for (const scope of order) {
      const d = files[scope] && files[scope].data;
      if (!d) continue;
      const v = getDeep(d, key);
      if (v === undefined) continue;
      row.perScope[scope] = v;
      row.value = v; row.from = scope;           // 뒤에 오는 스코프가 이긴다
    }
    out.keys[key] = row;
  }
  for (const key of Object.keys(ENV_SWITCHES)) {
    const row = { value: undefined, from: null, perScope: {} };
    for (const scope of order) {
      const d = files[scope] && files[scope].data;
      if (!d || !d.env || d.env[key] === undefined) continue;
      row.perScope[scope] = d.env[key];
      row.value = d.env[key]; row.from = scope;
    }
    out.env[key] = row;
  }
  return out;
}

// Bash 규칙 중간의 * 는 그 자리에 끼워넣은 옵션까지 승인한다 (Claude Code 자체 경고와 같은 기준)
function ruleRisk(rule) {
  const m = String(rule).match(/^([A-Za-z_]+)\((.*)\)$/);
  if (!m || ['Bash', 'PowerShell'].indexOf(m[1]) < 0) return null;
  const inner = m[2];
  const star = inner.indexOf('*');
  if (star < 0) return null;
  const after = inner.slice(star + 1).trim();
  if (after === '' || /^\**$/.test(after)) return null;
  return '커맨드 중간에 * 가 있어 그 자리에 끼워넣은 옵션까지 자동 승인됩니다';
}

function addPermission(kind, rule, scope, cwd) {
  if (PERM_KINDS.indexOf(kind) < 0) throw new Error('allow / deny / ask 중 하나여야 합니다');
  rule = String(rule || '').trim();
  if (!rule) throw new Error('규칙이 비어 있습니다');
  if (rule.length > 500) throw new Error('규칙이 너무 깁니다');
  return editSettings(d => {
    d.permissions = d.permissions || {};
    d.permissions[kind] = d.permissions[kind] || [];
    if (d.permissions[kind].indexOf(rule) >= 0) throw new Error('이미 있는 규칙입니다');
    d.permissions[kind].push(rule);
    return { kind, rule, count: d.permissions[kind].length, warning: ruleRisk(rule) };
  }, scope, cwd);
}

function removePermission(kind, rule, scope, cwd) {
  if (PERM_KINDS.indexOf(kind) < 0) throw new Error('allow / deny / ask 중 하나여야 합니다');
  return editSettings(d => {
    const list = (d.permissions && d.permissions[kind]) || [];
    const i = list.indexOf(rule);
    if (i < 0) throw new Error('없는 규칙입니다');
    list.splice(i, 1);
    return { kind, rule, count: list.length };
  }, scope, cwd);
}

function addDirectory(dir, scope, cwd) {
  dir = String(dir || '').trim();
  if (!dir) throw new Error('경로가 비어 있습니다');
  if (!fs.existsSync(dir)) throw new Error('없는 폴더입니다: ' + dir);
  return editSettings(d => {
    d.permissions = d.permissions || {};
    d.permissions.additionalDirectories = d.permissions.additionalDirectories || [];
    const list = d.permissions.additionalDirectories;
    if (list.some(x => String(x).toLowerCase() === dir.toLowerCase()))
      throw new Error('이미 등록된 폴더입니다');
    list.push(dir);
    return { dir, count: list.length };
  }, scope, cwd);
}

function removeDirectory(dir, scope, cwd) {
  return editSettings(d => {
    const list = (d.permissions && d.permissions.additionalDirectories) || [];
    const i = list.findIndex(x => String(x).toLowerCase() === String(dir).toLowerCase());
    if (i < 0) throw new Error('없는 폴더입니다');
    list.splice(i, 1);
    return { dir, count: list.length };
  }, scope, cwd);
}

// ------------------------------------------------------------ 백업 / 되돌리기

function listBackups(scope, cwd) {
  // 프로젝트를 아직 안 골랐으면 조회가 실패할 수 있다. 그건 오류가 아니라 "없음" 이다.
  let target;
  try { target = settingsPath(scope, cwd); } catch { return []; }
  const dir = path.dirname(target);
  const base = path.basename(target) + '.bak_';
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter(f => f.indexOf(base) === 0)
    .map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function restoreBackup(name, scope, cwd) {
  const target = settingsPath(scope, cwd);          // 스코프별 대상 파일
  const base = path.basename(target) + '.bak_';
  name = String(name || '');
  // 그 스코프의 백업만 받는다. 경로 구분자가 섞이면 거부한다.
  if (name.indexOf(base) !== 0 || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0)
    throw new Error('이 스코프의 백업 파일명이 아닙니다: ' + name);
  const src = path.join(path.dirname(target), name);
  if (!fs.existsSync(src)) throw new Error('없는 백업입니다');
  const data = readJson(src);                       // 유효한 JSON 인지 먼저 확인
  const bak = backup(target);                       // 되돌리기 직전 상태도 백업
  const bytes = writeSafely(target, data);
  return { ok: true, restored: name, scope: scope || 'user',
           file: target, backup: path.basename(bak), bytes };
}

// ------------------------------------------------------------ 에이전트 / 스킬

function frontmatterBlock(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    lines.push(k + ': ' + (Array.isArray(v) ? JSON.stringify(v) : String(v)));
  }
  lines.push('---');
  return lines.join('\n');
}

function createAgent(spec) {
  const name = String(spec.name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('이름은 영문/숫자/-/_/. 로 1~64자여야 합니다');
  const desc = String(spec.description || '').trim();
  if (!desc) throw new Error('설명(description)은 필수입니다 - 이걸로 에이전트가 선택됩니다');

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const file = path.join(AGENTS_DIR, name + '.md');
  if (!file.startsWith(AGENTS_DIR)) throw new Error('경로가 올바르지 않습니다');
  if (fs.existsSync(file) && !spec.overwrite) throw new Error('이미 있는 에이전트입니다: ' + name);

  const tools = Array.isArray(spec.tools) ? spec.tools.filter(Boolean) : null;
  const body = String(spec.body || '').trim()
    || ('# ' + name + '\n\n' + desc + '\n\n## 하는 일\n\n- \n\n## 하지 않는 일\n\n- \n');

  const text = frontmatterBlock({
    name, description: desc,
    tools: tools && tools.length ? tools : null,
    model: spec.model || null,
  }) + '\n\n' + body + '\n';

  fs.writeFileSync(file, text, 'utf8');
  return { ok: true, name, file, bytes: text.length };
}

function deleteAgent(name) {
  if (!NAME_RE.test(String(name))) throw new Error('이름이 올바르지 않습니다');
  const file = path.join(AGENTS_DIR, name + '.md');
  if (!file.startsWith(AGENTS_DIR)) throw new Error('경로가 올바르지 않습니다');
  const moved = trash(file, 'agent-' + name);
  return { ok: true, name, trashed: moved };
}

function createSkill(spec) {
  const name = String(spec.name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('이름은 영문/숫자/-/_/. 로 1~64자여야 합니다');
  const desc = String(spec.description || '').trim();
  if (!desc) throw new Error('설명(description)은 필수입니다 - 이걸로 스킬이 트리거됩니다');

  const dir = path.join(SKILLS_DIR, name);
  if (!dir.startsWith(SKILLS_DIR)) throw new Error('경로가 올바르지 않습니다');
  if (fs.existsSync(dir) && !spec.overwrite) throw new Error('이미 있는 스킬입니다: ' + name);
  fs.mkdirSync(dir, { recursive: true });

  const body = String(spec.body || '').trim()
    || ('# ' + name + '\n\n' + desc + '\n\n## 언제 쓰나\n\n- \n\n## 어떻게 하나\n\n1. \n');
  const text = frontmatterBlock({ name, description: desc }) + '\n\n' + body + '\n';
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, text, 'utf8');
  return { ok: true, name, file, bytes: text.length };
}

function deleteSkill(name) {
  if (!NAME_RE.test(String(name))) throw new Error('이름이 올바르지 않습니다');
  const dir = path.join(SKILLS_DIR, name);
  if (!dir.startsWith(SKILLS_DIR)) throw new Error('경로가 올바르지 않습니다');
  const moved = trash(dir, 'skill-' + name);
  return { ok: true, name, trashed: moved };
}

// 에이전트/스킬 본문 읽기·쓰기 (대시보드에서 편집할 때)
function readDoc(kind, name) {
  if (!NAME_RE.test(String(name))) throw new Error('이름이 올바르지 않습니다');
  const file = kind === 'skill'
    ? path.join(SKILLS_DIR, name, 'SKILL.md')
    : path.join(AGENTS_DIR, name + '.md');
  const root = kind === 'skill' ? SKILLS_DIR : AGENTS_DIR;
  if (!file.startsWith(root)) throw new Error('경로가 올바르지 않습니다');
  if (!fs.existsSync(file)) throw new Error('파일이 없습니다');
  return { ok: true, kind, name, file, text: fs.readFileSync(file, 'utf8') };
}

function writeDoc(kind, name, text) {
  const cur = readDoc(kind, name);           // 존재·경로 검증을 재사용한다
  if (typeof text !== 'string' || !text.trim()) throw new Error('내용이 비어 있습니다');
  if (text.length > 400000) throw new Error('내용이 너무 깁니다');
  const bak = cur.file + '.bak_' + stamp();
  fs.copyFileSync(cur.file, bak);
  fs.writeFileSync(cur.file, text, 'utf8');
  return { ok: true, kind, name, file: cur.file, backup: path.basename(bak), bytes: text.length };
}

// ------------------------------------------------------------ MCP / 플러그인 (공식 CLI)

function claudeBin() {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  return fs.existsSync(local) ? local : 'claude';
}

function runClaude(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(claudeBin(), args, { timeout: timeout || 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errOut = String(stderr || '').trim();
        if (err && !out) return reject(new Error(errOut || err.message));
        resolve({ ok: !err, stdout: out, stderr: errOut });
      });
  });
}

// `claude mcp list` 는 연결 상태까지 알려준다. 느리므로 캐시한다.
let mcpCache = null;
function mcpList(force) {
  if (!force && mcpCache && Date.now() - mcpCache.at < 30000) return Promise.resolve(mcpCache.data);
  return runClaude(['mcp', 'list'], 60000).then(r => {
    const servers = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      // "name: target - ✔ Connected" / "name: target - ! Needs authentication"
      const m = line.match(/^(.+?):\s+(.+?)\s+-\s+(.+)$/);
      if (!m) continue;
      const health = m[3].trim();
      servers.push({
        name: m[1].trim(), target: m[2].trim(), health,
        state: /Connected|연결/.test(health) ? 'ok'
             : (/auth/i.test(health) ? 'auth' : 'fail'),
      });
    }
    const data = { servers, raw: r.stdout.slice(0, 4000) };
    mcpCache = { at: Date.now(), data };
    return data;
  });
}

function mcpAdd(spec) {
  const name = String(spec.name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('이름은 영문/숫자/-/_/. 로 1~64자여야 합니다');
  const target = String(spec.commandOrUrl || '').trim();
  if (!target) throw new Error('명령 또는 URL 이 필요합니다');
  const scope = ['local', 'user', 'project'].indexOf(spec.scope) >= 0 ? spec.scope : 'user';
  const transport = ['stdio', 'http', 'sse'].indexOf(spec.transport) >= 0 ? spec.transport : 'stdio';

  const args = ['mcp', 'add', '-s', scope, '-t', transport];
  for (const e of (Array.isArray(spec.env) ? spec.env : [])) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) args.push('-e', e);
  }
  for (const h of (Array.isArray(spec.headers) ? spec.headers : [])) {
    if (h && h.indexOf(':') > 0) args.push('-H', h);
  }
  args.push(name, target);
  for (const a of (Array.isArray(spec.args) ? spec.args : [])) args.push(String(a));

  mcpCache = null;
  return runClaude(args, 60000);
}

function mcpRemove(name, scope) {
  if (!NAME_RE.test(String(name))) throw new Error('이름이 올바르지 않습니다');
  const args = ['mcp', 'remove'];
  if (['local', 'user', 'project'].indexOf(scope) >= 0) args.push('-s', scope);
  args.push(name);
  mcpCache = null;
  return runClaude(args, 30000);
}

// 프로젝트별 MCP on/off 는 ~/.claude.json 의 disabledMcpjsonServers 로 관리된다
function setProjectMcp(cwd, name, enabled) {
  if (!NAME_RE.test(String(name))) throw new Error('이름이 올바르지 않습니다');
  const data = readJson(GLOBAL_JSON);
  const bak = backup(GLOBAL_JSON);
  data.projects = data.projects || {};
  const key = Object.keys(data.projects).find(
    k => k.toLowerCase().replace(/\\/g, '/') === String(cwd).toLowerCase().replace(/\\/g, '/'));
  if (!key) throw new Error('~/.claude.json 에 없는 프로젝트입니다: ' + cwd);

  const p = data.projects[key];
  p.disabledMcpjsonServers = p.disabledMcpjsonServers || [];
  const i = p.disabledMcpjsonServers.indexOf(name);
  if (enabled && i >= 0) p.disabledMcpjsonServers.splice(i, 1);
  if (!enabled && i < 0) p.disabledMcpjsonServers.push(name);

  const bytes = writeSafely(GLOBAL_JSON, data);
  return { ok: true, cwd: key, name, enabled: !!enabled, backup: path.basename(bak), bytes };
}

function setPluginEnabled(name, on, scope, cwd) {
  if (!/^[A-Za-z0-9][A-Za-z0-9@._-]{0,80}$/.test(String(name)))
    throw new Error('플러그인 이름이 올바르지 않습니다');
  return runClaude(['plugin', on ? 'enable' : 'disable', name], 60000)
    .then(r => Object.assign({ ok: true, name, enabled: !!on }, r))
    .catch(() => {
      // CLI 가 실패하면 설정을 직접 고친다 (같은 결과)
      return editSettings(d => {
        d.enabledPlugins = d.enabledPlugins || {};
        const key = Object.keys(d.enabledPlugins).find(
          k => k === name || k.split('@')[0] === String(name).split('@')[0]);
        if (!key) throw new Error('설치되지 않은 플러그인입니다: ' + name);
        d.enabledPlugins[key] = !!on;
        return { name: key, enabled: !!on, via: 'settings.json' };
      }, scope, cwd);
    });
}

module.exports = {
  paths: { CLAUDE_HOME, SETTINGS, GLOBAL_JSON, AGENTS_DIR, SKILLS_DIR, TRASH_DIR },
  SETTABLE, ENV_SWITCHES, SCOPES, PERM_KINDS, ruleRisk,
  settingsPath, effective, setEnvSwitch,
  setSetting, addPermission, removePermission, addDirectory, removeDirectory,
  listBackups, restoreBackup,
  createAgent, deleteAgent, createSkill, deleteSkill, readDoc, writeDoc,
  mcpList, mcpAdd, mcpRemove, setProjectMcp, setPluginEnabled,
};
