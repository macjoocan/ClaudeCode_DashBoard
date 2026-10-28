(function () {
  'use strict';
  const CC = window.CC || (window.CC = {});
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let modal, inventory, hooks, busy = false;
  const names = { running: '실행 확인', stale: '종료 표시 남음', closed: '종료된 터미널', unknown: '실행 확인 안 됨' };
  const statuses = { busy: '작업 중', waiting: '확인 대기', idle: '대기 중' };
  function close() { if (!busy) { modal?.remove(); modal = null; document.querySelector('#cleanup-open').focus(); } }
  async function load() {
    const res = await fetch('/api/cleanup?fresh=1', { cache: 'no-store' });
    if (!res.headers.get('content-type')?.includes('application/json')) throw new Error('세션 정리 기능을 사용하려면 대시보드 서버를 재시작해 주세요.');
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error);
    inventory = data;
    if (!modal) return;
    modal.querySelector('#cleanup-summary').textContent = data.rows.filter(r => r.type === 'running').length + '개 실행 확인 · '
      + data.rows.filter(r => r.type === 'unknown').length + '개 확인 안 됨 · ' + data.rows.filter(r => ['stale', 'closed'].includes(r.type)).length + '개 종료 표시';
    draw();
  }
  function draw() {
    const filter = modal.querySelector('#cleanup-filter').value;
    const rows = inventory.rows.filter(r => {
      if (filter === 'all') return true;
      if (filter === 'idle') return r.type === 'running' && r.status === 'idle' && Date.now() - r.at > 3600000;
      return r.type === filter;
    });
    modal.querySelector('#cleanup-rows').innerHTML = rows.map(r => '<label class="cleanup-row"><input type="checkbox" value="' + esc(r.key) + '" ' + (['stale', 'closed'].includes(r.type) ? 'checked' : '') + '>'
      + '<span class="cleanup-row-main"><b>' + esc(r.title) + '</b><small>' + esc(r.cwd || r.id || '') + '</small><small>' + esc(r.reason) + '</small></span>'
      + '<span class="cleanup-row-state"><span class="studio-tag">' + (r.provider === 'codex' ? 'Codex' : 'Claude') + '</span><small>' + names[r.type] + ' · ' + statuses[r.status] + '</small>'
      + '<small>' + (r.at ? new Date(r.at).toLocaleString('ko-KR') : '시각 알 수 없음') + '</small></span></label>').join('') || '<p class="studio-hint">해당하는 세션이 없습니다.</p>';
    count();
  }
  function selected() { return [...modal.querySelectorAll('#cleanup-rows input:checked')].map(i => inventory.rows.find(r => r.key === i.value)); }
  function count() { modal.querySelector('#cleanup-count').textContent = selected().length + '개 선택'; }
  async function execute(mode) {
    const rows = selected(); if (!rows.length) { hooks.toast('정리할 세션을 선택해 주세요.', true); return; }
    if (mode === 'dismiss' && !confirm('선택한 ' + rows.length + '개 세션의 실행 표시만 해제할까요?\n\n실행 여부를 확정할 수 없는 세션은 계속 실행 중일 수도 있습니다. 프로세스는 종료하지 않으며 대화와 작업 파일도 유지합니다. 다음 활동이 감지되면 실행 중 목록에 다시 나타납니다.')) return;
    if (mode === 'stop') {
      const invalid = rows.filter(r => !r.killable);
      if (invalid.length) { hooks.toast('실제 실행을 확인한 세션만 종료할 수 있습니다. 종료된 표시는 표시 정리, 확인 안 된 항목은 목록 숨김을 사용하세요.', true); return; }
      const working = rows.filter(r => r.status === 'busy').length;
      if (!confirm('선택한 ' + rows.length + '개 AI 세션을 종료할까요?' + (working ? '\n작업 중인 세션 ' + working + '개가 포함되어 있습니다.' : '')
        + '\n\n' + rows.slice(0, 12).map(r => (r.provider === 'codex' ? 'Codex' : 'Claude') + ' · ' + r.title.slice(0, 70)).join('\n')
        + (rows.length > 12 ? '\n외 ' + (rows.length - 12) + '개' : '') + '\n\n진행 중인 응답은 중단됩니다. 대화 기록과 작업 파일은 삭제하지 않습니다.')) return;
    }
    busy = true;
    modal.querySelectorAll('button,select,input').forEach(el => { el.disabled = true; });
    const report = modal.querySelector('#cleanup-report'); report.textContent = '대상 상태를 다시 확인하고 정리하는 중…';
    try {
      const res = await fetch('/api/cleanup/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inventory.token, keys: rows.map(r => r.key), mode, confirmed: ['stop', 'dismiss'].includes(mode) }) });
      const data = await res.json(); if (!res.ok || data.error) throw new Error(data.error);
      report.textContent = data.done.length + '개 처리 완료' + (data.failed.length ? ' · ' + data.failed.length + '개 건너뜀\n' + data.failed.map(f => (inventory.rows.find(r => r.key === f.key)?.title || f.key) + ': ' + f.error).join('\n') : '')
        + (mode !== 'hide' ? '\n정리한 상태 표시는 백업에 보관됩니다. 대화 기록은 유지됩니다.' : ' · 숨긴 세션은 목록의 숨김 항목에서 다시 표시할 수 있습니다.');
      await hooks.reload(); await load();
    } catch (e) { report.textContent = e.message; }
    finally { busy = false; modal?.querySelectorAll('button,select,input').forEach(el => { el.disabled = false; }); }
  }
  async function open() {
    if (modal) return;
    modal = document.createElement('div'); modal.className = 'studio-modal';
    modal.innerHTML = '<div class="studio-dialog cleanup-dialog" role="dialog" aria-modal="true" aria-label="실행 중 세션 정리"><h2>실행 중 세션 정리</h2>'
      + '<p>종료 표시만 남은 항목을 치우거나, 오래 대기 중인 세션을 선택해 종료하세요. 실행 확인이 안 되는 항목은 프로세스 종료 없이 목록에서 숨길 수 있습니다.</p><div id="cleanup-summary" class="studio-note">실제 프로세스를 확인하는 중…</div>'
      + '<div class="studio-actions"><select class="btn" id="cleanup-filter" aria-label="정리 대상 필터"><option value="all">전체 상태</option><option value="stale">종료 표시 남음</option><option value="closed">종료된 터미널</option><option value="idle">1시간 이상 대기 중</option><option value="running">실행 확인</option><option value="unknown">실행 확인 안 됨</option></select>'
      + '<button class="btn" id="cleanup-select-all">표시 항목 전체 선택</button><button class="btn" id="cleanup-select-none">선택 해제</button><span class="studio-hint" id="cleanup-count">0개 선택</span></div>'
      + '<div id="cleanup-rows"></div><div id="cleanup-report" role="status" aria-live="polite"></div><div class="studio-dialog-footer"><button class="btn" id="cleanup-close">닫기</button>'
      + '<button class="btn" data-cleanup="hide">선택 목록 숨김</button><button class="btn" data-cleanup="dismiss">실행 표시만 해제</button><button class="btn" data-cleanup="clean">종료된 표시 정리</button><button class="btn primary" data-cleanup="stop">선택 세션 종료</button></div></div>';
    document.body.appendChild(modal);
    modal.querySelector('#cleanup-close').addEventListener('click', close);
    modal.querySelector('#cleanup-filter').addEventListener('change', draw);
    modal.querySelector('#cleanup-select-all').addEventListener('click', () => { modal.querySelectorAll('#cleanup-rows input').forEach(i => { i.checked = true; }); count(); });
    modal.querySelector('#cleanup-select-none').addEventListener('click', () => { modal.querySelectorAll('#cleanup-rows input').forEach(i => { i.checked = false; }); count(); });
    modal.addEventListener('change', count);
    modal.addEventListener('click', e => { const button = e.target.closest('[data-cleanup]'); if (button && !busy) execute(button.dataset.cleanup); else if (e.target === modal) close(); });
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const els = [...modal.querySelectorAll('button,input,select')].filter(el => !el.disabled);
        if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0]?.focus(); }
      }
    });
    modal.querySelector('#cleanup-filter').focus();
    try { await load(); } catch (e) { if (modal) modal.querySelector('#cleanup-report').textContent = e.message; }
  }
  CC.cleanup = { init(options) { hooks = options; document.querySelector('#cleanup-open').addEventListener('click', open); } };
})();
