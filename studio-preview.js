'use strict';

// On-demand local Chromium preview, using CDP directly (no additional package or
// separate application install). Screenshots reflect the real layout engine.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

function localUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('http://localhost:3000 같은 개발 서버 주소를 입력해 주세요'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw new Error('이 미리보기는 로컬 개발 서버 주소만 지원합니다');
  return url.href;
}
function browserPath() {
  return [process.env.CC_STUDIO_BROWSER,
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].find(p => p && fs.existsSync(p)) || null;
}
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('브라우저 연결 시간 초과')); }, 10000);
    ws.once('open', () => { clearTimeout(timeout); resolve(); });
    ws.once('error', e => { clearTimeout(timeout); reject(e); });
  });
  ws.on('error', () => {});
  ws.on('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('미리보기 브라우저 연결이 끊겼습니다')); } pending.clear(); });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result || {});
  });
  return { close: () => ws.close(), call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('미리보기 응답 시간 초과: ' + method)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }), e => { if (e) { pending.delete(id); clearTimeout(timer); reject(e); } });
    });
  } };
}
function pickElement(x, y) {
  let el = document.elementFromPoint(x, y);
  if (!el) return null;
  while (el.shadowRoot && el.shadowRoot.elementFromPoint(x, y)) {
    const next = el.shadowRoot.elementFromPoint(x, y); if (next === el) break; el = next;
  }
  const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
  const props = ['display', 'position', 'width', 'height', 'padding', 'margin', 'gap', 'color', 'background-color',
    'font-family', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'box-shadow', 'align-items', 'justify-content'];
  const css = Object.fromEntries(props.map(key => [key, style.getPropertyValue(key)]));
  let selector = el.tagName.toLowerCase();
  if (el.id) selector += '#' + CSS.escape(el.id);
  else if (el.classList.length) selector += '.' + [...el.classList].slice(0, 4).map(c => CSS.escape(c)).join('.');
  const clone = el.cloneNode(true);
  for (const field of [clone, ...clone.querySelectorAll('input,textarea,[contenteditable]')]) {
    if (field.matches('input,textarea,[contenteditable]')) { field.removeAttribute('value'); field.textContent = ''; }
  }
  for (const node of clone.querySelectorAll('script')) node.remove();
  return { selector, html: clone.outerHTML.slice(0, 6000), css, url: location.href,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY } };
}

