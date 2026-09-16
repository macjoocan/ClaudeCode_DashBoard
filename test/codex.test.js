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
    git_branch text, thread_source text, source text, archived integer,
    tokens_used integer
  )`);
  db.exec(`create table thread_spawn_edges (
    parent_thread_id text, child_thread_id text, status text
  )`);
  const ins = db.prepare(`insert into threads values (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('aaa-111', 'C:\\r\\a.jsonl', '\\\\?\\D:\\proj\\App', '앱 작업',
          '첫 프롬프트', '마지막', 2000, 1000, 'main', 'user', null, 0, 12345);
  ins.run('bbb-222', 'C:\\r\\b.jsonl', '\\\\?\\D:\\proj\\App', 'x'.repeat(400),
          '서브 프롬프트', '미리보기', 3000, 1500, 'main', 'subagent',
          '{"subagent":{"thread_spawn":{"parent_thread_id":"aaa-111","depth":1}}}', 0, 6789);
  ins.run('ccc-333', 'C:\\r\\c.jsonl', '\\\\?\\D:\\proj\\Old', '보관됨',
          '옛날', '옛날', 500, 400, 'main', 'user', null, 1, 100);
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

test('readThreads 는 tokens_used 를 싣는다', () => {
  const rows = codex.readThreads(makeFixtureDb());
  assert.equal(typeof rows[0].tokens, 'number');
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

test('stamp 는 행 수와 최신 updated_at_ms 와 archived 합을 합친 문자열', () => {
  const p = makeFixtureDb();
  assert.equal(codex.stamp(p), '3:3000:1');    // archived 포함 3행, 최대 3000, archived 합 1(ccc-333)
});

test('stamp 는 DB 가 없으면 빈 문자열', () => {
  assert.equal(codex.stamp('C:\\없는\\x.sqlite'), '');
});

// updated_at_ms 를 건드리지 않고 archived 만 뒤집는 경우, 이전 stamp(count+max)는
// 값이 그대로라 캐시가 무효화되지 않았다(사전 확인 스크립트로 재현: 수정 전에는
// before === after === '3:3000' 이었음). archived 합을 stamp 에 넣어 이 구멍을 막는다.
test('stamp 는 updated_at_ms 변화 없이 archived 만 바뀌어도 달라진다', () => {
  const p = makeFixtureDb();
  const before = codex.stamp(p);
  const wdb = new DatabaseSync(p);
  wdb.exec("update threads set archived = 1 where id = 'aaa-111'");
  wdb.close();
  const after = codex.stamp(p);
  assert.notEqual(before, after);
});

test('codexArgs 는 각 동작을 올바른 인자로 바꾼다', () => {
  assert.deepEqual(codex.codexArgs('new'), []);
  assert.deepEqual(codex.codexArgs('resume', 'aaa-111'), ['resume', 'aaa-111']);
  assert.deepEqual(codex.codexArgs('fork', 'aaa-111'), ['fork', 'aaa-111']);
  assert.deepEqual(codex.codexArgs('continue'), ['resume', '--last']);
});

test('codexArgs 는 resume/fork 에 세션 ID 가 없으면 던진다', () => {
  assert.throws(() => codex.codexArgs('resume'), /세션 ID/);
  assert.throws(() => codex.codexArgs('fork', ''), /세션 ID/);
});

// ------------------------------------------------------- parseRollout

function writeRollout(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-roll-'));
  const p = path.join(dir, 'r.jsonl');
  fs.writeFileSync(p, lines.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  return p;
}

test('parseRollout 은 사용자/어시스턴트/툴을 뽑는다', () => {
  const p = writeRollout([
    { timestamp: '2026-08-17T04:34:30.523Z', type: 'session_meta',
      payload: { session_id: 'aaa', cwd: 'D:\\x', base_instructions: { text: 'x'.repeat(5000) } } },
    { timestamp: '2026-08-17T04:34:30.965Z', type: 'event_msg',
      payload: { type: 'user_message', message: '안녕' } },
    { timestamp: '2026-08-17T04:34:38.427Z', type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' } },
    { timestamp: '2026-08-17T04:38:25.784Z', type: 'event_msg',
      payload: { type: 'agent_message', message: '했습니다' } },
  ]);
  const out = codex.parseRollout(p, 40);
  assert.equal(out.msgs.length, 3);
  assert.equal(out.msgs[0].role, 'user');
  assert.equal(out.msgs[0].text, '안녕');
  assert.equal(out.msgs[1].role, 'tool');
  assert.ok(out.msgs[1].text.includes('exec_command'));
  assert.equal(out.msgs[2].role, 'assistant');
});

test('parseRollout 은 limit 만큼 뒤에서 자른다', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push({ timestamp: '2026-08-17T04:34:30.965Z', type: 'event_msg',
                 payload: { type: 'user_message', message: '메시지 ' + i } });
  }
  const out = codex.parseRollout(writeRollout(lines), 10);
  assert.equal(out.msgs.length, 10);
  assert.equal(out.msgs[9].text, '메시지 49');
  assert.equal(out.total, 50);
});

// 최종 리뷰(승격된 보류 항목): rollout 은 실측 최대 9.4MB 인데 대화 패널이 열려
// 있는 동안 5초마다 통째로 다시 읽고 다시 파싱했다. Claude 쪽 transcript() 처럼
// 파일 끝만 읽도록 상한을 건다.
test('parseRollout 은 파일 끝만 읽고 잘린 첫 줄을 버린다', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push({ timestamp: '2026-08-17T04:34:30.965Z', type: 'event_msg',
                 payload: { type: 'user_message', message: '메시지 ' + i } });
  }
  const p = writeRollout(lines);
  const full = codex.parseRollout(p, 100);
  const tail = codex.parseRollout(p, 100, 300);   // 300 바이트만 읽는다

  assert.equal(full.total, 50);
  assert.ok(tail.total > 0 && tail.total < full.total, '꼬리만 읽어 메시지 수가 줄어야 한다');
  // 마지막 메시지는 항상 살아 있고, 잘린 첫 줄 때문에 깨진 항목이 섞이면 안 된다
  assert.equal(tail.msgs[tail.msgs.length - 1].text, '메시지 49');
  assert.ok(tail.msgs.every(m => /^메시지 \d+$/.test(m.text)), '잘린 줄이 섞이면 안 된다');
});

test('parseRollout 은 상한보다 작은 파일은 그대로 다 읽는다', () => {
  const p = writeRollout([
    { timestamp: '2026-08-17T04:34:30.965Z', type: 'event_msg',
      payload: { type: 'user_message', message: '하나' } },
  ]);
  const out = codex.parseRollout(p, 40, 1024 * 1024);
  assert.equal(out.total, 1);
  assert.equal(out.msgs[0].text, '하나');
});

test('parseRollout 은 깨진 줄을 건너뛴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-roll-'));
  const p = path.join(dir, 'r.jsonl');
  fs.writeFileSync(p, '{깨짐\n' + JSON.stringify({
    timestamp: '2026-08-17T04:34:30.965Z', type: 'event_msg',
    payload: { type: 'user_message', message: '살아남음' } }) + '\n', 'utf8');
  const out = codex.parseRollout(p, 40);
  assert.equal(out.msgs.length, 1);
  assert.equal(out.msgs[0].text, '살아남음');
});

