'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createBridge, cleanText } = require('../bridge');

// 기본 fixture 는 큐/대기 동작을 본다. 화면 준비 판정(minScreen/settleMs)은
// 그 테스트들의 관심사가 아니라 아래 '시작 프롬프트' 테스트에서 따로 다룬다.
function fixture(term, opts) {
  let clock = 10000;
  const terms = term ? [term] : [];
  const writes = [];
  const bridge = createBridge({
    terminals: {
      list: () => terms,
      write: (id, data) => { writes.push({ id, data }); return true; },
    },
    startTarget: target => {
      const t = { id: 'term-new', provider: target.provider, sessionId: target.id,
        alive: true, status: null, startedAt: clock, lastAt: clock };
      terms.push(t);
      return t;
    },
    readyDelayMs: 1000,
    quietMs: 100,
    minScreen: 0,
    settleMs: 0,
    now: () => clock,
    ...(opts || {}),
  });
  return { bridge, terms, writes, tick(ms) { clock += ms; } };
}

const base = {
  source: { provider: 'claude', id: 'c1', title: '설계', project: 'C:\\work' },
  target: { provider: 'codex', id: 'x1', title: '구현', cwd: 'C:\\work' },
  text: '이 설계를 검토해 줘',
};

test('같은 provider 사이 전달은 거부한다', async () => {
  const f = fixture();
  await assert.rejects(() => f.bridge.send({ ...base,
    target: { ...base.target, provider: 'claude' } }), /사이에서만/);
  f.bridge.close();
});

test('꺼진 대상은 재개하고 준비된 뒤 한 번만 전달한다', async () => {
  const f = fixture();
  const queued = await f.bridge.send(base);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.launched, true);
  assert.equal(f.writes.length, 0);

  f.tick(1200);
  f.bridge.pump();
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].data, /\x1b\[200~/);
  assert.match(f.writes[0].data, /이 설계를 검토해 줘/);
  // Enter 는 같은 쓰기에 붙이지 않는다 - Codex 가 제출로 안 받는다
  assert.match(f.writes[0].data, /\x1b\[201~$/);
  assert.equal(f.bridge.get(queued.id).status, 'delivered');
  f.bridge.pump();
  assert.equal(f.writes.length, 1);
  f.bridge.close();
});

test('작업 중인 대상에는 끼워 넣지 않고 idle 이 되면 전달한다', async () => {
  const term = { id: 'term-1', provider: 'codex', sessionId: 'x1', alive: true,
    status: 'busy', startedAt: 0, lastAt: 0 };
  const f = fixture(term);
  const queued = await f.bridge.send(base);
  assert.equal(queued.status, 'queued');
  assert.equal(f.writes.length, 0);
  term.status = 'idle';
  f.bridge.pump();
  assert.equal(f.writes.length, 1);
  assert.equal(f.bridge.get(queued.id).status, 'delivered');
  f.bridge.close();
});

test('제어 문자는 제거하되 줄바꿈은 보존한다', () => {
  assert.equal(cleanText(' a\r\nb\x00\x1bc '), 'a\nbc');
});

// 실측(2026-09-21, Codex 이어하기):
//   0.4s  출력 16바이트인데 화면은 이미 '정지' 상태
//   3.2s  업데이트 알림 모달이 뜨고 사용자가 답할 때까지 남는다
// 그 사이에 전달이 나가서, 붙여넣기가 대화창이 아니라 메뉴로 들어갔다.
// 겉으로는 delivered 인데 상대는 아무것도 못 받은 상태가 됐다.
function screenFixture(buf) {
  let clock = 10000;
  const t = { id: 'term-new', provider: 'codex', sessionId: 'x1', alive: true,
    status: null, startedAt: clock, lastAt: clock, buf: buf };
  const writes = [];
  const bridge = createBridge({
    terminals: {
      list: () => [t],
      get: () => t,
      write: (id, data) => { writes.push({ id, data }); return true; },
    },
    startTarget: () => t,
    readyDelayMs: 1000, quietMs: 100,
    startupMs: 30000, settleMs: 4000, minScreen: 512,
    now: () => clock,
  });
  return { bridge, t, writes, tick(ms) { clock += ms; } };
}

const toCodex = {
  source: { provider: 'claude', id: 'c1', title: '설계', project: 'C:' + String.fromCharCode(92) + 'work' },
  target: { provider: 'codex', id: 'x1', title: '작업', cwd: 'C:' + String.fromCharCode(92) + 'work' },
  text: '이거 이어서 해줘',
};

test('시작 프롬프트가 떠 있으면 전달하지 않고 사유를 남긴다', async () => {
  const f = screenFixture('x'.repeat(900) + String.fromCharCode(10)
    + 'Update available! 0.155.0 -> 0.155.1' + String.fromCharCode(10)
    + 'Press enter to continue');
  const m = await f.bridge.send(toCodex);
  f.tick(20000); f.bridge.pump();
  assert.equal(f.writes.length, 0);
  assert.equal(f.bridge.get(m.id).status, 'queued');
  assert.equal(f.bridge.get(m.id).waitingOn, '확인 프롬프트');
});

test('화면이 거의 안 그려졌으면 조용해도 전달하지 않는다', async () => {
  const f = screenFixture('Resuming session…');   // 실측 0.4s 시점 - 16바이트
  const m = await f.bridge.send(toCodex);
  f.tick(20000); f.bridge.pump();
  assert.equal(f.writes.length, 0);
  assert.equal(f.bridge.get(m.id).status, 'queued');
});

test('프롬프트 없는 상태가 충분히 유지돼야 전달한다', async () => {
  const f = screenFixture('x'.repeat(900) + String.fromCharCode(10) + '› Ask Codex to do anything');
  const m = await f.bridge.send(toCodex);

  f.tick(1500); f.bridge.pump();          // 깨끗해진 지 얼마 안 됨
  assert.equal(f.writes.length, 0, '시작 직후엔 아직 쓰면 안 된다');

  f.tick(5000); f.bridge.pump();          // settleMs 를 넘김
  assert.equal(f.writes.length, 1);
  assert.equal(f.bridge.get(m.id).status, 'delivered');
});

test('시간이 지나도 프롬프트면 사유가 담긴 오류로 끝난다', async () => {
  const f = screenFixture('x'.repeat(900) + String.fromCharCode(10) + 'Press enter to continue');
  const m = await f.bridge.send(toCodex);
  // 실제로는 0.5초마다 pump 가 돌면서 사유를 계속 갱신한다. 만료 판정이 앞에 있으므로
  // 중간 pump 없이 11분을 건너뛰면 사유가 안 실린다 - 그 순서를 그대로 재현한다.
  f.tick(5000); f.bridge.pump();
  assert.equal(f.bridge.get(m.id).waitingOn, '확인 프롬프트');
  f.tick(11 * 60 * 1000); f.bridge.pump();
  const got = f.bridge.get(m.id);
  assert.equal(got.status, 'failed');
  assert.ok(got.error.indexOf('확인 프롬프트') >= 0, got.error);
});
