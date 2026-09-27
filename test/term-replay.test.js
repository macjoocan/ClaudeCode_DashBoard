'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/term.js'), 'utf8');

function fakeBody() {
  const set = new Set();
  return {
    classList: {
      add: c => set.add(c),
      remove: c => set.delete(c),
      contains: c => set.has(c),
    },
    hidden: () => set.has('replaying'),
  };
}

function fixture() {
  const parsed = [], frames = [], timers = [], written = [], views = new Map();
  const buffer = {viewportY: 20, baseY: 200};
  const body = fakeBody();
  const v = {info:{id:'test'},ws:{},el:{getClientRects:()=>[{}]}, body,
    fit:{fit(){buffer.viewportY = 0;}},
    term:{buffer:{active:buffer}, write(text, done){ written.push(text); if(done) parsed.push(done); },
      scrollToBottom(){buffer.viewportY = buffer.baseY;}}
  };
  views.set('test', v);
  // Run the real output/fit functions with a deterministic asynchronous renderer.
  // 슬라이스는 코얼레싱 헬퍼(flushLive/writeLive/dropPending/endReplay)까지 포함해야 한다.
  const fit = source.slice(source.indexOf('  function fitView('), source.indexOf('  function fitVisible('));
  const output = source.slice(source.indexOf('  var OUT_MAX'), source.indexOf('  function connect('));
  const ctx = {views,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  };
  vm.createContext(ctx); vm.runInContext(fit + output, ctx);
  return {v,buffer,parsed,frames,timers,written,views,body,ctx};
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

// 스크롤백을 그대로 써 넣으면 xterm 이 처음부터 순서대로 그려서, 첫 화면부터
// 아래로 주르륵 스크롤하는 게 그대로 보인다. 다 쓸 때까지 감춰야 한다.
test('replay hides the screen until parsing finishes', () => {
  const {v,parsed,frames,body,ctx} = fixture();
  ctx.writeOutput(v,{d:'history',replay:true},v.ws);
  assert.equal(body.hidden(), true);
  parsed.shift()();
  assert.equal(body.hidden(), true);   // 파싱이 끝나도 프레임 전까지는 아직
  frames.shift()();
  assert.equal(body.hidden(), false);
});

// 콜백이 영영 안 오면 패인이 빈 화면으로 남는다. 시간이 지나면 풀어줘야 한다.
test('replay unhides even if the write callback never fires', () => {
  const {v,timers,body,ctx} = fixture();
  ctx.writeOutput(v,{d:'history',replay:true},v.ws);
  assert.equal(body.hidden(), true);
  timers.shift()();                    // 안전장치 타이머
  assert.equal(body.hidden(), false);
});

// 취소된 복원도 화면은 반드시 다시 보여야 한다.
test('cancelled replay still unhides the screen', () => {
  const {v,parsed,frames,body,ctx} = fixture();
  ctx.writeOutput(v,{d:'history',replay:true},v.ws);
  parsed.shift()();
  v.replayScroll = null;               // 사용자가 직접 스크롤함
  frames.shift()();
  assert.equal(body.hidden(), false);
});

test('live output does not force a reader to the bottom', () => {
  const {v,buffer,parsed,frames,written,ctx} = fixture();
  ctx.writeOutput(v,{d:'live'},v.ws);
  assert.equal(parsed.length,0);       // 복원이 아니므로 콜백을 달지 않는다
  frames.shift()();                    // 코얼레싱된 프레임을 흘린다
  assert.deepEqual(written,['live']);
  assert.equal(buffer.viewportY,20);   // 읽던 자리를 건드리지 않는다
});

test('wheel navigation during an asynchronous live write stays at the chosen position', () => {
  const {v,buffer,parsed,frames,ctx} = fixture();
  buffer.viewportY = buffer.baseY;      // 출력이 시작될 때는 맨 아래
  ctx.writeOutput(v,{d:'live'},v.ws);
  frames.shift()();                    // write 콜백은 아직 대기 중
  ctx.markNavigation(v);              // 그 사이 사용자가 휠을 굴림
  buffer.viewportY = 120;
  parsed.shift()();                    // 늦게 도착한 Codex 출력 콜백
  assert.equal(buffer.viewportY,120);
});

test('live output still follows the bottom without user navigation', () => {
  const {v,buffer,parsed,frames,ctx} = fixture();
  buffer.viewportY = buffer.baseY;
  ctx.writeOutput(v,{d:'live'},v.ws);
  frames.shift()();
  buffer.baseY = 210;
  parsed.shift()();
  assert.equal(buffer.viewportY,210);
});

// Codex TUI 는 한 프레임을 작은 덩어리 여러 개로 흘려보낸다. 덩어리마다 write() 하면
// 반쯤 그려진 화면이 그대로 렌더돼 입력 줄이 번쩍인다.
test('live output is coalesced into one write per frame', () => {
  const {v,frames,written,ctx} = fixture();
  ctx.writeOutput(v,{d:'a'},v.ws);
  ctx.writeOutput(v,{d:'b'},v.ws);
  ctx.writeOutput(v,{d:'c'},v.ws);
  assert.equal(written.length,0);      // 아직 아무것도 그리지 않았다
  assert.equal(frames.length,1);       // 프레임은 한 번만 예약한다
  frames.shift()();
  assert.deepEqual(written,['abc']);
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
