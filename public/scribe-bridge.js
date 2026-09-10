// SCRIBE 가 파일에 닿는 유일한 통로인 `window.scribe` 를 HTTP 로 구현한다.
//
// Electron 에서는 preload 가 IPC 로 이 객체를 넣어줬다. 여기서는 대시보드 서버의
// /api/md 로 보낸다. **모양만 같으면 SCRIBE 빌드물은 자기가 어디서 도는지 모른다.**
// 그래서 SCRIBE 소스를 한 줄도 고치지 않고 그대로 쓸 수 있다.
//
// 이 스크립트는 앱 번들보다 먼저 실행돼야 한다 (서버가 index.html 에 끼워 넣는다).
(function () {
  'use strict';

  function call(op, body) {
    return fetch('/api/md', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ op: op }, body || {})),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      return j.result;
    });
  }

  // 보관 폴더는 대시보드(부모 창)가 고른다. 편집기 안에서 폴더 창을 띄우면
  // iframe 뒤에 가려 보이지 않을 수 있어, 부모에게 요청하고 결과만 받는다.
  function askParentForVault() {
    return new Promise(function (resolve) {
      if (window.parent === window) return resolve(null);
      var done = false;
      function onMsg(e) {
        if (!e.data || e.data.type !== 'scribe:vault-picked') return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(e.data.listing || null);
      }
      window.addEventListener('message', onMsg);
      window.parent.postMessage({ type: 'scribe:pick-vault' }, location.origin);
      // 사용자가 창을 닫아버리면 영영 안 온다. 3분 뒤 포기한다.
      setTimeout(function () {
        if (done) return;
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 180000);
    });
  }

  // ---------------------------------------------------------- 보관 폴더 감시
  //
  // 웹 터미널에서 만든 .md 가 편집기 목록에 바로 뜨게 한다.
  // Electron 은 파일 감시(watch)를 썼지만 여기서는 값싼 지문을 폴링한다.
  var watchers = [];
  var lastStamp = null;
  var timer = null;

  function tick() {
    if (!watchers.length || document.hidden) return;
    call('stamp').then(function (s) {
      if (!s || !s.stamp || s.stamp === 'none') return;
      if (lastStamp === null) { lastStamp = s.stamp; return; }
      if (s.stamp === lastStamp) return;
      lastStamp = s.stamp;
      return call('list').then(function (r) {
        watchers.forEach(function (fn) { try { fn(r.listing); } catch (e) {} });
      });
    }).catch(function () {});
  }
  function ensureTimer() {
    if (timer) return;
    timer = setInterval(tick, 3000);
  }

  window.scribe = {
    openVault: function () { return askParentForVault(); },

    currentVault: function () { return call('current').then(function (r) { return r.listing; }); },
    list: function () { return call('list').then(function (r) { return r.listing; }); },

    read:   function (file) { return call('read', { file: file }); },
    write:  function (file, text) { return call('write', { file: file, text: text }); },
    create: function (file, text) { return call('create', { file: file, text: text }); },
    rename: function (file, target) { return call('rename', { file: file, target: target }); },
    remove: function (file) { return call('remove', { file: file }); },

    readAll: function () { return call('read-all').then(function (r) { return r.documents; }); },
    search:  function (query, options) {
      return call('search', { query: query, options: options }).then(function (r) { return r.hits; });
    },
    replaceAll: function (query, replacement, options) {
      return call('replace-all', { query: query, replacement: replacement, options: options });
    },

    // 붙여넣은 이미지. 바이트는 JSON 에 실을 수 없어 따로 보낸다.
    saveImage: function (file, bytes) {
      var buf = bytes instanceof ArrayBuffer ? bytes : (bytes && bytes.buffer) || bytes;
      return fetch('/api/md/image?p=' + encodeURIComponent(file), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: buf,
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) throw new Error(j.error);
        return j.result;
      });
    },
    assetUrl: function (file) { return call('asset-url', { file: file }).then(function (r) { return r.url; }); },

    // 내보내기는 Electron 의 저장 대화상자에 기대던 기능이라 브라우저에서는 없다.
    // null 을 돌려주면 SCRIBE 가 "취소" 로 보고 조용히 넘어간다.
    exportHtml: function () { return Promise.resolve(null); },
    exportPdf:  function () { return Promise.resolve(null); },

    draft: {
      save:  function (file, text) { return call('draft-save', { file: file, text: text }); },
      list:  function () { return call('draft-list').then(function (r) { return r.drafts; }); },
      clear: function (file) { return call('draft-clear', { file: file }).then(function () {}); },
    },

    settings: {
      get: function () { return call('settings-get'); },
      set: function (value) { return call('settings-set', { value: value }); },
    },

    onVaultChanged: function (cb) {
      watchers.push(cb);
      ensureTimer();
      return function () {
        var i = watchers.indexOf(cb);
        if (i >= 0) watchers.splice(i, 1);
      };
    },

    // Electron 메뉴에서 오던 명령. 부모 창이 대신 보낼 수 있게 열어 둔다.
    onCommand: function (cb) {
      function onMsg(e) {
        if (e.data && e.data.type === 'scribe:command') { try { cb(e.data.command); } catch (err) {} }
      }
      window.addEventListener('message', onMsg);
      return function () { window.removeEventListener('message', onMsg); };
    },
  };

  // 탭으로 돌아오면 바로 한 번 본다 (3초를 기다리지 않게)
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
