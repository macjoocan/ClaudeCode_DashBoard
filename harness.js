// 하네스(설정) 수집 + 세션/에이전트 그래프 데이터.
//
// Claude Code 의 설정은 여러 파일에 흩어져 있다:
//   ~/.claude/settings.json          사용자 전역 (권한·모델·플러그인 on/off)
//   ~/.claude.json                   전역 MCP 서버 + 프로젝트별 신뢰/MCP 사용 여부
//   <project>/.claude/settings.json         프로젝트 공유 설정
//   <project>/.claude/settings.local.json   내 로컬 설정 (커밋 안 함)
//   <project>/.mcp.json                     프로젝트 MCP 서버
//   ~/.claude/plugins/...            플러그인이 등록하는 훅·스킬·에이전트
//   ~/.claude/skills, ~/.claude/agents
//
// 이 모듈은 그걸 한 장으로 합쳐서 "어디서 온 설정인지"까지 같이 돌려준다. 읽기만 한다.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
// 테스트에서 사본을 대상으로 돌릴 수 있게 경로를 바꿔 끼운다 (config-write.js 와 같은 규칙)
const CLAUDE_HOME = process.env.CC_CLAUDE_HOME || path.join(HOME, '.claude');
const USER_SETTINGS = path.join(CLAUDE_HOME, 'settings.json');
const GLOBAL_JSON = process.env.CC_CLAUDE_JSON || path.join(HOME, '.claude.json');
const PLUGINS_DIR = path.join(CLAUDE_HOME, 'plugins');
const SKILLS_DIR = path.join(CLAUDE_HOME, 'skills');
const AGENTS_DIR = path.join(CLAUDE_HOME, 'agents');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function statOf(file) {
  try { const s = fs.statSync(file); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; }
}
function shortHome(p) {
  if (!p) return p;
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

// --------------------------------------------------------- frontmatter 파싱

// SKILL.md / agent .md 의 YAML 머리말에서 name/description/tools 만 얕게 뽑는다
function frontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { return null; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = raw.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) { key = kv[1]; out[key] = kv[2].trim(); }
    else if (key && /^\s+\S/.test(raw)) out[key] = (out[key] + ' ' + raw.trim()).trim();  // 이어지는 줄
  }
  for (const k of Object.keys(out)) {
    out[k] = out[k].replace(/^["']|["']$/g, '');
  }
  return out;
}

// --------------------------------------------------------- 플러그인

function pluginHooks(dir) {
  const out = [];
  for (const rel of ['hooks/hooks.json', '.claude-plugin/hooks.json']) {
    const f = path.join(dir, rel);
    const j = readJson(f);
    if (!j || !j.hooks) continue;
    for (const [event, entries] of Object.entries(j.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        // command 와 args 가 분리돼 있는 경우가 있다 ("node" + ["...script.mjs"]).
        // 실제로 뭐가 도는지 보이려면 합쳐야 한다.
        const cmds = (e.hooks || []).map(h => {
          const full = [h.command].concat(Array.isArray(h.args) ? h.args : [])
            .filter(Boolean).join(' ');
          return {
            type: h.type || 'command',
            command: full.slice(0, 400),
            label: h.statusMessage || null,
            timeout: h.timeout,
          };
        });
        out.push({ event, matcher: e.matcher || '*', commands: cmds, file: rel });
      }
    }
  }
  return out;
}

function listDirNames(dir, ext) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => ext ? (d.isFile() && d.name.endsWith(ext)) : d.isDirectory())
      .map(d => ext ? d.name.replace(ext, '') : d.name);
  } catch { return []; }
}

