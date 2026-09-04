/**
 * Brief H error mapper (shared/error-mapping.ts).
 *
 * Pure string-in → `{ message, kind }` out. Locks in the contract with Brief B
 * (the known error strings RequestTracker/BackendClient/EffectRunner produce)
 * and the Brief H invariant: **no internal `req-NN` id ever reaches the user**.
 * Recovery action buttons are derived from `kind` via `noticeActionsFor` (the
 * single source of truth the webview imports).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripReqIds,
  isCancelErrorString,
  mapSendOrEditError,
  mapPreflightError,
  noticeActionsFor,
  noticeActionLabel,
  type NoticeKind,
  type NoticeAction,
} from '../../../src/shared/error-mapping';

// ─── stripReqIds / isCancelErrorString ───────────────────────────────────────

test('stripReqIds replaces every req-NN id with the neutral token "request"', () => {
  assert.equal(stripReqIds('Timed out waiting for response to req-45'), 'Timed out waiting for response to request');
  // Multiple ids in one string.
  assert.equal(stripReqIds('req-1 then req-99 then req-452'), 'request then request then request');
  // No id → unchanged.
  assert.equal(stripReqIds('Backend stopped.'), 'Backend stopped.');
  // Id-like substrings that are not req-NN are left alone.
  assert.equal(stripReqIds('pre-request hook'), 'pre-request hook');
});

test('isCancelErrorString detects RequestTracker cancel strings', () => {
  assert.equal(isCancelErrorString('Request req-12 was cancelled.'), true);
  assert.equal(isCancelErrorString('Request req-12 was cancelled: user aborted'), true);
  // Non-cancel errors are not cancels.
  assert.equal(isCancelErrorString('Timed out waiting for response to req-45'), false);
  assert.equal(isCancelErrorString(undefined), false);
  assert.equal(isCancelErrorString('Backend stopped.'), false);
});

// ─── mapSendOrEditError (pre-ack RPC failure) ────────────────────────────────

test('mapSendOrEditError classifies RequestTracker timeouts and never leaks req-NN', () => {
  const send = mapSendOrEditError('Timed out waiting for response to req-45', 'send')!;
  assert.equal(send.kind, 'send-timeout');
  assert.ok(!send.message.includes('req-45'), 'no req-NN in the user-facing message');

  const edit = mapSendOrEditError('Timed out waiting for response to req-45', 'edit')!;
  assert.equal(edit.kind, 'edit-failed');
  assert.ok(!edit.message.includes('req-45'));
});

test('mapSendOrEditError classifies dropped-line errors and offers show-logs', () => {
  const send = mapSendOrEditError('Backend sent an unparseable response for req-7: bad json :: {...} (stderr tail: boom)', 'send')!;
  assert.equal(send.kind, 'dropped-line');
  assert.ok(!send.message.includes('req-7'));
});

test('mapSendOrEditError classifies backend-exit errors', () => {
  for (const err of [
    'Backend exited unexpectedly with code 1.',
    'Backend stopped.',
    'Backend is not running',
    'Backend client disposed.',
  ]) {
    const send = mapSendOrEditError(err, 'send')!;
    assert.equal(send.kind, 'backend-exit', `backend-exit for: ${err}`);
    const edit = mapSendOrEditError(err, 'edit')!;
    assert.equal(edit.kind, 'edit-failed', `edit-failed for: ${err}`);
  }
});

test('mapSendOrEditError gives disabled providers an actionable settings notice', () => {
  const send = mapSendOrEditError(
    'PROVIDER_DISABLED: The selected model provider is disabled in Pie settings.',
    'send',
  )!;
  assert.equal(send.kind, 'provider-disabled');
  assert.match(send.message, /Enable it in settings|enabled provider/);
  assert.deepEqual(noticeActionsFor(send.kind), ['open-settings']);
});

test('mapSendOrEditError falls back to a generic message for unknown errors (no raw error leaked)', () => {
  const send = mapSendOrEditError('some unknown internal error req-99 with internals', 'send')!;
  assert.equal(send.kind, 'send-failed');
  // The raw error is NOT included (it may carry req-NN or other internals).
  assert.ok(!send.message.includes('req-99'));
  assert.ok(!send.message.includes('some unknown internal error'));

  const edit = mapSendOrEditError('weird error req-2', 'edit')!;
  assert.equal(edit.kind, 'edit-failed');
  assert.ok(!edit.message.includes('req-2'));
});

test('mapSendOrEditError returns null for a user-initiated cancel (suppress the notice)', () => {
  // The rollback still happens; only the error banner is suppressed (the user
  // initiated the cancel — a banner would be noise).
  assert.equal(mapSendOrEditError('Request req-12 was cancelled.', 'send'), null);
  assert.equal(mapSendOrEditError('Request req-12 was cancelled.', 'edit'), null);
});

// ─── mapPreflightError (post-ack, pre-commit setup failure) ─────────────────

test('mapPreflightError classifies send-timer fires and surfaces the budget (whole seconds)', () => {
  const send = mapPreflightError('Timed out waiting for the turn to start streaming (120s)', 'send');
  assert.equal(send.kind, 'prepass-timeout');
  assert.ok(send.message.includes('120s'), 'budget surfaced in the message');
  assert.ok(!send.message.includes('req-'));

  const edit = mapPreflightError('Timed out waiting for the turn to start streaming (120s)', 'edit');
  assert.equal(edit.kind, 'edit-failed');
});

test('mapPreflightError accepts DECIMAL-second budgets (Brief H follow-up — was misclassified as prepass-failed)', () => {
  // The send-timer budget derives from prepassTimeoutSec + first-token headroom
  // and may be fractional. The capture group must accept an optional decimal,
  // else a `12.5s` budget fails to match and the error misclassifies as a
  // generic backend-reported setup failure.
  const send = mapPreflightError('Timed out waiting for the turn to start streaming (12.5s)', 'send');
  assert.equal(send.kind, 'prepass-timeout', 'decimal budget classified as prepass-timeout, not prepass-failed');
  assert.ok(send.message.includes('12.5s'), 'decimal budget surfaced in the message');

  const edit = mapPreflightError('Timed out waiting for the turn to start streaming (0.5s)', 'edit');
  assert.equal(edit.kind, 'edit-failed');
});

test('mapPreflightError classifies a model-start timeout (pruning already succeeded) as model-start-timeout, NOT prepass-timeout', () => {
  // The send-timer is re-armed with the model-start budget once pruning
  // succeeds; a fire after re-arm carries the model-start error string so the
  // notice blames model-start (concurrency/rate-limit/first-token), NOT pruning
  // — pruning already finished. Both strings begin "Timed out waiting for … to
  // start streaming", so the patterns must stay distinct.
  const send = mapPreflightError('Timed out waiting for the model to start streaming (600s)', 'send');
  assert.equal(send.kind, 'model-start-timeout', 'model-start fire classified as model-start-timeout, not prepass-timeout');
  assert.ok(send.message.includes('600s'), 'budget surfaced in the message');
  assert.ok(send.message.includes('concurrency slot'), 'message names the likely cause');
  assert.ok(!send.message.toLowerCase().includes('pruning'), 'does not blame pruning');
  assert.ok(!send.message.includes('req-'));

  const edit = mapPreflightError('Timed out waiting for the model to start streaming (600s)', 'edit');
  assert.equal(edit.kind, 'edit-failed');
});

test('mapPreflightError accepts DECIMAL-second model-start budgets', () => {
  const send = mapPreflightError('Timed out waiting for the model to start streaming (12.5s)', 'send');
  assert.equal(send.kind, 'model-start-timeout');
  assert.ok(send.message.includes('12.5s'));
});

test('mapPreflightError classifies a ProviderGate saturation (queued for a concurrency slot) as model-start-timeout, NOT prepass-failed', () => {
  // When the send is legitimately QUEUED waiting for a provider concurrency
  // slot and the queueWait deadline elapses, ProviderGate throws a retryable
  // 429 whose message contains "concurrency cap reached". This reaches the
  // host as a PreflightFailed and must NOT be blamed as a pruning
  // (prepass-failed) failure — the turn was queued, not broken. It reuses the
  // model-start-timeout kind (same concurrency/rate-limit domain +
  // retry/show-logs remedy).
  const raw =
    'Provider "anthropic" concurrency cap reached: waited 30000ms without a slot. Retry after a brief delay.';
  const send = mapPreflightError(raw, 'send');
  assert.equal(send.kind, 'model-start-timeout', 'saturation classified as model-start-timeout, not prepass-failed');
  assert.ok(send.message.includes('concurrency slot'), 'message names the queued-slot cause');
  assert.ok(!send.message.toLowerCase().includes('pruning'), 'does not blame pruning');
  assert.ok(!send.message.includes('req-'), 'no req-NN leaked');
  assert.ok(!send.message.includes('anthropic'), 'raw provider name not leaked into the user-facing message');

  const edit = mapPreflightError(raw, 'edit');
  assert.equal(edit.kind, 'edit-failed');
  assert.ok(!edit.message.toLowerCase().includes('pruning'), 'edit does not blame pruning');
  assert.ok(!edit.message.includes('req-'));
});

test('mapPreflightError classifies generic setup failures without blaming pruning', () => {
  // SDK preflight includes auth/model checks, compaction, input hooks, and all
  // before_agent_start extensions. Surface the sanitized cause without
  // claiming skill pruning ran.
  const send = mapPreflightError('model rate limit exceeded for req-3', 'send');
  assert.equal(send.kind, 'send-failed');
  assert.ok(send.message.includes('model rate limit exceeded'), 'sanitized detail surfaced');
  assert.ok(!send.message.includes('req-3'), 'req-NN stripped from the detail');
  assert.ok(!send.message.toLowerCase().includes('pruning'));

  const edit = mapPreflightError('some setup failure req-8', 'edit');
  assert.equal(edit.kind, 'edit-failed');
  assert.ok(!edit.message.includes('req-8'));
  assert.ok(!edit.message.toLowerCase().includes('pruning'));
});

test('mapPreflightError never returns null (a setup failure is always a real error)', () => {
  assert.ok(mapPreflightError(undefined, 'send') !== null);
  assert.ok(mapPreflightError('', 'send') !== null);
  assert.ok(mapPreflightError(undefined, 'edit') !== null);
});

// ─── Recovery actions (webview-side) ─────────────────────────────────────────

test('noticeActionsFor maps each kind to its recovery actions (single source of truth)', () => {
  const cases: Record<NoticeKind, NoticeAction[]> = {
    'send-timeout': ['retry', 'open-settings'],
    'prepass-timeout': ['retry', 'retry-without-pruning', 'open-settings'],
    'model-start-timeout': ['retry', 'show-logs'],
    'prepass-failed': ['retry', 'retry-without-pruning'],
    'dropped-line': ['retry', 'show-logs'],
    'backend-exit': ['restart-backend', 'show-logs'],
    'provider-disabled': ['open-settings'],
    'operational-error': ['show-logs'],
    'send-failed': ['retry'],
    'edit-failed': [], // re-editing is a separate affordance owned by the inline editor
  };
  for (const kind of Object.keys(cases) as NoticeKind[]) {
    assert.deepEqual(noticeActionsFor(kind), cases[kind], `actions for ${kind}`);
  }
  // edit-failed carries no buttons (the message names the next action in prose).
  assert.deepEqual(noticeActionsFor('edit-failed'), []);
});

test('noticeActionLabel returns a human-readable label for every action', () => {
  const labels: Record<NoticeAction, string> = {
    retry: 'Retry',
    'retry-without-pruning': 'Retry without pruning',
    'show-logs': 'Show logs',
    'open-settings': 'Open settings',
    'restart-backend': 'Restart backend',
  };
  for (const action of Object.keys(labels) as NoticeAction[]) {
    assert.equal(noticeActionLabel(action), labels[action], `label for ${action}`);
  }
});

// ─── Brief H invariant: no req-NN reaches the user across ALL mapped messages ─

test('Brief H invariant: no mapped message leaks an internal req-NN id', () => {
  const reqErrors = [
    'Timed out waiting for response to req-45',
    'Backend sent an unparseable response for req-7: x :: y (stderr tail: z)',
    'Backend exited unexpectedly with code 1.',
    'Timed out waiting for the turn to start streaming (12.5s)',
    'model error for req-99',
    'Request req-12 was cancelled.',
    'unknown req-1 internal',
    'Provider "anthropic" concurrency cap reached: waited 30000ms without a slot.',
  ];
  for (const err of reqErrors) {
    for (const opKind of ['send', 'edit'] as const) {
      const pre = mapSendOrEditError(err, opKind);
      if (pre) assert.ok(!pre.message.includes('req-'), `pre-ack ${opKind} leaked req-NN: ${pre.message} (from "${err}")`);
      const post = mapPreflightError(err, opKind);
      assert.ok(!post.message.includes('req-'), `post-ack ${opKind} leaked req-NN: ${post.message} (from "${err}")`);
    }
  }
});
