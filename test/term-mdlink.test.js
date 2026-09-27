// 터미널에 찍힌 .md 경로를 Ctrl+클릭으로 열려면, 먼저 그 경로를 정확히 집어내야 한다.
// 너무 좁으면 못 잡고, 너무 넓으면 아무 단어에나 밑줄이 그어진다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/term.js'), 'utf8');
const line = source.split('\n').find(l => l.indexOf('var MD_PATH_RE =') >= 0);
assert.ok(line, 'term.js 에서 MD_PATH_RE 를 찾지 못했다');
// /.../g 형태의 리터럴을 그대로 살려 쓴다
const body = line.slice(line.indexOf('/') + 1, line.lastIndexOf('/g'));
const RE = new RegExp(body, 'g');

// term.js 의 registerMdLinks 와 같은 다듬기 (감싼 기호 제거)
function hits(text) {
  RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = RE.exec(text)) !== null) {
    let raw = m[0].replace(/^[([{'"`]+/, '').replace(/[)\]},.;:'"`]+$/, '');
    if (raw.length >= 4) out.push(raw);
  }
  return out;
}

test('윈도 절대경로를 잡는다', () => {
  assert.deepEqual(hits('Wrote C:\\00.SVN\\Action\\docs\\plan.md'), ['C:\\00.SVN\\Action\\docs\\plan.md']);
});

test('슬래시 경로와 상대경로를 잡는다', () => {
  assert.deepEqual(hits('문서를 docs/설계.md 에 저장했습니다'), ['docs/설계.md']);
  assert.deepEqual(hits('created ./notes/todo.markdown ok'), ['./notes/todo.markdown']);
  assert.deepEqual(hits('/c/tmp/report.md 확인'), ['/c/tmp/report.md']);
});

test('폴더 없는 파일 이름도 잡는다 (cwd 기준으로 푼다)', () => {
  assert.deepEqual(hits('see README.md for details'), ['README.md']);
});

test('.mdx 같은 다른 확장자는 잡지 않는다', () => {
  assert.deepEqual(hits('file.mdx 는 아니다'), []);
  assert.deepEqual(hits('page.mdc 도 아니다'), []);
});

test('마크다운이 아닌 줄에서는 아무것도 잡지 않는다', () => {
  assert.deepEqual(hits('no path here'), []);
  assert.deepEqual(hits('npm install --save-dev vitest'), []);
});

test('문장 끝 기호는 경로에서 뺀다', () => {
  assert.deepEqual(hits('자세한 건 docs/guide.md, 그리고 다른 곳'), ['docs/guide.md']);
  assert.deepEqual(hits('(docs/a.md)'), ['docs/a.md']);
});

test('한 줄에 여러 개도 각각 잡는다', () => {
  assert.deepEqual(hits('a/one.md 와 b/two.md 를 만들었습니다'), ['a/one.md', 'b/two.md']);
});

// 공백이 든 경로는 어디서 끊길지 알 수 없어 잡지 않는다 - 잘못 잡느니 안 잡는 게 낫다.
test('공백이 든 경로는 온전히 잡지 못한다 (알려진 한계)', () => {
  const got = hits('C:\\Program Files\\x\\a.md');
  assert.notEqual(got[0], 'C:\\Program Files\\x\\a.md');
});

test('접힌 터미널 두 줄의 문서 경로를 어느 줄에서 눌러도 전체 파일로 연다', () => {
  const first = '📄 docs/superpowers/specs/2026-09-27-orderflow-paper-';
  const second = 'forward-validation-design.md';
  const lines = [first, second].map((text, i) => ({
    isWrapped: i > 0,
    translateToString: () => text,
  }));
  let provider, opened;
  const v = { info: { cwd: 'D:\\CoinTrade' }, term: {
    buffer: { active: { length: lines.length, getLine: i => lines[i] } },
    registerLinkProvider: p => { provider = p; },
  } };
  const start = source.indexOf('  var MD_PATH_RE =');
  const end = source.indexOf('  // 패인 머리글:', start);
  const ctx = { CC: { openMd: (file, cwd) => { opened = { file, cwd }; } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  ctx.registerMdLinks(v);
  for (const y of [1, 2]) {
    let links;
    provider.provideLinks(y, value => { links = value; });
    assert.equal(links?.length, 1);
    assert.equal(links[0].text, first.slice(3) + second);
    assert.equal(links[0].range.start.y, 1);
    assert.equal(links[0].range.end.y, 2);
    links[0].activate();
    assert.deepEqual(opened, { file: first.slice(3) + second, cwd: 'D:\\CoinTrade' });
  }
});

test('다른 줄에만 있는 링크는 현재 줄의 링크로 돌려주지 않는다', () => {
  const lines = ['docs/a.md and ', 'docs/b.md'].map((text, i) => ({
    isWrapped: i > 0,
    translateToString: () => text,
  }));
  let provider;
  const v = { info: { cwd: 'D:\\CoinTrade' }, term: {
    buffer: { active: { getLine: i => lines[i] } },
    registerLinkProvider: p => { provider = p; },
  } };
  const start = source.indexOf('  var MD_PATH_RE =');
  const end = source.indexOf('  // 패인 머리글:', start);
  const ctx = { CC: {} };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  ctx.registerMdLinks(v);
  let firstLinks, secondLinks;
  provider.provideLinks(1, value => { firstLinks = value; });
  provider.provideLinks(2, value => { secondLinks = value; });
  assert.deepEqual(Array.from(firstLinks, link => link.text), ['docs/a.md']);
  assert.deepEqual(Array.from(secondLinks, link => link.text), ['docs/b.md']);
});
