// 터미널 신원(sessionId/status)이 provider 별로 올바른 파일에서 오는지.
// CODEX_HOME 은 terminals.js 가 codex.js 를 require 하기 전에 정해져야 한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-termhome-'));
fs.mkdirSync(path.join(HOME, '.cc-launcher-live'), { recursive: true });
process.env.CODEX_HOME = HOME;

// 살아있는 PID 여야 한다 - liveMap 은 죽은 PID 의 상태 파일을 버린다.
const CODEX_PID = process.pid;
// terminals.js 가 이 디렉터리를 1초 메모하므로 첫 조회 전에 써 둔다.
fs.writeFileSync(path.join(HOME, '.cc-launcher-live', 'cx-1.json'), JSON.stringify({
  sessionId: 'cx-1', status: 'waiting', cwd: 'D:\\tmp', pid: CODEX_PID, at: Date.now() }), 'utf8');

const terminals = require('../terminals.js');

function fake(provider, pid) {
  return { id: 't1', action: 'new', cwd: 'D:\\tmp', sessionId: null, provider,
           title: 'x', pid, startedAt: 1, lastAt: 1, exitCode: null, exitedAt: null,
           cols: 80, rows: 24, buf: '', clients: new Set() };
}

// ~/.claude/sessions 에 실제로 있는 상태 파일 하나 (없으면 그 케이스는 건너뛴다)
function anyClaudeLive() {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (o && o.sessionId) return { pid: Number(path.basename(f, '.json')), o };
    } catch {}
  }
  return null;
}

// I6: Codex 터미널이 Claude 의 <pid>.json 을 읽으면 (1) 자기 sessionId 를 영영 못 찾고
// (2) Windows PID 재사용 때 죽은 Claude 세션의 id/상태/이름을 통째로 주워온다.
test('Codex 터미널은 Claude 상태 파일(~/.claude/sessions/<pid>.json)을 읽지 않는다', () => {
  const hit = anyClaudeLive();
  if (!hit) return;   // 이 머신에 살아있는 Claude 세션이 없으면 검증할 게 없다

  // 같은 pid 라도 provider 가 다르면 결과가 달라야 한다
  const asClaude = terminals.info(fake('claude', hit.pid));
  assert.equal(asClaude.sessionId, hit.o.sessionId);   // Claude 쪽은 예전 그대로

  const asCodex = terminals.info(fake('codex', hit.pid));
  assert.equal(asCodex.sessionId, null);
  assert.equal(asCodex.status, null);
  assert.equal(asCodex.name, null);
});

test('Codex 터미널은 Codex live 디렉터리에서 자기 sessionId 와 상태를 찾는다', () => {
  const t = fake('codex', CODEX_PID);
  const info = terminals.info(t);
  assert.equal(info.sessionId, 'cx-1');
  assert.equal(info.status, 'waiting');
  assert.equal(t.sessionId, 'cx-1');   // 다음 조회를 위해 터미널에도 박아둔다
});

test('Codex live 디렉터리에 없는 pid 는 아무것도 주워오지 않는다', () => {
  const info = terminals.info(fake('codex', 1));
  assert.equal(info.sessionId, null);
  assert.equal(info.status, null);
});

test('종료된 터미널은 어느 provider 든 상태를 읽지 않는다', () => {
  const t = fake('codex', CODEX_PID);
  t.exitCode = 0; t.exitedAt = Date.now();
  const info = terminals.info(t);
  assert.equal(info.alive, false);
  assert.equal(info.status, null);
});
