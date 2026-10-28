// 대시보드의 "폰 연결" 버튼과 창. QR 을 띄우고, 연결된 폰을 보여주고 끊는다.
// index.html 을 덜 건드리려고 버튼도 여기서 붙인다(알림 버튼 옆).
(function () {
  'use strict';
  var anchor = document.getElementById('attention-toggle');
  if (!anchor || !window.CCQR) return;

  var css = document.createElement('style');
  css.textContent = [
    '#mp-modal{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:16px}',
    '#mp-box{background:var(--panel,#1d211d);color:var(--fg,#e6ebe6);border:1px solid var(--line,#333);border-radius:10px;',
    'width:min(440px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:18px 20px;display:grid;gap:12px}',
    '#mp-box h3{margin:0;font-size:16px}#mp-box p{margin:0;font-size:13px;color:var(--dim,#9aa59b)}',
    '#mp-qr{justify-self:center;background:#fff;padding:6px;border-radius:6px;line-height:0}',
    '#mp-qr svg{width:240px;height:240px}',
    '#mp-url{font:12px/1.4 Consolas,monospace;word-break:break-all;user-select:all;background:var(--panel3,#252a25);padding:8px;border-radius:6px}',
    '.mp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.mp-row select{flex:1;min-width:0}',
    '.mp-dev{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13px;padding:6px 0;border-top:1px solid var(--line,#333)}',
    '.mp-warn{font-size:12px;color:var(--warn,#e7a85a)}',
  ].join('');
  document.head.appendChild(css);

  var btn = document.createElement('button');
  btn.className = 'btn ghost';
  btn.id = 'mobile-toggle';
  btn.title = '같은 와이파이의 폰에서 QR 을 찍어 이 대시보드 터미널을 이어서 쓴다';
  btn.textContent = '📱 폰';
  anchor.parentNode.insertBefore(btn, anchor);

  var modal = null, timer = null, last = null, urlIndex = 0;
  function api(p, body) {
    return fetch(p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw new Error(j.error); return j; });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(t) { var s = Math.round((Date.now() - t) / 1000); return s < 60 ? '방금' : s < 3600 ? Math.round(s / 60) + '분 전' : Math.round(s / 3600) + '시간 전'; }

  function render(st) {
    var box = modal.querySelector('#mp-box');
    var html = '<h3>폰으로 이어서 하기</h3>';
    if (last && last.urls && last.urls.length && st.pairingUntil) {
      var url = last.urls[Math.min(urlIndex, last.urls.length - 1)];
      var left = Math.max(0, Math.round((st.pairingUntil - Date.now()) / 1000));
      html += '<p>폰 카메라로 찍으세요. <b>' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + '</b> 뒤 만료되고, 한 번 쓰면 끝납니다.</p>'
        + '<div id="mp-qr">' + window.CCQR.toSvg(window.CCQR.encode(url, 'M'), 6) + '</div>'
        + '<div id="mp-url">' + esc(url) + '</div>';
      if (last.addresses.length > 1) {
        html += '<div class="mp-row"><span style="font-size:12px">주소</span><select id="mp-addr">'
          + last.addresses.map(function (a, i) { return '<option value="' + i + '"' + (i === urlIndex ? ' selected' : '') + '>' + esc(a.address + ' · ' + a.name) + '</option>'; }).join('')
          + '</select></div><p>폰이 못 찾으면 다른 주소를 골라 보세요(와이파이 쪽 주소여야 합니다).</p>';
      }
    } else if (st.on) {
      html += '<p>폰 연결이 켜져 있습니다. 새 폰을 붙이려면 QR 을 새로 띄우세요.</p>';
    } else {
      html += '<p>켜면 이 PC 의 ' + 7789 + ' 포트가 같은 와이파이에 열립니다. QR 을 찍은 폰만 들어올 수 있습니다.</p>';
    }
    html += '<div class="mp-row"><button class="btn" id="mp-pair">' + (st.on ? 'QR 새로 띄우기' : '켜고 QR 띄우기') + '</button>'
      + (st.on ? '<button class="btn ghost" id="mp-stop">폰 연결 끄기</button>' : '')
      + '<button class="btn ghost" id="mp-close">닫기</button></div>';
    html += '<p class="mp-warn">폰에서 이 PC 터미널에 그대로 입력할 수 있습니다. 같은 와이파이의 다른 사람이 오가는 내용을 엿볼 수 있으니(암호화 없는 http) 회사·공용 와이파이에서는 쓰고 나서 꺼 주세요.</p>';
    html += '<div><b style="font-size:13px">연결된 폰 ' + st.devices.length + '대</b>'
      + st.devices.map(function (d) {
        return '<div class="mp-dev"><span>' + esc(d.name) + ' · ' + (d.live ? '<b>지금 보는 중</b>' : '마지막 ' + ago(d.lastSeenAt)) + '</span>'
          + '<button class="btn ghost" data-revoke="' + esc(d.id) + '">끊기</button></div>';
      }).join('') + '</div>';
    box.innerHTML = html;
  }

  function refresh() {
    return api('/api/mobile').then(function (st) {
      if (!st.pairingUntil) last = last && st.on ? last : null;
      render(st);
    }).catch(function (e) { modal.querySelector('#mp-box').innerHTML = '<h3>폰으로 이어서 하기</h3><p>대시보드 서버를 재시작해야 쓸 수 있습니다. (' + esc(e.message) + ')</p><button class="btn ghost" id="mp-close">닫기</button>'; });
  }

  function open() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'mp-modal';
    modal.innerHTML = '<div id="mp-box" role="dialog" aria-label="폰으로 이어서 하기"></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) {
      var t = e.target;
      if (t === modal || t.id === 'mp-close') return close();
      if (t.id === 'mp-pair') {
        t.disabled = true;
        api('/api/mobile/pair', {}).then(function (j) { last = j; urlIndex = 0; render(j.status); })
          .catch(function (err) { alertBox(err.message); });
      } else if (t.id === 'mp-stop') {
        api('/api/mobile/stop', {}).then(function (st) { last = null; render(st); });
      } else if (t.dataset.revoke) {
        api('/api/mobile/revoke', { id: t.dataset.revoke }).then(function (j) { render(j.status); });
      }
    });
    modal.addEventListener('change', function (e) {
      if (e.target.id === 'mp-addr') { urlIndex = Number(e.target.value) || 0; refresh(); }
    });
    document.addEventListener('keydown', onKey);
    refresh();
    timer = setInterval(refresh, 2000);
  }
  function alertBox(msg) {
    var p = document.createElement('p');
    p.className = 'mp-warn';
    p.textContent = msg.indexOf('EADDRINUSE') >= 0 ? '7789 포트를 다른 프로그램이 쓰고 있습니다.' : msg;
    modal.querySelector('#mp-box').appendChild(p);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    clearInterval(timer); timer = null;
    document.removeEventListener('keydown', onKey);
    if (modal) modal.remove();
    modal = null;
  }
  btn.addEventListener('click', open);
})();
