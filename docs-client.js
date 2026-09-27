import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { insert, replaceAll } from '@milkdown/kit/utils';
import { buildTree, headingsFromMarkdown, isDocumentModified, resolveRelativePath } from './docs-navigation.mjs';
import { readDraft, saveDraft, clearDraft } from './docs-drafts.mjs';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

const $ = id => document.getElementById(id);
let root = '', file = '', version = '', original = '', dirty = false, mode = 'visual';
let editor = null, loading = false, saving = false;
let sideTab = 'files', treeInitialized = false, readFromRaw = false;
let lastVisualMarkdown = '', savedVisualMarkdown = '';
const expandedDirs = new Set();

async function api(op, extra = {}) {
  const response = await fetch('/api/docs', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, root, ...extra }) });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || '문서 요청 실패');
  return data.result;
}
function status(message, error = false) { $('status').textContent = message; $('status').style.color = error ? '#d97979' : ''; }
function hasUnsavedChanges() {
  return isDocumentModified({ file, mode, original, source: $('source').value,
    visual: editor ? editor.getMarkdown() : '', savedVisual: savedVisualMarkdown, readFromRaw });
}
function changed() {
  dirty = hasUnsavedChanges();
  $('name').textContent = (file || '문서') + (dirty ? ' ●' : '');
  status(dirty ? '저장되지 않은 변경 사항' : '변경 사항 없음');
  persistDraft();
  requestAnimationFrame(renderOutline);
}
function currentText() {
  if (!hasUnsavedChanges()) return original;
  return mode === 'raw' || (mode === 'read' && readFromRaw) ? $('source').value : editor.getMarkdown();
}
function replaceDocument(markdown) {
  editor.editor.action(replaceAll(markdown));
  // Milkdown sends markdownUpdated after a 200 ms debounce. Record the loaded
  // content now so that the later event is not mistaken for a user edit.
  lastVisualMarkdown = editor.getMarkdown();
}

function persistDraft() {
  if (!file) return;
  try {
    if (hasUnsavedChanges()) saveDraft(localStorage, root, file, currentText(), version);
    else clearDraft(localStorage, root, file);
  } catch { status('임시저장 공간이 부족합니다. Ctrl+S로 파일을 저장해 주세요.', true); }
}

function assetUrl(url) {
  const relative = resolveRelativePath(file, url);
  if (!relative || !root) return url;
  return '/api/docs/asset?root=' + encodeURIComponent(root) + '&file=' + encodeURIComponent(relative);
}

async function uploadImage(image) {
  if (!root || !file) throw new Error('이미지를 넣기 전에 문서를 먼저 여세요');
  const query = new URLSearchParams({ root, file });
  const response = await fetch('/api/docs/image?' + query, { method: 'POST', body: image });
  const data = await response.json().catch(() => ({ error: '이미지 기능을 사용하려면 대시보드 서버를 재시작하세요' }));
  if (!response.ok || data.error) throw new Error(data.error || '이미지를 저장하지 못했습니다');
  return data.result.path;
}

function expandParents(name) {
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) expandedDirs.add(parts.slice(0, i).join('/'));
}

function renderTree(paths) {
  const tree = buildTree(paths);
  if (!treeInitialized) {
    for (const name of tree.folders.keys()) expandedDirs.add(name);
    treeInitialized = true;
  }
  const container = $('files');
  container.replaceChildren();
  if (!paths.length) { container.innerHTML = '<div class="empty">마크다운 문서가 없습니다.</div>'; return; }
  function addNode(node, parent, prefix) {
    for (const [name, child] of node.folders) {
      const folderPath = prefix ? prefix + '/' + name : name;
      const details = document.createElement('details');
      details.className = 'tree-folder'; details.open = expandedDirs.has(folderPath);
      const summary = document.createElement('summary');
      summary.textContent = name; summary.title = folderPath;
      details.appendChild(summary);
      const children = document.createElement('div'); children.className = 'tree-children';
      addNode(child, children, folderPath);
      details.appendChild(children);
      details.addEventListener('toggle', () => {
        if (details.open) expandedDirs.add(folderPath); else expandedDirs.delete(folderPath);
      });
      parent.appendChild(details);
    }
    for (const entry of node.files) {
      const button = document.createElement('button');
      button.textContent = entry.name; button.title = entry.path;
      button.classList.toggle('active', entry.path.toLowerCase() === file.toLowerCase());
      button.onclick = () => open(entry.path);
      parent.appendChild(button);
    }
  }
  addNode(tree, container, '');
}

