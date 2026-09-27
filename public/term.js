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
  var refitTimer = null;     // 창 리사이즈 중 xterm 재줄바꿈이 연속 실행되지 않게 모은다

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

  function fitView(v) {
    if (!v.el.getClientRects().length) return;
    var buffer = v.term.buffer.active;
    var atBottom = buffer.viewportY >= buffer.baseY;
    try {
      v.fit.fit();
      // Header sizing can finish after replay. Keep a bottom-pinned view pinned,
      // but do not pull a user reading older output back down.
      if (atBottom) v.term.scrollToBottom();
    } catch (e) {}
  }

  function fitVisible(n) {
    order.slice(0, n).forEach(function (id) {
      var v = views.get(id);
      if (!v) return;
      fitView(v);
    });
  }

  // xterm 은 cols/rows 가 바뀔 때 긴 스크롤백 전체를 다시 줄바꿈한다. 브라우저의
  // resize 이벤트마다 곧바로 fit 하면 내용이 위아래로 튀는 과정이 그대로 보인다.
  // 마지막 크기가 정해진 뒤 한 번만 맞춰 같은 작업을 반복하지 않는다.
  function scheduleRefit() {
    if (refitTimer) clearTimeout(refitTimer);
    refitTimer = setTimeout(function () {
      refitTimer = null;
      apply();
    }, 120);
  }

  function cancelScheduledRefit() {
    if (!refitTimer) return;
    clearTimeout(refitTimer);
    refitTimer = null;
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
      g.classList.add('on');
      document.body.classList.add(isCol ? 'gcdrag' : 'grdrag');

      function move(ev) {
        var d = (isCol ? ev.clientX : ev.clientY) - start;
        var na = Math.max(MINPX, Math.min(total - MINPX, a + d));
        arr[idx] = pair * (na / total);
        arr[idx + 1] = pair - arr[idx];
        applyTemplate(geo);
        // 드래그 중 fit 하면 긴 스크롤백이 계속 재줄바꿈되어 화면이 위아래로 튄다.
        // 패인 틀만 움직이고 PTY 크기는 손을 놓았을 때 한 번만 맞춘다.
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

  // 참고: 예전에 Codex 패인을 강제로 대체화면(?1049h)에 넣었다. 되돌렸다.
  //
  // 대체화면에는 스크롤백이 없다. 그래서 마우스 휠로 되짚을 것이 아예 없었고,
  // 게다가 xterm 은 대체화면에서 휠을 **위/아래 화살표 키로 바꿔 앱에 보낸다**.
  // Codex 가 그걸 받아 제 대화 기록을 스크롤했다 - 휠을 굴리면 터미널이 아니라
  // 지난 대화가 쓸려 지나가던 것이 이것이다. 맨 터미널에서 멀쩡했던 이유이기도 하다.
  // 그쪽은 대체화면을 쓰지 않는다. 우리도 쓰지 않는다.

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
      // Codex TUI 는 대기 중에도 커서 모양 제어열(ESC [0 q)을 계속 보내 깜빡임 위상을
      // 초기화한다. Codex 패인에서는 꺼 둔다.
      // 주의: 생성자에 false 가 전달되는 것까지는 확인했지만, xterm 의 options 읽기가
      // 계속 true 를 돌려줘 화면에서의 효과는 확인하지 못했다.
      cursorBlink: info.provider !== 'codex', allowProposedApi: true,
      // Codex 는 스크롤백을 짧게 둔다.
      //
      // 제자리에 덧그리는 TUI 라 뒤로 밀린 줄은 "지난 대화" 가 아니라 **옛 프레임 조각**이다.
      // 남겨봐야 볼 것이 없는데 값은 비싸다 - 실측: Codex 패인 하나가 8000줄까지 차고,
      // 패인 크기를 바꾸거나 터미널을 하나 더 열어 배치가 바뀔 때마다 xterm 이 그 8000줄을
      // 전부 다시 줄바꿈한다. 그게 "스크롤이 계속 도는" 것처럼 보이고 실제로도 버벅인다.
      // (그 리사이즈로 새로 들어온 출력은 0바이트였다 - 순전히 reflow 비용이다.)
      // 0 으로 두면 뒤를 아예 못 봐서 오히려 화면이 잘린 것처럼 보인다(실측).
      // 마우스 휠로 되짚으려면 남아 있어야 한다 - 0 이면 휠이 아무 것도 안 한다.
      // 1000줄이면 reflow 는 싸고 최근 것은 되짚을 수 있다.
      // Claude Code 는 로그처럼 덧붙이므로 스크롤백이 진짜 기록이다. 8000 줄 그대로 둔다.
      scrollback: info.provider === 'codex' ? 1000 : 8000, theme: THEME
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch (e) {}
    term.open(body);

    var v = { el: el, head: head, body: body, term: term, fit: fit, ws: null, info: info, alive: info.alive };
    // Explicit navigation wins over the pending initial-replay scroll.
    ['wheel', 'pointerdown', 'keydown'].forEach(function (name) {
      body.addEventListener(name, function () { markNavigation(v); }, { passive: true });
    });
    views.set(info.id, v);
    if (order.indexOf(info.id) < 0) order.push(info.id);

    el.addEventListener('mousedown', function () { focus(info.id, true); });

    term.onData(function (d) { sendMsg(v, { t: 'i', d: d }); });
    term.onResize(function (size) { sendMsg(v, { t: 'r', c: size.cols, r: size.rows }); });

    registerMdLinks(v);
    paneHead(v);
    wireClipboard(v, body);
    wireDrag(v);
    connect(v);
    return v;
  }

  // 터미널에 찍힌 .md 경로를 클릭하면 문서 탭에서 그 문서를 연다.
  //
  // Claude Code 도 Codex 도 문서를 만들면 경로를 찍어준다. 그걸 손으로 복사해
  // 폴더를 고르는 대신 바로 갈 수 있게 한다. 상대경로는 그 터미널의 cwd 기준이라
  // 서버가 풀어준다(/api/md/resolve).
  //
  // 공백이 든 경로는 따옴표로 감싼 경우에만 한 경로로 판정한다.
  //
  //   [드라이브: 또는 구분자로 시작]?  (폴더 구분자)*  이름.md
  var MD_PATH_RE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[^\s"'`<>|*?]+[\\/])*[^\s"'`<>|*?]+\.(?:md|markdown)(?![A-Za-z0-9_])/g;
  var QUOTED_MD_PATH_RE = /["'`]([^"'`\r\n]+\.(?:md|markdown))["'`]/g;

  function registerMdLinks(v) {
    if (!v.term.registerLinkProvider) return;
    v.term.registerLinkProvider({
      provideLinks: function (y, cb) {
        var buffer = v.term.buffer.active;
        var line = buffer.getLine(y - 1);
        if (!line) { cb(undefined); return; }
        // xterm 은 긴 경로를 여러 화면 줄로 접는다. 이어진 줄을 한 논리 줄로
        // 합쳐야 앞부분을 잃지 않고 실제 파일 경로를 열 수 있다.
        var first = y - 1, last = y - 1;
        while (first > 0 && first > y - 16 && buffer.getLine(first).isWrapped) first--;
        while (last < y + 14 && buffer.getLine(last + 1)?.isWrapped) last++;
        var parts = [], text = '';
        for (var row = first; row <= last; row++) {
          var partLine = buffer.getLine(row);
          var partText = partLine.translateToString(true);
          parts.push({ line: partLine, y: row + 1, start: text.length, end: text.length + partText.length });
          text += partText;
        }
        var links = [], quoted = [], m;
        QUOTED_MD_PATH_RE.lastIndex = 0;
        while ((m = QUOTED_MD_PATH_RE.exec(text)) !== null) {
          if (!m[1].includes(' ')) continue;
          quoted.push({ start: m.index + 1, end: m.index + 1 + m[1].length });
          links.push(mdLink(v, m[1], mdLinkRange(parts, m.index + 1, m[1].length)));
        }
        MD_PATH_RE.lastIndex = 0;
        while ((m = MD_PATH_RE.exec(text)) !== null) {
          if (quoted.some(q => m.index >= q.start && m.index < q.end)) continue;
          // 경로를 감싼 괄호·따옴표와 문장 끝 기호는 경로가 아니다.
          // 앞을 깎은 만큼 밑줄 위치도 밀어야 엉뚱한 칸에 그어지지 않는다.
          var raw = m[0];
          var lead = raw.match(/^[([{'"`]+/);
          if (lead) raw = raw.slice(lead[0].length);
          raw = raw.replace(/[)\]},.;:'"`]+$/, '');
          if (!raw || raw.length < 4) continue;
          links.push(mdLink(v, raw, mdLinkRange(parts, m.index + (lead ? lead[0].length : 0), raw.length)));
        }
        links = links.filter(function (link) {
          return link.range.start && link.range.end &&
            link.range.start.y <= y && y <= link.range.end.y;
        });
        cb(links.length ? links : undefined);
      }
    });
  }

  function mdLinkRange(parts, start, length) {
    function point(index, end) {
      for (var part of parts) {
        if (index < part.start || index >= part.end) continue;
        var offset = index - part.start;
        var line = part.line;
        if (line.getCell) {
          var chars = 0;
          for (var col = 0; col < line.length; col++) {
            var cell = line.getCell(col);
            if (!cell || !cell.getWidth()) continue;
            var width = cell.getWidth();
            var count = (cell.getChars() || ' ').length;
            if (offset < chars + count) return { x: col + (end ? width : 1), y: part.y };
            chars += count;
          }
        }
        return { x: offset + 1, y: part.y };
      }
      return null;
    }
    return { start: point(start, false), end: point(start + length - 1, true) };
  }

  function mdLink(v, raw, range) {
    return {
      text: raw,
      range: range,
      activate: function (ev) {
        if (CC.openMd) CC.openMd(raw, v.info.cwd);
        else note('문서 탭을 쓸 수 없습니다', true);
      }
    };
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
      + '<button class="pbtn fav ' + (i.fav ? 'on' : '') + '" data-termfav="' + id + '"'
      +   (!i.sessionId ? ' disabled' : '')
      +   ' title="이 세션 즐겨찾기">' + (i.fav ? '★' : '☆') + '</button>'
      + '<button class="pbtn ctx" data-termcopyid="' + id + '"'
      +   (!i.sessionId ? ' disabled' : '')
      +   ' title="' + (i.sessionId
            ? '세션 ID 복사 · ' + escText(i.sessionId)
            : '세션 ID 는 첫 대화가 시작돼야 생깁니다') + '">ID</button>'
      + '<button class="pbtn ctx" data-termctx="compact" data-termid="' + id + '"'
      +   (!i.alive ? ' disabled' : '') + ' title="현재 대화를 요약 압축해 컨텍스트 공간 확보">압축</button>'
      + '<button class="pbtn ctx warn" data-termctx="clear" data-termid="' + id + '"'
      +   (!i.alive ? ' disabled' : '') + ' title="대화 기록은 보존하고 빈 컨텍스트의 새 세션 시작">초기화</button>'
      + '<button class="pbtn ctx" data-termhandoff="' + id + '"'
      +   (!i.alive || !i.sessionId ? ' disabled' : '')
      +   ' title="현재 AI가 인수인계를 요약한 뒤 반대편 AI로 전환">AI 전환</button>'
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

  // 세션 ID 를 클립보드로. --resume 에 그대로 붙여 쓸 수 있는 값이다.
  function copyId(id) {
    var v = views.get(id);
    var sid = v && v.info ? v.info.sessionId : null;
    if (!sid) { note('아직 세션 ID 가 없습니다 - 첫 대화 뒤에 생깁니다', true); return; }
    writeClipboard(sid).then(function (ok) {
      note(ok ? '세션 ID 를 복사했습니다 · ' + sid : '복사 실패 - ID: ' + sid, !ok);
    });
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

    wireFiles(v, body);
  }

  // ------------------------------------------------------ 이미지 · 파일 넣기
  //
  // PTY 는 텍스트만 흘린다. 이미지 바이트를 그대로 밀어넣을 방법이 없다.
  // 그래서 브라우저가 받은 파일을 서버에 올려 디스크에 저장하고, 그 **경로**를
  // 프롬프트에 찍어준다. CLI 는 경로를 받으면 알아서 읽는다
  // (공식 문서: "Provide an image path to Claude").
  //
  // 끌어다 놓기도 같은 길을 쓴다. 브라우저는 보안상 끌어온 파일의 진짜 경로를
  // 알려주지 않으므로(파일 이름만 준다), 내용을 올려 새로 저장하는 수밖에 없다.

  function humanSize(n) {
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
    return (n / 1048576).toFixed(1) + 'MB';
  }

  // 경로에 공백이 있으면 따옴표로 감싼다
  function quoteIfNeeded(p) {
    return /\s/.test(p) ? '"' + p + '"' : p;
  }

  function uploadOne(file) {
    var name = file.name || ('paste-' + Date.now()
      + ((file.type && file.type.indexOf('/') > 0) ? '.' + file.type.split('/')[1].split('+')[0] : '.bin'));
    return fetch('/api/paste-file?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      return j;
    });
  }

  // 파일들을 올리고 경로를 프롬프트에 찍는다
  function sendFiles(v, files) {
    var list = [];
    for (var i = 0; i < files.length; i++) list.push(files[i]);
    if (!list.length) return;

    note(list.length === 1 ? '올리는 중…' : list.length + '개 올리는 중…');
    var done = [], failed = 0;

    return list.reduce(function (chain, f) {
      return chain.then(function () {
        return uploadOne(f).then(
          function (j) { done.push(j); },
          function (e) { failed++; note('올리기 실패: ' + e.message, true); });
      });
    }, Promise.resolve()).then(function () {
      if (!done.length) return;
      // 경로 앞뒤에 공백을 둬서 이미 쓰던 문장에 자연스럽게 붙게 한다
      var text = done.map(function (j) { return quoteIfNeeded(j.path); }).join(' ') + ' ';
      sendMsg(v, { t: 'i', d: text });
      try { v.term.focus(); } catch (e) {}
      var bytes = done.reduce(function (s, j) { return s + j.bytes; }, 0);
      note(done.length + '개 경로를 넣었습니다 · ' + humanSize(bytes)
        + (failed ? ' (' + failed + '개 실패)' : ''));
    });
  }

  function wireFiles(v, body) {
    // 붙여넣기에 파일이 실려 오면 그것을 먼저 처리한다.
    // 텍스트 붙여넣기는 건드리지 않는다 - xterm 의 기본 경로로 그냥 흘려보낸다.
    body.addEventListener('paste', function (e) {
      var files = filesFrom(e.clipboardData);
      if (!files.length) return;          // 평범한 텍스트 붙여넣기
      e.preventDefault();
      e.stopPropagation();
      sendFiles(v, files);
    }, true);
  }

  // dataTransfer 에서 실제 파일을 긁어모은다.
  // files 만 보면 안 된다 - 웹페이지에서 끌어온 이미지는 items 에만 들어온다.
  function filesFrom(dt) {
    var out = [];
    if (!dt) return out;
    if (dt.files && dt.files.length) {
      for (var i = 0; i < dt.files.length; i++) out.push(dt.files[i]);
      return out;
    }
    if (dt.items) {
      for (var k = 0; k < dt.items.length; k++) {
        if (dt.items[k].kind === 'file') {
          var f = dt.items[k].getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  // 웹페이지에서 끌어온 이미지는 파일이 아니라 URL 로 온다
  function urlFrom(dt) {
    if (!dt) return null;
    var s = '';
    try { s = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch (e) {}
    s = String(s).split('\n')[0].trim();
    return /^https?:\/\//i.test(s) ? s : null;
  }

  // ------------------------------------------------------------ 끌어다 놓기
  //
  // 문서 전체에서 받는다. 패인 안에만 걸면 머리글·패인 사이 틈처럼 살짝 빗나간 곳에
  // 놓았을 때 브라우저 기본 동작이 나가서 **새 탭에 이미지가 열려버린다.**
  // 그리고 그때는 우리 drop 핸들러가 안 돌아 오버레이가 화면에 그대로 남는다.
  // 그래서 (1) 터미널 탭에서는 문서 수준에서 무조건 기본 동작을 막고,
  //        (2) 오버레이는 어떤 경로로 끝나든 반드시 걷어낸다.

  var dragPane = null;      // 지금 오버레이가 걸린 패인

  function markPane(el) {
    if (dragPane === el) return;
    if (dragPane) dragPane.classList.remove('dropfile');
    dragPane = el;
    if (dragPane) dragPane.classList.add('dropfile');
  }
  function clearDrag() { markPane(null); }

  // 포인터 밑의 패인. 없으면 활성 패인으로 보낸다.
  function paneAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var pane = el && el.closest ? el.closest('.termpane') : null;
    if (pane && views.has(pane.dataset.term)) return views.get(pane.dataset.term);
    if (active && views.has(active)) return views.get(active);
    return null;
  }

  function dragHasPayload(dt) {
    if (!dt) return false;
    var t = dt.types || [];
    for (var i = 0; i < t.length; i++) {
      if (t[i] === 'Files' || t[i] === 'text/uri-list') return true;
    }
    return false;
  }

  // 터미널 화면이 떠 있을 때만 가로챈다
  function termVisible() {
    var w = document.getElementById('termwrap');
    return w && !w.hidden;
  }

  function initDrop() {
    document.addEventListener('dragover', function (e) {
      if (!termVisible() || !dragHasPayload(e.dataTransfer)) return;
      e.preventDefault();                       // 이걸 해야 drop 이 우리에게 온다
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
      var v = paneAt(e.clientX, e.clientY);
      markPane(v ? v.el : null);
    });

    document.addEventListener('drop', function (e) {
      if (!termVisible() || !dragHasPayload(e.dataTransfer)) { clearDrag(); return; }
      e.preventDefault();                       // 새 탭으로 열리는 것을 막는다
      e.stopPropagation();
      var v = paneAt(e.clientX, e.clientY);
      clearDrag();
      if (!v) { note('놓을 터미널을 찾지 못했습니다', true); return; }

      var files = filesFrom(e.dataTransfer);
      if (files.length) { sendFiles(v, files); return; }

      var url = urlFrom(e.dataTransfer);
      if (url) { sendUrl(v, url); return; }
      note('여기서 가져올 수 있는 파일이 없습니다', true);
    });

    // 오버레이가 남지 않게 끝나는 모든 길목에서 걷어낸다
    document.addEventListener('dragleave', function (e) {
      // 창 밖으로 나갔을 때만 (relatedTarget 이 없다)
      if (!e.relatedTarget) clearDrag();
    });
    document.addEventListener('dragend', clearDrag);
    window.addEventListener('blur', clearDrag);
    document.addEventListener('mouseup', clearDrag);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') clearDrag();
    });
  }

  // 웹페이지에서 끌어온 이미지 주소를 서버가 내려받아 저장한다
  function sendUrl(v, url) {
    note('이미지를 받는 중…');
    post('/api/paste-url', { url: url }).then(function (j) {
      if (j.error) { note('받기 실패: ' + j.error, true); return; }
      sendMsg(v, { t: 'i', d: quoteIfNeeded(j.path) + ' ' });
      try { v.term.focus(); } catch (e) {}
      note('경로를 넣었습니다 · ' + humanSize(j.bytes));
    }, function (e) { note('받기 실패: ' + e.message, true); });
  }

  // 들어오는 출력을 한 프레임에 한 번만 써 넣는다.
  //
  // Codex TUI 는 한 프레임을 작은 덩어리 여러 개로 흘려보낸다. 덩어리마다 write()
  // 하면 xterm 이 반쯤 그려진 화면을 그대로 렌더해서 입력 줄이 번쩍인다.
  // 한 프레임치를 모아 한 번에 쓰면 완성된 화면만 그려진다.
  var OUT_MAX = 256 * 1024;   // 이만큼 쌓이면 프레임을 기다리지 않고 넘긴다

  function markNavigation(v) {
    v.replayScroll = null;
    v.scrollEpoch = (v.scrollEpoch || 0) + 1;
  }

  function flushLive(v) {
    if (v.outRaf) { cancelAnimationFrame(v.outRaf); v.outRaf = 0; }
    var chunk = (v.outQ || []).join('');
    v.outQ = []; v.outLen = 0;
    if (!chunk || !views.has(v.info.id)) return;

    // 쓰기 **전에** 하단에 있었는지 본다. 쓰고 나면 baseY 가 이미 움직여서 늦는다.
    var b = v.term.buffer.active;
    var wasAtBottom = b.viewportY >= b.baseY;
    var scrollEpoch = v.scrollEpoch || 0;
    try {
      v.term.write(chunk, function () {
        // 출력이 들어오면 화면을 하단에 붙여 둔다. 이게 없으면 새 내용이 아래에
        // 쌓이는 동안 보이는 곳은 그대로라, 화면이 계속 위로 흘러가는 것처럼 보인다.
        // 위로 올려 옛 내용을 보고 있던 사람은 끌어내리지 않는다.
        if (wasAtBottom && (v.scrollEpoch || 0) === scrollEpoch) {
          try { v.term.scrollToBottom(); } catch (e) {}
        }
      });
    } catch (e) {}
  }

  function writeLive(v, d) {
    (v.outQ || (v.outQ = [])).push(d);
    v.outLen = (v.outLen || 0) + d.length;
    // 다른 탭을 보고 있으면 requestAnimationFrame 이 돌지 않는다. 그대로 두면
    // 큐가 무한정 자란다. 일정량 넘으면 프레임을 기다리지 않고 바로 써 넣는다
    // (xterm 이 내부에서 버퍼링하므로 화면이 안 보여도 안전하다).
    if (v.outLen > OUT_MAX) { flushLive(v); return; }
    if (v.outRaf) return;
    v.outRaf = requestAnimationFrame(function () { v.outRaf = 0; flushLive(v); });
  }

  // 대기 중인 출력을 버린다 (PTY 교체·재접속·패인 제거처럼 화면이 갈릴 때).
  function dropPending(v) {
    if (v.outRaf) { cancelAnimationFrame(v.outRaf); v.outRaf = 0; }
    v.outQ = []; v.outLen = 0;
  }

  // 스크롤백 복원이 끝나면 화면을 다시 보여준다. 어떤 경로로 끝나든 반드시 벗긴다 -
  // 여기서 빠지면 패인이 빈 화면으로 남는다.
  function endReplay(v) {
    if (v.replayTimer) { clearTimeout(v.replayTimer); v.replayTimer = 0; }
    if (v.body) v.body.classList.remove('replaying');
  }

  function writeOutput(v, m, ws) {
    if (!m.replay) { writeLive(v, m.d); return; }
    var token = {};
    v.replayScroll = token;
    // 스크롤백(최대 512KB)을 그대로 써 넣으면 xterm 이 처음부터 순서대로 그려서,
    // 첫 화면부터 아래로 주르륵 스크롤하는 게 그대로 보인다. 다 쓸 때까지 감춘다.
    // display:none 이 아니라 visibility 여야 레이아웃이 남아 fit() 이 제대로 된다.
    if (v.body) v.body.classList.add('replaying');
    v.replayTimer = setTimeout(function () { endReplay(v); }, 4000);   // 콜백이 안 와도 풀어준다
    // write() parses asynchronously: scrolling immediately after write() is too early.
    v.term.write(m.d, function () {
      requestAnimationFrame(function () {
        if (v.ws !== ws || v.replayScroll !== token || !views.has(v.info.id)) { endReplay(v); return; }
        v.replayScroll = null;
        fitView(v);
        v.term.scrollToBottom();
        endReplay(v);
      });
    });
  }

  function connect(v) {
    v.replayScroll = null;
    dropPending(v); endReplay(v);   // 옛 소켓의 대기 출력이 새 복원 위에 쏟아지지 않게
    var ws = new WebSocket('ws://' + location.host + '/term?id=' + encodeURIComponent(v.info.id));
    v.ws = ws;
    ws.onmessage = function (ev) {
      if (v.ws !== ws) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'o') {
        writeOutput(v, m, ws);
      } else if (m.t === 'replay') {
        // 이어하기 기록 재생. 서버가 조용해질 때까지 모았다가 한 덩어리로 준다.
        //
        // 이걸 그냥 쓰면 xterm 이 파싱하면서 중간중간 그리기 때문에 화면이 위에서
        // 아래로 쓸려 내려가는 것이 그대로 보인다. 다 쓸 때까지 패인을 가려 둔다.
        // 기록은 스크롤백에 그대로 남으므로 마우스 휠로 되짚을 수 있다.
        dropPending(v);
        v.body.style.visibility = 'hidden';
        try {
          v.term.write(m.d, function () {
            v.body.style.visibility = '';
            try { v.term.scrollToBottom(); } catch (e) {}
          });
        } catch (e) { v.body.style.visibility = ''; }
      } else if (m.t === 'reset') {
        v.replayScroll = null;
        dropPending(v); endReplay(v);      // 옛 PTY 의 대기 출력을 새 화면에 쏟지 않는다
        v.term.reset();                    // 서버가 PTY 를 갈아끼웠다
      } else if (m.t === 'm') {
        // /api/terms가 덧붙인 fav/slug는 PTY 메타데이터에 없으므로 보존한다.
        v.info = Object.assign({}, v.info, m.info); v.alive = m.info.alive;
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

  function refit() { cancelScheduledRefit(); apply(); }

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
    dropPending(v); endReplay(v);
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

  function patch(id, values) {
    var v = views.get(id);
    if (!v) return;
    v.info = Object.assign({}, v.info, values || {});
    paneHead(v);
  }

  window.addEventListener('resize', scheduleRefit);
  initDrop();

  CC.term = {
    init: init, open: open, sync: sync, refit: refit, scheduleRefit: scheduleRefit,
    show: focus, focus: focus, solo: solo,
    setLayout: setLayout, getLayout: getLayout, slots: slots,
    setOrient: setOrient, getOrient: getOrient,
    stop: stop, close: close, drop: drop,
    reload: reload, restart: restart,
    moveTo: moveTo, nudge: nudge, resetSizes: resetSizes,
    list: listLocal, patch: patch, copyId: copyId,
    // 탭 바가 패인 순서를 따라가게 한다
    orderOf: function (id) { var i = order.indexOf(id); return i < 0 ? 9999 : i; },
    // 디버깅·테스트용: 특정 터미널의 xterm 인스턴스
    xterm: function (id) { var v = views.get(id); return v ? v.term : null; },
    get current() { return active; },
    get visibleIds() { return order.slice(0, slots()); },
    has: function (id) { return views.has(id); }
  };
})();
