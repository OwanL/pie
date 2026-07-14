import '../../helpers/vscode-stub';

import assert from 'node:assert/strict';
import test from 'node:test';

import { onCustomMessage } from '../../../src/host/session-service/handlers/session';
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
