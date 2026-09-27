'use strict';
const fs = require('node:fs');
const path = require('node:path');

function resolveMarkdownPath(input, cwd, roots = []) {
  const raw = String(input || '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!raw) throw new Error('경로가 비어 있습니다');
  if (!/\.(md|markdown)$/i.test(raw)) throw new Error('마크다운 파일이 아닙니다');
  const full = path.resolve(path.isAbsolute(raw) ? raw : path.join(String(cwd || ''), raw));
  let stat;
  try { stat = fs.statSync(full); } catch {}
  if (stat) {
    if (!stat.isFile()) throw new Error('파일이 아닙니다: ' + full);
    return { full, dir: path.dirname(full), file: path.basename(full) };
  }
  if (path.isAbsolute(raw)) throw new Error('파일을 찾지 못했습니다: ' + full);

  const found = new Map();
  function consider(base) {
    const candidate = path.resolve(base, raw);
    try {
      if (!fs.statSync(candidate).isFile()) return;
      const real = fs.realpathSync(candidate);
      found.set(real.toLowerCase(), real);
    } catch {}
  }
  for (const root of roots.slice(0, 200)) {
    if (typeof root !== 'string' || !root) continue;
    consider(root);
    let entries;
    try { entries = fs.readdirSync(path.join(root, '.worktrees'), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries.slice(0, 100)) {
      if (entry.isDirectory()) consider(path.join(root, '.worktrees', entry.name));
    }
  }
  if (found.size > 1) throw new Error('같은 문서를 여러 작업 폴더에서 찾았습니다: ' + [...found.values()].join(', '));
  if (!found.size) throw new Error('파일을 찾지 못했습니다: ' + full);
  const match = [...found.values()][0];
  return { full: match, dir: path.dirname(match), file: path.basename(match) };
}

module.exports = { resolveMarkdownPath };
