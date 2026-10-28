'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const digest = raw => crypto.createHash('sha256').update(raw).digest('hex');

async function windowsProcesses() {
  if (process.platform !== 'win32') return null;
  const command = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
    + 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress';
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  const rows = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(rows) ? rows : [rows]).map(r => ({ pid: Number(r.ProcessId), name: r.Name,
    command: r.CommandLine || '', born: r.CreationDate || '' }));
}
function cliProvider(p) {
  if (/^claude(?:\.exe)?$/i.test(p.name)) return 'claude';
  if (/^codex(?:\.exe)?$/i.test(p.name)) return 'codex';
  if (/^node(?:\.exe)?$/i.test(p.name)) {
    if (/(?:@openai[\\/]codex|[\\/]codex(?:\.js|\.mjs|[\\/]bin[\\/]))/i.test(p.command)) return 'codex';
    if (/(?:@anthropic-ai[\\/]claude-code|[\\/]claude[\\/]cli\.js)/i.test(p.command)) return 'claude';
  }
  return null;
}
const processKey = p => digest([p.pid, p.name, p.born, p.command].join('\0'));

function createCleanup({ claudeDir, codexDir, backupDir, terminals, sessions, killTree, hide,
  listProcesses = windowsProcesses, now = Date.now }) {
  const snapshots = new Map(); let loading, cached;
  function records() {
    const rows = [];
    for (const [provider, dir] of [['claude', claudeDir], ['codex', codexDir]]) {
      let names; try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) continue;
        try {
          const file = path.join(dir, name), raw = fs.readFileSync(file), value = JSON.parse(raw);
          if (!value.sessionId || !/^[a-zA-Z0-9._-]+$/.test(String(value.sessionId))) continue;
          rows.push({ provider, file, raw, fingerprint: digest(raw), id: String(value.sessionId),
            pid: Number(value.pid) || null, status: value.status || 'idle', cwd: value.cwd || '',
            at: Number(value.at || value.statusUpdatedAt || value.updatedAt) || fs.statSync(file).mtimeMs });
        } catch {}
      }
    }
    return rows;
  }
  async function collect() {
    let processes = null;
    try { processes = await listProcesses(); } catch { /* no process visibility means unknown, never stale */ }
    const all = records(), terms = terminals.list(), titles = new Map();
    for (const s of await sessions()) titles.set((s.provider || 'claude') + ':' + s.id, s);
    const groups = new Map();
    for (const rec of all) {
      const key = rec.provider + ':' + rec.id;
      if (!groups.has(key)) groups.set(key, { key, provider: rec.provider, id: rec.id, records: [], terms: [] });
      groups.get(key).records.push(rec);
    }
    for (const term of terms) {
      const key = term.sessionId ? term.provider + ':' + term.sessionId : 'term:' + term.id;
      if (!groups.has(key)) groups.set(key, { key, provider: term.provider, id: term.sessionId || null, records: [], terms: [] });
      groups.get(key).terms.push(term);
    }
    const rows = [];
    for (const group of groups.values()) {
      const { provider, id } = group, meta = titles.get(provider + ':' + id);
      const recent = [...group.records].sort((a, b) => b.at - a.at)[0];
      const embedded = group.terms.filter(t => t.alive);
      const linked = processes?.filter(p => cliProvider(p) === provider && p.command.includes(id || '\0')) || [];
      // Claude writes its actual PID. Codex hook PID is an ephemeral shell and
      // must never be used as proof that the Codex session has ended.
      if (processes && provider === 'claude') for (const r of group.records) {
        const p = processes.find(p => p.pid === r.pid && cliProvider(p) === provider);
        if (p && !linked.some(x => x.pid === p.pid) && (!Date.parse(p.born) || Date.parse(p.born) <= r.at)) linked.push(p);
      }
      const anyCli = processes?.some(p => cliProvider(p) === provider);
      let type, reason;
      if (embedded.length || linked.length) { type = 'running'; reason = embedded.length ? '대시보드 터미널에서 실행 중' : '실제 AI 프로세스 확인됨'; }
      else if (!group.records.length) { type = 'closed'; reason = '종료된 대시보드 터미널'; }
      else if (processes && (provider === 'claude' || !anyCli) && now() - recent.at > 120000) {
        type = 'stale'; reason = '실행 프로세스 없이 상태 표시만 남음';
      } else { type = 'unknown'; reason = provider === 'codex' ? 'Codex 프로세스와 이 세션의 연결을 확인할 수 없음' : '프로세스 상태를 확정할 수 없음'; }
      const at = Math.max(recent?.at || 0, ...group.terms.map(t => t.lastRealAt || t.lastAt || 0));
      const status = embedded.some(t => t.status === 'busy') || group.records.some(r => r.status === 'busy') ? 'busy'
        : embedded.some(t => t.status === 'waiting') || group.records.some(r => r.status === 'waiting') ? 'waiting' : 'idle';
      rows.push({ ...group, type, reason, at, status, linked,
        title: meta?.title || meta?.last || group.terms[0]?.title || id || '새 터미널',
        cwd: meta?.project?.cwd || meta?.cwd || group.terms[0]?.cwd || recent?.cwd || '',
        slug: meta?.slug || null, killable: type === 'running' && (embedded.length > 0 || linked.every(p => p.born)),
      });
    }
    return rows.sort((a, b) => a.at - b.at);
  }
  function publicRows(rows) {
    return rows.map(({ records, terms, linked, ...row }) => ({ ...row,
      pids: [...new Set([...terms.filter(t => t.alive).map(t => t.pid), ...linked.map(p => p.pid)])].filter(Boolean),
      terminals: terms.length,
    }));
  }
  async function inventory(force = false) {
    if (!force && cached && now() - cached.at < 5000) return cached.value;
    if (loading) return loading;
    loading = (async () => {
      const rows = await collect(), token = crypto.randomUUID();
      for (const [key, snapshot] of snapshots) if (now() - snapshot.at > 5 * 60 * 1000) snapshots.delete(key);
      snapshots.set(token, { at: now(), rows });
      if (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value);
      const value = { token, rows: publicRows(rows) };
      cached = { at: now(), value }; return value;
    })();
    try { return await loading; } finally { loading = null; }
  }
  function retire(rec) {
    if (!fs.existsSync(rec.file) || digest(fs.readFileSync(rec.file)) !== rec.fingerprint) throw new Error('상태가 갱신되어 정리를 건너뛰었습니다');
    const dir = path.join(backupDir, crypto.randomUUID()); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, path.basename(rec.file)), rec.raw);
    fs.writeFileSync(path.join(dir, 'restore.json'), JSON.stringify({ original: rec.file, provider: rec.provider, sessionId: rec.id }));
    // Recheck after backup; a hook may have updated the state in the meantime.
    if (digest(fs.readFileSync(rec.file)) !== rec.fingerprint) throw new Error('상태가 갱신되어 정리를 건너뛰었습니다');
    fs.unlinkSync(rec.file);
  }
  async function execute(input) {
    const snapshot = snapshots.get(input.token);
    if (!snapshot || now() - snapshot.at > 5 * 60 * 1000) throw new Error('목록이 만료되었습니다. 다시 확인해 주세요');
    if (!['clean', 'stop', 'hide', 'dismiss'].includes(input.mode)) throw new Error('정리 방식을 확인해 주세요');
    if (['stop', 'dismiss'].includes(input.mode) && input.confirmed !== true) throw new Error('선택 세션 처리 확인이 필요합니다');
    if (!Array.isArray(input.keys) || !input.keys.length || input.keys.length > 100) throw new Error('1~100개 세션을 선택해 주세요');
    const current = await collect(), done = [], failed = [];
    for (const key of new Set(input.keys)) {
      try {
        const before = snapshot.rows.find(r => r.key === key), row = current.find(r => r.key === key);
        if (!before || !row) throw new Error('목록에서 사라졌습니다');
        if (input.mode === 'hide') {
          if (!row.id || !row.slug && row.provider === 'claude') throw new Error('세션 기록이 없어 목록 숨김을 사용할 수 없습니다');
          await hide(row); done.push(key); continue;
        }
        if (row.status === 'busy' && before.status !== 'busy') throw new Error('새 작업이 시작되어 정리를 건너뛰었습니다');
        if (input.mode === 'clean' || input.mode === 'dismiss') {
          const allowed = input.mode === 'dismiss' ? ['unknown', 'stale', 'closed'] : ['stale', 'closed'];
          if (!allowed.includes(row.type)) throw new Error('실행이 확인된 항목은 표시 해제 대신 세션 종료 또는 목록 숨김을 사용해 주세요');
          for (const term of row.terms) { if (term.alive) throw new Error('터미널이 실행 중입니다'); terminals.close(term.id); }
        } else {
          if (!row.killable) throw new Error('실행 프로세스가 확실하지 않아 종료하지 않았습니다');
          for (const p of row.linked) {
            const old = before.linked.find(old => old.pid === p.pid);
            if (!old || processKey(old) !== processKey(p)) throw new Error('프로세스가 교체되어 종료하지 않았습니다');
          }
          for (const term of row.terms) {
            const old = before.terms.find(old => old.id === term.id);
            if (!old || old.startedAt !== term.startedAt) throw new Error('터미널이 재시작되어 건너뛰었습니다');
          }
          for (const term of row.terms) if (term.alive) terminals.close(term.id);
          if (row.linked.length) {
            const latest = await listProcesses();
            for (const p of row.linked) {
              const fresh = latest?.find(item => item.pid === p.pid);
              if (!fresh) continue; // Closing an owned PTY may already have stopped this child.
              if (processKey(fresh) !== processKey(p)) throw new Error('프로세스가 바뀌어 건너뛰었습니다');
              await killTree(p.pid);
            }
          }
        }
        for (const rec of row.records) {
          const old = before.records.find(r => r.file === rec.file);
          if (!old || old.fingerprint !== rec.fingerprint) throw new Error('세션 상태가 갱신되어 표시 정리를 건너뛰었습니다');
          retire(rec);
        }
        done.push(key);
      } catch (e) { failed.push({ key, error: e.message }); }
    }
    cached = null; snapshots.delete(input.token);
    return { done, failed, backupDir };
  }
  return { inventory, execute };
}
module.exports = { createCleanup, cliProvider, windowsProcesses };
