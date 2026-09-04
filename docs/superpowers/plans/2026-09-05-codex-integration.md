# Codex 연동 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cc-launcher 대시보드 한 곳에서 Claude Code 세션과 Codex 세션을 같이 보고, 열고, 실행 상태를 확인한다.

**Architecture:** `codex.js` 어댑터 모듈 하나가 Codex 관련 지식을 전부 소유한다. `server.js` 는 정해진 지점(스캔 병합·실행 라우팅·대화 읽기·그래프·실행상태)에서만 어댑터를 부른다. 기존 Claude 경로는 건드리지 않는다. 세션 목록은 rollout 파일 스캔 대신 `~/.codex/state_5.sqlite` 의 `threads` 테이블을 읽는다.

**Tech Stack:** Node 24 (CommonJS), `node:sqlite` 내장 모듈, `node:test` 내장 테스트 러너, node-pty, ws. 프론트엔드는 vanilla JS.

**Spec:** `docs/superpowers/specs/2026-09-05-codex-integration-design.md`

## Global Constraints

- **새 npm 의존성을 추가하지 않는다.** 현재 `package.json` 의존성은 `node-pty` 와 `ws` 뿐이고, "첫 실행 때 자동 설치"가 성립해야 한다. sqlite는 `node:sqlite`, 테스트는 `node:test` 내장을 쓴다.
- **Node 24 이상 필요** (`node:sqlite`). 현재 개발 머신은 v24.13.0.
- `node:sqlite` 는 experimental이라 기동 시 `ExperimentalWarning` 을 뿜는다. 서버 진입점에서 억제한다.
- **Codex sqlite에는 절대 쓰지 않는다.** 읽기 전용으로만 연다.
- **`title` 은 200자로 절단한다.** 실측 최대 36,111자(승인 요청 블롭이 제목에 들어간 세션 존재), 중앙값 29자.
- Codex `cwd` 는 `\\?\D:\path` 형태다. `\\?\` 접두사를 제거해야 Claude 프로젝트 카드와 합쳐진다.
- 서버는 `127.0.0.1` 바인딩과 Origin 검사를 그대로 유지한다.
- UI 문자열은 한국어. 기존 코드 스타일(2-space, CommonJS `require`, 세미콜론)을 따른다.
- `SAFE_ID = /^[A-Za-z0-9\-]+$/` 는 이미 Codex UUID를 통과한다. **변경하지 말 것.**

---

### Task 1: 테스트 하네스 + 순수 유틸 (cwd 정규화, title 절단)

`codex.js` 의 부작용 없는 부분부터 만든다. 이 태스크가 프로젝트의 첫 테스트를 도입한다.

**Files:**
- Create: `test/codex.test.js`
- Create: `codex.js`
- Modify: `package.json` (scripts에 `test` 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `codex.js` 가 `{ normalizeCwd, safeTitle }` 을 export. `normalizeCwd(s: string) => string`, `safeTitle(...candidates: (string|null)[]) => string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/codex.test.js`:

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex.test.js`
Expected: FAIL — `Cannot find module '../codex.js'`

- [ ] **Step 3: 최소 구현을 쓴다**

`codex.js`:

```js
// Codex 세션 어댑터. Codex 관련 지식은 전부 이 파일이 소유한다.
// 세션 목록은 rollout 파일을 스캔하지 않고 ~/.codex/state_5.sqlite 의
// threads 테이블을 읽는다 (실측 33행 = rollout 파일 33개로 일치).
'use strict';

const TITLE_MAX = 200;

// Codex 는 cwd 를 확장 길이 경로(\\?\D:\...)로 저장한다.
// 벗기지 않으면 Claude 프로젝트 카드와 다른 키가 되어 카드가 둘로 갈린다.
function normalizeCwd(s) {
  let v = String(s || '');
  if (v.startsWith('\\\\?\\UNC\\')) return '\\\\' + v.slice(8);
  if (v.startsWith('\\\\?\\')) return v.slice(4);
  return v;
}

// threads.title 은 보통 짧지만(중앙값 29자) 승인 요청 블롭이 통째로
// 들어가 36,000자가 넘는 경우가 있다. 반드시 자른다.
function safeTitle(...candidates) {
  for (const c of candidates) {
    const v = String(c == null ? '' : c).replace(/\s+/g, ' ').trim();
    if (!v) continue;
    return v.length > TITLE_MAX ? v.slice(0, TITLE_MAX) + '…' : v;
  }
  return '';
}

module.exports = { normalizeCwd, safeTitle, TITLE_MAX };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: package.json 에 test 스크립트를 넣는다**

`package.json` 의 `scripts` 를 다음으로 바꾼다:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/*.test.js"
  },
```

- [ ] **Step 6: 스크립트로도 도는지 확인한다**

Run: `npm test`
Expected: PASS — 9 tests

- [ ] **Step 7: 커밋**

```bash
git add codex.js test/codex.test.js package.json
git commit -m "feat(codex): cwd 정규화와 title 절단 유틸 + node:test 하네스"
```

---

### Task 2: threads 테이블 → 세션 목록

**Files:**
- Modify: `codex.js`
- Modify: `test/codex.test.js`

**Interfaces:**
- Consumes: Task 1 의 `normalizeCwd`, `safeTitle`
- Produces: `codex.js` 가 추가로 export —
  - `readThreads(dbPath: string) => Array<Session>` 여기서 `Session = { id, provider: 'codex', title, firstPrompt, last, mtime, branch, cwd, rolloutPath, threadSource, parentId }`
  - `CODEX_HOME: string` (`~/.codex` 절대경로)
  - `STATE_DB: string` (`~/.codex/state_5.sqlite`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/codex.test.js` 끝에 추가:

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex.test.js`
Expected: FAIL — `codex.readThreads is not a function`

- [ ] **Step 3: 구현을 쓴다**

`codex.js` 의 `module.exports` 위에 추가:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');

const SELECT = `
  select id, rollout_path, cwd, title, first_user_message, preview,
         updated_at_ms, created_at_ms, git_branch, thread_source, source
    from threads
   where archived = 0
   order by updated_at_ms desc`;

// source 는 '{"subagent":{"thread_spawn":{"parent_thread_id":"...","depth":1}}}'
// 형태이거나 null 이다. 파싱에 실패해도 세션 자체는 살린다.
function parentOf(sourceJson) {
  if (!sourceJson) return null;
  try {
    const j = JSON.parse(sourceJson);
    return j?.subagent?.thread_spawn?.parent_thread_id || null;
  } catch { return null; }
}

// 읽기 전용으로 연다. Codex 가 쓰는 중이라 잠겨 있으면 temp 로 복사해 읽는다.
function openReadOnly(dbPath) {
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), tmp: null };
  } catch {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-codex-')), 'state.sqlite');
    fs.copyFileSync(dbPath, tmp);
    return { db: new DatabaseSync(tmp, { readOnly: true }), tmp };
  }
}

function readThreads(dbPath) {
  const file = dbPath || STATE_DB;
  if (!fs.existsSync(file)) return [];
  let handle;
  try { handle = openReadOnly(file); } catch { return []; }

  try {
    return handle.db.prepare(SELECT).all().map(r => ({
      id: r.id,
      provider: 'codex',
      title: safeTitle(r.title, r.first_user_message, r.preview),
      firstPrompt: safeTitle(r.first_user_message),
      last: safeTitle(r.preview, r.first_user_message),
      mtime: Number(r.updated_at_ms) || Number(r.created_at_ms) || 0,
      branch: r.git_branch || null,
      cwd: normalizeCwd(r.cwd),
      rolloutPath: r.rollout_path || null,
      threadSource: r.thread_source || null,
      parentId: parentOf(r.source),
    }));
  } catch {
    return [];
  } finally {
    try { handle.db.close(); } catch {}
    if (handle.tmp) { try { fs.rmSync(path.dirname(handle.tmp), { recursive: true, force: true }); } catch {} }
  }
}
```

`module.exports` 를 다음으로 바꾼다:

```js
module.exports = { normalizeCwd, safeTitle, readThreads, TITLE_MAX, CODEX_HOME, STATE_DB };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex.test.js`
Expected: PASS — 15 tests

- [ ] **Step 5: 실제 DB 로도 확인한다**

Run:
```bash
node --no-warnings -e "const c=require('./codex.js'); const r=c.readThreads(); console.log('세션',r.length); console.log(r.slice(0,3).map(x=>x.threadSource+' | '+x.cwd+' | '+x.title.slice(0,40)).join('\n'));"
```
Expected: 세션 수가 1 이상이고, `cwd` 에 `\\?\` 가 없다.

- [ ] **Step 6: 커밋**

```bash
git add codex.js test/codex.test.js
git commit -m "feat(codex): threads 테이블에서 세션 목록 읽기"
```

---

### Task 3: 스캔 캐시 + 서버 프로젝트 병합

**Files:**
- Modify: `codex.js`
- Modify: `test/codex.test.js`
- Modify: `server.js:197-268` (`scan()`)

**Interfaces:**
- Consumes: Task 2 의 `readThreads`
- Produces: `codex.js` 가 추가로 export — `sessions() => Array<Session>` (캐시 적용, 인자 없음, 실제 `STATE_DB` 사용), `stamp(dbPath?) => string` (캐시 키)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/codex.test.js` 끝에 추가:

