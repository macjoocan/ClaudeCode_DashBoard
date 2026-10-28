// 폰 화면. QR 로 짝을 맺고, 세션 목록 → 터미널로 들어간다.
(function () {
  'use strict';
  var KEY = 'ccl.mobile.token';
  var $ = function (id) { return document.getElementById(id); };
  var token = null;
  try { token = localStorage.getItem(KEY); } catch (e) {}

  var KEYS = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t', ctrlc: '\x03',
    newline: '\x1b\r', '1': '1', '2': '2', '3': '3' };

  function show(view) {
    ['notice', 'list', 'termview'].forEach(function (v) { $(v).hidden = v !== view; });
    $('back').hidden = view !== 'termview';
    $('fontdown').hidden = $('fontup').hidden = view !== 'termview';
  }
  function notice(html) { $('notice').innerHTML = html; show('notice'); }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {},
      token ? { authorization: 'Bearer ' + token } : {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  // 1) QR 로 들어온 경우: 주소 끝의 #pair=코드로 기기 토큰을 받는다
  function pairIfNeeded() {
    var m = /[#&]pair=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m) return Promise.resolve();
    history.replaceState(null, '', location.pathname);       // 코드는 주소창에 남기지 않는다
    var name = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android 폰' : '폰';
    return api('/m/api/pair', { method: 'POST', body: JSON.stringify({ code: m[1], name: name }) }).then(function (j) {
      token = j.token;
      try { localStorage.setItem(KEY, token); } catch (e) {}
    }, function (e) {
      if (!token) throw e;            // 이미 연결된 폰이 지난 QR 을 또 찍은 경우 - 그냥 이어서 쓴다
    });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // 2) 세션 목록
  function loadList() {
    $('title').textContent = '대시보드';
    $('state').textContent = '';
    return api('/m/api/terms').then(function (j) {
      var list = $('list');
      list.innerHTML = '';
      if (!j.terms.length) { notice('대시보드에 열린 터미널이 없습니다.<br>PC 대시보드에서 세션을 연 뒤 새로고침하세요.'); return; }
      j.terms.forEach(function (t) {
        var b = document.createElement('button');
        b.className = 'item';
        var st = !t.alive ? 'dead' : (t.status === 'busy' ? 'busy' : 'idle');
        b.innerHTML = '<span class="t"><span class="dot ' + st + '"></span>' + esc(t.title || t.project) + '</span>'
          + '<span class="s">' + (t.provider === 'codex' ? 'Codex' : 'Claude') + ' · ' + esc(t.project)
          + ' · ' + (!t.alive ? '종료됨' : st === 'busy' ? '작업 중' : '대기 중') + '</span>';
        b.onclick = function () { openTerm(t); };
        list.appendChild(b);
      });
      show('list');
    }).catch(failed);
  }

  function failed(e) {
    if (e && e.status === 401) {
      token = null; try { localStorage.removeItem(KEY); } catch (x) {}
      notice('<b>연결이 끊겼습니다.</b><br>PC 대시보드의 "폰 연결"에서 QR 을 다시 찍어 주세요.');
    } else notice('<b>대시보드에 닿지 않습니다.</b><br>PC 와 같은 와이파이인지, 대시보드에서 폰 연결이 켜져 있는지 확인하세요.<br><br>' + esc(e && e.message));
  }

  // 3) 터미널: PC 와 같은 크기로 그리고, 폰 폭에 맞게 글자 크기를 정한다(크기는 안 바꾼다)
  var term = null, ws = null, current = null, retry = 0;
  // 폭에 꼭 맞추면 100칸 화면이 7px 가 돼 못 읽는다. 읽을 수 있는 크기를 기본으로 하고
  // 넘치면 가로로 민다. 사용자가 고른 크기는 기억한다.
  var userFont = null;
  try { userFont = Number(localStorage.getItem('ccl.mobile.font')) || null; } catch (e) {}
  function fontFor(cols) {
    if (userFont) return userFont;
    var w = $('screen').clientWidth - 8;
    return Math.max(10, Math.min(14, Math.floor(w / (cols * 0.6))));
  }
  function setFont(delta) {
    if (!term) return;
    userFont = Math.max(7, Math.min(20, term.options.fontSize + delta));
    term.options.fontSize = userFont;
    try { localStorage.setItem('ccl.mobile.font', String(userFont)); } catch (e) {}
  }
  $('fontdown').onclick = function () { setFont(-1); };
  $('fontup').onclick = function () { setFont(1); };
  function openTerm(t) {
    current = t;
    $('title').textContent = t.title || t.project;
    show('termview');
    if (term) term.dispose();
    term = new window.Terminal({ cols: t.cols, rows: t.rows, fontSize: fontFor(t.cols), scrollback: 3000,
      fontFamily: 'Menlo, Consolas, "D2Coding", monospace', theme: { background: '#0f120f' }, allowProposedApi: true });
    $('screen').innerHTML = '';
    term.open($('screen'));
    term.onData(function (d) { sendInput(d); });
    connect();
  }
  function connect() {
    if (ws) { ws.onclose = null; ws.close(); }
    $('state').textContent = '연결 중…';
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/m/term?id=' + encodeURIComponent(current.id) + '&t=' + encodeURIComponent(token));
    var first = true;
    ws.onopen = function () { retry = 0; $('state').textContent = '연결됨'; };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'o') { if (m.replay && first) term.reset(); term.write(m.d); }
      else if (m.t === 'replay') { term.reset(); term.write(m.d, function () { term.scrollToBottom(); }); }
      else if (m.t === 'reset') term.reset();
      else if (m.t === 'm' && m.info) {
        if (m.info.cols !== term.cols || m.info.rows !== term.rows) {
          term.resize(m.info.cols, m.info.rows);
          term.options.fontSize = fontFor(m.info.cols);
        }
      } else if (m.t === 'x') term.write('\r\n\x1b[38;5;131m[세션이 종료되었습니다]\x1b[m\r\n');
      first = false;
    };
    ws.onclose = function () {
      $('state').textContent = '끊김 - 다시 연결 중';
      if (!current) return;
      // 토큰이 해제됐으면 목록 조회가 401 로 알려준다
      api('/m/api/terms').then(function () {
        setTimeout(function () { if (current) connect(); }, Math.min(8000, 1000 * Math.pow(2, retry++)));
      }).catch(failed);
    };
  }
  function sendInput(d) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: d }));
  }

  $('keys').addEventListener('click', function (e) {
    var k = e.target.closest('[data-k]');
    if (k) sendInput(KEYS[k.dataset.k]);
  });
  $('compose').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('text').value;
    if (!v) { sendInput('\r'); return; }
    // 여러 줄이면 줄마다 줄바꿈 키(ESC CR)로 잇고 마지막에 Enter
    sendInput(v.replace(/\r?\n/g, '\x1b\r'));
    setTimeout(function () { sendInput('\r'); }, 60);
    $('text').value = '';
  });
  $('back').onclick = function () {
    current = null;
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    loadList();
  };
  window.addEventListener('resize', function () { if (term && current) term.options.fontSize = fontFor(term.cols); });

  pairIfNeeded().then(function () {
    if (!token) { notice('<b>아직 연결되지 않았습니다.</b><br>PC 대시보드에서 "폰 연결"을 누르고 나오는 QR 을 이 폰 카메라로 찍어 주세요.'); return; }
    loadList();
  }).catch(function (e) { notice('<b>연결하지 못했습니다.</b><br>' + esc(e.message)); });
})();
