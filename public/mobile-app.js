// 폰 화면. QR 로 짝을 맺고, 세션 목록 → 터미널로 들어간다.
//
// 터미널은 PC 패인과 같은 크기(보통 100칸 넘게)로 돈다. 폰 폭에 그대로 그리면 글자가 깨알이 되거나
// 가로로 밀어야 해서, 기본은 "글" 보기다: 터미널 버퍼를 줄글로 꺼내 폰 폭에 맞춰 줄바꿈한다.
// 메뉴 모양을 정확히 봐야 할 때만 "화면" 보기(진짜 터미널)로 바꾼다.
(function () {
  'use strict';
  var KEY = 'ccl.mobile.token';
  var $ = function (id) { return document.getElementById(id); };
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return null; }
  var token = store(KEY);

  var KEYS = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
    tab: '\t', shifttab: '\x1b[Z', bs: '\x7f', ctrlc: '\x03' };

  // ------------------------------------------------------------ 공통
  function show(view) {
    $('notice').hidden = view !== 'notice';
    $('listwrap').hidden = view !== 'list';
    $('termview').hidden = $('dock').hidden = view !== 'term';
    $('back').hidden = $('mode').hidden = $('fontup').hidden = view !== 'term';
  }
  function notice(title, body) {
    $('notice').innerHTML = '<b>' + esc(title) + '</b>' + (body || '');
    show('notice');
    setState('off', title);
  }
  function setState(cls, text) { $('subdot').className = 'dot ' + cls; $('state').textContent = text; }
  var toastTimer;
  function toast(msg) {
    $('toast').textContent = msg; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { $('toast').hidden = true; }, 2600);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
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
  function failed(e) {
    if (e && e.status === 401) {
      token = null; store(KEY, null);
      notice('연결이 끊겼습니다', 'PC 대시보드의 <b style="display:inline;font-size:inherit">📱 폰</b>에서 QR 을 다시 찍어 주세요.');
    } else {
      notice('대시보드에 닿지 않습니다', 'PC 와 같은 와이파이인지, 대시보드에서 폰 연결이 켜져 있는지 확인하세요.<br><br><button onclick="location.reload()">다시 시도</button>');
    }
  }

  // ------------------------------------------------------------ 짝맺기
  function pairIfNeeded() {
    var m = /[#&]pair=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m) return Promise.resolve();
    history.replaceState(null, '', location.pathname);       // 코드는 주소창에 남기지 않는다
    var ua = navigator.userAgent;
    var name = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android 폰' : '폰';
    return api('/m/api/pair', { method: 'POST', body: JSON.stringify({ code: m[1], name: name }) }).then(function (j) {
      token = j.token; store(KEY, token);
      toast('연결됐습니다');
    }, function (e) {
      if (!token) throw e;            // 이미 연결된 폰이 지난 QR 을 또 찍은 경우 - 그냥 이어서 쓴다
    });
  }

  // ------------------------------------------------------------ 목록
  var lastStatus = {}, listTimer = null;
  function statusOf(t) { return !t.alive ? 'dead' : (t.status === 'busy' ? 'busy' : 'idle'); }
  function label(st) { return st === 'dead' ? '종료됨' : st === 'busy' ? '작업 중' : '대기 중'; }

  // 작업 중 → 대기로 바뀐 세션은 끝난 것이다. 폰을 보고 있지 않아도 알 수 있게 진동한다.
  function noticeDone(terms) {
    var done = [];
    terms.forEach(function (t) {
      var st = statusOf(t);
      if (lastStatus[t.id] === 'busy' && st === 'idle') done.push(t);
      lastStatus[t.id] = st;
    });
    if (done.length) {
      toast((done[0].title || done[0].project) + (done.length > 1 ? ' 외 ' + (done.length - 1) + '개' : '') + ' 작업이 끝났습니다');
      try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (e) {}
      document.title = '● 끝남 · 대시보드';
    }
    return done;
  }

  function loadList(quiet) {
    return api('/m/api/terms').then(function (j) {
      var done = noticeDone(j.terms).map(function (t) { return t.id; });
      if (current) return;                                      // 터미널을 보는 중이면 알림만
      $('title').textContent = '대시보드 세션';
      setState('idle', '연결됨');
      var list = $('list');
      list.innerHTML = '';
      if (!j.terms.length) {
        notice('열린 터미널이 없습니다', 'PC 대시보드에서 세션을 열면 여기에 나옵니다.');
        return;
      }
      var busy = j.terms.filter(function (t) { return statusOf(t) === 'busy'; }).length;
      $('listcount').textContent = j.terms.length + '개 · 작업 중 ' + busy;
      j.terms.forEach(function (t) {
        var st = statusOf(t);
        var b = document.createElement('button');
        b.className = 'item' + (done.indexOf(t.id) >= 0 ? ' done' : '');
        b.innerHTML = '<span class="dot ' + st + '"></span><span class="t">' + esc(t.title || t.project) + '</span>'
          + '<span class="s">' + (t.provider === 'codex' ? 'Codex' : 'Claude') + ' · ' + esc(t.project) + ' · ' + label(st) + '</span>';
        b.onclick = function () { openTerm(t); };
        list.appendChild(b);
      });
      show('list');
    }).catch(function (e) { if (!quiet || e.status === 401) failed(e); });
  }
  function startPolling() {
    clearInterval(listTimer);
    listTimer = setInterval(function () { if (!document.hidden) loadList(true); }, 4000);
  }
  $('refresh').onclick = function () { loadList(); };

  // ------------------------------------------------------------ 터미널
  var term = null, ws = null, current = null, retry = 0, mode = store('ccl.mobile.mode') || 'read';
  var readerFont = Number(store('ccl.mobile.readerFont')) || 13;
  var wakeLock = null;

  function screenFont(cols) {
    var w = $('screen').clientWidth - 8;
    return Math.max(9, Math.min(13, Math.floor(w / (cols * 0.6))));
  }

  function setMode(m) {
    mode = m; store('ccl.mobile.mode', m);
    $('m-read').setAttribute('aria-pressed', String(m === 'read'));
    $('m-screen').setAttribute('aria-pressed', String(m === 'screen'));
    $('reader').hidden = m !== 'read';
    $('screen').hidden = m !== 'screen';
    $('fontup').textContent = m === 'read' ? '가' + readerFont : '가+';
    if (m === 'read') renderReader(true);
    else if (term) { term.options.fontSize = screenFont(term.cols); term.scrollToBottom(); }
    updateBottomButton();
  }
  $('m-read').onclick = function () { setMode('read'); };
  $('m-screen').onclick = function () { setMode('screen'); };
  $('fontup').onclick = function () {
    if (mode === 'read') {
      readerFont = readerFont >= 17 ? 11 : readerFont + 1;      // 11 → 17 을 돈다
      store('ccl.mobile.readerFont', String(readerFont));
      $('reader').style.fontSize = readerFont + 'px';
      $('fontup').textContent = '가' + readerFont;
    } else if (term) {
      term.options.fontSize = term.options.fontSize >= 16 ? 8 : term.options.fontSize + 1;
    }
  };

  // 글 보기: 버퍼의 줄을 꺼내 끝 공백을 걷고, 터미널이 접은 줄(isWrapped)은 다시 잇는다.
  var READER_LINES = 800, renderPending = false, showAll = false;
  function bufferText() {
    var b = term.buffer.active, total = b.length, out = [];
    var from = showAll ? 0 : Math.max(0, total - READER_LINES);
    for (var y = from; y < total; y++) {
      var line = b.getLine(y);
      if (!line) continue;
      var s = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += s;
      else out.push(s);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    // 터미널 폭만큼 그은 구분선(────)은 폰에서 두세 줄로 접힌다. 짧은 한 줄로 바꾼다.
    out = out.map(function (s) { return /^\s*[─━═╌╍┄┅—-]{12,}\s*$/.test(s) ? '────────────' : s; });
    return { text: out.join('\n'), cut: from > 0 };
  }
  function atBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 40; }
  function renderReader(force) {
    if (!term || mode !== 'read') return;
    if (renderPending && !force) return;
    renderPending = true;
    requestAnimationFrame(function () {
      renderPending = false;
      var r = $('reader'), stick = force || atBottom(r);
      var b = bufferText();
      r.textContent = b.text;
      if (b.cut) {
        var more = document.createElement('button');
        more.className = 'more'; more.textContent = '앞부분 더 보기';
        more.onclick = function () { showAll = true; renderReader(); r.scrollTop = 0; };
        r.insertBefore(more, r.firstChild);
      }
      if (stick) r.scrollTop = r.scrollHeight;
      updateBottomButton();
    });
  }
  function updateBottomButton() {
    var el = mode === 'read' ? $('reader') : $('screen');
    $('tobottom').hidden = !current || atBottom(el);
  }
  $('reader').addEventListener('scroll', updateBottomButton, { passive: true });
  $('screen').addEventListener('scroll', updateBottomButton, { passive: true });
  $('tobottom').onclick = function () {
    if (mode === 'read') { var r = $('reader'); r.scrollTop = r.scrollHeight; }
    else if (term) term.scrollToBottom();
    updateBottomButton();
  };

  function openTerm(t) {
    current = t; showAll = false;
    document.title = (t.title || t.project) + ' · 대시보드';
    $('title').textContent = t.title || t.project;
    show('term');
    if (term) term.dispose();
    term = new window.Terminal({ cols: t.cols, rows: t.rows, fontSize: 11, scrollback: 3000,
      fontFamily: 'ui-monospace, Menlo, Consolas, "D2Coding", monospace', theme: { background: '#0e110e' }, allowProposedApi: true });
    $('screen').innerHTML = '';
    term.open($('screen'));
    term.onData(function (d) { sendInput(d); });
    $('reader').style.fontSize = readerFont + 'px';
    $('reader').textContent = '';
    setMode(mode);
    connect();
    keepAwake();
  }

  function connect() {
    if (ws) { ws.onclose = null; ws.close(); }
    setState('busy', '연결 중…');
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/m/term?id=' + encodeURIComponent(current.id) + '&t=' + encodeURIComponent(token));
    var first = true;
    ws.onopen = function () { retry = 0; setState(statusOf(current), label(statusOf(current))); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'o') {
        if (m.replay && first) term.reset();
        term.write(m.d, function () { renderReader(m.replay); });
      } else if (m.t === 'replay') {
        term.reset();
        term.write(m.d, function () { renderReader(true); term.scrollToBottom(); });
      } else if (m.t === 'reset') { term.reset(); renderReader(true); }
      else if (m.t === 'm' && m.info) {
        if (m.info.cols !== term.cols || m.info.rows !== term.rows) {
          term.resize(m.info.cols, m.info.rows);
          if (mode === 'screen') term.options.fontSize = screenFont(m.info.cols);
        }
        current.status = m.info.status; current.alive = m.info.alive;
        setState(statusOf(current), label(statusOf(current)));
      } else if (m.t === 'x') {
        term.write('\r\n[세션이 종료되었습니다]\r\n', function () { renderReader(); });
        setState('dead', '종료됨');
      }
      first = false;
    };
    ws.onclose = function () {
      if (!current) return;
      setState('off', '끊김 · 다시 연결 중');
      api('/m/api/terms').then(function () {
        setTimeout(function () { if (current) connect(); }, Math.min(8000, 1000 * Math.pow(2, retry++)));
      }).catch(failed);
    };
  }
  function sendInput(d) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ t: 'i', d: d })); return true; }
    toast('연결이 끊겨 보내지 못했습니다');
    return false;
  }
  // 말을 보낸다: 여러 줄이면 줄마다 줄바꿈 키(ESC CR)로 잇고 마지막에 Enter
  function say(text) {
    if (!text) return sendInput('\r');
    if (!sendInput(text.replace(/\r?\n/g, '\x1b\r'))) return false;
    setTimeout(function () { sendInput('\r'); }, 60);
    var r = $('reader'); r.scrollTop = r.scrollHeight;
    return true;
  }

  function keepAwake() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l; l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { document.title = current ? (current.title || current.project) + ' · 대시보드' : '대시보드 · 폰'; if (current) keepAwake(); }
  });

  // ------------------------------------------------------------ 조작부
  $('keys').addEventListener('click', function (e) {
    var k = e.target.closest('[data-k]');
    if (k) sendInput(KEYS[k.dataset.k]);
  });
  $('quick').addEventListener('click', function (e) {
    var q = e.target.closest('[data-say]');
    if (q && say(q.dataset.say)) toast('보냈습니다: ' + q.textContent);
  });
  var text = $('text');
  function grow() { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, window.innerHeight * 0.3) + 'px'; }
  text.addEventListener('input', grow);
  $('compose').addEventListener('submit', function (e) {
    e.preventDefault();
    if (say(text.value)) { text.value = ''; grow(); }
  });
  $('back').onclick = function () {
    current = null;
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    document.title = '대시보드 · 폰';
    loadList();
  };
  window.addEventListener('resize', function () { if (term && current && mode === 'screen') term.options.fontSize = screenFont(term.cols); });

  // ------------------------------------------------------------ 시작
  setState('off', '연결 전');
  pairIfNeeded().then(function () {
    if (!token) {
      notice('아직 연결되지 않았습니다', 'PC 대시보드 위쪽의 <b style="display:inline;font-size:inherit">📱 폰</b> 버튼을 누르고, 나오는 QR 을 이 폰 카메라로 찍어 주세요.');
      return;
    }
    loadList();
    startPolling();
  }).catch(function (e) { notice('연결하지 못했습니다', esc(e.message)); });
})();