```js
test('stamp 는 행 수와 최신 updated_at_ms 를 합친 문자열', () => {
  const p = makeFixtureDb();
  assert.equal(codex.stamp(p), '3:3000');    // archived 포함 3행, 최대 3000
});

test('stamp 는 DB 가 없으면 빈 문자열', () => {
  assert.equal(codex.stamp('C:\\없는\\x.sqlite'), '');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex.test.js`
Expected: FAIL — `codex.stamp is not a function`

- [ ] **Step 3: 구현을 쓴다**

`codex.js` 에 추가:

```js
// 파일 mtime 대신 DB 내용으로 캐시를 무효화한다.
// sqlite 는 WAL 때문에 mtime 이 안 바뀔 수 있다.
function stamp(dbPath) {
  const file = dbPath || STATE_DB;
  if (!fs.existsSync(file)) return '';
  let handle;
  try { handle = openReadOnly(file); } catch { return ''; }
  try {
    const r = handle.db.prepare('select count(*) n, max(updated_at_ms) m from threads').get();
    return `${r.n}:${r.m || 0}`;
  } catch {
    return '';
  } finally {
    try { handle.db.close(); } catch {}
    if (handle.tmp) { try { fs.rmSync(path.dirname(handle.tmp), { recursive: true, force: true }); } catch {} }
  }
}

let _cache = { stamp: null, rows: [] };

function sessions() {
  const s = stamp();
  if (s && s === _cache.stamp) return _cache.rows;
  const rows = readThreads();
  _cache = { stamp: s, rows };
  return rows;
}
```

export 에 `sessions`, `stamp` 를 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex.test.js`
Expected: PASS — 17 tests

- [ ] **Step 5: `server.js` 의 `scan()` 에 병합을 넣는다**

`server.js` 상단 require 블록(21행 부근 `const CLAUDE_HOME = ...` 위)에 추가:

```js
const codex = require('./codex.js');
```

`scan()` 안, Claude 파일 순회가 끝난 직후 — 즉 `const pins = loadPins();` 바로 위에 다음을 넣는다:

```js
  // Codex 세션을 같은 프로젝트 맵에 병합한다. 키가 cwd 소문자라
  // 같은 폴더면 Claude 카드와 자연히 합쳐진다.
  for (const s of codex.sessions()) {
    if (!s.cwd) continue;
    const key = s.cwd.toLowerCase();
    if (!projects.has(key)) {
      projects.set(key, {
        key, cwd: s.cwd, name: path.basename(s.cwd) || s.cwd,
        exists: fs.existsSync(s.cwd),
        gitBranch: s.branch, sessions: [],
      });
    }
    const p = projects.get(key);
    if (!p.gitBranch && s.branch) p.gitBranch = s.branch;
    let sizeKB = 0;
    try { sizeKB = Math.round(fs.statSync(s.rolloutPath).size / 1024); } catch {}
    p.sessions.push({
      id: s.id, slug: null, provider: 'codex',
      mtime: s.mtime, sizeKB,
      branch: s.branch, version: null,
      title: s.title, firstPrompt: s.firstPrompt, last: s.last,
      live: null,
      fav: favs.has('codex:' + s.id),
      subagents: null,
      threadSource: s.threadSource, parentId: s.parentId,
    });
  }
```

Claude 세션 push 블록(`server.js:239` 부근)에도 provider 를 명시한다. `id, slug: d.name,` 다음 줄에 추가:

```js
        provider: 'claude',
```

- [ ] **Step 6: 서버가 두 provider 를 다 내보내는지 확인한다**

Run:
```bash
node --no-warnings -e "
const cp=require('child_process');
" ; node --no-warnings server.js > /dev/null 2>&1 &
sleep 2
curl -s http://127.0.0.1:7788/api/projects | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const all=j.projects.flatMap(p=>p.sessions);const by={};all.forEach(x=>by[x.provider]=(by[x.provider]||0)+1);console.log('provider별 세션:',JSON.stringify(by));});"
```
Expected: `{"claude":N,"codex":M}` 처럼 둘 다 0보다 크다.

- [ ] **Step 7: 커밋**

```bash
git add codex.js test/codex.test.js server.js
git commit -m "feat(codex): 프로젝트 카드에 Codex 세션 병합"
```

---

### Task 4: 실행 라우팅 (외부 창 + 내장 터미널)

**Files:**
- Modify: `codex.js`
- Modify: `test/codex.test.js`
- Modify: `server.js:343-371` (`claudeCommand`, `launch`), `server.js:625-635` (`/api/term/new`)
- Modify: `terminals.js:40` (`create`)

**Interfaces:**
- Consumes: 없음
- Produces: `codex.js` 가 추가로 export — `codexArgs(action: string, sessionId?: string) => string[]`, `findCodexBin() => string|null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex.test.js`
Expected: FAIL — `codex.codexArgs is not a function`

- [ ] **Step 3: 구현을 쓴다**

`codex.js` 에 추가 (`execFileSync` require 를 상단에 함께 추가):

```js
const { execFileSync } = require('node:child_process');

function codexArgs(action, sessionId) {
  if (action === 'resume' || action === 'fork') {
    if (!sessionId) throw new Error('세션 ID 가 필요합니다');
    return [action, sessionId];
  }
  if (action === 'continue') return ['resume', '--last'];
  return [];   // 'new'
}

