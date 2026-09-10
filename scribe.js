// SCRIBE(마크다운 편집기)를 대시보드 안에서 띄운다.
//
// SCRIBE 는 파일 접근을 전부 `window.scribe` 브리지 하나로만 한다 (Electron 의
// preload 가 넣어주던 것). 그래서 **그 브리지만 HTTP 로 갈아끼우면 빌드 결과물을
// 고치지 않고 그대로 쓸 수 있다.** 여기가 그 서버 쪽이다.
//
// 파일을 읽고 쓰는 실제 코드는 SCRIBE 의 desktop/vault.cjs 를 그대로 require 한다.
// 베껴오면 원본이 고쳐질 때 갈라진다. 그 파일은 Electron 을 참조하지 않는 순수
// Node 라 그냥 불러진다 (경로 탈출·심링크 방어도 거기 들어 있다).

const fs = require('fs');
const path = require('path');
const os = require('os');

// ------------------------------------------------------------ SCRIBE 찾기

function findScribe() {
  const tries = [];
  if (process.env.CC_SCRIBE_DIR) tries.push(process.env.CC_SCRIBE_DIR);
  // 런처가 <루트>/Claude_code/cc-launcher 라면 <루트>/Scribe/editor 를 본다
  const up2 = path.dirname(path.dirname(__dirname));
  tries.push(path.join(up2, 'Scribe', 'editor'));
  tries.push(path.join(path.dirname(__dirname), 'Scribe', 'editor'));
  tries.push(path.join(os.homedir(), 'Scribe', 'editor'));

  for (const dir of tries) {
    try {
      if (fs.existsSync(path.join(dir, 'dist', 'index.html'))
        && fs.existsSync(path.join(dir, 'desktop', 'vault.cjs'))) {
        return path.resolve(dir);
      }
    } catch {}
  }
  return null;
}

const SCRIBE_DIR = findScribe();
const DIST_DIR = SCRIBE_DIR ? path.join(SCRIBE_DIR, 'dist') : null;

let vaultApi = null, searchApi = null, loadError = null;
if (SCRIBE_DIR) {
  try {
    vaultApi = require(path.join(SCRIBE_DIR, 'desktop', 'vault.cjs'));
    searchApi = require(path.join(SCRIBE_DIR, 'desktop', 'search.cjs'));
  } catch (e) {
    loadError = String((e && e.message) || e);
  }
}

function available() {
  return !!(DIST_DIR && vaultApi && searchApi);
}
function status() {
  return {
    ok: available(),
    scribeDir: SCRIBE_DIR,
    error: loadError || (SCRIBE_DIR ? null : 'SCRIBE 를 찾지 못했습니다'),
    vault: STATE.vault,
  };
}

// ------------------------------------------------------------ 상태 보관
//
// 보관 폴더·설정·임시저장은 런처 폴더가 아니라 사용자 홈에 둔다.
// 런처를 다시 받아도 남아 있어야 하고, 깃에 들어가면 안 된다.

const HOME_DIR = path.join(os.homedir(), '.claude', 'cc-launcher-scribe');
const STATE_FILE = path.join(HOME_DIR, 'state.json');
const DRAFT_DIR = path.join(HOME_DIR, 'drafts');

let STATE = { vault: null, settings: {} };
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (raw && typeof raw === 'object') {
    STATE.vault = typeof raw.vault === 'string' ? raw.vault : null;
    STATE.settings = (raw.settings && typeof raw.settings === 'object') ? raw.settings : {};
  }
} catch {}
// 보관 폴더가 없어졌으면 기억에서 지운다
if (STATE.vault && !fs.existsSync(STATE.vault)) STATE.vault = null;

function saveState() {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2), 'utf8');
  } catch {}
}

function requireVault() {
  if (!available()) throw new Error(status().error || 'SCRIBE 를 쓸 수 없습니다');
  if (!STATE.vault) throw new Error('보관 폴더가 열려 있지 않습니다.');
  if (!fs.existsSync(STATE.vault)) throw new Error('보관 폴더가 없어졌습니다: ' + STATE.vault);
  return STATE.vault;
}

