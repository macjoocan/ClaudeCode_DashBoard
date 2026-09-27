# 런처 CLI 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드 내장 터미널 패인에서 런처 CLI 가 먼저 뜨고, 거기서 Codex/Claude 어느 쪽이든 골라 그 패인 그대로 들어간다.

**Architecture:** CLI 는 에이전트를 **띄우지 않는다.** 고르면 대시보드에 "이 패인을 이걸로 갈아끼워라" 고 부탁하고 자기는 사라진다. 에이전트는 서버가 node-pty 로 직접 띄우므로 PTY 의 pid 가 곧 에이전트의 pid 다. 돌아오는 것도 같은 길(`/api/term/restart`)이다.

**Tech Stack:** Node.js (내장 모듈만), node-pty, ws. **새 의존성을 넣지 않는다.**

**Spec:** `docs/superpowers/specs/2026-09-26-launcher-cli-design.md`

## 왜 CLI 가 에이전트를 띄우지 않나 — 이 계획의 핵심

첫 판에서는 CLI 가 `exec` 로 자리를 넘기는 그림이었다. **훅이 깨진다.**

대시보드는 세션 상태를 **pid 파일 이름으로** 찾는다:

```js
function liveInfo(pid) {
  const f = path.join(LIVE_DIR, pid + '.json');   // ~/.claude/sessions/<pid>.json
```

`t.pid` 는 node-pty 가 띄운 프로세스의 pid 다. Node 에는 진짜 `exec` 가 없어서 CLI 가 에이전트를 띄우면 자식이 되고, 훅은 **그 자식의 pid** 로 파일을 쓴다.

```
지금        node-pty -> claude.exe(16572)      훅: sessions/16572.json   t.pid=16572  맞음
CLI 가 띄우면  node-pty -> node(3000)             t.pid=3000
                            -> claude.exe(4200)   훅: sessions/4200.json  영영 못 찾음
```

상태 표시(작업 중/대기), 세션 ID 연결, 카드와 터미널 연결이 전부 죽는다.

**이 레포는 이미 같은 실패를 겪었다.** `terminals.js` 의 Codex pid 역인덱스가 무용지물인 이유가 정확히 이것이다 — npm 셤이 실제 바이너리를 자식으로 spawn 해서, 훅이 기록하는 pid 가 PTY pid 보다 두세 단계 아래다. 같은 구덩이를 다시 파지 않는다.

그래서 CLI 는 부탁만 한다. 서버가 `restart` 로 PTY 를 갈아끼우면 pid 는 언제나 에이전트 자신의 것이다.

**스킬과 MCP 는 영향이 없다.** 에이전트가 제 설정에서 제가 띄운다 — 누구의 자식인지는 상관이 없다. 걸리는 것은 훅 하나뿐이고, 그것이 pid 로 맞추기 때문이다.

## Global Constraints

- **새 의존성 금지.** `package.json` 의 `dependencies` 는 `node-pty` 와 `ws` 뿐이다
- **CLI 는 서버 모듈을 `require` 하지 않는다.** HTTP 로만 붙는다 (`bridge-send.js` 와 같은 결)
- **CLI 는 에이전트를 `spawn` 하지 않는다.** 위 이유. 어기면 훅이 조용히 죽는다
- **7788 을 건드리지 않는다.** 사용자의 실제 작업 세션이 붙어 있고, 서버를 내리면 진행 중인 턴이 날아간다. 확인은 `CC_LAUNCHER_PORT=7899` 로 별도 기동
- **`.js` 는 LF, `docs/*.md` 는 CRLF.** 기존 파일을 텍스트 모드로 통째 다시 쓰지 말 것 — 줄끝이 전부 바뀌어 diff 가 수천 줄이 된다 (실제로 밟았다)
- **큰 문서를 heredoc 으로 쓰지 말 것.** 본문의 따옴표에 셸이 걸린다 (이 계획서를 쓰다 걸렸다). 파일 도구로 쓰고 줄끝만 따로 맞춘다
- 테스트: `npm test` = `node --test test/*.test.js`. 현재 241개 통과, 약 11초

## Review Focus

