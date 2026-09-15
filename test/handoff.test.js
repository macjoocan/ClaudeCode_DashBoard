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
  });
  const job = await manager.start('t1');
  for (let i=0; i<100 && manager.get(job.id).status !== 'sent'; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(manager.get(job.id).status, 'sent');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].id, 't1');
  assert.equal(writes[1].id, 't2');
  assert.match(writes[1].text, /새 요약/);
  manager.close();
});
