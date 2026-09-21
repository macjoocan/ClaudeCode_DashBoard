'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandoff, opposite, envelope } = require('../handoff');

test('반대 provider를 고른다', () => {
  assert.equal(opposite('claude'), 'codex');
  assert.equal(opposite('codex'), 'claude');
});

test('인수인계 봉투에 양쪽 provider와 프로젝트가 들어간다', () => {
  const s = envelope({ sourceProvider:'claude', targetProvider:'codex', cwd:'C:\\work' }, '완료 내용');
  assert.match(s, /Claude Code/);
  assert.match(s, /Codex/);
  assert.match(s, /C:\\work/);
  assert.match(s, /완료 내용/);
});

test('요약 응답 뒤 반대 AI를 열고 인수인계를 전달한다', async () => {
  const writes = [];
  const source = { id:'t1', provider:'claude', sessionId:'s1', cwd:'C:\\work', exitCode:null, lastAt:0, buf:'ready' };
  const target = { id:'t2', provider:'codex', sessionId:null, cwd:'C:\\work', exitCode:null, lastAt:0, buf:'ready' };
  let reads = 0;
  const terms = new Map([['t1', source]]);
  const manager = createHandoff({
    terminals: {
      get:id => terms.get(id),
      info:t => ({ id:t.id, provider:t.provider, sessionId:t.sessionId, cwd:t.cwd, status:'idle' }),
      write(id, text) { writes.push({id,text}); return true; },
    },
    readTranscript: async () => reads++ ? [{role:'assistant', text:'새 요약', ts:'2'}] : [{role:'assistant', text:'이전 답변', ts:'1'}],
    startTarget: async spec => { assert.equal(spec.provider, 'codex'); terms.set('t2', target); return target; },
    pollMs: 1, quietMs: 1, summaryTimeoutMs: 100, targetTimeoutMs: 100,
    // 이 테스트는 흐름(요약 -> 대상 열기 -> 전달)을 본다. 화면 준비 판정은
    // 아래 '부팅 중' 테스트에서 따로 다룬다.
    minScreen: 0, settleMs: 0, submitDelayMs: 1,
  });
  const job = await manager.start('t1');
  for (let i=0; i<100 && manager.get(job.id).status !== 'sent'; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(manager.get(job.id).status, 'sent');
  // 붙여넣기와 Enter 가 따로 나가므로 붙여넣기만 골라 본다
  const pastes = writes.filter(w => w.text.length > 1);
  assert.equal(pastes.length, 2);
  assert.equal(pastes[0].id, 't1');
  assert.equal(pastes[1].id, 't2');
  assert.match(pastes[1].text, /새 요약/);
  manager.close();
});

// 실측(2026-09-21): 대상 Claude 가 아직 부팅 중일 때 인수인계를 써서 그대로 버려졌다.
// job 은 sent 인데 대상 화면엔 문구가 없었다 - 거짓 성공이다.
test('부팅 중인 대상에는 쓰지 않고 실패로 끝낸다', async () => {
  const writes = [];
  const source = { id:'t1', provider:'claude', sessionId:'s1', cwd:'C:' + String.fromCharCode(92) + 'work',
    exitCode:null, lastAt:0, buf:'x'.repeat(600) };
  const target = { id:'t2', provider:'codex', sessionId:null, cwd:'C:' + String.fromCharCode(92) + 'work',
    exitCode:null, lastAt:0, buf:'부팅중' };   // 화면이 거의 안 그려진 상태
  let reads = 0;
  const terms = new Map([['t1', source]]);
  const manager = createHandoff({
    terminals: {
      get:id => terms.get(id),
      info:t => ({ id:t.id, provider:t.provider, sessionId:t.sessionId, cwd:t.cwd, status:'idle' }),
      write(id, text) { writes.push({id,text}); return true; },
    },
    // 첫 호출은 기준선, 그 다음부터 새 요약이 온 것으로 본다
    readTranscript: async () => reads++ ? [{role:'assistant', text:'새 요약', ts:'2'}]
                                       : [{role:'assistant', text:'이전 답변', ts:'1'}],
    startTarget: async () => { terms.set('t2', target); return target; },
    pollMs: 1, quietMs: 1, summaryTimeoutMs: 200, targetTimeoutMs: 60,
    minScreen: 512, settleMs: 5, submitDelayMs: 1,
  });
  const job = await manager.start('t1');
  for (let i=0; i<200 && manager.get(job.id).status !== 'failed'; i++) await new Promise(r => setTimeout(r, 2));
  const got = manager.get(job.id);
  assert.equal(got.status, 'failed');
  assert.match(got.error, /준비되지 않았습니다/);
  // 대상에는 아무것도 쓰지 않았어야 한다
  assert.equal(writes.filter(w => w.id === 't2').length, 0);
  manager.close();
});
