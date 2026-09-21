// 작업실 - 연결 탭의 도트 캐릭터 뷰.
//
// 그래프는 "무엇이 무엇에 연결됐나" 를 본다. 이건 "지금 누가 뭘 하고 있나" 를 본다.
// 세션 하나가 캐릭터 하나고, 서브에이전트가 뜨면 부모 옆으로 걸어 나와 같이 일한다.
// 일이 끝나면 부모에게 돌아가 사라진다.
//
// 데이터는 이미 있는 것만 쓴다 - 새로 수집하지 않는다.
//   /api/events/timeline  spans(도는 툴) · agents(도는 서브에이전트)
//   CC.harness.graph      세션 이름 · provider · 상태
//
// 에셋 파일을 두지 않는다. 이 프로젝트는 새 의존성을 금지하고, 스프라이트 PNG 를
// 얹으면 경로·캐시·해상도를 따로 관리해야 한다. 그래서 **코드로 도트를 찍고**
// imageSmoothingEnabled=false + 정수 배율로 키운다. 진짜 픽셀아트처럼 각이 산다.
(function () {
  'use strict';
  var CC = window.CC || (window.CC = {});

  // ---------------------------------------------------------------- 스프라이트
  //
  // 문자 한 칸 = 픽셀 한 칸. 팔레트 키로 색을 고른다.
  //   .  비움    k 윤곽    s 피부    a 강조(provider 색)    d 그늘    w 하이라이트
  var W = 12, H = 14;

  // 팔 내린 자세 / 올린 자세 두 장. 위아래 흔들림(bob)은 그릴 때 y 를 1 옮겨서 낸다 -
  // 프레임을 더 두는 것보다 데이터가 적고, 도트 느낌은 똑같이 난다.
  var BODY_DOWN = [
    '....kkkk....',
    '...kaaaak...',
    '..kaaaaaak..',
    '..kssssssk..',
    '..ksbssbsk..',
    '..kssssssk..',
    '...kssssk...',
    '...aaaaaa...',
    '..aaaaaaaa..',
    '.saaaaaaaas.',
    '..aaaaaaaa..',
    '..addddda...',
    '...kk..kk...',
    '...kk..kk...',
  ];
  var BODY_UP = [
    '....kkkk....',
    '...kaaaak...',
    '..kaaaaaak..',
    '..kssssssk..',
    '..ksbssbsk..',
    '..kssssssk..',
    '...kssssk...',
    '.s.aaaaaa.s.',
    '.saaaaaaaas.',
    '..aaaaaaaa..',
    '..aaaaaaaa..',
    '..addddda...',
    '...kk..kk...',
    '...kk..kk...',
  ];

  // 도구별 소품 8x8. 무슨 일을 하는지 한눈에 보이게 한다.
  var PROPS = {
    Bash:      ['kkkkkkkk','kdddddddk'.slice(0,8),'kdwddddk','kddwdddk','kdddddddk'.slice(0,8),'kdwwwddk','kdddddddk'.slice(0,8),'kkkkkkkk'],
    Read:      ['..kkkk..','.kwwwwk.','kwddddwk','kwddddwk','kwddddwk','kwddddwk','.kwwwwk.','..kkkk..'],
    Edit:      ['......kk','.....kwk','....kwk.','...kwk..','..kwk...','.kwk....','kdk.....','kk......'],
    Write:     ['......kk','.....kwk','....kwk.','...kwk..','..kwk...','.kwk....','kdk.....','kk......'],
    Grep:      ['.kkkk...','k.wwk...','k.wwk...','.kkkk...','...kk...','....kk..','.....kk.','......kk'],
    Glob:      ['.kkkk...','k.wwk...','k.wwk...','.kkkk...','...kk...','....kk..','.....kk.','......kk'],
    WebFetch:  ['..kkkk..','.kwwwwk.','kwkwwkwk','kwwkkwwk','kwwkkwwk','kwkwwkwk','.kwwwwk.','..kkkk..'],
    WebSearch: ['..kkkk..','.kwwwwk.','kwkwwkwk','kwwkkwwk','kwwkkwwk','kwkwwkwk','.kwwwwk.','..kkkk..'],
    Task:      ['..kkkk..','.kaaaak.','kaawwaak','kaawwaak','kaaaaaak','.kaaaak.','..k..k..','..k..k..'],
    _default:  ['..kkkk..','.kdaadk.','kdaaaadk','kaawwaak','kaawwaak','kdaaaadk','.kdaadk.','..kkkk..'],
  };

  function propFor(tool) { return PROPS[tool] || PROPS._default; }

  // mcp__playwright__browser_take_screenshot 같은 이름은 화면을 넘긴다. 뒤쪽만 남긴다.
  function shortTool(t) {
    var s = String(t || '');
    var m = /^mcp__[^_]+__(.+)$/.exec(s);
    if (m) s = m[1];
    return s.length > 18 ? s.slice(0, 17) + '…' : s;
  }

  // provider 별 강조색. Codex 는 청록, Claude 는 주황 계열 - 한눈에 갈린다.
  var SKIN = { claude: '#f2c28b', codex: '#f2c28b' };
  var ACCENT = { claude: '#d97757', codex: '#4db6ac' };
  var ACCENT_SUB = '#9b8cf0';   // 서브에이전트는 보라. 부모와 섞이지 않게.

  function palette(kind, provider) {
    var accent = kind === 'sub' ? ACCENT_SUB : (ACCENT[provider] || ACCENT.claude);
    return {
      '.': null,
      k: '#241f2b',
      s: SKIN[provider] || SKIN.claude,
      b: '#241f2b',
      a: accent,
      d: shade(accent, -28),
      w: '#f5f2ea',
    };
  }

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt));
    var g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    var b = Math.max(0, Math.min(255, (n & 255) + amt));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  // 1픽셀 = px 칸. 정수 배율이어야 각이 산다.
  function blit(ctx, rows, pal, x, y, px) {
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      for (var c = 0; c < row.length; c++) {
        var color = pal[row[c]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x + c * px, y + r * px, px, px);
      }
    }
  }

  // ---------------------------------------------------------------- 상태
  var host = null, canvas = null, ctx = null, raf = 0, timer = 0;
  var actors = [];          // 화면에 있는 캐릭터
  var byKey = {};
  var t0 = Date.now();

  function key(a) { return a.kind + ':' + a.id; }

  // timeline + graph 를 캐릭터 목록으로 바꾼다.
  function build(tl, graph) {
    var now = Date.now();
    var sessions = {};
    (graph && graph.nodes || []).forEach(function (n) {
      if (n.kind === 'session' && n.live) sessions[n.sessionId] = n;
    });

    var running = {};   // 세션별로 지금 도는 툴
    (tl && tl.spans || []).forEach(function (s) {
      if (s.t1) return;                       // 끝난 건 제외
      if (s.agentId) running['a:' + s.agentId] = s.tool;
      else running['s:' + s.sess] = s.tool;
    });

    var want = [];
    Object.keys(sessions).forEach(function (sid) {
      var n = sessions[sid];
      want.push({
        kind: 'sess', id: sid, provider: n.provider || 'claude',
        label: (n.label || sid).slice(0, 22),
        busy: n.status === 'busy', tool: running['s:' + sid] || null,
        parent: null,
      });
    });
    (tl && tl.agents || []).forEach(function (a) {
      if (a.t1) return;                       // 끝난 서브에이전트는 빠진다
      if (!sessions[a.sess]) return;          // 부모가 안 보이면 띄우지 않는다
      want.push({
        kind: 'sub', id: a.id, provider: 'claude',
        label: (a.type || 'agent').slice(0, 18),
        busy: true, tool: running['a:' + a.id] || 'Task',
        parent: a.sess, since: a.t0 || now,
      });
    });
    return want;
  }

  // 새로 온 건 팝업으로 등장시키고, 사라진 건 바로 지우지 않고 퇴장시킨다.
  // 딱딱 나타났다 없어지면 "같이 일한다" 는 느낌이 안 난다.
  function sync(want) {
    var now = Date.now();
    var seen = {};
    want.forEach(function (w) {
      var k = w.kind + ':' + w.id;
      seen[k] = true;
      var cur = byKey[k];
      if (!cur) {
        cur = byKey[k] = { born: now, x: 0, y: 0, leaving: 0 };
        actors.push(cur);
      }
      cur.data = w;
      cur.leaving = 0;
    });
    actors.forEach(function (a) {
      var k = a.data && (a.data.kind + ':' + a.data.id);
      if (k && !seen[k] && !a.leaving) a.leaving = now;
    });
    actors = actors.filter(function (a) {
      if (!a.leaving) return true;
      if (now - a.leaving < 900) return true;      // 퇴장 연출 시간
      var k = a.data && (a.data.kind + ':' + a.data.id);
      if (k) delete byKey[k];
      return false;
    });
  }

  // ---------------------------------------------------------------- 그리기
  var PX = 4;                       // 세션 캐릭터 픽셀 배율 (서브는 3)
  var SUB_PX = 3;
  var DESK_W = 168, DESK_H = 108;

  function layout(width) {
    var cols = Math.max(1, Math.floor(width / DESK_W));
    var parents = actors.filter(function (a) { return a.data && a.data.kind === 'sess'; });
    parents.forEach(function (a, i) {
      a.col = i % cols; a.row = Math.floor(i / cols);
      a.hx = 16 + a.col * DESK_W;
      a.hy = 26 + a.row * DESK_H;
    });
    // 서브에이전트는 부모 옆에 선다. 여럿이면 가로로 늘어선다.
    var used = {};
    actors.filter(function (a) { return a.data && a.data.kind === 'sub'; }).forEach(function (a) {
      var p = byKey['sess:' + a.data.parent];
      if (!p || p.hx == null) { a.hx = null; return; }
      var n = used[a.data.parent] = (used[a.data.parent] || 0) + 1;
      a.hx = p.hx + W * PX + 26 + (n - 1) * (W * SUB_PX + 22);   // 부모 소품 자리를 비켜난다
      a.hy = p.hy + 6;
      a.parentAt = { x: p.hx, y: p.hy };
    });
    return Math.max(1, Math.ceil(parents.length / cols)) * DESK_H + 24;
  }

  function draw() {
    if (!ctx || !canvas) return;
    var t = (Date.now() - t0) / 1000;
    var w = canvas.width / (window.devicePixelRatio || 1);
    var h = canvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, w, h);

    actors.forEach(function (a) {
      if (a.hx == null || !a.data) return;
      var d = a.data;
      var age = (Date.now() - a.born) / 1000;
      var appear = Math.min(1, age / 0.25);                 // 등장
      var gone = a.leaving ? Math.min(1, (Date.now() - a.leaving) / 0.9 / 1000) : 0;
      var alpha = appear * (1 - gone);
      if (alpha <= 0.01) return;

      // 작업 중이면 빠르게, 쉬면 느리게 흔든다. 이 차이만으로 바쁜 게 보인다.
      var speed = d.busy ? 6 : 2;
      var bob = Math.floor(Math.abs(Math.sin(t * speed + a.hx)) * 2);
      var armUp = d.busy && Math.floor(t * speed) % 2 === 0;

      ctx.save();
      ctx.globalAlpha = alpha;

      // 부모와 이어진 실. 같이 일하고 있다는 표시.
      if (d.kind === 'sub' && a.parentAt) {
        ctx.strokeStyle = 'rgba(155,140,240,.55)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(a.parentAt.x + W * PX / 2, a.parentAt.y + 30);
        ctx.lineTo(a.hx + W * PX / 2, a.hy + 26);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      var px = d.kind === 'sub' ? SUB_PX : PX;   // 서브에이전트는 조금 작게
      var pal = palette(d.kind === 'sub' ? 'sub' : 'main', d.provider);
      var y = a.hy + bob + Math.round(gone * 10);

      // 발밑 바닥선. 이게 없으면 캐릭터가 허공에 뜬 것처럼 보인다.
      var floorY = a.hy + H * px + 3;
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      ctx.fillRect(a.hx - 2, floorY, W * px + 4, 2);
      blit(ctx, armUp ? BODY_UP : BODY_DOWN, pal, a.hx, y, px);

      // 지금 쓰는 도구를 소품으로
      if (d.tool) {
        blit(ctx, propFor(d.tool), pal, a.hx + W * px + 4, y + 6, px - 1);
      }

      // 이름표. 서브에이전트는 **머리 위**에 붙인다 - 부모 이름표와 같은 줄에 두면 겹친다.
      ctx.globalAlpha = alpha * 0.9;
      ctx.font = '10px ui-monospace, Consolas, monospace';
      if (d.kind === 'sub') {
        ctx.fillStyle = '#b9aef5';
        ctx.fillText(d.label, a.hx - 2, y - 4);
      } else {
        ctx.fillStyle = '#cfc9c0';
        ctx.fillText(d.label, a.hx, y + H * px + 16);
        if (d.tool) {
          ctx.fillStyle = '#8f8a82';
          ctx.fillText(shortTool(d.tool), a.hx, y + H * px + 27);
        }
      }
      ctx.restore();
    });

    raf = requestAnimationFrame(draw);
  }

  function fit() {
    if (!canvas || !host) return;
    var dpr = window.devicePixelRatio || 1;
    var w = host.clientWidth || 600;
    var need = layout(w);
    canvas.style.width = w + 'px';
    canvas.style.height = need + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(need * dpr);
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;     // 이게 없으면 도트가 뭉갠다
  }

  function refresh() {
    fetch('/api/events/timeline').then(function (r) { return r.json(); }).then(function (tl) {
      sync(build(tl, CC.harness && CC.harness.graph));
      fit();
      var n = actors.filter(function (a) { return !a.leaving; }).length;
      var note = host && host.parentNode && host.parentNode.querySelector('.wsnote');
      if (note) {
        note.textContent = n ? ('' + n + '명이 일하는 중') :
          '지금 도는 세션이 없습니다. 세션이 시작되면 여기 나타납니다.';
      }
    }).catch(function () {});
  }

  function mount(el) {
    host = el;
    el.innerHTML = '<canvas class="wscanvas"></canvas>';
    canvas = el.querySelector('canvas');
    fit();
    refresh();
    stopTimers();
    timer = setInterval(refresh, 1500);
    raf = requestAnimationFrame(draw);
    window.addEventListener('resize', fit);
  }

  function stopTimers() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (timer) { clearInterval(timer); timer = 0; }
  }

  function stop() {
    stopTimers();
    window.removeEventListener('resize', fit);
    host = null; canvas = null; ctx = null;
    actors = []; byKey = {};
  }

  CC.workshop = { mount: mount, stop: stop, refresh: refresh };
})();
