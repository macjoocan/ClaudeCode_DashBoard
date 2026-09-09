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

  var GUT = 6;               // 패인 사이 간격(px). 이 틈이 곧 크기 조절 손잡이다.
  var MINPX = 140;           // 패인 최소 크기
  var sizes = {};            // "orient:칸수" -> { c:[비율...], r:[비율...] }
  var savedOrder = null;     // 사용자가 드래그로 정한 순서 (localStorage)
  var orderRestored = false;
  var guts = null;           // 손잡이 오버레이 (grid 배치에 끼지 않게 absolute)

  function init(hostEl, changeCb) {
    CC.host = hostEl;
    onChange = changeCb;
    layout = Number(localStorage.getItem('ccl.layout') || 1);
    orient = localStorage.getItem('ccl.orient') || 'grid';
    sizes = readJson('ccl.sizes') || {};
    savedOrder = readJson('ccl.order') || null;
  }

  function readJson(k) {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
  }
  function writeJson(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  function setLayout(n) {
    // 0 은 '전체'다. `Number(n) || 1` 로 쓰면 0 이 1 로 바뀌어 전체가 1분할이 된다
    // (새로고침 뒤엔 문자열 '0' 이라 통과해서, 클릭할 때만 어긋났다).
    var v = Number(n);
    layout = (isFinite(v) && v >= 0) ? v : 1;
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

  // 배치 방향
  //   cols(가로) : 좌우로 나란히          [A][B][C]
  //   rows(세로) : 위아래로 쌓기           [A]
  //                                        [B]
  //   grid(가로세로) : 정사각형에 가깝게    [A][B]
  //                                        [C][D]
  function geometry(n) {
    if (orient === 'cols') return { cols: Math.max(1, n), rows: 1 };
    if (orient === 'rows') return { cols: 1, rows: Math.max(1, n) };
    // 항상 정사각형에 가깝게. n=3 이면 2x2 가 되어 가로 배치와 구분된다.
    var cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    return { cols: cols, rows: Math.max(1, Math.ceil(n / cols)) };
  }

  // ------------------------------------------------------------ 패인 크기 (비율)
  //
  // 칸 수마다 따로 기억한다. 2분할에서 잡은 비율이 4분할로 갔다 와도 그대로 남는다.

  function sizeKey(geo) { return orient + ':' + geo.cols + 'x' + geo.rows; }

  function ones(n) { var a = []; for (var i = 0; i < n; i++) a.push(1); return a; }

  function sizeFor(geo) {
    var k = sizeKey(geo);
    var s = sizes[k];
    if (!s || !s.c || s.c.length !== geo.cols || !s.r || s.r.length !== geo.rows) {
      s = { c: ones(geo.cols), r: ones(geo.rows) };
      sizes[k] = s;
    }
    return s;
  }

  function applyTemplate(geo) {
    var host = CC.host;
    var s = sizeFor(geo);
    var track = function (f) { return 'minmax(0,' + f + 'fr)'; };
    host.style.display = 'grid';
    host.style.position = 'relative';
    host.style.gap = GUT + 'px';
    host.style.gridTemplateColumns = s.c.map(track).join(' ');
    host.style.gridTemplateRows = s.r.map(track).join(' ');
  }

  function fitVisible(n) {
    order.slice(0, n).forEach(function (id) {
      var v = views.get(id);
      if (!v) return;
      try { v.fit.fit(); } catch (e) {}
    });
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

    var geo = geometry(n);
    applyTemplate(geo);

    // 격자에서 마지막 줄이 비면 마지막 패인이 남은 칸을 채운다 (구멍 방지).
    // 'auto / -1' 로는 안 된다 - 시작 선이 자동으로 잡혀 한 칸만 차지한다. span 을 센다.
    var lastSpan = 1;
    if (orient === 'grid' && n > 1) {
      var rem = n % geo.cols;
      if (rem !== 0) lastSpan = geo.cols - rem + 1;
    }

    order.forEach(function (id, idx) {
      var v = views.get(id);
      if (!v) return;
      var visible = idx < n;
      v.el.hidden = !visible;
      v.el.classList.toggle('active', id === active);
      v.el.classList.toggle('solo', n === 1);
      // grid 자동 배치는 DOM 순서가 아니라 **order 를 반영한 순서**를 따른다.
      // 이걸 안 주면 order 배열만 바뀌고 화면의 좌우 위치는 그대로다
      // (자리 옮기기가 "안 먹는" 것처럼 보인다).
      v.el.style.order = idx;
      v.el.style.gridColumn = (visible && idx === n - 1 && lastSpan > 1)
        ? 'span ' + lastSpan : '';
    });

    // 자리 번호와 ◀ ▶ 활성 상태는 order 에 달려 있으니 같이 다시 그린다
    refreshHeads();

    // 레이아웃이 바뀐 뒤 실제 크기가 정해지면 fit + 손잡이 재배치
    requestAnimationFrame(function () {
      fitVisible(n);
      layoutGuts(geo);
      if (onChange) onChange();
    });
  }

  function refreshHeads() {
    views.forEach(function (v) { paneHead(v); });
  }

  // ------------------------------------------------------------ 크기 조절 손잡이
  //
  // 손잡이는 grid 자식이 아니라 absolute 오버레이다. grid 자식으로 넣으면 패인
  // 자동 배치에 끼어들어 칸이 밀린다.

  function trackPx(prop) {
    // 계산된 값은 'minmax(0,1fr)' 이 아니라 해결된 픽셀('440px 6px ...')로 나온다
    var s = (getComputedStyle(CC.host)[prop] || '').split(' ');
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var n = parseFloat(s[i]);
      if (isFinite(n)) out.push(n);
    }
    return out;
  }

  function layoutGuts(geo) {
    var host = CC.host;
    if (!host) return;
    if (!guts) {
      guts = document.createElement('div');
      guts.className = 'termguts';
      host.appendChild(guts);
      wireGuts();
    }
    var nc = geo.cols > 1 ? geo.cols - 1 : 0;
    var nr = geo.rows > 1 ? geo.rows - 1 : 0;
    if (!nc && !nr) { guts.innerHTML = ''; return; }

    var w = trackPx('gridTemplateColumns');
    var h = trackPx('gridTemplateRows');
    if (w.length !== geo.cols || h.length !== geo.rows) return;   // 아직 크기가 안 잡혔다

    var html = '', acc, j;
    // 열 경계: 두 칸 사이 gap 의 가운데
    acc = 0;
    for (j = 0; j < nc; j++) {
      acc += w[j];
      html += '<div class="gut gc" data-gc="' + j + '" style="left:'
            + (acc + j * GUT + GUT / 2) + 'px" title="좌우 크기 조절 (더블클릭하면 균등)"></div>';
    }
    acc = 0;
    for (j = 0; j < nr; j++) {
      acc += h[j];
      html += '<div class="gut gr" data-gr="' + j + '" style="top:'
            + (acc + j * GUT + GUT / 2) + 'px" title="위아래 크기 조절 (더블클릭하면 균등)"></div>';
    }
    guts.innerHTML = html;
  }

  function wireGuts() {
    guts.addEventListener('dblclick', function (e) {
      var g = e.target.closest && e.target.closest('.gut');
      if (!g) return;
      var geo = geometry(slots());
      var s = sizeFor(geo);
      if (g.classList.contains('gc')) s.c = ones(geo.cols); else s.r = ones(geo.rows);
      writeJson('ccl.sizes', sizes);
      apply();
    });

    guts.addEventListener('pointerdown', function (e) {
      var g = e.target.closest && e.target.closest('.gut');
      if (!g || e.button !== 0) return;

      var isCol = g.classList.contains('gc');
      var idx = Number(isCol ? g.dataset.gc : g.dataset.gr);
      var n = slots();
      var geo = geometry(n);
      var s = sizeFor(geo);
      var arr = isCol ? s.c : s.r;
      var px = trackPx(isCol ? 'gridTemplateColumns' : 'gridTemplateRows');
      if (px.length !== arr.length || idx + 1 >= arr.length) return;

      var a = px[idx], total = a + px[idx + 1];
      var pair = arr[idx] + arr[idx + 1];
      var start = isCol ? e.clientX : e.clientY;
      var lastFit = 0;

      g.classList.add('on');
      document.body.classList.add(isCol ? 'gcdrag' : 'grdrag');

      function move(ev) {
        var d = (isCol ? ev.clientX : ev.clientY) - start;
        var na = Math.max(MINPX, Math.min(total - MINPX, a + d));
        arr[idx] = pair * (na / total);
        arr[idx + 1] = pair - arr[idx];
        applyTemplate(geo);
        // fit 은 무거우니 드래그 중에는 솎아낸다. 안 하면 캔버스가 잘려 보인다.
        var now = Date.now();
        if (now - lastFit > 80) { lastFit = now; fitVisible(n); }
        layoutGuts(geo);
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        g.classList.remove('on');
        document.body.classList.remove('gcdrag', 'grdrag');
        writeJson('ccl.sizes', sizes);
        fitVisible(n);
        layoutGuts(geo);
        if (onChange) onChange();
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }

  function resetSizes() {
    sizes = {};
    writeJson('ccl.sizes', sizes);
    apply();
  }

  // ------------------------------------------------------------ 위치 바꾸기 (드래그)

  // id 를 targetId 자리로 밀어넣는다 (스왑이 아니라 삽입)
  function moveTo(id, targetId) {
    var from = order.indexOf(id), to = order.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, id);
    writeJson('ccl.order', order);
    apply();
    if (onChange) onChange();
  }

  // 한 칸 앞/뒤로. 화면에 보이는 범위 안에서만 돈다 - 안 보이는 자리로 밀어내면
  // 버튼을 눌렀는데 패인이 사라진 것처럼 보인다.
  function nudge(id, dir) {
    var n = slots();
    var from = order.indexOf(id);
    if (from < 0) return false;
    var to = from + dir;
    if (to < 0 || to >= Math.max(n, 1) || to >= order.length) return false;
    order.splice(from, 1);
    order.splice(to, 0, id);
    writeJson('ccl.order', order);
    apply();
    if (onChange) onChange();
    return true;
  }

  // 이 패인이 앞/뒤로 갈 수 있나 (버튼 비활성화 판단용)
  function canNudge(id, dir) {
    var n = slots();
    var i = order.indexOf(id);
    if (i < 0) return false;
    var to = i + dir;
    return to >= 0 && to < Math.max(n, 1) && to < order.length;
  }

  // 머리글을 잡고 끌면 다른 패인 자리로 옮긴다.
  // preventDefault 를 하지 않는다 - 그러면 mousedown 이 막혀 포커스가 안 간다.
  function wireDrag(v) {
    v.head.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return;   // 버튼은 버튼대로
      var id = v.info.id;
      var sx = e.clientX, sy = e.clientY;
      var moved = false, overId = null;

      function mark(tid) {
        if (tid === overId) return;
        var prev = overId && views.get(overId);
        if (prev) prev.el.classList.remove('dropto');
        overId = tid;
        var next = overId && views.get(overId);
        if (next) next.el.classList.add('dropto');
      }

      function move(ev) {
        if (!moved) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
          moved = true;
          v.el.classList.add('drag');
          document.body.classList.add('panedrag');
        }
        var el = document.elementFromPoint(ev.clientX, ev.clientY);
        var pane = el && el.closest ? el.closest('.termpane') : null;
        var tid = pane && pane.dataset.term !== id ? pane.dataset.term : null;
        mark(tid);
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        v.el.classList.remove('drag');
        document.body.classList.remove('panedrag');
        var target = overId;
        mark(null);
        if (moved && target) moveTo(id, target);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
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
        title: opts.title, cols: cols, rows: rows, provider: opts.provider
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      mount(j.term);
      focus(j.term.id);
      return j.term;
    });
  }

  // 복사·붙여넣기는 아래 wireClipboard() 한 곳에서만 건다.
  // (병합 정리: 여기 있던 같은 목적의 구현을 지웠다. 둘 다 두면 contextmenu 리스너가
  //  두 개 붙어, 선택 상태로 우클릭하면 복사한 뒤 곧바로 붙여넣기까지 일어난다.)

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
    wireDrag(v);
    connect(v);
    return v;
  }

  // 패인 머리글: 세션 이름 · 프로젝트 · 상태 + 새로고침 / 재시작 / 단독 보기 / 닫기
  function paneHead(v) {
    var i = v.info;
    var parts = String(i.cwd || '').split(/[\\/]/).filter(Boolean);
    var proj = parts.length ? parts[parts.length - 1] : i.cwd;
    var dot = !i.alive ? '' : (i.status === 'busy' ? 'busy' : 'idle');
    var st = !i.alive ? '종료됨' : (i.status === 'busy' ? '작업 중' : '대기 중');
    var rs = i.restarts ? ' · 재시작 ' + i.restarts + '회' : '';
    var id = escText(i.id);
    // 자리 번호를 보여준다. 몇 번째 칸인지 알아야 ◀ ▶ 가 무슨 뜻인지 안다.
    var pos = order.indexOf(i.id);
    var posN = pos >= 0 ? (pos + 1) : '';
    v.head.innerHTML =
      '<span class="grip" title="끌어서 자리 옮기기">⠿</span>'
      + '<span class="pos" title="' + posN + '번째 자리">' + posN + '</span>'
      + '<span class="st ' + dot + '"></span>'
      + '<span class="nm">' + escText(i.name || i.title || proj) + '</span>'
      + '<span class="pj">' + escText(proj) + ' · ' + st + rs + '</span>'
      + '<span class="sp"></span>'
      + '<button class="pbtn nav" data-movepane="' + id + '" data-dir="-1"'
      +   (canNudge(i.id, -1) ? '' : ' disabled')
      +   ' title="앞 자리로 (Alt+←)">◀</button>'
      + '<button class="pbtn nav" data-movepane="' + id + '" data-dir="1"'
      +   (canNudge(i.id, 1) ? '' : ' disabled')
      +   ' title="뒤 자리로 (Alt+→)">▶</button>'
      + '<button class="pbtn" data-reloadterm="' + id + '"'
      +   ' title="새로고침 - 화면만 다시 붙인다. 세션은 건드리지 않는다">↻</button>'
      + '<button class="pbtn warn" data-restartterm="' + id + '"'
      +   ' title="재시작 - CLI 를 끄고 같은 세션으로 다시 켠다 (--resume). 응답 중이던 내용은 사라진다">⟳</button>'
      + '<button class="pbtn" data-solo="' + id + '" title="이 터미널만 크게 보기">⤢</button>'
      + '<button class="pbtn" data-closeterm="' + id + '" title="' + (i.alive ? '세션 종료' : '닫기') + '">✕</button>';
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

      // Alt+← / Alt+→ : 패인을 앞뒤 자리로. 전역 키 핸들러는 #termwrap 안에서
      // 물러나므로(터미널 입력을 가로채지 않으려고) 여기서 직접 받는다.
      if (e.altKey && !e.ctrlKey && !e.metaKey && (k === 'arrowleft' || k === 'arrowright')) {
        nudge(v.info.id, k === 'arrowleft' ? -1 : 1);
        if (onChange) onChange();
        return false;
      }

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
      } else if (m.t === 'reset') {
        v.term.reset();                    // 서버가 PTY 를 갈아끼웠다
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

    // 드래그로 정해둔 순서는 첫 동기화에서 한 번만 복원한다.
    // 매번 하면 apply() 가 활성 패인을 앞으로 끌어온 것을 4초마다 되돌려버린다.
    if (!orderRestored && order.length) { restoreOrder(); orderRestored = true; }

    if (!active || !views.has(active)) active = order.length ? order[0] : null;
    apply();
  }

  function restoreOrder() {
    if (!savedOrder || !savedOrder.length) return;
    var rank = {};
    savedOrder.forEach(function (id, i) { rank[id] = i; });
    var known = [], fresh = [];
    order.forEach(function (id) { (rank[id] === undefined ? fresh : known).push(id); });
    known.sort(function (a, b) { return rank[a] - rank[b]; });
    order = known.concat(fresh);          // 저장에 없는 새 터미널은 뒤에 붙인다
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

  // 새로고침: 화면만 다시 붙인다. 서버가 스크롤백을 다시 보내주므로 내용은 그대로다.
  // WebSocket 이 조용히 죽었거나 출력이 깨져 보일 때 쓴다. 세션은 건드리지 않는다.
  function reload(id) {
    var v = views.get(id);
    if (!v) return;
    try {
      if (v.ws) { v.ws.onclose = null; v.ws.onmessage = null; v.ws.close(); }
    } catch (e) {}
    v.term.reset();
    connect(v);
    requestAnimationFrame(function () { try { v.fit.fit(); } catch (e) {} });
  }

  // 재시작: CLI 프로세스만 갈아끼운다. 터미널 id 가 유지되므로 자리·크기가 그대로다.
  function restart(id) {
    var v = views.get(id);
    if (!v) return Promise.resolve();
    v.term.write('\r\n\x1b[38;5;101m[재시작 중...]\x1b[m\r\n');
    return post('/api/term/restart', { id: id }).then(function (j) {
      if (j.error) {
        v.term.write('\r\n\x1b[38;5;131m[재시작 실패: ' + j.error + ']\x1b[m\r\n');
        return;
      }
      v.info = j.term;
      v.alive = j.term.alive;
      paneHead(v);
      reload(id);              // 새 PTY 에 다시 붙는다
      if (onChange) onChange();
    });
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
    reload: reload, restart: restart,
    moveTo: moveTo, nudge: nudge, resetSizes: resetSizes,
    list: listLocal,
    // 탭 바가 패인 순서를 따라가게 한다
    orderOf: function (id) { var i = order.indexOf(id); return i < 0 ? 9999 : i; },
    // 디버깅·테스트용: 특정 터미널의 xterm 인스턴스
    xterm: function (id) { var v = views.get(id); return v ? v.term : null; },
    get current() { return active; },
    get visibleIds() { return order.slice(0, slots()); },
    has: function (id) { return views.has(id); }
  };
})();