- **서버가 꺼져 있을 때** — CLI 가 스택 트레이스 대신 사람 말로 거절하고 종료 코드 1 을 남긴다 (Task 5)
- **부탁이 성공하면 CLI 는 응답을 못 받는다** — 서버가 이 프로세스를 죽이기 때문이다. 끊긴 연결을 실패로 읽으면 사용자는 성공한 전환을 실패로 본다 (Task 5)
- **모르는 provider 값** — 갈아끼우지 않고 기존 값을 지킨다. 조용히 받아 `t.provider` 를 오염시키면 상태 판정이 엉뚱한 파일을 읽는다 (Task 1)
- **없는 터미널 id** — `null` 을 돌려주고 서버가 404 로 답한다 (Task 1, 2)
- **에이전트 바이너리가 없을 때** — PTY 를 **죽이기 전에** 실패해야 한다. 죽인 뒤 실패하면 패인이 빈 채로 남는다 (Task 1)

---

### Task 1: `restart` 가 무엇을 띄울지 받게 한다

**Files:**
- Create: `relaunch-plan.js`
- Test: `test/relaunch-plan.test.js`
- Modify: `terminals.js` (`restart`, `fresh`, `module.exports`)

**Interfaces:**
- Consumes: 없음
- Produces: `relaunchPlan(t, opts) -> { provider, action, sessionId, launcher }`

`restart` 는 PTY 를 실제로 띄우므로 그대로는 시험할 수 없다. 이 레포가 쓰는 방식대로(`kill-result.js`, `launch-args.js`) **판단만 순수 함수로 떼어낸다.**

지금 `restart` 는 `t.provider` 와 `t.sessionId` 를 그대로 쓴다. 런처가 패인을 반대편으로 바꾸려면 그 둘을 받을 수 있어야 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/relaunch-plan.test.js` 를 새로 만든다.

```js
// 패인을 무엇으로 갈아끼울지 정하는 판단만 떼어낸 것.
// restart 는 PTY 를 실제로 띄우므로 그대로는 시험할 수 없다.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { relaunchPlan } = require('../relaunch-plan');

const T = { provider: 'claude', sessionId: 'c-1' };

test('아무것도 안 주면 지금 것을 그대로 이어한다', () => {
  assert.deepEqual(relaunchPlan(T, undefined),
    { provider: 'claude', action: 'resume', sessionId: 'c-1', launcher: false });
});

test('fresh 는 세션을 버리고 새로 시작한다', () => {
  assert.deepEqual(relaunchPlan(T, { fresh: true }),
    { provider: 'claude', action: 'new', sessionId: null, launcher: false });
});

test('provider 를 갈아끼울 수 있다', () => {
  const p = relaunchPlan(T, { provider: 'codex', sessionId: 'x-1' });
  assert.equal(p.provider, 'codex');
  assert.equal(p.sessionId, 'x-1');
  assert.equal(p.action, 'resume');
});

test('sessionId 를 null 로 주면 그 provider 로 새 세션', () => {
  const p = relaunchPlan(T, { provider: 'codex', sessionId: null });
  assert.equal(p.provider, 'codex');
  assert.equal(p.action, 'new');
  assert.equal(p.sessionId, null);
});

test('모르는 provider 는 무시하고 지금 것을 지킨다', () => {
  // 조용히 받으면 t.provider 가 오염되고 상태 판정이 엉뚱한 파일을 읽는다.
  assert.equal(relaunchPlan(T, { provider: 'gpt' }).provider, 'claude');
  assert.equal(relaunchPlan(T, { provider: '' }).provider, 'claude');
});

