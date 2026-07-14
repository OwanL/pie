import test from 'node:test';
import assert from 'node:assert/strict';

import { backendExitEvents } from '../../../src/host/session-service/backend-exit-events';

test('deduplicates affected paths and classifies interrupted sessions', () => {
  const events = backendExitEvents(
    ['/s1', '/s1', '/s2', '/s3'],
    137,
    'raw OOM details',
    1234,
    { '/s1': 'waiting for user input', '/s2': 'running a tool', '/s3': 'generating' },
  );
  assert.deepEqual(events[0], {
    kind: 'NoticeShown',
    notice: 'PI backend stopped (code 137). 3 sessions were interrupted (1 waiting for user input, 1 running a tool, 1 generating).',
    noticeKind: 'backend-exit',
    noticeRaw: 'raw OOM details',
  });
  assert.deepEqual(events[1], {
    kind: 'SessionsInterrupted',
    sessionPaths: ['/s1', '/s2', '/s3'],
    reason: 'PI backend stopped unexpectedly (code 137)',
    occurredAt: 1234,
  });
  assert.equal(JSON.stringify(events[0]).includes('active session'), false);
  assert.equal((events[0] as { notice: string }).notice.includes('raw OOM'), false);
});

test('reports no interruption when no sessions were running', () => {
  const events = backendExitEvents([], 0, 'detail', 1234);
  assert.deepEqual(events, [
    { kind: 'NoticeShown', notice: 'PI backend stopped (code 0).', noticeKind: 'backend-exit', noticeRaw: 'detail' },
    { kind: 'BackendReadyChanged', ready: false },
    { kind: 'RunningSessionsChanged', sessionPaths: [] },
  ]);
});
