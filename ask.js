// /api/ask - 가드와 실행기를 잇는다.
//
// "Claude 가 화면을 만들고 GPT 가 머리를 맡는다" 를 API 키 없이 하는 자리다.
// 화면 쪽 코드는 fetch 한 줄이면 되고, 키가 어디에도 안 들어간다.
//
// 여기서 지킬 것은 하나다: **가드를 우회할 길이 없어야 한다.**
// 실행기를 직접 부르는 길을 만들지 않는다. 반드시 acquire 를 지나야 run 에 닿는다.
'use strict';

const PROVIDERS = ['claude', 'codex'];

// 이유마다 맞는 상태를 단다. 상태를 server.js 안에서 정하면 시험할 자리가 없다.
// 잘못 부른 것(400)과 상한(429)을 섞으면, 화면은 "좀 쉬었다 다시" 로 읽고
// 고칠 것을 안 고친 채 재시도 루프를 돈다 - 우리가 막으려던 바로 그 모양이다.
const STATUS = {
  bad_request: 400,
  per_minute: 429,
  daily_tokens: 429,
};
function statusFor(reason) { return STATUS[reason] || 502; }

function createAsk(deps) {
  const guard = deps.guard;
  const runner = deps.runner;

  return async function ask(r, hooks) {
    const provider = String((r && r.provider) || '');
    const prompt = String((r && r.prompt) || '');

    // 상한을 쓰기 전에 거른다. 슬롯을 잡았다가 놓는 낭비를 하지 않는다.
    if (PROVIDERS.indexOf(provider) < 0) {
      return { ok: false, reason: 'bad_request', status: 400, message: 'provider 는 ' + PROVIDERS.join(' 또는 ') + ' 여야 한다' };
    }
    if (!prompt.trim()) {
      return { ok: false, reason: 'bad_request', status: 400, message: 'prompt 가 비었다' };
    }

    const req = { provider, prompt, schema: (r && r.schema) || null };
    const slot = await guard.acquire(req);

    if (!slot.ok) return Object.assign({ status: statusFor(slot.reason) }, slot);
    if (slot.cached !== undefined) {
      return { ok: true, status: 200, result: slot.cached, cached: true };
    }

    const p = runner.run(req);
    if (hooks && hooks.onStart) hooks.onStart(p);    // 부르는 쪽이 끊으면 취소할 수 있게

    const out = await p;
    if (!out.ok) { guard.abandon(slot.ticket); return Object.assign({ status: statusFor(out.reason) }, out); }

    guard.finish(slot.ticket, { tokens: out.tokens, result: out.result });
    return { ok: true, status: 200, result: out.result, tokens: out.tokens };
  };
}

module.exports = { createAsk };