function findCodexBin() {
  try {
    return execFileSync('where.exe', ['codex'], { encoding: 'utf8' })
      .split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}
```

export 에 `codexArgs`, `findCodexBin` 을 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex.test.js`
Expected: PASS — 19 tests

- [ ] **Step 5: `server.js` 에 provider 라우팅을 넣는다**

`server.js:37` 부근, `const CLAUDE_BIN = findClaudeBin();` 아래에 추가:

```js
const CODEX_BIN = codex.findCodexBin();
```

`claudeCommand` (343행) 아래에 형제 함수를 추가:

```js
function codexCommand(action, sessionId) {
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  if (!CODEX_BIN) throw new Error('codex 를 찾을 수 없습니다 (npm i -g @openai/codex)');
  return [`& ${q(CODEX_BIN)}`, ...codex.codexArgs(action, sessionId)].join(' ');
}
```

`launch()` (354행) 의 시그니처와 `inner` 줄을 바꾼다:

```js
function launch({ action, cwd, sessionId, title, extra, provider }) {
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`폴더가 없습니다: ${cwd}`);
  if ((action === 'resume' || action === 'fork') && !SAFE_ID.test(String(sessionId || '')))
    throw new Error('세션 ID 가 올바르지 않습니다');
  const inner = provider === 'codex'
    ? codexCommand(action, sessionId)
    : claudeCommand(action, sessionId, extra);
```

나머지 본문은 그대로 둔다.

- [ ] **Step 6: 내장 터미널에도 provider 를 통과시킨다**

`server.js:629` 의 `terminals.create({...})` 호출에 두 줄을 더한다:

```js
      const t = terminals.create({
        action: b.action || 'new', cwd: b.cwd, sessionId: b.sessionId,
        title: b.title, cols: b.cols, rows: b.rows, model: b.model,
        claudeBin: CLAUDE_BIN,
        provider: b.provider === 'codex' ? 'codex' : 'claude',
        codexBin: CODEX_BIN,
      });
```

`terminals.js:40` 의 `create` 를 바꾼다:

```js
function create({ action, cwd, sessionId, title, cols, rows, claudeBin, model, provider, codexBin }) {
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`폴더가 없습니다: ${cwd}`);

  const isCodex = provider === 'codex';
  const bin = isCodex ? codexBin : claudeBin;
  if (!bin) throw new Error(isCodex ? 'codex 를 찾을 수 없습니다' : 'claude 를 찾을 수 없습니다');

  const args = isCodex
    ? require('./codex.js').codexArgs(action, sessionId)
    : claudeArgs(action, sessionId);
  if (model && !isCodex) args.push('--model', model);

  const p = pty.spawn(bin, args, {
```

그리고 터미널 객체(`terminals.js:57` 부근 `const t = {`)에 `provider` 를 담는다. `id, action, cwd, sessionId: sessionId || null,` 다음 줄에 추가:

```js
    provider: isCodex ? 'codex' : 'claude',
```

`info()` 가 이 필드를 내보내는지 확인하고, 빠져 있으면 더한다.

- [ ] **Step 7: 실제로 Codex 터미널이 뜨는지 확인한다**

서버를 띄우고:
```bash
curl -s -X POST http://127.0.0.1:7788/api/term/new -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:7788" -d "{\"action\":\"new\",\"provider\":\"codex\",\"cwd\":\"D:\\\\00.project\\\\Claude_Code\",\"cols\":100,\"rows\":30}"
```
Expected: `{"ok":true,"term":{...,"provider":"codex",...}}` 그리고 `tasklist /FI "IMAGENAME eq codex.exe"` 에 프로세스가 보인다. 확인 후 `/api/term/kill` 로 정리한다.

- [ ] **Step 8: 커밋**

```bash
git add codex.js test/codex.test.js server.js terminals.js
git commit -m "feat(codex): 외부 창과 내장 터미널 실행 라우팅"
```

---

### Task 5: 대화 보기 (rollout jsonl 파서)

**Files:**
- Modify: `codex.js`
- Modify: `test/codex.test.js`
- Modify: `server.js:475-480` (`/api/transcript`)

**Interfaces:**
- Consumes: Task 3 의 `sessions()` (rolloutPath 조회용 — 캐시가 걸려 있어 `readThreads()` 보다 낫다)
- Produces: `codex.js` 가 추가로 export — `transcript(sessionId: string, limit: number) => { msgs: Array<{role, text, at}>, total: number }`. `role` 은 `'user' | 'assistant' | 'tool'` 로 Claude 쪽과 같은 어휘를 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex.test.js`
Expected: FAIL — `codex.parseRollout is not a function`

- [ ] **Step 3: 구현을 쓴다**

`codex.js` 에 추가:

```js
// rollout jsonl 한 줄 = { timestamp, type, payload }.
// 첫 줄(session_meta)은 base_instructions 때문에 50KB 를 넘을 수 있어
// 줄 단위로 읽되 내용은 필요한 것만 뽑는다.
function rowToMsg(j) {
  const p = j.payload || {};
  const at = j.timestamp || null;
  if (j.type === 'event_msg' && p.type === 'user_message' && p.message)
    return { role: 'user', text: String(p.message), at };
  if (j.type === 'event_msg' && p.type === 'agent_message' && p.message)
    return { role: 'assistant', text: String(p.message), at };
  if (j.type === 'response_item' && p.type === 'function_call')
    return { role: 'tool', text: `${p.name || 'tool'} ${String(p.arguments || '').slice(0, 400)}`, at };
  return null;
}

function parseRollout(file, limit) {
  if (!file || !fs.existsSync(file)) return { msgs: [], total: 0 };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { msgs: [], total: 0 }; }

  const msgs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const m = rowToMsg(j);
    if (m) msgs.push(m);
  }
  const n = Math.max(1, Number(limit) || 40);
  return { msgs: msgs.slice(-n), total: msgs.length };
}

function transcript(sessionId, limit) {
  // sessions() 를 쓴다 - readThreads() 는 매번 DB 를 다시 연다
  const row = sessions().find(r => r.id === sessionId);
  if (!row) throw new Error('세션을 찾을 수 없습니다');
  // 경로 탈출 차단: rollout 은 반드시 ~/.codex/sessions 하위여야 한다
  const sessionsDir = path.join(CODEX_HOME, 'sessions');
  const real = path.resolve(row.rolloutPath || '');
  if (!real.startsWith(path.resolve(sessionsDir))) throw new Error('세션 파일 경로가 올바르지 않습니다');
  return parseRollout(real, limit);
}
```

export 에 `parseRollout`, `transcript` 를 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex.test.js`
Expected: PASS — 23 tests

- [ ] **Step 5: 서버 라우팅을 붙인다**

`server.js:475` 의 `/api/transcript` 블록을 다음으로 바꾼다:

```js
    if (url.pathname === '/api/transcript') {
      const limit = Number(url.searchParams.get('limit')) || 40;
      if (url.searchParams.get('provider') === 'codex') {
        const id = url.searchParams.get('id') || '';
        if (!SAFE_ID.test(id)) throw new Error('세션 ID 가 올바르지 않습니다');
        return json(res, 200, codex.transcript(id, limit));
      }
      return json(res, 200, transcript(
        url.searchParams.get('slug') || '',
        url.searchParams.get('id') || '', limit));
    }
```

- [ ] **Step 6: 실제 세션으로 확인한다**

```bash
ID=$(node --no-warnings -e "const c=require('./codex.js');const r=c.sessions();console.log(r[0]?r[0].id:'')")
curl -s "http://127.0.0.1:7788/api/transcript?provider=codex&id=$ID&limit=5" | head -c 400
```
Expected: `{"msgs":[{"role":"user","text":"...` 형태

- [ ] **Step 7: 커밋**

```bash
git add codex.js test/codex.test.js server.js
git commit -m "feat(codex): rollout jsonl 대화 보기"
```

---

### Task 6: 훅 브리지 스크립트

**Files:**
- Create: `codex-hook.js`
- Create: `test/codex-hook.test.js`

**Interfaces:**
- Consumes: 없음
- Produces: 실행 파일 `codex-hook.js`. stdin 으로 훅 JSON 을 받아 `CCL_HOOK_URL`(기본 `http://127.0.0.1:7788/api/hook`)로 POST 하고, 실행 상태 파일을 갱신한다. 실패해도 **항상 exit 0** 이어야 한다 — 0 이 아니면 Codex 턴이 막힌다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/codex-hook.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runHook(payload, env) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'codex-hook.js')], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('훅은 받은 JSON 을 그대로 POST 한다', async () => {
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => { got = JSON.parse(b); res.writeHead(200); res.end('{}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/hook`;
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));

  runHook({ hook_event_name: 'PreToolUse', session_id: 'aaa', cwd: 'D:\\x', tool_name: 'Bash' },
          { CCL_HOOK_URL: url, CCL_LIVE_DIR: live });

  await new Promise(r => setTimeout(r, 300));
  srv.close();
  assert.equal(got.hook_event_name, 'PreToolUse');
  assert.equal(got.session_id, 'aaa');
  assert.equal(got.provider, 'codex');     // 훅이 provider 를 붙인다
});

test('SessionStart 는 실행 상태 파일을 만든다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  runHook({ hook_event_name: 'SessionStart', session_id: 'bbb', cwd: 'D:\\x' },
          { CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook', CCL_LIVE_DIR: live });
  const f = path.join(live, 'bbb.json');
  assert.ok(fs.existsSync(f));
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(j.sessionId, 'bbb');
  assert.equal(j.status, 'idle');
});

test('UserPromptSubmit 은 busy, Stop 은 idle 로 바꾼다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  const env = { CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook', CCL_LIVE_DIR: live };
  runHook({ hook_event_name: 'SessionStart', session_id: 'ccc', cwd: 'D:\\x' }, env);
  runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'ccc', cwd: 'D:\\x' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'ccc.json'), 'utf8')).status, 'busy');
  runHook({ hook_event_name: 'Stop', session_id: 'ccc', cwd: 'D:\\x' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'ccc.json'), 'utf8')).status, 'idle');
});

