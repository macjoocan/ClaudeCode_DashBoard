# auto-yes-cowork (테스트 버전 0.1.0)

Claude 데스크톱 앱 **코워크**에서 권한 승인 창(한 번만 허용 / 이 작업에 허용)을 자동으로 허용하는 플러그인이다.
터미널·Code 탭·Codex 용은 `../auto-yes` 이다. 코워크는 그 설정을 읽지 않아서 따로 만들었다.

## 지금은 테스트 버전이다

코워크는 격리된 가상머신 안에서 돌고, 플러그인 훅이 어디서 실행되는지 문서에 없다.
그래서 이 버전은 훅이 불릴 때마다 **작업 폴더에 `auto-yes-cowork-log.txt`** 를 남긴다.

| 기록에 보이는 것 | 뜻 |
|---|---|
| 파일이 아예 안 생김 | 훅이 안 불렸거나, 그 환경에 node 가 없다 |
| `SessionStart`, `PreToolUse` 만 있음 | 훅은 돈다. 코워크 승인 창은 PermissionRequest 를 거치지 않는다 |
| `PermissionRequest ... ALLOW` 인데 창이 뜸 | 훅 응답을 코워크가 무시한다 (조직 정책일 수 있음) |
| `PermissionRequest ... ALLOW` 이고 창이 안 뜸 | 성공 |
| `os=win32` / `os=linux` | 훅이 Windows / 가상머신 안에서 돈 것 |

## 켜져 있어도 직접 고르는 것

- 플랜 승인, 질문
- 통째 삭제·강제 푸시·`git reset --hard` 등 (`../auto-yes` 와 같은 목록)
- 데이터를 바꾸는 SQL: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `MERGE` 등.
  `SELECT` 만 자동으로 넘긴다.

## 설치 / 끄기

- 설치: 코워크 대화창에 `auto-yes-cowork-0.1.0.plugin` 파일을 끌어다 놓고 설치 버튼을 누른다.
  (또는 Customize → Plugins 에서 올리기. 회사 정책으로 개인 플러그인 설치가 막혀 있을 수 있다)
- 끄기: Customize → Plugins 에서 이 플러그인을 끄거나 지운다.

## 빌드

`powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1` → `dist/auto-yes-cowork-<버전>.plugin`
