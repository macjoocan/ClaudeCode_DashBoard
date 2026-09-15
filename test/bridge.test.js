'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createBridge, cleanText } = require('../bridge');

function fixture(term) {
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
    now: () => clock,
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
  assert.match(f.writes[0].data, /\x1b\[201~\r$/);
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
