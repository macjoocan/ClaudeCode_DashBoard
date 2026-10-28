'use strict';
// mobile.js - QR 짝맺기와 폰 전용 포트의 보안 경계.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createMobile } = require('../mobile');

function fakeTerminals() {
  const got = [];
  return {
    got,
    list: () => [{ id: 't1', title: 'proj', provider: 'claude', alive: true, status: 'idle', cols: 100, rows: 30, cwd: 'C:\\x\\proj' }],
    get: id => (id === 't1' ? {} : null),
    attach(ws, id) {
      ws.send(JSON.stringify({ t: 'o', d: 'hello from ' + id, replay: true }));
      ws.on('message', raw => got.push(JSON.parse(raw.toString())));
    },
  };
}

async function setup(t) {
  let clock = 1_000_000;
  const terms = fakeTerminals();
  const m = createMobile({ terminals: terms, publicDir: path.join(__dirname, '..', 'public'),
    dataFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mob-')), 'devices.json'),
    port: 0, host: '127.0.0.1', now: () => clock });
  t.after(() => m.stop());
  const p = await m.pair();
  const base = 'http://127.0.0.1:' + p.port;
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { m, p, base, post, terms, tick: ms => { clock += ms; } };
}

test('a QR code works once, expires after 3 minutes, and only its token opens the API', async t => {
  const s = await setup(t);
  assert.equal((await s.post('/m/api/pair', { code: 'wrong' })).status, 403);
  const ok = await s.post('/m/api/pair', { code: s.p.code, name: 'iPhone' });
  assert.equal(ok.status, 200);
  const { token } = await ok.json();
  assert.equal((await s.post('/m/api/pair', { code: s.p.code })).status, 403, 'single use');

  assert.equal((await fetch(s.base + '/m/api/terms')).status, 401);
  assert.equal((await fetch(s.base + '/m/api/terms', { headers: { authorization: 'Bearer nope' } })).status, 401);
  const list = await (await fetch(s.base + '/m/api/terms', { headers: { authorization: 'Bearer ' + token } })).json();
  assert.equal(list.terms[0].project, 'proj');

  const p2 = await s.m.pair();
  s.tick(3 * 60 * 1000 + 1);
  assert.equal((await s.post('/m/api/pair', { code: p2.code })).status, 403, 'expired');
  // 대시보드 기능은 이 포트에 없다
  assert.equal((await fetch(s.base + '/api/terms')).status, 404);
  assert.equal((await fetch(s.base + '/../server.js')).status, 404);
  assert.equal((await fetch(s.base + '/m')).status, 200);
});

function ws(url, headers) {
  return new Promise(resolve => {
    const w = new WebSocket(url, { headers });
    const msgs = [];
    w.on('message', d => msgs.push(JSON.parse(d.toString())));
    w.on('open', () => resolve({ w, msgs, open: true }));
    w.on('error', () => resolve({ w, msgs, open: false }));
  });
}

test('terminal socket needs a token and same origin, and phones cannot resize the PTY', async t => {
  const s = await setup(t);
  const { token } = await (await s.post('/m/api/pair', { code: s.p.code })).json();
  const wsBase = s.base.replace('http', 'ws');
  assert.equal((await ws(wsBase + '/m/term?id=t1')).open, false, 'no token');
  assert.equal((await ws(wsBase + '/m/term?id=t1&t=' + token, { origin: 'http://evil.example' })).open, false, 'other site');
  assert.equal((await ws(wsBase + '/m/term?id=nope&t=' + token)).open, false, 'unknown terminal');

  const c = await ws(wsBase + '/m/term?id=t1&t=' + token);
  assert.equal(c.open, true);
  c.w.send(JSON.stringify({ t: 'r', c: 40, r: 20 }));
  c.w.send(JSON.stringify({ t: 'i', d: 'yes\r' }));
  await new Promise(r => setTimeout(r, 150));
  assert.deepEqual(s.terms.got, [{ t: 'i', d: 'yes\r' }], 'resize dropped, input passed');
  assert.match(c.msgs[0].d, /hello from t1/);
  assert.equal(s.m.status().devices[0].live, 1);

  // 대시보드에서 끊으면 열린 연결도 닫히고 토큰도 더는 안 통한다
  const closed = new Promise(r => c.w.on('close', r));
  assert.equal(s.m.revoke(s.m.status().devices[0].id), true);
  await closed;
  assert.equal((await fetch(s.base + '/m/api/terms', { headers: { authorization: 'Bearer ' + token } })).status, 401);
});

test('nothing listens until pairing starts, and stop closes the port', async () => {
  const m = createMobile({ terminals: fakeTerminals(), publicDir: path.join(__dirname, '..', 'public'),
    dataFile: path.join(os.tmpdir(), 'mob-none-' + process.pid + '.json'), port: 0, host: '127.0.0.1' });
  assert.equal(m.status().on, false);
  const p = await m.pair();
  assert.equal(m.status().on, true);
  await m.stop();
  assert.equal(m.status().on, false);
  await assert.rejects(fetch('http://127.0.0.1:' + p.port + '/m'));
});
