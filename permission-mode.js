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

module.exports = { normalizeMode, permissionArgs, requestedMode };
