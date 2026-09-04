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