function setVault(dir) {
  if (!dir) throw new Error('폴더 경로가 필요합니다');
  const full = path.resolve(String(dir));
  if (!fs.existsSync(full)) throw new Error('없는 폴더입니다: ' + full);
  if (!fs.statSync(full).isDirectory()) throw new Error('폴더가 아닙니다: ' + full);
  STATE.vault = full;
  saveState();
  return listing();
}

function listing() {
  return vaultApi.listVault(requireVault());
}

// ------------------------------------------------------------ 임시 저장(초안)
//
// 저장하지 않고 브라우저를 닫아도 내용이 남게 한다. 보관 폴더별로 갈라 둔다.

function draftKey(file) {
  const tag = (STATE.vault || '') + '|' + file;
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return h.toString(36) + '.json';
}
function draftSave(file, text) {
  if (typeof file !== 'string' || typeof text !== 'string')
    throw new Error('임시 저장할 내용이 올바르지 않습니다.');
  fs.mkdirSync(DRAFT_DIR, { recursive: true });
  const saved = Date.now();
  fs.writeFileSync(path.join(DRAFT_DIR, draftKey(file)),
    JSON.stringify({ vault: STATE.vault, path: file, text, saved }), 'utf8');
  return { saved };
}
function draftList() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(DRAFT_DIR); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, name), 'utf8'));
      // 지금 열려 있는 보관 폴더의 초안만 돌려준다
      if (v && v.vault === STATE.vault && typeof v.path === 'string' && typeof v.text === 'string')
        out.push({ path: v.path, text: v.text, saved: Number(v.saved) || 0 });
    } catch {}   // 깨진 초안 하나 때문에 복구 전체가 막히면 안 된다
  }
  return out;
}
function draftClear(file) {
  if (typeof file !== 'string') return { ok: true };
  try { fs.rmSync(path.join(DRAFT_DIR, draftKey(file)), { force: true }); } catch {}
  return { ok: true };
}

// ------------------------------------------------------------ 브리지 동작

function readAllDocuments() {
  const base = requireVault();
  return listing().entries
    .filter(e => e.kind === 'markdown')
    .map(e => {
      try { return { path: e.path, text: vaultApi.readDocument(base, e.path).text }; }
      catch { return { path: e.path, text: '' }; }
    });
}

