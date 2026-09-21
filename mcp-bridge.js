#!/usr/bin/env node
// 대시보드 브리지를 MCP 도구로 내보낸다.
//
// 왜 필요한가: Claude Code 에는 세션끼리 말을 거는 **자기 것**(SendMessage/ListAgents)이
// 있다. 딱 봐도 이게 맞는 도구라 Claude 는 이걸 집는데, 이건 Claude Code 세션만 안다.
// Codex 세션 ID 를 주면 "no agent named ... is reachable" 로 반송된다. 하네스 기능이라
// 대시보드가 고칠 수 있는 것이 아니다.
//
// 반대 방향이 멀쩡했던 이유도 같다. Codex 에는 그런 자체 기능이 없어서 무조건 대시보드
// 브리지를 탄다. 브리지 자체는 처음부터 양방향이었다 - 빠진 것은 Claude 쪽에서 그걸
// 집어들 손잡이뿐이었다. 그 손잡이를 여기서 만든다.
//
// 왜 남의 것을 안 쓰나: 살아있는 세션에 끼워 넣는 것은 agent-bridge 뿐인데 Windows 를
// 지원하지 않고 Bun 과 자체 런처를 요구해서 대시보드와 PTY 소유권이 충돌한다. 나머지
// (claude-codex-bridge 류)는 부를 때마다 `codex exec` 로 **새 프로세스**를 띄우므로
// "지금 진행 중인 그 세션" 과의 대화가 아니다.
//
// 등록
//   claude mcp add cc-bridge -- node C:\00.SVN\Claude_code\cc-launcher\mcp-bridge.js
'use strict';

const http = require('http');

const PORT = Number(process.env.CC_LAUNCHER_PORT || 7788);
const DEFAULT_WAIT_S = 120;
const NL = String.fromCharCode(10);

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
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('응답을 읽지 못했습니다: ' + raw.slice(0, 200))); }
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
      out.push({
        id: s.id, provider: s.provider, title: s.title || '', live: !!s.live,
        cwd: p.cwd, project: p.name, mtime: s.mtime || 0,
      });
    }
  }
  return out;
}

function sameDir(a, b) {
  const norm = v => String(v || '').replace(/[/\\]+$/, '').replace(/\//g, '\\').toLowerCase();
  const x = norm(a);
  return !!x && x === norm(b);
}

// 발신으로 쓸 세션을 고른다.
//
// 브리지는 서로 다른 provider 사이를 잇는다. 같은 폴더에서 돌고 있는 내 쪽 세션을
// 먼저 고르고, 없으면 살아있는 것, 그것도 없으면 가장 최근에 움직인 것을 쓴다.
function pickSource(all, targetProvider, cwd) {
  const want = targetProvider === 'codex' ? 'claude' : 'codex';
  const mine = all.filter(s => s.provider === want);
  return mine.find(s => s.live && sameDir(s.cwd, cwd))
      || mine.find(s => s.live)
      || mine.slice().sort((a, b) => b.mtime - a.mtime)[0]
      || null;
}

function listText(all, opts) {
  opts = opts || {};
  const lines = [];
  for (const prov of ['codex', 'claude']) {
    if (opts.provider && opts.provider !== prov) continue;
    let rows = all.filter(s => s.provider === prov);
    if (opts.live_only) rows = rows.filter(s => s.live);
    rows.sort((a, b) => b.mtime - a.mtime);
    rows = rows.slice(0, opts.limit || 15);
    lines.push('== ' + (prov === 'codex' ? 'Codex' : 'Claude Code') + ' 세션' +
      (opts.live_only ? ' (실행 중)' : '') + ' ==');
    if (!rows.length) lines.push('  (없음)');
    for (const s of rows) {
      lines.push('  ' + s.id + '  ' + (s.live ? '● ' : '  ') +
        s.project + ' · ' + (s.title || '(제목 없음)').slice(0, 50));
    }
  }
  return lines.join(NL);
}

const TOOLS = [
  {
    name: 'session_list',
    description:
      '대시보드가 아는 코딩 세션을 나열한다. Codex 세션과 Claude Code 세션 둘 다 나온다. ' +
      'session_send 에 넣을 세션 ID 를 여기서 얻는다. ● 는 지금 실행 중이라는 뜻이다.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['codex', 'claude'], description: '한쪽만 보고 싶을 때' },
        live_only: { type: 'boolean', description: '실행 중인 것만' },
        limit: { type: 'number', description: 'provider 당 최대 개수 (기본 15)' },
      },
    },
  },
  {
    name: 'session_send',
    description:
      '다른 코딩 세션에게 말을 보낸다. Claude Code 에서 Codex 세션으로, 또는 그 반대로 보낼 수 있다. ' +
      'Claude Code 의 SendMessage 는 Claude 세션만 알기 때문에 Codex 세션 ID 로는 반송된다 - ' +
      'Codex 로 보낼 때는 이 도구를 쓴다. 상대 기록에서 도착이 확인될 때까지 기다린 뒤 결과를 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '받는 세션 ID (session_list 로 확인)' },
        text: { type: 'string', description: '보낼 말' },
        from_session_id: {
          type: 'string',
          description: '보내는 쪽 세션 ID. 자기 ID 를 알면 넣어 준다. 안 넣으면 같은 폴더에서 ' +
                       '돌고 있는 세션을 골라 쓰는데, 한 폴더에 여러 개면 엉뚱한 것이 발신으로 찍힐 수 있다.',
        },
        wait_seconds: { type: 'number', description: '도착 확인을 기다리는 시간 (기본 120, 0 이면 안 기다림)' },
      },
      required: ['session_id', 'text'],
    },
  },
];

