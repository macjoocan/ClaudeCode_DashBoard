// 터미널에 찍힌 .md 경로를 Ctrl+클릭으로 열려면, 먼저 그 경로를 정확히 집어내야 한다.
// 너무 좁으면 못 잡고, 너무 넓으면 아무 단어에나 밑줄이 그어진다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
