#!/usr/bin/env node
// Claude Code 세션에서 Codex 세션으로(그 반대도) 메시지를 보낸다.
//
// 왜 필요한가: Claude Code 의 SendMessage/ListAgents 는 **Claude Code 세션끼리만** 안다.
// Codex 세션 ID 를 주면 "no agent named ... is reachable" 로 반송된다. 그건 하네스
// 기능이라 대시보드가 고칠 수 있는 게 아니다. 대신 대시보드가 이미 가진 브리지
// (/api/bridge/send)를 세션에서 부를 수 있게 한다.
//
// 쓰는 법
//   node bridge-send.js <대상-세션-ID> "보낼 말"
//   node bridge-send.js                      <- 인자 없이 부르면 보낼 수 있는 대상을 나열한다
//
// 선택
//   --from <세션ID>   발신 세션을 직접 지정한다. 기본값은 지금 폴더에서 돌고 있는
//                     내 쪽 세션이고, 없으면 가장 최근에 움직인 것을 쓴다.
//   --port <번호>     대시보드 포트 (기본 7788)
//   --wait <초>       도착 확인을 기다리는 시간 (기본 180)
'use strict';

const http = require('http');

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v == null ? dflt : v;
}

const PORT = Number(opt('port', process.env.CC_LAUNCHER_PORT || 7788));
const WAIT_S = Number(opt('wait', 180));
const FROM = opt('from', null);

function api(path, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path,
      method: body == null ? 'GET' : 'POST',
      headers: body == null ? {} : { 'content-type': 'application/json', 'content-length': data.length },
      timeout: 120000,
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(raw); } catch { return reject(new Error('응답을 읽지 못했습니다: ' + raw.slice(0, 200))); }
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('대시보드가 응답하지 않습니다')));
    req.on('error', e => reject(new Error(
      e.code === 'ECONNREFUSED'
        ? '대시보드가 안 떠 있습니다 (127.0.0.1:' + PORT + '). 바탕화면 바로가기로 켜 주세요.'
        : e.message)));
    if (data) req.write(data);
    req.end();
  });
}

// 스캔 결과를 세션 목록으로 편다.
async function sessions() {
  const j = await api('/api/projects');
  const out = [];
  for (const p of (j.projects || j || [])) {
    for (const s of (p.sessions || [])) {
      out.push({ id: s.id, provider: s.provider, title: s.title || '', live: !!s.live,
                 cwd: p.cwd, project: p.name, mtime: s.mtime || 0 });
    }
  }
  return out;
}

function sameDir(a, b) {
  const norm = v => String(v || '').replace(/[/\\]+$/, '').replace(/\//g, '\\').toLowerCase();
  const x = norm(a);
  return !!x && x === norm(b);
}

async function listTargets(all) {
  const byProv = { claude: [], codex: [] };
  for (const s of all) (byProv[s.provider] || byProv.claude).push(s);
  for (const prov of ['codex', 'claude']) {
    const rows = byProv[prov].sort((a, b) => b.mtime - a.mtime).slice(0, 15);
    console.log('');
    console.log('== ' + (prov === 'codex' ? 'Codex' : 'Claude Code') + ' 세션 (최근 15개) ==');
    for (const s of rows) {
      console.log('  ' + s.id + '  ' + (s.live ? '● ' : '  ')
        + s.project + ' · ' + (s.title || '(제목 없음)').slice(0, 40));
    }
  }
  console.log('');
  console.log('보내기:  node bridge-send.js <대상-세션-ID> "보낼 말"');
}

(async () => {
  const targetId = argv[0];
  const text = argv.slice(1).join(' ').trim();
  const all = await sessions();

  if (!targetId) { await listTargets(all); return; }

  const target = all.find(s => s.id === targetId);
  if (!target) {
    console.error('대상 세션을 찾지 못했습니다: ' + targetId);
    console.error('인자 없이 실행하면 보낼 수 있는 세션 목록이 나옵니다.');
    process.exitCode = 1;
    return;
  }
  if (!text) { console.error('보낼 말을 적어 주세요.'); process.exitCode = 1; return; }

  // 발신은 반대편 provider 여야 한다. 지금 폴더에서 돌고 있는 것을 먼저 고른다.
  const wantFrom = target.provider === 'codex' ? 'claude' : 'codex';
  let source = FROM ? all.find(s => s.id === FROM) : null;
  if (FROM && !source) { console.error('--from 세션을 찾지 못했습니다: ' + FROM); process.exitCode = 1; return; }
  if (!source) {
    const mine = all.filter(s => s.provider === wantFrom);
    source = mine.find(s => s.live && sameDir(s.cwd, process.cwd()))
          || mine.find(s => s.live)
          || mine.sort((a, b) => b.mtime - a.mtime)[0];
  }
  if (!source) { console.error('발신으로 쓸 ' + wantFrom + ' 세션이 없습니다.'); process.exitCode = 1; return; }

  console.log('발신: ' + source.provider + ' ' + source.id + '  (' + source.project + ')');
  console.log('대상: ' + target.provider + ' ' + target.id + '  (' + target.project + ')');

  const sent = await api('/api/bridge/send', {
    sourceProvider: source.provider, sourceId: source.id,
    targetProvider: target.provider, targetId: target.id, text,
  });
  if (sent.error) { console.error('보내지 못했습니다: ' + sent.error); process.exitCode = 1; return; }

  // 대시보드가 상대 기록에서 도착을 확인해 줄 때까지 기다린다.
  const id = sent.message.id;
  const until = Date.now() + WAIT_S * 1000;
  let shown = '';
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 2000));
    const st = await api('/api/bridge/status?id=' + encodeURIComponent(id));
    const m = st.message;
    if (!m) break;
    const line = m.status + (m.waitingOn ? ' (' + m.waitingOn + ')' : '')
      + (m.sends ? ' · 시도 ' + m.sends : '');
    if (line !== shown) { console.log('  ' + line); shown = line; }
    if (m.status === 'delivered') { console.log('전달됐습니다.'); return; }
    if (m.status === 'failed') { console.error('실패: ' + (m.error || '알 수 없음')); process.exitCode = 1; return; }
  }
  console.error('시간 안에 확인되지 않았습니다. 대시보드에서 상태를 봐 주세요.');
  process.exitCode = 1;
})().catch(e => { console.error(String(e && e.message || e)); process.exitCode = 1; });
