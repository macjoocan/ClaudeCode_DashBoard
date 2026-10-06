// Offline evidence for review findings. Assertions document existing defects;
// these are not acceptance tests. No CLI, user configuration, or network runs.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function terminalFixture() {
  const exits = [], spawned = [];
  const module = { exports: {} };
  const ctx = { module, exports: module.exports, process, console, Buffer,
    setTimeout() { return 0; }, clearTimeout() {}, clearInterval() {}, setInterval() { return 0; },
    require(name) {
      if (name === 'node-pty') return { spawn() {
        const p = { pid: 100 + spawned.length, onData() {}, onExit() {}, write() {}, kill() {} };
        spawned.push(p); return p;
      } };
      return require(name.startsWith('.') ? path.join(root, name) : name);
    } };
  vm.runInNewContext(read('terminals.js'), ctx);
  const api = module.exports;
  const t = { id: 'proof', provider: 'claude', cwd: root, cols: 80, rows: 24,
    exitCode: null, clients: new Set(), buf: '',
    proc: { onExit(fn) { exits.push(fn); }, kill() {}, write(data) {
      if (typeof data !== 'string') throw new TypeError('data must be a string');
    } } };
  api._terms.set(t.id, t);
  return { api, t, exits, spawned };
}

async function main() {
  const f = terminalFixture();
  const ws = new EventEmitter(); ws.send = () => {}; ws.close = () => {};
  f.api.attach(ws, f.t.id);
  assert.throws(() => ws.emit('message', Buffer.from('null')), /null/);
  assert.throws(() => ws.emit('message', Buffer.from('{"t":"i","d":{}}')), /string/);
  console.log('R02: malformed WS input escapes the event callback');

  const r = terminalFixture();
  const one = r.api.restart(r.t.id, { claudeBin: 'fake' });
  const two = r.api.restart(r.t.id, { claudeBin: 'fake' });
  r.exits.forEach(fn => fn());
  await Promise.all([one, two]);
  assert.equal(r.spawned.length, 2);
  assert.equal(r.api._terms.size, 1);
  assert.equal(r.t.proc, r.spawned[1]);
  console.log('R04: two restarts spawn two PTYs but retain only one');

  const c = terminalFixture();
  const pending = c.api.restart(c.t.id, { claudeBin: 'fake' });
  c.api.close(c.t.id); c.exits.forEach(fn => fn()); await pending;
  assert.equal(c.spawned.length, 1); assert.equal(c.api._terms.size, 0);
  console.log('R04: closing a pending restart still spawns an unregistered PTY');

  const events = require('../events.js');
  events.reset();
  events.ingest({ hook_event_name: 'PreToolUse', session_id: 'proof', tool_use_id: 'tool1', tool_name: 'Read' });
  events.ingest({ hook_event_name: 'SubagentStart', session_id: 'proof', agent_id: 'agent1', agent_type: 'Explore' });
  const live = events.liveState();
  assert.equal(live.proof.tools[0].id, undefined);
  assert.equal(live.proof.agents[0].id, undefined);
  const ctx = { LIVE: live };
  const src = read('public/live.js');
  vm.runInNewContext(src.slice(src.indexOf('  function applyToLive('), src.indexOf('  // ------------------------------------------------------------ 렌더')), ctx);
  ctx.applyToLive({ event: 'PostToolUse', sessionId: 'proof', toolUseId: 'tool1', at: Date.now() });
  ctx.applyToLive({ event: 'SubagentStop', sessionId: 'proof', agentId: 'agent1', at: Date.now() });
  assert.equal(live.proof.tools.length, 1); assert.equal(live.proof.agents.length, 1);
  events.reset();
  console.log('R08: snapshot entries survive their matching completion events');

  const server = read('server.js');
  let response;
  const download = { URL, require(name) {
    assert.equal(name, 'http');
    return { get(target, options, cb) {
      if (target.protocol !== 'http:') throw new Error('ERR_INVALID_PROTOCOL');
      response = cb; return { on() {} };
    } };
  } };
  vm.runInNewContext(server.slice(server.indexOf('function downloadToPaste('), server.indexOf('// 오래된 붙여넣기 파일')), download);
  download.downloadToPaste('http://example.invalid/image');
  assert.throws(() => response({ statusCode: 301, headers: { location: 'https://example.invalid/image' }, resume() {} }), /ERR_INVALID_PROTOCOL/);
  console.log('R03: HTTP to HTTPS redirect throws outside the Promise handler');

  const records = JSON.stringify({ type: 'system', cwd: 'D:/example' }) + '\n'
    + JSON.stringify({ type: 'user', message: { content: 'x'.repeat(150000) } }) + '\n'
    + (JSON.stringify({ type: 'system', text: 'padding'.repeat(1000) }) + '\n').repeat(70);
  const bytes = Buffer.from(records);
  const parser = { HEAD_BYTES: 96 * 1024, HEAD_MAX: 2 * 1024 * 1024, TAIL_BYTES: 256 * 1024,
    readChunk(file, start, length) { return bytes.subarray(start, start + length).toString('utf8'); } };
  vm.runInNewContext(server.slice(server.indexOf('function textOf('), server.indexOf('// ------------------------------------------------ 실행 중인 세션')), parser);
  assert.equal(parser.parseSession('fake', { size: bytes.length }).firstPrompt, null);
  console.log('R12: a prompt spanning 96 KB chunks disappears from session metadata');

  let finishFetch;
  const log = { innerHTML: '', scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
  const elements = { '#log': log, '#p-info': {}, '#p-more': {} };
  const transcript = { openSess: { provider: 'claude', slug: 'a', id: 'a' }, openLimit: 40,
    $: name => elements[name], esc: s => s, md: s => s, stamp: s => s,
    fetch: () => new Promise(resolve => { finishFetch = resolve; }) };
  const index = read('public/index.html');
  vm.runInNewContext(index.slice(index.indexOf('async function loadTranscript('), index.indexOf('function closePanel(')), transcript);
  const request = transcript.loadTranscript(false);
  transcript.openSess = { provider: 'codex', id: 'b' };
  finishFetch({ json: async () => ({ messages: [{ role: 'assistant', text: 'session A content' }], total: 1 }) });
  await request;
  assert.match(log.innerHTML, /Codex/); assert.match(log.innerHTML, /session A content/);
  console.log('R09: stale session A response renders in session B with the B provider label');

}
main().catch(error => { console.error(error); process.exitCode = 1; });
