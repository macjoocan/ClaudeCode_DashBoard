'use strict';

const { submitPaste } = require('./session-actions');
const { pendingPrompt } = require('./tui-state');

const SUMMARY_PROMPT = `[AI 세션 전환 요청]
현재까지의 작업을 반대편 코딩 AI가 바로 이어받을 수 있도록 인수인계 요약을 작성해 주세요.

다음 항목을 짧고 구체적으로 포함하세요.
1. 사용자의 최종 목표와 요구사항
2. 지금까지 내린 주요 결정과 그 이유
3. 수정했거나 중요하게 본 파일과 코드 위치
4. 완료된 작업과 검증 결과
5. 남은 작업, 알려진 문제, 주의사항
6. 다음 AI가 바로 실행할 추천 순서

추측은 사실처럼 쓰지 말고, 비밀값이나 자격증명은 포함하지 마세요.
다른 작업이나 도구 호출은 하지 말고 인수인계 본문만 답변하세요.`;

function opposite(provider) { return provider === 'codex' ? 'claude' : 'codex'; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function lastAssistant(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && String(m.text || '').trim()) return m;
  }
  return null;
}
function signature(m) { return m ? String(m.ts || m.at || '') + '\n' + String(m.text || '') : ''; }
function publicJob(j) {
  return {
    id: j.id, status: j.status, sourceProvider: j.sourceProvider,
    targetProvider: j.targetProvider, sourceTermId: j.sourceTermId,
    targetTermId: j.targetTermId || null, error: j.error || null,
  };
}
function envelope(job, summary) {
  const text = String(summary || '').trim().slice(0, 20000);
  return `[AI 세션 인수인계]
보낸 AI: ${job.sourceProvider === 'codex' ? 'Codex' : 'Claude Code'}
받는 AI: ${job.targetProvider === 'codex' ? 'Codex' : 'Claude Code'}
프로젝트: ${job.cwd}

아래 인수인계 내용을 검토하고, 현재 저장소 상태와 대조한 다음 남은 작업을 이어서 진행해 주세요.

${text}`;
}

