// 실시간 훅 이벤트 스트림(SSE) 수신 + 활동 피드 + 그래프 노드 실시간 갱신.
//
// Claude Code 의 http 훅이 서버로 POST 하고, 서버가 SSE 로 여기로 흘려보낸다.
// 훅이 설치돼 있지 않으면 스트림은 조용하고, 설치 안내 배너가 뜬다.
(function () {
  var CC = window.CC || (window.CC = {});
  var esc = window.escHtml;

  var LIVE = {};          // sessionId -> 파생 상태
  var FEED = [];          // 최근 이벤트 (최신이 앞)
  var MAX_FEED = 150;
  var es = null;
  var hookStatus = null;
  var onUpdate = null;
  var connected = false;

  // 이벤트별 표시 이름 / 색 분류
  var EV = {
    SessionStart:      { ko: '세션 시작',    cls: 'e-life' },
    SessionEnd:        { ko: '세션 종료',    cls: 'e-life' },
    UserPromptSubmit:  { ko: '프롬프트',     cls: 'e-user' },
    PreToolUse:        { ko: '툴 시작',      cls: 'e-tool' },
    PostToolUse:       { ko: '툴 완료',      cls: 'e-tool2' },
    PostToolUseFailure:{ ko: '툴 실패',      cls: 'e-fail' },
    SubagentStart:     { ko: '에이전트 시작', cls: 'e-agent' },
    SubagentStop:      { ko: '에이전트 종료', cls: 'e-agent2' },
    Stop:              { ko: '응답 완료',    cls: 'e-life' },
    StopFailure:       { ko: '응답 실패',    cls: 'e-fail' },
    Notification:      { ko: '알림',        cls: 'e-note' },
    PreCompact:        { ko: '압축 시작',    cls: 'e-note' },
    PostCompact:       { ko: '압축 완료',    cls: 'e-note' },
  };

  var PHASE = {
    idle:     { ko: '대기 중',   cls: 'idle' },
    thinking: { ko: '생각 중',   cls: 'busy' },
    tool:     { ko: '툴 실행 중', cls: 'busy' },
    waiting:  { ko: '승인 대기',  cls: 'wait' },
    ended:    { ko: '종료됨',    cls: '' },
  };

  function connect() {
    if (es) { try { es.close(); } catch (e) {} }
    es = new EventSource('/api/events');

    es.addEventListener('open', function () { connected = true; if (onUpdate) onUpdate(); });

    es.addEventListener('snapshot', function (m) {
      try {
        var d = JSON.parse(m.data);
        LIVE = d.live || {};
        FEED = (d.events || []).slice().reverse();
        connected = true;
        if (onUpdate) onUpdate();
      } catch (e) {}
    });

    es.addEventListener('event', function (m) {
      try {
        var ev = JSON.parse(m.data);
        FEED.unshift(ev);
        if (FEED.length > MAX_FEED) FEED.pop();
        applyToLive(ev);
        if (onUpdate) onUpdate(ev);
      } catch (e) {}
    });

    es.onerror = function () {
      connected = false;
      if (onUpdate) onUpdate();
      // EventSource 는 스스로 재접속한다. 서버가 죽었으면 계속 재시도.
    };
  }

  // 서버의 파생 상태를 매번 다시 받지 않고, 들어온 이벤트로 화면 쪽 상태를 갱신한다
  function applyToLive(ev) {
    if (!ev.sessionId) return;
    var s = LIVE[ev.sessionId] || (LIVE[ev.sessionId] = {
      phase: 'idle', tools: [], agents: [], toolCount: 0, agentCount: 0, cwd: ev.cwd
    });
    if (ev.cwd) s.cwd = ev.cwd;
    s.updatedAt = ev.at;

    switch (ev.event) {
      case 'SessionStart': s.phase = 'idle'; s.tools = []; s.agents = []; break;
      case 'SessionEnd':   s.phase = 'ended'; s.tools = []; s.agents = []; break;
      case 'UserPromptSubmit': s.phase = 'thinking'; s.lastPrompt = ev.text; break;
      case 'PreToolUse':
        s.phase = 'tool'; s.toolCount = (s.toolCount || 0) + 1; s.lastTool = ev.tool;
        s.tools = s.tools.concat([{ id: ev.toolUseId, name: ev.tool, summary: ev.text }]);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        s.tools = s.tools.filter(function (t) { return t.id !== ev.toolUseId; });
        if (!s.tools.length && s.phase === 'tool') s.phase = 'thinking';
        break;
      case 'SubagentStart':
        s.agentCount = (s.agentCount || 0) + 1;
        s.agents = s.agents.concat([{ id: ev.agentId, type: ev.agentType }]);
        break;
      case 'SubagentStop':
        s.agents = s.agents.filter(function (a) { return a.id !== ev.agentId; });
        break;
      case 'Stop':
      case 'StopFailure': s.phase = 'idle'; s.tools = []; break;
      case 'Notification':
        if (ev.text === 'permission_prompt') s.phase = 'waiting';
        break;
    }
  }

  // ------------------------------------------------------------ 렌더

  function hhmmss(ms) {
    var d = new Date(ms), p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function projOf(cwd) {
    var parts = String(cwd || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  // 훅 설치 배너
  function renderBanner() {
    var h = hookStatus;
    if (!h) return '';
    var on = h.installed && h.installed.length;
    if (!on) {
      return '<div class="hookbar off">'
        + '<div><b>실시간 관측이 꺼져 있습니다.</b> 훅을 설치하면 세션이 지금 무슨 툴을 돌리는지,'
        + ' 서브에이전트가 언제 뜨고 끝나는지 이 화면에서 바로 보입니다.</div>'
        + '<div class="hbtns">'
        +   '<button class="btn primary xs" data-hookinstall="lifecycle">설치 (세션·에이전트)</button>'
        +   '<button class="btn xs" data-hookinstall="full">설치 (툴까지 전부)</button>'
        + '</div>'
        + '<div class="hnote">'
        +   '<code>' + esc(h.file) + '</code> 의 <code>hooks</code> 에 <code>type:"http"</code> 항목을 넣습니다.'
        +   ' 프로세스를 띄우지 않고 이 서버로 바로 POST 하는 방식이라 이벤트당 ~8ms 입니다.'
        +   ' 쓰기 전에 타임스탬프 백업을 만들고, 넣은 항목만 나중에 지웁니다.'
        +   ' <b>훅은 새로 시작하는 세션부터 적용됩니다.</b>'
        + '</div></div>';
    }
    return '<div class="hookbar on">'
      + '<div><span class="st ' + (connected ? 'busy' : '') + '"></span>'
      +   '<b>실시간 관측 ' + (connected ? '연결됨' : '연결 끊김 - 재시도 중') + '</b>'
      +   ' · ' + h.installed.length + '개 이벤트 (' + (h.mode === 'full' ? '툴까지 전부' : '세션·에이전트') + ')</div>'
      + '<div class="hbtns">'
      +   (h.mode === 'full'
            ? '<button class="btn xs" data-hookinstall="lifecycle">툴 추적 끄기</button>'
            : '<button class="btn xs" data-hookinstall="full">툴까지 추적</button>')
      +   '<button class="btn ghost xs" data-hookuninstall="1">관측 끄기</button>'
      + '</div>'
      + '<div class="hnote">' + esc(h.installed.join(', ')) + '</div>'
      + '</div>';
  }

  // 실시간 활동 피드
  function renderFeed() {
    if (!FEED.length) {
      return '<div class="feedempty">'
        + (hookStatus && hookStatus.installed.length
            ? '아직 이벤트가 없습니다.<br>훅은 <b>새로 시작하는 세션</b>부터 붙습니다 —<br>세션을 새로 열거나 이어하기를 눌러보세요.'
            : '훅을 설치하면 여기에 활동이 실시간으로 흐릅니다.')
        + '</div>';
    }
    return FEED.map(function (ev) {
      var meta = EV[ev.event] || { ko: ev.event, cls: '' };
      var proj = projOf(ev.cwd);
      return '<div class="fe ' + meta.cls + '"' + (ev.sessionId ? ' data-fsess="' + esc(ev.sessionId) + '"' : '') + '>'
        + '<span class="ft">' + hhmmss(ev.at) + '</span>'
        + '<span class="fk">' + esc(meta.ko) + '</span>'
        // 에이전트 이벤트는 text 가 agentType 과 같으므로 한 번만 쓴다
        + '<span class="fb">'
        +   (ev.tool ? '<b>' + esc(ev.tool) + '</b> ' : '')
        +   (ev.agentType ? '<b>' + esc(ev.agentType) + '</b>' : '')
        +   (ev.text && ev.text !== ev.agentType ? esc(ev.text) : '')
        + '</span>'
        + (proj ? '<span class="fp">' + esc(proj) + '</span>' : '')
        + '</div>';
    }).join('');
  }

  // 그래프 노드 위에 덧씌울 실시간 정보 (harness-ui 가 세션 노드를 그릴 때 쓴다)
  function liveFor(sessionId) { return LIVE[sessionId] || null; }
  function phaseLabel(p) { return (PHASE[p] || { ko: p }).ko; }
  function phaseClass(p) { return (PHASE[p] || { cls: '' }).cls; }

  function activeCount() {
    var n = 0;
    for (var k in LIVE) if (LIVE[k].phase !== 'idle' && LIVE[k].phase !== 'ended') n++;
    return n;
  }
  function agentCount() {
    var n = 0;
    for (var k in LIVE) n += (LIVE[k].agents || []).length;
    return n;
  }

  // ------------------------------------------------------------ 훅 설치

  function loadStatus() {
    return fetch('/api/hooks/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { hookStatus = j; return j; })
      .catch(function () { hookStatus = null; });
  }

  function install(mode) {
    return fetch('/api/hooks/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: mode })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      return loadStatus().then(function () { return j; });
    });
  }
  function uninstall() {
    return fetch('/api/hooks/uninstall', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      return loadStatus().then(function () { return j; });
    });
  }

  CC.live = {
    connect: connect, loadStatus: loadStatus, install: install, uninstall: uninstall,
    renderBanner: renderBanner, renderFeed: renderFeed,
    liveFor: liveFor, phaseLabel: phaseLabel, phaseClass: phaseClass,
    activeCount: activeCount, agentCount: agentCount,
    set onUpdate(fn) { onUpdate = fn; },
    get connected() { return connected; },
    get status() { return hookStatus; },
    get feed() { return FEED; },
    get live() { return LIVE; }
  };
})();
