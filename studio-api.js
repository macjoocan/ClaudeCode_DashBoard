'use strict';

function studioRoutes({ studio, preview, terminals, readBody, json, readTranscript }) {
  return async function route(req, res, url) {
    if (!url.pathname.startsWith('/api/studio/')) return false;
    try {
      const op = url.pathname.slice('/api/studio/'.length);
      const b = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      const write = new Set(['create', 'start', 'send', 'stop', 'save', 'note', 'commit', 'apply', 'archive', 'preview', 'preview-act', 'preview-send', 'preview-close']);
      if ((write.has(op) && req.method !== 'POST') || (!write.has(op) && req.method !== 'GET')) {
        json(res, 405, { error: '지원하지 않는 요청 방식입니다' }); return true;
      }
      let result;
      if (op === 'tasks') result = { tasks: studio.list(), previewAvailable: preview.available() };
      else if (op === 'inspect') result = await studio.inspect(b.root);
      else if (op === 'create') result = { task: await studio.create(b) };
      else if (op === 'task') result = { task: studio.get(b.task) };
      else if (op === 'start') result = { task: await studio.start(b.task, b.candidate) };
      else if (op === 'send') result = studio.send(b.task, b.candidate, b.text);
      else if (op === 'stop') {
        const { c } = studio.context(b.task, b.candidate);
        if (b.confirmed !== true) throw new Error('터미널 중지 확인이 필요합니다');
        result = { stopped: c.terminalId ? terminals.kill(c.terminalId) : false };
      }
      else if (op === 'files') result = { files: await studio.files(b.task, b.candidate) };
      else if (op === 'file') result = studio.readFile(b.task, b.candidate, b.file);
      else if (op === 'save') result = studio.writeFile(b.task, b.candidate, b.file, b.text, b.version);
      else if (op === 'changes') result = await studio.changes(b.task, b.candidate);
      else if (op === 'diff') result = await studio.diff(b.task, b.candidate, b.file);
      else if (op === 'note') result = studio.note(b.task, b.candidate, b.file, b.line, b.text);
      else if (op === 'commit') result = { task: await studio.commit(b.task, b.candidate, b.message) };
      else if (op === 'apply') result = { task: await studio.apply(b.task, b.candidate, b.confirmed) };
      else if (op === 'archive') result = { task: studio.archive(b.task) };
      else if (op === 'result') {
        const { c } = studio.context(b.task, b.candidate);
        const t = c.terminalId && terminals.get(c.terminalId);
        const id = (t && terminals.info(t).sessionId) || c.sessionId;
        const messages = id ? await readTranscript(c.provider, id) : [];
        result = { messages: (messages || []).filter(m => m.role === 'assistant')
          .slice(-8).map(m => ({ text: String(m.text || '').slice(-16000) })) };
      }
      else if (op === 'preview') { studio.get(b.task); result = await preview.navigate(b.task, b.url); }
      else if (op === 'preview-act') { studio.get(b.task); result = await preview.act(b.task, b); }
      else if (op === 'preview-send') {
        result = studio.send(b.task, b.candidate, preview.message(b.task, b.capture, b.text));
      }
      else if (op === 'preview-close') { await preview.release(b.task); result = {}; }
      else { json(res, 404, { error: '작업 API를 찾지 못했습니다' }); return true; }
      json(res, 200, { ok: true, ...result });
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
    return true;
  };
}
module.exports = { studioRoutes };
