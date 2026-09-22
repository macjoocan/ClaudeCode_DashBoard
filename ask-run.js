// /api/ask 의 실행기 - CLI 를 자식 프로세스로 부르고, 결과와 쓴 토큰을 읽어 온다.
//
// 왜 CLI 인가: 구독 로그인을 그대로 쓴다. API 키도 추가 과금도 없다
// (실측: codex exec 20초/23,864 토큰, claude -p 12초/16,023+191 토큰).
// 그래서 이 파일에는 키가 없고, 자식이 알아서 제 자격증명을 쓴다.
//
// 상한·큐는 모른다. 그건 ask-guard.js 가 한다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function createRunner(opts) {
  const spawn = opts.spawn;
  // 실측(2026-09-23): claude -p 한 번이 56초 걸렸다. 계획서의 12초는 따뜻할 때고,
  // 찬 채로 부르면 그보다 한참 든다. 60초로 두면 정상 호출이 타임아웃으로 죽는다.
  const timeoutMs = opts.timeoutMs == null ? 180000 : opts.timeoutMs;
  const bin = opts.bin || {};

  // 스키마는 파일로만 넘길 수 있다(--output-schema <FILE>). 부르는 쪽이 임시파일까지
  // 챙기게 할 이유가 없어 기본 구현을 둔다. 시험에서는 갈아끼운다.
  const writeSchema = opts.writeSchema || function (schema) {
    const f = path.join(os.tmpdir(), 'cc-ask-' + crypto.randomBytes(6).toString('hex') + '.json');
    fs.writeFileSync(f, JSON.stringify(schema), 'utf8');
    return f;
  };

  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  function splitLines(text) {
    return String(text).split(LF).map((x) => (x.endsWith(CR) ? x.slice(0, -1) : x));
  }

  function argsFor(r, schemaPath) {
    // 프롬프트는 stdin 으로 간다 - argv 에 실으면 shell 경유 시 주입이 된다.
    if (r.provider === 'claude') return ['-p', '--output-format', 'json'];
    if (r.provider === 'codex') {
      // --skip-git-repo-check: 화면이 부르는 것이라 아무 폴더에서나 돌아야 한다.
      // --json: 이벤트를 JSONL 로 내보낸다. 토큰 수를 여기서만 알 수 있다.
      const a = ['exec', '--skip-git-repo-check', '--json'];
      if (schemaPath) a.push('--output-schema', schemaPath);
      return a;                                  // 프롬프트는 stdin 으로 간다
    }
    throw new Error('알 수 없는 provider: ' + r.provider);
  }

  // claude -p --output-format json 은 {result, usage} 를 준다.
  // result 는 문자열이다 - 스키마를 요구했으면 그 안에 JSON 이 들어 있다.
  function parseClaude(text) {
    const o = JSON.parse(text);
    const u = o.usage || {};
    let result = o.result;
    try { result = JSON.parse(o.result); } catch (e) { /* 그냥 문장이면 그대로 둔다 */ }
    return { result, tokens: (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) };
  }

  // codex exec --json 의 출력(2026-09-23 실측). 최상위 type 이 점 표기다:
  //   thread.started / turn.started / item.completed / turn.completed
  // 토큰은 turn.completed.usage 에 한 번만 온다. 답은 item.completed 중
  // item.type === 'agent_message' 의 text 다.
  //
  // item.type === 'error' 도 섞여 온다(실측: 스킬 설명이 잘렸다는 경고). 치명적이지
  // 않으므로 실패로 치지 않되, 답으로 착각해서도 안 된다.
  function parseCodex(text) {
    let tokens = 0;
    let last = null;
    let noted = null;

    for (const line of splitLines(text)) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch (e) { continue; }

      if (j.type === 'turn.completed' && j.usage) {
        // 캐시로 읽은 입력도 한도를 먹는다. 빼지 않는다.
        tokens += (Number(j.usage.input_tokens) || 0) + (Number(j.usage.output_tokens) || 0);
        continue;
      }
      if (j.type === 'item.completed' && j.item) {
        if (j.item.type === 'agent_message' && j.item.text) last = String(j.item.text);
        else if (j.item.type === 'error' && j.item.message) noted = String(j.item.message);
      }
    }

    if (last == null) {
      throw new Error('답으로 볼 만한 줄이 없었다' + (noted ? ' · ' + noted.slice(0, 300) : ''));
    }
    let result = last;
    try { result = JSON.parse(last); } catch (e) { /* 그냥 문장이면 그대로 둔다 */ }
    return { result, tokens };
  }

  function run(r) {
    let cancel = () => {};
    const p = new Promise((resolve) => {
      // 스키마는 파일로만 넘길 수 있다(--output-schema <FILE>).
      let schemaPath = null;
      try {
        if (r.provider === 'codex' && r.schema) schemaPath = writeSchema(r.schema);
      } catch (e) { return resolve({ ok: false, reason: 'schema', message: String(e.message || e) }); }

      // Node 는 .cmd/.bat 직접 실행을 막는다 (실측: spawn EINVAL). 그때만 shell 을 쓴다.
      // argv 에는 우리가 만든 고정 플래그뿐이라 shell 을 거쳐도 주입될 것이 없다.
      const cmd = cmdFor(r);
      const useShell = /[.](cmd|bat)$/i.test(String(cmd));

      let child;
      try { child = spawn(cmd, argsFor(r, schemaPath), { windowsHide: true, shell: useShell }); }
      catch (e) { return resolve({ ok: false, reason: 'spawn', message: String(e.message || e) }); }

      let out = '';
      let err = '';
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill(); } catch (e) {}
        resolve({ ok: false, reason: 'timeout', message: timeoutMs + 'ms 안에 답이 없었다' });
      }, timeoutMs);
      if (timer.unref) timer.unref();

      // 부르는 쪽이 끊으면(브라우저가 창을 닫으면) 자식을 남겨둘 이유가 없다.
      // 남겨두면 답도 못 받는 호출이 한도를 계속 먹는다.
      cancel = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.kill(); } catch (e) {}
        resolve({ ok: false, reason: 'canceled', message: '부르는 쪽이 취소했다' });
      };

      // spawn 실패는 'close' 가 아니라 'error' 로 온다. 안 받으면 unhandled 'error'
      // 로 서버 프로세스가 통째로 죽는다 (실측: spawn claude ENOENT 로 죽었다).
      child.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: 'spawn', message: String((e && e.message) || e) });
      });

      // 프롬프트를 stdin 으로 넣고 닫는다. 안 닫으면 CLI 가 입력을 기다리며 안 끝난다.
      try {
        if (child.stdin) {
          child.stdin.on('error', () => {});     // 자식이 먼저 죽으면 EPIPE 가 난다
          child.stdin.write(String(r.prompt));
          child.stdin.end();
        }
      } catch (e) { /* 못 써도 아래 close/error 가 사유를 준다 */ }

      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });

      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code !== 0) {
          return resolve({ ok: false, reason: 'exit', message: '종료 코드 ' + code + (err ? ' · ' + err.slice(0, 500) : '') });
        }
        const parse = r.provider === 'claude' ? parseClaude : parseCodex;
        try { resolve(Object.assign({ ok: true }, parse(out))); }
        catch (e) { resolve({ ok: false, reason: 'parse', message: String(e.message || e) }); }
      });
    });
    p.cancel = () => cancel();
    return p;
  }

  // Windows 에서 'claude' 는 없다 - claude.cmd 다. server.js 가 이미 찾아 둔 경로를
  // 받아 쓰고, 없으면 이름으로 시도한다(PATH 에 있으면 그것도 된다).
  function cmdFor(r) { return bin[r.provider] || r.provider; }

  return { run };
}

module.exports = { createRunner };