test('SessionEnd 는 실행 상태 파일을 지운다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  const env = { CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook', CCL_LIVE_DIR: live };
  runHook({ hook_event_name: 'SessionStart', session_id: 'ddd', cwd: 'D:\\x' }, env);
  runHook({ hook_event_name: 'SessionEnd', session_id: 'ddd', cwd: 'D:\\x' }, env);
  assert.ok(!fs.existsSync(path.join(live, 'ddd.json')));
});

test('서버가 죽어 있어도 exit 0 이고 stdout 은 비어 있다', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  const out = runHook({ hook_event_name: 'PreToolUse', session_id: 'eee', cwd: 'D:\\x' },
                      { CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook', CCL_LIVE_DIR: live });
  assert.equal(out, '');
});

test('stdin 이 깨진 JSON 이어도 exit 0', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'codex-hook.js')], {
    input: '{깨짐', encoding: 'utf8',
    env: { ...process.env, CCL_HOOK_URL: 'http://127.0.0.1:1/api/hook' },
  });
  assert.equal(out, '');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex-hook.test.js`
Expected: FAIL — `Cannot find module ... codex-hook.js`

- [ ] **Step 3: 구현을 쓴다**

`codex-hook.js`:

```js
// Codex 훅이 실행하는 다리. stdin 으로 훅 JSON 을 받아 런처로 POST 하고
// 실행 상태 파일을 갱신한다.
//
// Codex 는 type:"http" 훅을 지원하지 않는다 (핸들러는 command 와 mcp_tool 뿐).
// 그래서 Claude 쪽처럼 프로세스 없이 갈 수가 없다. hooks.json 에서
// "async": true 로 걸어 이 프로세스가 턴을 막지 않게 한다.
//
// 무슨 일이 있어도 exit 0 이어야 한다. 0 이 아니면 Codex 가 턴을 막는다.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOOK_URL = process.env.CCL_HOOK_URL || 'http://127.0.0.1:7788/api/hook';
const LIVE_DIR = process.env.CCL_LIVE_DIR
  || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.cc-launcher-live');

// 이벤트별로 실행 상태를 어떻게 바꿀지
const STATUS = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  PostToolUse: 'busy',
  PermissionRequest: 'waiting',
  Stop: 'idle',
  Interrupt: 'idle',
};

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function updateLive(body) {
  const id = String(body.session_id || '');
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return;
  const file = path.join(LIVE_DIR, id + '.json');
  try {
    if (body.hook_event_name === 'SessionEnd') { fs.rmSync(file, { force: true }); return; }
    const status = STATUS[body.hook_event_name];
    if (!status) return;
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      sessionId: id, status, cwd: body.cwd || null,
      pid: process.ppid, at: Date.now(),
    }), 'utf8');
  } catch {}
}

function post(body, done) {
  let u;
  try { u = new URL(HOOK_URL); } catch { return done(); }
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length,
               Origin: `http://${u.host}` },
    timeout: 2000,
  }, res => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(data);
}

let body;
try { body = JSON.parse(readStdin()); } catch { process.exit(0); }
if (!body || typeof body !== 'object') process.exit(0);

body.provider = 'codex';
updateLive(body);
post(body, () => process.exit(0));
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex-hook.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: 커밋**

```bash
git add codex-hook.js test/codex-hook.test.js
git commit -m "feat(codex): 훅 브리지 스크립트"
```

---

### Task 7: hooks.json 설치 / 제거

**Files:**
- Create: `codex-hooks-install.js`
- Create: `test/codex-hooks-install.test.js`
- Modify: `server.js` (`/api/hooks/status|install|uninstall` 에 provider 분기)

**Interfaces:**
- Consumes: Task 6 의 `codex-hook.js` 경로
- Produces: `codex-hooks-install.js` 가 `{ status(), install(), uninstall(), HOOKS_FILE, EVENTS }` 를 export. 시그니처는 기존 `hooks-install.js` 와 같은 모양이되 url 대신 스크립트 경로로 우리 항목을 식별한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/codex-hooks-install.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-hooks-'));
  delete require.cache[require.resolve('../codex-hooks-install.js')];
  process.env.CODEX_HOME = dir;
  return { dir, mod: require('../codex-hooks-install.js') };
}

test('install 은 12개 이벤트를 전부 건다', () => {
  const { dir, mod } = fresh();
  const r = mod.install();
  assert.equal(r.ok, true);
  assert.equal(r.installed.length, 12);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.ok(j.hooks.PreToolUse);
  assert.equal(j.hooks.PreToolUse[0].hooks[0].type, 'command');
});

test('SessionEnd 를 뺀 나머지는 async 다', () => {
  const { dir, mod } = fresh();
  mod.install();
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.equal(j.hooks.PreToolUse[0].hooks[0].async, true);
  assert.equal(j.hooks.SessionEnd[0].hooks[0].async, undefined);
  assert.ok(j.hooks.SessionEnd[0].hooks[0].timeout <= 3);
});

test('status 는 설치 전후를 구분한다', () => {
  const { mod } = fresh();
  assert.equal(mod.status().installed.length, 0);
  mod.install();
  assert.equal(mod.status().installed.length, 12);
});

test('uninstall 은 우리 것만 지우고 남의 훅은 둔다', () => {
  const { dir, mod } = fresh();
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'other.exe' }] }] },
  }), 'utf8');
  mod.install();
  mod.uninstall();
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  assert.equal(j.hooks.PreToolUse.length, 1);
  assert.equal(j.hooks.PreToolUse[0].hooks[0].command, 'other.exe');
});

test('install 은 기존 파일을 백업한다', () => {
  const { dir, mod } = fresh();
  fs.writeFileSync(path.join(dir, 'hooks.json'), '{"hooks":{}}', 'utf8');
  const r = mod.install();
  assert.ok(r.backup);
  assert.ok(fs.existsSync(r.backup));
});

test('install 은 깨진 기존 파일에 던지고 덮어쓰지 않는다', () => {
  const { dir, mod } = fresh();
  fs.writeFileSync(path.join(dir, 'hooks.json'), '{깨짐', 'utf8');
  assert.throws(() => mod.install());
  assert.equal(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), '{깨짐');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex-hooks-install.test.js`
Expected: FAIL — `Cannot find module '../codex-hooks-install.js'`

- [ ] **Step 3: 구현을 쓴다**

`codex-hooks-install.js`:

```js
// ~/.codex/hooks.json 에 런처 훅을 설치/제거한다.
// 기존 hooks-install.js 와 같은 안전장치를 쓴다 - 백업, 임시 파일에 쓰고
// 다시 파싱해 검증한 뒤 rename, 우리 항목만 식별해 남의 훅은 안 건드린다.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const HOOKS_FILE = path.join(CODEX_HOME, 'hooks.json');
const SCRIPT = path.join(__dirname, 'codex-hook.js');

// SessionEnd 는 항상 동기이고 타임아웃이 1~3초다. 나머지는 async 로 뺀다.
const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
                'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
                'PreCompact', 'PostCompact'];

function entryFor(event) {
  const h = {
    type: 'command',
    command: `"${process.execPath}" "${SCRIPT}"`,
    statusMessage: 'cc-launcher',
  };
  if (event === 'SessionEnd' || event === 'Interrupt') h.timeout = 3;
  else { h.async = true; h.timeout = 30; }
  return { matcher: '*', hooks: [h] };
}

function isOurs(entry) {
  return (entry?.hooks || []).some(h => String(h.command || '').includes('codex-hook.js'));
}

function readFile() {
  if (!fs.existsSync(HOOKS_FILE)) return { text: '', data: {} };
  const text = fs.readFileSync(HOOKS_FILE, 'utf8');
  if (!text.trim()) return { text, data: {} };
  return { text, data: JSON.parse(text) };   // 깨졌으면 여기서 던진다
}

function backup(text) {
  if (!text) return null;
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const base = `${HOOKS_FILE}.bak_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_`
             + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let file = base, i = 1;
  while (fs.existsSync(file)) file = `${base}_${i++}`;
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function writeSafely(data) {
  const out = JSON.stringify(data, null, 2);
  const tmp = HOOKS_FILE + '.tmp_' + process.pid;
  fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });
  fs.writeFileSync(tmp, out, 'utf8');
  const back = JSON.parse(fs.readFileSync(tmp, 'utf8'));   // 재파싱 검증
  if (!back || typeof back !== 'object') { fs.unlinkSync(tmp); throw new Error('검증 실패'); }
  fs.renameSync(tmp, HOOKS_FILE);
  return out.length;
}

