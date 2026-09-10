// 구성 탭의 쓰기(편집) 기능.
//
// 기본은 읽기 전용이다. 헤더의 [편집] 을 켜야 컨트롤이 나타난다.
// 모든 쓰기는 /api/cfg 한 곳으로 op 를 실어 보내고, 서버가 백업 + 검증 후 반영한다.
(function () {
  var CC = window.CC || (window.CC = {});
  var esc = window.escHtml;

  var EDIT = localStorage.getItem('ccl.edit') === '1';
  var MCP = null;          // claude mcp list 결과 (연결 상태 포함)
  var BACKUPS = [];
  var onChanged = null;    // 변경 후 구성을 다시 읽게 하는 콜백

  // 어느 설정 파일에 쓸지 (user / project / local) + 대상 프로젝트
  var SCOPE = localStorage.getItem('ccl.scope') || 'user';
  var SCWD = localStorage.getItem('ccl.scwd') || '';
  var SCHEMA = null;       // 만질 수 있는 항목 정의
  var EFF = null;          // 스코프별 현재 값 + 실제 적용값

  function scopeOf() { return SCOPE; }
  function scopeCwd() { return SCOPE === 'user' ? null : (SCWD || null); }
  function setScope(scope, cwd) {
    SCOPE = scope;
    if (cwd !== undefined) SCWD = cwd || '';
    localStorage.setItem('ccl.scope', SCOPE);
    localStorage.setItem('ccl.scwd', SCWD);
  }
  // 모든 쓰기에 현재 스코프를 실어 보낸다
  function withScope(body) {
    body.scope = SCOPE;
    body.cwd = scopeCwd();
    return body;
  }

  function isEdit() { return EDIT; }
  function setEdit(v) {
    EDIT = !!v;
    localStorage.setItem('ccl.edit', EDIT ? '1' : '0');
  }

  function post(body) {
    return fetch('/api/cfg', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      return j;
    });
  }

  // 백업 목록만 같이 읽는다 (즉시 응답).
  // MCP 연결 상태는 `claude mcp list` 가 서버 11개를 헬스체크해서 15초쯤 걸리므로
  // 구성 로딩을 막지 않고, 버튼을 눌렀을 때만 확인한다.
  function loadExtras() {
    var q = '?scope=' + encodeURIComponent(SCOPE)
          + (scopeCwd() ? '&cwd=' + encodeURIComponent(scopeCwd()) : '');
    var a = fetch('/api/cfg/backups' + q, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { BACKUPS = j.backups || []; })
      .catch(function () { BACKUPS = []; });
    var b = SCHEMA ? Promise.resolve() : fetch('/api/cfg/schema', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { SCHEMA = j; })
      .catch(function () { SCHEMA = null; });
    var c = fetch('/api/cfg/effective'
        + (scopeCwd() ? '?cwd=' + encodeURIComponent(scopeCwd()) : ''), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { EFF = j; })
      .catch(function () { EFF = null; });
    return Promise.all([a, b, c]);
  }

  var mcpLoading = false;
  function loadMcpHealth() {
    if (mcpLoading) return Promise.resolve(MCP);
    mcpLoading = true;
    var btn = document.getElementById('mcpcheck');
    if (btn) { btn.disabled = true; btn.textContent = '확인 중… (최대 20초)'; }
    return fetch('/api/mcp/list', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        MCP = j; mcpLoading = false;
        CC.toast('MCP 서버 ' + (j.servers || []).length + '개 상태 확인');
        refresh();
        return j;
      })
      .catch(function (e) {
        mcpLoading = false;
        CC.toast('상태 확인 실패: ' + e.message, true);
        if (btn) { btn.disabled = false; btn.textContent = '연결 상태 확인'; }
      });
  }

  // ------------------------------------------------------------ 스코프 선택

  // 어느 파일에 쓸지 고르는 줄. 프로젝트 스코프면 프로젝트도 고른다.
  function scopeBar(projects) {
    var cur = EFF && EFF.scopes ? EFF.scopes : {};
    var chip = function (k) {
      var s = cur[k];
      if (!s) return '';
      return '<span class="scst ' + (s.exists ? 'has' : 'none') + '">'
        + (s.exists ? '있음' : '없음') + '</span>';
    };
    var opts = (projects || []).map(function (p) {
      return '<option value="' + esc(p.cwd) + '"' + (p.cwd === SCWD ? ' selected' : '') + '>'
        + esc(p.name) + '</option>';
    }).join('');

    return '<div class="scopebar">'
      + '<span class="lb">설정 대상</span>'
      + '<div class="seg">'
      +   '<button data-scope="user" class="' + (SCOPE === 'user' ? 'on' : '') + '"'
      +     ' title="~/.claude/settings.json - 내 모든 프로젝트">전역</button>'
      +   '<button data-scope="project" class="' + (SCOPE === 'project' ? 'on' : '') + '"'
      +     ' title="<프로젝트>/.claude/settings.json - 팀과 공유(커밋됨)">프로젝트 공유</button>'
      +   '<button data-scope="local" class="' + (SCOPE === 'local' ? 'on' : '') + '"'
      +     ' title="<프로젝트>/.claude/settings.local.json - 나만(커밋 안 됨)">프로젝트 로컬</button>'
      + '</div>'
      + (SCOPE === 'user' ? ''
          : '<select class="cfgsel" id="scopeproj"><option value="">프로젝트 고르기…</option>'
            + opts + '</select>')
      + '<div class="grow"></div>'
      + '<span class="dimtxt">' + (SCOPE === 'user'
          ? '~\\.claude\\settings.json ' + chip('user')
          : (SCWD
              ? esc(SCWD) + '\\.claude\\settings' + (SCOPE === 'local' ? '.local' : '') + '.json '
                + chip(SCOPE)
              : '<b style="color:var(--busy)">프로젝트를 고르세요</b>')) + '</span>'
      + '</div>'
      + (SCOPE !== 'user' && !SCWD ? '' : '<div class="scopenote dimtxt">'
          + '우선순위: <b>프로젝트 로컬</b> &gt; <b>프로젝트 공유</b> &gt; <b>전역</b>'
          + ' — 위에 있는 값이 아래를 덮습니다. 아래 항목의 <span class="fromtag">태그</span>가'
          + ' 지금 실제로 적용되는 출처입니다.</div>');
  }

  // ------------------------------------------------------------ 시각 설정 편집기

  function fromTag(row) {
    if (!row || row.from == null) return '<span class="fromtag none">미설정</span>';
    var ko = { user: '전역', project: '프로젝트 공유', local: '프로젝트 로컬' }[row.from] || row.from;
    var mine = row.from === SCOPE;
    return '<span class="fromtag ' + (mine ? 'mine' : '') + '">' + ko + '</span>';
  }

  // 항목 하나를 컨트롤로 그린다
  function field(key, spec, row, isEnv) {
    var here = row && row.perScope ? row.perScope[SCOPE] : undefined;
    var setAttr = isEnv ? 'data-envkey' : 'data-cfgkey';
    var ctrl;

    if (!EDIT) {
      ctrl = '<span class="fval">' + (row && row.value !== undefined
        ? esc(String(row.value)) : '<i>기본값</i>') + '</span>';
    } else if (spec.kind === 'bool' || spec.kind === 'onoff') {
      var on = spec.kind === 'onoff' ? here === '1' : here === true;
      var isSet = here !== undefined;
      ctrl = '<div class="seg tiny">'
        + '<button ' + setAttr + '="' + key + '" data-v="on" class="' + (isSet && on ? 'on' : '') + '">켬</button>'
        + '<button ' + setAttr + '="' + key + '" data-v="off" class="' + (isSet && !on ? 'on' : '') + '">끔</button>'
        + '<button ' + setAttr + '="' + key + '" data-v="unset" class="' + (isSet ? '' : 'on') + '"'
        +   ' title="이 스코프에서 지워 상위 값을 따른다">해제</button>'
        + '</div>';
    } else if (spec.kind === 'enum') {
      ctrl = '<select class="cfgsel" ' + setAttr + '="' + key + '">'
        + '<option value="">— 해제 (상위 값 사용) —</option>'
        + spec.values.map(function (v) {
            return '<option value="' + esc(v) + '"' + (here === v ? ' selected' : '') + '>'
              + esc(v) + '</option>';
          }).join('')
        + '</select>';
    } else if (spec.kind === 'num') {
      ctrl = '<input class="cfgnum" type="number" ' + setAttr + '="' + key + '"'
        + (spec.min != null ? ' min="' + spec.min + '"' : '')
        + (spec.max != null ? ' max="' + spec.max + '"' : '')
        + ' value="' + (here === undefined ? '' : esc(String(here))) + '" placeholder="기본값">';
    } else {
      ctrl = '<input class="cfgtext" ' + setAttr + '="' + key + '"'
        + ' value="' + (here === undefined ? '' : esc(String(here))) + '" placeholder="비우면 해제">';
    }

    var warn = spec.warnScopes && spec.warnScopes[SCOPE] ? spec.warnScopes[SCOPE] : null;
    return '<div class="cfgfield' + (here !== undefined ? ' set' : '') + '">'
      + '<div class="fl"><span class="fname">' + esc(spec.label || key) + '</span>'
      +   fromTag(row)
      +   '<code class="fkey">' + esc(key) + '</code></div>'
      + '<div class="fc">' + ctrl + '</div>'
      + (spec.hint ? '<div class="fhint">' + esc(spec.hint) + '</div>' : '')
      + (warn ? '<div class="fwarn">⚠ ' + esc(warn) + '</div>' : '')
      + (spec.danger && EDIT ? '<div class="fwarn">⚠ ' + esc(spec.danger) + '</div>' : '')
      + '</div>';
  }

  // 설정 / 기능 스위치 두 묶음
  function settingsPanel() {
    if (!SCHEMA || !EFF) return '<span class="dimtxt">설정 정의를 불러오는 중…</span>';
    if (SCOPE !== 'user' && !SCWD)
      return '<div class="empty">위에서 프로젝트를 먼저 고르세요.</div>';

    var basic = ['model', 'effortLevel', 'permissions.defaultMode', 'agent', 'language'];
    var agentish = ['teammateMode', 'subagentPromptCacheTtl'];
    var rest = Object.keys(SCHEMA.settable).filter(function (k) {
      return basic.indexOf(k) < 0 && agentish.indexOf(k) < 0;
    });

    var box = function (title, keys) {
      return '<div class="subh">' + title + '</div><div class="cfggrid">'
        + keys.map(function (k) {
            return field(k, SCHEMA.settable[k], EFF.keys[k], false);
          }).join('') + '</div>';
    };

    return box('기본', basic)
      + '<div class="subh">멀티 · 서브에이전트</div><div class="cfggrid">'
      +   agentish.map(function (k) { return field(k, SCHEMA.settable[k], EFF.keys[k], false); }).join('')
      +   Object.keys(SCHEMA.envSwitches).map(function (k) {
            return field(k, SCHEMA.envSwitches[k], EFF.env[k], true);
          }).join('')
      + '</div>'
      + '<div class="dimtxt">위 다섯 개는 설정 키가 아니라 <code>env</code> 환경변수입니다.'
      + ' 에이전트 팀은 실험 기능이라 켜야 동작합니다.</div>'
      + box('그 외', rest);
  }

  // ------------------------------------------------------------ 조각들

  // 편집 모드 스위치 + 백업 되돌리기
  function toolbar() {
    var opts = BACKUPS.slice(0, 12).map(function (b) {
      var d = new Date(b.mtime);
      var p = function (n) { return String(n).padStart(2, '0'); };
      return '<option value="' + esc(b.name) + '">'
        + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
        + ' (' + Math.round(b.size / 1024) + 'KB)</option>';
    }).join('');
    return '<div class="cfgbar">'
      + '<div class="seg">'
      +   '<button class="' + (EDIT ? '' : 'on') + '" data-editmode="0">읽기 전용</button>'
      +   '<button class="' + (EDIT ? 'on' : '') + '" data-editmode="1">편집</button>'
      + '</div>'
      + (EDIT
          ? '<span class="cfgwarn">쓰기가 켜졌습니다. 바꾸면 즉시 <code>settings.json</code> 에 반영되고,'
            + ' 매번 백업이 남습니다.</span>'
          : '<span class="dimtxt">보기만 합니다. 바꾸려면 <b>편집</b> 을 켜세요.</span>')
      + '<div class="grow"></div>'
      + (BACKUPS.length
          ? '<span class="dimtxt">백업 ' + BACKUPS.length + '개</span>'
            + '<select class="cfgsel" id="bakpick"><option value="">되돌리기…</option>' + opts + '</select>'
            + '<button class="btn xs" id="bakgo" disabled>되돌리기</button>'
          : '')
      + '</div>';
  }

  // 모델 / 노력 수준 선택
  function settingSelect(key, cur, values) {
    if (!EDIT) return esc(cur == null ? '—' : cur);
    return '<select class="cfgsel" data-setkey="' + key + '">'
      + values.map(function (v) {
          return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>';
        }).join('')
      + '</select>';
  }

  // 규칙/디렉터리 목록에 삭제 버튼과 추가 폼을 붙인다
  function ruleActions(kind, rule) {
    if (!EDIT) return '';
    return '<button class="xdel" data-permdel="' + esc(kind) + '|' + esc(rule) + '" title="삭제">✕</button>';
  }
  function addForm(id, placeholder, btn) {
    if (!EDIT) return '';
    return '<div class="addrow">'
      + '<input class="hfilter" id="' + id + '" placeholder="' + esc(placeholder) + '">'
      + '<button class="btn primary xs" data-addfrom="' + id + '">' + esc(btn) + '</button>'
      + '</div>';
  }

  // 플러그인 on/off
  function pluginToggle(p) {
    if (!EDIT) return '';
    return '<button class="btn xs" data-plugtoggle="' + esc(p.name) + '" data-on="' + (p.enabled ? '1' : '0') + '">'
      + (p.enabled ? '끄기' : '켜기') + '</button>';
  }

  // MCP 서버 카드에 연결 상태와 삭제를 붙인다
  function mcpHealth(name) {
    if (!MCP || !MCP.servers) return '';   // 아직 확인 안 함 - 배지를 아예 안 그린다
    var hit = MCP.servers.find(function (s) { return s.name === name || s.name.indexOf(name) >= 0; });
    if (!hit) return '<span class="mh unk">미확인</span>';
    var ko = hit.state === 'ok' ? '연결됨' : (hit.state === 'auth' ? '인증 필요' : '연결 실패');
    return '<span class="mh ' + hit.state + '">' + ko + '</span>';
  }
  function mcpActions(name) {
    if (!EDIT) return '';
    return '<button class="xdel" data-mcpdel="' + esc(name) + '" title="MCP 서버 제거">✕</button>';
  }
  // 연결 상태 확인 버튼 (느린 호출이라 명시적으로만 실행한다)
  function mcpCheckBar() {
    return '<div class="addrow" style="align-items:center">'
      + '<button class="btn xs" id="mcpcheck">' + (MCP ? '상태 다시 확인' : '연결 상태 확인') + '</button>'
      + '<span class="dimtxt">' + (MCP
          ? (MCP.servers || []).length + '개 확인됨'
          : '<code>claude mcp list</code> 로 실제 연결 상태를 확인합니다 (서버가 많으면 15초쯤)') + '</span>'
      + '</div>';
  }

  function mcpAddForm() {
    if (!EDIT) return '';
    return '<div class="subh">MCP 서버 추가</div>'
      + '<div class="mform">'
      + '<input class="hfilter" id="m-name" placeholder="이름 (예: my-server)">'
      + '<select class="cfgsel" id="m-transport">'
      +   '<option value="stdio">stdio (명령 실행)</option>'
      +   '<option value="http">http</option><option value="sse">sse</option>'
      + '</select>'
      + '<select class="cfgsel" id="m-scope">'
      +   '<option value="user">user (내 전체 프로젝트)</option>'
      +   '<option value="local">local (이 프로젝트만)</option>'
      +   '<option value="project">project (팀 공유 .mcp.json)</option>'
      + '</select>'
      + '<input class="hfilter wide" id="m-target" placeholder="명령 또는 URL (예: npx -y @scope/server  또는  https://...)">'
      + '<input class="hfilter" id="m-env" placeholder="환경변수 KEY=값, 쉼표로 여러 개 (선택)">'
      + '<button class="btn primary xs" id="m-add">추가</button>'
      + '</div>'
      + '<div class="dimtxt">추가는 <code>claude mcp add</code> 를 그대로 호출합니다. 형식 검증은 CLI 가 합니다.</div>';
  }

  // ------------------------------------------------------- 에이전트 팀 템플릿
  //
  // 서브에이전트는 하나씩 만들면 손이 많이 간다. 자주 쓰는 조합을 미리 묶어두고
  // 한 번에 만든다. 만든 뒤 각자 '편집' 으로 내용을 채우는 것을 전제로 한 뼈대다.
  //
  // description 이 곧 선택 기준이다. Claude 가 이 문장을 보고 언제 부를지 정하므로
  // "언제 쓰는지" 를 먼저 쓴다.

  var TOOLBOX = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'];

  var TEAMS = {
    review: {
      label: '코드 리뷰 팀',
      note: '변경분을 세 관점으로 나눠 본다. 읽기 위주라 위험이 낮다.',
      members: [
        { name: 'reviewer', model: 'sonnet', tools: ['Read', 'Grep', 'Glob'],
          description: '코드 변경분의 정확성과 회귀를 검토할 때. 로직 오류·엣지케이스·기존 동작 파손을 찾는다.' },
        { name: 'security-reviewer', model: 'sonnet', tools: ['Read', 'Grep', 'Glob'],
          description: '보안 관점 검토가 필요할 때. 입력 검증·경로 탈출·비밀값 노출·권한 확대를 본다.' },
        { name: 'test-writer', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
          description: '빠진 테스트를 채울 때. 기존 테스트 스타일을 따라 실패 케이스부터 만든다.' },
      ],
    },
    debug: {
      label: '디버깅 팀',
      note: '재현과 수정을 나눈다. 재현 담당은 고치지 않는다.',
      members: [
        { name: 'repro', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Bash'],
          description: '버그를 재현할 때. 최소 재현 절차를 찾아 정리하고 고치지는 않는다.' },
        { name: 'fixer', model: 'opus', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'],
          description: '재현된 버그를 고칠 때. 근본 원인을 찾아 최소 변경으로 고치고 검증까지 한다.' },
      ],
    },
    research: {
      label: '조사 · 문서 팀',
      note: '큰 코드베이스를 훑을 때. 본 대화의 문맥을 아끼려고 나눈다.',
      members: [
        { name: 'explorer', model: 'sonnet', tools: ['Read', 'Grep', 'Glob'],
          description: '코드베이스를 넓게 훑어야 할 때. 파일을 많이 읽고 결론만 요약해 돌려준다.' },
        { name: 'doc-writer', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
          description: '문서를 쓰거나 고칠 때. 코드를 먼저 읽고 실제 동작에 맞춰 쓴다.' },
      ],
    },
  };

  function teamForm() {
    if (!EDIT) return '';
    var opts = Object.keys(TEAMS).map(function (k) {
      return '<option value="' + k + '">' + esc(TEAMS[k].label)
        + ' (' + TEAMS[k].members.length + '개)</option>';
    }).join('');
    return '<div class="subh">에이전트 팀 한 번에 만들기</div>'
      + '<div class="mform">'
      +   '<select class="cfgsel" id="team-kind">' + opts + '</select>'
      +   '<input class="hfilter" id="team-prefix" placeholder="이름 앞에 붙일 말 (선택, 예: hex-)">'
      +   '<button class="btn primary xs" data-maketeam="1">팀 만들기</button>'
      +   '<button class="btn ghost xs" data-teampeek="1">뭘 만드는지 보기</button>'
      + '</div>'
      + '<div class="dimtxt" id="team-peek">'
      +   '고른 팀의 에이전트를 한 번에 만듭니다. 이름이 겹치면 그것만 건너뛰고 나머지는 만듭니다.'
      + '</div>';
  }

  function teamPeek() {
    var t = TEAMS[val('team-kind')];
    if (!t) return;
    var pre = (val('team-prefix') || '').trim();
    var el = document.getElementById('team-peek');
    if (!el) return;
    el.innerHTML = '<b>' + esc(t.label) + '</b> &middot; ' + esc(t.note) + '<br>'
      + t.members.map(function (m) {
        return '&nbsp;&nbsp;<code>' + esc(pre + m.name) + '</code> &middot; '
          + esc(m.model) + ' &middot; ' + esc(m.tools.join(', '))
          + '<br>&nbsp;&nbsp;&nbsp;&nbsp;<span class="dimtxt">' + esc(m.description) + '</span>';
      }).join('<br>')
      + '<br>저장 위치: ' + esc(agentDirNote());
  }

  function agentDirNote() {
    if (SCOPE === 'user') return '~/.claude/agents/';
    return (SCWD || '(프로젝트를 고르세요)') + '\\.claude\\agents\\';
  }

  // 에이전트 / 스킬 만들기 폼
  function makeForm(kind) {
    if (!EDIT) return '';
    var k = kind === 'skill' ? 'skill' : 'agent';
    var ko = k === 'skill' ? '스킬' : '에이전트';
    return '<div class="subh">' + ko + ' 새로 만들기</div>'
      + '<div class="mform">'
      + '<input class="hfilter" id="' + k + '-name" placeholder="이름 (영문/숫자/-)">'
      + '<input class="hfilter wide" id="' + k + '-desc" placeholder="설명 - '
      +   (k === 'skill' ? '이 문장으로 스킬이 트리거됩니다' : '이 문장으로 에이전트가 선택됩니다') + '">'
      + (k === 'agent'
          ? '<select class="cfgsel" id="agent-model">'
            +   '<option value="">모델: 기본</option><option value="opus">opus</option>'
            +   '<option value="sonnet">sonnet</option><option value="haiku">haiku</option>'
            + '</select>'
          : '')
      + '<button class="btn primary xs" data-make="' + k + '">만들기</button>'
      + '</div>'
      + (k === 'agent'
          ? '<div class="toolpick">'
            +   '<span class="dimtxt">도구 &middot; 하나도 안 고르면 전체 허용</span>'
            +   TOOLBOX.map(function (t) {
                  return '<label class="tk"><input type="checkbox" class="agent-tool" value="'
                    + esc(t) + '"> ' + esc(t) + '</label>';
                }).join('')
            + '</div>'
          : '')
      + '<div class="dimtxt">' + (k === 'skill' ? '~/.claude/skills/&lt;이름&gt;/SKILL.md'
                                                : esc(agentDirNote()) + '&lt;이름&gt;.md')
      +   ' 를 프론트매터와 뼈대까지 만들어 둡니다. 만든 뒤 <b>편집</b> 으로 내용을 채우세요.'
      +   ' <b>다음 세션부터 인식됩니다.</b>'
      +   (k === 'agent' ? ' 저장 위치는 위의 <b>설정 대상</b> 을 따릅니다.' : '')
      + '</div>';
  }

  function docActions(kind, name, source) {
    if (!EDIT || String(source || '').indexOf('plugin:') === 0) return '';
    return '<button class="btn ghost xs" data-docedit="' + kind + '|' + esc(name) + '">편집</button>'
      + '<button class="xdel" data-docdel="' + kind + '|' + esc(name) + '" title="휴지통으로 이동">✕</button>';
  }

  // ------------------------------------------------------------ 편집 모달

  function openEditor(kind, name) {
    fetch('/api/cfg/doc?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(name),
          { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(j.error);
        var el = document.getElementById('docmodal');
        el.innerHTML = '<div class="dmbox">'
          + '<div class="dmh"><b>' + esc(name) + '</b>'
          +   '<span class="dimtxt">' + esc(j.file) + '</span>'
          +   '<div class="grow"></div>'
          +   '<button class="btn xs" id="dm-save">저장</button>'
          +   '<button class="btn ghost xs" id="dm-close">닫기</button></div>'
          + '<textarea class="dmta" id="dm-text" spellcheck="false"></textarea>'
          + '<div class="dmf dimtxt">저장하면 원본은 <code>.bak_</code> 로 남습니다. 다음 세션부터 반영됩니다.</div>'
          + '</div>';
        el.hidden = false;
        document.getElementById('dm-text').value = j.text;
        document.getElementById('dm-close').onclick = function () { el.hidden = true; };
        document.getElementById('dm-save').onclick = function () {
          var text = document.getElementById('dm-text').value;
          post({ op: 'doc-write', kind: kind, name: name, text: text })
            .then(function (r) {
              CC.toast('저장됨 · 백업 ' + r.backup);
              el.hidden = true;
            })
            .catch(function (e) { CC.toast(e.message, true); });
        };
      })
      .catch(function (e) { CC.toast(e.message, true); });
  }

  // ------------------------------------------------------------ 클릭 처리
  // index.html 의 전역 클릭 핸들러가 여기로 넘긴다. 처리했으면 true 를 돌려준다.

  function handle(t) {
    var d = t.dataset || {};

    if (d.editmode !== undefined) {
      setEdit(d.editmode === '1');
      refresh();
      return true;
    }

    if (d.setkey !== undefined) return false;   // change 이벤트로 처리한다

    // 설정 대상(스코프) 전환
    if (d.scope) {
      setScope(d.scope);
      refresh();
      return true;
    }

    // 켬/끔/해제 3단 버튼 (bool · onoff)
    if (d.cfgkey || d.envkey) {
      var isEnv = !!d.envkey;
      var key = d.envkey || d.cfgkey;
      var v = d.v === 'unset' ? null : (d.v === 'on');
      if (isEnv) act(post(withScope({ op: 'env', key: key, value: v })),
                     key + ' → ' + (v === null ? '해제' : (v ? '켬' : '끔')) + ' · 다음 세션부터');
      else act(post(withScope({ op: 'set', key: key, value: v })),
               key + ' → ' + (v === null ? '해제' : (v ? '켬' : '끔')) + ' · 다음 세션부터');
      return true;
    }

    if (d.permdel) {
      var parts = d.permdel.split('|');
      var kind = parts.shift();
      var rule = parts.join('|');
      if (!confirm('이 규칙을 삭제할까요?\n\n' + rule)) return true;
      act(post(withScope({ op: 'perm-remove', kind: kind, rule: rule })), '규칙 삭제됨');
      return true;
    }

    if (d.addfrom) {
      var inp = document.getElementById(d.addfrom);
      var v = (inp.value || '').trim();
      if (!v) { CC.toast('값을 입력하세요', true); return true; }
      if (d.addfrom === 'permadd') {
        act(post(withScope({ op: 'perm-add', kind: 'allow', rule: v })), '규칙 추가됨', function (r) {
          if (r.warning) CC.toast('주의: ' + r.warning, true);
        });
      } else {
        act(post(withScope({ op: 'dir-add', dir: v })), '폴더 추가됨');
      }
      inp.value = '';
      return true;
    }

    if (d.dirdel) {
      if (!confirm('이 폴더를 목록에서 뺄까요?\n\n' + d.dirdel)) return true;
      act(post(withScope({ op: 'dir-remove', dir: d.dirdel })), '폴더 삭제됨');
      return true;
    }

    if (d.plugtoggle) {
      var on = d.on !== '1';
      act(post(withScope({ op: 'plugin', name: d.plugtoggle, enabled: on })),
          d.plugtoggle + (on ? ' 켜짐' : ' 꺼짐') + ' · 다음 세션부터 적용');
      return true;
    }

    if (d.mcpdel) {
      if (!confirm('MCP 서버를 제거할까요?\n\n' + d.mcpdel)) return true;
      act(post({ op: 'mcp-remove', name: d.mcpdel }), 'MCP 서버 제거됨');
      return true;
    }

    if (t.id === 'mcpcheck') { loadMcpHealth(); return true; }

    if (t.id === 'm-add') {
      var env = (val('m-env') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var target = val('m-target');
      var bits = target.split(/\s+/).filter(Boolean);
      act(post({
        op: 'mcp-add', name: val('m-name'), transport: val('m-transport'), scope: val('m-scope'),
        commandOrUrl: bits.shift(), args: bits, env: env
      }), 'MCP 서버 추가됨 · 다음 세션부터 적용');
      return true;
    }

    if (d.make) {
      var kind = d.make;
      var body = { op: kind + '-create', name: val(kind + '-name'), description: val(kind + '-desc') };
      if (kind === 'agent') {
        var tl = [].slice.call(document.querySelectorAll('.agent-tool:checked'))
          .map(function (c) { return c.value; });
        if (tl.length) body.tools = tl;
        if (val('agent-model')) body.model = val('agent-model');
      }
      // 에이전트는 스코프 바를 따른다. 스킬은 아직 전역만 지원한다.
      if (kind === 'agent') withScope(body);
      act(post(body), (kind === 'skill' ? '스킬' : '에이전트') + ' 만들었습니다 · 다음 세션부터 인식됩니다',
          function (r) { openEditor(kind, r.name); });
      return true;
    }

    if (d.teampeek) { teamPeek(); return true; }

    if (d.maketeam) {
      var t = TEAMS[val('team-kind')];
      if (!t) { CC.toast('팀을 고르세요', true); return true; }
      var pre = (val('team-prefix') || '').trim();
      if (SCOPE !== 'user' && !SCWD) {
        CC.toast('프로젝트 스코프입니다 - 위에서 대상 프로젝트를 먼저 고르세요', true);
        return true;
      }
      var members = t.members.map(function (m) {
        return { name: pre + m.name, description: m.description, tools: m.tools, model: m.model };
      });
      if (!confirm(t.label + ' 을 만듭니다 (' + members.length + '개)\n\n'
          + members.map(function (m) { return '  ' + m.name; }).join('\n')
          + '\n\n저장 위치: ' + agentDirNote() + '\n\n만들까요?')) return true;

      act(post(withScope({ op: 'agent-team', members: members })), null, function (r) {
        var msg = r.made.length + '개 만들었습니다';
        if (r.failed && r.failed.length) {
          msg += ' · ' + r.failed.length + '개 건너뜀 (' + r.failed[0].error + ')';
        }
        CC.toast(msg + ' · 다음 세션부터 인식됩니다', !r.made.length);
      });
      return true;
    }

    if (d.docedit) {
      var p2 = d.docedit.split('|');
      openEditor(p2[0], p2[1]);
      return true;
    }
    if (d.docdel) {
      var p3 = d.docdel.split('|');
      var koName = p3[0] === 'skill' ? '스킬' : '에이전트';
      if (!confirm(koName + ' "' + p3[1] + '" 을 휴지통으로 옮길까요?\n\n' +
                   '~/.claude/.cc-launcher-trash/ 로 이동합니다 (되돌릴 수 있습니다)')) return true;
      act(post({ op: p3[0] + '-delete', name: p3[1] }), koName + ' 휴지통으로 이동');
      return true;
    }

    if (t.id === 'bakgo') {
      var sel = document.getElementById('bakpick');
      if (!sel || !sel.value) return true;
      if (!confirm('settings.json 을 이 백업으로 되돌릴까요?\n\n' + sel.value
                   + '\n\n(되돌리기 직전 상태도 백업됩니다)')) return true;
      act(post(withScope({ op: 'restore', name: sel.value })), '되돌렸습니다');
      return true;
    }

    return false;
  }

  // select 변경 처리 (모델 / 노력 수준)
  function handleChange(t) {
    if (!t || !t.dataset) return false;

    // 프로젝트 스코프의 대상 프로젝트 선택
    if (t.id === 'scopeproj') {
      setScope(SCOPE, t.value);
      refresh();
      return true;
    }

    // 시각 편집기의 select / number / text
    if (t.dataset.cfgkey || t.dataset.envkey) {
      var isEnv = !!t.dataset.envkey;
      var key = t.dataset.envkey || t.dataset.cfgkey;
      var spec = SCHEMA && (isEnv ? SCHEMA.envSwitches[key] : SCHEMA.settable[key]);
      var raw = String(t.value == null ? '' : t.value).trim();
      var value;
      if (raw === '') value = null;                       // 해제
      else if (spec && spec.kind === 'num') value = Number(raw);
      else value = raw;
      act(post(withScope({ op: isEnv ? 'env' : 'set', key: key, value: value })),
          (spec ? spec.label : key) + ' → ' + (value === null ? '해제' : raw) + ' · 다음 세션부터');
      return true;
    }

    if (t.dataset.setkey) {
      act(post(withScope({ op: 'set', key: t.dataset.setkey, value: t.value })),
          t.dataset.setkey + ' = ' + t.value + ' · 다음 세션부터 적용');
      return true;
    }
    if (t.id === 'bakpick') {
      var go = document.getElementById('bakgo');
      if (go) go.disabled = !t.value;
      return true;
    }
    return false;
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  function act(p, okMsg, then) {
    return p.then(function (r) {
      // okMsg 가 없으면 then 이 알아서 알린다 (결과에 따라 문구가 갈리는 경우)
      if (okMsg) CC.toast(okMsg + (r.backup ? ' · 백업 ' + r.backup : ''));
      if (then) then(r);
      refresh();
      return r;
    }).catch(function (e) { CC.toast(e.message, true); });
  }

  function refresh() {
    if (onChanged) onChanged();
  }

  CC.cfgEdit = {
    handle: handle, handleChange: handleChange,
    loadExtras: loadExtras, toolbar: toolbar,
    settingSelect: settingSelect, ruleActions: ruleActions, addForm: addForm,
    pluginToggle: pluginToggle, mcpHealth: mcpHealth, mcpActions: mcpActions,
    mcpAddForm: mcpAddForm, mcpCheckBar: mcpCheckBar, makeForm: makeForm, docActions: docActions,
    teamForm: teamForm,
    scopeBar: scopeBar, settingsPanel: settingsPanel, scopeOf: scopeOf,
    openEditor: openEditor,
    isEdit: isEdit,
    set onChanged(fn) { onChanged = fn; },
    get mcp() { return MCP; }
  };
})();