async function callTool(name, args) {
  args = args || {};

  if (name === 'session_list') {
    return listText(await sessions(), args);
  }

  if (name === 'session_send') {
    const targetId = String(args.session_id || '').trim();
    const text = String(args.text || '').trim();
    if (!targetId) throw new Error('session_id 가 필요합니다.');
    if (!text) throw new Error('보낼 말이 비어 있습니다.');

    const all = await sessions();
    const target = all.find(s => s.id === targetId);
    if (!target) throw new Error('그런 세션이 없습니다: ' + targetId + NL + 'session_list 로 확인해 주세요.');

    const fromId = String(args.from_session_id || '').trim();
    let source = null;
    if (fromId) {
      source = all.find(s => s.id === fromId) || null;
      if (!source) throw new Error('from_session_id 세션이 없습니다: ' + fromId);
      if (source.provider === target.provider) {
        // 브리지는 서로 다른 provider 사이를 잇는다. 같은 쪽끼리는 각자의 기능을 쓴다.
        throw new Error('같은 provider 끼리는 이 도구로 보내지 않습니다 (둘 다 ' + source.provider + ').' + NL
          + 'Claude Code 끼리라면 SendMessage 를 쓰세요.');
      }
    } else {
      source = pickSource(all, target.provider, process.cwd());
    }
    if (!source) {
      throw new Error('발신으로 쓸 ' + (target.provider === 'codex' ? 'Claude Code' : 'Codex') + ' 세션이 없습니다.');
    }

    const sent = await api('/api/bridge/send', {
      sourceProvider: source.provider, sourceId: source.id,
      targetProvider: target.provider, targetId: target.id, text,
    });
    if (sent.error) throw new Error('보내지 못했습니다: ' + sent.error);

    const head = '발신: ' + source.provider + ' ' + source.id + NL
               + '대상: ' + target.provider + ' ' + target.id + ' (' + target.project + ')';

    const waitS = args.wait_seconds == null ? DEFAULT_WAIT_S : Number(args.wait_seconds);
    if (!waitS) return head + NL + '보냈습니다. 도착 확인은 기다리지 않았습니다. (메시지 ID ' + sent.message.id + ')';

    const until = Date.now() + waitS * 1000;
    let last = '';
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 2000));
      const st = await api('/api/bridge/status?id=' + encodeURIComponent(sent.message.id));
      const m = st.message;
      if (!m) break;
      last = m.status + (m.waitingOn ? ' (' + m.waitingOn + ')' : '');
      if (m.status === 'delivered') return head + NL + '전달됐습니다.';
      if (m.status === 'failed') throw new Error(head + NL + '실패: ' + (m.error || '알 수 없음'));
    }
    return head + NL + waitS + '초 안에 도착이 확인되지 않았습니다. 마지막 상태: ' + (last || '알 수 없음')
         + NL + '상대가 아직 작업 중일 수 있습니다. 대시보드에서 상태를 볼 수 있습니다.';
  }

  throw new Error('모르는 도구입니다: ' + name);
}

// --- MCP stdio 전송 ---
//
// 줄 단위 JSON-RPC 2.0 이다. 한 줄에 메시지 하나. SDK 없이도 이게 전부다.
function serve() {
  let buf = '';
  const write = msg => process.stdout.write(JSON.stringify(msg) + NL);
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, message) => write({ jsonrpc: '2.0', id, error: { code: -32603, message } });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
  });

  async function handle(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id == null) return;                  // 알림에는 답하지 않는다

    try {
      if (m.method === 'initialize') {
        return reply(m.id, {
          // 클라이언트가 말한 버전에 맞춘다. 모르면 우리가 아는 것으로 답한다.
          protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'cc-launcher-bridge', version: '1.0.0' },
        });
      }
      if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS });
      if (m.method === 'tools/call') {
        const p = m.params || {};
        try {
          const text = await callTool(p.name, p.arguments);
          return reply(m.id, { content: [{ type: 'text', text: String(text) }] });
        } catch (e) {
          // 도구 실패는 프로토콜 오류가 아니다. 모델이 읽고 고칠 수 있게 돌려준다.
          return reply(m.id, { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true });
        }
      }
      if (m.method === 'ping') return reply(m.id, {});
      return fail(m.id, '지원하지 않는 요청입니다: ' + m.method);
    } catch (e) {
      return fail(m.id, String(e && e.message || e));
    }
  }
}

if (require.main === module) serve();

module.exports = { pickSource, sameDir, listText, TOOLS, callTool, serve };