// installed_plugins.json 형식: { version: 2, plugins: { "<name>@<marketplace>": [ {installPath, version, scope} ] } }
// installPath 가 들어 있으므로 디렉터리를 추측하지 않고 그대로 쓴다.
function collectPlugins(enabledMap) {
  const installed = readJson(path.join(PLUGINS_DIR, 'installed_plugins.json')) || {};
  const table = installed.plugins || installed;   // v2 / 구형 모두 대응
  const out = [];

  for (const [name, val] of Object.entries(table)) {
    if (name === 'version') continue;
    const metas = Array.isArray(val) ? val : [val];
    const meta = metas[0] || {};
    let dir = meta.installPath || null;
    if (dir && !fs.existsSync(dir)) dir = null;

    // installPath 가 없거나 사라졌으면 marketplaces 배치를 한 번 더 본다
    if (!dir) {
      const base = name.split('@')[0];
      const mkt = name.split('@')[1] || '';
      const cand = [
        path.join(PLUGINS_DIR, 'marketplaces', mkt, 'plugins', base),
        path.join(PLUGINS_DIR, 'marketplaces', mkt, base),
      ];
      dir = cand.find(c => fs.existsSync(c)) || null;
    }

    // 플러그인 안에 plugins/<name>/ 로 한 겹 더 들어가 있는 배치도 있다
    let root = dir;
    if (dir) {
      const nested = path.join(dir, 'plugins', name.split('@')[0]);
      if (fs.existsSync(path.join(nested, 'hooks', 'hooks.json'))
          && !fs.existsSync(path.join(dir, 'hooks', 'hooks.json'))) root = nested;
    }

    out.push({
      name,
      marketplace: name.split('@')[1] || null,
      enabled: name in enabledMap ? !!enabledMap[name] : null,
      scope: meta.scope || null,
      version: meta.version || (dir ? path.basename(dir) : null),
      installedAt: meta.installedAt || null,
      dir: root ? shortHome(root) : null,
      hooks: root ? pluginHooks(root) : [],
      skills: root ? listDirNames(path.join(root, 'skills')) : [],
      agents: root ? listDirNames(path.join(root, 'agents'), '.md') : [],
      commands: root ? listDirNames(path.join(root, 'commands'), '.md') : [],
      mcpServers: root ? Object.keys((readJson(path.join(root, '.mcp.json')) || {}).mcpServers || {}) : [],
    });
  }
  out.sort((a, b) => (b.enabled === true) - (a.enabled === true) || a.name.localeCompare(b.name));
  return out;
}

// --------------------------------------------------------- 프로젝트 설정 파일

function projectConfig(cwd) {
  const files = [];
  const add = (rel, kind) => {
    const f = path.join(cwd, rel);
    const st = statOf(f);
    if (!st) return;
    const entry = { rel, kind, path: f, size: st.size, mtime: st.mtime };
    if (kind !== 'claudemd') {
      const j = readJson(f);
      entry.keys = j ? Object.keys(j) : [];
      entry.data = j;
    }
    files.push(entry);
  };
  add('.claude/settings.json', 'settings');
  add('.claude/settings.local.json', 'local');
  add('.mcp.json', 'mcp');
  add('CLAUDE.md', 'claudemd');
  add('AGENTS.md', 'claudemd');
  return files;
}

// --------------------------------------------------------- 경고 (충돌·위험)

function buildWarnings(cfg) {
  const w = [];
  const allow = (cfg.user.permissions.allow || []);
  const CMD_TOOLS = new Set(['Bash', 'PowerShell']);

  // Claude Code 자체가 경고하는 패턴: 커맨드 중간의 * 는 뒤에 끼워넣은 옵션까지 승인해 버린다
  for (const rule of allow) {
    const m = String(rule).match(/^([A-Za-z_]+)\((.*)\)$/);
    // 명령을 실행하는 툴에만 해당한다. Read(...)/Edit(...) 의 ** 는 정상적인 파일 글롭이다.
    if (!m || !CMD_TOOLS.has(m[1])) continue;
    const inner = m[2];
    const star = inner.indexOf('*');
    if (star < 0) continue;
    const after = inner.slice(star + 1).trim();
    // 끝에 붙은 * (Bash(git log:*) 처럼)은 의도된 접두 매칭이므로 넘어간다
    if (after === '' || /^\**$/.test(after)) continue;
    w.push({
      level: 'warn', kind: 'permission-wildcard',
      text: '커맨드 중간에 * 가 있어 그 자리에 끼워넣은 옵션까지 자동 승인됩니다',
      detail: rule, source: '~/.claude/settings.json',
    });
  }

  // 존재하지 않는 추가 디렉터리
  for (const d of (cfg.user.permissions.additionalDirectories || [])) {
    if (!fs.existsSync(d)) {
      w.push({ level: 'info', kind: 'missing-dir', text: '추가 디렉터리가 존재하지 않습니다',
               detail: d, source: '~/.claude/settings.json' });
    }
  }

  // 신뢰 안 된 프로젝트
  for (const [p, v] of Object.entries(cfg.global.projects || {})) {
    if (v.trust === false) {
      w.push({ level: 'info', kind: 'untrusted', text: '폴더 신뢰가 아직 승인되지 않았습니다',
               detail: p, source: '~/.claude.json' });
    }
  }

  // 같은 폴더가 대소문자만 다르게 두 항목으로 등록된 경우.
  // 설정(신뢰·MCP 사용 여부·허용 툴)이 두 곳으로 갈려서 한쪽만 적용된다.
  const caseMap = new Map();
  for (const p of Object.keys(cfg.global.projects || {})) {
    const k = p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!caseMap.has(k)) caseMap.set(k, []);
    caseMap.get(k).push(p);
  }
  for (const [, list] of caseMap) {
    if (list.length > 1) {
      w.push({ level: 'warn', kind: 'path-case-dup',
               text: '같은 폴더가 대소문자만 다르게 두 번 등록돼 설정이 갈려 있습니다',
               detail: list.join('  ↔  '), source: '~/.claude.json' });
    }
  }

  // 이름이 겹치는 스킬 (플러그인 vs 사용자)
  const seen = new Map();
  for (const s of cfg.skills) {
    const prev = seen.get(s.name);
    if (prev) {
      w.push({ level: 'warn', kind: 'skill-shadow',
               text: '같은 이름의 스킬이 두 곳에 있습니다 (하나가 가려집니다)',
               detail: s.name + '  ←  ' + prev.source + ' / ' + s.source, source: s.source });
    } else seen.set(s.name, s);
  }

  // 훅이 걸린 플러그인이 꺼져 있으면 그 훅은 안 돈다 - 헷갈리기 쉬우니 알려준다
  for (const p of cfg.plugins) {
    if (p.enabled === false && p.hooks.length) {
      w.push({ level: 'info', kind: 'disabled-hooks',
               text: '플러그인이 꺼져 있어 등록된 훅 ' + p.hooks.length + '개가 동작하지 않습니다',
               detail: p.name, source: p.dir || 'plugins' });
    }
  }
  return w;
}

