import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIdleSessionCapabilities,
  buildSessionCapabilities,
  hasBillableSessionActivity,
} from '../../../src/backend/session-activity';
import type { SessionContext } from '../../../src/backend/server-types';

function contextWith(sessionOverrides: Record<string, unknown> = {}, contextOverrides: Record<string, unknown> = {}): SessionContext {
  return {
    sessionPath: '/workspace/session.jsonl',
    session: {
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
      messages: [],
      agent: { hasQueuedMessages: () => false },
      getPendingBashMessages: () => [],
      ...sessionOverrides,
    },
    busySeq: 0,
    queuedLocalIds: [],
    ...contextOverrides,
  } as unknown as SessionContext;
}

test('one billable-activity predicate covers every exposed SDK and backend window', () => {
  assert.equal(hasBillableSessionActivity(contextWith()), false);

  const activeContexts = [
    contextWith({}, { activeRequest: { id: 'request-1' } }),
    contextWith({}, { manualCompactionRequest: { requestId: 'compact-1', cancelled: false } }),
    contextWith({}, { pendingExtensionCommand: { requestId: 'command-1' } }),
    contextWith({ isStreaming: true }),
    contextWith({ isCompacting: true }),
    contextWith({ isRetrying: true }),
    contextWith({ isBashRunning: true }),
    contextWith({ pendingMessageCount: 1 }),
    contextWith({ hasPendingBashMessages: true }),
  ];

  for (const context of activeContexts) {
    assert.equal(hasBillableSessionActivity(context), true);
    assert.deepEqual(buildSessionCapabilities(context), {
      billableActivity: true,
      canContinue: false,
      canInterrupt: true,
      canCompact: false,
    });
  }
});

test('idle continuation classification uses the supplied complete backend context', () => {
  assert.deepEqual(buildIdleSessionCapabilities([], undefined), {
    billableActivity: false,
    canContinue: false,
    canInterrupt: false,
    canCompact: true,
  });

  const completeContext = [
    ...Array.from({ length: 500 }, (_, index) => ({ role: 'assistant', content: `old-${index}`, stopReason: 'stop' })),
    { role: 'user', content: 'delivered but not answered' },
  ];
  assert.equal(buildIdleSessionCapabilities(completeContext).canContinue, true);
});
