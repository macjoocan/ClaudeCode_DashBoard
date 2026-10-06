'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('Windows clipboard helper uses STA, hidden process, UTF8 and preserves multiple paths', async () => {
  const { readClipboardFiles } = require('../clipboard-files');
  let launch;
  const result = await readClipboardFiles({ platform: 'win32', stat: () => ({ isFile: () => true, size: 5 }),
    execFile(bin, args, opts, cb) { launch = { bin, args, opts }; cb(null, JSON.stringify(['C:\\한글 이미지.png', 'D:\\two.pdf'])); } });
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].path, 'C:\\한글 이미지.png');
  assert.ok(launch.args.includes('-STA')); assert.equal(launch.opts.windowsHide, true);
  assert.equal(launch.opts.encoding, 'utf8'); assert.ok(launch.opts.timeout > 0);
});
test('folders, missing paths and relative paths are skipped', async () => {
  const { readClipboardFiles } = require('../clipboard-files');
  const result = await readClipboardFiles({ platform: 'win32',
    execFile(bin, args, opts, cb) { cb(null, JSON.stringify(['C:\\ok.png', 'C:\\folder', 'C:\\missing', 'relative.png'])); },
    stat(p) { if (p.endsWith('missing')) throw new Error('ENOENT'); return { isFile: () => p.endsWith('png'), size: 5 }; } });
  assert.deepEqual(result.files.map(f => f.path), ['C:\\ok.png']); assert.equal(result.skipped, 3);
});
test('non-Windows host does not invoke PowerShell', async () => {
  const { readClipboardFiles } = require('../clipboard-files');
  const result = await readClipboardFiles({ platform: 'linux', execFile() { throw new Error('must not run'); } });
  assert.deepEqual(result.files, []);
});
test('clipboard failures and malformed helper output become rejected promises', async () => {
  const { readClipboardFiles } = require('../clipboard-files');
  for (const stdout of ['bad json', '{}']) {
    await assert.rejects(readClipboardFiles({ platform: 'win32', execFile(b, a, o, cb) { cb(null, stdout); } }));
  }
  await assert.rejects(readClipboardFiles({ platform: 'win32', execFile(b, a, o, cb) { cb(new Error('locked')); } }));
});
