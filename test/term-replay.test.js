'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/term.js'), 'utf8');

function fixture() {
  const parsed = [], frames = [], views = new Map();
  const buffer = {viewportY: 20, baseY: 200};
  const v = {info:{id:'test'},ws:{},el:{getClientRects:()=>[{}]},
    fit:{fit(){buffer.viewportY = 0;}},
    term:{buffer:{active:buffer}, write(text, done){ if(done) parsed.push(done); },
      scrollToBottom(){buffer.viewportY = buffer.baseY;}}
  };
  views.set('test', v);
  // Run the real output/fit functions with a deterministic asynchronous renderer.
  const fit = source.slice(source.indexOf('  function fitView('), source.indexOf('  function fitVisible('));
  const output = source.slice(source.indexOf('  function writeOutput('), source.indexOf('  function connect('));
  const ctx = {views, requestAnimationFrame:fn=>frames.push(fn)};
  vm.createContext(ctx); vm.runInContext(fit + output, ctx);
  return {v,buffer,parsed,frames,views,ctx};
}
test('replay reaches bottom only after parsing and layout complete', () => {
  const {v,buffer,parsed,frames,ctx} = fixture();
  ctx.writeOutput(v,{d:'history',replay:true},v.ws);
  assert.equal(buffer.viewportY,20);
  parsed.shift()();
  assert.equal(buffer.viewportY,20);
  frames.shift()();
  assert.equal(buffer.viewportY,200);
  ctx.fitView(v); // subsequent header resize must keep the bottom pinned
  assert.equal(buffer.viewportY,200);
});
test('live output does not force a reader to the bottom', () => {
  const {v,buffer,parsed,frames,ctx} = fixture();
  ctx.writeOutput(v,{d:'live'},v.ws);
  assert.equal(buffer.viewportY,20);
  assert.equal(parsed.length+frames.length,0);
});
for (const reason of ['user navigation','new connection','removed pane']) {
  test('pending replay is cancelled by ' + reason, () => {
    const {v,buffer,parsed,frames,views,ctx} = fixture();
    ctx.writeOutput(v,{d:'history',replay:true},v.ws);
    parsed.shift()();
    if(reason==='user navigation') v.replayScroll=null;
    if(reason==='new connection') v.ws={};
    if(reason==='removed pane') views.delete('test');
    frames.shift()();
    assert.equal(buffer.viewportY,20);
  });
}
