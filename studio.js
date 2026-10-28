'use strict';

// Local task workspaces. Git mutations are serialized per repository; nothing is
// merged or deleted by a background agent. PTYs remain owned by terminals.js.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pendingPrompt } = require('./tui-state');
const { submitPaste } = require('./session-actions');
const run = promisify(execFile);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const validProvider = p => ['claude', 'codex'].includes(p);

async function git(cwd, args) {
  try {
    return (await run('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })).stdout;
  } catch (e) { throw new Error(String(e.stderr || e.message).trim().slice(0, 2000)); }
}

function createStudio({ stateDir, terminals, startTerminal, now = Date.now }) {
  const stateFile = path.join(stateDir, 'tasks.json');
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks; }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('작업 기록을 읽지 못했습니다: ' + e.message); }
  if (!Array.isArray(tasks)) throw new Error('작업 기록 형식이 올바르지 않습니다');
  const locks = new Map();
  let closed = false, pumping = false;
  function save() {
    fs.mkdirSync(stateDir, { recursive: true });
    const temp = stateFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, tasks }, null, 2));
    fs.renameSync(temp, stateFile);
  }
  function lock(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(fn);
    locks.set(key, job);
    return job.finally(() => { if (locks.get(key) === job) locks.delete(key); });
  }
  function find(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) throw new Error('작업을 찾지 못했습니다');
    return task;
  }
  function candidate(task, id) {
    const c = task.candidates.find(c => c.id === id);
    if (!c) throw new Error('AI 작업 공간을 찾지 못했습니다');
    return c;
  }
  function view(task) {
    return { ...task, candidates: task.candidates.map(c => {
      const t = c.terminalId && terminals.get(c.terminalId);
      const term = t && terminals.info(t);
      return { ...c, terminal: term || null,
        messages: (c.messages || []).map(({ text, ...m }) => m) };
    }) };
  }
  async function inspect(root) {
    if (!path.isAbsolute(String(root || ''))) throw new Error('프로젝트의 전체 폴더 경로를 입력해 주세요');
    root = fs.realpathSync(root);
    if (!fs.statSync(root).isDirectory()) throw new Error('프로젝트 폴더가 아닙니다');
    let gitRoot;
    try { gitRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (e) {
      if (!/not a git repository/i.test(e.message)) throw e;
      return { root, git: false };
    }
    const base = (await git(gitRoot, ['rev-parse', '--verify', 'HEAD'])).trim();
    const branch = (await git(gitRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
    const dirty = !!(await git(gitRoot, ['status', '--porcelain'])).trim();
    return { root: fs.realpathSync(gitRoot), git: true, base, branch, dirty };
  }
  async function create(input) {
    const title = String(input.title || '').trim().slice(0, 160);
    const prompt = String(input.prompt || '').trim();
    const providers = input.providers;
    if (!title || !prompt || prompt.length > 12000) throw new Error('작업 제목과 요청 내용(12,000자 이내)을 입력해 주세요');
    if (!Array.isArray(providers) || !providers.length || providers.length > 4 || !providers.every(validProvider))
      throw new Error('Claude/Codex 작업자를 1~4개 선택해 주세요');
    const repo = await inspect(input.root);
    const isolated = input.isolated !== false;
    if (isolated && !repo.git) throw new Error('독립 작업 공간은 커밋이 있는 Git 프로젝트가 필요합니다. 일반 폴더는 단일 작업을 선택하세요');
    if (!isolated && providers.length !== 1) throw new Error('같은 폴더에서는 한 AI만 실행할 수 있습니다');
    return lock(repo.root.toLowerCase(), async () => {
      const id = crypto.randomUUID();
      const task = { id, title, prompt, root: repo.root, isolated, base: repo.base || null,
        sourceBranch: repo.branch || null, sourceDirty: !!repo.dirty, createdAt: now(), updatedAt: now(),
        status: 'ready', candidates: [], notes: [] };
      // Record each successful worktree immediately, including partial failures,
      // so a failed second git operation never leaves an untracked first workspace.
      tasks.unshift(task); save();
      for (let i = 0; i < providers.length; i++) {
        const c = { id: crypto.randomUUID(), provider: providers[i], messages: [],
          branch: isolated ? `studio/${id.slice(0, 8)}/${providers[i]}-${i + 1}` : null,
          cwd: isolated ? path.join(stateDir, 'worktrees', id, `${providers[i]}-${i + 1}`) : repo.root };
        try {
          if (isolated) {
            fs.mkdirSync(path.dirname(c.cwd), { recursive: true });
            await git(repo.root, ['worktree', 'add', '-b', c.branch, c.cwd, repo.base]);
          }
          task.candidates.push(c); save();
        } catch (e) { task.status = 'error'; task.error = e.message; save(); throw e; }
      }
      return view(task);
    });
  }
  function enqueue(c, text, kind) {
    text = String(text || '').trim();
    if (!text || text.length > 16000) throw new Error('요청은 1~16,000자로 입력해 주세요');
    const m = { id: crypto.randomUUID(), text, kind, status: 'queued', at: now() };
    c.messages = (c.messages || []).slice(-49); c.messages.push(m); save();
    return { id: m.id, status: m.status };
  }
  async function start(taskId, candidateId) {
    const task = find(taskId), c = candidate(task, candidateId);
    return lock(c.id, async () => {
      const old = c.terminalId && terminals.get(c.terminalId);
      if (old && terminals.info(old).alive) return view(task);
      const t = await startTerminal({ cwd: c.cwd, provider: c.provider, sessionId: c.sessionId,
        action: c.sessionId ? 'resume' : 'new', title: `${task.title} · ${c.provider}` });
      c.terminalId = t.id;
      if (!c.startedAt || !c.sessionId && !(c.messages || []).some(m => m.kind === 'task' && m.status === 'queued'))
        enqueue(c, `[대시보드 작업: ${task.title}]\n${task.prompt}\n\n작업 폴더: ${c.cwd}\n작업 결과, 검증 결과, 남은 문제를 마지막에 정리해 주세요.`, 'task');
      c.startedAt = now(); task.status = 'active'; task.updatedAt = now(); save();
      return view(task);
    });
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      let changed = false;
      for (const task of tasks) for (const c of task.candidates) {
        const t = c.terminalId && terminals.get(c.terminalId);
        if (!t) continue;
        const inf = terminals.info(t);
        if (inf.sessionId && c.sessionId !== inf.sessionId) { c.sessionId = inf.sessionId; changed = true; }
        const m = (c.messages || []).find(m => m.status === 'queued');
        if (!m) continue;
        if (!inf.alive || now() - m.at > 10 * 60 * 1000) {
          m.status = 'failed'; m.error = !inf.alive ? '터미널이 종료되었습니다' : '10분 동안 입력 준비가 되지 않았습니다'; changed = true; continue;
        }
        if (now() - inf.startedAt < 5000 || inf.status === 'busy' || inf.status === 'waiting'
            || now() - (inf.lastRealAt || inf.lastAt) < 1500 || pendingPrompt(t.buf || '')) continue;
        if (!inf.status && (now() - inf.startedAt < 30000 || (t.buf || '').length < 100)) continue;
        // No Enter retries and no automatic answers to approval dialogs.
        m.status = submitPaste(terminals.write, t.id, m.text) ? 'sent' : 'failed';
        m.sentAt = now(); changed = true;
      }
      if (changed) save();
    } finally { pumping = false; }
  }
  function send(taskId, candidateId, text) {
    const c = candidate(find(taskId), candidateId);
    const t = c.terminalId && terminals.get(c.terminalId);
    if (!t || !terminals.info(t).alive) throw new Error('먼저 이 작업의 AI 터미널을 실행해 주세요');
    return enqueue(c, text, 'followup');
  }
  function context(taskId, candidateId) { const task = find(taskId); return { task, c: candidate(task, candidateId) }; }
  async function files(taskId, candidateId) {
    const { c } = context(taskId, candidateId);
    try { return (await git(c.cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean).slice(0, 3000); }
    catch {
      const out = [];
      function walk(dir, prefix, depth) {
        if (depth > 5 || out.length >= 1000) return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(ent.name)) continue;
          const rel = prefix + ent.name;
          if (ent.isDirectory()) walk(path.join(dir, ent.name), rel + '/', depth + 1);
          else if (ent.isFile()) out.push(rel);
          if (out.length >= 1000) break;
        }
      }
      walk(c.cwd, '', 0); return out;
    }
  }
  function safeFile(c, file) {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some(s => s === '..' || s === '.git')) throw new Error('작업 폴더 안의 파일만 열 수 있습니다');
    const root = fs.realpathSync(c.cwd), full = fs.realpathSync(path.resolve(root, file));
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(full).isFile()) throw new Error('작업 폴더 밖의 파일입니다');
    return full;
  }
  function readFile(taskId, candidateId, file) {
    const { c } = context(taskId, candidateId);
    const full = safeFile(c, file);
    if (fs.statSync(full).size > 512 * 1024) throw new Error('편집기는 512KB 이하 파일을 지원합니다');
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) throw new Error('바이너리 파일은 텍스트 편집기로 열 수 없습니다');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('UTF-8 형식의 파일만 편집할 수 있습니다');
    return { text, version: hash(bytes) };
  }
  function writeFile(taskId, candidateId, file, text, version) {
    const { c } = context(taskId, candidateId);
    const full = safeFile(c, file), before = fs.readFileSync(full);
    if (hash(before) !== version) throw new Error('AI 또는 다른 창에서 파일을 변경했습니다. 다시 열어 비교해 주세요');
    if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) throw new Error('512KB 이하의 텍스트가 필요합니다');
    fs.writeFileSync(full, text); return { version: hash(text) };
  }
  async function changes(taskId, candidateId) {
    const { task, c } = context(taskId, candidateId);
    if (!task.base) return { files: [], git: false };
    const tracked = (await git(c.cwd, ['diff', '--name-only', '-z', task.base, '--'])).split('\0').filter(Boolean);
    const untracked = (await git(c.cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    const stats = (await git(c.cwd, ['diff', '--numstat', task.base, '--'])).split('\n');
    return { git: true, files: [...new Set([...tracked, ...untracked])].map(file => {
      const row = stats.find(r => r.slice(r.indexOf('\t', r.indexOf('\t') + 1) + 1) === file);
      const [added, removed] = row ? row.split('\t') : ['0', '0'];
      return { path: file, added, removed, untracked: untracked.includes(file) };
    }) };
  }
  async function diff(taskId, candidateId, file) {
    const { task, c } = context(taskId, candidateId);
    const changed = (await changes(taskId, candidateId)).files.find(f => f.path === file);
    if (!changed) throw new Error('변경 목록에 없는 파일입니다');
    if (changed.untracked) {
      const { text } = readFile(taskId, candidateId, file);
      return { patch: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${text.split('\n').length} @@\n` + text.split('\n').map(l => '+' + l).join('\n') };
    }
    return { patch: await git(c.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--unified=4', task.base, '--', file]) };
  }
  async function commit(taskId, candidateId, message) {
    const { task, c } = context(taskId, candidateId);
    if (!task.isolated) throw new Error('후보 커밋은 독립 Git 작업 공간에서만 지원합니다');
    return lock(task.root.toLowerCase(), async () => {
      const term = c.terminalId && terminals.get(c.terminalId);
      if (term && terminals.info(term).alive) throw new Error('커밋할 AI 터미널을 먼저 중지해 주세요');
      if ((await git(c.cwd, ['symbolic-ref', '--short', 'HEAD'])).trim() !== c.branch) throw new Error('후보 브랜치가 바뀌었습니다');
      const title = String(message || '').trim();
      if (!title || title.length > 300) throw new Error('커밋 메시지를 300자 이내로 입력해 주세요');
      await git(c.cwd, ['add', '-A', '--', '.']);
      await git(c.cwd, ['commit', '-m', title]);
      c.commit = (await git(c.cwd, ['rev-parse', 'HEAD'])).trim(); save();
      return view(task);
    });
  }
  async function apply(taskId, candidateId, confirmed) {
    if (confirmed !== true) throw new Error('원본 반영 확인이 필요합니다');
    const { task, c } = context(taskId, candidateId);
    if (!task.isolated || !task.sourceBranch) throw new Error('브랜치가 있는 독립 Git 작업만 원본에 반영할 수 있습니다');
    return lock(task.root.toLowerCase(), async () => {
      const source = await inspect(task.root);
      if (source.dirty || source.base !== task.base || source.branch !== task.sourceBranch) throw new Error('원본 브랜치 또는 파일이 작업 시작 후 변경되었습니다. 변경을 먼저 검토해 주세요');
      const inf = c.terminalId && terminals.get(c.terminalId);
      if (inf && terminals.info(inf).alive) throw new Error('반영할 AI 터미널을 먼저 중지해 주세요');
      if ((await git(c.cwd, ['status', '--porcelain'])).trim()) throw new Error('후보의 변경 사항을 먼저 커밋해 주세요');
      if ((await git(c.cwd, ['symbolic-ref', '--short', 'HEAD'])).trim() !== c.branch) throw new Error('후보 브랜치가 바뀌었습니다');
      const head = (await git(c.cwd, ['rev-parse', 'HEAD'])).trim();
      if (head === task.base) throw new Error('반영할 커밋이 없습니다');
      await git(c.cwd, ['merge-base', '--is-ancestor', task.base, head]);
      await git(task.root, ['merge', '--ff-only', c.branch]);
      task.status = 'applied'; task.winner = c.id; task.updatedAt = now(); save();
      return view(task);
    });
  }
  function archive(taskId) { const t = find(taskId); t.archived = !t.archived; save(); return view(t); }
  function note(taskId, candidateId, file, line, text) {
    const task = find(taskId); candidate(task, candidateId);
    text = String(text || '').trim();
    if (!text || text.length > 4000 || !Number.isInteger(line) || line < 1) throw new Error('줄 번호와 코멘트를 확인해 주세요');
    const message = send(taskId, candidateId, `[코드 검토]\n파일: ${file}\n줄: ${line}\n${text}`);
    task.notes.push({ candidateId, file, line, text, at: now(), messageId: message.id }); save();
    return message;
  }
  const timer = setInterval(() => { pump().catch(() => {}); }, 1000); timer.unref();
  return { inspect, create, start, send, files, readFile, writeFile, changes, diff, commit, apply, archive, note,
    list: () => tasks.map(view), get: id => view(find(id)), context,
    pump, close() { closed = true; clearInterval(timer); } };
}

module.exports = { createStudio, git };
