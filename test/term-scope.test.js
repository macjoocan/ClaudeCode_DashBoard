'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/term.js'), 'utf8');

test('task terminal scope hides unrelated PTYs and restores global layout without changing terminal contents', () => {
  const views = new Map(['other', 'claude', 'codex'].map(id => [id, { el: { hidden: false, style: {}, classList: { toggle() {} } }, contents: 'preserved ' + id }]));
  const context = { scope: null, order: ['other', 'claude', 'codex'], active: 'other', layout: 1,
    orient: 'grid', views, CC: { host: {} },
    applyTemplate() {}, refreshHeads() {}, fitVisible() {}, layoutGuts() {}, requestAnimationFrame: fn => fn(), onChange: null };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function slots()'), source.indexOf('  // 배치 방향'))
    + source.slice(source.indexOf('  function geometry('), source.indexOf('  // ------------------------------------------------------------ 패인 크기'))
    + source.slice(source.indexOf('  function apply()'), source.indexOf('  function refreshHeads()')), context);
  context.setScope(['claude', 'codex']);
  assert.equal(context.slots(), 2); assert.equal(views.get('other').el.hidden, true);
  assert.equal(views.get('claude').el.hidden, false); assert.equal(views.get('codex').el.hidden, false);
  context.setScope(null); assert.equal(context.slots(), 1);
  for (const [id, v] of views) assert.equal(v.contents, 'preserved ' + id);
});
