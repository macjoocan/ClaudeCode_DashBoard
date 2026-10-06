# 여러 파일·이미지 붙여넣기 — 2026-10-07

Windows 탐색기에서 여러 파일·이미지를 함께 선택해 Ctrl+C 후 내장 터미널에서 Ctrl+V, Ctrl+Shift+V 또는 Shift+Insert로 붙여넣는 경로를 추가했다. 선택 없는 우클릭·가운데 클릭도 Windows 파일 목록을 먼저 확인한다.

브라우저의 paste 이벤트가 실제 File들을 제공하면 기존 업로드 경로를 사용한다. Windows 파일 목록이 있으면 해당 원본 파일 경로 전부를 한 번에 넣고, 브라우저가 복수 선택의 일부만 노출하는 경우에도 전체 목록을 우선한다. 공백이 있는 경로는 따옴표로 감싼다. 드래그·파일 업로드 입력도 xterm의 bracketed paste로 묶는다. 폴더·없어진 파일·상대 경로는 제외한다. 클립보드를 수정하거나 원본 파일을 이동하지 않는다.

일반 텍스트의 브라우저 기본 paste는 유지한다. 브라우저 paste가 먼저 도착하면 Windows fallback을 취소하며, 뒤늦은 Windows 응답도 취소 상태를 확인해 중복 입력을 방지한다. Windows API는 사용자 붙여넣기 동작에서만 호출한다.

구현: `clipboard-files.js`의 숨긴 STA PowerShell 읽기, `POST /api/clipboard-files`, `public/term.js` 이벤트 처리. 서버 API 버전을 8로 올리고 UTF-16 인코딩을 유지하면서 Launch.vbs의 버전 판정을 함께 변경했다. 기존 서버는 재시작해야 새 API가 활성화된다. 실행 중 터미널이 종료될 수 있으므로 작업을 저장한 뒤 서버를 다시 실행하고 브라우저를 새로고침한다. 이번 작업에서 기존 서버를 종료하지 않았다.

검증: 새 회귀 테스트 11개와 기존 클립보드 테스트 13개를 통과했다. 전체 테스트 결과는 `multi-file-test-results.txt`에 남겼다. 실제 Windows API 호출도 성공했다(당시 파일 클립보드 항목 0개). 실제 탐색기에서 복수 파일을 복사해 브라우저·CLI까지 입력하는 수동 종단 검증은 수행하지 않았다. 따라서 모든 앱의 이미지 복사 포맷까지 지원한다고 주장하지 않는다. 앱이 클립보드에 한 장만 제공하면 누락된 이미지 데이터를 복구할 수 없다.

Windows FileDropList 읽기와 STA 요구 사항은 [Microsoft 문서](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.getfiledroplist?view=windowsdesktop-10.0)를 확인했다. 브라우저 paste 데이터의 범위는 [W3C Clipboard 명세](https://www.w3.org/TR/clipboard-apis/)를 참고했다.