test('parseRollout 은 없는 파일에 빈 결과', () => {
  assert.deepEqual(codex.parseRollout('C:\\없는\\r.jsonl', 40), { msgs: [], total: 0 });
});

// ------------------------------------------------------- isInsideSessions (경로 탈출 차단)

test('isInsideSessions 은 sessions 로 시작하지만 실제로는 형제 디렉터리인 경로를 막는다', () => {
  const evil = path.join(codex.CODEX_HOME, 'sessions-evil', 'x.jsonl');
  assert.equal(codex.isInsideSessions(evil), false);
});

test('isInsideSessions 은 sessions 하위 정상 경로를 허용한다', () => {
  const ok = path.join(codex.CODEX_HOME, 'sessions', '2026', '08', '17', 'rollout-x.jsonl');
  assert.equal(codex.isInsideSessions(ok), true);
});

test('isInsideSessions 은 .. 로 상위를 탈출하는 경로를 막는다', () => {
  const traversal = path.join(codex.CODEX_HOME, 'sessions', '..', 'evil.jsonl');
  assert.equal(codex.isInsideSessions(traversal), false);
});

// ------------------------------------------------------- liveMap (실행 상태 파일)

test('liveMap 은 상태 파일을 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  fs.writeFileSync(path.join(dir, 'aaa-111.json'), JSON.stringify({
    sessionId: 'aaa-111', status: 'busy', cwd: 'D:\\x', pid: process.pid, at: Date.now() }), 'utf8');
  const m = codex.liveMap(dir);
  assert.equal(m.get('aaa-111').status, 'busy');
  // /api/live 가 Claude 상태와 한 맵에 담으므로 출처가 실려 있어야 한다
  assert.equal(m.get('aaa-111').provider, 'codex');
});

// 강제 종료된 CLI 는 상태 파일을 못 지운다. 나이만 보면 하루 내내 '실행 중' 으로 남는다.
test('liveMap 은 PID 가 죽은 파일을 버린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  fs.writeFileSync(path.join(dir, 'dead.json'), JSON.stringify({
    sessionId: 'dead', status: 'busy', pid: 998877, at: Date.now() }), 'utf8');
  assert.equal(codex.liveMap(dir).size, 0);
});

// pid 를 안 남긴 옛 파일까지 버리면 멀쩡한 세션이 목록에서 사라진다.
test('liveMap 은 pid 없는 파일은 그대로 살린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  fs.writeFileSync(path.join(dir, 'nopid.json'), JSON.stringify({
    sessionId: 'nopid', status: 'idle', at: Date.now() }), 'utf8');
  assert.ok(codex.liveMap(dir).has('nopid'));
});