function status() {
  let data;
  try { data = readFile().data; } catch (e) { return { ok: false, error: String(e.message) }; }
  const hooks = data.hooks || {};
  const installed = [];
  const otherHooks = {};
  for (const [ev, entries] of Object.entries(hooks)) {
    for (const entry of (entries || [])) if (isOurs(entry)) installed.push(ev);
    const n = (entries || []).filter(e => !isOurs(e)).length;
    if (n) otherHooks[ev] = n;
  }
  return { ok: true, installed: installed.sort(), otherHooks, file: HOOKS_FILE, available: EVENTS };
}

function install() {
  const { text, data } = readFile();
  const bak = backup(text);
  data.hooks = data.hooks || {};
  for (const ev of EVENTS) {
    const list = (data.hooks[ev] || []).filter(e => !isOurs(e));
    list.push(entryFor(ev));
    data.hooks[ev] = list;
  }
  const bytes = writeSafely(data);
  return { ok: true, installed: EVENTS.slice().sort(), backup: bak, bytes, file: HOOKS_FILE };
}

function uninstall() {
  const { text, data } = readFile();
  const bak = backup(text);
  const removed = [];
  for (const [ev, entries] of Object.entries(data.hooks || {})) {
    const kept = (entries || []).filter(e => !isOurs(e));
    if (kept.length !== (entries || []).length) removed.push(ev);
    if (kept.length) data.hooks[ev] = kept; else delete data.hooks[ev];
  }
  const bytes = writeSafely(data);
  return { ok: true, removed: removed.sort(), backup: bak, bytes };
}

module.exports = { status, install, uninstall, HOOKS_FILE, EVENTS };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex-hooks-install.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: 서버 엔드포인트에 provider 분기를 넣는다**

`server.js` 상단에 추가:

```js
const codexHooks = require('./codex-hooks-install.js');
```

`server.js:545-555` 의 세 블록을 다음으로 바꾼다:

```js
    if (url.pathname === '/api/hooks/status') {
      return json(res, 200, {
        claude: Object.assign(hooksInstall.status(HOOK_URL), { url: HOOK_URL }),
        codex: codexHooks.status(),
      });
    }
    if (url.pathname === '/api/hooks/install' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, b.provider === 'codex'
        ? codexHooks.install()
        : hooksInstall.install(HOOK_URL, b.mode));
    }
    if (url.pathname === '/api/hooks/uninstall' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, b.provider === 'codex'
        ? codexHooks.uninstall()
        : hooksInstall.uninstall(HOOK_URL));
    }
```

**주의:** `/api/hooks/status` 의 응답 모양이 바뀐다. `public/live.js` 가 이 값을 읽으므로 Task 9 에서 같이 고친다. 이 태스크에서는 서버만 바꾸고, 프론트가 잠시 깨지는 것을 감수한다.

- [ ] **Step 6: 실제 설치/제거를 왕복해본다**

```bash
node -e "const m=require('./codex-hooks-install.js'); console.log(JSON.stringify(m.install(),null,1))"
node -e "const m=require('./codex-hooks-install.js'); console.log(m.status().installed.length)"
node -e "const m=require('./codex-hooks-install.js'); console.log(JSON.stringify(m.uninstall(),null,1))"
```
Expected: install 이 12개, status 가 12, uninstall 이 12개를 제거. `~/.codex/hooks.json` 에 백업 파일이 남는다.

- [ ] **Step 7: 커밋**

```bash
git add codex-hooks-install.js test/codex-hooks-install.test.js server.js
git commit -m "feat(codex): hooks.json 설치/제거 + 서버 엔드포인트 분기"
```

---

### Task 8: 실행 상태 읽기 + 이벤트 정규화

**Files:**
- Modify: `codex.js`
- Modify: `test/codex.test.js`
- Modify: `server.js:145` 부근 (`liveSessions`), `scan()` 의 Codex 병합 블록
- Modify: `events.js` (PermissionRequest 매핑)

**Interfaces:**
- Consumes: Task 6 이 쓰는 `~/.codex/.cc-launcher-live/<id>.json` 파일
- Produces: `codex.js` 가 추가로 export — `liveMap(dir?: string) => Map<string, {status, cwd, pid, at}>`. `status` 는 `'busy' | 'idle' | 'waiting'`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
test('liveMap 은 상태 파일을 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-live-'));
  fs.writeFileSync(path.join(dir, 'aaa-111.json'), JSON.stringify({
    sessionId: 'aaa-111', status: 'busy', cwd: 'D:\\x', pid: 123, at: Date.now() }), 'utf8');
  const m = codex.liveMap(dir);
  assert.equal(m.get('aaa-111').status, 'busy');
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex.test.js`
Expected: FAIL — `codex.liveMap is not a function`

- [ ] **Step 3: 구현을 쓴다**

`codex.js` 에 추가:

```js
const LIVE_DIR = path.join(CODEX_HOME, '.cc-launcher-live');
const LIVE_MAX_AGE = 24 * 60 * 60 * 1000;   // 하루 넘은 상태 파일은 죽은 것으로 본다

// Codex 에는 ~/.claude/sessions/<pid>.json 대응물이 없다.
// 우리 훅(codex-hook.js)이 쓴 파일을 읽는다.
function liveMap(dir) {
  const d = dir || LIVE_DIR;
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch { return out; }
  const now = Date.now();
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
    if (!j || !j.sessionId) continue;
    if (now - Number(j.at || 0) > LIVE_MAX_AGE) continue;
    out.set(String(j.sessionId), {
      status: j.status === 'busy' || j.status === 'waiting' ? j.status : 'idle',
      cwd: j.cwd || null, pid: j.pid || null, at: j.at || 0,
    });
  }
  return out;
}
```

export 에 `liveMap`, `LIVE_DIR` 을 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex.test.js`
Expected: PASS — 27 tests

- [ ] **Step 5: `scan()` 의 Codex 블록에 live 를 붙인다**

Task 3 에서 넣은 Codex 병합 블록에서, 루프 앞에 한 줄을 추가하고 `live: null` 을 바꾼다:

```js
  const codexLive = codex.liveMap();
  for (const s of codex.sessions()) {
```

그리고 push 안의 `live: null,` 을 다음으로:

```js
      live: codexLive.get(s.id) || null,
```

- [ ] **Step 6: `events.js` 에 PermissionRequest 를 매핑한다**

`events.js` 에서 승인 대기를 판정하는 곳(`Notification` 과 `permission_prompt` 를 함께 보는 지점)을 찾아, Codex 의 `PermissionRequest` 도 같은 결론이 나오게 조건을 넓힌다. 구현 시 실제 코드를 읽고 다음 성질을 만족시킨다:

- `hook_event_name === 'PermissionRequest'` 인 이벤트가 오면 그 세션의 단계가 `승인 대기` 가 된다.
- 기존 Claude 의 `Notification: permission_prompt` 판정은 그대로 동작한다.

- [ ] **Step 7: 훅을 걸고 실제로 상태가 잡히는지 확인한다**

```bash
node -e "require('./codex-hooks-install.js').install()"
```
그 다음 대시보드에서 Codex 세션을 하나 띄우고:
```bash
curl -s http://127.0.0.1:7788/api/projects | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const live=j.projects.flatMap(p=>p.sessions).filter(x=>x.provider==='codex'&&x.live);console.log('살아있는 Codex 세션:',live.length,live.map(x=>x.live.status).join(','));});"
```
Expected: 1 이상, 상태가 `busy` 또는 `idle`

- [ ] **Step 8: 커밋**

```bash
git add codex.js test/codex.test.js server.js events.js
git commit -m "feat(codex): 훅 기반 실행 상태 + PermissionRequest 매핑"
```

---

### Task 9: UI — provider 섹션 분리

**Files:**
- Modify: `public/index.html` (카드 렌더링, 새 세션 버튼, 즐겨찾기, 대화 열기)
- Modify: `public/live.js` (`/api/hooks/status` 응답 모양 변경 대응)
- Modify: `server.js:499-509` (`/api/fav` 의 키)

**Interfaces:**
- Consumes: Task 3 의 세션 `provider` 필드, Task 7 의 `/api/hooks/status` 새 응답 `{claude, codex}`
- Produces: 없음 (최종 소비자)

