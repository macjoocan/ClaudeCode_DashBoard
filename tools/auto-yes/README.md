# 자동 Yes

Claude Code / Codex 가 아래처럼 물어볼 때 자동으로 Yes 를 고른다.

```
Do you want to proceed?            Would you like to run the following command?
❯ 1. Yes                           › 1. Yes, proceed (y)
  2. No                              2. Yes, and don't ask again ...
```

화면을 누르는 방식이 아니라 두 CLI 가 공식으로 제공하는 `PermissionRequest` 훅으로 허용한다.
그래서 일반 터미널, Claude 데스크톱 앱의 Code 탭, Codex 앱처럼 같은 설정을 읽는 곳이면 다 적용된다.

## 준비물

- Windows, [Node.js](https://nodejs.org) (`node` 명령이 되면 된다)

## 쓰는 법

| 파일 | 하는 일 |
|---|---|
| `install.bat` | 훅 설치(처음 한 번). **설치만 해서는 꺼져 있다** |
| `on.bat` | 켜기. 재시작 필요 없음 |
| `off.bat` | 끄기. 평소처럼 메뉴가 뜬다 |
| `status.bat` | 켜짐/꺼짐, 설치 상태, 최근 기록 5줄 |
| `uninstall.bat` | 훅 제거 |

1. 폴더를 아무 데나 두고 `install.bat` 더블클릭
2. 열려 있던 Claude / Codex 터미널과 앱은 **다시 켠다** (훅은 시작할 때 읽는다)
3. **Codex 는 처음 한 번** `1 hook is new or changed` 가 뜬다. 내용을 확인하고 `Trust all and continue` 를 고른다. 고르지 않으면 Codex 쪽은 동작하지 않는다
4. `on.bat` 으로 켜고, 필요 없으면 `off.bat`

설치하면 스크립트가 `%USERPROFILE%\.auto-yes\` 로 복사된다. 이 폴더는 지워도 되고, 새 버전을 받으면 `install.bat` 을 다시 실행하면 된다.

## 켜져 있어도 자동으로 넘기지 않는 것

다음은 평소처럼 메뉴가 뜬다. 사람이 직접 고른다.

- 플랜 승인(`ExitPlanMode`), 질문(`AskUserQuestion`)
- 되돌리기 어려운 명령: `rm -rf`(`rm -r -fo` 포함), `Remove-Item -Recurse`, `rd /s`·`rmdir /q /s`, `del /s`,
  `git push --force`(`git push origin +main` 포함), `git reset --hard`, `git clean -f`, `format C:`, `DROP TABLE/DATABASE`
- 폴더 신뢰 확인, 업데이트 알림 (권한 요청이 아니라서 훅이 불리지 않는다)

목록은 `auto-yes.js` 위쪽의 `ALWAYS_ASK_COMMANDS` 에 있다.

## 알아둘 것

- 켜면 **그 PC 의 모든 Claude / Codex 세션**에 적용된다. 창마다 따로 켤 수 없다.
- Claude 를 `자동 심사(auto)` 나 `dontAsk` 모드로 쓰면 이 훅이 불리지 않는다. 그 모드에서는 Claude 가 스스로 판단한다.
- 무엇을 허용했는지는 `%USERPROFILE%\.auto-yes\log.txt` 에 남는다(`ALLOW` 허용 / `ASK` 메뉴로 넘김).
- 이미 있던 훅 설정은 건드리지 않고 맨 뒤에 하나만 추가한다. **처음 설치하기 전** 파일이
  `*.auto-yes.orig.bak` 으로 한 번만 남는다(다시 설치·제거해도 덮이지 않는다).
  - Claude: `%USERPROFILE%\.claude\settings.json`
  - Codex: `%USERPROFILE%\.codex\hooks.json`
- 훅이 실패하거나 입력을 못 읽으면 아무것도 허용하지 않는다. 평소처럼 메뉴가 뜬다.

## 버전

지금 버전은 `status.bat` 첫 줄에 나온다. 새 버전을 받으면 `install.bat` 만 다시 실행하면 된다.

- 1.1.0 (2026-10-20) - 위험 명령 거르기 보강(`rmdir /q /s`, `git push origin +main`, `rm -r -fo`),
  원본 설정 백업이 덮이던 문제 수정
- 1.0.0 (2026-10-07) - 첫 버전

## 확인한 환경

Claude Code 2.1.292 / 2.1.301, Codex CLI 0.160.1 / 0.163.0. 두 앱(Claude 데스크톱 Code 탭, Codex 앱)은
같은 설정 파일을 읽으므로 적용될 것으로 보지만 앱에서 직접 확인하지는 않았다.
