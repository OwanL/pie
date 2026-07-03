/**
 * Tests for the pure `backendExitEvents` policy helper extracted from
 * `attach.ts#onExit`. The helper decides what events the host dispatches when
 * the PI backend process dies — critically, whether the user is alerted that
 * one or more running sessions were interrupted (non-user-initiated).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { backendExitEvents } from '../src/host/session-service/backend-exit-events';
import type { Event } from '../src/host/core/events';

test('backendExitEvents alerts about a single interrupted session with a per-session count suffix', () => {
  const events = backendExitEvents(['/s1'], 1, '');

  assert.deepEqual(events, [
    {
      kind: 'NoticeShown',
      notice: 'PI backend stopped (code 1). The active session was interrupted.',
    },
    {
      kind: 'SessionsInterrupted',
      sessionPaths: ['/s1'],
      reason: 'PI backend stopped unexpectedly (code 1)',
    },
    { kind: 'BackendReadyChanged', ready: false },
    { kind: 'RunningSessionsChanged', sessionPaths: [] },
  ] satisfies Event[]);
});

test('backendExitEvents reports a count when multiple sessions were interrupted', () => {
  const events = backendExitEvents(['/s1', '/s2', '/s3'], 137, 'OOM killed');

  assert.deepEqual(events, [
    {
      kind: 'NoticeShown',
      notice: 'PI backend stopped (code 137): OOM killed. 3 running sessions were interrupted.',
    },
    {
      kind: 'SessionsInterrupted',
      sessionPaths: ['/s1', '/s2', '/s3'],
      reason: 'PI backend stopped unexpectedly (code 137): OOM killed',
    },
    { kind: 'BackendReadyChanged', ready: false },
    { kind: 'RunningSessionsChanged', sessionPaths: [] },
  ] satisfies Event[]);
});

test('backendExitEvents does NOT dispatch SessionsInterrupted on a clean exit with nothing running', () => {
  const empty: readonly string[] = [];
  const events = backendExitEvents(empty, 0, '');

  assert.deepEqual(events, [
    { kind: 'NoticeShown', notice: 'PI backend stopped (code 0).' },
    { kind: 'BackendReadyChanged', ready: false },
    { kind: 'RunningSessionsChanged', sessionPaths: [] },
  ] satisfies Event[]);
  assert.ok(
    !events.some((e) => (e as { kind?: string }).kind === 'SessionsInterrupted'),
    'no interrupt alert when nothing was running — clean exit',
  );
});

test('backendExitEvents includes stderr (truncated) in both the notice and the per-session interrupt reason', () => {
  const longStderr = 'x'.repeat(500);
  const events = backendExitEvents(['/s'], null, longStderr);

  const notice = (events[0] as { kind: 'NoticeShown'; notice: string }).notice;
  const interrupt = events.find((e) => e.kind === 'SessionsInterrupted') as {
    kind: 'SessionsInterrupted';
    sessionPaths: string[];
    reason: string;
  };

  assert.ok(notice.includes(': ' + 'x'.repeat(300)), 'notice surfaces truncated stderr');
  assert.ok(notice.length < 500, 'notice is truncated to 300 chars of stderr');
  assert.ok(
    interrupt.reason.includes(': ' + 'x'.repeat(300)),
    'interrupt reason surfaces the same truncated stderr',
  );
  assert.deepEqual(interrupt.sessionPaths, ['/s']);
});

test('backendExitEvents handles a null exit code (process killed without one)', () => {
  const events = backendExitEvents(['/s'], null, '');

  const notice = (events[0] as { kind: 'NoticeShown'; notice: string }).notice;
  assert.equal(notice, 'PI backend stopped. The active session was interrupted.');
  assert.ok(!notice.includes('code'), 'no code suffix when code is null');
});
