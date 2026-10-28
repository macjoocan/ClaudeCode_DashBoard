'use strict';
const fs = require('node:fs');
const path = require('node:path');

// An alias changes dashboard routing only; never rewrite provider transcripts/DBs.
function normalize(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) throw new Error('절대 폴더 경로를 입력해 주세요');
  const full = path.normalize(raw);
  return full.length > path.parse(full).root.length ? full.replace(/[\\/]+$/, '') : full;
}
const key = value => normalize(value).toLowerCase();
function createProjectPaths(file) {
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('invalid aliases');
    rows = rows.map(r => ({ from: normalize(r.from), to: normalize(r.to) }));
  } catch (e) { if (e.code !== 'ENOENT') throw new Error('프로젝트 경로 연결 파일을 읽지 못했습니다: ' + e.message); }
  function resolve(value, entries = rows, descendants = false) {
    if (!value || !path.isAbsolute(value)) return value;
    let current = normalize(value);
    const seen = new Set();
    for (let i = 0; i <= entries.length; i++) {
      const k = key(current);
      if (seen.has(k)) throw new Error('프로젝트 경로가 순환 연결됩니다');
      seen.add(k);
      const hit = entries.filter(r => k === key(r.from) || (descendants && k.startsWith(key(r.from) + path.sep)))
        .sort((a, b) => b.from.length - a.from.length)[0];
      if (!hit) return current;
      current = path.join(hit.to, path.relative(hit.from, current));
    }
    throw new Error('프로젝트 경로 연결이 너무 깊습니다');
  }
  function set(from, to) {
    from = normalize(from); to = normalize(to);
    if (path.parse(from).root === from || path.parse(to).root === to) throw new Error('드라이브 전체가 아닌 프로젝트 폴더를 선택해 주세요');
    if (key(from) === key(to)) throw new Error('이전 경로와 새 경로가 같습니다');
    if (!fs.statSync(to).isDirectory()) throw new Error('새 경로가 폴더가 아닙니다');
    const next = [...rows.filter(r => key(r.from) !== key(from)), { from, to }];
    for (const r of next) resolve(r.from, next, true);
    // Atomic replacement, preserving the previous config on write/rename failure.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
    rows = next;
    return { from, to: resolve(from) };
  }
  return { resolve: value => resolve(value), resolveFile: value => resolve(value, rows, true),
    set, list: () => rows.map(r => ({ ...r })), key };
}
module.exports = { createProjectPaths, normalize, key };