// --------------------------------------------------------- 메인 수집

function config(knownCwds) {
  const us = readJson(USER_SETTINGS) || {};
  const gj = readJson(GLOBAL_JSON) || {};

  const user = {
    file: shortHome(USER_SETTINGS),
    stat: statOf(USER_SETTINGS),
    model: us.model || null,
    effortLevel: us.effortLevel || null,
    tui: us.tui || null,
    // autoMode 는 긴 텍스트(환경 설명 등)를 담을 수 있으므로 키만 요약해서 보낸다
    autoMode: us.autoMode ? { keys: Object.keys(us.autoMode) } : null,
    autoUpdatesChannel: us.autoUpdatesChannel || null,
    permissions: {
      allow: us.permissions && us.permissions.allow || [],
      deny: us.permissions && us.permissions.deny || [],
      ask: us.permissions && us.permissions.ask || [],
      additionalDirectories: us.permissions && us.permissions.additionalDirectories || [],
      defaultMode: us.permissions && us.permissions.defaultMode || null,
    },
    enabledPlugins: us.enabledPlugins || {},
    hooks: us.hooks || null,
  };

  const mcpServers = Object.entries(gj.mcpServers || {}).map(([name, v]) => ({
    name,
    type: v.type || (v.url ? 'http' : 'stdio'),
    command: v.command || v.url || null,
    args: Array.isArray(v.args) ? v.args.slice(0, 6) : [],
    env: v.env ? Object.keys(v.env) : [],
  }));

  const projects = {};
  for (const [p, v] of Object.entries(gj.projects || {})) {
    projects[p] = {
      trust: typeof v.hasTrustDialogAccepted === 'boolean' ? v.hasTrustDialogAccepted : null,
      allowedTools: (v.allowedTools || []).length,
      mcpServers: Object.keys(v.mcpServers || {}),
      enabledMcpjson: v.enabledMcpjsonServers || [],
      disabledMcpjson: v.disabledMcpjsonServers || [],
      exists: fs.existsSync(p),
    };
  }

  // 스킬: 사용자 디렉터리 + 플러그인
  const skills = [];
  for (const name of listDirNames(SKILLS_DIR)) {
    const fm = frontmatter(path.join(SKILLS_DIR, name, 'SKILL.md')) || {};
    skills.push({ name: fm.name || name, dirName: name, source: '~/.claude/skills',
                  description: (fm.description || '').slice(0, 260) });
  }

  const agents = [];
  for (const f of listDirNames(AGENTS_DIR, '.md')) {
    const fm = frontmatter(path.join(AGENTS_DIR, f + '.md')) || {};
    agents.push({ name: fm.name || f, source: '~/.claude/agents',
                  description: (fm.description || '').slice(0, 260),
                  tools: fm.tools || null, model: fm.model || null });
  }

  const plugins = collectPlugins(user.enabledPlugins);
  for (const p of plugins) {
    for (const s of p.skills) skills.push({ name: s, source: 'plugin:' + p.name, description: '', plugin: p.name, pluginEnabled: p.enabled });
    for (const a of p.agents) agents.push({ name: a, source: 'plugin:' + p.name, description: '', plugin: p.name, pluginEnabled: p.enabled });
  }

  // 훅 전체 취합 (사용자 설정 + 플러그인)
  const hooks = [];
  if (user.hooks) {
    for (const [event, entries] of Object.entries(user.hooks)) {
      for (const e of (entries || [])) {
        for (const h of (e.hooks || [])) {
          hooks.push({ event, matcher: e.matcher || '*', command: String(h.command || '').slice(0, 300),
                       source: '~/.claude/settings.json', active: true });
        }
      }
    }
  }
  for (const p of plugins) {
    for (const h of p.hooks) {
      for (const c of h.commands) {
        hooks.push({ event: h.event, matcher: h.matcher, command: c.command, label: c.label,
                     source: 'plugin:' + p.name, active: p.enabled !== false });
      }
    }
  }
  hooks.sort((a, b) => a.event.localeCompare(b.event) || a.source.localeCompare(b.source));

  const projectFiles = (knownCwds || [])
    .map(cwd => ({ cwd, files: projectConfig(cwd) }))
    .filter(x => x.files.length);

  const cfg = {
    user, global: { file: shortHome(GLOBAL_JSON), stat: statOf(GLOBAL_JSON), mcpServers, projects },
    projectFiles, plugins, skills, agents, hooks,
  };
  cfg.warnings = buildWarnings(cfg);
  return cfg;
}

