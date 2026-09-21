// Claude/Codex 세션 사이의 수동 메시지 브리지.
//
// 메시지는 대상 CLI 가 실행되는 ConPTY 에 bracketed paste + Enter 로 전달한다.
// 자동 회신은 하지 않는다. 사람이 명시적으로 보낸 메시지만 한 번 전달하므로
// 두 에이전트가 서로를 무한 호출하는 루프가 생기지 않는다.
'use strict';

const { pendingPrompt } = require('./tui-state');
const { submitPaste } = require('./session-actions');

const MAX_TEXT = 12000;
const MAX_MESSAGES = 200;
const EXPIRE_MS = 10 * 60 * 1000;

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
}

function providerName(value) {
  return value === 'codex' ? 'Codex' : 'Claude';
}

function createBridge(options) {
  const terminals = options.terminals;
  const startTarget = options.startTarget;
  const readyDelayMs = options.readyDelayMs == null ? 2500 : options.readyDelayMs;
  const quietMs = options.quietMs == null ? 700 : options.quietMs;
  // 시작 직후 화면이 조용하다고 준비된 게 아니다. 실측(Codex 이어하기):
  //   0.4s  출력 16바이트, 화면 정지 407ms  -> 이때 쓰면 붙여넣기가 통째로 먹힌다
  //   3.2s  '업데이트 알림' 모달이 뜨고 사용자가 답할 때까지 그대로 남는다
  // 그래서 (1) 화면이 어느 정도 그려졌고 (2) 프롬프트 없는 상태가 일정 시간
  // **유지될 때** 비로소 쓴다.
  const startupMs = options.startupMs == null ? 30000 : options.startupMs;
  const settleMs = options.settleMs == null ? 4000 : options.settleMs;
  const minScreen = options.minScreen == null ? 512 : options.minScreen;
  const submitDelayMs = options.submitDelayMs == null ? 250 : options.submitDelayMs;
  // 쓴 것이 정말 상대 대화에 들어갔는지 확인한다. 안 들어갔으면 다시 쓴다.
  //
  // 타이밍 규칙(조용한가·프롬프트는 없나·화면은 그려졌나)을 아무리 맞춰도 빠져나가는
  // 경우가 남았다 - 상태는 delivered 인데 Codex 세션 기록에는 없는 일이 실제로 있었다.
  // 규칙을 더 얹어 추측을 정교하게 만드는 대신, **결과를 확인**한다. envelope 에 박힌
  // 메시지 ID 가 상대 기록에 나타나면 그때 delivered 로 본다.
  const verify = options.verify || null;          // (message) => Promise<boolean>
  // 확인 창을 넉넉히 준다. 짧으면 **중복 전송**이 난다 - 상대가 받아서 기록에 적기까지
  // 시간이 걸리는데, 그 전에 재시도하면 같은 메시지가 두 번 들어간다(실측: 20초로 뒀다가
  // 봉투가 상대 대화에 두 번 찍혔다). 놓친 메시지를 늦게 다시 보내는 쪽이,
  // 멀쩡히 간 메시지를 두 번 보내는 쪽보다 낫다.
  // 재시도는 하지 않는다(기본 1회).
  //
  // 상대가 작업 중이면 붙여넣기가 컴포저에 머물다가, 작업이 끝나는 순간 제출된다.
  // 그 사이에 다시 쓰면 **둘 다** 들어간다 - 실측: 상대가 3분 9초 걸리는 일을 하고 있어서
  // 60초 창을 넘겼고, 같은 봉투가 두 번 찍혔다. 늦게 도착하는 것은 기다리면 되지만
  // 두 번 들어간 것은 사람이 치워야 한다.
  // 확인은 큐가 살아있는 동안(10분) 계속 한다. 정말 못 갔으면 사유를 남기고 끝난다.
  const verifyWindowMs = options.verifyWindowMs == null ? EXPIRE_MS : options.verifyWindowMs;
  const maxSends = options.maxSends == null ? 1 : options.maxSends;
  const now = options.now || Date.now;
  const messages = new Map();
  let seq = 0;

  function publicMessage(m) {
    return {
      id: m.id, status: m.status, createdAt: m.createdAt, deliveredAt: m.deliveredAt || null,
      source: m.source, target: m.target, terminalId: m.terminalId || null,
      launched: !!m.launched, error: m.error || null, waitingOn: m.waitingOn || null,
      sends: m.sends || 0,
    };
  }

  function findTarget(m) {
    return terminals.list().find(t => t.alive && t.provider === m.target.provider
      && t.sessionId === m.target.id) || null;
  }

  function envelope(m) {
    return [
      '[세션 브리지 메시지]',
      '발신: ' + providerName(m.source.provider) + ' · ' + (m.source.title || m.source.id),
      '프로젝트: ' + (m.source.project || '-'),
      '메시지 ID: ' + m.id,
      '',
      m.text,
      '',
      '이 메시지는 대시보드에서 사용자가 직접 전달했습니다. 자동 회신되지는 않습니다.',
      '현재 세션에서 위 요청에 답변해 주세요.',
    ].join('\n');
  }

  function trimHistory() {
    if (messages.size <= MAX_MESSAGES) return;
    for (const [id, m] of messages) {
      if (m.status !== 'queued') messages.delete(id);
      if (messages.size <= MAX_MESSAGES) break;
    }
  }

  function pump() {
    const time = now();
    for (const m of messages.values()) {
      if (m.status !== 'queued') continue;
      if (time - m.createdAt > EXPIRE_MS) {
        m.status = 'failed';
        m.error = m.waitingOn
          ? '대상 세션이 ' + m.waitingOn + ' 에서 멈춰 있습니다. 그 터미널에서 먼저 응답해 주세요'
          : '10분 안에 대상 세션이 준비되지 않았습니다';
        continue;
      }
      const target = findTarget(m);
      if (!target) continue;
      m.terminalId = target.id;
      if (time - target.startedAt < readyDelayMs) continue;
      if (target.status === 'busy' || target.status === 'waiting') continue;
      // 훅이 꺼져 status 를 모를 때는 화면이 잠잠해질 때까지 기다려 시작 화면에
      // 메시지가 섞이지 않게 한다. lastAt 대신 lastRealAt 을 쓴다 - Codex TUI 는
      // 대기 중에도 스피너를 다시 그려서 lastAt 기준으로는 영영 잠잠해지지 않고,
      // 그래서 Claude -> Codex 전달만 10분 뒤 시간 초과로 실패했다.
      if (!target.status && time - (target.lastRealAt || target.lastAt) < quietMs) continue;
      // 화면이 조용해도 모달 프롬프트가 떠 있으면 붙여넣기가 대화창이 아니라 **메뉴로**
      // 들어간다(Codex 시작 직후의 업데이트 알림·폴더 신뢰 등). 겉으로는 전달된 것처럼
      // 보이고 상대는 아무것도 못 받는다. 그래서 프롬프트가 걷힐 때까지 기다린다.
      // list() 는 buf 를 안 싣는다. 화면을 보려면 원본 터미널이 필요하다.
      const raw = typeof terminals.get === 'function' ? terminals.get(target.id) : null;
      const screen = (raw && raw.buf) || target.buf || '';
      const blocked = pendingPrompt(screen);
      if (blocked) { m.waitingOn = blocked; m.clearSince = null; continue; }
      // 아직 거의 아무것도 안 그려졌으면 '조용한' 게 아니라 '로딩 중' 이다.
      if (screen.length < minScreen) { m.clearSince = null; continue; }
      if (!m.clearSince) m.clearSince = time;
      // 시작 직후에는 프롬프트가 늦게 뜬다. 잠깐 깨끗한 것만 보고 쓰면 그 틈에 끼인다.
      if (time - target.startedAt < startupMs && time - m.clearSince < settleMs) continue;
      m.waitingOn = null;

      // 이미 한 번 썼으면 확인 창이 끝날 때까지 기다린다. 그 안에 상대 기록에 나타나면
      // 성공, 안 나타나면 다시 쓴다(컴포저에 머물러 있다가 제출이 씹히는 경우가 있다).
      if (m.sentAt && time - m.sentAt < verifyWindowMs) continue;
      if (m.sends >= maxSends) {
        m.status = 'failed';
        m.error = verify
          ? '전달했지만 대상 대화에 나타나지 않았습니다 (' + m.sends + '회 시도)'
          : '전달을 확인하지 못했습니다';
        continue;
      }

      try {
        // 붙여넣기와 Enter 를 나눠 보낸다. Codex 는 201~ 바로 뒤에 붙인 CR 을 제출로
        // 받지 않아 본문이 컴포저에 남는다(실측). 그게 Claude -> Codex 만 안 되던 이유다.
        if (!submitPaste(terminals.write, target.id, envelope(m), submitDelayMs)) {
          throw new Error('대상 터미널에 쓸 수 없습니다');
        }
        m.sends = (m.sends || 0) + 1;
        m.sentAt = time;
        if (!verify) {                      // 확인할 방법이 없으면 예전처럼 쓴 즉시 완료
          m.status = 'delivered';
          m.deliveredAt = time;
        }
      } catch (e) {
        m.status = 'failed';
        m.error = String((e && e.message) || e);
      }
    }
  }

  // 상대 기록을 뒤져 우리 메시지가 들어갔는지 본다. 실패는 조용히 넘긴다 -
  // 확인이 안 된다고 전달을 실패로 만들면 안 된다(재시도가 알아서 한다).
  async function checkDelivered() {
    if (!verify) return;
    for (const m of messages.values()) {
      if (m.status !== 'queued' || !m.sentAt) continue;
      let ok = false;
      try { ok = await verify(publicMessage(m)); } catch { ok = false; }
      if (ok) {
        m.status = 'delivered';
        m.deliveredAt = now();
        m.waitingOn = null;
      }
    }
  }

  async function send(input) {
    const sourceProvider = input?.source?.provider;
    const targetProvider = input?.target?.provider;
    if (!['claude', 'codex'].includes(sourceProvider)
        || !['claude', 'codex'].includes(targetProvider)) throw new Error('provider 가 올바르지 않습니다');
    if (sourceProvider === targetProvider) throw new Error('Claude와 Codex 사이에서만 전달할 수 있습니다');
    if (!input.source.id || !input.target.id) throw new Error('발신·대상 세션이 필요합니다');
    const text = cleanText(input.text);
    if (!text) throw new Error('전달할 메시지를 입력해 주세요');
    if (text.length > MAX_TEXT) throw new Error('메시지는 12,000자까지 전달할 수 있습니다');

    const m = {
      id: 'b' + now().toString(36) + '-' + (++seq).toString(36),
      status: 'queued', createdAt: now(), deliveredAt: null,
      source: { provider: sourceProvider, id: String(input.source.id),
        title: cleanText(input.source.title).slice(0, 200), project: cleanText(input.source.project).slice(0, 260) },
      target: { provider: targetProvider, id: String(input.target.id),
        title: cleanText(input.target.title).slice(0, 200), cwd: String(input.target.cwd || '') },
      text, launched: false, terminalId: null, error: null, waitingOn: null, clearSince: null,
      sends: 0, sentAt: 0,
    };
    messages.set(m.id, m);
    trimHistory();

    let target = findTarget(m);
    if (!target) {
      try {
        target = await startTarget(m.target);
        m.launched = true;
        m.terminalId = target && target.id;
      } catch (e) {
        m.status = 'failed';
        m.error = String((e && e.message) || e);
      }
    }
    pump();
    return publicMessage(m);
  }

  function get(id) {
    const m = messages.get(String(id || ''));
    return m ? publicMessage(m) : null;
  }

  const timer = setInterval(function () { pump(); checkDelivered(); }, 500);
  if (timer.unref) timer.unref();
  return { send, get, pump, checkDelivered, close: () => clearInterval(timer), cleanText };
}

module.exports = { createBridge, cleanText, MAX_TEXT };
