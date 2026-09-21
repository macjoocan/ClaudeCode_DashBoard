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
const { pickSource, sameDir, listText, TOOLS } = require('../mcp-bridge');

const S = (id, provider, extra) => Object.assign(
  { id, provider, live: false, cwd: 'C:\\a', project: 'a', title: '', mtime: 0 }, extra);

test('경로 비교는 구분자와 대소문자를 가리지 않는다', () => {
  assert.ok(sameDir('C:\\00.SVN\\x', 'c:/00.svn/x/'));
  assert.ok(!sameDir('', 'C:\\a'));
  assert.ok(!sameDir('C:\\a', 'C:\\b'));
});

test('Codex 로 보낼 때 발신은 Claude 쪽에서 고른다', () => {
  const all = [S('cx', 'codex', { live: true }), S('cl', 'claude', { live: true })];
  assert.equal(pickSource(all, 'codex', 'C:\\a').id, 'cl');
  assert.equal(pickSource(all, 'claude', 'C:\\a').id, 'cx');
});

test('같은 폴더에서 돌고 있는 세션을 먼저 고른다', () => {
  const all = [
    S('other', 'claude', { live: true, cwd: 'C:\\b' }),
    S('here', 'claude', { live: true, cwd: 'C:\\a' }),
  ];
  assert.equal(pickSource(all, 'codex', 'C:\\a').id, 'here');
});

test('살아있는 것이 없으면 가장 최근에 움직인 것을 쓴다', () => {
  const all = [S('old', 'claude', { mtime: 1 }), S('new', 'claude', { mtime: 9 })];
  assert.equal(pickSource(all, 'codex', 'C:\\zzz').id, 'new');
});

test('보낼 상대가 아예 없으면 null', () => {
  // Codex 로 보내려면 Claude 쪽 발신이 있어야 한다. Codex 만 있으면 고를 것이 없다.
  assert.equal(pickSource([S('cx', 'codex')], 'codex', 'C:\\a'), null);
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
function rpc(lines) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-bridge.js')],
      { stdio: ['pipe', 'pipe', 'pipe'] });
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
