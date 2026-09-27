export function buildTree(paths) {
  const root = { folders: new Map(), files: [] };
  for (const file of paths) {
    const parts = file.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ name: parts.at(-1), path: file });
  }
  return root;
}

export function headingsFromMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headings = [];
  let fence = null;
  let frontmatter = lines[0] === '---';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontmatter) {
      if (i > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = line.match(/^ {0,3}(#{1,6})(?:\s+|$)(.*)$/);
    if (atx) {
      headings.push({ level: atx[1].length, text: atx[2].replace(/\s+#+\s*$/, '').trim(), line: i });
      continue;
    }
    if (i > 0 && /^ {0,3}(=+|-+)\s*$/.test(line) && lines[i - 1].trim()) {
      const previous = lines[i - 1].trim();
      if (!/^[#>\-*+\d`~|]/.test(previous)) {
        headings.push({ level: line.trim()[0] === '=' ? 1 : 2, text: previous, line: i - 1 });
      }
    }
  }
  return headings;
}

export function isDocumentModified({ file, mode, original, source, visual, savedVisual, readFromRaw }) {
  if (!file) return false;
  return mode === 'raw' || (mode === 'read' && readFromRaw)
    ? source !== original
    : visual !== savedVisual;
}

export function resolveRelativePath(documentFile, href) {
  if (!documentFile || !href || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return null;
  const raw = href.split(/[?#]/, 1)[0];
  if (!raw) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw).replace(/\\/g, '/'); }
  catch { return null; }
  const parts = decoded.startsWith('/') ? [] : documentFile.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (part.includes(':') || part.includes('\0')) return null;
    else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}
