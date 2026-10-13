// Claude Code 에서 Codex 세션으로 말을 보내는 MCP 도구.
//
// 왜 필요했나: Claude Code 의 SendMessage 는 Claude 세션만 안다. Codex ID 를 주면
// 반송된다. 반대 방향이 멀쩡했던 것은 Codex 에 그런 자체 기능이 없어서 무조건
// 대시보드 브리지를 탔기 때문이다. 즉 빠진 것은 Claude 쪽 손잡이뿐이었다.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pickSource, resolveSession, sameDir, listText, TOOLS } = require('../mcp-bridge');

const S = (id, provider, extra) => Object.assign(
  { id, provider, live: false, cwd: 'C:\\a', project: 'a', title: '', mtime: 0 }, extra);

test('경로 비교는 구분자와 대소문자를 가리지 않는다', () => {
  assert.ok(sameDir('C:\\00.SVN\\x', 'c:/00.svn/x/'));
  assert.ok(!sameDir('', 'C:\\a'));
  assert.ok(!sameDir('C:\\a', 'C:\\b'));
});

test('대상을 제외한 유일한 같은 폴더 live 세션을 고른다', () => {
  const all = [S('cx', 'codex', { live: true }), S('cl', 'claude', { live: true })];
  assert.equal(pickSource(all, all[0], 'C:\\a').id, 'cl');
  assert.equal(pickSource(all, all[1], 'C:\\a').id, 'cx');
  all[1].provider = 'codex';
  assert.equal(pickSource(all, all[0], 'C:\\a').id, 'cl');
});

test('같은 폴더에서 돌고 있는 세션을 먼저 고른다', () => {
  const all = [
    S('other', 'claude', { live: true, cwd: 'C:\\b' }),
    S('here', 'claude', { live: true, cwd: 'C:\\a' }),
  ];
  assert.equal(pickSource(all, S('target', 'codex'), 'C:\\a').id, 'here');
});

test('종료된 세션을 발신으로 추측하지 않는다', () => {
  const all = [S('old', 'claude', { mtime: 1 }), S('new', 'claude', { mtime: 9 })];
  assert.equal(pickSource(all, S('target', 'codex'), 'C:\\zzz'), null);
});

test('보낼 상대가 아예 없으면 null', () => {
  assert.equal(pickSource([S('cx', 'codex')], S('cx', 'codex'), 'C:\\a'), null);
});

test('발신이 모호하면 ID 지정을 요청하고 provider 필터를 지원한다', () => {
  const all = [S('a', 'claude', { live: true }), S('b', 'codex', { live: true })];
  assert.throws(() => pickSource(all, S('target', 'codex'), 'C:\\a'), /from_session_id/);
  assert.equal(pickSource(all, S('target', 'codex'), 'C:\\a', 'codex').id, 'b');
  const duplicate = [S('same', 'claude'), S('same', 'codex')];
  assert.throws(() => resolveSession(duplicate, 'same', null, 'session_id'), /중복/);
  assert.equal(resolveSession(duplicate, 'same', 'codex', 'session_id').provider, 'codex');
});

test('목록은 provider 로 나누고 실행 중을 표시한다', () => {
  const txt = listText([S('cx', 'codex', { live: true, title: '작업' }), S('cl', 'claude')], {});
  assert.match(txt, /Codex 세션/);
  assert.match(txt, /Claude Code 세션/);
  assert.match(txt, /cx {2}● /);
});

test('한쪽만 보여줄 수 있다', () => {
  const txt = listText([S('cx', 'codex'), S('cl', 'claude')], { provider: 'codex' });
  assert.ok(txt.includes('cx'));
  assert.ok(!txt.includes('cl '));
});

test('발신을 직접 지정할 수 있다', () => {
  // 한 폴더에 세션이 여러 개면 자동 선택이 엉뚱한 것을 집을 수 있다.
  const send = TOOLS.find(t => t.name === 'session_send');
  assert.ok(send.inputSchema.properties.from_session_id, 'from_session_id 가 있어야 한다');
  assert.ok(!send.inputSchema.required.includes('from_session_id'), '필수는 아니어야 한다');
});

test('도구 설명에 Codex 로 보낼 때 쓰라는 말이 있다', () => {
  // 모델이 SendMessage 대신 이걸 집게 하는 것이 이 도구의 존재 이유다.
  const send = TOOLS.find(t => t.name === 'session_send');
  assert.match(send.description, /SendMessage/);
  assert.deepEqual(send.inputSchema.required, ['session_id', 'text']);
});

// MCP 클라이언트가 실제로 말을 거는 방식 그대로 굴려 본다.
function rpc(lines, port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-bridge.js')],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        ...(port ? { CC_LAUNCHER_PORT: String(port) } : {}) } });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(out.trim().split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse)));
    for (const l of lines) p.stdin.write(JSON.stringify(l) + String.fromCharCode(10));
    p.stdin.end();
    setTimeout(() => { try { p.kill(); } catch {} }, 8000);
  });
}

test('initialize 와 tools/list 에 답한다', async () => {
  const [init, list] = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'cc-launcher-bridge');
  assert.deepEqual(list.result.tools.map(t => t.name), ['session_list', 'session_send']);
});

test('알림에는 답하지 않는다', async () => {
  const msgs = await rpc([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 7, method: 'ping' },
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, 7);
});

test('도구가 실패해도 프로토콜 오류로 내지 않는다', async () => {
  // 모델이 읽고 스스로 고칠 수 있어야 한다. 오류로 내면 그냥 끊긴다.
  const [res] = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_send', arguments: { text: '' } } },
  ]);
  assert.ok(!res.error, '프로토콜 오류로 내면 안 된다');
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /session_id/);
});

test('실제 MCP stdio→HTTP 요청은 네 방향을 지원하고 self-send는 전송 전에 거부한다', async t => {
  const http = require('node:http');
  const sent = [];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/projects') return res.end(JSON.stringify({ projects: [{
      cwd: process.cwd(), name: 'test', sessions: [S('c1', 'claude'), S('c2', 'claude'), S('x1', 'codex'), S('x2', 'codex')]
    }] }));
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      sent.push(JSON.parse(body));
      res.end(JSON.stringify({ ok: true, message: { id: 'test-message', status: 'queued' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const pairs = [['c1', 'c2'], ['x1', 'x2'], ['c1', 'x1'], ['x1', 'c1'], ['c1', 'c1']];
  const replies = await rpc(pairs.map(([from, to], i) => ({ jsonrpc: '2.0', id: i + 1,
    method: 'tools/call', params: { name: 'session_send', arguments: {
      from_session_id: from, session_id: to, text: '테스트', wait_seconds: 0
    } } })), server.address().port);
  assert.equal(sent.length, 4);
  for (const [from, to] of pairs.slice(0, 4)) {
    assert.ok(sent.some(s => s.sourceId === from && s.targetId === to));
  }
  assert.equal(replies.filter(r => !r.result.isError).length, 4);
  assert.match(replies.find(r => r.id === 5).result.content[0].text, /자기 자신/);
});
