(function () {
  'use strict';
  const CC = window.CC || (window.CC = {});
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { tasks: [], id: localStorage.getItem('ccl.studio.task'), mode: 'agents', candidate: null,
    loaded: false, loading: false, at: 0, file: null, changes: [], fileList: [], preview: null, selection: null, clickMode: false, archived: false, contentKey: '', generation: 0 };
  let root, hooks, modal, polling, editorDirty = false, operation = false;
  const $ = selector => root.querySelector(selector);
  const task = () => state.tasks.find(t => t.id === state.id);
  const candidate = () => task()?.candidates.find(c => c.id === state.candidate) || task()?.candidates[0];
  const label = c => (c.provider === 'codex' ? 'Codex' : 'Claude') + (task()?.candidates.filter(x => x.provider === c.provider).length > 1 ? ' · ' + (task().candidates.indexOf(c) + 1) : '');
  const status = c => c.terminal?.alive ? ({ busy: '작업 중', waiting: '확인 필요', idle: '입력 대기' }[c.terminal.status] || '실행 중') : c.startedAt ? '중지됨' : '시작 전';
  async function api(op, body) {
    const res = await fetch('/api/studio/' + op, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    if (!res.headers.get('content-type')?.includes('application/json')) throw new Error('새 작업 기능을 사용하려면 대시보드 서버를 재시작해 주세요. Launch.vbs에서 이전 버전 교체를 선택할 수 있습니다.');
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '요청에 실패했습니다');
    return data;
  }
  function args(extra) { return { task: state.id, candidate: candidate()?.id, ...extra }; }
  function get(op, extra) { return api(op + '?' + new URLSearchParams(args(extra))); }
  function notice(text, error) { hooks.toast(text, error); }
  function updateTasks(data) {
    state.tasks = data.tasks || state.tasks;
    if (data.task) state.tasks = state.tasks.map(t => t.id === data.task.id ? data.task : t);
    if (!task()) state.id = state.tasks.find(t => !t.archived)?.id || state.tasks[0]?.id || null;
    if (task() && !task().candidates.some(c => c.id === state.candidate)) state.candidate = task().candidates[0]?.id;
    if (state.id) localStorage.setItem('ccl.studio.task', state.id);
  }
  async function refresh(force) {
    if (state.loading || (!force && Date.now() - state.at < 4500)) return;
    state.loading = true;
    try {
      const before = showTerminals();
      const data = await api('tasks'); updateTasks(data); state.loaded = true; state.at = Date.now();
      paintChrome();
      if (before !== showTerminals()) hooks.render();
      if (!state.contentKey) await content();
    } catch (e) { if (!state.loaded) $('.studio-content').innerHTML = '<div class="studio-empty"><p>' + esc(e.message) + '</p><button class="btn" data-studio="refresh">다시 연결</button></div>'; }
    finally { state.loading = false; }
  }
  function init(el, options) {
    root = el; hooks = options;
    root.innerHTML = '<aside class="studio-side"><div class="studio-brand">AI WORKSPACE</div><h2>나의 작업 공간</h2>'
      + '<button class="btn primary" data-studio="new">＋ 새 작업</button><input class="studio-search" aria-label="작업 검색" placeholder="작업 검색…">'
      + '<div class="studio-task-list"></div><div class="studio-side-footer"><button class="btn ghost xs" data-studio="archive-view">보관한 작업 보기</button>'
      + '<p>Ctrl + P 빠른 열기<br>Claude · Codex 병렬 작업</p></div></aside>'
      + '<div class="studio-head"></div><div class="studio-content"></div>'
      + '<div class="studio-composer" hidden><textarea id="studio-prompt" aria-label="AI에게 보낼 요청" placeholder="이 작업의 AI에게 추가 요청… 파일과 이미지도 끌어놓을 수 있어요."></textarea>'
      + '<div class="studio-compose-line"><select id="studio-recipient" aria-label="요청받을 AI"></select><span class="studio-hint">Ctrl + Enter 전송 · 작업 중이면 준비될 때 전달</span>'
      + '<button class="btn primary" data-studio="send">요청 보내기 ↗</button></div><div class="studio-status" aria-live="polite"></div></div>';
    root.addEventListener('click', handle);
    root.addEventListener('input', e => {
      if (e.target.matches('.studio-search')) paintSidebar();
      if (e.target.id === 'studio-file-filter') filterFiles(e.target.value);
      if (e.target.id === 'studio-source') { editorDirty = true; $('#studio-save').textContent = '변경 저장 •'; }
      if (e.target.id === 'studio-prompt' && state.id) localStorage.setItem('ccl.studio.draft.' + state.id, e.target.value);
    });
    root.addEventListener('change', e => { if (e.target.id === 'studio-candidate') selectCandidate(e.target.value); });
    root.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); $('.studio-composer').classList.add('studio-drop-active'); } });
    root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) $('.studio-composer').classList.remove('studio-drop-active'); });
    root.addEventListener('drop', async e => {
      if (!e.dataTransfer.files.length || !task()) return;
      e.preventDefault(); $('.studio-composer').classList.remove('studio-drop-active');
      try {
        for (const file of e.dataTransfer.files) {
          const res = await fetch('/api/paste-file?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
          const data = await res.json(); if (!res.ok) throw new Error(data.error);
          $('#studio-prompt').value += '\n첨부 파일: ' + data.path;
        }
        $('#studio-prompt').dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) { notice(e.message, true); }
    });
    document.addEventListener('keydown', e => {
      if (root.hidden) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); quickOpen(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement.id === 'studio-prompt') { e.preventDefault(); action('send'); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && document.activeElement.id === 'studio-source') { e.preventDefault(); action('save'); }
      if (e.key === 'Escape' && modal) closeModal();
    });
    window.addEventListener('beforeunload', e => { if (editorDirty) { e.preventDefault(); e.returnValue = ''; } });
    polling = setInterval(() => { if (!root.hidden && !document.hidden && !modal) refresh(false); }, 5000);
  }
  function showTerminals() { return state.mode === 'agents' && !!task()?.candidates.some(c => c.terminal); }
  function scope() { if (!root.hidden) CC.term.setScope(task()?.candidates.map(c => c.terminal?.id).filter(Boolean) || []); }
  function enter() {
    if (!root) return;
    scope(); refresh(false);
    if (!state.loaded) $('.studio-content').textContent = '작업 공간을 불러오는 중…';
  }
  function paintSidebar() {
    const query = $('.studio-search').value.toLowerCase();
    const rows = state.tasks.filter(t => !!t.archived === state.archived && (!query || (t.title + ' ' + t.root).toLowerCase().includes(query)));
    const html = rows.map(t => '<button class="studio-task ' + (state.id === t.id ? 'on' : '') + '" data-studio="select" data-id="' + t.id + '"><b>' + esc(t.title)
      + '</b><small>' + (t.status === 'applied' ? '✓ 반영 완료' : t.candidates.filter(c => c.terminal?.alive).length + ' 실행 중') + ' · ' + t.candidates.length + ' AI</small></button>').join('') || '<p class="studio-hint">아직 작업이 없습니다.</p>';
    const list = $('.studio-task-list'); if (list.innerHTML !== html) list.innerHTML = html;
  }
  function paintChrome() {
    paintSidebar(); const t = task();
    const modes = [['agents', 'AI 터미널'], ['review', '변경 코드'], ['compare', '결과 비교'], ['files', '파일 편집'], ['design', 'Design Mode']];
    const html = '<div class="studio-head-top"><div><h2>' + esc(t?.title || '아이디어를 작업으로') + '</h2><div class="studio-path" title="' + esc(t?.root || '') + '">'
      + esc(t?.root || '독립된 작업 공간에서 Claude와 Codex를 함께 사용하세요') + '</div></div><div class="studio-actions">'
      + (t ? '<span class="studio-tag">' + (t.isolated ? 'ISOLATED GIT' : 'SINGLE WORKSPACE') + '</span><button class="btn primary" data-studio="start-all">AI 실행</button><button class="btn" data-studio="stop">선택 AI 중지</button><button class="btn" data-studio="archive">' + (t.archived ? '보관 해제' : '보관') + '</button>' : '')
      + '<button class="btn ghost" data-studio="refresh" aria-label="작업 새로고침">↻</button></div></div>'
      + '<div class="studio-tabs">' + modes.map(([id, title]) => '<button data-studio="mode" data-id="' + id + '" class="' + (state.mode === id ? 'on' : '') + '">' + title + '</button>').join('')
      + (t?.candidates.length ? '<select id="studio-candidate" aria-label="검토할 AI 작업" class="btn">' + t.candidates.map(c => '<option value="' + c.id + '" ' + (candidate()?.id === c.id ? 'selected' : '') + '>' + esc(label(c)) + ' · ' + status(c) + '</option>').join('') + '</select>' : '') + '</div>';
    // Avoid replacing focused controls every poll.
    if ($('.studio-head').innerHTML !== html && !$('.studio-head').contains(document.activeElement)) $('.studio-head').innerHTML = html;
    $('.studio-composer').hidden = !t;
    const recipient = $('#studio-recipient'), old = recipient.value;
    const opts = t ? t.candidates.map(c => '<option value="' + c.id + '">' + esc(label(c)) + '</option>').join('') + (t.candidates.length > 1 ? '<option value="all">모든 작업자</option>' : '') : '';
    if (recipient.innerHTML !== opts) { recipient.innerHTML = opts; if ([...recipient.options].some(o => o.value === old)) recipient.value = old; }
    if (t) {
      const messages = t.candidates.flatMap(c => (c.messages || []).slice(-1).map(m => label(c) + ': ' + ({ queued: '전달 대기', sent: '입력 전송됨', failed: m.error || '전달 실패' }[m.status] || m.status)));
      $('.studio-status').textContent = messages.join(' · ');
    }
    scope();
  }
  function discardEditor() {
    if (editorDirty && !confirm('저장하지 않은 파일 변경을 닫을까요?')) return false;
    editorDirty = false; return true;
  }
  async function select(id) {
    if (!discardEditor()) return;
    state.id = id; state.candidate = null; state.file = null; state.contentKey = ''; state.preview = null; state.selection = null;
    updateTasks({}); $('#studio-prompt').value = localStorage.getItem('ccl.studio.draft.' + id) || '';
    paintChrome(); hooks.render(); await content();
  }
  async function selectCandidate(id) {
    if (!discardEditor()) { paintChrome(); return; }
    state.candidate = id; state.file = null; state.contentKey = ''; await content();
  }
  async function content(force) {
    const t = task(), c = candidate();
    const key = [state.id, c?.id, state.mode].join(':');
    if (!force && state.contentKey === key) return;
    state.contentKey = key; const generation = ++state.generation;
    const host = $('.studio-content'); host.hidden = showTerminals();
    if (!t) {
      host.innerHTML = '<div class="studio-empty"><div class="studio-mark">⌘</div><h2>하나의 요청, 여러 가지 가능성</h2><p>Claude와 Codex에 같은 작업을 맡기고<br>각자의 코드와 결과를 한곳에서 비교하세요.</p><button class="btn primary" data-studio="new">첫 작업 만들기 ＋</button><p class="studio-hint">독립 Git 작업 공간 · 코드 리뷰 · 화면 요소로 수정 요청</p></div>'; return;
    }
    if (!c) { host.textContent = t.error || '작업 공간 생성에 실패했습니다. 새 작업을 만들어 주세요.'; return; }
    if (state.mode === 'agents') {
      if (showTerminals()) { scope(); CC.term.scheduleRefit(); return; }
      host.innerHTML = (t.sourceDirty ? '<div class="studio-note">원본의 미커밋 변경은 독립 작업 공간에 포함되지 않습니다. 작업 시작 시점의 커밋을 기준으로 생성했습니다.</div>' : '')
        + '<div class="studio-candidates">' + t.candidates.map(c => '<article class="studio-candidate"><h3>' + esc(label(c)) + '</h3><span class="studio-tag">' + status(c) + '</span><p>' + esc(c.branch || '프로젝트 폴더에서 직접 작업') + '</p><button class="btn primary" data-studio="start" data-id="' + c.id + '">AI 시작</button></article>').join('')
        + '</div><p class="studio-hint">작업 요청은 AI가 준비되면 한 번 전송됩니다. 시작 화면의 확인 요청은 터미널에서 응답하세요.</p>'; return;
    }
    host.innerHTML = '<p class="studio-hint">불러오는 중…</p>';
    try {
      if (state.mode === 'compare') {
        const rows = await Promise.all(t.candidates.map(async c => {
          const data = await get('result', { candidate: c.id }); const changed = await get('changes', { candidate: c.id });
          return '<article class="studio-candidate"><h3>' + esc(label(c)) + '</h3><span class="studio-tag">' + status(c) + '</span><p>' + changed.files.length + '개 변경 파일 · ' + esc(c.branch || '일반 폴더') + '</p>'
            + '<button class="btn" data-studio="review-candidate" data-id="' + c.id + '">변경 코드 검토</button><div class="studio-result">' + esc(data.messages.map(m => m.text).join('\n\n') || '아직 저장된 AI 응답이 없습니다. 터미널에서 진행 상태를 확인하세요.') + '</div></article>';
        }));
        if (generation === state.generation) host.innerHTML = '<div class="studio-candidates">' + rows.join('') + '</div>'; return;
      }
      if (state.mode === 'design') { if (generation === state.generation) paintDesign(); return; }
      const review = state.mode === 'review';
      const data = await get(review ? 'changes' : 'files');
      if (generation !== state.generation) return;
      state.changes = data.files; state.fileList = review ? data.files.map(f => f.path) : data.files;
      host.innerHTML = '<div class="studio-code-layout"><div class="studio-files"><input id="studio-file-filter" aria-label="파일 검색" placeholder="파일 검색 · Ctrl P"><div id="studio-files-list"></div></div>'
        + '<div class="studio-editor"><div class="studio-editor-head"><strong id="studio-file-title">파일을 선택하세요</strong>'
        + (review ? '<button class="btn" data-studio="commit">후보 커밋</button><button class="btn primary" data-studio="apply">원본에 반영</button>' : '<button class="btn primary" id="studio-save" data-studio="save" disabled>변경 저장</button>')
        + '</div><div id="studio-file-body"><p class="studio-hint">' + (review ? (data.git ? '변경 줄을 클릭하면 AI에게 검토 코멘트를 보낼 수 있습니다. 원본 반영 전에는 작업자를 중지하고 후보 커밋을 만드세요.' : '일반 폴더는 Git 변경 비교 없이 파일 편집을 사용할 수 있습니다.') : '파일을 선택해 읽고 편집하세요. 저장 시 AI가 바꾼 내용과 충돌하는지 확인합니다.') + '</p></div></div></div>';
      filterFiles(''); if (state.file && state.fileList.includes(state.file)) await openFile(state.file);
    } catch (e) { if (generation === state.generation) host.innerHTML = '<div class="studio-note">' + esc(e.message) + '</div>'; }
  }
  function filterFiles(query) {
    const host = $('#studio-files-list'); if (!host) return;
    host.innerHTML = state.fileList.filter(file => file.toLowerCase().includes(query.toLowerCase())).slice(0, 600).map(file => {
      const changed = state.mode === 'review' && state.changes.find(f => f.path === file);
      return '<button class="studio-file ' + (file === state.file ? 'on' : '') + '" data-studio="file" data-file="' + esc(file) + '">' + esc(file)
        + (changed ? '<small>' + (changed.untracked ? 'NEW' : '+' + esc(changed.added) + ' −' + esc(changed.removed)) + '</small>' : '') + '</button>';
    }).join('') || '<p class="studio-hint">파일이 없습니다.</p>';
  }
  async function openFile(file) {
    if (!discardEditor()) return;
    const generation = ++state.generation, review = state.mode === 'review';
    const data = await get(review ? 'diff' : 'file', { file });
    if (generation !== state.generation) return;
    state.file = file; $('#studio-file-title').textContent = file; filterFiles($('#studio-file-filter').value);
    const host = $('#studio-file-body');
    if (review) {
      let old = 0, fresh = 0;
      host.innerHTML = '<div class="studio-diff">' + data.patch.split('\n').map(line => {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
        if (hunk) { old = Number(hunk[1]); fresh = Number(hunk[2]); }
        const meta = /^(diff |index |--- |\+\+\+ |@@|\\)/.test(line);
        const add = !meta && line.startsWith('+'), del = !meta && line.startsWith('-');
        const lineNo = meta ? 0 : del ? old++ : fresh++;
        if (!meta && !add && !del) old++;
        return '<div class="studio-diff-line ' + (hunk ? 'hunk' : add ? 'add' : del ? 'del' : '') + '" ' + (lineNo ? 'data-studio="comment" data-line="' + lineNo + '" data-side="' + (del ? 'old' : 'new') + '"' : '') + '><span>' + (lineNo || '') + '</span><code>' + esc(line || ' ') + '</code></div>';
      }).join('') + '</div><div class="studio-comments">줄 클릭 → 검토 코멘트 전달'
        + task().notes.filter(n => n.candidateId === candidate().id && n.file === file).slice(-10).map(n => '<div class="studio-comment">L' + n.line + ' · ' + esc(n.text) + '</div>').join('') + '</div>';
    } else {
      host.innerHTML = '<textarea class="studio-source" id="studio-source" spellcheck="false" aria-label="파일 내용"></textarea>';
      $('#studio-source').value = data.text; state.version = data.version; $('#studio-save').disabled = false;
    }
  }
  function paintDesign() {
    const host = $('.studio-content');
    host.innerHTML = '<div class="studio-design-bar"><input id="studio-url" aria-label="로컬 개발 서버 주소" placeholder="http://localhost:3000" value="' + esc(localStorage.getItem('ccl.studio.url.' + state.id) || '') + '">'
      + '<button class="btn primary" data-studio="preview">미리보기 열기</button><button class="btn" data-studio="preview-toggle">' + (state.clickMode ? '클릭 모드' : '요소 선택 모드') + '</button>'
      + '<button class="btn" data-studio="scroll-up" aria-label="미리보기 위로 스크롤">↑</button><button class="btn" data-studio="scroll-down" aria-label="미리보기 아래로 스크롤">↓</button><button class="btn" data-studio="preview-close">닫기</button></div>'
      + '<div class="studio-design-layout"><div class="studio-preview ' + (state.clickMode ? 'click' : '') + '">'
      + (state.preview ? '<img id="studio-preview-image" alt="개발 화면 미리보기. 클릭하면 해당 요소를 선택합니다." src="' + state.preview + '">' : '<div class="studio-empty"><p>로컬 웹 개발 서버를 열어 주세요.<br>화면의 요소를 선택하면 HTML·CSS·캡처를 가져옵니다.</p></div>')
      + '<div class="studio-preview-label">1280 × 800 · Chrome / Edge 렌더링 · ' + (state.clickMode ? '클릭으로 화면 조작' : '클릭으로 요소 선택') + '</div></div><aside class="studio-selection"></aside></div>';
    const img = $('#studio-preview-image'); if (img) img.addEventListener('click', async e => {
      if (operation) return;
      const rect = img.getBoundingClientRect();
      operation = true;
      try {
        const data = await api('preview-act', args({ action: state.clickMode ? 'click' : 'pick', x: (e.clientX - rect.left) / rect.width * 1280, y: (e.clientY - rect.top) / rect.height * 800 }));
        if (state.clickMode) { state.preview = data.image; img.src = data.image; }
        else { state.selection = data; paintSelection(); }
      } catch (e) { notice(e.message, true); } finally { operation = false; }
    });
    paintSelection();
  }
  function paintSelection() {
    const host = $('.studio-selection'); if (!host) return;
    const s = state.selection;
    host.innerHTML = s ? '<h3>' + esc(s.selection.selector) + '</h3><img alt="선택한 요소 캡처" src="' + s.image + '"><pre>' + esc(s.selection.html) + '</pre><details><summary>계산된 CSS</summary><pre>'
      + esc(JSON.stringify(s.selection.css, null, 2)) + '</pre></details><textarea id="studio-design-request" aria-label="선택한 요소 수정 요청" placeholder="예: 이 버튼을 더 크게 하고 파란색으로 바꿔 줘."></textarea><button class="btn primary" data-studio="design-send">선택한 AI에 수정 요청</button>'
      : '<h3>수정할 요소를 선택하세요</h3><p class="studio-hint">선택한 요소의 HTML, 계산된 CSS와 캡처 파일 경로를 AI에게 함께 보냅니다.</p>';
  }
  function openModal(html) {
    closeModal(); modal = document.createElement('div'); modal.className = 'studio-modal';
    modal.innerHTML = '<div class="studio-dialog" role="dialog" aria-modal="true" aria-label="작업 공간 대화상자">' + html + '</div>';
    document.body.appendChild(modal); modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-studio-cancel]')) closeModal(); });
    setTimeout(() => modal?.querySelector('input,textarea,button')?.focus(), 0);
    modal.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const fields = [...modal.querySelectorAll('input,textarea,select,button')].filter(el => !el.disabled && el.getClientRects().length);
      if (e.shiftKey && document.activeElement === fields[0]) { e.preventDefault(); fields.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === fields.at(-1)) { e.preventDefault(); fields[0]?.focus(); }
    });
  }
  let previousFocus;
  function closeModal() { if (modal) { modal.remove(); modal = null; previousFocus?.focus(); } }
  function createDialog() {
    previousFocus = document.activeElement;
    const projects = [...new Set(hooks.projects().map(p => p.cwd).filter(Boolean))];
    openModal('<h2>새 작업 만들기</h2><p>같은 요청을 각 AI의 독립 작업 공간에서 실행하고 결과를 비교합니다.</p><form id="studio-create-form">'
      + '<label class="studio-field">작업 이름<input name="title" required maxlength="160" placeholder="예: 로그인 화면 개선"></label>'
      + '<label class="studio-field">프로젝트 폴더<input name="root" required list="studio-project-options" placeholder="C:\\projects\\my-app" value="' + esc(task()?.root || projects[0] || '') + '"><datalist id="studio-project-options">' + projects.map(p => '<option value="' + esc(p) + '">').join('') + '</datalist></label>'
      + '<label class="studio-field">AI에게 맡길 작업<textarea name="prompt" required maxlength="12000" placeholder="목표와 완료 조건을 구체적으로 적어 주세요."></textarea></label>'
      + '<div class="studio-checks"><label><input type="checkbox" name="claude" checked> Claude</label><label><input type="checkbox" name="codex" checked> Codex</label></div>'
      + '<label class="studio-field">선택한 AI마다 작업자 수<select name="count"><option value="1">각 1개</option><option value="2">각 2개 (최대 4개)</option></select></label>'
      + '<div class="studio-checks"><label><input type="checkbox" name="isolated" checked> 독립 Git 작업 공간 사용</label></div><p class="studio-hint">Git은 현재 커밋을 기준으로 복제합니다. 미커밋 파일·node_modules·.env는 복사되지 않습니다.<br>Git이 없는 폴더는 체크를 해제하고 한 AI만 선택하세요.</p>'
      + '<div class="studio-inline-error" role="alert"></div><div class="studio-dialog-footer"><button class="btn" type="button" data-studio-cancel>취소</button><button class="btn primary" type="submit">작업 공간 만들기</button></div></form>');
    modal.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault(); const form = e.currentTarget, data = new FormData(form), button = form.querySelector('[type=submit]'); button.disabled = true;
      try {
        const providers = ['claude', 'codex'].filter(p => data.has(p)).flatMap(p => Array(Number(data.get('count'))).fill(p));
        const out = await api('create', { title: data.get('title'), root: data.get('root'), prompt: data.get('prompt'), providers, isolated: data.has('isolated') });
        state.tasks.unshift(out.task); closeModal(); await select(out.task.id); notice('작업 공간을 만들었습니다. AI 실행을 누르면 시작합니다.');
      } catch (e) { form.querySelector('.studio-inline-error').textContent = e.message; button.disabled = false; }
    });
  }
  async function quickOpen() {
    if (modal) return;
    previousFocus = document.activeElement;
    openModal('<h2>빠른 열기</h2><label class="studio-field"><input id="studio-quick" aria-label="작업 또는 파일 검색" placeholder="작업 이름 또는 파일 경로 검색…"></label><div class="studio-quick-results"></div><div class="studio-dialog-footer"><button class="btn" data-studio-cancel>닫기</button></div>');
    const box = modal; let files = [];
    if (candidate()) { try { files = (await get('files')).files; } catch {} }
    if (modal !== box) return;
    function draw() {
      const q = box.querySelector('input').value.toLowerCase();
      box.querySelector('.studio-quick-results').innerHTML = state.tasks.filter(t => t.title.toLowerCase().includes(q)).slice(0, 8).map(t => '<button data-task="' + t.id + '">작업 · ' + esc(t.title) + '</button>').join('')
        + files.filter(f => f.toLowerCase().includes(q)).slice(0, 25).map(f => '<button data-file="' + esc(f) + '">파일 · ' + esc(f) + '</button>').join('');
    }
    box.querySelector('input').addEventListener('input', draw); draw();
    box.addEventListener('click', async e => {
      const button = e.target.closest('[data-task],[data-file]'); if (!button) return;
      closeModal();
      if (button.dataset.task) await select(button.dataset.task);
      else { if (!discardEditor()) return; state.mode = 'files'; state.contentKey = ''; paintChrome(); hooks.render(); await content(); await openFile(button.dataset.file); }
    });
  }
  async function handle(e) {
    const button = e.target.closest('[data-studio]'); if (!button) return;
    e.preventDefault();
    if (operation) return;
    const op = button.dataset.studio;
    if (op === 'new') { createDialog(); return; }
    if (op === 'select') { try { await select(button.dataset.id); } catch (e) { notice(e.message, true); } return; }
    if (op === 'file') { try { await openFile(button.dataset.file); } catch (e) { notice(e.message, true); } return; }
    if (op === 'mode' || op === 'review-candidate') {
      if (!discardEditor()) return;
      state.mode = op === 'mode' ? button.dataset.id : 'review'; if (op === 'review-candidate') state.candidate = button.dataset.id;
      state.file = null; state.contentKey = ''; paintChrome(); hooks.render(); await content(); return;
    }
    button.disabled = true;
    try { await action(op, button); } catch (err) { notice(err.message, true); }
    finally { button.disabled = false; }
  }
  async function action(op, button) {
    if (operation) return;
    operation = true;
    try {
      if (op === 'refresh') { await refresh(true); if (discardEditor()) await content(true); return; }
      if (op === 'archive-view') { state.archived = !state.archived; paintSidebar(); return; }
      if (!task()) return;
      if (op === 'archive') { updateTasks(await api('archive', args())); paintChrome(); return; }
      if (op === 'stop') {
        if (!confirm(label(candidate()) + '의 실행을 중지할까요? 진행 중인 응답은 중단되며 작업 파일은 유지됩니다.')) return;
        await api('stop', args({ confirmed: true })); await hooks.loadTerms(); await refresh(true); paintChrome(); notice('선택한 AI를 중지했습니다.'); return;
      }
      if (op === 'start-all' || op === 'start') {
        const targets = op === 'start' ? task().candidates.filter(c => c.id === button.dataset.id) : task().candidates;
        let failure;
        for (const c of targets) { try { updateTasks(await api('start', args({ candidate: c.id }))); } catch (e) { failure = e; } }
        await hooks.loadTerms(); await refresh(true); paintChrome(); hooks.render(); await content(true);
        if (failure) throw failure; notice('AI를 시작했습니다. 시작 확인이 있으면 터미널에서 응답해 주세요.'); return;
      }
      if (op === 'send') {
        const input = $('#studio-prompt'), text = input.value.trim(); if (!text) return;
        const ids = $('#studio-recipient').value === 'all' ? task().candidates.map(c => c.id) : [$('#studio-recipient').value];
        for (const id of ids) await api('send', args({ candidate: id, text }));
        input.value = ''; localStorage.removeItem('ccl.studio.draft.' + state.id); await refresh(true); notice('요청을 전달 대기열에 추가했습니다.'); return;
      }
      if (op === 'save') {
        if (!state.file || !$('#studio-source')) return;
        const out = await api('save', args({ file: state.file, version: state.version, text: $('#studio-source').value }));
        state.version = out.version; editorDirty = false; $('#studio-save').textContent = '변경 저장'; notice('파일을 저장했습니다.'); return;
      }
      if (op === 'comment') {
        const text = prompt(state.file + ' · ' + (button.dataset.side === 'old' ? '이전 코드 ' : '') + 'L' + button.dataset.line + '\nAI에게 전달할 검토 의견을 입력하세요.');
        if (text) { await api('note', args({ file: state.file, line: Number(button.dataset.line), text: (button.dataset.side === 'old' ? '[이전 코드 기준] ' : '') + text })); await refresh(true); notice('검토 의견을 전달 대기열에 추가했습니다.'); } return;
      }
      if (op === 'commit') {
        const message = prompt('선택한 후보의 변경 파일 전체를 커밋합니다.\n커밋 메시지:', task().title); if (!message) return;
        updateTasks(await api('commit', args({ message }))); notice('후보 브랜치에 커밋했습니다.'); await content(true); return;
      }
      if (op === 'apply') {
        if (!confirm('선택한 후보를 원본 프로젝트 브랜치에 반영할까요?\n\n먼저 후보 AI를 중지하고 변경 사항을 커밋해 주세요. 원본에 다른 변경이 있으면 반영을 중단합니다.')) return;
        updateTasks(await api('apply', args({ confirmed: true }))); paintChrome(); notice('선택한 후보를 원본에 반영했습니다.'); return;
      }
      if (op === 'preview') {
        const url = $('#studio-url').value; const out = await api('preview', args({ url }));
        localStorage.setItem('ccl.studio.url.' + state.id, url); state.preview = out.image; state.selection = null; paintDesign(); return;
      }
      if (op === 'preview-toggle') { state.clickMode = !state.clickMode; paintDesign(); return; }
      if (op === 'preview-close') { await api('preview-close', args()); state.preview = null; state.selection = null; paintDesign(); return; }
      if (op === 'scroll-up' || op === 'scroll-down') {
        const out = await api('preview-act', args({ action: 'scroll', delta: op === 'scroll-up' ? -500 : 500 })); state.preview = out.image; paintDesign(); return;
      }
      if (op === 'design-send') { await api('preview-send', args({ capture: state.selection?.id, text: $('#studio-design-request').value })); await refresh(true); notice('요소 정보와 캡처 경로를 전달 대기열에 추가했습니다.'); }
    } finally { operation = false; }
  }
  CC.studio = { init, enter, showTerminals };
})();
