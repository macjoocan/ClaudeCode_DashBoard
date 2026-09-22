// /api/ask 의 실행기 - CLI 를 자식 프로세스로 부르고 결과와 토큰 수를 읽어 온다.
//
// 구독 로그인 그대로 쓴다. API 키가 어디에도 안 들어간다(실측: codex exec 20초/23,864
// 토큰, claude -p 12초/16,023+191). 그래서 실행기는 키를 모르고, 자식이 알아서 쓴다.
//
// 가짜 spawn 으로 시험한다. 진짜를 부르면 시험 한 번에 2만 토큰이 나간다.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createRunner } = require('../ask-run');

// 자식 흉내. write 한 것을 받아 두고, 아무 때나 종료시킬 수 있다.
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = { written: '', write(x) { this.written += x; }, end() { this.ended = true; }, on() {} };
  c.killed = false;
  c.kill = () => { c.killed = true; c.emit('close', null); };
  return c;
}

function fixture() {
  const calls = [];
  let child = null;
  const runner = createRunner({
    spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); child = fakeChild(); return child; },
    timeoutMs: 60000,
  });
  return { runner, calls, child: () => child };
}

test('claude 는 -p 와 json 출력으로 부르고 결과와 토큰을 읽는다', async () => {
  const f = fixture();
  const p = f.runner.run({ provider: 'claude', prompt: '이 화면 뭐가 문제야' });

  await new Promise((r) => setImmediate(r));
  const a = f.calls[0].args;
  assert.ok(a.includes('-p'), '-p 로 한 번만 묻는다');
  assert.ok(!a.some((x) => x.includes('이 화면')), '프롬프트는 argv 에 없어야 한다');
  assert.ok(a.includes('--output-format') && a.includes('json'), a.join(' '));

  f.child().stdout.emit('data', Buffer.from(JSON.stringify({
    result: '{"원인":"스크롤백"}',
    usage: { input_tokens: 16023, output_tokens: 191 },
  })));
  f.child().emit('close', 0);

  const out = await p;
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.result, { 원인: '스크롤백' });
  assert.equal(out.tokens, 16214, '한도 원장에 넣을 수 있어야 한다');
});

// codex exec --json 의 실제 출력(2026-09-23 실측, codex exec --skip-git-repo-check --json):
//
//   {"type":"thread.started","thread_id":...}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions..."}}
//   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"4입니다."}}
//   {"type":"turn.completed","usage":{"input_tokens":19593,"cached_input_tokens":12160,
//                                     "cache_write_input_tokens":0,"output_tokens":7,...}}
//
// 처음엔 rollout 파일과 같은 event_msg/payload 봉투일 거라 짐작했는데 아니었다.
// 최상위 type 이 점 표기이고, 토큰은 turn.completed.usage 에 한 번만 온다.
function codexLines(objs) {
  return objs.map((o) => JSON.stringify(o)).join(String.fromCharCode(10));
}

test('codex 는 turn.completed 의 usage 로 토큰을 세고 agent_message 를 답으로 쓴다', async () => {
  const f = fixture();
  const p = f.runner.run({ provider: 'codex', prompt: '2 더하기 2 는?', schema: { type: 'object' } });

  await new Promise((r) => setImmediate(r));
  const a = f.calls[0].args;
  assert.ok(a.includes('exec') && a.includes('--json'), a.join(' '));
  assert.ok(a.includes('--output-schema'), '스키마를 줬으면 넘겨야 한다');
  assert.ok(a.includes('--skip-git-repo-check'), '아무 폴더에서나 돌아야 한다');

  f.child().stdout.emit('data', Buffer.from(codexLines([
    { type: 'thread.started', thread_id: 'x' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Skill descriptions were shortened' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '{"합":4}' } },
    { type: 'turn.completed', usage: { input_tokens: 19593, cached_input_tokens: 12160, output_tokens: 7 } },
  ])));
  f.child().emit('close', 0);

  const out = await p;
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(out.result, { 합: 4 });
  assert.equal(out.tokens, 19600, 'input + output. 캐시분도 한도를 먹는다');
});

test('치명적이지 않은 error 항목을 답으로 착각하지 않는다', async () => {
  // 실측에서 매번 앞에 낀다. 이걸 답으로 잡으면 화면에 경고문이 결과로 뜬다.
  const f = fixture();
  const p = f.runner.run({ provider: 'codex', prompt: '무엇' });
  await new Promise((r) => setImmediate(r));

  f.child().stdout.emit('data', Buffer.from(codexLines([
    { type: 'item.completed', item: { type: 'error', message: '경고일 뿐' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '진짜 답' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } },
  ])));
  f.child().emit('close', 0);

  const out = await p;
  assert.equal(out.result, '진짜 답');
});

test('답이 하나도 없으면 왜 없는지 알 수 있게 실패한다', async () => {
  const f = fixture();
  const p = f.runner.run({ provider: 'codex', prompt: '무엇' });
  await new Promise((r) => setImmediate(r));

  f.child().stdout.emit('data', Buffer.from(codexLines([{ type: 'turn.started' }])));
  f.child().emit('close', 0);

  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'parse');
});