function createHandoff(options) {
  const terminals = options.terminals;
  const readTranscript = options.readTranscript;
  const startTarget = options.startTarget;
  const pollMs = options.pollMs || 1000;
  const quietMs = options.quietMs || 1500;
  const summaryTimeoutMs = options.summaryTimeoutMs || 10 * 60 * 1000;
  // 대상 CLI 가 부팅을 끝낼 때까지 넉넉히 기다린다. 예전 20초는 Claude 시작 화면이
  // 다 뜨기도 전에 지나가서, 인수인계가 부팅 중인 TUI 로 들어가 그대로 버려졌다
  // (job 은 sent 인데 대상 화면엔 아무것도 없었다 - 실측).
  const targetTimeoutMs = options.targetTimeoutMs || 60000;
  // bridge 와 같은 기준: 화면이 어느 정도 그려졌고, 프롬프트 없는 상태가 유지될 것.
  const settleMs = options.settleMs == null ? 4000 : options.settleMs;
  const minScreen = options.minScreen == null ? 512 : options.minScreen;
  // 붙여넣기가 화면에 반영된 뒤 Enter 를 보낸다. 너무 빠르면 컴포저가 아직
  // 붙여넣기를 처리하는 중이라 제출이 씹힌다.
  const submitDelayMs = options.submitDelayMs == null ? 250 : options.submitDelayMs;
  const jobs = new Map();
  let seq = 0;
  let closed = false;

  async function waitForSummary(job, baseline) {
    const deadline = Date.now() + summaryTimeoutMs;
    while (!closed && Date.now() < deadline) {
      await sleep(pollMs);
      const source = terminals.get(job.sourceTermId);
      if (!source || source.exitCode != null) throw new Error('요약 중 원본 세션이 종료되었습니다');
      const latest = lastAssistant(await readTranscript(job));
      if (latest && signature(latest) !== baseline) {
        const info = terminals.info(source);
        // 훅이 실제 idle을 알려준 경우만 즉시 완료로 본다. 상태가 null이면
        // 스트리밍 중간 조각을 요약 완성본으로 오인하지 않도록 출력 정적 시간을 기다린다.
        const safe = info.status === 'idle';
        // lastAt 이 아니라 lastRealAt 을 본다 - Codex TUI 는 대기 중에도 스피너를
        // 계속 그려서 lastAt 으로는 영영 조용해지지 않는다.
        const quiet = Date.now() - Number(source.lastRealAt || source.lastAt || 0) >= quietMs;
        if (safe || quiet) return String(latest.text || '').trim();
      }
    }
    throw new Error('인수인계 요약 응답을 기다리는 시간이 초과되었습니다');
  }

  async function waitForTarget(job, target) {
    const deadline = Date.now() + targetTimeoutMs;
    let clearSince = null;
    while (!closed && Date.now() < deadline) {
      await sleep(pollMs);
      if (target.exitCode != null) throw new Error('전환할 AI 세션이 시작 중 종료되었습니다');
      const screen = target.buf || '';
      // 모달 프롬프트(업데이트 알림·폴더 신뢰 등)가 떠 있으면 아직 준비된 게 아니다.
      // 그대로 쓰면 인수인계 본문이 메뉴로 들어가고 Enter 가 항목을 골라버린다.
      // 화면이 거의 안 그려진 것도 '조용한' 게 아니라 '부팅 중' 이다.
      if (pendingPrompt(screen) || screen.length < minScreen) { clearSince = null; continue; }
      if (!clearSince) clearSince = Date.now();
      if (Date.now() - clearSince < settleMs) continue;
      if (Date.now() - Number(target.lastRealAt || target.lastAt || 0) >= quietMs) return;
    }
    if (closed) throw new Error('대시보드가 종료되었습니다');
    // 제한 시간이 지나도 프롬프트가 그대로면 쓰면 안 된다. 인수인계 본문이 메뉴로
    // 들어가고 Enter 가 항목을 골라버린다 - 조용히 잘못 눌리느니 실패가 낫다.
    const blocked = pendingPrompt(target.buf);
    if (blocked) throw new Error('전환할 AI 세션이 ' + blocked + ' 에서 멈춰 있습니다. 그 터미널에서 먼저 응답해 주세요');
    // 화면이 여전히 비어 있으면 아직 부팅 중이다. 지금 쓰면 그대로 버려진다.
    if ((target.buf || '').length < minScreen) {
      throw new Error('전환할 AI 세션이 아직 준비되지 않았습니다 (시작 화면이 뜨지 않음)');
    }
    // 일부 CLI/테마는 준비 완료 뒤에도 커서를 계속 갱신한다. 제한 시간이 지나면
    // 살아있는 PTY에는 전달을 시도하되, 종료된 경우만 실패시킨다.
    if (target.exitCode != null) throw new Error('전환할 AI 세션을 시작하지 못했습니다');
  }

  async function run(job, baseline) {
    try {
      const summary = await waitForSummary(job, baseline);
      job.status = 'starting-target';
      const target = await startTarget({
        provider: job.targetProvider, cwd: job.cwd,
        title: (job.targetProvider === 'codex' ? 'Codex' : 'Claude') + ' · 인수인계',
      });
      job.targetTermId = target.id;
      await waitForTarget(job, target);
      // 붙여넣기와 Enter 를 나눠 보낸다 - Codex 는 201~ 뒤에 붙인 CR 을 제출로 안 받는다.
      if (!submitPaste(terminals.write, target.id, envelope(job, summary), submitDelayMs)) {
        throw new Error('전환할 AI 세션에 인수인계를 입력하지 못했습니다');
      }
      job.status = 'sent';
    } catch (e) {
      job.status = 'failed';
      job.error = String((e && e.message) || e);
    }
  }

  async function start(termId) {
    if (closed) throw new Error('세션 전환 관리자가 종료되었습니다');
    const source = terminals.get(termId);
    if (!source || source.exitCode != null) throw new Error('실행 중인 원본 터미널이 없습니다');
    const info = terminals.info(source);
    if (!info.sessionId) throw new Error('첫 메시지를 보낸 뒤 세션 ID가 확인되면 전환할 수 있습니다');
    if (info.status === 'busy' || info.status === 'waiting') {
      throw new Error('작업 또는 승인 대기가 끝난 뒤 전환해 주세요');
    }
    if (!info.status && Date.now() - Number(source.lastRealAt || source.lastAt || 0) < quietMs) {
      throw new Error('터미널 출력이 멈춘 뒤 전환해 주세요');
    }
    // 원본도 모달 프롬프트에 걸려 있을 수 있다(Codex 시작 직후의 업데이트 알림 등).
    // 그대로 쓰면 요약 요청이 대화창이 아니라 메뉴로 들어가고 Enter 가 항목을 고른다.
    // 대상만 막아두면 여기서 똑같이 당한다.
    const sourceBlocked = pendingPrompt(source.buf);
    if (sourceBlocked) {
      throw new Error('이 세션이 ' + sourceBlocked + ' 에서 멈춰 있습니다. 터미널에서 먼저 응답한 뒤 전환해 주세요');
    }
    const before = lastAssistant(await readTranscript({
      sourceProvider: info.provider, sourceSessionId: info.sessionId,
      cwd: info.cwd, sourceTermId: info.id,
    }));
    const job = {
      id: 'h' + Date.now().toString(36) + '-' + (++seq), status: 'summarizing',
      sourceProvider: info.provider, targetProvider: opposite(info.provider),
      sourceSessionId: info.sessionId, sourceTermId: info.id, cwd: info.cwd,
      targetTermId: null, error: null,
    };
    jobs.set(job.id, job);
    if (!submitPaste(terminals.write, info.id, SUMMARY_PROMPT, submitDelayMs)) {
      jobs.delete(job.id);
      throw new Error('원본 세션에 요약 요청을 입력하지 못했습니다');
    }
    run(job, signature(before));
    return publicJob(job);
  }

  return {
    start,
    get(id) { const j = jobs.get(String(id || '')); return j ? publicJob(j) : null; },
    close() { closed = true; },
  };
}

module.exports = { createHandoff, lastAssistant, signature, envelope, SUMMARY_PROMPT, opposite };
