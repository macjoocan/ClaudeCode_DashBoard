// 실황 탭: 세션·서브에이전트가 무엇을 언제 했는지 워터폴 타임라인으로 그린다.
//
// 레인 구조 (훅의 agent_id 로 정확히 갈라진다):
//   세션(부모)                       ← agent_id 없는 툴 호출
//     └ 서브에이전트 Explore …       ← agent_id 붙은 툴 호출
//
// 겹치는 툴(병렬 호출)은 레인 안에서 서브행으로 쌓는다.
// 진행 중인 구간은 오른쪽 끝(now)까지 늘어나며 깜빡인다.
(function () {
  var CC = window.CC || (window.CC = {});
  var esc = window.escHtml;

  var DATA = null;
  var WINDOW = Number(localStorage.getItem('ccl.tlwin') || 120000);  // 보이는 시간 폭
  var PAUSED = false;
  var host = null;
  var raf = null;
  var lastFetch = 0;

  // 툴 종류별 색 (읽기/쓰기/실행/에이전트/기타)
  var TOOL_CLS = {
    Bash: 'run', PowerShell: 'run', Read: 'read', Glob: 'read', Grep: 'read',
    Edit: 'write', Write: 'write', NotebookEdit: 'write',
    Agent: 'agent', Task: 'agent', Skill: 'skill',
    WebFetch: 'net', WebSearch: 'net', Artifact: 'net',
  };
  function toolCls(t) {
    if (!t) return 'etc';
    if (TOOL_CLS[t]) return TOOL_CLS[t];
    if (t.indexOf('mcp__') === 0) return 'mcp';
    return 'etc';
  }

  function init(el) { host = el; }

  function setWindow(ms) {
    WINDOW = ms;
    localStorage.setItem('ccl.tlwin', String(ms));
    load(true);
  }

  function load(force) {
    if (!host) return Promise.resolve();
    if (!force && Date.now() - lastFetch < 900) return Promise.resolve();
    lastFetch = Date.now();
    return fetch('/api/events/timeline?window=' + WINDOW, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { DATA = j; render(); return j; })
      .catch(function () {});
  }

  // ---------------------------------------------------------------- 레인 만들기

  function buildLanes(d) {
    var lanes = [];          // {key, kind, label, sub, spans:[], rows:[]}
    var byKey = {};

    function lane(key, kind, label, parent, meta) {
      if (byKey[key]) return byKey[key];
      var l = { key: key, kind: kind, label: label, parent: parent || null,
                meta: meta || null, spans: [], rows: [] };
      byKey[key] = l;
      lanes.push(l);
      return l;
    }

    // 세션 레인 먼저 (최근 활동 순)
    var sessOrder = Object.keys(d.sessions).sort(function (a, b) {
      return (d.sessions[b].updatedAt || 0) - (d.sessions[a].updatedAt || 0);
    });
    sessOrder.forEach(function (sid) {
      var s = d.sessions[sid];
      var parts = String(s.cwd || '').split(/[\\/]/).filter(Boolean);
      lane(sid, 'session', parts.length ? parts[parts.length - 1] : sid.slice(0, 8), null, s);
    });

    // 서브에이전트 레인 (부모 밑에 붙인다).
    // 같은 종류가 여러 개 뜨면 이름만으로는 구분이 안 되니 시작 순서로 번호를 붙인다.
    var seen = {};
    d.agents.slice().sort(function (a, b) { return a.t0 - b.t0; }).forEach(function (a) {
      var type = a.type || '에이전트';
      seen[type] = (seen[type] || 0) + 1;
      var same = d.agents.filter(function (x) { return (x.type || '에이전트') === type; }).length;
      lane(a.lane, 'agent', same > 1 ? type + ' #' + seen[type] : type, a.sess, a);
    });
    // agents 목록에 없지만 span 에만 등장하는 에이전트도 레인을 만든다
    d.spans.forEach(function (sp) {
      if (sp.agentId && !byKey[sp.lane]) lane(sp.lane, 'agent', sp.agentType || '에이전트', sp.sess, null);
      if (!byKey[sp.lane]) lane(sp.lane, 'session', String(sp.sess || '').slice(0, 8), null, null);
    });

    d.spans.forEach(function (sp) {
      var l = byKey[sp.lane];
      if (l) l.spans.push(sp);
    });

    // 부모 바로 밑에 자기 에이전트가 오도록 정렬
    var ordered = [];
    lanes.filter(function (l) { return l.kind === 'session'; }).forEach(function (s) {
      ordered.push(s);
      lanes.filter(function (l) { return l.kind === 'agent' && l.parent === s.key; })
        .sort(function (a, b) { return (a.meta ? a.meta.t0 : 0) - (b.meta ? b.meta.t0 : 0); })
        .forEach(function (a) { ordered.push(a); });
    });
    lanes.filter(function (l) { return ordered.indexOf(l) < 0; }).forEach(function (l) { ordered.push(l); });

    // 겹치는 구간을 서브행으로 쌓는다 (구간 패킹)
    var now = d.now;
    ordered.forEach(function (l) {
      l.spans.sort(function (a, b) { return a.t0 - b.t0; });
      l.spans.forEach(function (sp) {
        var end = sp.t1 == null ? now : sp.t1;
        var r = 0;
        while (true) {
          var row = l.rows[r] || (l.rows[r] = []);
          var last = row[row.length - 1];
          var lastEnd = last ? (last.t1 == null ? now : last.t1) : -Infinity;
          if (!last || lastEnd <= sp.t0) { row.push(sp); sp._row = r; break; }
          r++;
          if (r > 12) { row.push(sp); sp._row = 12; break; }   // 안전장치
        }
      });
      if (!l.rows.length) l.rows = [[]];
    });

    return ordered;
  }

  // ---------------------------------------------------------------- 렌더

  var ROW_H = 17, LANE_PAD = 5, LABEL_W = 168;

  function render() {
    if (!host) return;
    if (!DATA) { host.innerHTML = '<div class="empty">불러오는 중&#8230;</div>'; return; }
    var d = DATA;

    var st = CC.live && CC.live.status;
    var installed = st && (
      ((st.claude && st.claude.installed) || []).length ||
      ((st.codex && st.codex.installed) || []).length);
    if (!installed) {
      host.innerHTML = (CC.live ? CC.live.renderBanner() : '')
        + '<div class="empty">훅을 설치하면 여기에 세션과 서브에이전트의 활동이 실시간으로 그려집니다.</div>';
      return;
    }

    var lanes = buildLanes(d);
    var hasTools = lanes.some(function (l) { return l.spans.length; });

    var head = '<div class="tlbar">'
      + '<div class="seg">'
      +   [[30000, '30초'], [120000, '2분'], [600000, '10분'], [1800000, '30분']].map(function (w) {
            return '<button data-tlwin="' + w[0] + '" class="' + (WINDOW === w[0] ? 'on' : '') + '">'
              + w[1] + '</button>';
          }).join('')
      + '</div>'
      + '<button class="btn xs" data-tlpause="1">' + (PAUSED ? '▶ 재생' : '⏸ 멈춤') + '</button>'
      + '<span class="dimtxt">' + (CC.live && CC.live.connected ? '● 실시간' : '○ 끊김')
      +   ' · 이벤트 ' + d.total + '건 · 구간 ' + d.spans.length + '개'
      +   ' · 에이전트 ' + d.agents.length + '개</span>'
      + '<div class="grow"></div>'
      + '<span class="tllegend">'
      +   ['read:읽기', 'write:쓰기', 'run:실행', 'agent:에이전트', 'mcp:MCP', 'net:네트워크', 'etc:기타']
          .map(function (x) { var p = x.split(':');
            return '<i class="sp ' + p[0] + '"></i>' + p[1]; }).join('')
      + '</span></div>';

    if (!hasTools) {
      host.innerHTML = head
        + '<div class="empty">최근 ' + Math.round(WINDOW / 1000) + '초 안에 활동이 없습니다.<br>'
        + '세션에서 뭔가 시키면 여기에 바로 그려집니다.</div>'
        + turnList(d);
      return;
    }

    // 시간축
    var t0 = d.now - WINDOW, t1 = d.now;
    var W = 1000;                                  // viewBox 폭 (CSS 로 늘림)
    var x = function (t) { return Math.max(0, Math.min(W, (t - t0) / WINDOW * W)); };

    var y = 24, laneBoxes = [];
    lanes.forEach(function (l) {
      var h = Math.max(1, l.rows.length) * ROW_H;
      laneBoxes.push({ lane: l, y: y, h: h });
      y += h + LANE_PAD;
    });
    var H = y + 6;

    // 눈금 (5개)
    var ticks = [];
    for (var i = 0; i <= 5; i++) {
      var tt = t0 + WINDOW * i / 5;
      var lx = x(tt);
      var secAgo = Math.round((d.now - tt) / 1000);
      ticks.push('<line class="tlgrid" x1="' + lx + '" y1="14" x2="' + lx + '" y2="' + H + '"/>'
        + '<text class="tltick" x="' + (lx + 3) + '" y="11">'
        + (secAgo === 0 ? '지금' : '-' + secAgo + '초') + '</text>');
    }

    // 레인 배경 + 구간
    var body = [];
    laneBoxes.forEach(function (b) {
      var l = b.lane;
      body.push('<rect class="tllane ' + l.kind + '" x="0" y="' + b.y + '" width="' + W
        + '" height="' + b.h + '"/>');

      l.spans.forEach(function (sp) {
        var end = sp.t1 == null ? d.now : sp.t1;
        var x1 = x(sp.t0), x2 = x(end);
        var w = Math.max(1.6, x2 - x1);            // 아주 짧은 것도 보이게
        var yy = b.y + sp._row * ROW_H + 2;
        var running = sp.t1 == null;
        var ms = sp.dur != null ? sp.dur : (d.now - sp.t0);
        var label = (sp.tool || '') + (ms >= 400 ? ' ' + fmtMs(ms) : '');
        body.push('<g class="tlspan ' + toolCls(sp.tool)
          + (sp.failed ? ' failed' : '') + (running ? ' running' : '')
          + (sp.partial ? ' partial' : '') + '">'
          + '<rect x="' + x1 + '" y="' + yy + '" width="' + w + '" height="' + (ROW_H - 4)
          +   '" rx="2.5"/>'
          + (w > 46 ? '<text x="' + (x1 + 4) + '" y="' + (yy + ROW_H - 8) + '">'
              + esc(cut(label, Math.floor(w / 5.4))) + '</text>' : '')
          + '<title>' + esc((sp.tool || '?') + '  ' + fmtMs(ms) + (running ? ' (진행 중)' : '')
              + (sp.agentType ? '\n에이전트: ' + sp.agentType : '\n부모 세션')
              + (sp.summary ? '\n' + sp.summary : '')
              + (sp.failed ? '\n실패' : '')) + '</title>'
          + '</g>');
      });
    });

    // 서브에이전트 실행 구간을 부모 레인 위에 띠로 표시 (언제 떠 있었는지)
    d.agents.forEach(function (a) {
      var pb = laneBoxes.find(function (b) { return b.lane.key === a.lane; });
      if (!pb) return;
      var end = a.t1 == null ? d.now : a.t1;
      body.push('<rect class="tlagent' + (a.t1 == null ? ' running' : '') + '" x="' + x(a.t0)
        + '" y="' + (pb.y - 3) + '" width="' + Math.max(2, x(end) - x(a.t0)) + '" height="2.5" rx="1"/>');
    });

    // 프롬프트 / 완료 마커
    var markers = [];
    d.turns.forEach(function (t) {
      if (t.t0 >= t0) {
        markers.push('<g class="tlmark prompt"><line x1="' + x(t.t0) + '" y1="14" x2="' + x(t.t0)
          + '" y2="' + H + '"/><title>' + esc('프롬프트: ' + (t.prompt || '(내용 없음)')
          + '\n툴 ' + t.tools + '개 · 에이전트 ' + t.agents + '개'
          + (t.failed ? ' · 실패 ' + t.failed : '')) + '</title></g>');
      }
      if (t.t1 && t.t1 >= t0) {
        markers.push('<g class="tlmark done"><line x1="' + x(t.t1) + '" y1="14" x2="' + x(t.t1)
          + '" y2="' + H + '"/><title>응답 완료</title></g>');
      }
    });

    // 레인 이름표는 SVG 밖 HTML 로 (한글 폭 계산이 정확하다)
    var labels = laneBoxes.map(function (b) {
      var l = b.lane;
      var running = l.kind === 'agent' && l.meta && l.meta.t1 == null;
      var phase = l.kind === 'session' && l.meta ? l.meta.phase : null;
      return '<div class="tllabel ' + l.kind + '" style="top:' + b.y + 'px;height:' + b.h + 'px">'
        + (l.kind === 'agent' ? '<span class="tlbranch">└</span>' : '')
        + '<span class="st ' + (phase === 'tool' || phase === 'thinking' ? 'busy'
            : (phase === 'waiting' ? 'wait' : (running ? 'busy' : (phase ? 'idle' : '')))) + '"></span>'
        + '<span class="tlname" title="' + esc(l.kind === 'session'
            ? (l.meta && l.meta.cwd ? l.meta.cwd : l.key)
            : ((l.meta && l.meta.result) ? l.meta.result : l.label)) + '">' + esc(l.label) + '</span>'
        + '<span class="tlmeta">' + (l.kind === 'session'
            ? (l.meta ? '툴 ' + l.meta.toolCount : '')
            : (l.meta && l.meta.dur != null ? fmtMs(l.meta.dur) : '진행 중')) + '</span>'
        + '</div>';
    }).join('');

    host.innerHTML = head
      + '<div class="tlwrap">'
      +   '<div class="tllabels" style="height:' + H + 'px">' + labels + '</div>'
      +   '<div class="tlchart">'
      +     '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="tlsvg"'
      +       ' style="height:' + H + 'px">'
      +       ticks.join('') + body.join('') + markers.join('')
      +     '</svg>'
      +   '</div>'
      + '</div>'
      + turnList(d);
  }

  // 턴 목록 (프롬프트 → 결과 요약)
  function turnList(d) {
    var ts = d.turns.slice().reverse().slice(0, 8);
    if (!ts.length) return '';
    return '<div class="turns"><div class="turnh">최근 턴</div>'
      + ts.map(function (t) {
          var dur = t.t1 ? fmtMs(t.t1 - t0safe(t)) : fmtMs(d.now - t0safe(t)) + ' (진행 중)';
          return '<div class="turn' + (t.t1 ? '' : ' live') + '">'
            + '<div class="tq">' + esc(t.prompt || '(프롬프트 기록 없음 - 런처를 늦게 켰거나 이어받은 턴)') + '</div>'
            + '<div class="tm">' + dur + ' · 툴 ' + t.tools + '개'
            +   (t.agents ? ' · 서브에이전트 ' + t.agents + '개' : '')
            +   (t.failed ? ' · <b class="bad">실패 ' + t.failed + '</b>' : '')
            + '</div></div>';
        }).join('')
      + '</div>';
  }
  function t0safe(t) { return t.t0 || t.t1 || Date.now(); }

  function cut(s, n) {
    s = String(s == null ? '' : s);
    if (n < 3) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function fmtMs(ms) {
    if (ms == null) return '';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
    return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's';
  }

  // 진행 중인 구간이 자라 보이게 애니메이션 프레임마다 다시 그린다 (멈춤 시 정지)
  function tick() {
    if (!PAUSED && host && !host.hidden && DATA) {
      DATA.now = Date.now();
      render();
    }
    raf = setTimeout(tick, 700);
  }

  function handle(t) {
    if (t.dataset.tlwin) { setWindow(Number(t.dataset.tlwin)); return true; }
    if (t.dataset.tlpause) { PAUSED = !PAUSED; if (!PAUSED) load(true); else render(); return true; }
    return false;
  }

  // 새 이벤트가 오면 즉시 새로 받는다 (구간 시작/끝이 바로 보이게)
  function onEvent() { if (!PAUSED) load(); }

  CC.timeline = {
    init: init, load: load, render: render, handle: handle, onEvent: onEvent,
    start: function () { if (!raf) tick(); },
    get paused() { return PAUSED; }
  };
})();