// --------------------------------------------------------- 서브에이전트 스캔
//
// subagent_type 은 Task/Agent 툴 인자에 들어가고 파일 어디에나 나올 수 있어서
// 앞/끝 표본으로는 놓친다. 그래서 그래프용으로만 파일 전체를 훑는다.
// mtime 캐시가 있으니 두 번째부터는 공짜다.

const SUB_CACHE = new Map();          // file -> { mtime, size, counts }
const SUB_MAX_BYTES = 24 * 1024 * 1024;
const SUB_CHUNK = 4 * 1024 * 1024;

function scanSubagents(file) {
  let st;
  try { st = fs.statSync(file); } catch { return {}; }
  const hit = SUB_CACHE.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.counts;

  const counts = {};
  const re = /"subagent_type":"([^"]{1,60})"/g;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    // 큰 파일은 끝에서부터 SUB_MAX_BYTES 만 본다 (최근 활동이 중요하다)
    const start = Math.max(0, st.size - SUB_MAX_BYTES);
    const buf = Buffer.alloc(SUB_CHUNK);
    let pos = start, carry = '';
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(SUB_CHUNK, st.size - pos), pos);
      if (n <= 0) break;
      const text = carry + buf.slice(0, n).toString('utf8');
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) counts[m[1]] = (counts[m[1]] || 0) + 1;
      carry = text.slice(-80);      // 경계에서 잘린 토큰 대비
      pos += n;
    }
  } catch { /* 읽기 실패는 빈 결과로 */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }

  SUB_CACHE.set(file, { mtime: st.mtimeMs, size: st.size, counts });
  return counts;
}

// --------------------------------------------------------- 그래프

// projects: server.js 의 scan() 결과. cfg: 위 config().
// 프로젝트 -> 세션 -> (서브에이전트 / MCP 서버) 3단 그래프를 만든다.
function normPath(p) { return String(p || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''); }

