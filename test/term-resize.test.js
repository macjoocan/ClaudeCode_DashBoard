'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTermModule() {
  const listeners = {};
  const timers = new Map();
  let nextTimer = 1;

  const window = {
    CC: {},
    addEventListener(name, fn) { listeners[name] = fn; },
  };
  const document = { addEventListener() {} };
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'term.js'), 'utf8');

  vm.runInNewContext(source, {
    window,
    document,
    Map,
    Promise,
    setTimeout(fn, delay) {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });

  return { window, listeners, timers };
}

test('연속 window resize는 마지막 refit 하나로 합친다', () => {
  const { window, listeners, timers } = loadTermModule();

  assert.equal(typeof listeners.resize, 'function');
  assert.equal(typeof window.CC.term.scheduleRefit, 'function');

  listeners.resize();
  listeners.resize();
  listeners.resize();

  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 120);
});
