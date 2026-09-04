import '../../helpers/vscode-stub';

import assert from 'node:assert/strict';
import test from 'node:test';

import { onCustomMessage, onExtensionUIRequest } from '../../../src/host/session-service/handlers/session';
import { NOOP_RUN_OBSERVER, type RunObserver } from '../../../src/host/stats-service';
import type { CustomMessagePayload } from '../../../src/shared/protocol';

test('onCustomMessage forwards pruning-result usage details to RunObserver', () => {
  const calls: unknown[][] = [];
  const runObserver: RunObserver = {
    ...NOOP_RUN_OBSERVER,
    onSkillPruningUsage: (...args) => calls.push(args),
  };
  const payload: CustomMessagePayload = {
    requestId: 'req-1',
    sessionPath: '/workspace/session.jsonl',
    message: {
      id: 'pruning-message-1',
      role: 'system',
      createdAt: '2026-07-04T10:00:00.000Z',
      markdown: 'All skills kept',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: {
        prepassModel: 'openai/pruner',
        prepassInputTokens: 100,
        prepassOutputTokens: 20,
      },
    },
  };

  onCustomMessage(payload, {
    context: {} as never,
    getArchState: () => ({} as never),
    dispatchArch: () => undefined,
    runObserver,
    state: { touchSessionTranscript: () => undefined } as never,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName, sessionPath) => sessionPath ?? null,
  });

  assert.deepEqual(calls, [[
    payload.sessionPath,
    payload.message.id,
    payload.message.createdAt,
    payload.message.customDetails,
  ]]);
});

test('onCustomMessage does not forward unrelated custom messages as pruning usage', () => {
  let callCount = 0;
  const runObserver: RunObserver = {
    ...NOOP_RUN_OBSERVER,
    onSkillPruningUsage: () => { callCount += 1; },
  };
  const payload: CustomMessagePayload = {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    message: {
      id: 'other-message',
      role: 'system',
      createdAt: '2026-07-04T10:00:00.000Z',
      markdown: 'Other',
      status: 'completed',
      customType: 'other-extension',
    },
  };

  onCustomMessage(payload, {
    context: {} as never,
    getArchState: () => ({} as never),
    dispatchArch: () => undefined,
    runObserver,
    state: { touchSessionTranscript: () => undefined } as never,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName, sessionPath) => sessionPath ?? null,
  });

  assert.equal(callCount, 0);
});

test('onExtensionUIRequest preserves notify severity instead of routing every notification as an error', () => {
  const events: Array<Record<string, unknown>> = [];
  let renderCount = 0;
  const dispatchArch = (event: unknown): void => {
    events.push(event as Record<string, unknown>);
  };
  const backendErrors: string[] = [];
  const deps = {
    context: {} as never,
    getArchState: () => ({} as never),
    dispatchArch,
    runObserver: {
      ...NOOP_RUN_OBSERVER,
      onBackendError: (_sessionPath: string | undefined, code: string) => backendErrors.push(code),
    },
    state: { claimOperationalIncident: () => true } as never,
    scheduleRender: () => { renderCount += 1; },
    requireEventSessionPath: (_eventName: string, sessionPath: string | undefined) => sessionPath ?? null,
  };

  for (const notifyType of ['info', 'warning', 'error'] as const) {
    onExtensionUIRequest({
      id: `notify-${notifyType}`,
      method: 'notify',
      message: `notification ${notifyType}`,
      notifyType,
      sessionPath: '/workspace/session.jsonl',
    }, deps);
  }

  assert.deepEqual(events.map((event) => ({
    kind: event.kind,
    severity: (event.incident as { severity?: string } | undefined)?.severity,
    message: (event.incident as { message?: string } | undefined)?.message,
  })), [
    { kind: 'IncidentReported', severity: 'info', message: 'Info: notification info' },
    { kind: 'IncidentReported', severity: 'warning', message: 'Warning: notification warning' },
    { kind: 'IncidentReported', severity: 'error', message: 'Error: notification error' },
  ]);
  assert.deepEqual(backendErrors, ['EXTENSION_NOTIFICATION_ERROR']);
  assert.equal(renderCount, 3);
});
