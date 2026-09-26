# 런처 CLI 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드 내장 터미널 패인에서 런처 CLI 가 먼저 뜨고, 거기서 Codex/Claude 어느 쪽이든 골라 그 패인 그대로 들어간다.

**Architecture:** CLI 는 에이전트 입출력을 중계하지 않는다. 고르면 대시보드에 provider 를 알린 뒤 자리를 넘겨 PTY 를 에이전트에게 온전히 준다. 돌아오는 것은 CLI 가 아니라 대시보드가 `terminals.restart` 로 한다.

**Tech Stack:** Node.js (내장 모듈만), node-pty, ws. **새 의존성을 넣지 않는다.**

**Spec:** `docs/superpowers/specs/2026-09-26-launcher-cli-design.md`

## Global Constraints

- **새 의존성 금지.** `package.json` 의 `dependencies` 는 `node-pty` 와 `ws` 뿐이다. 추가하지 않는다
- **CLI 는 서버 모듈을 `require` 하지 않는다.** HTTP 로만 붙는다 (`bridge-send.js` 와 같은 결)
- **7788 을 건드리지 않는다.** 사용자의 실제 작업 세션이 붙어 있고, 서버를 내리면 진행 중인 턴이 날아간다. 확인은 `CC_LAUNCHER_PORT=7899` 로 별도 기동
- **`.js` 는 LF, `docs/*.md` 는 CRLF.** 기존 파일을 텍스트 모드로 통째 다시 쓰지 말 것 — 줄끝이 전부 바뀌어 diff 가 수천 줄이 된다 (실제로 밟았다)
- **큰 문서를 heredoc 으로 쓰지 말 것.** 본문의 따옴표·백틱에 셸이 걸린다 (이 계획서를 쓰다 실제로 걸렸다). 파일 도구로 쓰고 줄끝만 따로 맞춘다
- **provider 알림이 성공한 뒤에만 자리를 넘긴다.** 실패하면 넘어가지 않는다
- 테스트: `npm test` = `node --test test/*.test.js`. 현재 241개 통과, 약 11초

## Review Focus

- **서버가 꺼져 있을 때** — CLI 가 스택 트레이스 대신 사람 말로 거절하고 종료 코드 1 을 남긴다 (Task 5)
- **provider 알림이 실패할 때** — 자리를 넘기지 않고 사유를 남긴다. 어긋난 채 넘어가면 사용자는 "왜 스크롤이 이상하지"를 겪으며 원인을 못 찾는다 (Task 5)
- **모르는 provider 값이 들어올 때** — 엔드포인트가 400 으로 거절한다. 조용히 받아 `t.provider` 를 오염시키면 상태 판정이 엉뚱한 파일을 읽는다 (Task 2)
- **없는 터미널 id** — 404 로 거절한다 (Task 2)
- **에이전트 바이너리가 없을 때** — 실패를 잡아 사유를 남긴다. 패인이 빈 채로 죽지 않게 (Task 5)

---

### Task 1: `terminals.setProvider` — 서버가 패인의 provider 를 바꿀 수 있게

**Files:**
- Modify: `terminals.js` (`module.exports` 와 그 위)
- Test: `test/terminals.test.js`

**Interfaces:**
- Consumes: 없음 (기존 `info`, `send`, `terms` 만 쓴다)
- Produces: `setProvider(id, provider) -> info 객체 | null`. `null` 은 그 id 의 터미널이 없다는 뜻이다.

`provider` 는 `create` 때 고정되는데, 그 값이 상태를 어디서 읽을지 · 스크롤백 · 덧그림 판정을 전부 결정한다. CLI 가 자리를 넘기며 provider 를 바꾸므로 이 값도 따라 바뀌어야 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/terminals.test.js` 맨 아래에 덧붙인다.

```js
test('setProvider 는 provider 를 바꾸고 붙어 있는 화면에 새 info 를 보낸다', () => {
  const sent = [];
  terminals._terms.set('tp-1', {
    id: 'tp-1', provider: 'claude', cwd: 'D:\\tmp', title: 't',
    sessionId: null, pid: process.pid, action: 'new',
    cols: 80, rows: 24, startedAt: Date.now(), lastAt: Date.now(),
    exitCode: null, exitedAt: null, restarts: 0, buf: '',
    clients: new Set([{ readyState: 1, send: (s) => sent.push(JSON.parse(s)) }]),
  });

  const out = terminals.setProvider('tp-1', 'codex');
  assert.equal(out.provider, 'codex');
  assert.equal(terminals._terms.get('tp-1').provider, 'codex');
  assert.equal(sent.length, 1, '붙어 있는 화면이 모르면 스크롤백이 예전 값으로 남는다');
  assert.equal(sent[0].t, 'm');
  assert.equal(sent[0].info.provider, 'codex');

  terminals._terms.delete('tp-1');
});