// projects: server.js 의 scan() 결과. cfg: 위 config(). terms: terminals.list().
// 프로젝트 -> 세션 -> 서브에이전트 3단 그래프 + MCP 밴드를 만든다.
//
// MCP 는 전역 서버가 모든 프로젝트에 걸려서 엣지로 그리면 헤어볼이 된다.
// 그래서 전역 서버는 "공용 밴드" 로 한 번만 그리고, 프로젝트 전용 서버와
// 명시적으로 끈 서버만 프로젝트에 붙인다.
function graph(projects, cfg, terms, projectsDir) {
  const nodes = [];
  const edges = [];
  const add = n => { nodes.push(n); return n.id; };

  const embBySession = new Map();
  for (const t of (terms || [])) if (t.sessionId && t.alive) embBySession.set(t.sessionId, t);

  const globalMcp = cfg.global.mcpServers.map(m => m.name);
  const globalSet = new Set(globalMcp);
  const mcpSeen = new Set();
  const agentSeen = new Set();

  for (const p of projects) {
    const pid = 'p:' + p.key;
    const gp = Object.entries(cfg.global.projects).find(([k]) => normPath(k) === normPath(p.cwd));
    const gv = gp ? gp[1] : null;
    const disabled = gv ? (gv.disabledMcpjson || []) : [];

    // 프로젝트 전용 MCP (전역에 없는 것만)
    const ownMcp = [];
    if (gv) {
      for (const name of [].concat(gv.mcpServers || [], gv.enabledMcpjson || [])) {
        if (!globalSet.has(name) && ownMcp.indexOf(name) < 0) ownMcp.push(name);
      }
    }

    add({ id: pid, kind: 'project', label: p.name, cwd: p.cwd, branch: p.gitBranch,
          sessions: p.sessions.length, live: p.sessions.filter(s => s.live).length,
          exists: p.exists, trust: gv ? gv.trust : null,
          mcpDisabled: disabled, mcpOwn: ownMcp });

    for (const name of ownMcp) {
      const mid = 'm:' + name;
      if (!mcpSeen.has(mid)) { mcpSeen.add(mid); add({ id: mid, kind: 'mcp', scope: 'project', label: name }); }
      edges.push({ from: pid, to: mid, kind: 'mcp' });
    }

    // 세션: 실행 중인 것 전부 + 최근 3개
    const show = p.sessions.filter(s => s.live)
      .concat(p.sessions.filter(s => !s.live).slice(0, 3));

    for (const s of show) {
      const sid = 's:' + s.id;
      const emb = embBySession.get(s.id);

      // 파일 전체를 훑어 서브에이전트 사용 내역을 얻는다 (mtime 캐시)
      let subs = s.subagents || {};
      if (projectsDir && s.slug) {
        const f = path.join(projectsDir, s.slug, s.id + '.jsonl');
        const full = scanSubagents(f);
        if (Object.keys(full).length) subs = full;
      }

      add({ id: sid, kind: 'session', label: s.title || '(제목 없음)', sessionId: s.id,
            slug: s.slug, provider: s.provider, live: !!s.live, status: s.live ? s.live.status : null,
            embedded: !!emb, termId: emb ? emb.id : null,
            mtime: s.mtime, fav: !!s.fav, sizeKB: s.sizeKB, project: p.name, cwd: p.cwd,
            subagentCalls: Object.values(subs).reduce((a, b) => a + b, 0) });
      edges.push({ from: pid, to: sid, kind: 'session' });

      for (const [type, count] of Object.entries(subs)) {
        const aid = 'a:' + type;
        if (!agentSeen.has(aid)) {
          agentSeen.add(aid);
          const def = cfg.agents.find(x => x.name === type);
          add({ id: aid, kind: 'subagent', label: type,
                source: def ? def.source : '내장/플러그인',
                desc: def ? def.description : '' });
        }
        edges.push({ from: sid, to: aid, kind: 'subagent', count });
      }
    }
  }

  // 내장 터미널로만 존재하는 세션(아직 대화 기록이 없어 스캔에 안 잡힌 것)도 보여준다
  for (const t of (terms || [])) {
    if (!t.alive) continue;
    if (t.sessionId && nodes.some(n => n.id === 's:' + t.sessionId)) continue;
    const proj = projects.find(p => normPath(p.cwd) === normPath(t.cwd));
    const sid = 's:term:' + t.id;
    add({ id: sid, kind: 'session', label: t.name || t.title || '(새 세션)',
          sessionId: t.sessionId, provider: t.provider || 'claude', live: true, status: t.status,
          embedded: true, termId: t.id,
          mtime: t.lastAt, fresh: true, project: proj ? proj.name : t.cwd, cwd: t.cwd,
          subagentCalls: 0 });
    if (proj) edges.push({ from: 'p:' + proj.key, to: sid, kind: 'session' });
  }

  return {
    nodes, edges,
    globalMcp: cfg.global.mcpServers,
    stats: {
      projects: nodes.filter(n => n.kind === 'project').length,
      sessions: nodes.filter(n => n.kind === 'session').length,
      live: nodes.filter(n => n.kind === 'session' && n.live).length,
      embedded: nodes.filter(n => n.kind === 'session' && n.embedded).length,
      mcpGlobal: globalMcp.length,
      mcpProject: nodes.filter(n => n.kind === 'mcp').length,
      subagents: nodes.filter(n => n.kind === 'subagent').length,
      subagentCalls: edges.filter(e => e.kind === 'subagent').reduce((a, e) => a + e.count, 0),
    },
  };
}

module.exports = { config, graph };
