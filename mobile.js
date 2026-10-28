// 폰으로 이어서 하기. 같은 와이파이의 폰이 QR 을 찍어 대시보드 터미널에 붙는다.
//
// 대시보드(7788)는 지금처럼 이 PC 에서만 열린다. 폰은 켤 때만 여는 **따로 된 포트**로 들어오고,
// 거기에는 폰 화면·세션 목록·터미널 연결만 있다. 세션 종료나 설정 같은 다른 기능은 아예 없다.
//
// 연결 절차:
//   1. 대시보드에서 "폰 연결" → 3분짜리 일회용 코드가 든 QR (주소#pair=코드)
//   2. 폰이 코드를 내고 기기 토큰을 받는다. 코드는 한 번 쓰면 끝이다.
//   3. 이후 요청은 기기 토큰으로 한다. 대시보드에서 기기별로 끊을 수 있다.
// 토큰은 해시만 파일에 남긴다. 같은 망 http 라 오가는 내용을 엿볼 수 있다는 점은 감수한 선택이다.
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PAIR_TTL_MS = 3 * 60 * 1000;
const DEFAULT_PORT = 7789;
// 폰에 내줄 파일. 이 밖의 경로는 없다.
const STATIC = {
  '/m': ['mobile.html', 'text/html; charset=utf-8'],
  '/m/': ['mobile.html', 'text/html; charset=utf-8'],
  '/m/mobile.js': ['mobile-app.js', 'text/javascript; charset=utf-8'],
  '/m/vendor/xterm.js': ['vendor/xterm.js', 'text/javascript; charset=utf-8'],
  '/m/vendor/xterm.css': ['vendor/xterm.css', 'text/css; charset=utf-8'],
};

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
function sameHash(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// 폰이 닿을 만한 주소. 가상 어댑터(WSL·Hyper-V·VMware·VirtualBox·Docker)는 뒤로 뺀다.
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|WSL|Hyper-V|VMware|VirtualBox|Docker|Loopback|vbox|tailscale/i.test(name);
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      out.push({ name, address: a.address, rank: (virtual ? 2 : 0) + (priv ? 0 : 1) });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ name, address }) => ({ name, address }));
}

