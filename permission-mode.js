'use strict';

// Explicit, per-process overrides. Never edit global settings or answer prompts.
function normalizeMode(mode) {
  if (mode == null) return 'inherit';
  if (!['inherit', 'auto', 'full'].includes(mode)) throw new Error('잘못된 권한 모드');
  return mode;
}

function permissionArgs(provider, mode) {
  mode = normalizeMode(mode);
  if (mode === 'inherit') return [];
  if (provider === 'codex') {
    return mode === 'full'
      ? ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']
      : ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-c', 'approvals_reviewer=auto_review'];
  }
  return mode === 'full'
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'auto'];
}

function requestedMode(body) {
  const mode = normalizeMode(body.permissionMode);
  if (mode === 'full' && body.confirmFullAccess !== true)
    throw new Error('묻지 않기 모드의 위험 안내를 먼저 확인해 주세요');
  return mode;
}

// 세션별로 고른 권한을 기억한다.
//
// 권한은 CLI 플래그라 프로세스가 끝나면 사라진다. 카드에서 같은 세션을 다시 열면
// '기존 설정' 으로 뜨는데, Codex 는 이어하기 때 승인 정책(never)만 되살리고 샌드박스는
// read-only 로 떨어뜨린다(실측 0.160.1). 쓰기도 못 하고 물어보지도 못하는 세션이 된다.
// 그래서 "provider:sessionId" -> mode 를 파일에 남겨 두고, 다시 열 때 그대로 건다.
function createStore(file) {
  const fs = require('fs');
  let map = null;
  function load() {
    if (map) return map;
    try { map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { map = {}; }
    if (typeof map !== 'object' || Array.isArray(map)) map = {};
    return map;
  }
  function key(provider, id) { return (provider === 'codex' ? 'codex' : 'claude') + ':' + id; }
  return {
    get(provider, id) {
      if (!id) return undefined;
      const mode = load()[key(provider, id)];
      return ['auto', 'full'].includes(mode) ? mode : undefined;
    },
    remember(provider, id, mode) {
      if (!id) return;
      const m = load(), k = key(provider, id);
      const next = mode === 'auto' || mode === 'full' ? mode : undefined;
      if (m[k] === next) return;
      if (next) m[k] = next; else delete m[k];
      try { fs.writeFileSync(file, JSON.stringify(m, null, 2), 'utf8'); } catch {}
    },
  };
}

module.exports = { normalizeMode, permissionArgs, requestedMode, createStore };