function createPreview({ stateDir }) {
  let browser = null, processHandle = null, opening = null, closed = false;
  const pages = new Map(), captures = new Map();
  async function ensureBrowser() {
    if (closed) throw new Error('미리보기가 종료되었습니다');
    if (browser) return browser;
    if (opening) return opening;
    opening = (async () => {
      const bin = browserPath();
      if (!bin) throw new Error('Chrome 또는 Edge를 찾지 못했습니다. CC_STUDIO_BROWSER에 실행 파일 경로를 지정할 수 있습니다');
      fs.mkdirSync(stateDir, { recursive: true });
      const profile = fs.mkdtempSync(path.join(stateDir, 'browser-'));
      const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
        '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'],
      { windowsHide: true, stdio: 'ignore' });
      processHandle = proc;
      let failure;
      proc.once('error', e => { failure = e; });
      proc.once('exit', () => {
        if (processHandle === proc) { browser = null; processHandle = null; pages.clear(); }
        // Only the disposable profile made by this invocation is removed.
        if (path.dirname(path.resolve(profile)) === path.resolve(stateDir) && path.basename(profile).startsWith('browser-'))
          fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }, () => {});
      });
      try {
        const start = Date.now();
        let active;
        while (Date.now() - start < 12000) {
          if (closed || failure || proc.exitCode != null) throw failure || new Error('미리보기 브라우저를 시작하지 못했습니다');
          try { active = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n'); } catch {}
          if (active?.[1]) break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (!active?.[1]) throw new Error('Chrome 디버깅 포트를 열지 못했습니다');
        const client = await connect(`ws://127.0.0.1:${Number(active[0])}${active[1]}`);
        browser = { client, port: Number(active[0]) }; return browser;
      } catch (e) { proc.kill(); throw e; }
    })();
    try { return await opening; } finally { opening = null; }
  }
  // Serialize navigation, screenshot and selection for each preview. Otherwise a
  // slow navigation could attach a screenshot to a different URL/element.
  const operations = new Map();
  function serial(key, fn) {
    const p = (operations.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    operations.set(key, p);
    return p.finally(() => { if (operations.get(key) === p) operations.delete(key); });
  }
  async function page(key) {
    const b = await ensureBrowser();
    if (pages.has(key)) return pages.get(key);
    if (pages.size >= 4) throw new Error('미리보기는 최대 4개 작업까지 열 수 있습니다. 사용하지 않는 미리보기를 닫아 주세요');
    const { targetId } = await b.client.call('Target.createTarget', { url: 'about:blank' });
    const p = { targetId, client: await connect(`ws://127.0.0.1:${b.port}/devtools/page/${targetId}`) };
    await p.client.call('Page.enable');
    await p.client.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    pages.set(key, p); return p;
  }
  async function screenshot(p) {
    const shot = await p.client.call('Page.captureScreenshot', { format: 'png' });
    return { image: 'data:image/png;base64,' + shot.data, width: 1280, height: 800 };
  }
  function navigate(key, value) {
    const url = localUrl(value);
    return serial(key, async () => {
      const p = await page(key);
      const result = await p.client.call('Page.navigate', { url });
      if (result.errorText) throw new Error('개발 서버를 열지 못했습니다: ' + result.errorText);
      for (let i = 0; i < 40; i++) {
        const state = await p.client.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        const frame = await p.client.call('Page.getFrameTree');
        if (frame.frameTree?.frame.loaderId === result.loaderId && state.result?.value === 'complete') break;
        await new Promise(r => setTimeout(r, 100));
      }
      p.url = url;
      return { ...await screenshot(p), url };
    });
  }
  function act(key, input) {
    return serial(key, async () => {
      const p = pages.get(key);
      if (!p) throw new Error('먼저 개발 서버 미리보기를 열어 주세요');
      if (input.action === 'scroll') {
        await p.client.call('Runtime.evaluate', { expression: `scrollBy(0,${Math.max(-800, Math.min(800, Number(input.delta) || 0))})` });
        return screenshot(p);
      }
      const x = Number(input.x), y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= 1280 || y >= 800) throw new Error('미리보기 안의 요소를 선택해 주세요');
      if (input.action === 'click') {
        await p.client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await p.client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return screenshot(p);
      }
      const result = await p.client.call('Runtime.evaluate', { expression: `(${pickElement.toString()})(${x},${y})`, returnByValue: true });
      const selection = result.result?.value;
      if (!selection) throw new Error('요소 정보를 읽지 못했습니다');
      const r = selection.rect;
      const clip = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width + Math.min(0, r.x), 1280 - Math.max(0, r.x)),
        height: Math.min(r.height + Math.min(0, r.y), 800 - Math.max(0, r.y)), scale: 1 };
      if (clip.width < 1 || clip.height < 1) throw new Error('화면에 보이는 요소를 선택해 주세요');
      clip.x += selection.scroll.x; clip.y += selection.scroll.y;
      const shot = await p.client.call('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
      const id = crypto.randomUUID(), dir = path.join(stateDir, 'captures');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, id + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      captures.set(id, { key, selection, file });
      if (captures.size > 100) captures.delete(captures.keys().next().value);
      return { id, selection, image: 'data:image/png;base64,' + shot.data };
    });
  }
  function message(key, id, instruction) {
    const capture = captures.get(id);
    if (!capture || capture.key !== key) throw new Error('선택한 요소가 만료되었습니다. 다시 선택해 주세요');
    instruction = String(instruction || '').trim();
    if (!instruction || instruction.length > 4000) throw new Error('수정 요청을 4,000자 이내로 입력해 주세요');
    const s = capture.selection;
    return `[Design Mode 수정 요청]\n${instruction}\n\n주소: ${s.url}\n요소: ${s.selector}\n화면 좌표: ${JSON.stringify(s.rect)}\n캡처 파일: ${capture.file}\n\nHTML:\n${s.html}\n\n계산된 CSS:\n${JSON.stringify(s.css, null, 2)}`;
  }
  async function release(key) {
    return serial(key, async () => {
      const p = pages.get(key); if (!p) return;
      p.client.close(); pages.delete(key);
      if (browser) await browser.client.call('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
    });
  }
  return { available: () => !!browserPath(), navigate, act, message, release,
    close() { closed = true; for (const p of pages.values()) p.client.close(); pages.clear(); browser?.client.close(); processHandle?.kill(); } };
}

module.exports = { createPreview, localUrl, pickElement };
