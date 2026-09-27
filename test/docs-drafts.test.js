'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('drafts are isolated by folder and file and can be recovered or cleared', async () => {
  const { readDraft, saveDraft, clearDraft } = await import('../docs-drafts.mjs');
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  saveDraft(storage, 'C:/one', 'note.md', 'unsaved text', 'v1');
  assert.equal(readDraft(storage, 'C:/one', 'note.md').text, 'unsaved text');
  assert.equal(readDraft(storage, 'C:/two', 'note.md'), null);
  assert.equal(readDraft(storage, 'C:/one', 'other.md'), null);
  clearDraft(storage, 'C:/one', 'note.md');
  assert.equal(readDraft(storage, 'C:/one', 'note.md'), null);
});
