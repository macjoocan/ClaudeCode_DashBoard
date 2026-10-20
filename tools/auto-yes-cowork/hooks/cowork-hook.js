// auto-yes-cowork 훅. 코워크가 승인 창을 띄우기 직전(PermissionRequest)에 불려 허용을 돌려준다.
//
// 테스트 버전이다. 코워크는 격리된 가상머신 안에서 돌기 때문에 훅이 Windows 에서 도는지
// 가상머신(Linux) 안에서 도는지 문서에 없다. 그래서 불릴 때마다 어디서 무엇을 했는지
// 작업 폴더의 auto-yes-cowork-log.txt 에 남긴다. 그 파일이 생기는지가 첫 번째 확인이다.
//
// 판단이 안 서거나 무엇이든 실패하면 아무것도 출력하지 않는다 - 그러면 평소처럼 창이 뜬다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 위험 명령 검사는 팀용 자동 Yes(tools/auto-yes/auto-yes.js)를 빌드 때 lib-auto-yes.js 로 복사해 쓴다.
// 못 불러오면 아무것도 허용하지 않는다.
let alwaysAsk = null;
try { alwaysAsk = require('./lib-auto-yes.js').alwaysAsk; } catch {}
const haveRiskCheck = typeof alwaysAsk === 'function';

// 데이터를 바꾸는 SQL. hue-bi 같은 커넥터는 명령 대신 query 문자열을 넘긴다.
const SQL_WRITE = /(^|;)\s*(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|upsert|replace|load\s+data|invalidate\s+metadata|refresh|compute\s+stats)\b/i;
function sqlWrite(ti) {
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  })(ti);
  return strings.some(s => SQL_WRITE.test(s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')));
}

function writeLog(line) {
  const name = 'auto-yes-cowork-log.txt';
  for (const dir of [process.cwd(), os.homedir(), os.tmpdir()]) {
    try { fs.appendFileSync(path.join(dir, name), line + os.EOL); return; } catch {}
  }
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const event = input.hook_event_name || '?';
  const tool = input.tool_name || '';
  let decision = '-';
  let out = null;
  if (event === 'PermissionRequest') {
    const why = !haveRiskCheck ? 'no risk check' : (alwaysAsk(input) || (sqlWrite(input.tool_input || {}) ? 'sql write' : null));
    if (why) decision = 'ASK (' + why + ')';
    else {
      decision = 'ALLOW';
      out = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    }
  }
  const brief = JSON.stringify(input.tool_input || '').replace(/\s+/g, ' ').slice(0, 140);
  writeLog([new Date().toISOString(), event, decision, tool, 'mode=' + (input.permission_mode || '?'),
    'os=' + process.platform + '/' + os.release(), 'node=' + process.version, 'cwd=' + process.cwd(), brief].join(' | '));
  if (out) process.stdout.write(JSON.stringify(out));
}

try { main(); } catch { /* 훅은 실패로 끝나지 않는다 */ }
