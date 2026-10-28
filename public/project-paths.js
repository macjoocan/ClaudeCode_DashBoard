(function () {
  'use strict';
  let hooks, modal;
  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!(res.headers.get('content-type') || '').includes('application/json')) throw new Error('대시보드 서버를 재시작한 뒤 다시 시도해 주세요');
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '요청 실패');
    return data;
  }
  function open(from) {
    if (modal) return;
    const opener = document.activeElement;
    modal = document.createElement('div'); modal.className = 'studio-modal';
    modal.innerHTML = '<form class="studio-dialog" role="dialog" aria-modal="true" aria-label="프로젝트 폴더 다시 연결">'
      + '<h2>프로젝트 폴더 다시 연결</h2><p>C → D 이동 등으로 바뀐 프로젝트 폴더를 지정하세요. 원본 대화 기록과 즐겨찾기는 유지합니다.</p>'
      + '<label>이전 폴더<input name="from" readonly style="width:100%"></label>'
      + '<label>새 프로젝트 폴더<input name="to" required placeholder="D:\\Projects\\프로젝트명" style="width:100%"></label>'
      + '<button type="button" class="btn" data-browse>폴더 선택…</button>'
      + '<p>선택한 프로젝트 한 개만 연결합니다. 하위 프로젝트는 각각 연결하세요. 실행 중인 세션은 변경하지 않으며, 이후 시작·이어하기부터 적용됩니다.</p>'
      + '<p>파일을 이동하거나 Git worktree를 복구하는 기능은 아닙니다. 대화 안의 과거 경로는 남을 수 있으니 AI에도 새 작업 경로를 알려주세요.</p>'
      + '<p role="status" data-status></p><div class="studio-dialog-footer"><button type="button" class="btn" data-cancel>취소</button><button class="btn primary" type="submit">확인 후 연결</button></div></form>';
    const form = modal.querySelector('form'), status = modal.querySelector('[data-status]');
    form.elements.from.value = from;
    let busy = false;
    function close() { if (!busy) { modal.remove(); modal = null; opener?.focus(); } }
    modal.querySelector('[data-cancel]').onclick = close;
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const controls = [...modal.querySelectorAll('input,button')].filter(el => !el.disabled);
        if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0].focus(); }
      }
    });
    modal.querySelector('[data-browse]').onclick = async () => {
      if (busy) return;
      busy = true; status.textContent = '폴더 선택 중…';
      try { const j = await post('/api/pickfolder', { start: form.elements.to.value || from }); if (!j.cancelled) form.elements.to.value = j.path; status.textContent = ''; }
      catch (e) { status.textContent = e.message; }
      finally { busy = false; }
    };
    form.onsubmit = async e => {
      e.preventDefault(); if (busy) return;
      const to = form.elements.to.value.trim();
      if (!confirm('이 프로젝트를 새 폴더에 연결할까요?\n\n' + from + '\n→ ' + to + '\n\n기존 대화 파일은 수정하지 않습니다. 실행 중인 세션은 그대로 둡니다.')) return;
      busy = true; form.querySelectorAll('button,input').forEach(el => { el.disabled = true; });
      try {
        await post('/api/projects/reconnect', { from, to, confirm: true });
        busy = false; close(); hooks.toast('프로젝트 폴더를 다시 연결했습니다'); await hooks.reload();
      } catch (err) { status.textContent = err.message; }
      finally { busy = false; if (modal) form.querySelectorAll('button,input').forEach(el => { el.disabled = false; }); }
    };
    document.body.appendChild(modal); form.elements.to.focus();
  }
  window.CC = window.CC || {};
  CC.projectPaths = { init(options) { hooks = options; document.addEventListener('click', e => {
    const button = e.target.closest('[data-reconnect]'); if (button) { e.preventDefault(); open(button.dataset.reconnect); }
  }); } };
})();
