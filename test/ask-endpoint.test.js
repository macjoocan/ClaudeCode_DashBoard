// /api/ask 배선 - 가드와 실행기를 잇는 자리.
//
// 여기서 지킬 것은 하나다: **가드를 우회할 길이 없어야 한다.**
// 거부는 이유를 달고 나가고(조용히 실패하지 않는다), 실행이 실패하면 슬롯을 돌려준다.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createAsk } = require('../ask');

function fixture(over) {
  const events = [];
  const guard = {
    acquire: async (r) => { events.push('acquire'); return (over && over.acquire) || { ok: true, ticket: {} }; },
    finish: (t, o) => { events.push('finish:' + o.tokens); },
    abandon: () => { events.push('abandon'); },
  };
  const runner = {
    run: () => {
      const p = Promise.resolve((over && over.run) || { ok: true, result: { 답: '됐다' }, tokens: 1234 });
      p.cancel = () => {};
      return p;
    },
  };
  return { ask: createAsk({ guard, runner }), events };
}

test('통과하면 결과를 주고 쓴 토큰을 원장에 넣는다', async () => {
  const f = fixture();
  const out = await f.ask({ provider: 'codex', prompt: '정리해줘' });

  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { 답: '됐다' });
  assert.deepEqual(f.events, ['acquire', 'finish:1234'], '토큰을 안 넣으면 상한이 안 는다');
});

test('가드가 막으면 부르지 않고 이유를 그대로 낸다', async () => {
  const f = fixture({ acquire: { ok: false, reason: 'daily_tokens', message: '오늘 치를 다 썼다' } });
  const out = await f.ask({ provider: 'codex', prompt: '정리해줘' });

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'daily_tokens');
  assert.ok(out.message, '조용히 실패하면 화면이 이유를 못 보여준다');
  assert.deepEqual(f.events, ['acquire'], '막았는데 자식을 띄우면 가드가 있으나 마나다');
});

test('캐시 적중이면 실행기를 부르지 않는다', async () => {
  const f = fixture({ acquire: { ok: true, cached: { 답: '전에 것' } } });
  const out = await f.ask({ provider: 'codex', prompt: '정리해줘' });

  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { 답: '전에 것' });
  assert.equal(out.cached, true, '캐시에서 나온 것인지 화면이 알 수 있어야 한다');
  assert.deepEqual(f.events, ['acquire'], '슬롯도 안 잡았으니 반납할 것도 없다');
});

test('실행이 실패하면 슬롯을 돌려준다', async () => {
  const f = fixture({ run: { ok: false, reason: 'timeout', message: '60000ms 안에 답이 없었다' } });
  const out = await f.ask({ provider: 'codex', prompt: '정리해줘' });

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'timeout');
  assert.deepEqual(f.events, ['acquire', 'abandon'], '안 돌려주면 다음 호출이 영영 못 들어온다');
});

test('모르는 provider 는 가드를 잡기도 전에 막는다', async () => {
  const f = fixture();
  const out = await f.ask({ provider: 'gpt', prompt: '정리해줘' });

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'bad_request');
  assert.deepEqual(f.events, [], '슬롯을 잡았다가 놓는 낭비를 하지 않는다');
});

test('프롬프트가 비면 막는다', async () => {
  const f = fixture();
  const out = await f.ask({ provider: 'codex', prompt: '   ' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'bad_request');
});

// 거부 이유마다 맞는 HTTP 상태를 달아 보낸다. 상태를 server.js 안에서 정하면
// 시험할 자리가 없어져서, 판정한 쪽이 같이 들고 나온다.
test('상한에 걸린 것과 잘못 부른 것은 다른 상태로 나간다', async () => {
  const bad = await fixture().ask({ provider: 'gpt', prompt: '안녕' });
  assert.equal(bad.status, 400, '잘못 부른 것을 429 로 주면 "좀 쉬면 되나" 로 읽힌다');

  const over = await fixture({ acquire: { ok: false, reason: 'per_minute', message: '분당 상한' } })
    .ask({ provider: 'codex', prompt: '안녕' });
  assert.equal(over.status, 429);

  const dead = await fixture({ run: { ok: false, reason: 'timeout', message: '답이 없었다' } })
    .ask({ provider: 'codex', prompt: '안녕' });
  assert.equal(dead.status, 502, '자식이 못 답한 건 우리 잘못도 부른 쪽 잘못도 아니다');

  const good = await fixture().ask({ provider: 'codex', prompt: '안녕' });
  assert.equal(good.status, 200);
});