- [ ] **Step 1: 즐겨찾기 키를 provider 인식으로 바꾼다**

`server.js:499` 의 `/api/fav` 블록을 다음으로 바꾼다:

```js
    if (url.pathname === '/api/fav' && req.method === 'POST') {
      const b = await readBody(req);
      if (!SAFE_ID.test(String(b.id || ''))) throw new Error('잘못된 세션 지정');
      let token;
      if (b.provider === 'codex') token = 'codex:' + b.id;
      else {
        if (!SAFE_SLUG.test(String(b.slug || ''))) throw new Error('잘못된 세션 지정');
        token = `${b.slug}/${b.id}`;      // 기존 형식 유지 - favorites.json 하위호환
      }
      const favs = loadFavs();
      const i = favs.indexOf(token);
      if (i >= 0) favs.splice(i, 1); else favs.push(token);
      saveFavs(favs);
      return json(res, 200, { ok: true, fav: i < 0 });
    }
```

- [ ] **Step 2: 카드 렌더링을 provider 섹션으로 나눈다**

`public/index.html` 에서 프로젝트 카드의 세션 목록을 그리는 함수를 찾아, 한 목록을 그리던 자리를 두 묶음으로 나눈다. 다음 성질을 만족시킨다:

- 세션을 `provider` 로 갈라 `Claude Code` 묶음을 먼저, `Codex` 묶음을 다음에 그린다.
- 각 묶음 앞에 이름표(`Claude Code` / `Codex`)를 넣고, **그 provider 세션이 없으면 이름표도 그리지 않는다.**
- 묶음 안의 정렬은 기존과 같다 — 실행 중 우선, 그 다음 최근순.
- `+ 더 보기` 는 묶음별로 센다.
- 검색 필터는 두 묶음에 똑같이 걸린다.

- [ ] **Step 3: 실행 버튼에 provider 를 실어 보낸다**

세션 행의 `이어하기` / `포크` 버튼이 `/api/launch` 와 `/api/term/new` 를 부를 때 body 에 `provider: <그 세션의 provider>` 를 넣는다. `대화 보기` 는 `/api/transcript` 호출에 `provider` 쿼리 파라미터를 붙이고, Codex면 `slug` 를 보내지 않는다. `★` 토글은 `/api/fav` 에 `provider` 를 실어 보낸다.

- [ ] **Step 4: `새 세션` 에 provider 선택을 붙인다**

프로젝트 카드의 `새 세션` 을 두 개로 나눈다 — `새 세션 (Claude)` 과 `새 세션 (Codex)`. `CODEX_BIN` 이 없으면 Codex 버튼은 비활성으로 두고 `codex 가 설치되지 않았습니다` 를 title 로 단다. 서버가 `/api/projects` 응답의 `env` 에 `codex` 경로를 이미 실어 보내도록 `server.js:464` 를 고친다:

```js
        env: { claude: CLAUDE_BIN, codex: CODEX_BIN, wt: WT_BIN, projectsDir: PROJECTS_DIR },
```

- [ ] **Step 5: `public/live.js` 를 새 응답 모양에 맞춘다**

`live.js` 는 지금 `/api/hooks/status` 응답을 평평한 객체로 읽는다(`h.installed`, `h.mode`). Task 7 에서 `{claude, codex}` 로 바뀌었으므로, 배너가 두 provider 를 각각 보여주게 고친다:

- Claude 배너는 기존 그대로 `h.claude` 를 읽는다.
- Codex 줄을 하나 더 만들어 `h.codex.installed.length` 를 보여주고, 설치/제거 버튼은 `/api/hooks/install|uninstall` 에 `{provider:'codex'}` 를 보낸다.
- Codex 는 mode 구분(lifecycle/full)이 없다. 버튼은 `관측 켜기` / `관측 끄기` 두 개다.

- [ ] **Step 6: 브라우저에서 확인한다**

서버를 띄우고 `http://127.0.0.1:7788` 을 새로고침한 뒤 눈으로 확인한다:

1. 두 provider 세션이 있는 프로젝트 카드에 `Claude Code` / `Codex` 이름표가 둘 다 보인다.
2. Claude 세션만 있는 카드에는 `Codex` 이름표가 안 보인다.
3. Codex 세션의 `대화 보기` 가 내용을 띄운다.
4. Codex 세션의 `이어하기` 가 터미널에서 열린다.
5. `★` 를 눌렀다 떼면 즐겨찾기 탭에 나타났다 사라진다.
6. 연결 탭 배너에 Claude 줄과 Codex 줄이 각각 보인다.

- [ ] **Step 7: 전체 테스트를 돌린다**

Run: `npm test`
Expected: PASS — 전체 통과 (39 tests: codex 27 + hook 6 + hooks-install 6)

- [ ] **Step 8: 커밋**

```bash
git add public/index.html public/live.js server.js
git commit -m "feat(codex): 카드 provider 섹션 분리와 실행/즐겨찾기 라우팅"
```

---

### Task 10: 구성 탭에 Codex 읽기

TOML 파서를 쓰지 않는다. `codex doctor --json` 이 설정을 평평한 JSON 으로 준다.

**Files:**
- Modify: `codex.js`
- Modify: `test/codex.test.js`
- Modify: `server.js` (`/api/cfg/codex` 추가)
- Modify: `public/harness-ui.js` (구성 탭에 Codex 섹션)

**Interfaces:**
- Consumes: Task 4 의 `findCodexBin`
- Produces: `codex.js` 가 추가로 export — `parseDoctor(json: object) => { ok, version, status, checks: Array<{id, category, status, summary, details}> }`, `doctor(cb: (err, report) => void) => void` (비동기, `codex doctor --json` 실행)

`codex doctor --json` 응답 모양(실측):

```json
{ "schemaVersion": 1, "overallStatus": "warning", "codexVersion": "0.153.2",
  "checks": {
    "config.load": { "id": "config.load", "category": "config", "status": "ok",
      "summary": "config loaded",
      "details": { "model": "gpt-5.5", "model provider": "openai", "mcp servers": "5",
                   "config.toml": "C:\\Users\\macjo\\.codex\\config.toml" } },
    "mcp.config": { "status": "warning", "summary": "MCP configuration has optional issues",
      "details": { "configured servers": "5", "stdio servers": "3" } },
    "auth.credentials": { "status": "ok", "summary": "auth is configured",
      "details": { "stored auth mode": "chatgpt" } }
  } }
```

`details` 는 항상 `{문자열: 문자열}` 평면 맵이다. 체크는 실측 24개.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
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
  assert.equal(r.checks[0].id, 'config.load');
  assert.equal(r.checks[0].details.model, 'gpt-5.5');
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/codex.test.js`
Expected: FAIL — `codex.parseDoctor is not a function`

- [ ] **Step 3: 구현을 쓴다**

`codex.js` 에 추가 (`execFile` 을 상단 require 에 더한다):

```js
const { execFile } = require('node:child_process');

const STATUS_ORDER = { fail: 0, error: 0, warning: 1, warn: 1, ok: 2, idle: 3 };

function parseDoctor(json) {
  if (!json || typeof json !== 'object' || !json.checks || typeof json.checks !== 'object')
    return { ok: false, version: null, status: null, checks: [] };
  const checks = Object.values(json.checks)
    .filter(c => c && typeof c === 'object')
    .map(c => ({
      id: String(c.id || ''), category: String(c.category || ''),
      status: String(c.status || ''), summary: String(c.summary || ''),
      details: (c.details && typeof c.details === 'object') ? c.details : {},
    }))
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
                    || a.id.localeCompare(b.id));
  return { ok: true, version: json.codexVersion || null,
           status: json.overallStatus || null, checks };
}

// codex doctor 는 네트워크 확인까지 해서 수 초가 걸린다.
// 구성 로딩과 분리해 버튼을 눌렀을 때만 부른다 (Claude 쪽 MCP 확인과 같은 방침).
function doctor(cb) {
  const bin = findCodexBin();
  if (!bin) return cb(new Error('codex 를 찾을 수 없습니다'));
  execFile(bin, ['doctor', '--json'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      if (err && !stdout) return cb(err);
      let j;
      try { j = JSON.parse(stdout); } catch (e) { return cb(new Error('doctor 출력을 읽지 못했습니다')); }
      cb(null, parseDoctor(j));
    });
}
```

export 에 `parseDoctor`, `doctor` 를 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/codex.test.js`
Expected: PASS — 30 tests

