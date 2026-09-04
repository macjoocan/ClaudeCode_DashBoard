// Codex 세션 어댑터. Codex 관련 지식은 전부 이 파일이 소유한다.
// 세션 목록은 rollout 파일을 스캔하지 않고 ~/.codex/state_5.sqlite 의
// threads 테이블을 읽는다 (실측 33행 = rollout 파일 33개로 일치).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');

const TITLE_MAX = 200;

// Codex 는 cwd 를 확장 길이 경로(\\?\D:\...)로 저장한다.
// 벗기지 않으면 Claude 프로젝트 카드와 다른 키가 되어 카드가 둘로 갈린다.
function normalizeCwd(s) {
  let v = String(s || '');
  if (v.startsWith('\\\\?\\UNC\\')) return '\\\\' + v.slice(8);
  if (v.startsWith('\\\\?\\')) return v.slice(4);
  return v;
}

// threads.title 은 보통 짧지만(중앙값 29자) 승인 요청 블롭이 통째로
// 들어가 36,000자가 넘는 경우가 있다. 반드시 자른다.
function safeTitle(...candidates) {
  for (const c of candidates) {
    const v = String(c == null ? '' : c).replace(/\s+/g, ' ').trim();
    if (!v) continue;
    return v.length > TITLE_MAX ? v.slice(0, TITLE_MAX) + '…' : v;
  }
  return '';
}

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');

const SELECT = `
  select id, rollout_path, cwd, title, first_user_message, preview,
         updated_at_ms, created_at_ms, git_branch, thread_source, source
    from threads
   where archived = 0
   order by updated_at_ms desc`;

// source 는 '{"subagent":{"thread_spawn":{"parent_thread_id":"...","depth":1}}}'
// 형태이거나 null 이다. 파싱에 실패해도 세션 자체는 살린다.
function parentOf(sourceJson) {
  if (!sourceJson) return null;
  try {
    const j = JSON.parse(sourceJson);
    return j?.subagent?.thread_spawn?.parent_thread_id || null;
  } catch { return null; }
}

// 읽기 전용으로 연다. Codex 가 쓰는 중이라 잠겨 있으면 temp 로 복사해 읽는다.
//
// WAL 모드 DB 를 readOnly 로 열면 SQLite 가 옆에 -shm/-wal 사이드카 파일을
// 스스로 만든다(실측: state_5.sqlite-shm, state_5.sqlite-wal 생성됨). 이건
// 우리가 쓰기를 한 게 아니라 SQLite 자체의 동작이라 무해하다. immutable=1 로
// 열면 이 사이드카가 안 생기지만, Codex 가 동시에 쓰는 중이면 torn(중간 상태)
// 읽기를 할 위험이 있어 일부러 쓰지 않는다.
function openReadOnly(dbPath) {
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), tmp: null };
  } catch {
    // 1차 open 이 실패한 경우에만 여기로 온다. 폴백(복사 후 재오픈) 자체가
    // 또 실패하면(copyFileSync 실패, 또는 복사본이 손상돼 재오픈 실패)
    // mkdtempSync 로 만든 temp 디렉터리가 정리되지 않고 남는다. 그래서
    // 폴백 블록 전체를 try/catch 로 감싸 실패 시 temp 디렉터리를 지우고
    // 다시 던진다 — 바깥 readThreads 의 catch 가 최종적으로 []를 반환한다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-'));
    try {
      const tmp = path.join(dir, 'state.sqlite');
      fs.copyFileSync(dbPath, tmp);
      return { db: new DatabaseSync(tmp, { readOnly: true }), tmp };
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      throw e;
    }
  }
}

function readThreads(dbPath) {
  const file = dbPath || STATE_DB;
  if (!fs.existsSync(file)) return [];
  let handle;
  try { handle = openReadOnly(file); } catch { return []; }

  try {
    return handle.db.prepare(SELECT).all().map(r => ({
      id: r.id,
      provider: 'codex',
      title: safeTitle(r.title, r.first_user_message, r.preview),
      firstPrompt: safeTitle(r.first_user_message),
      last: safeTitle(r.preview, r.first_user_message),
      mtime: Number(r.updated_at_ms) || Number(r.created_at_ms) || 0,
      branch: r.git_branch || null,
      cwd: normalizeCwd(r.cwd),
      rolloutPath: r.rollout_path || null,
      threadSource: r.thread_source || null,
      parentId: parentOf(r.source),
    }));
  } catch {
    return [];
  } finally {
    try { handle.db.close(); } catch {}
    if (handle.tmp) { try { fs.rmSync(path.dirname(handle.tmp), { recursive: true, force: true }); } catch {} }
  }
}

