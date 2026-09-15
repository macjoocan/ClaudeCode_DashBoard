'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {kind, createInbox} = require('../public/attention');

test('Claude and Codex approval events share an inbox category', () => {
  assert.equal(kind({sessionId:'c',event:'PermissionRequest'}), '승인 요청');
  assert.equal(kind({sessionId:'a',event:'Notification',matcher:'permission_prompt'}), '승인 요청');
  assert.equal(kind({sessionId:'a',event:'Notification',text:'permission_prompt'}), '승인 요청');
  assert.equal(kind({sessionId:'a',event:'Notification',text:'idle_prompt'}), null);
  assert.equal(kind({sessionId:'a',event:'Stop',agentId:'child'}), null);
  assert.equal(kind({event:'Stop'}), null);
});
test('snapshot history is read, live alerts unread, reconnect duplicates ignored', () => {
  const inbox = createInbox();
  const event = {n:1,at:10,sessionId:'a',event:'Stop'};
  inbox.add(event, true);
  assert.equal(inbox.unread(), 0);
  assert.equal(inbox.add(event, false), null);
  inbox.add({...event,n:2,at:11,event:'StopFailure'}, false);
  assert.equal(inbox.unread(), 1);
  inbox.readAll();
  assert.equal(inbox.unread(), 0);
  // A restarted server reuses sequence numbers but the timestamp distinguishes events.
  assert.ok(inbox.add({...event,at:20}, false));
});
test('history is bounded to 50 newest alerts', () => {
  const inbox = createInbox();
  for (let n=0;n<120;n++) inbox.add({n,at:n,sessionId:'a',event:'Stop'}, false);
  assert.equal(inbox.rows.length, 50);
  assert.equal(inbox.rows[0].at, 119);
  assert.equal(inbox.rows[49].at, 70);
});
