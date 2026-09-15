// Claude/Codex 세션 사이의 수동 메시지 브리지.
//
// 메시지는 대상 CLI 가 실행되는 ConPTY 에 bracketed paste + Enter 로 전달한다.
// 자동 회신은 하지 않는다. 사람이 명시적으로 보낸 메시지만 한 번 전달하므로
// 두 에이전트가 서로를 무한 호출하는 루프가 생기지 않는다.
'use strict';

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
  const now = options.now || Date.now;
  const messages = new Map();
  let seq = 0;

  function publicMessage(m) {
    return {
      id: m.id, status: m.status, createdAt: m.createdAt, deliveredAt: m.deliveredAt || null,
      source: m.source, target: m.target, terminalId: m.terminalId || null,
      launched: !!m.launched, error: m.error || null,
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
        m.error = '10분 안에 대상 세션이 준비되지 않았습니다';
        continue;
      }
      const target = findTarget(m);
      if (!target) continue;
      m.terminalId = target.id;
      if (time - target.startedAt < readyDelayMs) continue;
      if (target.status === 'busy' || target.status === 'waiting') continue;
      // 훅이 꺼져 status 를 모를 때는 출력이 잠잠해질 때까지 기다려 시작 화면에
      // 메시지가 섞이지 않게 한다.
      if (!target.status && time - target.lastAt < quietMs) continue;
      try {
        const payload = '\x1b[200~' + envelope(m) + '\x1b[201~\r';
        if (!terminals.write(target.id, payload)) throw new Error('대상 터미널에 쓸 수 없습니다');
        m.status = 'delivered';
        m.deliveredAt = time;
      } catch (e) {
        m.status = 'failed';
        m.error = String((e && e.message) || e);
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
      text, launched: false, terminalId: null, error: null,
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

  const timer = setInterval(pump, 500);
  if (timer.unref) timer.unref();
  return { send, get, pump, close: () => clearInterval(timer), cleanText };
}

module.exports = { createBridge, cleanText, MAX_TEXT };
