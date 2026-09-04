// events.js 는 top-level require 가 없는 순수 인메모리 모듈이라 격리 테스트가 가능하다.
// 승인 대기(phase: 'waiting') 판정이 Claude(Notification+permission_prompt) 와
// Codex(PermissionRequest) 양쪽에서 성립하는지 확인한다.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const events = require('../events.js');

test('Codex 의 PermissionRequest 이벤트는 세션을 승인 대기로 만든다', () => {
  events.reset();
  events.ingest({ hook_event_name: 'PermissionRequest', session_id: 'sess-pr-1', cwd: 'D:\\x' });
  const live = events.liveState();
  assert.equal(live['sess-pr-1'].phase, 'waiting');
});

test('Claude 의 Notification+permission_prompt 는 여전히 승인 대기로 만든다 (회귀 방지)', () => {
  events.reset();
  events.ingest({ hook_event_name: 'Notification', session_id: 'sess-notif-1',
                  notification_type: 'permission_prompt', cwd: 'D:\\x' });
  const live = events.liveState();
  assert.equal(live['sess-notif-1'].phase, 'waiting');
});

test('permission_prompt 가 아닌 Notification 은 승인 대기로 바꾸지 않는다', () => {
  events.reset();
  events.ingest({ hook_event_name: 'Notification', session_id: 'sess-notif-2',
                  notification_type: 'idle_timeout', cwd: 'D:\\x' });
  const live = events.liveState();
  assert.notEqual(live['sess-notif-2'].phase, 'waiting');
});