- [ ] **Step 5: 서버 엔드포인트를 붙인다**

`server.js` 의 `/api/mcp/list` 블록 근처에 추가:

```js
    if (url.pathname === '/api/cfg/codex') {
      return new Promise(resolve => {
        codex.doctor((err, report) => {
          resolve(json(res, 200, err ? { ok: false, error: String(err.message) } : report));
        });
      });
    }
```

- [ ] **Step 6: 실제로 응답하는지 확인한다**

```bash
curl -s http://127.0.0.1:7788/api/cfg/codex | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok:',j.ok,'version:',j.version,'checks:',j.checks&&j.checks.length);});"
```
Expected: `ok: true version: 0.153.2 checks: 24`

- [ ] **Step 7: 구성 탭에 읽기 전용 섹션을 그린다**

`public/harness-ui.js` 의 구성 탭 렌더링에 `Codex` 섹션을 더한다. 다음 성질을 만족시킨다:

- 기본은 접혀 있고 **`Codex 설정 읽기` 버튼을 눌러야 `/api/cfg/codex` 를 부른다.** 자동으로 부르지 않는다 — `codex doctor` 는 네트워크 확인까지 해서 수 초가 걸린다.
- 응답의 `checks` 를 상태별 색(ok/warning/fail)으로 목록 렌더링한다. 각 항목은 `summary` 를 제목으로, `details` 의 키-값을 그 아래 표로 그린다.
- `ok: false` 면 `error` 문자열을 그대로 보여준다 (`codex 를 찾을 수 없습니다` 등).
- **편집 컨트롤은 넣지 않는다.** 이번 범위는 읽기뿐이다.

- [ ] **Step 8: 커밋**

```bash
git add codex.js test/codex.test.js server.js public/harness-ui.js
git commit -m "feat(codex): 구성 탭에 doctor 기반 Codex 설정 읽기"
```

---

### Task 11: 토큰 사용량

**중요한 비대칭:** Codex 는 `threads.tokens_used` 컬럼 하나로 끝난다(이미 읽는 테이블). Claude 는 assistant 레코드마다 `usage` 가 박혀 있어 합치려면 파일을 통째로 읽어야 한다(실측 한 파일에 2,327건). README 가 내세우는 "세션 파일을 통째로 읽지 않는다"와 충돌하므로 **`scan()` 에서 계산하지 않는다.** 별도 엔드포인트에서 요청 시에만 계산하고 mtime+size 캐시를 건다.

**Files:**
- Create: `usage.js`
- Create: `test/usage.test.js`
- Modify: `codex.js` (SELECT 에 `tokens_used` 추가)
- Modify: `test/codex.test.js`
- Modify: `server.js` (`/api/usage` 추가)
- Modify: `public/index.html` (세션 행과 프로젝트 카드에 표시)

**Interfaces:**
- Consumes: Task 2 의 `readThreads`, Task 3 의 `sessions`
- Produces: `usage.js` 가 `{ sumUsage, forClaudeFile, fmt }` 를 export —
  - `sumUsage(text: string) => { input, output, cacheWrite, cacheRead, billable, samples }`
  - `forClaudeFile(file: string) => 위와 같은 객체` (mtime+size 캐시 적용)
  - `fmt(n: number) => string` (`1.2M`, `340K`, `512`)
  - `codex.js` 의 세션 객체에 `tokens: number` 필드가 생긴다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/usage.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const usage = require('../usage.js');

test('sumUsage 는 usage 레코드를 합친다', () => {
  const text = [
    JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 5,
      cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 2, output_tokens: 7,
      cache_creation_input_tokens: 50, cache_read_input_tokens: 2000 } } }),
  ].join('\n');
  const u = usage.sumUsage(text);
  assert.equal(u.input, 12);
  assert.equal(u.output, 12);
  assert.equal(u.cacheWrite, 150);
  assert.equal(u.cacheRead, 3000);
  assert.equal(u.samples, 2);
});

test('billable 은 캐시 읽기를 빼고 센다', () => {
  // cache_read 는 이미 있는 컨텍스트를 다시 읽는 것이라 매 턴 누적되어
  // 합치면 실제 소비량을 크게 부풀린다. 별도로 두고 billable 에서는 뺀다.
  const text = JSON.stringify({ message: { usage: {
    input_tokens: 10, output_tokens: 5,
    cache_creation_input_tokens: 100, cache_read_input_tokens: 999999 } } });
  assert.equal(usage.sumUsage(text).billable, 115);
});

test('sumUsage 는 usage 없는 줄과 깨진 줄을 건너뛴다', () => {
  const text = ['{깨짐', JSON.stringify({ type: 'user' }),
    JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 1 } } })].join('\n');
  const u = usage.sumUsage(text);
  assert.equal(u.samples, 1);
  assert.equal(u.billable, 2);
});

test('sumUsage 는 빈 입력에 0', () => {
  const u = usage.sumUsage('');
  assert.equal(u.samples, 0);
  assert.equal(u.billable, 0);
});

test('forClaudeFile 은 같은 파일을 두 번째엔 캐시로 준다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-usage-'));
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, JSON.stringify({ message: { usage: {
    input_tokens: 3, output_tokens: 4 } } }) + '\n', 'utf8');
  const a = usage.forClaudeFile(f);
  const b = usage.forClaudeFile(f);
  assert.equal(a.billable, 7);
  assert.strictEqual(a, b);      // 캐시라 같은 객체가 나온다
});

test('forClaudeFile 은 없는 파일에 0', () => {
  assert.equal(usage.forClaudeFile('C:\\없는\\s.jsonl').billable, 0);
});

test('fmt 는 사람이 읽을 크기로 줄인다', () => {
  assert.equal(usage.fmt(512), '512');
  assert.equal(usage.fmt(340000), '340K');
  assert.equal(usage.fmt(1200000), '1.2M');
  assert.equal(usage.fmt(0), '0');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/usage.test.js`
Expected: FAIL — `Cannot find module '../usage.js'`

- [ ] **Step 3: 구현을 쓴다**

`usage.js`:

```js
// 세션 토큰 사용량. Claude 는 파일을 통째로 읽어야 나오므로
// scan() 에서 부르지 않는다 - /api/usage 에서 요청 시에만 계산하고 캐시한다.
'use strict';

const fs = require('node:fs');

function empty() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0, samples: 0 };
}

function sumUsage(text) {
  const u = empty();
  for (const line of String(text || '').split('\n')) {
    if (!line || line.indexOf('"usage"') < 0) continue;   // 싼 사전 필터
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const g = j?.message?.usage;
    if (!g || typeof g !== 'object') continue;
    u.input += Number(g.input_tokens) || 0;
    u.output += Number(g.output_tokens) || 0;
    u.cacheWrite += Number(g.cache_creation_input_tokens) || 0;
    u.cacheRead += Number(g.cache_read_input_tokens) || 0;
    u.samples++;
  }
  // cache_read 는 매 턴 같은 컨텍스트를 다시 읽는 값이라 누적하면
  // 실제 소비량을 크게 부풀린다. 따로 보여주되 billable 에서는 뺀다.
  u.billable = u.input + u.output + u.cacheWrite;
  return u;
}

const cache = new Map();   // file -> { mtimeMs, size, u }

function forClaudeFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return empty(); }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.u;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return empty(); }
  const u = sumUsage(text);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, u });
  return u;
}

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(v);
}

module.exports = { sumUsage, forClaudeFile, fmt, empty };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/usage.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Codex 쪽 토큰을 세션에 싣는다**

`codex.js` 의 `SELECT` 상수에 컬럼을 더한다 — `thread_source, source` 뒤에 `, tokens_used` 를 넣는다.

`readThreads` 의 map 안에 한 줄 추가:

```js
      tokens: Number(r.tokens_used) || 0,
```

`test/codex.test.js` 의 픽스처에 컬럼을 맞춰 더하고(테이블 정의에 `tokens_used integer`, insert 에 값 추가) 테스트를 하나 넣는다:

```js
test('readThreads 는 tokens_used 를 싣는다', () => {
  const rows = codex.readThreads(makeFixtureDb());
  assert.equal(typeof rows[0].tokens, 'number');
});
```

