// Local Markdown documents. Paths are always resolved beneath a selected folder.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv', '__pycache__']);

function rootPath(root) {
  const full = fs.realpathSync(String(root || ''));
  if (!fs.statSync(full).isDirectory()) throw new Error('폴더가 아닙니다');
  return full;
}

function filePath(root, file, creating = false) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file)) throw new Error('파일 경로가 올바르지 않습니다');
  const base = rootPath(root);
  const full = path.resolve(base, file);
  const rel = path.relative(base, full);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || !/\.(md|markdown)$/i.test(full))
    throw new Error('폴더 안의 마크다운 파일만 열 수 있습니다');
  const check = creating ? path.dirname(full) : full;
  const real = fs.realpathSync(check);
  const realRel = path.relative(base, real);
  if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel))
    throw new Error('폴더 밖의 파일은 열 수 없습니다');
  return full;
}

function version(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function list(root) {
  const base = rootPath(root);
  const files = [];
  function walk(dir) {
    if (files.length >= 2000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (dir !== base && ['EACCES', 'EPERM'].includes(error.code)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name))
        files.push(path.relative(base, path.join(dir, entry.name)).replace(/\\/g, '/'));
      if (files.length >= 2000) break;
    }
  }
  walk(base);
  return files.sort((a, b) => a.localeCompare(b, 'ko'));
}

function read(root, file) {
  const full = filePath(root, file);
  const stat = fs.statSync(full);
  if (stat.size > MAX_BYTES) throw new Error('8 MB가 넘는 문서입니다');
  const bytes = fs.readFileSync(full);
  return { file, text: bytes.toString('utf8'), version: version(bytes) };
}

function write(root, file, text, expectedVersion) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('8 MB가 넘는 문서입니다');
  const full = filePath(root, file);
  const current = fs.readFileSync(full);
  if (expectedVersion !== version(current)) throw new Error('파일이 다른 곳에서 변경됐습니다. 새로 읽고 변경 내용을 확인하세요.');
  const bytes = Buffer.from(text, 'utf8');
  const tmp = full + '.cc-launcher-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    fs.renameSync(tmp, full);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  return { file, version: version(bytes) };
}

function create(root, file) {
  const full = filePath(root, file, true);
  fs.writeFileSync(full, '', { flag: 'wx' });
  return read(root, file);
}

function within(base, target) {
  const rel = path.relative(base, target);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new Error('PNG, JPEG, GIF, WebP 이미지만 올릴 수 있습니다');
}

function saveImage(root, documentFile, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw new Error('이미지는 8 MB 이하여야 합니다');
  const doc = filePath(root, documentFile);
  const ext = imageExtension(bytes);
  const base = rootPath(root);
  const dir = path.join(path.dirname(doc), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  if (!within(base, fs.realpathSync(dir))) throw new Error('폴더 밖에 이미지를 저장할 수 없습니다');
  const name = version(bytes) + '.' + ext;
  const target = path.join(dir, name);
  try { fs.writeFileSync(target, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.readFileSync(target).equals(bytes)) throw new Error('같은 이름의 이미지가 이미 있습니다');
  }
  return { path: 'assets/' + name, bytes: bytes.length };
}

function assetPath(root, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file)) throw new Error('이미지 경로가 올바르지 않습니다');
  const base = rootPath(root);
  const full = path.resolve(base, file);
  if (!within(base, full) || !within(base, fs.realpathSync(full))) throw new Error('폴더 밖의 파일은 열 수 없습니다');
  const ext = path.extname(full).slice(1).toLowerCase();
  if (!IMAGE_TYPES[ext]) throw new Error('이미지 파일이 아닙니다');
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('이미지 파일이 아닙니다');
  if (stat.size > MAX_BYTES) throw new Error('8 MB가 넘는 이미지입니다');
  return { full, mime: IMAGE_TYPES[ext] };
}

function run(op, body) {
  const root = body.root;
  if (op === 'list') return { files: list(root) };
  if (op === 'read') return read(root, body.file);
  if (op === 'write') return write(root, body.file, body.text, body.version);
  if (op === 'create') return create(root, body.file);
  throw new Error('알 수 없는 문서 작업');
}

module.exports = { run, list, read, write, create, filePath, saveImage, assetPath };
