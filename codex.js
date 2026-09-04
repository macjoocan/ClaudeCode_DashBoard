// Codex 세션 어댑터. Codex 관련 지식은 전부 이 파일이 소유한다.
// 세션 목록은 rollout 파일을 스캔하지 않고 ~/.codex/state_5.sqlite 의
// threads 테이블을 읽는다 (실측 33행 = rollout 파일 33개로 일치).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

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
function openReadOnly(dbPath) {
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), tmp: null };
  } catch {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-')), 'state.sqlite');
    fs.copyFileSync(dbPath, tmp);
    return { db: new DatabaseSync(tmp, { readOnly: true }), tmp };
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

module.exports = { normalizeCwd, safeTitle, readThreads, TITLE_MAX, CODEX_HOME, STATE_DB };