// 파일 mtime 대신 DB 내용으로 캐시를 무효화한다.
// sqlite 는 WAL 때문에 mtime 이 안 바뀔 수 있다.
function stamp(dbPath) {
  const file = dbPath || STATE_DB;
  if (!fs.existsSync(file)) return '';
  let handle;
  try { handle = openReadOnly(file); } catch { return ''; }
  try {
    const r = handle.db.prepare('select count(*) n, max(updated_at_ms) m, sum(archived) a from threads').get();
    return `${r.n}:${r.m || 0}:${r.a || 0}`;
  } catch {
    return '';
  } finally {
    try { handle.db.close(); } catch {}
    if (handle.tmp) { try { fs.rmSync(path.dirname(handle.tmp), { recursive: true, force: true }); } catch {} }
  }
}

let _cache = { stamp: null, rows: [] };

function sessions() {
  const s = stamp();
  if (s && s === _cache.stamp) return _cache.rows;
  const rows = readThreads();
  _cache = { stamp: s, rows };
  return rows;
}

// 실행 시 codex CLI 에 넘길 인자를 만든다. Claude 쪽 claudeArgs 와 대응.
function codexArgs(action, sessionId) {
  if (action === 'resume' || action === 'fork') {
    if (!sessionId) throw new Error('세션 ID 가 필요합니다');
    return [action, sessionId];
  }
  if (action === 'continue') return ['resume', '--last'];
  return [];   // 'new'
}

// PATH 에서 codex 실행파일을 찾는다. 없으면 null.
// npm 전역 설치는 같은 디렉터리에 확장자 없는 POSIX 셸 스크립트(#!/bin/sh, WSL/Git-Bash 용)와
// codex.cmd(Windows 용)를 함께 만든다. where.exe 는 확장자 없는 쪽을 먼저 나열하는데,
// 그 파일은 PE 형식이 아니라 pty.spawn 이 "Cannot create process, error code: 193" 으로 죽는다.
// 그래서 .cmd/.exe/.bat 처럼 Windows 가 직접 실행 가능한 확장자를 우선한다
// (findClaudeBin 이 claude.exe/claude.cmd 를 우선하는 것과 같은 이유).
function findCodexBin() {
  try {
    const lines = execFileSync('where.exe', ['codex'], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);
    return lines.find(l => /\.(cmd|exe|bat)$/i.test(l)) || lines[0] || null;
  } catch { return null; }
}

// rollout jsonl 한 줄 = { timestamp, type, payload }.
// 첫 줄(session_meta)은 base_instructions 때문에 50KB 를 넘을 수 있어
// 줄 단위로 읽되 내용은 필요한 것만 뽑는다.
function rowToMsg(j) {
  const p = j.payload || {};
  const at = j.timestamp || null;
  if (j.type === 'event_msg' && p.type === 'user_message' && p.message)
    return { role: 'user', text: String(p.message), at };
  if (j.type === 'event_msg' && p.type === 'agent_message' && p.message)
    return { role: 'assistant', text: String(p.message), at };
  if (j.type === 'response_item' && p.type === 'function_call')
    return { role: 'tool', text: `${p.name || 'tool'} ${String(p.arguments || '').slice(0, 400)}`, at };
  return null;
}

function parseRollout(file, limit) {
  if (!file || !fs.existsSync(file)) return { msgs: [], total: 0 };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { msgs: [], total: 0 }; }

  const msgs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const m = rowToMsg(j);
    if (m) msgs.push(m);
  }
  const n = Math.max(1, Number(limit) || 40);
  return { msgs: msgs.slice(-n), total: msgs.length };
}

// 경로 탈출 차단: rollout 은 반드시 ~/.codex/sessions 하위여야 한다.
// path.resolve 뒤에 startsWith 만 쓰면 문자열 접두사 비교라 "sessions-evil" 같이
// 이름만 같은 접두사로 시작하는 형제 디렉터리도 통과해버린다(구분자 경계를 안 본다).
// path.relative 로 실제 트리 관계를 본다: 결과가 '..' 이거나 '..' + 구분자로
// 시작하면 상위로 나간 것이고, 절대경로 그대로면(윈도우에서 드라이브가 다르면
// relative 가 target 을 그대로 돌려준다) 공통 조상이 없다는 뜻이다.
// 둘 다 아니면 root 하위다. root 자신(빈 문자열)은 파일이 아니므로 제외한다.
function isInsideSessions(p) {
  const root = path.resolve(CODEX_HOME, 'sessions');
  const target = path.resolve(p || '');
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function transcript(sessionId, limit) {
  // sessions() 를 쓴다 - readThreads() 는 매번 DB 를 다시 연다
  const row = sessions().find(r => r.id === sessionId);
  if (!row) throw new Error('세션을 찾을 수 없습니다');
  if (!isInsideSessions(row.rolloutPath)) throw new Error('세션 파일 경로가 올바르지 않습니다');
  return parseRollout(path.resolve(row.rolloutPath || ''), limit);
}

module.exports = {
  normalizeCwd, safeTitle, readThreads, TITLE_MAX, CODEX_HOME, STATE_DB, sessions, stamp,
  codexArgs, findCodexBin, parseRollout, transcript, isInsideSessions,
};
