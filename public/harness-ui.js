// 구성(하네스) 탭 + 연결 그래프 탭 렌더링.
// 서버의 /api/config, /api/graph 를 그림으로 만든다. 읽기 전용이다.
(function () {
  var CC = window.CC || (window.CC = {});
  var esc = window.escHtml;

  var CFG = null, GRAPH = null, GRAPH_HOST = null;
  var EDGES = {};        // 실시간 신호를 쏠 엣지 인덱스

  // Codex 구성(codex doctor 결과) - 읽기 전용, 버튼을 눌러야 채워진다
  var CODEX_DOCTOR = null;
  var codexLoading = false;

  function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // ------------------------------------------------------------- 구성 탭

  function sec(id, title, count, body, open) {
    return '<details class="hsec" ' + (open ? 'open' : '') + ' data-sec="' + id + '">'
      + '<summary><span class="ht">' + esc(title) + '</span>'
      + (count == null ? '' : '<span class="hn">' + num(count) + '</span>') + '</summary>'
      + '<div class="hbody">' + body + '</div></details>';
  }

  // 값이 길어지면 셀이 폭발하므로 방어적으로 자른다 (전체는 title 로 본다)
  function kv(k, v, cls) {
    var s = v == null ? null : String(v);
    var shown = s == null ? '&mdash;' : esc(s.length > 120 ? s.slice(0, 119) + '…' : s);
    var tip = s && s.length > 120 ? ' title="' + esc(s.slice(0, 800)) + '"' : '';
    return '<div class="kv"><span class="k">' + esc(k) + '</span>'
      + '<span class="v ' + (cls || '') + '"' + tip + '>' + shown + '</span></div>';
  }

  // kv 는 값을 이스케이프한다. 컨트롤(select 등)을 넣을 때는 이걸 쓴다.
  function kvHtml(k, html) {
    return '<div class="kv"><span class="k">' + esc(k) + '</span>'
      + '<span class="v">' + html + '</span></div>';
  }

  function chips(list, cls) {
    if (!list || !list.length) return '<span class="dimtxt">없음</span>';
    return list.map(function (x) { return '<span class="chip ' + (cls || '') + '">' + esc(x) + '</span>'; }).join('');
  }

  // ------------------------------------------------------------- Codex 구성 (읽기 전용)
  //
  // codex doctor --json 은 네트워크 확인까지 해서 수 초가 걸린다. 구성 탭을 열 때
  // 자동으로 부르지 않고, 이 섹션의 "Codex 설정 읽기" 버튼을 눌렀을 때만 부른다
  // (Claude 쪽 MCP 연결 상태 확인과 같은 방침 - config-edit.js 의 mcpCheckBar 참고).

  // codex doctor 의 상태 문자열을 기존 MCP 배지 색(.mh)에 얹는다 (새 CSS 없이 재사용)
  function codexStatusCls(s) {
    s = String(s || '').toLowerCase();
    if (s === 'ok') return 'ok';
    if (s === 'fail' || s === 'error') return 'fail';
    if (s === 'warning' || s === 'warn') return 'auth';   // .mh.auth 가 경고색(주황)
    return 'unk';
  }

  function codexBody() {
    var bar = '<div class="addrow" style="align-items:center">'
      + '<button class="btn xs" id="codexcheck"' + (codexLoading ? ' disabled' : '') + '>'
      +   (codexLoading ? '확인 중… (최대 60초)' : (CODEX_DOCTOR ? '다시 확인' : 'Codex 설정 읽기'))
      + '</button>'
      + '<span class="dimtxt">' + (CODEX_DOCTOR && CODEX_DOCTOR.ok
          ? 'codex ' + esc(CODEX_DOCTOR.version || '?') + ' · 전체 상태 ' + esc(CODEX_DOCTOR.status || '?')
          : '<code>codex doctor --json</code> 로 실제 설정을 확인합니다 (네트워크 확인 포함, 최대 60초)')
      + '</span></div>';

    if (!CODEX_DOCTOR) return bar;

    if (!CODEX_DOCTOR.ok) {
      return bar + '<div class="empty">' + esc(CODEX_DOCTOR.error || '설정을 읽지 못했습니다') + '</div>';
    }

    var list = '<div class="mcplist">' + CODEX_DOCTOR.checks.map(function (c) {
      var details = c.details || {};
      var dkeys = Object.keys(details);
      return '<div class="mcp"><div class="mn">'
        + '<span class="mh ' + codexStatusCls(c.status) + '">' + esc(c.status) + '</span>'
        + esc(c.summary || c.id)
        + '<span class="grow"></span><span class="mt">' + esc(c.category) + '</span></div>'
        + (dkeys.length ? dkeys.map(function (k) { return kv(k, details[k]); }).join('')
                        : '<span class="dimtxt">세부 정보 없음</span>')
        + '</div>';
    }).join('') + '</div>';

    return bar + list;
  }

  function codexSection() {
    var count = (CODEX_DOCTOR && CODEX_DOCTOR.ok) ? CODEX_DOCTOR.checks.length : null;
    return sec('codex', 'Codex', count, codexBody(), openSecs.codex);
  }

  // 버튼 클릭 -> /api/cfg/codex 호출. 로딩 표시는 전체를 다시 그리지 않고
  // 버튼만 직접 바꾼다(느린 호출인데 구성 전체를 다시 불러올 필요는 없다).
  function loadCodexDoctor(host) {
    if (codexLoading) return;
    codexLoading = true;
    var btn = document.getElementById('codexcheck');
    if (btn) { btn.disabled = true; btn.textContent = '확인 중… (최대 60초)'; }
    fetch('/api/cfg/codex', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        codexLoading = false;
        CODEX_DOCTOR = j;
        openSecs.codex = true;
        renderConfig(host);
      })
      .catch(function (e) {
        codexLoading = false;
        CODEX_DOCTOR = { ok: false, error: e.message };
        openSecs.codex = true;
        renderConfig(host);
      });
  }

  // 다시 그려도 펼쳐둔 섹션이 닫히지 않게 열림 상태를 기억한다
  var openSecs = { warn: true };

  function rememberOpen(host) {
    host.querySelectorAll('.hsec').forEach(function (d) { openSecs[d.dataset.sec] = d.open; });
  }

  function renderConfig(host) {
    if (!CFG) { host.innerHTML = '<div class="empty">불러오는 중&#8230;</div>'; return; }
    if (host.querySelector('.hsec')) rememberOpen(host);
    var c = CFG;
    var CE = CC.cfgEdit;
    var out = [];
    if (CE) {
      out.push(CE.toolbar());
      // 어느 파일에 쓸지 (전역 / 프로젝트 공유 / 프로젝트 로컬)
      out.push(CE.scopeBar(c.projectFiles.map(function (pf) {
        var parts = pf.cwd.split(/[\/]/).filter(Boolean);
        return { cwd: pf.cwd, name: parts.length ? parts[parts.length - 1] : pf.cwd };
      }).concat(
        // 설정 파일이 아직 없는 프로젝트도 고를 수 있어야 한다
        Object.keys(c.global.projects).filter(function (p) {
          return c.global.projects[p].exists
            && !c.projectFiles.some(function (pf) { return pf.cwd === p; });
        }).map(function (p) {
          var parts = p.split(/[\/]/).filter(Boolean);
          return { cwd: p, name: (parts.length ? parts[parts.length - 1] : p) + ' (설정 없음)' };
        })
      )));
    }

    // ---- 요약 (편집 모드면 모델/노력 수준을 고를 수 있다)
    var wWarn = c.warnings.filter(function (w) { return w.level === 'warn'; }).length;
    out.push('<div class="hcard wide"><div class="hgrid">'
      + kvHtml('모델', CE ? CE.settingSelect('model', c.user.model,
          ['opus[1m]', 'opus', 'sonnet', 'haiku', 'default']) : esc(c.user.model))
      + kvHtml('노력 수준', CE ? CE.settingSelect('effortLevel', c.user.effortLevel,
          ['low', 'medium', 'high', 'max']) : esc(c.user.effortLevel))
      + kv('자동 모드', c.user.autoMode ? ('설정됨 (' + c.user.autoMode.keys.join(', ') + ')') : '끔')
      + kv('권한 규칙', c.user.permissions.allow.length + ' 허용 / '
          + c.user.permissions.deny.length + ' 거부 / ' + c.user.permissions.ask.length + ' 확인')
      + kv('추가 디렉터리', c.user.permissions.additionalDirectories.length + '개')
      + kv('플러그인', c.plugins.filter(function (p) { return p.enabled === true; }).length
          + ' / ' + c.plugins.length + ' 켜짐')
      + kv('훅', c.hooks.filter(function (h) { return h.active; }).length + ' 동작 / ' + c.hooks.length + ' 등록')
      + kv('스킬 · 에이전트', c.skills.length + ' · ' + c.agents.length)
      + kv('MCP 서버', c.global.mcpServers.length + '개 (전역)')
      + kv('경고', wWarn + ' 주의 / ' + c.warnings.length + ' 건', wWarn ? 'bad' : 'ok')
      + '</div>'
      + '<div class="hsrc">' + esc(c.user.file) + ' · ' + esc(c.global.file) + '</div></div>');

    // ---- 경고
    var byKind = {};
    c.warnings.forEach(function (w) { (byKind[w.kind] = byKind[w.kind] || []).push(w); });
    var kindName = {
      'permission-wildcard': '권한 규칙의 위험한 와일드카드',
      'missing-dir': '없는 디렉터리',
      'untrusted': '신뢰 미승인 프로젝트',
      'skill-shadow': '이름이 겹치는 스킬',
      'disabled-hooks': '꺼진 플러그인의 훅',
      'path-case-dup': '대소문자만 다른 중복 프로젝트 경로',
    };
    var wbody = Object.keys(byKind).map(function (k) {
      var items = byKind[k];
      var lvl = items[0].level;
      return '<div class="warngroup">'
        + '<div class="wh ' + lvl + '">' + esc(kindName[k] || k) + ' <b>' + items.length + '</b></div>'
        + items.slice(0, 40).map(function (w) {
            return '<div class="wi"><code>' + esc(w.detail) + '</code>'
              + '<div class="wt">' + esc(w.text) + '</div></div>';
          }).join('')
        + (items.length > 40 ? '<div class="dimtxt">…그 외 ' + (items.length - 40) + '건</div>' : '')
        + '</div>';
    }).join('');
    // ---- 시각 설정 편집기
    if (CE) out.push(sec('settings', '설정', null, CE.settingsPanel(),
      openSecs.settings !== false));

    out.push(sec('warn', '점검 결과', c.warnings.length, wbody || '<span class="dimtxt">문제 없음</span>', openSecs.warn !== false && wWarn > 0));

    // ---- 훅 (이벤트별)
    var byEvent = {};
    c.hooks.forEach(function (h) { (byEvent[h.event] = byEvent[h.event] || []).push(h); });
    var hbody = Object.keys(byEvent).sort().map(function (ev) {
      return '<div class="hookev"><div class="he">' + esc(ev)
        + '<span class="hn2">' + byEvent[ev].length + '</span></div>'
        + byEvent[ev].map(function (h) {
            return '<div class="hook ' + (h.active ? '' : 'off') + '">'
              + '<span class="hmatch">' + esc(h.matcher) + '</span>'
              + '<div><code>' + esc(h.command) + '</code>'
              + (h.label ? '<div class="hlabel">' + esc(h.label) + '</div>' : '') + '</div>'
              + '<span class="hfrom">' + esc(h.source) + (h.active ? '' : ' · 꺼짐') + '</span>'
              + '</div>';
          }).join('') + '</div>';
    }).join('');
    out.push(sec('hooks', '훅 (자동 실행)', c.hooks.length,
      hbody || '<span class="dimtxt">등록된 훅이 없습니다</span>', openSecs.hooks));

    // ---- MCP 서버
    var mbody = '<div class="mcplist">' + c.global.mcpServers.map(function (m) {
      return '<div class="mcp"><div class="mn">' + esc(m.name)
        + '<span class="mt">' + esc(m.type) + '</span>'
        + (CE ? CE.mcpHealth(m.name) : '')
        + '<span class="grow"></span>'
        + (CE ? CE.mcpActions(m.name) : '') + '</div>'
        + '<code>' + esc([m.command].concat(m.args).filter(Boolean).join(' ')) + '</code>'
        + (m.env.length ? '<div class="dimtxt">env: ' + esc(m.env.join(', ')) + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
    // 프로젝트별로 끈 서버
    var offs = Object.keys(c.global.projects).filter(function (p) {
      return (c.global.projects[p].disabledMcpjson || []).length;
    });
    if (offs.length) {
      mbody += '<div class="subh">프로젝트에서 끈 서버</div>' + offs.map(function (p) {
        return '<div class="kv"><span class="k">' + esc(p) + '</span><span class="v">'
          + chips(c.global.projects[p].disabledMcpjson, 'off') + '</span></div>';
      }).join('');
    }
    if (CE) mbody += CE.mcpCheckBar() + CE.mcpAddForm();
    out.push(sec('mcp', 'MCP 서버', c.global.mcpServers.length, mbody, openSecs.mcp));

    // ---- Codex (읽기 전용 - codex doctor 기반, 버튼을 눌러야 불러온다)
    out.push(codexSection());

    // ---- 플러그인
    var pbody = c.plugins.map(function (p) {
      return '<div class="plug ' + (p.enabled === false ? 'off' : '') + '">'
        + '<div class="pn"><span class="dot2 ' + (p.enabled ? 'on' : '') + '"></span>'
        + esc(p.name) + '<span class="pv">' + esc(p.version || '') + '</span>'
        + (p.enabled === false ? '<span class="chip off">꺼짐</span>' : '')
        + '<span class="grow"></span>' + (CE ? CE.pluginToggle(p) : '') + '</div>'
        + '<div class="pprov">'
        +   (p.hooks.length ? '<span class="chip warnc">훅 ' + p.hooks.length + '</span>' : '')
        +   (p.skills.length ? '<span class="chip">스킬 ' + p.skills.length + '</span>' : '')
        +   (p.agents.length ? '<span class="chip">에이전트 ' + p.agents.length + '</span>' : '')
        +   (p.commands.length ? '<span class="chip">명령 ' + p.commands.length + '</span>' : '')
        +   (p.mcpServers.length ? '<span class="chip">MCP ' + p.mcpServers.length + '</span>' : '')
        + '</div>'
        + (p.dir ? '<div class="hsrc">' + esc(p.dir) + '</div>' : '')
        + '</div>';
    }).join('');
    out.push(sec('plugins', '플러그인', c.plugins.length, '<div class="pluglist">' + pbody + '</div>', openSecs.plugins));

    // ---- 권한
    var risky = {};
    c.warnings.forEach(function (w) { if (w.kind === 'permission-wildcard') risky[w.detail] = true; });
    var abody = '<input class="hfilter" id="permfilter" placeholder="권한 규칙 검색">'
      + '<div class="rules" id="permrules">'
      + c.user.permissions.allow.map(function (r) {
          return '<div class="rule ' + (risky[r] ? 'risky' : '') + '">' + esc(r)
            + (risky[r] ? '<span class="chip warnc">중간 *</span>' : '')
            + (CE ? CE.ruleActions('allow', r) : '') + '</div>';
        }).join('')
      + '</div>'
      + (CE ? CE.addForm('permadd', '허용 규칙 추가 (예: Bash(git status:*) 또는 Read(//c/work/**))', '허용 추가') : '')
      + (c.user.permissions.deny.length ? '<div class="subh">거부</div><div class="rules">'
          + c.user.permissions.deny.map(function (r) { return '<div class="rule deny">' + esc(r) + '</div>'; }).join('')
          + '</div>' : '')
      + '<div class="subh">추가 디렉터리</div><div class="rules">'
      + c.user.permissions.additionalDirectories.map(function (d) {
          return '<div class="rule">' + esc(d)
            + (CE && CE.isEdit() ? '<button class="xdel" data-dirdel="' + esc(d) + '" title="삭제">✕</button>' : '')
            + '</div>'; }).join('')
      + '</div>'
      + (CE ? CE.addForm('diradd', '접근 허용할 폴더 경로 추가', '폴더 추가') : '');
    out.push(sec('perm', '권한 규칙', c.user.permissions.allow.length, abody, openSecs.perm));

    // ---- 스킬 / 에이전트
    var sbody = '<div class="subh">에이전트 ' + c.agents.length + '</div><div class="agl">'
      + c.agents.map(function (a) {
          return '<div class="ag"><div class="an">' + esc(a.name)
            + '<span class="grow"></span>' + (CE ? CE.docActions('agent', a.name, a.source) : '') + '</div>'
            + '<div class="as">' + esc(a.source) + (a.model ? ' · ' + esc(a.model) : '') + '</div>'
            + (a.description ? '<div class="ad">' + esc(a.description) + '</div>' : '') + '</div>';
        }).join('') + '</div>'
      + (CE ? CE.teamForm() : '')
      + (CE ? CE.makeForm('agent') : '')
      + '<div class="subh">스킬 ' + c.skills.length + '</div><div class="skl">'
      + c.skills.map(function (s) {
          var own = String(s.source || '').indexOf('plugin:') !== 0;
          return '<span class="chip ' + (s.pluginEnabled === false ? 'off' : '') + (own ? ' own' : '') + '" title="'
            + esc(s.source + (s.description ? ' — ' + s.description : '')) + '">' + esc(s.name)
            + (CE && CE.isEdit() && own
                ? '<button class="xdel" data-docedit="skill|' + esc(s.dirName || s.name) + '" title="편집">✎</button>'
                  + '<button class="xdel" data-docdel="skill|' + esc(s.dirName || s.name) + '" title="휴지통">✕</button>'
                : '')
            + '</span>';
        }).join('') + '</div>'
      + (CE ? CE.makeForm('skill') : '');
    out.push(sec('skills', '스킬 · 에이전트', c.skills.length + c.agents.length, sbody, openSecs.skills));

    // ---- 프로젝트별 설정 파일
    var fbody = c.projectFiles.map(function (pf) {
      return '<div class="pf"><div class="pfn">' + esc(pf.cwd) + '</div>'
        + pf.files.map(function (f) {
            var label = { settings: '.claude/settings.json', local: '.claude/settings.local.json',
                          mcp: '.mcp.json', claudemd: f.rel }[f.kind] || f.rel;
            return '<div class="pfi" data-openfile="' + esc(f.path) + '" title="VS Code 로 열기">'
              + '<span class="pfk">' + esc(label) + '</span>'
              + '<span class="dimtxt">' + Math.max(1, Math.round(f.size / 1024)) + 'KB'
              + (f.keys && f.keys.length ? ' · ' + esc(f.keys.slice(0, 5).join(', ')) : '') + '</span></div>';
          }).join('') + '</div>';
    }).join('');
    out.push(sec('files', '프로젝트 설정 파일', c.projectFiles.length,
      fbody || '<span class="dimtxt">없음</span>', openSecs.files));

    host.innerHTML = out.join('');

    var pf = document.getElementById('permfilter');
    if (pf) pf.addEventListener('input', function () {
      var q = pf.value.toLowerCase();
      document.querySelectorAll('#permrules .rule').forEach(function (el) {
        el.style.display = el.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
      });
    });

    // Codex 설정 읽기 버튼 - 전역 클릭 위임(index.html)을 타지 않고 여기서 직접 붙인다
    // (이 섹션이 harness-ui.js 안에서 완결되도록 - config-edit.js/index.html 을 건드리지 않는다)
    var cbtn = document.getElementById('codexcheck');
    if (cbtn) cbtn.addEventListener('click', function () { loadCodexDoctor(host); });
  }

  // ------------------------------------------------------------- 그래프 탭

  var LAY = { colP: 20, colS: 300, colA: 700, rowH: 30, top: 56, boxP: 250, boxS: 360, boxA: 190 };

  // 실행 중인 세션만 볼지. 세션이 쌓이면 노드가 수십 개라 신호가 묻힌다.
  var LIVEONLY = localStorage.getItem('ccl.gliveonly') === '1';

  // 작업실(도트 캐릭터) 표시 여부. 그래프를 없애지 않고 위에 얹는다 -
  // "무엇이 연결됐나"(그래프)와 "지금 누가 뭘 하나"(작업실)는 다른 질문이다.
  var ROOM = localStorage.getItem('ccl.groom') === '1';

  function renderGraph(host) {
    if (!GRAPH) { host.innerHTML = '<div class="empty">불러오는 중&#8230;</div>'; return; }
    var g = GRAPH;

    // 걸러낼 때는 노드와 엣지를 같이 걸러야 한다. 엣지만 남으면 허공을 가리킨다.
    if (LIVEONLY) {
      var keep = {};
      g.nodes.forEach(function (n) {
        if (n.kind !== 'session' || n.live) keep[n.id] = 1;
      });
      // nodes/edges 만 담은 새 객체로 바꾸면 mcpGlobal 같은 다른 필드가 날아간다.
      // 원본을 얕게 복사하고 두 배열만 갈아끼운다.
      var filtered = {};
      Object.keys(g).forEach(function (k) { filtered[k] = g[k]; });
      filtered.nodes = g.nodes.filter(function (n) { return keep[n.id]; });
      filtered.edges = g.edges.filter(function (e) { return keep[e.from] && keep[e.to]; });
      g = filtered;
    }

    var projects = g.nodes.filter(function (n) { return n.kind === 'project'; });
    var sessions = g.nodes.filter(function (n) { return n.kind === 'session'; });
    var agents = g.nodes.filter(function (n) { return n.kind === 'subagent'; });
    var sessByProj = {};
    g.edges.filter(function (e) { return e.kind === 'session'; })
      .forEach(function (e) { (sessByProj[e.from] = sessByProj[e.from] || []).push(e.to); });

    // 세션이 있는 프로젝트만, 실행 중인 것 우선
    var shown = projects.filter(function (p) { return (sessByProj['p:' + p.cwd.toLowerCase()] || sessByProj[p.id] || []).length; });
    shown.sort(function (a, b) { return (b.live - a.live) || (b.sessions - a.sessions); });

    var byId = {};
    g.nodes.forEach(function (n) { byId[n.id] = n; });

    // y 좌표 배치
    var y = LAY.top, pos = {};
    shown.forEach(function (p) {
      var kids = (sessByProj[p.id] || []);
      var y0 = y;
      kids.forEach(function (sid) { pos[sid] = y; y += LAY.rowH; });
      pos[p.id] = kids.length ? (y0 + (y - LAY.rowH - y0) / 2) : y0;
      y += 10;   // 프로젝트 사이 간격
    });

    // 서브에이전트는 자기를 부른 세션들의 평균 y 에 놓는다
    var aEdges = g.edges.filter(function (e) { return e.kind === 'subagent'; });
    agents.forEach(function (a) {
      var ys = aEdges.filter(function (e) { return e.to === a.id; })
        .map(function (e) { return pos[e.from]; }).filter(function (v) { return v != null; });
      a._y = ys.length ? ys.reduce(function (s, v) { return s + v; }, 0) / ys.length : LAY.top;
    });
    // 겹치지 않게 정렬 후 밀어낸다
    agents.sort(function (a, b) { return a._y - b._y; });
    var last = -999;
    agents.forEach(function (a) {
      if (a._y - last < LAY.rowH + 22) a._y = last + LAY.rowH + 22;
      last = a._y;
      pos[a.id] = a._y;
    });

    var H = Math.max(y, last + 60) + 30;
    var W = LAY.colA + LAY.boxA + 40;

    // ---- 전역 MCP 밴드
    var band = '<div class="mband"><span class="mbl">전역 MCP 서버 ('
      + g.stats.mcpGlobal + ') · 모든 프로젝트 공용</span>'
      + g.globalMcp.map(function (m) {
          return '<span class="chip mchip" title="' + esc((m.command || '') + ' ' + (m.args || []).join(' '))
            + '">' + esc(m.name) + '</span>';
        }).join('') + '</div>';

    // ---- SVG
    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" class="gsvg">');
    svg.push('<defs>'
      + '<linearGradient id="ge" x1="0" x2="1"><stop offset="0" stop-color="#3d372f"/><stop offset="1" stop-color="#5a5044"/></linearGradient>'
      + '<linearGradient id="gel" x1="0" x2="1"><stop offset="0" stop-color="#6b5620"/><stop offset="1" stop-color="#e0b341"/></linearGradient>'
      + '<linearGradient id="gea" x1="0" x2="1"><stop offset="0" stop-color="#2c4a5c"/><stop offset="1" stop-color="#5fa8d3"/></linearGradient>'
      + '</defs>');

    // 열 제목
    svg.push('<text class="gcol" x="' + LAY.colP + '" y="26">프로젝트 ' + shown.length + '</text>');
    svg.push('<text class="gcol" x="' + LAY.colS + '" y="26">세션 ' + sessions.length
      + '  (실행 중 ' + g.stats.live + ')</text>');
    if (agents.length) svg.push('<text class="gcol" x="' + LAY.colA + '" y="26">서브에이전트 '
      + agents.length + '  (호출 ' + g.stats.subagentCalls + ')</text>');

    // 엣지에 id 를 붙인다. 실시간 신호(움직이는 점)가 이 path 를 따라 달린다.
    function curve(x1, y1, x2, y2, stroke, w, id) {
      var mx = (x1 + x2) / 2;
      return '<path' + (id ? ' id="' + id + '"' : '') + ' class="gedge"'
        + ' d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2
        + '" fill="none" stroke="' + stroke + '" stroke-width="' + (w || 1.3) + '" opacity=".85"/>';
    }
    function edgeId(from, to) {
      return 'ed-' + String(from + '--' + to).replace(/[^A-Za-z0-9_-]/g, '_');
    }

    // 엣지: 프로젝트 -> 세션
    EDGES = {};        // sessionId -> {up: 프로젝트쪽 엣지, agents: {타입: 엣지}}
    g.edges.filter(function (e) { return e.kind === 'session'; }).forEach(function (e) {
      if (pos[e.from] == null || pos[e.to] == null) return;
      var s = byId[e.to];
      var id = edgeId(e.from, e.to);
      svg.push(curve(LAY.colP + LAY.boxP, pos[e.from] + 11, LAY.colS, pos[e.to] + 11,
        s && s.live ? 'url(#gel)' : 'url(#ge)', s && s.live ? 2 : 1.2, id));
      if (s && s.sessionId) {
        EDGES[s.sessionId] = EDGES[s.sessionId] || { agents: {} };
        EDGES[s.sessionId].up = id;
        EDGES[s.sessionId].node = e.to;
      }
    });
    // 엣지: 세션 -> 서브에이전트
    aEdges.forEach(function (e) {
      if (pos[e.from] == null || pos[e.to] == null) return;
      var id = edgeId(e.from, e.to);
      svg.push(curve(LAY.colS + LAY.boxS, pos[e.from] + 11, LAY.colA, pos[e.to] + 11,
        'url(#gea)', Math.min(4, 1.2 + e.count * 0.5), id));
      var sn = byId[e.from];
      if (sn && sn.sessionId) {
        EDGES[sn.sessionId] = EDGES[sn.sessionId] || { agents: {} };
        EDGES[sn.sessionId].agents[String(byId[e.to] && byId[e.to].label)] = id;
      }
    });

    // 노드: 프로젝트
    shown.forEach(function (p) {
      var yy = pos[p.id];
      svg.push('<g class="gn proj" data-gsel="' + esc(p.id) + '">'
        + '<rect x="' + LAY.colP + '" y="' + yy + '" width="' + LAY.boxP + '" height="22" rx="6"/>'
        + '<circle cx="' + (LAY.colP + 13) + '" cy="' + (yy + 11) + '" r="3.5" class="'
          + (p.live ? 'dlive' : 'doff') + '"/>'
        + '<text x="' + (LAY.colP + 24) + '" y="' + (yy + 15) + '">' + esc(cut(p.label, 22)) + '</text>'
        + '<text class="gsub" x="' + (LAY.colP + LAY.boxP - 8) + '" y="' + (yy + 15) + '" text-anchor="end">'
          + p.sessions + '개' + (p.live ? ' · ' + p.live + ' 실행' : '') + '</text>'
        + '<title>' + esc(p.cwd + (p.branch ? '\n브랜치: ' + p.branch : '')
          + (p.mcpDisabled && p.mcpDisabled.length ? '\n끈 MCP: ' + p.mcpDisabled.join(', ') : '')) + '</title>'
        + '</g>');
    });

    // 노드: 세션
    sessions.forEach(function (s) {
      var yy = pos[s.id];
      if (yy == null) return;
      var cls = 'gn sess' + (s.live ? ' live' : '') + (s.embedded ? ' emb' : '');
      svg.push('<g class="' + cls + '" data-gsel="' + esc(s.id) + '"'
        + (s.sessionId ? ' data-view="' + esc(s.provider) + '|' + esc(s.slug) + '|' + esc(s.sessionId) + '"' : '')
        + (s.termId ? ' data-goterm="' + esc(s.termId) + '"' : '') + '>'
        + '<rect x="' + LAY.colS + '" y="' + yy + '" width="' + LAY.boxS + '" height="22" rx="6"/>'
        + '<circle cx="' + (LAY.colS + 13) + '" cy="' + (yy + 11) + '" r="3.5" class="'
          + (s.live ? (s.status === 'busy' ? 'dbusy' : 'dlive') : 'doff') + '"/>'
        + '<text x="' + (LAY.colS + 24) + '" y="' + (yy + 15) + '">' + esc(cut(s.label, 34)) + '</text>'
        + '<text class="gsub" x="' + (LAY.colS + LAY.boxS - 8) + '" y="' + (yy + 15) + '" text-anchor="end">'
          + (s.embedded ? '대시보드' : (s.live ? (s.status === 'busy' ? '작업 중' : '대기 중') : ago(s.mtime)))
          + (s.subagentCalls ? ' · 에이전트 ' + s.subagentCalls : '') + '</text>'
        + '<title>' + esc(s.project + '\n' + s.label
          + (s.sessionId ? '\n' + s.sessionId : '')
          + (s.embedded ? '\n대시보드 터미널에서 실행 중 - 클릭하면 이동' : '\n클릭하면 대화 보기')) + '</title>'
        + '</g>');
    });

    // 노드: 서브에이전트
    agents.forEach(function (a) {
      var yy = pos[a.id];
      svg.push('<g class="gn agent" data-gsel="' + esc(a.id) + '">'
        + '<rect x="' + LAY.colA + '" y="' + yy + '" width="' + LAY.boxA + '" height="22" rx="6"/>'
        + '<text x="' + (LAY.colA + 12) + '" y="' + (yy + 15) + '">' + esc(cut(a.label, 20)) + '</text>'
        + '<title>' + esc(a.label + '\n출처: ' + a.source + (a.desc ? '\n' + a.desc : '')) + '</title>'
        + '</g>');
    });

    svg.push('</svg>');

    host.innerHTML = (CC.live ? CC.live.renderBanner() : '')
      + band
      + '<div class="glegend">'
      +   '<span><i class="dbusy"></i>작업 중</span><span><i class="dlive"></i>대기 중</span>'
      +   '<span><i class="doff"></i>실행 중 아님</span>'
      +   '<button class="gbtn' + (LIVEONLY ? ' on' : '') + '" data-gliveonly="1"'
      +     ' title="실행 중인 세션만 남긴다. 세션이 쌓이면 노드가 수십 개라 신호가 묻힌다">'
      +     '실행 중만</button>'
      +   '<button class="gbtn' + (ROOM ? ' on' : '') + '" data-groom="1"'
      +     ' title="지금 도는 세션과 서브에이전트를 도트 캐릭터로 본다">작업실</button>'
      +   '<button class="gbtn" data-ggraph="reload"'
      +     ' title="그래프를 다시 만든다 (새로 시작한 세션 반영)">↻</button>'
      +   '<span class="gcount">세션 ' + sessions.length
      +     (LIVEONLY ? ' (실행 중만)' : ' / 전체 ' + GRAPH.nodes.filter(function (n) {
        return n.kind === 'session'; }).length) + '</span>'
      +   '<span class="gl2">세션을 클릭하면 대화가 열리고, 대시보드에서 도는 세션은 그 터미널로 이동합니다</span>'
      + '</div>'
      + (ROOM ? '<div class="wsbox"><div class="wsnote">불러오는 중…</div>'
                + '<div class="wsroom" id="wsroom"></div></div>' : '')
      + '<div class="gsplit">'
      +   '<div class="gwrap">' + svg.join('') + '</div>'
      +   '<div class="gfeed"><div class="gfh" id="gfh">실시간 활동</div>'
      +     '<div class="gfl" id="gfl">' + (CC.live ? CC.live.renderFeed() : '') + '</div></div>'
      + '</div>';
    paintLive();

    // 작업실은 host.innerHTML 을 새로 쓸 때마다 캔버스가 날아가므로 여기서 다시 붙인다.
    if (CC.workshop) {
      CC.workshop.stop();
      var room = document.getElementById('wsroom');
      if (room) CC.workshop.mount(room);
    }
  }

  // 그래프 SVG 위에 실시간 상태를 덧씌운다. 다시 그리지 않고 노드만 갱신하므로
  // 이벤트가 쏟아져도 스크롤이 튀지 않는다.
  function paintLive() {
    if (!CC.live || !GRAPH) return;
    GRAPH.nodes.forEach(function (n) {
      if (n.kind !== 'session' || !n.sessionId) return;
      var g = document.querySelector('.gsvg [data-gsel="' + cssEsc(n.id) + '"]');
      if (!g) return;
      var lv = CC.live.liveFor(n.sessionId);
      var dot = g.querySelector('circle');
      var sub = g.querySelector('text.gsub');
      if (!lv) return;

      var cls = CC.live.phaseClass(lv.phase);
      if (dot) dot.setAttribute('class', cls === 'busy' ? 'dbusy' : (cls === 'wait' ? 'dwait' : (cls === 'idle' ? 'dlive' : 'doff')));
      g.classList.toggle('live', lv.phase !== 'ended');
      g.classList.toggle('working', cls === 'busy');

      if (sub) {
        var label = CC.live.phaseLabel(lv.phase);
        if (lv.tools && lv.tools.length) label = lv.tools[0].name;
        if (lv.agents && lv.agents.length) label += ' · 에이전트 ' + lv.agents.length;
        sub.textContent = label;
      }
    });
    var fh = document.getElementById('gfh');
    if (fh) {
      fh.innerHTML = '실시간 활동'
        + '<span class="gfc">' + (CC.live.connected ? '● 연결됨' : '○ 끊김') + '</span>'
        + (CC.live.activeCount() ? '<span class="gfa">활동 중 ' + CC.live.activeCount() + '</span>' : '')
        + (CC.live.agentCount() ? '<span class="gfa">에이전트 ' + CC.live.agentCount() + '</span>' : '');
    }
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // ------------------------------------------------------------- 엣지 위 신호
  //
  // 레이아웃은 그대로 두고, 이벤트가 올 때 해당 엣지를 따라 점을 하나 달리게 한다.
  // 갈 때(요청)와 올 때(응답)를 방향으로 구분하므로 "왔다 갔다" 하는 게 보인다.
  // SVG animateMotion + mpath 를 쓰므로 JS 타이머가 필요 없다.

  var MAX_PULSE = 70;
  var pulseCount = 0;

  function pulse(edge, opts) {
    if (!edge || pulseCount >= MAX_PULSE) return;
    var svg = document.querySelector('.gsvg');
    var path = svg && svg.querySelector('#' + edge);
    if (!path) return;
    opts = opts || {};

    var dur = (opts.dur || 900) + 'ms';
    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'gpulse ' + (opts.cls || ''));

    var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', String(opts.r || 3.2));
    g.appendChild(c);

    var m = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
    m.setAttribute('dur', dur);
    m.setAttribute('fill', 'freeze');
    m.setAttribute('calcMode', 'linear');
    // 역방향은 경로를 거꾸로 훑는다 (응답이 돌아오는 모습)
    if (opts.back) {
      m.setAttribute('keyPoints', '1;0');
      m.setAttribute('keyTimes', '0;1');
    }
    var mp = document.createElementNS('http://www.w3.org/2000/svg', 'mpath');
    mp.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + edge);
    mp.setAttribute('href', '#' + edge);
    m.appendChild(mp);
    g.appendChild(m);

    svg.appendChild(g);
    pulseCount++;
    var done = function () {
      if (g.parentNode) g.parentNode.removeChild(g);
      pulseCount--;
    };
    m.addEventListener('endEvent', done);
    setTimeout(done, (opts.dur || 900) + 400);   // endEvent 를 못 받는 경우 대비
    try { m.beginElement(); } catch (e) {}
  }

  // 툴 종류별 신호 색 (타임라인과 같은 분류)
  function pulseCls(tool) {
    if (!tool) return '';
    if (tool === 'Agent' || tool === 'Task') return 'p-agent';
    if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') return 'p-read';
    if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'p-write';
    if (tool === 'Bash' || tool === 'PowerShell') return 'p-run';
    if (tool.indexOf('mcp__') === 0) return 'p-mcp';
    return '';
  }

  // 이벤트 하나를 어떤 엣지에 어떻게 쏠지 결정한다
  function signal(ev) {
    if (!ev || !ev.sessionId || TABIS() !== 'graph') return;
    var e = EDGES[ev.sessionId];
    if (!e) return;

    var agentEdge = ev.agentType ? e.agents[ev.agentType] : null;

    switch (ev.event) {
      case 'UserPromptSubmit':
        // 사람 -> 세션 (프로젝트 쪽에서 들어온다)
        pulse(e.up, { cls: 'p-prompt', r: 4, dur: 700 });
        break;

      case 'PreToolUse':
        if (ev.agentId && agentEdge) {
          // 서브에이전트가 일을 시작 - 세션에서 에이전트로
          pulse(agentEdge, { cls: pulseCls(ev.tool), dur: 700 });
        } else {
          pulse(e.up, { cls: pulseCls(ev.tool), dur: 800 });
          if (ev.tool === 'Agent' || ev.tool === 'Task') {
            // 에이전트 호출은 세션 -> 에이전트 쪽으로도 쏜다
            var t = ev.text || '';
            Object.keys(e.agents).forEach(function (k) {
              if (t.indexOf(k) >= 0) pulse(e.agents[k], { cls: 'p-agent', r: 4, dur: 900 });
            });
          }
        }
        break;

      case 'PostToolUse':
      case 'PostToolUseFailure':
        // 결과가 돌아온다 - 반대 방향
        if (ev.agentId && agentEdge) pulse(agentEdge, { back: true, cls: pulseCls(ev.tool), dur: 700 });
        else pulse(e.up, { back: true, cls: ev.failed ? 'p-fail' : pulseCls(ev.tool), dur: 800 });
        break;

      case 'SubagentStart':
        if (agentEdge) pulse(agentEdge, { cls: 'p-agent', r: 4.5, dur: 1000 });
        break;

      case 'SubagentStop':
        // 에이전트가 결과를 물고 돌아온다
        if (agentEdge) pulse(agentEdge, { back: true, cls: 'p-agent', r: 4.5, dur: 1000 });
        break;

      case 'Stop':
      case 'StopFailure':
        pulse(e.up, { back: true, cls: 'p-prompt', r: 4, dur: 700 });
        break;

      case 'Notification':
        if (ev.text === 'permission_prompt') pulse(e.up, { back: true, cls: 'p-wait', r: 4.5, dur: 600 });
        break;
    }
  }

  function TABIS() {
    var on = document.querySelector('.tab.on');
    return on ? on.dataset.tab : '';
  }

  // 활동 중인 세션의 엣지에 흐르는 표시를 켠다 (점선이 계속 흐른다)
  function paintFlow() {
    if (!CC.live || !GRAPH) return;
    var live = CC.live.live || {};
    Object.keys(EDGES).forEach(function (sid) {
      var st = live[sid];
      var busy = st && (st.phase === 'tool' || st.phase === 'thinking');
      var e = EDGES[sid];
      var p = document.getElementById(e.up);
      if (p) p.classList.toggle('flowing', !!busy);
      var actAgents = {};
      ((st && st.agents) || []).forEach(function (a) { actAgents[a.type] = true; });
      Object.keys(e.agents).forEach(function (k) {
        var ap = document.getElementById(e.agents[k]);
        if (ap) ap.classList.toggle('flowing', !!actAgents[k]);
      });
    });
  }

  // 이벤트가 올 때 피드와 노드만 갱신한다
  function onLiveEvent(ev) {
    var fl = document.getElementById('gfl');
    if (fl && CC.live) fl.innerHTML = CC.live.renderFeed();
    paintLive();
    paintFlow();
    if (ev) signal(ev);

    // 그래프에 없는 것이 등장하면 다시 만든다. 노드가 있어야 신호를 쏠 수 있다.
    //
    // 세션 쪽을 빠뜨리고 있었다. 그래프는 연결 탭을 처음 열 때 한 번만 만들어지는데
    // (render() 가 #graphwrap 이 비었을 때만 loadGraph 를 부른다), 그 뒤에 시작한
    // 세션은 EDGES 에 없어 signal() 이 조용히 물러난다. 실측에서 활동 중인 세션
    // 7개 중 3개가 그래프에 없었다 - 하네스가 도는데 화면은 가만히 있는 이유였다.
    if (ev && GRAPH && GRAPH_HOST && TABIS() === 'graph') {
      var want = null;
      if (ev.sessionId && !EDGES[ev.sessionId]) want = 's:' + ev.sessionId;
      else if (ev.agentType && !GRAPH.nodes.some(function (n) {
        return n.kind === 'subagent' && n.label === ev.agentType;
      })) want = 'a:' + ev.agentType;

      // 한 번 새로 만들어 봤는데도 여전히 없으면 다시 시도하지 않는다.
      // 그래프에 절대 안 올라오는 세션(사이드체인 등)이 8초마다 재구성을 유발한다.
      if (want && !triedRefresh[want] && Date.now() - lastGraphRefresh > 8000) {
        triedRefresh[want] = 1;
        lastGraphRefresh = Date.now();
        loadGraph(GRAPH_HOST);
      }
    }
  }
  var lastGraphRefresh = 0;
  // "이걸 찾으려고 그래프를 다시 만들어 봤다" 기록. 키는 's:'+세션 또는 'a:'+에이전트.
  var triedRefresh = {};

  // 그래프를 새로 만든 뒤, 이제 실제로 생긴 것만 기록에서 지운다.
  // 통째로 비우면 끝내 안 생기는 세션(사이드체인 등)이 계속 재구성을 유발한다.
  function pruneTried() {
    if (!GRAPH) return;
    var have = {};
    GRAPH.nodes.forEach(function (n) {
      if (n.kind === 'session' && n.sessionId) have['s:' + n.sessionId] = 1;
      if (n.kind === 'subagent') have['a:' + n.label] = 1;
    });
    Object.keys(triedRefresh).forEach(function (k) {
      if (have[k]) delete triedRefresh[k];
    });
  }

  function cut(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function ago(ms) {
    if (!ms) return '';
    var m = Math.floor((Date.now() - ms) / 60000);
    if (m < 60) return m + '분 전';
    var h = Math.floor(m / 60); if (h < 24) return h + '시간 전';
    var d = Math.floor(h / 24); if (d < 30) return d + '일 전';
    return Math.floor(d / 30) + '개월 전';
  }

  // ------------------------------------------------------------- 로딩

  function loadConfig(host) {
    // 편집 모드에 필요한 것(백업 목록, MCP 연결 상태)도 같이 읽는다
    var extras = CC.cfgEdit ? CC.cfgEdit.loadExtras() : Promise.resolve();
    return Promise.all([fetch('/api/config', { cache: 'no-store' }).then(function (r) { return r.json(); }), extras])
      .then(function (arr) { return arr[0]; })
      .then(function (j) { if (j.error) throw new Error(j.error); CFG = j; renderConfig(host); return j; })
      .catch(function (e) { host.innerHTML = '<div class="empty">구성을 불러오지 못했습니다: ' + esc(e.message) + '</div>'; });
  }
  function loadGraph(host) {
    GRAPH_HOST = host;
    host.innerHTML = '<div class="empty">그래프를 만드는 중&#8230; (세션 기록을 훑습니다)</div>';
    return fetch('/api/graph', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(j.error);
        GRAPH = j;
        pruneTried();
        renderGraph(host);
        return j;
      })
      .catch(function (e) { host.innerHTML = '<div class="empty">그래프를 불러오지 못했습니다: ' + esc(e.message) + '</div>'; });
  }

  // 연결 탭 도구 버튼. index.html 의 클릭 위임에서 부른다.
  function handleGraphBtn(el) {
    if (el.dataset.groom !== undefined) {
      ROOM = !ROOM;
      localStorage.setItem('ccl.groom', ROOM ? '1' : '0');
      if (GRAPH_HOST) renderGraph(GRAPH_HOST);
      return true;
    }
    if (el.dataset.gliveonly !== undefined) {
      LIVEONLY = !LIVEONLY;
      localStorage.setItem('ccl.gliveonly', LIVEONLY ? '1' : '0');
      if (GRAPH_HOST) renderGraph(GRAPH_HOST);
      return true;
    }
    if (el.dataset.ggraph === 'reload') {
      if (GRAPH_HOST) loadGraph(GRAPH_HOST);
      return true;
    }
    return false;
  }

  CC.harness = {
    loadConfig: loadConfig, loadGraph: loadGraph,
    renderConfig: renderConfig, renderGraph: renderGraph,
    onLiveEvent: onLiveEvent, paintLive: paintLive, paintFlow: paintFlow, signal: signal,
    handleGraphBtn: handleGraphBtn,
    get config() { return CFG; }, get graph() { return GRAPH; }
  };
})();