function renderOutline() {
  const container = $('outline');
  container.replaceChildren();
  if (!file) { container.innerHTML = '<div class="empty">문서를 열면 제목이 표시됩니다.</div>'; return; }
  const headings = mode === 'raw' ? headingsFromMarkdown($('source').value) :
    Array.from($('editor').querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'))
      .map((element, index) => ({ level: Number(element.tagName[1]), text: element.textContent, index, element }));
  if (!headings.length) { container.innerHTML = '<div class="empty">제목이 없습니다. # 제목을 추가해 보세요.</div>'; return; }
  for (const heading of headings) {
    const button = document.createElement('button');
    button.textContent = heading.text || '제목 없음';
    button.style.paddingLeft = 8 + (heading.level - 1) * 13 + 'px';
    button.title = heading.text;
    button.onclick = () => {
      if (mode === 'raw') {
        const source = $('source');
        const position = source.value.split(/\r?\n/).slice(0, heading.line).join('\n').length + (heading.line ? 1 : 0);
        source.focus(); source.setSelectionRange(position, position);
        source.scrollTop = source.scrollHeight * (heading.line / Math.max(1, source.value.split(/\r?\n/).length - 1));
      } else heading.element.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    container.appendChild(button);
  }
}

function selectSideTab(next) {
  sideTab = next;
  $('files').hidden = next !== 'files'; $('outline').hidden = next !== 'outline';
  for (const key of ['files', 'outline']) {
    const button = $(key + '-tab');
    button.classList.toggle('active', key === next);
    button.setAttribute('aria-pressed', String(key === next));
  }
  if (next === 'outline') renderOutline();
}

function applyMode() {
  document.body.classList.toggle('source-mode', mode === 'raw');
  document.body.classList.toggle('read-mode', mode === 'read');
  for (const key of ['read', 'visual', 'raw']) $(key).classList.toggle('active', mode === key);
  $('image').disabled = !file || mode === 'read';
  if (editor) editor.editor.action(ctx => ctx.get(editorViewCtx).setProps({ editable: () => mode !== 'read' }));
  renderOutline();
}

async function ensureEditor() {
  if (editor) return;
  editor = new Crepe({ root: $('editor'), defaultValue: '', features: { [Crepe.Feature.AI]: false,
    [Crepe.Feature.TopBar]: true }, featureConfigs: {
    [Crepe.Feature.ImageBlock]: { onUpload: uploadImage, proxyDomURL: assetUrl }
  } });
  editor.on(listener => listener.markdownUpdated((_ctx, markdown) => {
    if (loading || !file || markdown === lastVisualMarkdown) return;
    lastVisualMarkdown = markdown;
    if (mode === 'visual') changed();
  }));
  await editor.create();
}
async function showMode(next) {
  if (!file || next === mode) return;
  if (next === 'visual' && /^---\s*\r?\n/.test(original) &&
      !confirm('이 문서에는 YAML 머리말이 있습니다. 문서 모드에서 수정하면 특수 문법이 바뀔 수 있습니다. 계속하시겠습니까?')) return;
  await ensureEditor();
  loading = true;
  if (next === 'raw' && !readFromRaw) $('source').value = currentText();
  if (mode === 'raw' && next !== 'raw') {
    replaceDocument($('source').value);
    if ($('source').value === original) savedVisualMarkdown = lastVisualMarkdown;
    readFromRaw = next === 'read';
  } else if (next === 'visual') readFromRaw = false;
  mode = next;
  applyMode();
  loading = false;
  changed();
}
async function refresh() {
  if (!root) { $('files').innerHTML = '<div class="empty">위에서 폴더를 고르세요.</div>'; return; }
  const data = await api('list');
  renderTree(data.files);
}
async function open(name, discardConfirmed = false) {
  if (saving) return status('저장이 끝난 뒤 문서를 열어 주세요', true);
  const discard = hasUnsavedChanges();
  if (discard && !discardConfirmed && !confirm('저장되지 않은 변경 사항을 버리고 다른 문서를 여시겠습니까?')) return;
  try {
    const data = await api('read', { file: name });
    if (discard) clearDraft(localStorage, root, file);
    const draft = readDraft(localStorage, root, name);
    let recovered = null;
    if (draft && draft.text !== data.text) {
      if (confirm('저장하지 않은 임시 문서가 있습니다. 복구하시겠습니까?')) recovered = draft;
      else clearDraft(localStorage, root, name);
    } else if (draft) clearDraft(localStorage, root, name);
    await ensureEditor();
    loading = true;
    file = name; version = data.version; original = data.text; dirty = false; readFromRaw = false;
    expandParents(name);
    $('source').value = recovered ? recovered.text : original;
    replaceDocument(original);
    savedVisualMarkdown = lastVisualMarkdown;
    if (recovered) {
      replaceDocument(recovered.text);
      version = recovered.baseVersion;
    }
    // Show recovered text exactly as stored. A visual round trip can normalize
    // whitespace or Markdown syntax before the user saves the recovered draft.
    mode = recovered || /^---\s*\r?\n/.test(original) ? 'raw' : 'visual';
    dirty = hasUnsavedChanges();
    $('name').textContent = name + (dirty ? ' ●' : '');
    applyMode();
    loading = false;
    await refresh();
    status(recovered ? (recovered.baseVersion === data.version ?
      '임시저장본을 복구했습니다 · Ctrl+S로 파일에 저장하세요' :
      '임시저장본을 복구했습니다 · 원본 파일도 변경되어 저장 시 충돌이 날 수 있습니다') :
      mode === 'raw' ? 'YAML 머리말이 있어 마크다운 원문으로 열었습니다' : '열림 · Ctrl+S로 저장');
  } catch (e) { loading = false; status(e.message, true); }
}
async function save() {
  if (!file || saving) return;
  const text = currentText();
  saving = true;
  $('save').disabled = true;
  try {
    const data = await api('write', { file, text, version });
    version = data.version; original = text;
    if (mode === 'visual' || (mode === 'read' && !readFromRaw)) savedVisualMarkdown = text;
    if (editor) lastVisualMarkdown = editor.getMarkdown();
    dirty = hasUnsavedChanges();
    $('name').textContent = file + (dirty ? ' ●' : '');
    status(dirty ? '저장 중에 수정한 내용이 남아 있습니다' : '저장했습니다');
    persistDraft();
    await refresh();
  } catch (e) { status(e.message, true); }
  finally { saving = false; $('save').disabled = false; }
}
async function setRoot(next, openFile) {
  if (saving) {
    window.parent.postMessage({ type: 'docs:root-rejected', root }, location.origin);
    return status('저장이 끝난 뒤 폴더를 바꿔 주세요', true);
  }
  const discard = hasUnsavedChanges();
  if (discard && !confirm('저장되지 않은 변경 사항을 버리고 폴더를 바꾸시겠습니까?')) {
    window.parent.postMessage({ type: 'docs:root-rejected', root }, location.origin);
    return;
  }
  if (discard) clearDraft(localStorage, root, file);
  root = next; file = ''; version = ''; original = ''; dirty = false; readFromRaw = false;
  treeInitialized = false; expandedDirs.clear();
  loading = true;
  $('source').value = '';
  if (editor) replaceDocument('');
  else lastVisualMarkdown = '';
  savedVisualMarkdown = lastVisualMarkdown;
  mode = 'visual';
  applyMode();
  loading = false;
  localStorage.setItem('ccl.docs.root', root);
  $('name').textContent = '문서를 선택하세요';
  try { await refresh(); if (openFile) await open(openFile); }
  catch (e) { status(e.message, true); }
}
$('visual').onclick = () => showMode('visual');
$('read').onclick = () => showMode('read');
$('raw').onclick = () => showMode('raw');
$('files-tab').onclick = () => selectSideTab('files');
$('outline-tab').onclick = () => selectSideTab('outline');
$('sidebar-toggle').onclick = () => {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  $('sidebar-toggle').textContent = collapsed ? '☰ 목록' : '☰';
  $('sidebar-toggle').title = collapsed ? '문서 목록 펼치기' : '문서 목록 접기';
  $('sidebar-toggle').setAttribute('aria-label', $('sidebar-toggle').title);
  localStorage.setItem('ccl.docs.sidebar-collapsed', String(collapsed));
};
$('save').onclick = save;
$('image').onclick = () => $('image-file').click();
$('image-file').onchange = async () => {
  const image = $('image-file').files?.[0];
  $('image-file').value = '';
  if (!image || !file || mode === 'read') return;
  const destination = file, destinationRoot = root;
  try {
    status('이미지를 저장하는 중…');
    const relative = await uploadImage(image);
    if (file !== destination || root !== destinationRoot) return status('문서가 바뀌어 이미지 삽입을 취소했습니다', true);
    const alt = image.name.replace(/[\[\]\r\n]/g, ' ');
    const markdown = `![${alt}](${relative})`;
    if (mode === 'raw') {
      const source = $('source');
      source.setRangeText(markdown, source.selectionStart, source.selectionEnd, 'end');
      changed();
    } else editor.editor.action(insert(markdown));
  } catch (error) { status(error.message, true); }
};
$('reload').onclick = () => refresh().catch(e => status(e.message, true));
$('source').oninput = changed;
$('editor').addEventListener('click', event => {
  const anchor = event.target.closest?.('a[href]');
  if (!anchor || !file || (mode !== 'read' && !event.ctrlKey && !event.metaKey)) return;
  const target = resolveRelativePath(file, anchor.getAttribute('href'));
  if (!target || !/\.(md|markdown)$/i.test(target)) return;
  event.preventDefault();
  open(target);
}, true);
$('new').onclick = async () => {
  if (saving) return status('저장이 끝난 뒤 문서를 만드세요', true);
  if (!root) return status('먼저 폴더를 고르세요', true);
  if (hasUnsavedChanges() && !confirm('저장되지 않은 변경 사항을 버리고 새 문서를 여시겠습니까?')) return;
  const name = prompt('새 문서 이름 (.md)', '새 문서.md');
  if (!name) return;
  try { await api('create', { file: name }); await refresh(); await open(name, true); }
  catch (e) { status(e.message, true); }
};
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', e => {
  persistDraft();
  if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) persistDraft(); });
window.addEventListener('message', e => {
  if (e.origin !== location.origin || !e.data || e.data.type !== 'docs:open') return;
  if (e.data.root === root && e.data.file) open(e.data.file);
  else setRoot(e.data.root || '', e.data.file || '');
});
if (localStorage.getItem('ccl.docs.sidebar-collapsed') === 'true') $('sidebar-toggle').click();
renderOutline();
setRoot(localStorage.getItem('ccl.docs.root') || '', '').finally(() => {
  window.parent.postMessage({ type: 'docs:ready' }, location.origin);
});