test('launcher 로 되돌리면 세션을 이어하지 않는다', () => {
  const p = relaunchPlan(T, { launcher: true });
  assert.equal(p.launcher, true);
  assert.equal(p.sessionId, null, '런처는 에이전트가 아니다 - 이어할 대화가 없다');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/relaunch-plan.test.js`

Expected: FAIL — `Cannot find module '../relaunch-plan'`

- [ ] **Step 3: 최소 구현**

`relaunch-plan.js` 를 새로 만든다.

```js
// 패인을 무엇으로 갈아끼울지 정한다 - 판단만. 띄우는 것은 terminals.restart 가 한다.
//
// 떼어낸 이유: restart 는 PTY 를 실제로 띄워서 그대로는 시험할 수 없다.
// kill-result.js · launch-args.js 와 같은 자리에 있는 물건이다.
'use strict';

function relaunchPlan(t, opts) {
  const o = opts || {};

  // 모르는 값은 무시하고 지금 것을 지킨다. 조용히 받으면 t.provider 가 오염되고,
  // 그 값이 상태를 어디서 읽을지·스크롤백·덧그림 판정을 전부 결정한다.
  const provider = (o.provider === 'claude' || o.provider === 'codex')
    ? o.provider
    : (t.provider === 'codex' ? 'codex' : 'claude');

  const launcher = !!o.launcher;

  // 런처는 에이전트가 아니다 - 이어할 대화가 없다.
  let sessionId;
  if (launcher || o.fresh) sessionId = null;
  else if (Object.prototype.hasOwnProperty.call(o, 'sessionId')) sessionId = o.sessionId || null;
  else sessionId = t.sessionId || null;

  return {
    provider: provider,
    action: sessionId ? 'resume' : 'new',
    sessionId: sessionId,
    launcher: launcher,
  };
}

module.exports = { relaunchPlan };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/relaunch-plan.test.js`

Expected: PASS (6개)

- [ ] **Step 5: `restart` 가 이걸 쓰게 한다**

`terminals.js` 위쪽에 `const { relaunchPlan } = require('./relaunch-plan');` 를 넣고, `restart` 의 머리를 바꾼다.

```js
function restart(id, { claudeBin, codexBin }, opts) {
  const t = terms.get(id);
  if (!t) return Promise.resolve(null);

  const plan = relaunchPlan(t, opts);
  const isCodex = plan.provider === 'codex';
  const bin = plan.launcher ? process.execPath : (isCodex ? codexBin : claudeBin);

  // 바이너리 확인은 PTY 를 죽이기 전에 한다. 죽인 뒤 실패하면 패인이 빈 채로 남는다.
  if (!bin) return Promise.reject(new Error(isCodex ? 'codex 를 찾을 수 없습니다' : 'claude 를 찾을 수 없습니다'));
```

`wait.then(...)` 안에서 인자와 상태 갱신을 `plan` 에서 가져온다.

```js
  return wait.then(() => {
    const args = plan.launcher
      ? [path.join(__dirname, 'launcher-cli.js')]
      : (isCodex
        ? require('./codex.js').codexArgs(plan.action, plan.sessionId)
        : claudeArgs(plan.action, plan.sessionId));

    const p = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: t.cols, rows: t.rows,
      cwd: t.cwd,
      env: Object.assign(cleanEnv(), {
        CC_TERM_ID: t.id,
        CC_LAUNCHER_PORT: String(process.env.CC_LAUNCHER_PORT || 7788),
      }),
      useConpty: true,
    });

    t.proc = p;
    t.pid = p.pid;
    t.provider = plan.provider;          // 갈아끼웠을 수 있다
    t.action = plan.action;
    t.sessionId = plan.sessionId;
```

나머지(`exitCode` 초기화, `buf` 비우기, `wire`, `send`)는 그대로 둔다.

`fresh` 도 새 모양에 맞춘다.

```js
function fresh(id, bins) { return restart(id, bins, { fresh: true }); }
```

- [ ] **Step 6: 전체 테스트**

Run: `npm test`

Expected: 통과 수가 6 늘고 실패 0

- [ ] **Step 7: 커밋**

```bash
git add relaunch-plan.js test/relaunch-plan.test.js terminals.js
git commit -m "패인을 무엇으로 갈아끼울지 받을 수 있게 한다"
```

---

### Task 2: `/api/term/restart` 가 그것을 넘기게

**Files:**
- Modify: `server.js` (`/api/term/restart` 배선)

**Interfaces:**
- Consumes: Task 1 의 `terminals.restart(id, bins, opts)`
- Produces: `POST /api/term/restart` — 본문 `{ id, provider?, sessionId?, launcher? }`

새 엔드포인트를 만들지 않는다. 이미 있는 것이 "이 패인을 갈아끼운다" 를 뜻하므로, 무엇으로 갈아끼울지를 받게만 넓힌다.

- [ ] **Step 1: 배선을 넓힌다**

`server.js` 의 `/api/term/restart` 를 이걸로 바꾼다.

```js
    // 이 패인을 무엇으로 갈아끼울지 받는다.
    //
    // 런처 CLI 가 이걸 부르고 사라진다. 에이전트는 서버가 node-pty 로 직접 띄우므로
    // PTY 의 pid 가 곧 에이전트의 pid 다 - 훅이 쓰는 pid 파일과 맞는다.
    // CLI 가 직접 띄우면 자식이 되어 그 연결이 끊긴다.
    if (url.pathname === '/api/term/restart' && req.method === 'POST') {
      const b = await readBody(req);
      const opts = {};
      if (b.provider !== undefined) opts.provider = String(b.provider || '');
      if (b.sessionId !== undefined) opts.sessionId = b.sessionId ? String(b.sessionId) : null;
      if (b.launcher) opts.launcher = true;

      const t = await terminals.restart(String(b.id || ''),
        { claudeBin: CLAUDE_BIN, codexBin: CODEX_BIN }, opts);
      if (!t) return json(res, 404, { ok: false, message: '터미널이 없습니다' });
      return json(res, 200, { ok: true, term: terminals.info(t) });
    }
```

기존 코드는 터미널이 없으면 `throw` 했는데, CLI 가 사유를 읽어야 하므로 404 로 바꾼다.

- [ ] **Step 2: 구문을 확인한다**

Run: `node --check server.js`

Expected: 출력 없음

- [ ] **Step 3: 별도 포트로 확인한다**

**7788 을 건드리지 않는다.**

```bash
CC_LAUNCHER_PORT=7899 node server.js &
curl -s -X POST http://127.0.0.1:7899/api/term/restart -H "Content-Type: application/json" -d "{\"id\":\"nope\"}" -w " -> %{http_code}\n"
```

Expected: `터미널이 없습니다` 와 `404`. 확인 후 그 서버만 종료한다.

- [ ] **Step 4: 전체 테스트**

Run: `npm test`

Expected: 실패 0

- [ ] **Step 5: 커밋**

```bash
git add server.js
git commit -m "패인 갈아끼우기에 무엇으로 바꿀지 실어 보낸다"
```

---

### Task 3: 화면이 provider 변경을 실제로 반영하게

**Files:**
- Modify: `public/term.js` (`function connect(` 앞, `m.t === 'm'` 처리부, xterm 생성부)
- Test: `test/term-provider.test.js` (새로 만든다)

**Interfaces:**
- Consumes: `restart` 가 보내는 `{ t: 'm', info: { provider } }`
- Produces: `scrollbackFor(provider) -> number`, `applyProvider(v, info) -> boolean`

`restart` 는 이미 `{t:'reset'}` 과 `{t:'m'}` 을 보낸다. 그런데 `m` 처리는 `v.info` 를 합치고 머리글만 다시 그린다 — 스크롤백은 xterm 을 만들 때 한 번 정해지므로 그대로 남는다. Codex 로 바뀌었는데 8000 줄이면 리사이즈마다 그 8000 줄을 전부 다시 줄바꿈한다(실측: 그게 "스크롤이 계속 도는" 것처럼 보이고 실제로 버벅인다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/term-provider.test.js` 를 새로 만든다. `test/term-replay.test.js` 와 같은 방식이다 — `vm` 으로 소스 일부를 잘라 실행한다.

```js
// provider 가 바뀌면 스크롤백도 따라 바뀌어야 한다.
//
// 스크롤백은 xterm 을 만들 때 한 번 정해진다. 런처로 패인이 Codex 가 됐는데
// 8000 줄이 남아 있으면 리사이즈마다 그 8000 줄을 전부 다시 줄바꿈한다.
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

`public/term.js` 에서 `function connect(` **앞에** 두 함수를 넣는다. 테스트가 이 두 앵커 사이를 잘라 쓰므로, 이름을 바꾸면 테스트도 같이 고쳐야 한다.

```js
  // Codex 는 제자리에 덧그리므로 뒤로 밀린 줄이 "지난 대화" 가 아니라 옛 프레임
  // 조각이다. 볼 것도 없는데 리사이즈마다 reflow 비용만 든다.
  function scrollbackFor(provider) { return provider === 'codex' ? 1000 : 8000; }

  // 런처로 패인이 반대편 에이전트가 되면 provider 가 바뀐다. 스크롤백은 xterm 을
  // 만들 때 한 번 정해지므로 여기서 갈아끼워야 한다.
  function applyProvider(v, info) {
    var next = info && info.provider;
    if (!next || !v.info || next === v.info.provider) return false;
    try { v.term.options.scrollback = scrollbackFor(next); } catch (e) {}
    return true;
  }
```

`m.t === 'm'` 처리에서 `v.info` 를 합치기 **전에** 부른다.

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

### Task 5: CLI 본체 — 부탁하고 사라진다

**Files:**
- Create: `launcher-cli.js`
- Test: `test/launcher-cli.test.js`

**Interfaces:**
- Consumes: Task 4 의 `launcher-view`, Task 2 의 `POST /api/term/restart`
- Produces: `swap({ post, termId, provider, sessionId }) -> Promise<{ ok, reason? }>`

**에이전트를 띄우지 않는 것이 이 파일의 요점이다.** 부탁이 성공하면 서버가 이 PTY 를 죽이므로 **응답이 오지 않는다.** 끊긴 연결을 실패로 읽으면 성공한 전환이 실패로 보인다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/launcher-cli.test.js` 를 새로 만든다.

```js
// 부탁하고 사라지는 부분. post 를 주입해 서버도 PTY 도 없이 돈다.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../launcher-cli');

test('갈아끼워달라고 부탁한다', async () => {
  const seen = [];
  const r = await cli.swap({
    post: async (path, body) => { seen.push([path, body]); return { ok: true }; },
    termId: 't1', provider: 'codex', sessionId: 'x-1',
  });
  assert.equal(r.ok, true);
  assert.equal(seen[0][0], '/api/term/restart');
  assert.deepEqual(seen[0][1], { id: 't1', provider: 'codex', sessionId: 'x-1' });
});

test('연결이 끊기는 것은 성공이다 - 서버가 우리를 죽인 것', async () => {
  // 갈아끼우기가 성공하면 서버가 이 PTY 를 죽인다. 응답이 올 수 없다.
  const r = await cli.swap({
    post: async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; },
    termId: 't1', provider: 'codex', sessionId: null,
  });
  assert.equal(r.ok, true, '끊긴 연결을 실패로 읽으면 성공한 전환이 실패로 보인다');
});

test('서버가 안 떠 있으면 사람 말로 거절한다', async () => {
  const r = await cli.swap({
    post: async () => { throw new Error('대시보드가 안 떠 있습니다 (127.0.0.1:7788)'); },
    termId: 't1', provider: 'claude', sessionId: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('안 떠 있'), r.reason);
});

test('서버가 이유를 대며 거절하면 그대로 전한다', async () => {
  const r = await cli.swap({
    post: async () => ({ ok: false, message: '터미널이 없습니다' }),
    termId: 't1', provider: 'codex', sessionId: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('터미널'), r.reason);
});

test('새 세션은 sessionId 를 null 로 보낸다', async () => {
  const seen = [];
  await cli.swap({
    post: async (p, b) => { seen.push(b); return { ok: true }; },
    termId: 't1', provider: 'claude', sessionId: null,
  });
  assert.equal(seen[0].sessionId, null);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/launcher-cli.test.js`

Expected: FAIL — `Cannot find module '../launcher-cli'`

- [ ] **Step 3: 최소 구현**

`launcher-cli.js` 를 새로 만든다. 이 단계에서는 `swap` 만 내보낸다.

```js
#!/usr/bin/env node
// 대시보드 패인의 입구. Codex 와 Claude 를 한 목록에서 고른다.
//
// 에이전트를 띄우지 않는다. 고르면 대시보드에 "이 패인을 이걸로 갈아끼워라" 고
// 부탁하고 사라진다. 우리가 직접 띄우면 에이전트가 이 프로세스의 자식이 되고,
// 훅이 쓰는 pid 파일(~/.claude/sessions/<pid>.json)이 PTY 의 pid 와 어긋나
// 상태 표시와 세션 연결이 조용히 죽는다. 이 레포는 그 실패를 이미 겪었다
// (Codex pid 역인덱스가 무용지물인 이유가 같은 것이다).
'use strict';

// 부탁이 성공하면 서버가 이 PTY 를 죽인다 - 응답이 올 수 없다.
// 그때 나는 끊김은 실패가 아니라 성공의 증거다.
function isDropped(e) {
  const code = e && e.code;
  if (code === 'ECONNRESET' || code === 'EPIPE') return true;
  return /socket hang up/i.test(String((e && e.message) || ''));
}

async function swap({ post, termId, provider, sessionId }) {
  let said;
  try {
    said = await post('/api/term/restart',
      { id: termId, provider: provider, sessionId: sessionId || null });
  } catch (e) {
    if (isDropped(e)) return { ok: true };
    return { ok: false, reason: String((e && e.message) || e) };
  }
  if (said && said.ok) return { ok: true };
  return { ok: false, reason: '대시보드가 거절했다: '
    + String((said && said.message) || '이유 없음') };
}

module.exports = { swap, isDropped };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test test/launcher-cli.test.js`

Expected: PASS (5개)

- [ ] **Step 5: 전체 테스트**

Run: `npm test`

Expected: 실패 0

- [ ] **Step 6: 목록을 띄우는 부분을 붙인다**

같은 파일 아래에 넣는다. 키 입력 루프는 Task 7 이다.

```js
const http = require('http');
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
    r.on('error', (e) => {
      // 끊김은 그대로 올려보낸다 - swap 이 성공으로 읽어야 한다.
      if (isDropped(e)) return reject(e);
      reject(new Error('대시보드가 안 떠 있습니다 (127.0.0.1:' + PORT + ')'));
    });
    if (data) r.write(data);
    r.end();
  });
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
  // 키 입력 루프는 Task 7 - 지금은 목록이 보이는 것까지.
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
git commit -m "런처 CLI - 에이전트를 띄우지 않고 갈아끼워달라고 부탁한다"
```

---

### Task 6: 패인을 런처로 열기 (옵트인)

**Files:**
- Modify: `terminals.js` (`create` 의 명령 선택부와 자식 환경)
- Modify: `public/term.js` (`paneHead` 의 버튼과 클릭 처리)

**Interfaces:**
- Consumes: Task 1 의 `relaunchPlan` (`launcher` 분기), Task 5 의 `launcher-cli.js`
- Produces: `create({ ..., launcher: true })` 가 에이전트 대신 런처 CLI 를 띄운다

**기본값을 바꾸지 않는다.** 지금 `실행` 버튼 동작이 말없이 달라지면 매일 쓰는 흐름이 깨진다. 헤더의 `실행 위치` 토글과 같은 결로 옵트인으로 둔다.

- [ ] **Step 1: `create` 가 런처를 띄울 수 있게 한다**

`terminals.js` 의 `create` 인자 목록에 `launcher` 를 추가하고, 명령과 인자를 정한 **뒤에** 넣는다.

```js
  // 런처로 열면 에이전트 대신 우리 CLI 가 뜬다. 거기서 골라 갈아끼운다.
  // 기본값이 아니다 - 기존 실행 버튼의 동작을 말없이 바꾸지 않는다.
  if (launcher) {
    cmd = process.execPath;
    args = [path.join(__dirname, 'launcher-cli.js')];
  }
```

자식 환경에 `CC_TERM_ID` 와 `CC_LAUNCHER_PORT` 를 넘긴다 (Task 1 의 `restart` 와 같은 모양).

```js
    env: Object.assign(cleanEnv(), {
      CC_TERM_ID: id,
      CC_LAUNCHER_PORT: String(process.env.CC_LAUNCHER_PORT || 7788),
    }),
```

- [ ] **Step 2: 머리글에 `런처` 버튼을 넣는다**

`public/term.js` 의 `paneHead` 에서 `data-restartterm` 버튼 옆에 넣는다.

```js
      + '<button class="pbtn" data-launcher="' + id + '" title="이 패인을 런처로 되돌린다">런처</button>'
```

클릭 처리에서 `/api/term/restart` 를 `{ id: id, launcher: true }` 로 부른다.

- [ ] **Step 3: 별도 포트로 왕복을 확인한다**

**7788 을 건드리지 않는다.**

```bash
CC_LAUNCHER_PORT=7899 node server.js &
```

브라우저로 `http://127.0.0.1:7899` 를 열고 사람 눈으로 확인한다.

1. 런처로 패인을 연다 → 세션 목록이 보인다
2. 머리글 `런처` → 목록이 다시 뜬다
3. 화면이 위에서 아래로 쓸리지 않는다

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
- Consumes: Task 4 의 `nextCursor`, Task 5 의 `swap`
- Produces: `route(state, key) -> { cursor, action }` — `action` 은 `null` · `'pick'` · `'new'` · `'quit'`

키 입력을 "다음 상태" 로 바꾸는 부분을 순수 함수로 갈라둔다. 실제 터미널 없이 시험하기 위해서다.

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

Task 5 Step 6 에서 넣었던 `main` 을 이걸로 갈아끼운다.

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
  let busy = false;
  draw(list, cursor);

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on('data', async (buf) => {
    if (busy) return;                                   // 부탁이 나간 뒤 두 번 누르지 않게
    const next = view.route({ cursor: cursor, total: list.length }, keyName(buf));
    cursor = next.cursor;

    if (next.action === 'quit') process.exit(0);

    if (next.action === 'pick' || next.action === 'new') {
      busy = true;
      const row = next.action === 'pick' ? list[cursor] : null;
      const r = await swap({
        post: (p, b) => req('POST', p, b),
        termId: TERM_ID,
        provider: row ? row.provider : 'claude',
        sessionId: row ? row.id : null,
      });
      // 성공이면 서버가 이 프로세스를 죽이므로 여기 도달하지 않는 것이 보통이다.
      if (!r.ok) {
        process.stdout.write(LF + r.reason + LF);
        busy = false;
        setTimeout(() => draw(list, cursor), 1500);
      }
      return;
    }

    draw(list, cursor);
  });
}
```

`new` 로 고른 provider 가 항상 `claude` 인 것은 지금 그대로 둔다 — 이어하기가 주된 길이고, provider 고르기는 따로 붙인다.

- [ ] **Step 6: 별도 포트로 확인한다**

**7788 을 건드리지 않는다.**

```bash
CC_LAUNCHER_PORT=7899 node server.js &
CC_LAUNCHER_PORT=7899 node launcher-cli.js
```

Expected: 위아래로 커서가 움직이고 `q` 로 빠져나온다. `CC_TERM_ID` 가 없으므로 Enter 를 누르면 `터미널이 없습니다` 가 뜨고 목록으로 돌아온다 — 이것이 "거절당하면 남는다" 의 실제 확인이다.

브라우저에서 런처 패인을 열고 세션을 고르면 그 패인이 그 에이전트가 되고, 머리글의 상태 표시가 **살아 있어야 한다**(작업 중/대기). 죽어 있으면 pid 연결이 끊긴 것이다.

- [ ] **Step 7: 전체 테스트**

Run: `npm test`

Expected: 실패 0

- [ ] **Step 8: 커밋**

```bash
git add launcher-view.js launcher-cli.js test/launcher-view.test.js
git commit -m "런처 CLI - 고르고 새로 시작하는 루프"
```

---

### Task 8: 한도 한 줄

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

`main` 에서 목록과 함께 가져온다. 한도가 느리거나 실패해도 목록은 뜨게 둔다.

```js
  let limits = null;
  try { limits = await req('GET', '/api/limits', null); } catch (e) { /* 없으면 없는 대로 */ }
```

`draw` 를 고치고, 부르는 자리마다 `limits` 를 넘긴다.

```js
function draw(list, cursor, limits) {
  process.stdout.write(ESC + '[2J' + ESC + '[H');
  const head = view.renderLimits(limits);
  if (head) process.stdout.write(head + LF + LF);
  process.stdout.write(view.renderList(list, cursor) + LF + LF);
  process.stdout.write('위아래 이동 · Enter 이어하기 · n 새로 · q 나가기' + LF);
}
```

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

이유: 보내려면 대상을 고르고 본문을 입력받아야 하는데, 그 순간 CLI 가 **입력을 받는 화면을 하나 더** 갖게 된다. 나머지 화면은 전부 키 한 번으로 끝나서 "패인에서 몇 초 안에 끝나는 일" 이라는 경계 안에 있지만 이것만 다르다.

`bridge-send.js` 가 이미 같은 일을 하고 대시보드 UI 에도 버튼이 있으므로, 런처가 도는 동안은 그 둘 중 하나를 쓴다. 나중에 필요해지면 별도 계획으로 붙인다.

## 첫 판에서 바뀐 것 (2026-09-27)

첫 판은 CLI 가 `exec` 로 에이전트가 되는 그림이었다. 사용자가 "스킬이랑 훅 같은거 MCP 호환이 제대로 될까" 를 물어서 확인하다 **훅이 깨지는 것을 구현 전에 찾았다.**

| | 첫 판 | 고친 판 |
|---|---|---|
| 에이전트를 띄우는 주체 | CLI (`spawn`) | 서버 (`restart`) |
| 훅의 pid 연결 | **끊김** | 유지 |
| 새 엔드포인트 | `POST /api/term/provider` | 없음 — `restart` 를 넓힘 |
| CLI 가 하는 일 | 알리고 자리 넘김 | 부탁하고 사라짐 |

스킬과 MCP 는 첫 판에서도 문제가 없었다 — 에이전트가 제 설정에서 제가 띄우므로 누구의 자식인지는 상관이 없다. 걸린 것은 훅 하나뿐이고, 그것이 pid 로 맞추기 때문이다.
