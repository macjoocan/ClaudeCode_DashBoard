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

// PTY 에 썼다는 것과 상대가 받았다는 것은 다르다. 실측: 상태는 delivered 인데
// Codex 세션 기록에는 없는 경우가 있었다. 결과를 확인하고, 안 들어갔으면 다시 쓴다.
function verifyFixture(opts) {
  let clock = 10000;
  const t = { id: 'term-new', provider: 'codex', sessionId: 'x1', alive: true,
    status: null, startedAt: clock, lastAt: clock, buf: 'x'.repeat(900) };
  const writes = [];
  const bridge = createBridge({
    terminals: {
      list: () => [t], get: () => t,
      write: (id, data) => { writes.push({ id, data }); return true; },
    },
    startTarget: () => t,
    readyDelayMs: 1000, quietMs: 100, minScreen: 0, settleMs: 0,
    submitDelayMs: 1, verifyWindowMs: 5000, maxSends: 3,
    now: () => clock,
    ...(opts || {}),
  });
  return { bridge, writes, tick(ms) { clock += ms; } };
}

const toCodex2 = {
  source: { provider: 'claude', id: 'c1', title: '설계', project: 'C:' + String.fromCharCode(92) + 'work' },
  target: { provider: 'codex', id: 'x1', title: '작업', cwd: 'C:' + String.fromCharCode(92) + 'work' },
  text: '이어서 해줘',
};

test('상대 기록에 나타나야 delivered 로 본다', async () => {
  let landed = false;
  const f = verifyFixture({ verify: async () => landed });
  const m = await f.bridge.send(toCodex2);
  f.tick(1200); f.bridge.pump();
  assert.equal(f.writes.filter(w => w.data.length > 1).length, 1, '한 번 썼다');
  await f.bridge.checkDelivered();
  assert.equal(f.bridge.get(m.id).status, 'queued', '아직 확인 안 됨');

  landed = true;
  await f.bridge.checkDelivered();
  assert.equal(f.bridge.get(m.id).status, 'delivered');
});

test('확인 창 안에는 다시 쓰지 않는다', async () => {
  const f = verifyFixture({ verify: async () => false });
  await f.bridge.send(toCodex2);
  f.tick(1200); f.bridge.pump();
  f.tick(1000); f.bridge.pump();          // 확인 창(5초) 안이다
  assert.equal(f.writes.filter(w => w.data.length > 1).length, 1);
});

test('확인 창이 지나면 다시 쓰고, 횟수를 넘기면 사유를 남기고 끝낸다', async () => {
  const f = verifyFixture({ verify: async () => false });
  const m = await f.bridge.send(toCodex2);
  for (let i = 0; i < 4; i++) { f.tick(6000); f.bridge.pump(); }
  const pastes = f.writes.filter(w => w.data.length > 1).length;
  assert.equal(pastes, 3, '최대 3회까지만 쓴다');
  const got = f.bridge.get(m.id);
  assert.equal(got.status, 'failed');
  assert.ok(got.error.indexOf('나타나지 않았습니다') >= 0, got.error);
  assert.equal(got.sends, 3);
});

test('확인 수단이 없으면 예전처럼 쓴 즉시 완료로 본다', async () => {
  const f = verifyFixture({ verify: null });
  const m = await f.bridge.send(toCodex2);
  f.tick(1200); f.bridge.pump();
  assert.equal(f.bridge.get(m.id).status, 'delivered');
});

// 확인 창이 짧으면 중복 전송이 난다. 상대가 받아 기록에 적기까지 걸리는 시간보다
// 창이 짧으면, 멀쩡히 간 메시지를 한 번 더 보낸다(실측: 봉투가 두 번 찍혔다).
test('확인이 늦게 되는 경우에도 두 번 보내지 않는다', async () => {
  let landed = false;
  const f = verifyFixture({ verify: async () => landed, verifyWindowMs: 60000, maxSends: 2 });
  const m = await f.bridge.send(toCodex2);
  f.tick(1200); f.bridge.pump();
  assert.equal(f.writes.filter(w => w.data.length > 1).length, 1);

  // 상대가 30초 뒤에야 기록에 적었다 - 창(60초) 안이므로 재전송이 없어야 한다
  f.tick(30000); f.bridge.pump();
  assert.equal(f.writes.filter(w => w.data.length > 1).length, 1, '창 안에서는 다시 안 쓴다');

  landed = true;
  await f.bridge.checkDelivered();
  assert.equal(f.bridge.get(m.id).status, 'delivered');
  assert.equal(f.bridge.get(m.id).sends, 1, '한 번만 보냈다');
});

// 붙여넣기 직후의 Enter 가 씹히면 본문이 컴포저에 남는다. 사람이 Enter 를 누르기
// 전까지 전달이 안 된다(실측). 본문을 다시 쓰면 중복이 나므로, 맨 Enter 만 넣는다.
test('제출이 씹히면 Enter 만 한 번 더 넣는다', () => {
  // submitDelayMs 를 크게 둬서 붙여넣기 직후의 Enter(진짜 타이머)는 이 시험 동안 안 온다.
  // 여기서 세는 Enter 는 오직 '씹혔을 때 넣는 것' 뿐이다.
  const f = verifyFixture({ verify: async () => false, verifyWindowMs: 60000,
    nudgeAfterMs: 8000, submitDelayMs: 600000 });
  return f.bridge.send(toCodex2).then(() => {
    f.tick(1200); f.bridge.pump();
    const pastes = () => f.writes.filter(w => w.data.length > 1).length;
    const enters = () => f.writes.filter(w => w.data === '\r').length;
    assert.equal(pastes(), 1);

    f.tick(3000); f.bridge.pump();
    assert.equal(enters(), 0, '아직 이르다');

    f.tick(6000); f.bridge.pump();
    assert.equal(enters(), 1, 'Enter 를 한 번 넣는다');
    assert.equal(pastes(), 1, '본문은 다시 쓰지 않는다 - 중복이 난다');

    f.tick(6000); f.bridge.pump();
    f.tick(6000); f.bridge.pump();
    assert.equal(enters(), 1, '한 번만 넣는다');
  });
});
