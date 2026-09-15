// Small, bounded inbox over the existing hook stream; no extra polling.
(function () {
  'use strict';
  function kind(ev) {
    if (!ev || !ev.sessionId || ev.agentId) return null;
    if (ev.event === 'PermissionRequest' || (ev.event === 'Notification'
        && (ev.matcher === 'permission_prompt' || ev.text === 'permission_prompt'))) return '승인 요청';
    if (ev.event === 'StopFailure') return '응답 실패';
    if (ev.event === 'Stop') return '응답 완료';
    return null;
  }
  function createInbox() {
    const rows = [], seen = new Set();
    return {
      rows,
      add(ev, historical) {
        const label = kind(ev);
        if (!label) return null;
        const key = [ev.n, ev.at, ev.sessionId, ev.event].join(':');
        if (seen.has(key)) return null;
        seen.add(key);
        if (seen.size > 500) seen.delete(seen.values().next().value);
        const row = { key, label, sessionId: ev.sessionId, provider: ev.provider,
          cwd: ev.cwd, at: ev.at, read: !!historical };
        rows.unshift(row);
        if (rows.length > 50) rows.pop();
        return row;
      },
      readAll() { rows.forEach(row => { row.read = true; }); },
      unread() { return rows.filter(row => !row.read).length; }
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { kind, createInbox }; return;
  }

  const CC = window.CC || (window.CC = {});
  const inbox = createInbox();
  const panel = document.getElementById('attention-panel');
  const list = document.getElementById('attention-list');
  const toggle = document.getElementById('attention-toggle');
  const desktop = document.getElementById('attention-desktop');
  let resolveSession, openSession, hydrated = false, enabled = false;
  try { enabled = localStorage.getItem('ccl.desktopAlerts') === '1'; } catch (_) {}
  function render() {
    toggle.textContent = '알림 ' + inbox.unread();
    desktop.textContent = '데스크톱 알림: ' + (enabled ? '켜짐' : '꺼짐');
    list.replaceChildren();
    if (!inbox.rows.length) { list.textContent = '새 응답 완료·승인 요청·실패가 여기에 표시됩니다. 실시간 관측 훅이 필요합니다.'; return; }
    inbox.rows.forEach(row => {
      const session = resolveSession && resolveSession(row);
      const button = document.createElement('button');
      button.className = 'attention-item' + (row.read ? '' : ' unread');
      const provider = (session && session.provider) || row.provider;
      const project = String(row.cwd || '').split(/[\\/]/).filter(Boolean).pop();
      button.textContent = (row.read ? '' : '● ') + row.label + ' · '
        + (provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'AI')
        + ' · ' + ((session && session.title) || project || row.sessionId.slice(0, 8))
        + ' · ' + new Date(row.at).toLocaleTimeString();
      button.onclick = () => { row.read = true; render(); if (openSession) openSession(row); };
      list.appendChild(button);
    });
  }
  function showDesktop(row) {
    if (!enabled || !document.hidden || !('Notification' in window)
        || Notification.permission !== 'granted') return;
    // Multiple dashboard tabs share one last-event marker. No transcript text in OS banners.
    try {
      if (localStorage.getItem('ccl.lastDesktopAlert') === row.key) return;
      localStorage.setItem('ccl.lastDesktopAlert', row.key);
      const note = new Notification('AI 대시보드 · ' + row.label, {
        body: '대시보드 알림함에서 세션을 확인하세요.', tag: row.key
      });
      note.onclick = () => {
        window.focus(); panel.hidden = false;
        toggle.setAttribute('aria-expanded', 'true'); render(); note.close();
      };
    } catch (_) { /* In-app inbox remains available if OS notifications fail. */ }
  }
  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) render();
  };
  document.getElementById('attention-close').onclick = () => {
    panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus();
  };
  document.getElementById('attention-read').onclick = () => { inbox.readAll(); render(); };
  desktop.onclick = async () => {
    if (enabled) enabled = false;
    else {
      if (!('Notification' in window)) { CC.toast('이 브라우저는 데스크톱 알림을 지원하지 않습니다.', true); return; }
      try {
        const permission = await Notification.requestPermission();
        enabled = permission === 'granted';
        if (!enabled) CC.toast('알림 권한이 없습니다. 브라우저 사이트 설정에서 허용할 수 있습니다.', true);
      } catch (_) { CC.toast('브라우저 알림을 켜지 못했습니다.', true); }
    }
    try { localStorage.setItem('ccl.desktopAlerts', enabled ? '1' : '0'); } catch (_) {}
    render();
  };
  panel.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.stopPropagation(); document.getElementById('attention-close').click(); }
  });
  CC.attention = {
    init(resolve, open) { resolveSession = resolve; openSession = open; render(); },
    update(ev, feed) {
      let historyChanged = false;
      if (!hydrated && feed && feed.length) {
        feed.slice().reverse().forEach(item => { if (item !== ev) inbox.add(item, true); });
        hydrated = true;
        historyChanged = true;
      }
      const row = inbox.add(ev, false);
      if (row) showDesktop(row);
      // Tool progress can be frequent; leave the inbox DOM intact until its contents change.
      if (row || historyChanged) render();
    }
  };
})();
