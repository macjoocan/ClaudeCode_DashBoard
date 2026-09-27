'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('file paths form expandable folders without losing their full paths', async () => {
  const { buildTree } = await import('../docs-navigation.mjs');
  const tree = buildTree(['README.md', 'docs/guide.md', 'docs/setup/install.md']);
  assert.deepEqual(tree.files, [{ name: 'README.md', path: 'README.md' }]);
  assert.deepEqual(tree.folders.get('docs').files, [{ name: 'guide.md', path: 'docs/guide.md' }]);
  assert.deepEqual(tree.folders.get('docs').folders.get('setup').files,
    [{ name: 'install.md', path: 'docs/setup/install.md' }]);
});

test('outline skips YAML and fenced code while retaining heading lines', async () => {
  const { headingsFromMarkdown } = await import('../docs-navigation.mjs');
  const markdown = ['---', 'title: Example', '---', '# Main', '```md', '# Not a heading', '```',
    '## Details', 'Setext', '------'].join('\n');
  assert.deepEqual(headingsFromMarkdown(markdown), [
    { level: 1, text: 'Main', line: 3 },
    { level: 2, text: 'Details', line: 7 },
    { level: 2, text: 'Setext', line: 8 }
  ]);
});

test('loading normalized Markdown alone does not request a save', async () => {
  const { isDocumentModified } = await import('../docs-navigation.mjs');
  const loaded = { file: 'note.md', mode: 'visual', original: '# Title\r\n',
    source: '# Title\r\n', visual: '# Title\n', savedVisual: '# Title\n', readFromRaw: false };
  assert.equal(isDocumentModified(loaded), false);
  assert.equal(isDocumentModified({ ...loaded, visual: '# Changed\n' }), true);
  assert.equal(isDocumentModified({ ...loaded, mode: 'raw', source: '# Changed\n' }), true);
});

test('relative document links resolve inside the selected root', async () => {
  const { resolveRelativePath } = await import('../docs-navigation.mjs');
  assert.equal(resolveRelativePath('docs/guide.md', '../README.md'), 'README.md');
  assert.equal(resolveRelativePath('docs/guide.md', 'images/hello%20world.png'), 'docs/images/hello world.png');
  assert.equal(resolveRelativePath('docs/guide.md', '../../outside.md'), null);
  assert.equal(resolveRelativePath('docs/guide.md', 'https://example.com/file.md'), null);
});