// 목록이 바뀌었는지 값싸게 판단할 지문. 폴링으로 새 파일을 알아채는 데 쓴다.
function listStamp() {
  try {
    const l = listing();
    let h = 0;
    for (const e of l.entries) {
      const s = e.path + '|' + (e.size || 0) + '|' + Math.floor((e.modified || 0) / 1000);
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return { stamp: h.toString(36) + '.' + l.entries.length, root: l.root };
  } catch (e) {
    return { stamp: 'none', error: String((e && e.message) || e) };
  }
}

function run(op, b) {
  switch (op) {
    case 'status':  return status();
    case 'stamp':   return listStamp();

    case 'set-vault': return { listing: setVault(b.dir) };
    case 'current': {
      if (!available() || !STATE.vault) return { listing: null };
      try { return { listing: listing() }; } catch { return { listing: null }; }
    }
    case 'list':    return { listing: listing() };
    case 'read':    return vaultApi.readDocument(requireVault(), b.file);
    case 'write':   return vaultApi.writeDocument(requireVault(), b.file, b.text);

    case 'create': {
      const base = requireVault();
      const free = vaultApi.freePath(base, b.file);
      return vaultApi.writeDocument(base, free, typeof b.text === 'string' ? b.text : '');
    }
    case 'rename': {
      const base = requireVault();
      const from = vaultApi.resolveInVault(base, b.file);
      const free = vaultApi.freePath(base, b.target);
      const to = vaultApi.resolveInVault(base, free);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      const info = fs.statSync(to);
      return { path: free, modified: info.mtimeMs, size: info.size };
    }
    case 'remove': {
      const base = requireVault();
      const file = vaultApi.resolveInVault(base, b.file);
      // 지우지 않고 휴지통으로 옮긴다. 편집기에서 실수로 지우면 되돌릴 길이 있어야 한다.
      const trashDir = path.join(HOME_DIR, 'trash',
        new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(file, path.join(trashDir, path.basename(file)));
      return { path: b.file, trashed: trashDir };
    }

    case 'read-all': return { documents: readAllDocuments() };
    case 'search':   return { hits: searchApi.search(readAllDocuments(), b.query, b.options) };

    case 'replace-all': {
      const base = requireVault();
      let files = 0, hits = 0;
      for (const doc of readAllDocuments()) {
        const r = searchApi.replaceInText(doc.text, b.query, b.replacement, b.options);
        if (!r || !r.hits) continue;
        vaultApi.writeDocument(base, doc.path, r.text);
        files++; hits += r.hits;
      }
      return { files, hits };
    }

    case 'asset-url': {
      vaultApi.resolveInVault(requireVault(), b.file);
      return { url: '/api/md/asset?p=' + encodeURIComponent(b.file) };
    }

    case 'settings-get': return STATE.settings || {};
    case 'settings-set': {
      STATE.settings = (b.value && typeof b.value === 'object') ? b.value : {};
      saveState();
      return STATE.settings;
    }

    case 'draft-save':  return draftSave(b.file, b.text);
    case 'draft-list':  return { drafts: draftList() };
    case 'draft-clear': return draftClear(b.file);

    default: throw new Error('알 수 없는 작업: ' + op);
  }
}

// 붙여넣은 이미지 저장. 본문이 JSON 이 아니라 원본 바이트라 따로 둔다.
function saveImage(file, buf) {
  const base = requireVault();
  if (!buf || !buf.length) throw new Error('이미지 데이터가 올바르지 않습니다.');
  if (buf.length > vaultApi.MAX_BYTES) throw new Error('8 MB가 넘는 이미지입니다.');
  const free = vaultApi.freePath(base, file);
  const target = vaultApi.resolveInVault(base, free);
  if (vaultApi.kindOf(target) !== 'image') throw new Error('이미지 파일이 아닙니다.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  return { path: free, modified: Date.now(), size: buf.length };
}

// 보관 폴더 안의 이미지를 그대로 내려준다
function assetPath(rel) {
  const base = requireVault();
  const file = vaultApi.resolveInVault(base, rel);
  if (vaultApi.kindOf(file) !== 'image') throw new Error('이미지가 아닙니다.');
  if (!fs.existsSync(file)) throw new Error('파일이 없습니다.');
  return file;
}

// ------------------------------------------------------------ dist 서빙
//
// index.html 에만 브리지 스크립트를 끼워 넣는다. SCRIBE 원본은 건드리지 않는다.

function distFile(rel) {
  if (!DIST_DIR) return null;
  const clean = path.normalize(rel || 'index.html').replace(/^(\.\.[\\/])+/, '');
  const full = path.join(DIST_DIR, clean);
  if (!path.resolve(full).startsWith(path.resolve(DIST_DIR))) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return full;
}

function indexHtml() {
  const file = distFile('index.html');
  if (!file) throw new Error('SCRIBE 빌드 결과물이 없습니다');
  let html = fs.readFileSync(file, 'utf8');
  // 앱 번들보다 **먼저** 실행돼야 window.scribe 가 준비된다
  const shim = '<script src="/scribe-bridge.js"></script>\n    ';
  const at = html.indexOf('<script type="module"');
  if (at < 0) throw new Error('SCRIBE index.html 구조가 바뀌었습니다');
  return html.slice(0, at) + shim + html.slice(at);
}

module.exports = {
  available, status, run, saveImage, assetPath, distFile, indexHtml,
  get vault() { return STATE.vault; },
};
