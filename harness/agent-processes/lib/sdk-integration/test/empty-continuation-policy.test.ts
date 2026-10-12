import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSession, ContinueAfterInterruptionDecision } from '@earendil-works/pi-coding-agent';
import { createSourceSdkPolicyAdapter } from '../source-sdk-policy';

for (const kind of ['empty', 'custom', 'dangling', 'completed'] as const) {
  test(`legacy empty continuation decision: ${kind}`, async () => {
    const tail = kind === 'custom'
      ? { role: 'custom', customType: 'fixture', content: 'context', timestamp: 1 }
      : { role: 'assistant', stopReason: kind === 'dangling' ? 'toolUse' : 'stop',
        content: kind === 'dangling' ? [{ type: 'toolCall', id: 'old-call', name: 'lookup', arguments: {} }]
          : [{ type: 'text', text: 'delivered reply' }], timestamp: 1 };
    const messages = kind === 'empty' ? [] : [tail];
    const branch = kind === 'empty' ? [] : [{ type: 'message', id: 'tail', message: tail }];
    const before = structuredClone(branch);
    let received: ContinueAfterInterruptionDecision | undefined;
    const session = { messages, sessionManager: { getBranch: () => branch },
      async continueAfterInterruption(decision: ContinueAfterInterruptionDecision) { received = decision; },
    } as unknown as AgentSession;
    const adapter = createSourceSdkPolicyAdapter({
      readHistoryCompactionSettings: () => undefined, beforeCompact: () => undefined,
    });
    const created = await adapter.wrapContinuationFactory(async () => ({ session }))({});
    await created.session.continueAfterInterruption();
    if (kind === 'empty') assert.equal(received?.type, 'unsupported');
    else assert.deepEqual(received, kind === 'dangling'
      ? { type: 'continue', omitEntryIds: ['tail'] } : { type: 'continue' });
    assert.deepEqual(branch, before);
    assert.strictEqual(messages.at(-1), kind === 'empty' ? undefined : tail);
  });
}