function createMobile({ terminals, publicDir, dataFile, port = DEFAULT_PORT, host = '0.0.0.0', now = () => Date.now() }) {
  let server = null, wss = null, pairing = null, listening = null;
  let devices = load();
  const sockets = new Map();            // deviceId -> Set<ws>

  function load() {
    try { const d = JSON.parse(fs.readFileSync(dataFile, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; }
  }
  function save() { try { fs.writeFileSync(dataFile, JSON.stringify(devices, null, 2)); } catch {} }

  function deviceFor(raw) {
    if (!raw) return null;
    const h = sha(raw);
    return devices.find(d => sameHash(d.tokenHash, h)) || null;
  }
  function authOf(req, url) {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
    return deviceFor(m ? m[1] : url.searchParams.get('t'));
  }

  function send(res, code, body, type) {
    res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(type ? body : JSON.stringify(body));
  }
  function body(req) {
    return new Promise(resolve => {
      const chunks = []; let len = 0;
      req.on('data', c => { len += c.length; if (len > 8192) req.destroy(); else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
      req.on('error', () => resolve({}));
    });
  }

  function termList() {
    return terminals.list().map(t => ({
      id: t.id, title: t.name || t.title, provider: t.provider, alive: t.alive, status: t.status,
      cols: t.cols, rows: t.rows, project: String(t.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '',
    }));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://phone');
    try {
      const file = req.method === 'GET' && STATIC[url.pathname];
      if (file) return send(res, 200, fs.readFileSync(path.join(publicDir, file[0])), file[1]);
      if (url.pathname === '/m/api/pair' && req.method === 'POST') {
        const b = await body(req);
        const ok = pairing && now() < pairing.expires && typeof b.code === 'string' && sameHash(pairing.codeHash, sha(b.code));
        if (!ok) return send(res, 403, { error: 'QR 이 만료됐거나 이미 쓰였습니다. 대시보드에서 QR 을 새로 띄워 주세요.' });
        pairing = null;                                   // 한 번 쓰면 끝
        const raw = token();
        const d = { id: crypto.randomBytes(6).toString('hex'), name: String(b.name || '폰').slice(0, 60),
          tokenHash: sha(raw), createdAt: now(), lastSeenAt: now() };
        devices.push(d); save();
        return send(res, 200, { token: raw, device: { id: d.id, name: d.name } });
      }
      const dev = authOf(req, url);
      if (url.pathname.startsWith('/m/api/') && !dev) return send(res, 401, { error: '연결이 끊겼습니다. 대시보드에서 QR 을 다시 찍어 주세요.' });
      if (url.pathname === '/m/api/terms' && req.method === 'GET') {
        dev.lastSeenAt = now(); save();
        return send(res, 200, { terms: termList() });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: String(e && e.message || e) });
    }
  }

  // 폰은 PTY 크기를 바꾸지 않는다. 바꾸면 PC 패인이 그 폭으로 깨진다.
  function phoneSocket(ws) {
    return {
      send: d => ws.send(d),
      close: () => ws.close(),
      get readyState() { return ws.readyState; },
      on(ev, fn) {
        if (ev !== 'message') return ws.on(ev, fn);
        ws.on('message', raw => {
          let m; try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m && m.t === 'r') return;
          fn(raw);
        });
      },
    };
  }

  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://phone');
    const dev = url.pathname === '/m/term' && authOf(req, url);
    // 다른 사이트에서 연 웹소켓은 받지 않는다. 폰 페이지는 같은 호스트에서 연다.
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin === 'http://' + req.headers.host;
    if (!dev || !sameOrigin || !terminals.get(url.searchParams.get('id') || '')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      dev.lastSeenAt = now();
      const set = sockets.get(dev.id) || new Set(); set.add(ws); sockets.set(dev.id, set);
      ws.on('close', () => set.delete(ws));
      terminals.attach(phoneSocket(ws), url.searchParams.get('id'));
    });
  }

  function start() {
    if (server) return listening;
    server = http.createServer(handle);
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', upgrade);
    listening = new Promise((resolve, reject) => {
      server.once('error', e => { server = null; reject(e); });
      server.listen(port, host, () => resolve(server.address().port));
    });
    return listening;
  }

  async function stop() {
    pairing = null;
    if (!server) return;
    for (const set of sockets.values()) for (const ws of set) { try { ws.close(); } catch {} }
    sockets.clear();
    const s = server; server = null; listening = null;
    try { wss.close(); } catch {}
    await new Promise(r => s.close(() => r()));
  }

  async function pair() {
    const p = await start();
    const raw = token();
    pairing = { codeHash: sha(raw), expires: now() + PAIR_TTL_MS };
    const addrs = lanAddresses();
    return { port: p, code: raw, expiresAt: pairing.expires, addresses: addrs,
      urls: addrs.map(a => `http://${a.address}:${p}/m#pair=${raw}`) };
  }

  function revoke(id) {
    const before = devices.length;
    devices = devices.filter(d => d.id !== id);
    if (devices.length === before) return false;
    save();
    for (const ws of sockets.get(id) || []) { try { ws.close(); } catch {} }
    sockets.delete(id);
    return true;
  }

  function status() {
    return { on: !!server, port: server && server.address() ? server.address().port : null,
      pairingUntil: pairing ? pairing.expires : null, addresses: lanAddresses(),
      devices: devices.map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
        live: (sockets.get(d.id) || new Set()).size })) };
  }

  // 대시보드(127.0.0.1)에서 부르는 API. 처리했으면 true.
  async function handleDashboardApi(url, req, res, json, readBody) {
    if (!url.pathname.startsWith('/api/mobile')) return false;
    if (url.pathname === '/api/mobile' && req.method === 'GET') { json(res, 200, status()); return true; }
    if (url.pathname === '/api/mobile/pair' && req.method === 'POST') { json(res, 200, Object.assign(await pair(), { status: status() })); return true; }
    if (url.pathname === '/api/mobile/stop' && req.method === 'POST') { await stop(); json(res, 200, status()); return true; }
    if (url.pathname === '/api/mobile/revoke' && req.method === 'POST') {
      const b = await readBody(req);
      json(res, 200, { ok: revoke(String(b.id || '')), status: status() }); return true;
    }
    return false;
  }

  return { start, stop, pair, revoke, status, handleDashboardApi, close: stop };
}

module.exports = { createMobile, lanAddresses };
