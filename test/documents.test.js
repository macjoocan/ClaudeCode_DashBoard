'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const docs = require('../documents');

test('Markdown document can be created, read, saved and listed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-'));
  try {
    const created = docs.create(root, 'note.md');
    assert.equal(created.text, '');
    const saved = docs.write(root, 'note.md', '# 제목\n\n본문\n', created.version);
    assert.equal(docs.read(root, 'note.md').text, '# 제목\n\n본문\n');
    assert.deepEqual(docs.list(root), ['note.md']);
    assert.throws(() => docs.write(root, 'note.md', '오래된 저장', created.version), /변경/);
    assert.equal(saved.version, docs.read(root, 'note.md').version);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('outside paths and non-Markdown files are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-'));
  try {
    assert.throws(() => docs.create(root, '../escape.md'), /폴더 안/);
    assert.throws(() => docs.create(root, 'note.txt'), /폴더 안/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('inaccessible nested folders do not hide accessible Markdown documents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-'));
  const blocked = path.join(root, 'blocked');
  const original = fs.readdirSync;
  try {
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(root, 'visible.md'), '# visible');
    fs.readdirSync = function (dir, options) {
      if (dir === blocked) {
        const error = new Error('access denied');
        error.code = 'EPERM';
        throw error;
      }
      return original.call(this, dir, options);
    };
    assert.deepEqual(docs.list(root), ['visible.md']);
  } finally {
    fs.readdirSync = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uploaded images stay beside their Markdown document and resolve safely', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    docs.create(root, 'docs/note.md');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const saved = docs.saveImage(root, 'docs/note.md', png);
    assert.match(saved.path, /^assets\/[a-f0-9]{64}\.png$/);
    const asset = docs.assetPath(root, 'docs/' + saved.path);
    assert.equal(asset.mime, 'image/png');
    assert.deepEqual(fs.readFileSync(asset.full), png);
    assert.throws(() => docs.assetPath(root, '../outside.png'), /폴더 밖/);
    assert.throws(() => docs.saveImage(root, 'docs/note.md', Buffer.from('<html>')), /이미지/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