test('dropLive 는 상태 파일을 지우고 경로를 벗어나는 id 는 막는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  const f = path.join(dir, 'gone.json');
  fs.writeFileSync(f, JSON.stringify({ sessionId: 'gone', at: Date.now() }), 'utf8');
  assert.equal(codex.dropLive('../escape', dir), false);
  assert.equal(codex.dropLive('gone', dir), true);
  assert.equal(fs.existsSync(f), false);
  assert.equal(codex.dropLive('gone', dir), false);   // 두 번째는 지울 게 없다
});

test('liveMap 은 오래된 파일을 버린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({
    sessionId: 'old', status: 'busy', at: Date.now() - 25 * 60 * 60 * 1000 }), 'utf8');
  assert.equal(codex.liveMap(dir).size, 0);
});

test('liveMap 은 깨진 파일을 건너뛴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{깨짐', 'utf8');
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({
    sessionId: 'good', status: 'idle', at: Date.now() }), 'utf8');
  const m = codex.liveMap(dir);
  assert.equal(m.size, 1);
  assert.ok(m.has('good'));
});

test('liveMap 은 디렉터리가 없으면 빈 Map', () => {
  assert.equal(codex.liveMap('C:\\없는\\디렉터리').size, 0);
});

test('liveMap 은 at 값이 깨진(비숫자) 문자열이면 최대로 오래된 것으로 보고 제외한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  fs.writeFileSync(path.join(dir, 'corrupt-at.json'), JSON.stringify({
    sessionId: 'corrupt-at', status: 'busy', at: 'not-a-number' }), 'utf8');
  assert.equal(codex.liveMap(dir).size, 0);
});

// ------------------------------------------------------- parseDoctor (codex doctor --json)

const DOCTOR_FIXTURE = {
  schemaVersion: 1, overallStatus: 'warning', codexVersion: '0.153.2',
  checks: {
    'config.load': { id: 'config.load', category: 'config', status: 'ok',
      summary: 'config loaded', details: { model: 'gpt-5.5', 'mcp servers': '5' } },
    'mcp.config': { id: 'mcp.config', category: 'mcp', status: 'warning',
      summary: 'MCP configuration has optional issues', details: { 'configured servers': '5' } },
  },
};

test('parseDoctor 는 체크를 배열로 펴고 카테고리를 지킨다', () => {
  const r = codex.parseDoctor(DOCTOR_FIXTURE);
  assert.equal(r.ok, true);
  assert.equal(r.version, '0.153.2');
  assert.equal(r.status, 'warning');
  assert.equal(r.checks.length, 2);
  // config.load 는 status:ok 라 warning 인 mcp.config 보다 뒤로 정렬된다(다음 테스트 참고).
  // 인덱스를 고정하는 대신 id 로 찾아 필드 보존만 검증한다.
  const cfg = r.checks.find(c => c.id === 'config.load');
  assert.equal(cfg.category, 'config');
  assert.equal(cfg.details.model, 'gpt-5.5');
});

test('parseDoctor 는 warning/fail 을 앞으로 정렬한다', () => {
  const r = codex.parseDoctor(DOCTOR_FIXTURE);
  assert.equal(r.checks[0].status, 'warning');   // mcp.config 가 먼저
});

test('parseDoctor 는 쓰레기 입력에 ok:false', () => {
  assert.equal(codex.parseDoctor(null).ok, false);
  assert.equal(codex.parseDoctor({}).ok, false);
  assert.equal(codex.parseDoctor({ checks: 'x' }).ok, false);
});

// 회귀 방지: doctor() 는 codex 실행 파일 경로를 큰따옴표로 감싸 실행해야 한다.
// 경로 중간에 공백이 있으면(예: 사용자 이름이 "John Smith") 따옴표 없이 넘길 경우
// cmd.exe 가 공백에서 인자를 다시 쪼개 "내부 또는 외부 명령이 아닙니다"로 조용히
// 실패한다(1차 수정에서 실측으로 발견). 실제 codex 를 부르지 않고, 공백이 든
// 임시 디렉터리에 가짜 .cmd 를 만들어 doctor() 의 두 번째 인자(bin 오버라이드)로
// 넘겨 검증한다.
test('doctor 는 경로에 공백이 있는 codex 실행 파일도 부른다 (cmd.exe 따옴표 회귀 방지)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl codex space '));
  const bin = path.join(dir, 'fake codex.cmd');
  const fakeJson = '{"schemaVersion":1,"overallStatus":"ok","codexVersion":"9.9.9",'
    + '"checks":{"x":{"id":"x","category":"c","status":"ok","summary":"s","details":{}}}}';
  fs.writeFileSync(bin, '@echo off\r\necho ' + fakeJson + '\r\n');
  try {
    const report = await new Promise((resolve, reject) => {
      codex.doctor((err, r) => err ? reject(err) : resolve(r), bin);
    });
    assert.equal(report.ok, true);
    assert.equal(report.version, '9.9.9');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].id, 'x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
