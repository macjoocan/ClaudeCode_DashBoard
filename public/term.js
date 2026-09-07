// 대시보드 내장 터미널 (xterm.js + WebSocket) - 다중 분할 지원.
// 서버가 PTY 를 소유하므로 브라우저를 새로고침하거나 닫아도 세션은 계속 살아 있고,
// 다시 들어오면 스크롤백을 되살려 이어서 본다.
//
// 레이아웃: 1 / 2 / 3 / 4 / 전체(auto). 보이는 패인만 fit() 을 걸어 PTY 크기를 맞춘다.
(function () {
  var CC = window.CC || (window.CC = {});

  var THEME = {
    background: '#12100e', foreground: '#efe9e1', cursor: '#d97757',
    cursorAccent: '#12100e', selectionBackground: 'rgba(217,119,87,.32)',
    black: '#12100e', red: '#c0554a', green: '#7fb069', yellow: '#e0b341',
    blue: '#5fa8d3', magenta: '#b07cc6', cyan: '#5fb3b3', white: '#d5cdc2',
    brightBlack: '#6f665b', brightRed: '#e0776a', brightGreen: '#9ecb87',
    brightYellow: '#f0cd6b', brightBlue: '#84c1e4', brightMagenta: '#cb9bdc',
    brightCyan: '#84cdcd', brightWhite: '#efe9e1'
  };

  var views = new Map();     // termId -> view
  var order = [];            // 표시 순서 (앞쪽이 먼저 배치된다)
  var active = null;         // 포커스된 termId
  var layout = 1;            // 1|2|3|4|0(전체)
  var orient = 'grid';       // grid(가로세로) | cols(가로=좌우) | rows(세로=위아래)
  var onChange = null;

  function init(hostEl, changeCb) {
    CC.host = hostEl;
    onChange = changeCb;
    layout = Number(localStorage.getItem('ccl.layout') || 1);
    orient = localStorage.getItem('ccl.orient') || 'grid';
  }

  function setLayout(n) {
    layout = Number(n) || 1;
    localStorage.setItem('ccl.layout', String(layout));
    apply();
  }
  function getLayout() { return layout; }

  function setOrient(o) {
    orient = (o === 'cols' || o === 'rows') ? o : 'grid';
    localStorage.setItem('ccl.orient', orient);
    apply();
  }
  function getOrient() { return orient; }

  // 화면에 배치할 터미널 수
  function slots() {
    if (layout === 0) return order.length;      // 전체
    return Math.min(layout, order.length);
  }

  // 레이아웃을 적용하고 보이는 패인만 fit 한다
  function apply() {
    var host = CC.host;
    if (!host) return;
    var n = slots();

    // 활성 터미널이 항상 보이도록 순서를 조정한다
    if (active && order.indexOf(active) >= n) {
      var i = order.indexOf(active);
      order.splice(i, 1);
      order.unshift(active);
    }

    // 배치 방향
    //   cols(가로) : 좌우로 나란히          [A][B][C]
    //   rows(세로) : 위아래로 쌓기           [A]
    //                                        [B]
    //   grid(가로세로) : 정사각형에 가깝게    [A][B]
    //                                        [C][D]
    var cols, rows;
    if (orient === 'cols') { cols = Math.max(1, n); rows = 1; }
    else if (orient === 'rows') { cols = 1; rows = Math.max(1, n); }
    else {
      // 항상 정사각형에 가깝게. n=3 이면 2x2 가 되어 가로 배치와 구분된다.
      cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      rows = Math.max(1, Math.ceil(n / cols));
    }

    host.style.display = 'grid';
    host.style.gap = '6px';
    host.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0,1fr))';
    host.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0,1fr))';

    // 격자에서 마지막 줄이 비면 마지막 패인이 남은 칸을 채운다 (구멍 방지)
    var lastSpan = 1;
    if (orient === 'grid' && n > 1) {
      var rem = n % cols;
      if (rem !== 0) lastSpan = cols - rem + 1;
    }

    order.forEach(function (id, idx) {
      var v = views.get(id);
      if (!v) return;
      var visible = idx < n;
      v.el.hidden = !visible;
      v.el.classList.toggle('active', id === active);
      v.el.classList.toggle('solo', n === 1);
      v.el.style.gridColumn = (visible && idx === n - 1 && lastSpan > 1)
        ? 'span ' + lastSpan : '';
    });

    // 레이아웃이 바뀐 뒤 실제 크기가 정해지면 fit
    requestAnimationFrame(function () {
      order.slice(0, n).forEach(function (id) {
        var v = views.get(id);
        if (!v) return;
        try { v.fit.fit(); } catch (e) {}
      });
      if (onChange) onChange();
    });
  }

  function open(opts) {
    var host = CC.host;
    var cols = Math.max(60, Math.floor((host.clientWidth || 900) / 8.6));
    var rows = Math.max(16, Math.floor((host.clientHeight || 600) / 18));
    return fetch('/api/term/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: opts.action || 'new', cwd: opts.cwd, sessionId: opts.sessionId,
        title: opts.title, cols: cols, rows: rows
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      mount(j.term);
      focus(j.term.id);
      return j.term;
    });
  }

  function mount(info) {
    if (views.has(info.id)) return views.get(info.id);

    var el = document.createElement('div');
    el.className = 'termpane';
    el.dataset.term = info.id;

    var head = document.createElement('div');
    head.className = 'ph2';
    el.appendChild(head);

    var body = document.createElement('div');
    body.className = 'pb2';
    el.appendChild(body);

    CC.host.appendChild(el);

    var term = new window.Terminal({
      cols: info.cols, rows: info.rows,
      fontFamily: '"Cascadia Mono", Consolas, "D2Coding", monospace',
      fontSize: 13, lineHeight: 1.2,
      cursorBlink: true, allowProposedApi: true,
      scrollback: 8000, theme: THEME
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch (e) {}
    term.open(body);

    var v = { el: el, head: head, term: term, fit: fit, ws: null, info: info, alive: info.alive };
    views.set(info.id, v);
    if (order.indexOf(info.id) < 0) order.push(info.id);

    el.addEventListener('mousedown', function () { focus(info.id, true); });
    term.onData(function (d) { sendMsg(v, { t: 'i', d: d }); });
    term.onResize(function (size) { sendMsg(v, { t: 'r', c: size.cols, r: size.rows }); });

    paneHead(v);
    wireClipboard(v, body);
    connect(v);
    return v;
  }

  // 패인 머리글: 세션 이름 · 프로젝트 · 상태 + 단독 보기 / 닫기
  function paneHead(v) {
    var i = v.info;
    var parts = String(i.cwd || '').split(/[\\/]/).filter(Boolean);
    var proj = parts.length ? parts[parts.length - 1] : i.cwd;
    var dot = !i.alive ? '' : (i.status === 'busy' ? 'busy' : 'idle');
    var st = !i.alive ? '종료됨' : (i.status === 'busy' ? '작업 중' : '대기 중');
    v.head.innerHTML =
      '<span class="st ' + dot + '"></span>'
      + '<span class="nm">' + escText(i.name || i.title || proj) + '</span>'
      + '<span class="pj">' + escText(proj) + ' · ' + st + '</span>'
      + '<span class="sp"></span>'
      + '<button class="pbtn" data-solo="' + escText(i.id) + '" title="이 터미널만 크게 보기">⤢</button>'
      + '<button class="pbtn" data-closeterm="' + escText(i.id) + '" title="' + (i.alive ? '세션 종료' : '닫기') + '">✕</button>';
  }

  function escText(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------ 복사 / 붙여넣기
  //
  // xterm.js 는 붙여넣기(브라우저 paste 이벤트)는 알아서 처리하지만,
  // Ctrl+C 는 선택이 있든 없든 항상 \x03(SIGINT) 로 보낸다.
  // cmd / Windows Terminal 규칙에 맞춘다:
  //
  //   Ctrl+C          선택이 있으면 복사, 없으면 SIGINT (그대로 통과)
  //   Ctrl+V          붙여넣기 (xterm 기본 - 건드리지 않는다)
  //   Ctrl+Shift+C    항상 복사
  //   Ctrl+Shift+V    붙여넣기 (클립보드 직접 읽기)
  //   Ctrl+Insert     복사        Shift+Insert  붙여넣기   (고전 윈도 방식)
  //   Ctrl+Shift+A    전체 선택   (Ctrl+A 는 TUI 가 줄 처음 이동에 쓰므로 건드리지 않는다)
  //   우클릭          선택이 있으면 복사, 없으면 붙여넣기 (cmd 빠른 편집 방식)
  //   가운데 클릭      붙여넣기
  //
  // 더블클릭(단어) · 트리플클릭(줄) 선택은 xterm 기본 기능이라 그대로 쓴다.

  function note(msg, isErr) {
    if (CC.toast) CC.toast(msg, isErr);
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
        function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  // 클립보드 API 가 막힌 경우를 위한 예비 수단
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function copySelection(v) {
    var text = v.term.getSelection();
    if (!text) return;
    writeClipboard(text).then(function (ok) {
      if (ok) {
        var n = text.length;
        note('복사됨 · ' + (n > 999 ? (n / 1000).toFixed(1) + 'k' : n) + '자');
        v.term.clearSelection();      // 다음 Ctrl+C 는 SIGINT 로 가게 한다
      } else {
        note('복사 실패 - Ctrl+Shift+C 로 다시 시도해 보세요', true);
      }
    });
  }

  function pasteClipboard(v) {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      note('이 브라우저에서는 Ctrl+V 로 붙여넣어 주세요', true);
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      if (!text) return;
      v.term.paste(text);             // 괄호 붙여넣기(bracketed paste) 규약을 지킨다
      v.term.focus();
    }, function () {
      note('클립보드를 읽지 못했습니다 - Ctrl+V 를 쓰세요', true);
    });
  }

  function wireClipboard(v, body) {
    var term = v.term;

    term.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      var ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
      var k = (e.key || '').toLowerCase();

      if (ctrl && !e.shiftKey && k === 'c') {
        // 선택이 있으면 복사하고 PTY 로 보내지 않는다. 없으면 평소대로 SIGINT.
        if (term.hasSelection()) { copySelection(v); return false; }
        return true;
      }
      if (ctrl && e.shiftKey && k === 'c') { copySelection(v); return false; }
      if (ctrl && !e.shiftKey && k === 'insert') { copySelection(v); return false; }

      // 붙여넣기.
      //
      // xterm 은 Ctrl+V 를 제어문자 \x16 으로 만들어 PTY 로 보내고 preventDefault 까지
      // 해버려서, 브라우저의 기본 붙여넣기가 아예 일어나지 않는다.
      // 여기서 false 를 돌려주면 xterm 이 손을 떼고 preventDefault 도 하지 않으므로
      // 브라우저가 평소처럼 붙여넣고, 그 paste 이벤트를 xterm 이 받아 PTY 로 보낸다.
      // (클립보드 읽기 권한이 필요 없다)
      if (ctrl && k === 'v') return false;                    // Ctrl+V, Ctrl+Shift+V
      if (!ctrl && e.shiftKey && k === 'insert') return false; // Shift+Insert

      if (ctrl && e.shiftKey && k === 'a') { term.selectAll(); return false; }

      return true;   // 그 밖의 키는 전부 PTY 로
    });

    // 우클릭: 선택 있으면 복사, 없으면 붙여넣기
    body.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (term.hasSelection()) copySelection(v);
      else pasteClipboard(v);
    });

    // 가운데 클릭 붙여넣기
    body.addEventListener('auxclick', function (e) {
      if (e.button === 1) { e.preventDefault(); pasteClipboard(v); }
    });
    body.addEventListener('mousedown', function (e) {
      if (e.button === 1) e.preventDefault();   // 가운데 클릭 자동 스크롤 방지
    });
  }

  function connect(v) {
    var ws = new WebSocket('ws://' + location.host + '/term?id=' + encodeURIComponent(v.info.id));
    v.ws = ws;
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'o') {
        v.term.write(m.d);
      } else if (m.t === 'm') {
        v.info = m.info; v.alive = m.info.alive;
        paneHead(v);
        if (onChange) onChange();
      } else if (m.t === 'x') {
        v.alive = false; v.info.alive = false;
        paneHead(v);
        v.term.write('\r\n\x1b[38;5;131m[세션이 종료되었습니다 - 종료 코드 ' + m.code + ']\x1b[m\r\n');
        if (onChange) onChange();
      } else if (m.t === 'e') {
        v.term.write('\r\n\x1b[38;5;131m[' + m.m + ']\x1b[m\r\n');
      }
    };
    ws.onclose = function () {
      if (v.alive) {
        v.term.write('\r\n\x1b[38;5;101m[연결이 끊겼습니다 - 3초 후 다시 붙습니다]\x1b[m\r\n');
        setTimeout(function () {
          if (views.has(v.info.id) && v.alive) { v.term.reset(); connect(v); }
        }, 3000);
      }
    };
  }

  function sendMsg(v, msg) {
    if (v.ws && v.ws.readyState === 1) { try { v.ws.send(JSON.stringify(msg)); } catch (e) {} }
  }

  // 포커스: 해당 터미널을 활성으로 만들고, 안 보이면 앞으로 끌어온다
  function focus(id, fromClick) {
    if (!views.has(id)) return;
    var wasActive = active === id;
    active = id;
    var n = slots();
    var visible = order.indexOf(id) < n;

    // 마우스로 클릭했고 이미 화면에 보이는 패인이면 레이아웃을 다시 잡지 않는다.
    // apply() 는 fit() 을 호출하는데, 드래그로 텍스트를 선택하는 중에 크기가
    // 다시 계산되면 선택이 풀린다.
    if (fromClick && visible) {
      if (!wasActive) {
        views.forEach(function (v2, k) { v2.el.classList.toggle('active', k === id); });
        if (onChange) onChange();
      }
      return;
    }

    if (!visible) {
      order.splice(order.indexOf(id), 1);
      order.unshift(id);
    }
    apply();
    if (!fromClick) {
      var v = views.get(id);
      requestAnimationFrame(function () { try { v.term.focus(); } catch (e) {} });
    } else {
      views.forEach(function (v2, k) { v2.el.classList.toggle('active', k === id); });
    }
  }

  function solo(id) { setLayout(1); focus(id); }

  function refit() { apply(); }

  // 서버 목록과 화면을 맞춘다 (새로고침 후 살아있는 터미널 되살리기)
  function sync(serverTerms) {
    var seen = {};
    serverTerms.forEach(function (info) {
      seen[info.id] = true;
      var v = views.get(info.id);
      if (v) {
        var changed = v.info.status !== info.status || v.info.alive !== info.alive
          || v.info.name !== info.name || v.info.sessionId !== info.sessionId;
        v.info = info; v.alive = info.alive;
        if (changed) paneHead(v);
      } else {
        mount(info);
      }
    });
    views.forEach(function (v, id) { if (!seen[id]) drop(id); });
    if (!active || !views.has(active)) active = order.length ? order[0] : null;
    apply();
  }

  function drop(id) {
    var v = views.get(id);
    if (!v) return;
    try { if (v.ws) v.ws.close(); } catch (e) {}
    try { v.term.dispose(); } catch (e) {}
    if (v.el.parentNode) v.el.parentNode.removeChild(v.el);
    views.delete(id);
    var i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    if (active === id) active = order.length ? order[0] : null;
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }
  function stop(id) { return post('/api/term/kill', { id: id }); }
  function close(id) { return post('/api/term/close', { id: id }).then(function (r) { drop(id); return r; }); }

  function listLocal() {
    return order.map(function (id) { return views.get(id).info; });
  }

  window.addEventListener('resize', function () { apply(); });

  CC.term = {
    init: init, open: open, sync: sync, refit: refit,
    show: focus, focus: focus, solo: solo,
    setLayout: setLayout, getLayout: getLayout, slots: slots,
    setOrient: setOrient, getOrient: getOrient,
    stop: stop, close: close, drop: drop,
    list: listLocal,
    // 디버깅·테스트용: 특정 터미널의 xterm 인스턴스
    xterm: function (id) { var v = views.get(id); return v ? v.term : null; },
    get current() { return active; },
    get visibleIds() { return order.slice(0, slots()); },
    has: function (id) { return views.has(id); }
  };
})();
