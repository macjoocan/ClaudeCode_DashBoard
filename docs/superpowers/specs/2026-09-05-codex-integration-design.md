# Codex 연동 설계

작성일: 2026-09-05

## 목표

cc-launcher 대시보드 한 곳에서 Claude Code 세션과 Codex 세션을 같이 보고, 열고, 상태를 확인한다.

## 채택안 — 접근 A: 어댑터 모듈 하나를 옆에 붙인다

새 파일 `codex.js` 가 Codex 관련 지식을 전부 소유하고, 기존 Claude 경로는 건드리지 않는다. `server.js` 는 정해진 다섯 지점에서만 어댑터를 부른다: 스캔 병합, 실행 라우팅, 대화 읽기, 그래프, 훅 설치.

검토했으나 택하지 않은 안:

- **provider 레지스트리**(`providers/claude.js` + `providers/codex.js` 공통 인터페이스) — 대칭적이고 3번째 provider를 붙이기 쉽지만, 검증된 Claude 경로를 전부 옮겨야 해서 회귀 위험이 목표 대비 과하다. provider가 실제로 셋이 되면 그때 승격한다.
- **인라인 분기** — 작업량은 A와 비슷한데 Codex 지식(훅 이벤트 매핑, `\\?\` 정규화, rollout 파싱)이 다섯 파일로 흩어진다.

선례도 A를 지지한다. claude-command-center는 엔진 7종을 붙이면서 플러그인 시스템 없이 엔진별 어댑터 코드로 갔다.

## 1. 데이터 어댑터 (`codex.js`)

`~/.codex/state_5.sqlite` 의 `threads` 테이블을 `node:sqlite` 로 읽기 전용 조회한다. rollout jsonl을 스캔하지 않는다. 이 테이블은 rollout 파일 수와 정확히 일치하며(실측 33/33) 런처가 쓰는 값이 전부 인덱싱돼 있다.

| 기존 세션 필드 | Codex 소스 |
|---|---|
| `id` | `threads.id` (UUID) |
| `title` | `title` → `first_user_message` → `preview` 순, 200자 절단 |
| `firstPrompt` / `last` | `first_user_message` / `preview` |
| `mtime` | `updated_at_ms` |
| `branch` | `git_branch` |
| `cwd` | `cwd` 에서 `\\?\` 접두사 제거 |
| `sizeKB` | `rollout_path` 의 `statSync` |
| `subagents` | `thread_spawn_edges` 조인 |
| `provider` | `'codex'` (신규 필드, Claude 쪽은 `'claude'`) |

- **프로젝트 병합**: 키가 `정규화(cwd).toLowerCase()` 이므로 같은 폴더면 Claude 카드와 자동으로 합쳐진다.
- **캐시 무효화**: `select max(updated_at_ms), count(*)` 한 번. 값이 그대로면 재조회하지 않는다.
- **잠금 대비**: 읽기 전용 열기가 실패하면 temp로 복사해 읽는 폴백을 둔다.
- `archived = 1` 은 숨긴다.

### 주의: title이 거대할 수 있다

실측 결과 `title` 중앙값은 29자인데 **최대 36,111자**였다. 승인 요청 블롭이 통째로 제목에 들어간 세션이 존재한다. 절단은 선택이 아니라 필수다.

### 의존성 판단

`node:sqlite` 는 Node 24 내장이라 새 네이티브 의존성이 없다. 다만 experimental이라 기동 시 경고를 뿜으므로 서버에서 억제한다. 대안인 `better-sqlite3` 은 네이티브 빌드가 하나 더 늘어 "첫 실행 자동 설치"를 약하게 만든다.

## 2. 실행 라우팅

`launch()` 가 `provider` 를 받고, `claudeCommand()` 옆에 `codexCommand()` 를 둔다.

| 버튼 | Claude | Codex |
|---|---|---|
| 이어하기 | `claude --resume <id>` | `codex resume <id>` |
| 포크 | `claude --resume <id> --fork-session` | `codex fork <id>` |
| 최근 이어하기 | `claude --continue` | `codex resume --last` |
| 새 세션 | `claude` | `codex` |

내장 터미널(`/api/term/new`)도 같은 `provider` 를 받아 PTY에서 그대로 쓴다. `SAFE_ID` 정규식이 Codex UUID를 통과시키는지 확인이 필요하다.

## 3. 훅 브리지 + 실행 상태

`~/.codex/hooks.json` 에 12개 이벤트를 `type:"command"` + `"async": true` 로 건다. 명령은 stdin JSON을 읽어 `/api/hook` 에 POST하는 작은 스크립트(`codex-hook.js`) 하나다.

Codex는 `type:"http"` 훅을 지원하지 않는다(핸들러는 `command` 와 `mcp_tool` 뿐). Claude 쪽에서 프로세스를 안 띄우려고 http를 쓴 설계가 여기선 성립하지 않는다. `"async": true` 가 이 비용을 상쇄한다 — 훅이 백그라운드로 빠져 턴을 막지 않는다.

- 페이로드 필드(`session_id`·`cwd`·`hook_event_name`·`transcript_path`·`permission_mode`·`turn_id`·`tool_name`·`tool_use_id`·`tool_input`)가 Claude와 거의 같아 `events.js` 를 그대로 재사용한다.
- `PermissionRequest` 만 Claude의 `Notification: permission_prompt` 자리(승인 대기 판정)에 매핑한다.
- `SessionEnd` 는 항상 동기이고 타임아웃이 1~3초라 async를 걸 수 없다. 여기만 짧게 처리한다.

### 실행 상태

Codex에는 `~/.claude/sessions/<pid>.json` 대응물이 없다. 훅이 `~/.codex/.cc-launcher-live/<session_id>.json` 을 직접 쓴다 — SessionStart에 생성, UserPromptSubmit/Stop에 갱신, SessionEnd에 삭제. 죽은 파일은 mtime과 `codex.exe` PID 대조로 걸러낸다. claude-command-center가 쓰는 방식이며 Claude 쪽 구조와 대칭이 맞는다.

## 4. UI

프로젝트 카드 안에서 provider별 섹션으로 나눈다. 카드는 공유하되 `Claude Code` 묶음과 `Codex` 묶음이 구분된다.

- `새 세션` 버튼에 provider 선택이 붙는다.
- 검색·즐겨찾기·실황·연결은 두 provider 공통으로 돈다.
- 즐겨찾기 키가 지금 `slug/id` 인데 Codex는 `slug` 가 없다. `codex:<id>` 형태로 확장하고 기존 `favorites.json` 은 계속 읽히게 둔다.

## 5. 안전장치

`hooks-install.js` 의 기존 방식을 그대로 적용한다 — 타임스탬프 백업, 임시 파일에 쓰고 재파싱 검증 후 rename, 우리 항목만 식별해 남의 훅은 건드리지 않는다.

- **uninstall 경로는 필수**다. 런처를 끄면 Codex가 매 이벤트마다 죽은 포트로 POST하게 된다.
- sqlite에는 절대 쓰지 않는다.
- `rollout_path` 가 `~/.codex/sessions` 하위인지 검증한다(경로 탈출 차단).

## 범위 밖

이번 설계에서 의도적으로 뺀 것들. 못 해서가 아니라 좁힌 결과다.

1. **구성 탭의 Codex 편집** — 읽기(표시·점검)만 넣는다. 편집하려면 TOML 파서/직렬화기와 Codex용 안전장치를 새로 만들어야 하는데 현재 `config-write.js` 의 쓰기 경로는 JSON 전제다.
2. **provider 레지스트리 승격** — 3번째 provider가 실제로 필요해질 때까지 미룬다.
3. **세션 handoff / 포맷 변환** — codbash에 있는 기능(Claude ↔ Codex ↔ Qwen). YAGNI로 제외.
4. **app-server 데몬 기반 실행 상태** — `codex app-server` + `codex agents` 경로. 훅 기반 live-state 파일로 가기로 해서 미확인으로 남긴다. 훅 방식이 실패하면 여기가 대안이다.

## 근거 자료

- Codex 훅 공식 문서: https://learn.chatgpt.com/docs/hooks
- codbash — 같은 문제를 푸는 브라우저 대시보드(xterm.js + node-pty, Claude + Codex): https://github.com/vakovalskii/codbash
- claude-command-center — 엔진 7종을 어댑터 코드로 붙인 사례, 훅이 쓰는 live-state 파일: https://github.com/amirfish1/claude-command-center
- claude-deck — provider 스위처, Codex는 `config.toml` 을 읽음: https://github.com/adrirubio/claude-deck
