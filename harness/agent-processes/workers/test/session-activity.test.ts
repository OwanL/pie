import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIdleSessionCapabilities,
  buildSessionCapabilities,
  hasBillableSessionActivity,
} from '../session-activity';
import type { SessionCapabilityFacts } from '../../lib/rpc/session-capability-facts.js';
import type { SessionContext } from '../../coordinator/server-types.js';

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

test('hot and cold continuation capabilities recognize completed assistant replies', () => {
  const completedReplies = [
    { role: 'assistant', content: [{ type: 'text', text: 'finished normally' }], stopReason: 'stop' },
    { role: 'assistant', content: [{ type: 'text', text: 'truncated at the output limit' }], stopReason: 'length' },
  ];

  for (const reply of completedReplies) {
    assert.equal(buildSessionCapabilities(contextWith({ messages: [reply] })).canContinue, true, 'hot idle runtime');
    assert.equal(buildIdleSessionCapabilities([reply]).canContinue, true, 'cold durable session');
  }
});

test('continuation capability still rejects busy and empty sessions', () => {
  const completedReply = { role: 'assistant', content: [{ type: 'text', text: 'finished normally' }], stopReason: 'stop' };
  const busy = contextWith({ messages: [completedReply], isStreaming: true });
  assert.deepEqual(buildSessionCapabilities(busy), {
    billableActivity: true,
    canContinue: false,
    canInterrupt: true,
    canCompact: false,
  });

  assert.equal(buildSessionCapabilities(contextWith()).canContinue, false, 'empty hot history');
  assert.equal(buildIdleSessionCapabilities([], undefined).canContinue, false, 'empty cold history');
});

test('hot and cold idle sessions continue after errors, dangling tools, and custom tails', () => {
  const tails = [
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider request failed' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'read' }], stopReason: 'toolUse' },
    { role: 'custom', content: 'extension context', customType: 'note' },
    { role: 'compactionSummary', summary: 'earlier conversation' },
  ];
  for (const tail of tails) {
    const messages = [{ role: 'user', content: 'work' }, tail];
    assert.equal(buildSessionCapabilities(contextWith({ messages })).canContinue, true);
    assert.equal(buildIdleSessionCapabilities(messages).canContinue, true);
    assert.equal(buildSessionCapabilities(contextWith({ messages, isStreaming: true })).canContinue, false);
  }
});

test('idle continuation classification uses the supplied complete backend context', () => {
  const completeContext = [
    ...Array.from({ length: 500 }, (_, index) => ({ role: 'assistant', content: `old-${index}`, stopReason: 'stop' })),
    { role: 'user', content: 'delivered but not answered' },
  ];
  assert.equal(buildIdleSessionCapabilities(completeContext).canContinue, true);
});

test('backend capability producers publish only inert facts, never the host operation overlay', () => {
  const capabilities = buildSessionCapabilities(contextWith());
  const facts: SessionCapabilityFacts = capabilities;
  assert.deepEqual(facts, {
    billableActivity: false,
    canContinue: false,
    canInterrupt: false,
    canCompact: true,
  });
  assert.equal('primaryOperation' in capabilities, false);
});
