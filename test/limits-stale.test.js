// 사용 한도 칸이 "잘 보이다가 안 보이게" 되던 자리.
//
// 실측: Claude 쪽이 HTTP 429 를 받자 칸이 `—` 로만 남았다. 429 는 20분을 쉬므로
// 그동안 숫자가 통째로 사라진다. 한도는 분 단위로 급변하지 않으니, 못 가져올 때는
// 마지막으로 받은 값을 **언제 것인지 밝혀서** 보여주는 편이 낫다.
//
// 그리고 캐시가 메모리에만 있으면 서버를 다시 띄울 때마다 곧장 다시 물어본다.
// 재시작을 몇 번 하다 429 를 맞았다. 재시작이 백오프를 지우면 안 된다.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_FILE = path.join(os.homedir(), '.claude', '.cc-launcher-limits.json');

test('캐시 파일에 마지막 성공값과 백오프 시각이 같이 남는다', () => {
  // 파일이 없을 수도 있다(한 번도 성공 못 한 새 환경). 있으면 모양을 지킨다.
  if (!fs.existsSync(CACHE_FILE)) return;
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  assert.equal(typeof saved.at, 'number', '언제 시도했는지가 있어야 백오프가 재시작을 넘긴다');
  assert.ok('ok' in saved);
  if (saved.lastGood) {
    assert.equal(typeof saved.lastGood.at, 'number');
    assert.ok(saved.lastGood.data, '마지막으로 성공한 본문을 들고 있어야 한다');
  }
});

test('실패 응답에 지난 값이 딸려 온다', async () => {
  const limits = require('../limits');
  const r = await limits.limits();
  if (r.ok) return;                       // 지금 잘 되고 있으면 볼 것이 없다
  // 한 번이라도 성공한 적이 있으면 stale 이 붙어야 한다
  if (fs.existsSync(CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (saved.lastGood) {
      assert.ok(r.stale, '지난 값을 딸려 보내야 화면이 비지 않는다');
      assert.ok(r.stale.data.gauges, r.reason);
    }
  }
});
