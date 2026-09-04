const { test } = require('node:test');
const assert = require('node:assert');
const codex = require('../codex.js');

test('normalizeCwd 는 \\\\?\\ 접두사를 벗긴다', () => {
  assert.equal(codex.normalizeCwd('\\\\?\\D:\\00.project\\GameDevTeam'), 'D:\\00.project\\GameDevTeam');
});

test('normalizeCwd 는 접두사가 없으면 그대로 둔다', () => {
  assert.equal(codex.normalizeCwd('D:\\00.project\\GameDevTeam'), 'D:\\00.project\\GameDevTeam');
});

test('normalizeCwd 는 UNC 접두사도 벗긴다', () => {
  assert.equal(codex.normalizeCwd('\\\\?\\UNC\\server\\share'), '\\\\server\\share');
});

test('normalizeCwd 는 빈 값에 안전하다', () => {
  assert.equal(codex.normalizeCwd(''), '');
  assert.equal(codex.normalizeCwd(null), '');
});

test('safeTitle 은 첫 번째로 쓸만한 값을 쓴다', () => {
  assert.equal(codex.safeTitle(null, '두번째', '세번째'), '두번째');
});

test('safeTitle 은 공백만 있는 값을 건너뛴다', () => {
  assert.equal(codex.safeTitle('   ', '진짜 제목'), '진짜 제목');
});

test('safeTitle 은 200자로 자르고 말줄임표를 붙인다', () => {
  const long = 'x'.repeat(500);
  const out = codex.safeTitle(long);
  assert.equal(out.length, 201);          // 200 + '…'
  assert.ok(out.endsWith('…'));
});

test('safeTitle 은 개행을 공백으로 바꾼다', () => {
  assert.equal(codex.safeTitle('첫 줄\n둘째 줄'), '첫 줄 둘째 줄');
});

test('safeTitle 은 후보가 모두 비면 빈 문자열', () => {
  assert.equal(codex.safeTitle(null, '', '  '), '');
});

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 실제 스키마의 부분집합으로 픽스처 DB를 만든다.
function makeFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codextest-'));
  const p = path.join(dir, 'state.sqlite');
  const db = new DatabaseSync(p);
  db.exec(`create table threads (
    id text, rollout_path text, cwd text, title text,
    first_user_message text, preview text,
    updated_at_ms integer, created_at_ms integer,
    git_branch text, thread_source text, source text, archived integer
  )`);
  db.exec(`create table thread_spawn_edges (
    parent_thread_id text, child_thread_id text, status text
  )`);
  const ins = db.prepare(`insert into threads values (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('aaa-111', 'C:\\r\\a.jsonl', '\\\\?\\D:\\proj\\App', '앱 작업',
          '첫 프롬프트', '마지막', 2000, 1000, 'main', 'user', null, 0);
  ins.run('bbb-222', 'C:\\r\\b.jsonl', '\\\\?\\D:\\proj\\App', 'x'.repeat(400),
          '서브 프롬프트', '미리보기', 3000, 1500, 'main', 'subagent',
          '{"subagent":{"thread_spawn":{"parent_thread_id":"aaa-111","depth":1}}}', 0);
  ins.run('ccc-333', 'C:\\r\\c.jsonl', '\\\\?\\D:\\proj\\Old', '보관됨',
          '옛날', '옛날', 500, 400, 'main', 'user', null, 1);
  db.close();
  return p;
}

test('readThreads 는 archived 를 제외하고 최신순으로 준다', () => {
  const rows = codex.readThreads(makeFixtureDb());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'bbb-222');   // updated_at_ms 3000 이 먼저
  assert.equal(rows[1].id, 'aaa-111');
});

test('readThreads 는 cwd 를 정규화한다', () => {
  const rows = codex.readThreads(makeFixtureDb());
  assert.equal(rows[0].cwd, 'D:\\proj\\App');
});

test('readThreads 는 title 을 자른다', () => {
  const rows = codex.readThreads(makeFixtureDb());
  assert.equal(rows[0].title.length, 201);
});

test('readThreads 는 provider 를 codex 로 박는다', () => {
  const rows = codex.readThreads(makeFixtureDb());
  assert.ok(rows.every(r => r.provider === 'codex'));
});

test('readThreads 는 source JSON 에서 부모 스레드를 뽑는다', () => {
  const rows = codex.readThreads(makeFixtureDb());
  assert.equal(rows.find(r => r.id === 'bbb-222').parentId, 'aaa-111');
  assert.equal(rows.find(r => r.id === 'aaa-111').parentId, null);
});

test('readThreads 는 DB 가 없으면 빈 배열', () => {
  assert.deepEqual(codex.readThreads('C:\\없는\\경로\\x.sqlite'), []);
});

test('openReadOnly 는 폴백까지 이중으로 실패해도 temp 디렉터리를 남기지 않는다', () => {
  // 디렉터리를 sqlite 파일인 것처럼 넘기면: 1차 open(new DatabaseSync(dir, {readOnly:true}))이
  // "unable to open database file"로 실패해 폴백 분기로 들어가고,
  // 폴백의 fs.copyFileSync(dir, tmp) 도 디렉터리를 파일로 복사할 수 없어 실패한다.
  // 즉 mocking 없이 "fallback 자체도 실패하는" 이중 실패 경로를 재현한다.
  const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ccl-codex-')).length;
  const fakeDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codextest-asdir-'));
  try {
    const rows = codex.readThreads(fakeDbDir);
    assert.deepEqual(rows, []);
    const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ccl-codex-')).length;
    assert.equal(after, before);
  } finally {
    fs.rmSync(fakeDbDir, { recursive: true, force: true });
  }
});