Run: `node --test test/codex.test.js`
Expected: PASS

- [ ] **Step 6: `/api/usage` 를 만든다**

`server.js` 상단에 `const usage = require('./usage.js');` 를 더하고, 엔드포인트를 추가한다:

```js
    // 사용량은 Claude 쪽이 파일 전체 읽기라 비싸다. scan() 과 분리해 여기서만 계산한다.
    if (url.pathname === '/api/usage') {
      const out = { projects: {}, sessions: {} };
      for (const p of scan()) {
        let billable = 0, cacheRead = 0;
        for (const s of p.sessions) {
          let u;
          if (s.provider === 'codex') {
            u = Object.assign(usage.empty(), { billable: s.tokens || 0 });
          } else {
            u = usage.forClaudeFile(path.join(PROJECTS_DIR, s.slug, s.id + '.jsonl'));
          }
          out.sessions[s.provider + ':' + s.id] = u;
          billable += u.billable;
          cacheRead += u.cacheRead;
        }
        out.projects[p.key] = { billable, cacheRead };
      }
      return json(res, 200, out);
    }
```

`scan()` 의 Codex 병합 블록에서 세션 push 에 `tokens: s.tokens,` 를 더한다.

- [ ] **Step 7: 실제 응답을 확인한다**

```bash
curl -s http://127.0.0.1:7788/api/usage | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const ks=Object.keys(j.sessions);console.log('세션',ks.length);const tot=Object.values(j.projects).reduce((a,b)=>a+b.billable,0);console.log('전체 billable',tot);const cx=ks.filter(k=>k.startsWith('codex:'));console.log('codex 세션',cx.length,'예시',j.sessions[cx[0]]);});"
```
Expected: 세션 수가 두 provider 합이고, `전체 billable` 이 0보다 크다.

- [ ] **Step 8: UI 에 표시한다**

`public/index.html` 에서:

- 페이지 로드 때 `/api/usage` 를 **한 번** 부르고(카드 렌더링을 막지 않게 비동기로), 도착하면 값을 채워 넣는다. `↻` 를 누르면 다시 부른다.
- 세션 행 오른쪽에 `usage.fmt(billable)` 을 회색 작은 글씨로 붙인다. 값이 0이면 아무것도 안 그린다.
- 프로젝트 카드 머리글에 그 프로젝트 합계를 붙인다.
- 마우스를 올리면 상세를 title 로 보여준다 — `입력 X · 출력 Y · 캐시쓰기 Z · 캐시읽기 W`.
- **Codex 세션은 `tokens_used` 하나뿐이라 세부 내역이 없다.** title 에 `Codex 는 총량만 제공` 이라고 적어 Claude 와 다르다는 걸 드러낸다.

- [ ] **Step 9: 전체 테스트**

Run: `npm test`
Expected: PASS — 50 tests (codex 31 + hook 6 + hooks-install 6 + usage 7)

- [ ] **Step 10: 커밋**

```bash
git add usage.js test/usage.test.js codex.js test/codex.test.js server.js public/index.html
git commit -m "feat: Claude·Codex 토큰 사용량 표시"
```

---

### Task 12: 문서 갱신

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1-11 전부
- Produces: 없음

- [ ] **Step 1: README 에 Codex 지원을 적는다**

다음을 반영한다:

- 맨 위 소개에 Claude Code 와 Codex 세션을 함께 다룬다는 것을 한 줄로.
- `파일` 섹션에 새 파일 3개를 추가: `codex.js` (Codex 어댑터 - threads sqlite 읽기·명령·rollout 파싱), `codex-hook.js` (Codex 훅 브리지), `codex-hooks-install.js` (Codex 훅 설치/제거).
- `실시간 관측 (훅)` 섹션에 Codex 편을 더한다 — `~/.codex/hooks.json`, 이벤트 12개, `type:"command"` + `"async": true`, 그리고 **Codex 는 `type:"http"` 훅을 지원하지 않아 스크립트를 거친다**는 이유.
- `구성 (하네스)` 섹션에 Codex 편을 더한다 — `codex doctor --json` 으로 읽고, 버튼을 눌렀을 때만 부르며(수 초 걸림), **읽기 전용**이라는 것.
- `주의` 섹션에 한 줄 — 런처를 안 쓸 거면 Codex 훅도 제거하는 게 낫다.
- `단축키` 섹션에 터미널 복사/붙여넣기를 적는다: `Ctrl+V` 붙여넣기, 선택 후 `Ctrl+C` 복사(선택이 없으면 SIGINT), `Ctrl+Shift+C` 복사, 우클릭은 선택 있으면 복사·없으면 붙여넣기. **이건 이번 작업 전에 이미 구현됐는데 문서에만 빠져 있던 것이다.**
- 요구사항에 Node 24 이상을 적는다 (`node:sqlite` 때문).
- `토큰 사용량` 섹션을 새로 만든다 — 어디서 오는지(Claude 는 `usage` 레코드 합, Codex 는 `threads.tokens_used`), **캐시 읽기를 billable 에서 빼는 이유**, Codex 는 세부 내역이 없다는 것, 그리고 사용량이 `scan()` 과 분리된 이유(Claude 쪽은 파일 전체 읽기).

- [ ] **Step 2: 커밋**

```bash
git add README.md
git commit -m "docs: Codex 지원과 터미널 복사/붙여넣기 문서화"
```

---

## Self-Review 결과

**스펙 커버리지** — 스펙의 5개 섹션과 "범위 밖"을 태스크에 대조했다.

| 스펙 섹션 | 태스크 |
|---|---|
| 1. 데이터 어댑터 | Task 1, 2, 3 |
| 2. 실행 라우팅 | Task 4 |
| 3. 훅 브리지 + 실행 상태 | Task 6, 7, 8 |
| 4. UI | Task 9 |
| 5. 안전장치 | Task 7 (백업·원자적 쓰기·uninstall), Task 5 (경로 검증), Task 2 (읽기 전용) |
| 범위 밖 1 — 구성 탭은 **읽기만** | Task 10 (읽기 구현, 편집 컨트롤 없음) |

빈 곳 없음. 첫 초안에서 Task 10(구성 탭 Codex 읽기)이 빠져 있었다 — 스펙의 "범위 밖" 1번이 **편집만** 제외하므로 읽기는 범위 안이다. 자체 검토에서 잡아 채워 넣었다.

채워 넣으면서 걸린 문제 하나: 구성 탭이 `~/.codex/config.toml` 을 읽어야 하는데 Node 에 TOML 파서가 없고 전역 제약이 새 의존성을 금지한다. `codex doctor --json` 이 설정·MCP·인증을 평평한 JSON 으로 주는 것을 실측 확인해 이 경로를 택했다(체크 24개). 대가는 속도다 — doctor 는 네트워크 확인까지 해서 수 초가 걸리므로 버튼 뒤로 뺐다. 기존 구성 탭이 MCP 연결 확인(15.3초)을 버튼으로 분리한 것과 같은 방침이다.

한계도 적어둔다: doctor 는 MCP 서버 **개수**만 주고 개별 목록은 주지 않는다. 서버 이름까지 보여주려면 `codex mcp list` 를 한 번 더 불러야 하는데, 이번 범위에서는 개수까지만 보여준다.

**타입 일관성** — `provider` 는 전 구간 `'claude' | 'codex'` 문자열. `Session.mtime` 은 epoch ms 숫자로 Claude 쪽 `stat.mtimeMs` 와 같은 단위. `live` 객체는 `{status, cwd, pid, at}` 이고 `status` 는 `'busy'|'idle'|'waiting'`. Task 8 의 `liveMap` 반환과 Task 3 의 `live:` 대입이 같은 모양이다. `codexArgs` 는 Task 4 에서 정의되어 Task 4(server) 와 Task 4(terminals) 양쪽에서 같은 이름으로 쓰인다.

**알려진 위험** — Task 7 이 `/api/hooks/status` 응답 모양을 바꾸는데 프론트 대응은 Task 9 Step 5 다. 그 사이 연결 탭 배너가 깨진다. 태스크를 순서대로 진행하면 Task 9 에서 복구되지만, 중간에 멈추면 배너가 비어 보인다. Task 7 Step 5 에 이 주의를 적어두었다.