test('시간이 지나면 자식을 죽이고 이유를 준다', async () => {
  const calls = [];
  let child = null;
  const runner = createRunner({
    spawn: () => { child = fakeChild(); return child; },
    timeoutMs: 10,
  });

  const out = await runner.run({ provider: 'claude', prompt: '답 없는 질문' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'timeout');
  assert.equal(child.killed, true, '안 죽이면 자식이 남아 한도를 계속 먹는다');
});

test('자식이 실패로 끝나면 stderr 를 이유에 담는다', async () => {
  const f = fixture();
  const p = f.runner.run({ provider: 'claude', prompt: '무엇' });
  await new Promise((r) => setImmediate(r));

  f.child().stderr.emit('data', Buffer.from('not logged in'));
  f.child().emit('close', 1);

  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'exit');
  assert.ok(out.message.includes('not logged in'), '왜 안 됐는지가 화면까지 가야 한다');
});

test('부르는 쪽이 취소하면 자식을 죽인다', async () => {
  const f = fixture();
  const p = f.runner.run({ provider: 'claude', prompt: '긴 것' });
  await new Promise((r) => setImmediate(r));

  p.cancel();
  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'canceled');
  assert.equal(f.child().killed, true);
});

// 실측: CLI 를 못 찾으면 spawn 이 'error' 를 낸다. 그걸 안 받으면 unhandled 'error'
// 로 **서버 프로세스가 통째로 죽는다**. 화면이 부르는 엔드포인트가 서버를 죽이면
// 대시보드의 터미널 세션까지 같이 날아간다.
test('자식을 못 띄워도 서버를 죽이지 않고 이유로 돌려준다', async () => {
  let child = null;
  const runner = createRunner({
    spawn: () => { child = fakeChild(); return child; },
    timeoutMs: 60000,
  });

  const p = runner.run({ provider: 'claude', prompt: '무엇' });
  await new Promise((r) => setImmediate(r));

  const err = new Error('spawn claude ENOENT');
  err.code = 'ENOENT';
  child.emit('error', err);                     // 아무도 안 받으면 여기서 프로세스가 죽는다

  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'spawn');
  assert.ok(out.message.includes('ENOENT'), out.message);
});

test('부를 CLI 경로를 받아서 쓴다', async () => {
  // Windows 에서 'claude' 는 없다. claude.cmd 다. server.js 가 이미 찾아 둔 경로를
  // 그대로 받아 쓴다 - 실행기가 다시 찾아 헤맬 이유가 없다.
  const calls = [];
  const runner = createRunner({
    spawn: (cmd) => { calls.push(cmd); return fakeChild(); },
    bin: { claude: 'C:/npm/claude.cmd', codex: 'C:/npm/codex.cmd' },
  });

  runner.run({ provider: 'claude', prompt: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls[0], 'C:/npm/claude.cmd');
});

// 프롬프트는 브라우저에서 오는 값이다. Windows 에서 .cmd 를 띄우려면 shell 을 거쳐야
// 하는데(Node 가 .cmd 직접 실행을 막는다 - 실측 spawn EINVAL), shell 에 사용자 문자열을
// argv 로 실으면 그대로 명령 주입이 된다. 그래서 프롬프트는 stdin 으로만 넘긴다.
// 길이 제한(Windows 명령줄 약 32KB)도 같이 사라진다.
test('프롬프트는 argv 가 아니라 stdin 으로 넘긴다', async () => {
  const calls = [];
  let child = null;
  const runner = createRunner({
    spawn: (cmd, args) => { calls.push({ cmd, args }); child = fakeChild(); return child; },
  });

  const 위험 = '무엇 " && del /q C:' + String.fromCharCode(92) + '* &';
  runner.run({ provider: 'codex', prompt: 위험 });
  await new Promise((r) => setImmediate(r));

  assert.ok(!calls[0].args.some((a) => a.indexOf('del /q') >= 0), 'argv 에 실리면 주입된다');
  assert.equal(child.stdin.written, 위험);
  assert.equal(child.stdin.ended, true, '안 닫으면 CLI 가 입력을 기다리며 안 끝난다');
});

test('.cmd 는 shell 로 띄운다', async () => {
  const calls = [];
  const runner = createRunner({
    spawn: (cmd, args, o) => { calls.push({ cmd, o }); return fakeChild(); },
    bin: { claude: 'C:/npm/claude.cmd' },
  });

  runner.run({ provider: 'claude', prompt: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls[0].o.shell, true, 'Node 는 .cmd 직접 실행을 막는다 (spawn EINVAL)');
});

test('확장자 없는 실행파일은 shell 없이 띄운다', async () => {
  const calls = [];
  const runner = createRunner({
    spawn: (cmd, args, o) => { calls.push({ cmd, o }); return fakeChild(); },
    bin: { claude: '/usr/local/bin/claude' },
  });

  runner.run({ provider: 'claude', prompt: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.ok(!calls[0].o.shell, 'shell 은 필요할 때만 쓴다');
});