test('setProvider 는 없는 터미널에 null 을 준다', () => {
  assert.equal(terminals.setProvider('없는-id', 'codex'), null);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/terminals.test.js`

Expected: FAIL — `terminals.setProvider is not a function`

- [ ] **Step 3: 최소 구현**

`terminals.js` 의 `module.exports` 바로 위에 넣는다.

```js
// 패인의 provider 를 바꾼다.
//
// create 때 정해진 값인데, 런처 CLI 가 반대편 에이전트로 자리를 넘기면 그 값이 낡는다.
// provider 는 상태를 어디서 읽을지(codexLiveInfo/liveInfo)·스크롤백·덧그림 판정을
// 전부 결정하므로, 낡은 채 두면 상태 판정이 엉뚱한 파일을 읽는다.
function setProvider(id, provider) {
  const t = terms.get(id);
  if (!t) return null;
  t.provider = provider === 'codex' ? 'codex' : 'claude';
  t.sessionId = null;        // 이전 에이전트의 것이다. info() 가 live 상태에서 다시 찾는다
  const nfo = info(t);
  send(t, { t: 'm', info: nfo });
  return nfo;
}
```

`module.exports` 목록에 `setProvider` 를 추가한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/terminals.test.js`

Expected: PASS

- [ ] **Step 5: 전체 테스트**

Run: `npm test`

Expected: 통과 수가 2 늘고 실패 0

- [ ] **Step 6: 커밋**

```bash
git add terminals.js test/terminals.test.js
git commit -m "패인의 provider 를 나중에 바꿀 수 있게 한다"
```

---

### Task 2: `POST /api/term/provider` — CLI 가 부를 입구

**Files:**
- Modify: `server.js` (`/api/term/restart` 배선 바로 앞)

**Interfaces:**
- Consumes: Task 1 의 `terminals.setProvider(id, provider)`
- Produces: `POST /api/term/provider` — 본문 `{ id, provider }`, 응답 `{ ok: true, info }` 또는 `{ ok: false, reason, message }`

이 레포는 엔드포인트 배선을 얇게 두고 로직을 모듈에 둔다 (`kill-result.js`, `launch-args.js` 가 그렇다). 판정은 Task 1 에서 이미 시험했으므로 여기는 배선과 입력 거절만 한다.

- [ ] **Step 1: 배선을 넣는다**

`server.js` 에서 `if (url.pathname === '/api/term/restart' && req.method === 'POST') {` 를 찾아 그 **앞에** 넣는다.

```js
    // 런처 CLI 가 반대편 에이전트로 자리를 넘기기 직전에 부른다.
    //
    // 이 호출이 성공해야 CLI 가 넘어간다. 모르는 값을 조용히 받아 t.provider 를
    // 오염시키면 상태 판정이 엉뚱한 파일을 읽고, 사용자는 원인을 찾을 수 없다.
    if (url.pathname === '/api/term/provider' && req.method === 'POST') {
      const b = await readBody(req);
      const provider = String(b.provider || '');
      if (provider !== 'claude' && provider !== 'codex') {
        return json(res, 400, { ok: false, reason: 'bad_provider',
          message: 'provider 는 claude 또는 codex 여야 한다' });
      }
      const nfo = terminals.setProvider(String(b.id || ''), provider);
      if (!nfo) {
        return json(res, 404, { ok: false, reason: 'no_terminal',
          message: '그 id 의 터미널이 없다' });
      }
      return json(res, 200, { ok: true, info: nfo });
    }

```

- [ ] **Step 2: 구문을 확인한다**

Run: `node --check server.js`

Expected: 출력 없음

- [ ] **Step 3: 별도 포트로 확인한다**

**7788 을 건드리지 않는다.**

```bash
CC_LAUNCHER_PORT=7899 node server.js &
curl -s -X POST http://127.0.0.1:7899/api/term/provider -H "Content-Type: application/json" -d "{\"id\":\"x\",\"provider\":\"gpt\"}" -w " -> %{http_code}\n"
curl -s -X POST http://127.0.0.1:7899/api/term/provider -H "Content-Type: application/json" -d "{\"id\":\"nope\",\"provider\":\"codex\"}" -w " -> %{http_code}\n"
```

Expected: 첫 줄에 `bad_provider` 와 `400`, 둘째 줄에 `no_terminal` 과 `404`. 확인 후 그 서버만 종료한다.

- [ ] **Step 4: 커밋**

```bash
git add server.js
git commit -m "CLI 가 패인의 provider 를 바꿀 입구를 연다"
```

---

### Task 3: 화면이 provider 변경을 실제로 반영하게

**Files:**
- Modify: `public/term.js` (`function connect(` 앞, 그리고 `m.t === 'm'` 처리부와 xterm 생성부)
- Test: `test/term-provider.test.js` (새로 만든다)

**Interfaces:**
- Consumes: Task 1 이 보내는 `{ t: 'm', info: { provider } }`
- Produces: `scrollbackFor(provider) -> number`, `applyProvider(v, info) -> boolean` (바뀌었으면 true)

지금 `m.t === 'm'` 처리는 `v.info` 를 합치고 머리글만 다시 그린다. 스크롤백은 xterm 을 만들 때 한 번 정해지므로 그대로 남는다 — Codex 로 바뀌었는데 8000 줄이면 리사이즈마다 그 8000 줄을 전부 다시 줄바꿈한다 (실측: 그게 "스크롤이 계속 도는" 것처럼 보이고 실제로 버벅인다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/term-provider.test.js` 를 새로 만든다. 기존 `test/term-replay.test.js` 와 같은 방식이다 — `vm` 으로 소스 일부를 잘라 실행한다.

```js
// provider 가 바뀌면 스크롤백도 따라 바뀌어야 한다.
//
// 스크롤백은 xterm 을 만들 때 한 번 정해진다. 런처 CLI 로 패인이 Codex 가 됐는데
// 8000 줄이 남아 있으면, 리사이즈할 때마다 그 8000 줄을 전부 다시 줄바꿈한다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/term.js'), 'utf8');

function ctxWith() {
  const from = source.indexOf('  function scrollbackFor(');
  const to = source.indexOf('  function connect(');
  assert.ok(from > 0 && to > from, '앵커를 못 찾았다 - 함수 이름이 바뀌었나');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(source.slice(from, to), ctx);
  return ctx;
}

test('provider 마다 스크롤백이 다르다', () => {
  const ctx = ctxWith();
  assert.equal(ctx.scrollbackFor('codex'), 1000);
  assert.equal(ctx.scrollbackFor('claude'), 8000);
});

test('provider 가 바뀌면 xterm 의 스크롤백을 갈아끼운다', () => {
  const ctx = ctxWith();
  const v = { info: { provider: 'claude' }, term: { options: { scrollback: 8000 } } };
  assert.equal(ctx.applyProvider(v, { provider: 'codex' }), true);
  assert.equal(v.term.options.scrollback, 1000);
});

test('provider 가 그대로면 건드리지 않는다', () => {
  const ctx = ctxWith();
  const v = { info: { provider: 'codex' }, term: { options: { scrollback: 1000 } } };
  assert.equal(ctx.applyProvider(v, { provider: 'codex' }), false);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/term-provider.test.js`

Expected: FAIL — 앵커를 못 찾아 `앵커를 못 찾았다` 단언에서 멈춘다

- [ ] **Step 3: 최소 구현**

`public/term.js` 에서 `function connect(` **앞에** 두 함수를 넣는다. 테스트가 이 두 앵커 사이를 잘라 쓰므로, 함수 이름을 바꾸면 테스트도 같이 고쳐야 한다.

```js
  // Codex 는 제자리에 덧그리므로 뒤로 밀린 줄이 "지난 대화" 가 아니라 옛 프레임
  // 조각이다. 볼 것도 없는데 리사이즈마다 reflow 비용만 든다.
  function scrollbackFor(provider) { return provider === 'codex' ? 1000 : 8000; }

  // 런처 CLI 로 패인이 반대편 에이전트가 되면 provider 가 바뀐다. 스크롤백은 xterm
  // 을 만들 때 한 번 정해지므로 여기서 갈아끼워야 한다.
  function applyProvider(v, info) {
    var next = info && info.provider;
    if (!next || !v.info || next === v.info.provider) return false;
    try { v.term.options.scrollback = scrollbackFor(next); } catch (e) {}
    return true;
  }
```

그리고 `m.t === 'm'` 처리에서 `v.info` 를 합치기 **전에** 부른다.

```js
      } else if (m.t === 'm') {
        applyProvider(v, m.info);          // 합치기 전에 - 비교할 옛 값이 필요하다
        // /api/terms가 덧붙인 fav/slug는 PTY 메타데이터에 없으므로 보존한다.
        v.info = Object.assign({}, v.info, m.info); v.alive = m.info.alive;
```

xterm 생성부의 `scrollback: info.provider === 'codex' ? 1000 : 8000` 도 `scrollback: scrollbackFor(info.provider)` 로 바꾼다 — 같은 숫자가 두 곳에 있으면 갈린다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/term-provider.test.js`

Expected: PASS (3개)

- [ ] **Step 5: 전체 테스트**

Run: `npm test`

Expected: 실패 0

- [ ] **Step 6: 커밋**

```bash
git add public/term.js test/term-provider.test.js
git commit -m "provider 가 바뀌면 화면의 스크롤백도 따라 바꾼다"
```

---

### Task 4: CLI 화면 — 순수 함수부터

**Files:**
- Create: `launcher-view.js`
- Test: `test/launcher-view.test.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `rows(graph, cwd) -> [{ id, provider, title, running }]`
  - `renderList(list, cursor) -> string` (ANSI 포함, 줄바꿈으로 끝나지 않는다)
  - `nextCursor(cursor, key, total) -> number`

터미널도 서버도 없이 도는 부분을 먼저 만든다. 화면 그리는 물건은 여기서 갈라두지 않으면 시험할 자리가 없어진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/launcher-view.test.js` 를 새로 만든다.

```js
// 런처 CLI 의 순수 부분. 터미널도 서버도 없이 돈다.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const view = require('../launcher-view');

const GRAPH = {
  sessions: [
    { id: 'c-1', provider: 'claude', title: '설계', cwd: 'D:\\work', running: true },
    { id: 'x-1', provider: 'codex',  title: '',     cwd: 'D:\\work', running: false },
    { id: 'c-2', provider: 'claude', title: '딴것', cwd: 'D:\\other', running: true },
  ],
};

test('이 폴더의 세션만 provider 구분 없이 한 목록으로', () => {
  const r = view.rows(GRAPH, 'D:\\work');
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.id), ['c-1', 'x-1']);
});

test('제목이 빈 세션도 id 앞자리로 가릴 수 있다', () => {
  const r = view.rows(GRAPH, 'D:\\work');
  const out = view.renderList(r, 0);
  assert.ok(out.includes('x-1'), 'Codex 는 제목이 빈 세션이 흔하다');
});

test('커서는 목록 끝에서 멈춘다', () => {
  assert.equal(view.nextCursor(0, 'up', 3), 0, '위로 넘어가면 감싸지 않는다');
  assert.equal(view.nextCursor(2, 'down', 3), 2);
  assert.equal(view.nextCursor(0, 'down', 3), 1);
  assert.equal(view.nextCursor(1, 'up', 3), 0);
});

test('빈 목록에서도 커서가 터지지 않는다', () => {
  assert.equal(view.nextCursor(0, 'down', 0), 0);
  assert.ok(view.renderList([], 0).length > 0, '빈 목록도 무슨 말이든 해야 한다');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/launcher-view.test.js`

Expected: FAIL — `Cannot find module '../launcher-view'`

- [ ] **Step 3: 최소 구현**

`launcher-view.js` 를 새로 만든다.

```js
// 런처 CLI 의 화면 - 순수 부분만.
//
// 터미널도 서버도 없이 돌아야 한다. 그래야 "무엇이 보이나" 를 프로세스 하나 안 띄우고
// 시험할 수 있다. 실제로 그리고 입력을 받는 쪽은 launcher-cli.js 다.
'use strict';

const ESC = String.fromCharCode(27);
const DIM = ESC + '[2m';
const OFF = ESC + '[0m';
const SEL = ESC + '[7m';

function rows(graph, cwd) {
  const all = (graph && graph.sessions) || [];
  return all
    .filter((s) => String(s.cwd || '') === String(cwd || ''))
    .map((s) => ({
      id: String(s.id || ''),
      provider: s.provider === 'codex' ? 'codex' : 'claude',
      title: String(s.title || ''),
      running: !!s.running,
    }));
}

function label(r) {
  const dot = r.running ? '*' : ' ';
  const who = r.provider === 'codex' ? 'Codex ' : 'Claude';
  // Codex 는 제목이 빈 세션이 흔하다(실측 7개). 그럴 때 id 앞자리로 가린다.
  const what = r.title || DIM + r.id.slice(0, 8) + OFF;
  return dot + ' ' + who + '  ' + what;
}

function renderList(list, cursor) {
  if (!list.length) return DIM + '이 폴더에는 세션이 없다. n 으로 새로 시작한다.' + OFF;
  return list
    .map((r, i) => (i === cursor ? SEL + label(r) + OFF : label(r)))
    .join(String.fromCharCode(10));
}

function nextCursor(cursor, key, total) {
  if (total <= 0) return 0;
  if (key === 'up') return cursor > 0 ? cursor - 1 : 0;
  if (key === 'down') return cursor < total - 1 ? cursor + 1 : total - 1;
  return cursor;
}

module.exports = { rows, renderList, nextCursor };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/launcher-view.test.js`

Expected: PASS (4개)

- [ ] **Step 5: 커밋**

```bash
git add launcher-view.js test/launcher-view.test.js
git commit -m "런처 CLI 의 화면 - 시험할 수 있는 부분부터"
```

---

### Task 5: CLI 본체 — 알리고, 자리를 넘긴다

**Files:**
- Create: `launcher-cli.js`
- Test: `test/launcher-cli.test.js`

**Interfaces:**
- Consumes: Task 4 의 `launcher-view`, Task 2 의 `POST /api/term/provider`
- Produces:
  - `handoff({ post, exec, termId, provider, sessionId }) -> Promise<{ ok, reason? }>`
  - `argsFor(provider, sessionId) -> [string]`

**중계하지 않는 것이 이 파일의 요점이다.** 고르면 대시보드에 알리고 자리를 넘긴다. 알림이 실패하면 넘기지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/launcher-cli.test.js` 를 새로 만든다. `post` 와 `exec` 를 주입해 실제로 아무것도 띄우지 않는다.

```js
// 자리를 넘기는 부분. 진짜로 프로세스를 바꾸면 시험이 사라지므로 주입한다.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../launcher-cli');

test('알린 뒤에 자리를 넘긴다 - 순서가 중요하다', async () => {
  const seen = [];
  const r = await cli.handoff({
    post: async (path, body) => { seen.push(['post', path, body.provider]); return { ok: true }; },
    exec: (cmd, args) => { seen.push(['exec', cmd, args.join(' ')]); },
    termId: 't1', provider: 'codex', sessionId: 'x-1',
  });
  assert.equal(r.ok, true);
  assert.equal(seen[0][0], 'post');
  assert.equal(seen[0][1], '/api/term/provider');
  assert.equal(seen[1][0], 'exec', '알림이 먼저다');
});

test('알림이 실패하면 넘기지 않는다', async () => {
  const seen = [];
  const r = await cli.handoff({
    post: async () => ({ ok: false, message: '그 id 의 터미널이 없다' }),
    exec: () => { seen.push('exec'); },
    termId: 't1', provider: 'codex', sessionId: null,
  });
  assert.equal(r.ok, false);
  assert.equal(seen.length, 0, '어긋난 채 넘어가면 사용자가 원인을 못 찾는다');
  assert.ok(r.reason.includes('터미널'), r.reason);
});

test('서버가 안 떠 있으면 사람 말로 거절한다', async () => {
  const r = await cli.handoff({
    post: async () => { throw new Error('대시보드가 안 떠 있습니다 (127.0.0.1:7788)'); },
    exec: () => { throw new Error('여기까지 오면 안 된다'); },
    termId: 't1', provider: 'claude', sessionId: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('안 떠 있'), r.reason);
});

test('넘기다 터져도 사유를 남긴다', async () => {
  const r = await cli.handoff({
    post: async () => ({ ok: true }),
    exec: () => { throw new Error('spawn codex ENOENT'); },
    termId: 't1', provider: 'codex', sessionId: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('ENOENT'), r.reason);
});

test('이어할 세션이 있으면 resume 인자를, 없으면 새로 시작', () => {
  assert.deepEqual(cli.argsFor('codex', null), []);
  assert.deepEqual(cli.argsFor('codex', 'x-1'), ['resume', 'x-1']);
  assert.deepEqual(cli.argsFor('claude', null), []);
  assert.deepEqual(cli.argsFor('claude', 'c-1'), ['--resume', 'c-1']);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/launcher-cli.test.js`

Expected: FAIL — `Cannot find module '../launcher-cli'`

- [ ] **Step 3: 최소 구현**

`launcher-cli.js` 를 새로 만든다. 이 단계에서는 `handoff` 와 `argsFor` 만 내보낸다.

```js
#!/usr/bin/env node
// 대시보드 패인의 입구. Codex 와 Claude 를 한 목록에서 고른다.
//
// 중계하지 않는다. 고르면 대시보드에 provider 를 알린 뒤 자리를 넘겨 PTY 를
// 에이전트에게 온전히 준다. 중계 계층을 하나 더 얹으면 TUI 가 두 겹이 되는데,
// 우리는 이미 그 대가를 치렀다 - 대체화면에 밀어넣었다가 마우스 휠이 죽었다.
//
// 돌아오는 것은 이 프로세스가 아니라 대시보드가 한다(머리글의 런처 버튼 ->
// /api/term/restart). 넘긴 프로세스는 스스로 못 돌아오지만 패인의 주인은 서버다.
'use strict';

function argsFor(provider, sessionId) {
  if (provider === 'codex') return sessionId ? ['resume', String(sessionId)] : [];
  return sessionId ? ['--resume', String(sessionId)] : [];
}

// post 와 exec 를 주입받는다 - 시험이 진짜로 프로세스를 바꾸면 안 된다.
async function handoff({ post, exec, termId, provider, sessionId }) {
  let said;
  try {
    said = await post('/api/term/provider', { id: termId, provider: provider });
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
  if (!said || !said.ok) {
    return { ok: false, reason: '대시보드가 거절했다: '
      + String((said && said.message) || '이유 없음') };
  }

  try {
    exec(provider, argsFor(provider, sessionId));
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
  return { ok: true };
}

module.exports = { handoff, argsFor };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/launcher-cli.test.js`

Expected: PASS (5개)

- [ ] **Step 5: 전체 테스트**

Run: `npm test`

Expected: 실패 0

- [ ] **Step 6: 실제 화면 루프를 붙인다**

같은 파일 아래에 넣는다. 여기는 시험하지 않는다 — 주입할 수 있게 갈라둔 부분은 Step 3 에서 이미 시험했고, 남은 것은 터미널 입력과 프로세스 교체다.

```js
const http = require('http');
const { spawn } = require('child_process');
const view = require('./launcher-view');

const PORT = Number(process.env.CC_LAUNCHER_PORT || 7788);
const TERM_ID = process.env.CC_TERM_ID || '';
const LF = String.fromCharCode(10);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      : {};
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: path, method: method, headers: headers },
      (res) => {
        let out = '';
        res.on('data', (d) => { out += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(out)); }
          catch (e) { reject(new Error('응답을 읽지 못했다')); }
        });
      });
    r.on('error', () => reject(
      new Error('대시보드가 안 떠 있습니다 (127.0.0.1:' + PORT + ')')));
    if (data) r.write(data);
    r.end();
  });
}

// Node 에는 exec 가 없다. 자식을 띄우고 그 종료 코드로 우리도 끝나면 같은 효과다.
function becomeAgent(cmd, args) {
  const child = spawn(cmd, args,
    { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('error', (e) => {
    process.stderr.write(String(e.message) + LF);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
}

async function main() {
  let graph;
  try {
    graph = await req('GET', '/api/graph', null);
  } catch (e) {
    process.stderr.write(String(e.message) + LF);
    process.exit(1);
  }
  const list = view.rows(graph, process.cwd());
  process.stdout.write(view.renderList(list, 0) + LF);
  // 키 입력 루프는 다음 커밋에서 - 지금은 목록이 보이는 것까지.
}

if (require.main === module) main();
```

- [ ] **Step 7: 별도 포트로 확인한다**

**7788 을 건드리지 않는다.**

```bash
CC_LAUNCHER_PORT=7899 node server.js &
CC_LAUNCHER_PORT=7899 node launcher-cli.js
```

Expected: 이 폴더의 세션 목록이 보이거나, 세션이 없으면 `이 폴더에는 세션이 없다`.

그 서버를 끄고 다시 실행하면 `대시보드가 안 떠 있습니다 (127.0.0.1:7899)` 와 종료 코드 1.

- [ ] **Step 8: 커밋**

```bash
git add launcher-cli.js test/launcher-cli.test.js
git commit -m "런처 CLI - 알린 뒤에 자리를 넘긴다"
```

---

### Task 6: 패인에서 런처로 열기 (옵트인)

**Files:**
- Modify: `terminals.js` (`create` 의 명령 선택부와 자식 환경)
- Modify: `public/term.js` (`paneHead` 의 버튼과 클릭 처리)

**Interfaces:**
- Consumes: Task 5 의 `launcher-cli.js`, 기존 `/api/term/restart`
- Produces: `create({ ..., launcher: true })` 가 에이전트 대신 런처 CLI 를 띄운다

**기본값을 바꾸지 않는다.** 지금 `실행` 버튼 동작이 말없이 달라지면 매일 쓰는 흐름이 깨진다. 헤더의 `실행 위치` 토글과 같은 결로 옵트인으로 둔다.

- [ ] **Step 1: `create` 가 런처를 띄울 수 있게 한다**

`terminals.js` 의 `create` 인자 목록에 `launcher` 를 추가하고, 명령과 인자를 정하는 부분 **뒤에** 넣는다.

```js
  // 런처로 열면 에이전트 대신 우리 CLI 가 뜬다. 거기서 골라 자리를 넘긴다.
  // 기본값이 아니다 - 기존 실행 버튼의 동작을 말없이 바꾸지 않는다.
  if (launcher) {
    cmd = process.execPath;
    args = [path.join(__dirname, 'launcher-cli.js')];
  }
```

자식 환경에 `CC_TERM_ID` 를 넘긴다. CLI 가 어느 패인인지 알아야 `setProvider` 를 부를 수 있다.

```js
    env: Object.assign({}, process.env, {
      CC_TERM_ID: id,
      CC_LAUNCHER_PORT: String(process.env.CC_LAUNCHER_PORT || 7788),
    }),
```

- [ ] **Step 2: 머리글에 `런처` 버튼을 넣는다**

`public/term.js` 의 `paneHead` 에서 `data-restartterm` 버튼 옆에 넣는다.

```js
      + '<button class="pbtn" data-launcher="' + id + '" title="이 패인을 런처로 되돌린다">런처</button>'
```

클릭 처리에서 `/api/term/restart` 를 `launcher: true` 와 함께 부른다.

- [ ] **Step 3: 별도 포트로 왕복을 확인한다**

**7788 을 건드리지 않는다.**

```bash
CC_LAUNCHER_PORT=7899 node server.js &
```

브라우저로 `http://127.0.0.1:7899` 를 열고 다음을 사람 눈으로 확인한다.

1. 런처로 패인을 연다 → 세션 목록이 보인다
2. Codex 세션을 고른다 → 그 패인이 Codex 가 된다
3. 머리글 `런처` → 다시 목록이 보인다
4. 2에서 화면이 위에서 아래로 쓸리지 않는다
5. 2 뒤에 마우스 휠이 동작한다

- [ ] **Step 4: 전체 테스트**

Run: `npm test`

Expected: 실패 0

- [ ] **Step 5: 커밋**

```bash
git add terminals.js public/term.js
git commit -m "패인을 런처로 열고, 런처로 되돌린다"
```

---

### Task 7: 키 입력 루프 — 고르고, 새로 시작한다

**Files:**
- Modify: `launcher-view.js` (`route` 추가)
- Modify: `launcher-cli.js` (`main` 의 루프)
- Test: `test/launcher-view.test.js`

**Interfaces:**
- Consumes: Task 4 의 `nextCursor`, Task 5 의 `handoff`
- Produces: `route(state, key) -> { cursor, action }` — `action` 은 `null` · `'pick'` · `'new'` · `'quit'` 중 하나

키 입력을 "다음 상태" 로 바꾸는 부분을 순수 함수로 갈라둔다. 그래야 실제 터미널 없이 시험할 수 있다. 터미널에서 읽고 화면을 지우는 것만 `launcher-cli.js` 에 남는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/launcher-view.test.js` 아래에 덧붙인다.

```js
test('Enter 는 고르기, n 은 새로, q 는 나가기', () => {
  assert.deepEqual(view.route({ cursor: 1, total: 3 }, 'enter'), { cursor: 1, action: 'pick' });
  assert.deepEqual(view.route({ cursor: 1, total: 3 }, 'n'), { cursor: 1, action: 'new' });
  assert.deepEqual(view.route({ cursor: 1, total: 3 }, 'q'), { cursor: 1, action: 'quit' });
});

test('위아래는 커서만 움직이고 아무 일도 하지 않는다', () => {
  assert.deepEqual(view.route({ cursor: 1, total: 3 }, 'down'), { cursor: 2, action: null });
  assert.deepEqual(view.route({ cursor: 1, total: 3 }, 'up'), { cursor: 0, action: null });
});

test('빈 목록에서 Enter 는 아무 일도 하지 않는다', () => {
  assert.deepEqual(view.route({ cursor: 0, total: 0 }, 'enter'), { cursor: 0, action: null });
});

test('모르는 키는 무시한다', () => {
  assert.deepEqual(view.route({ cursor: 1, total: 3 }, 'z'), { cursor: 1, action: null });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/launcher-view.test.js`

Expected: FAIL — `view.route is not a function`

- [ ] **Step 3: 최소 구현**

`launcher-view.js` 에 넣고 `module.exports` 에 `route` 를 추가한다.

```js
// 키 하나를 "다음 상태" 로 바꾼다. 터미널 없이 시험하려고 갈라 둔다.
function route(state, key) {
  const total = Number(state.total) || 0;
  const cursor = nextCursor(Number(state.cursor) || 0, key, total);
  if (key === 'q') return { cursor: cursor, action: 'quit' };
  if (key === 'n') return { cursor: cursor, action: 'new' };
  // 고를 것이 없으면 Enter 도 아무 일도 하지 않는다 - 빈 목록에서 터지지 않게.
  if (key === 'enter' && total > 0) return { cursor: cursor, action: 'pick' };
  return { cursor: cursor, action: null };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/launcher-view.test.js`

Expected: PASS (8개)

- [ ] **Step 5: `launcher-cli.js` 의 `main` 을 루프로 바꾼다**

Step 6 에서 넣었던 `main` 을 이걸로 갈아끼운다.

```js
const ESC = String.fromCharCode(27);

// 눌린 키를 이름으로 바꾼다. 방향키는 ESC [ A 형태로 들어온다.
function keyName(buf) {
  const s = String(buf);
  if (s === ESC + '[A') return 'up';
  if (s === ESC + '[B') return 'down';
  if (s === String.fromCharCode(13) || s === LF) return 'enter';
  if (s === String.fromCharCode(3)) return 'q';        // Ctrl+C
  return s.toLowerCase();
}

function draw(list, cursor) {
  process.stdout.write(ESC + '[2J' + ESC + '[H');      // 지우고 맨 위로
  process.stdout.write(view.renderList(list, cursor) + LF + LF);
  process.stdout.write('위아래 이동 · Enter 이어하기 · n 새로 · q 나가기' + LF);
}

async function main() {
  let graph;
  try {
    graph = await req('GET', '/api/graph', null);
  } catch (e) {
    process.stderr.write(String(e.message) + LF);
    process.exit(1);
  }

  const list = view.rows(graph, process.cwd());
  let cursor = 0;
  draw(list, cursor);

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on('data', async (buf) => {
    const next = view.route({ cursor: cursor, total: list.length }, keyName(buf));
    cursor = next.cursor;

    if (next.action === 'quit') { process.exit(0); }

    if (next.action === 'pick' || next.action === 'new') {
      const row = next.action === 'pick' ? list[cursor] : null;
      const provider = row ? row.provider : 'claude';
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      const r = await handoff({
        post: (p, b) => req('POST', p, b),
        exec: becomeAgent,
        termId: TERM_ID,
        provider: provider,
        sessionId: row ? row.id : null,
      });
      if (!r.ok) {
        // 넘어가지 못했으면 목록으로 돌아간다. 패인을 빈 채로 두지 않는다.
        process.stdout.write(LF + r.reason + LF);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        setTimeout(() => draw(list, cursor), 1500);
      }
      return;
    }

    draw(list, cursor);
  });
}
```

`new` 로 고른 provider 가 항상 `claude` 인 것은 다음 태스크에서 고른다 — 지금은 이어하기가 주된 길이다.

- [ ] **Step 6: 별도 포트로 확인한다**

**7788 을 건드리지 않는다.**

```bash
CC_LAUNCHER_PORT=7899 node server.js &
CC_LAUNCHER_PORT=7899 node launcher-cli.js
```

Expected: 위아래로 커서가 움직이고, `q` 로 빠져나온다. `CC_TERM_ID` 가 없으므로 Enter 를 누르면 `그 id 의 터미널이 없다` 가 뜨고 목록으로 돌아온다 — 이것이 "알림 실패 시 넘기지 않는다" 의 실제 확인이다.

- [ ] **Step 7: 전체 테스트**

Run: `npm test`

Expected: 실패 0

- [ ] **Step 8: 커밋**

```bash
git add launcher-view.js launcher-cli.js test/launcher-view.test.js
git commit -m "런처 CLI - 고르고 새로 시작하는 루프"
```

---

### Task 8: 한도 두 줄

**Files:**
- Modify: `launcher-view.js` (`renderLimits` 추가)
- Modify: `launcher-cli.js` (`draw` 의 머리)
- Test: `test/launcher-view.test.js`

**Interfaces:**
- Consumes: 기존 `GET /api/limits`
- Produces: `renderLimits(limits) -> string` (한 줄, 못 가져왔으면 빈 문자열)

패인에서 몇 초 안에 끝나는 일만 둔다는 원칙에 따라, 한도는 **읽기 전용 한 줄**이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/launcher-view.test.js` 아래에 덧붙인다.

```js
const LIMITS = {
  providers: {
    claude: { ok: true, data: { gauges: [
      { label: '5시간 세션', percent: 14, active: false },
      { label: '주간', percent: 37, active: true },
    ] } },
    codex: { ok: true, data: { gauges: [{ label: '주간', percent: 54, active: true }] } },
  },
};

test('한도는 provider 마다 active 인 것 하나씩', () => {
  const line = view.renderLimits(LIMITS);
  assert.ok(line.includes('37'), line);
  assert.ok(line.includes('54'), line);
  assert.ok(!line.includes('14'), 'active 가 아닌 것은 안 보여준다');
});

test('한도를 못 가져오면 자리를 차지하지 않는다', () => {
  assert.equal(view.renderLimits(null), '');
  assert.equal(view.renderLimits({ providers: { claude: { ok: false } } }), '');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/launcher-view.test.js`

Expected: FAIL — `view.renderLimits is not a function`

- [ ] **Step 3: 최소 구현**

`launcher-view.js` 에 넣고 `module.exports` 에 `renderLimits` 를 추가한다.

```js
// 한도는 읽기 전용 한 줄이다. 못 가져오면 자리를 차지하지 않는다 -
// 패인은 좁고, 빈 칸은 무엇이 잘못됐는지 알려주지도 않는다.
function renderLimits(limits) {
  const ps = (limits && limits.providers) || {};
  const parts = [];
  for (const name of ['claude', 'codex']) {
    const p = ps[name];
    if (!p || !p.ok || !p.data || !p.data.gauges) continue;
    const g = p.data.gauges.filter((x) => x && x.active)[0];
    if (!g) continue;
    parts.push((name === 'codex' ? 'Codex' : 'Claude') + ' ' + g.label + ' ' + g.percent + '%');
  }
  return parts.length ? DIM + parts.join('  ·  ') + OFF : '';
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/launcher-view.test.js`

Expected: PASS (10개)

- [ ] **Step 5: `draw` 머리에 붙인다**

`launcher-cli.js` 의 `main` 에서 목록과 함께 가져온다. 한도가 느리거나 실패해도 목록은 뜨게 둔다.

```js
  let limits = null;
  try { limits = await req('GET', '/api/limits', null); } catch (e) { /* 없으면 없는 대로 */ }
```

`draw` 를 고친다.

```js
function draw(list, cursor, limits) {
  process.stdout.write(ESC + '[2J' + ESC + '[H');
  const head = view.renderLimits(limits);
  if (head) process.stdout.write(head + LF + LF);
  process.stdout.write(view.renderList(list, cursor) + LF + LF);
  process.stdout.write('위아래 이동 · Enter 이어하기 · n 새로 · q 나가기' + LF);
}
```

`draw` 를 부르는 세 자리에 `limits` 를 넘긴다.

- [ ] **Step 6: 전체 테스트**

Run: `npm test`

Expected: 실패 0

- [ ] **Step 7: 커밋**

```bash
git add launcher-view.js launcher-cli.js test/launcher-view.test.js
git commit -m "런처 CLI - 한도 한 줄"
```

---

## 이 계획에서 뺀 것

스펙의 CLI 화면 목록 중 **전달(`s` — 반대편 세션에 말 보내기)** 은 태스크로 넣지 않았다.

이유: 보내려면 대상을 고르고 본문을 입력받아야 하는데, 그 순간 CLI 가 **입력을 받는 화면을 하나 더** 갖게 된다. 나머지 화면은 전부 키 한 번으로 끝나서 "패인에서 몇 초 안에 끝나는 일" 이라는 경계 안에 있지만, 이것만 다르다.

`bridge-send.js` 가 이미 같은 일을 하고 대시보드 UI 에도 버튼이 있으므로, 런처가 도는 동안은 그 둘 중 하나를 쓴다. 나중에 필요해지면 별도 계획으로 붙인다.
