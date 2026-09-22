// /api/ask 의 한도 가드.
//
// 왜 가드가 먼저인가: 이 엔드포인트는 화면이 부른다. 화면을 잘못 짜서 무한 호출이
// 돌면 하루치 구독 한도가 날아간다. 호출당 16k~24k 토큰이고(실측), 동시 1개에
// 12~20초라 분당 5회가 구조적 천장이다 - 분당만으로는 못 막는다. 실제 방어선은
// 일일 토큰 상한이다.
//
// 가드는 아무것도 실행하지 않는다. "받아도 되나" 만 답한다. 그래야 자식 프로세스
// 없이 상한을 시험할 수 있다.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createGuard } = require('../ask-guard');

// 시계와 저장소를 주입한다 (bridge.js 와 같은 방식).
function fixture(limits) {
  let clock = 1000000;
  let saved = null;
  const g = createGuard({
    now: () => clock,
    load: () => saved,
    save: (o) => { saved = o; },
    limits: Object.assign({ perMinute: 5, perDayTokens: 300000, cacheTtlMs: 600000 }, limits || {}),
  });
  return { g, tick(ms) { clock += ms; }, saved: () => saved };
}

const req = { provider: 'codex', prompt: '이 화면 뭐가 문제야', schema: null };

test('분당 상한을 넘으면 거부하고 이유를 준다', async () => {
  const f = fixture({ perMinute: 2 });

  for (let i = 0; i < 2; i++) {
    const a = await f.g.acquire(req);
    assert.equal(a.ok, true, i + '번째는 통과해야 한다');
    f.g.finish(a.ticket, { tokens: 100 });
  }

  const third = await f.g.acquire(req);
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'per_minute');
  assert.ok(third.message, '이유가 화면까지 가야 한다 - 조용히 실패하지 않는다');
});

test('일일 토큰 상한을 넘으면 거부한다', async () => {
  const f = fixture({ perMinute: 100, perDayTokens: 50000 });

  const a = await f.g.acquire(req);
  f.g.finish(a.ticket, { tokens: 50000 });       // 여기서 상한에 닿는다

  const b = await f.g.acquire(req);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'daily_tokens');
  assert.ok(b.message);
});

test('이미 실행 중이면 거부하지 않고 끝날 때까지 기다린다', async () => {
  const f = fixture({ perMinute: 100 });

  const first = await f.g.acquire(req);
  assert.equal(first.ok, true);

  let second = null;
  const waiting = f.g.acquire({ provider: 'codex', prompt: '다른 질문', schema: null })
    .then((r) => { second = r; });

  await new Promise((r) => setImmediate(r));
  assert.equal(second, null, '앞 호출이 도는 동안은 슬롯을 안 준다');

  f.g.finish(first.ticket, { tokens: 100 });
  await waiting;
  assert.equal(second.ok, true, '앞이 끝나면 풀려야 한다 - 거부가 아니다');
});

test('같은 프롬프트는 캐시에서 나오고 상한을 먹지 않는다', async () => {
  const f = fixture({ perMinute: 1 });          // 한 번 쓰면 더는 못 부른다

  const a = await f.g.acquire(req);
  f.g.finish(a.ticket, { tokens: 24000, result: { 답: '여기' } });

  const b = await f.g.acquire(req);
  assert.equal(b.ok, true, '분당 상한을 썼어도 캐시는 나가야 한다');
  assert.deepEqual(b.cached, { 답: '여기' });
  assert.equal(b.ticket, undefined, '실행할 게 아니니 슬롯을 주면 안 된다');
});

test('캐시는 TTL 이 지나면 안 쓴다', async () => {
  const f = fixture({ perMinute: 100, cacheTtlMs: 1000 });

  const a = await f.g.acquire(req);
  f.g.finish(a.ticket, { tokens: 100, result: { 답: '옛것' } });

  f.tick(1001);
  const b = await f.g.acquire(req);
  assert.equal(b.cached, undefined, 'TTL 이 지났으면 다시 물어봐야 한다');
  assert.ok(b.ticket, '실행 슬롯을 받아야 한다');
});

test('재시작해도 오늘 쓴 토큰이 이어진다', async () => {
  // 메모리에만 두면 서버를 다시 띄울 때마다 원장이 0 이 된다. 무한 호출을 막으려고
  // 넣은 상한인데, 그 무한 호출이 서버를 죽이면 상한도 같이 지워지는 꼴이 된다.
  let clock = 1000000;
  let disk = null;
  const mk = () => createGuard({
    now: () => clock, load: () => disk, save: (o) => { disk = o; },
    limits: { perMinute: 100, perDayTokens: 50000, cacheTtlMs: 600000 },
  });

  const g1 = mk();
  const a = await g1.acquire(req);
  g1.finish(a.ticket, { tokens: 50000 });

  const g2 = mk();                              // 서버 재시작
  const b = await g2.acquire(req);
  assert.equal(b.ok, false, '재시작이 상한을 지우면 안 된다');
  assert.equal(b.reason, 'daily_tokens');
});

test('날이 바뀌면 원장이 0 에서 다시 시작한다', async () => {
  const f = fixture({ perMinute: 100, perDayTokens: 50000 });

  const a = await f.g.acquire(req);
  f.g.finish(a.ticket, { tokens: 50000 });

  f.tick(24 * 60 * 60 * 1000);
  const b = await f.g.acquire({ provider: 'codex', prompt: '내일 질문', schema: null });
  assert.equal(b.ok, true, '하루가 지나면 다시 쓸 수 있어야 한다');
});

test('실행이 실패하면 슬롯은 돌려주고 토큰은 세지 않는다', async () => {
  const f = fixture({ perMinute: 100, perDayTokens: 50000 });

  const a = await f.g.acquire(req);
  f.g.abandon(a.ticket);                        // 자식 프로세스가 죽었다

  assert.equal(f.saved().tokens, 0, '받지도 못한 응답의 토큰을 셀 수는 없다');

  const b = await f.g.acquire({ provider: 'codex', prompt: '다시', schema: null });
  assert.equal(b.ok, true, '슬롯이 막혀 있으면 안 된다');
  assert.ok(b.ticket);
});
