'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyModes, modePrefix, appendTrim } = require('../term-modes');

const E = String.fromCharCode(27);
const ALT_ON = E + '[?1049h', MOUSE_ON = E + '[?1003h' + E + '[?1006h';

test('modes follow the output and only non-default ones are replayed', () => {
  const s = applyModes({}, ALT_ON + MOUSE_ON + E + '[?25l' + E + '[?2026h frame ' + E + '[?2026l');
  assert.equal(s['1049'], 'h');
  assert.equal(s['25'], 'l');
  assert.equal(s['2026'], undefined);                 // 동기화 구간은 상태가 아니다
  const p = modePrefix(s);
  assert.ok(p.startsWith(ALT_ON), 'alternate screen goes first');
  assert.ok(p.includes(E + '[?1003h') && p.includes(E + '[?1006h') && p.includes(E + '[?25l'));
  assert.equal(modePrefix(applyModes({}, ALT_ON + E + '[?1049l')), '');   // 껐다 켰다 → 기본
});

test('modes from the trimmed-away start of the buffer are kept (the jumbled Codex scrollback)', () => {
  const start = {};
  let buf = '';
  buf = appendTrim(buf, ALT_ON + MOUSE_ON + 'first frame', 40, start);
  for (let i = 0; i < 20; i++) buf = appendTrim(buf, E + '[H frame ' + i + ' ', 40, start);
  assert.ok(!buf.includes('1049'), 'the switch itself is gone from the buffer');
  assert.equal(start['1049'], 'h');
  assert.ok(modePrefix(start).startsWith(ALT_ON));
});

test('attach replays the saved modes before the buffer', () => {
  const terminals = require('../terminals.js');
  const sent = [];
  const t = { id: 'tm1', provider: 'codex', cwd: 'D:\\tmp', title: 'x', pid: 1, startedAt: 1,
    exitCode: null, cols: 80, rows: 24, clients: new Set(), restarts: 0,
    buf: E + '[H latest frame', bufModes: { 1049: 'h', 1003: 'h', 1006: 'h' } };
  terminals._terms.set(t.id, t);
  terminals.attach({ send(m) { sent.push(JSON.parse(m)); }, on() {} }, t.id);
  terminals._terms.delete(t.id);
  const replay = sent.find(m => m.t === 'replay');
  assert.ok(replay, 'codex pane gets a replay');
  assert.ok(replay.d.startsWith(ALT_ON));
  assert.ok(replay.d.endsWith('latest frame'));
});
