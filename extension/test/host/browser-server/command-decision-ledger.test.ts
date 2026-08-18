/**
 * Browser command decision ledger + gate tests (browser server plan §5.2):
 * exactly-one host decision/ack, duplicate-ID handling, and read-only status
 * reconciliation — never replay.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserCommandGate,
  canonicalCommandFingerprint,
} from '../../../src/host/browser-server/command-decision-ledger';
import type { RendererCommandContext, WebviewToHostMessage } from '../../../src/shared/protocol';

const CONTEXT: RendererCommandContext = {
  rendererId: 'renderer-1',
  kind: 'browser',
  rendererGeneration: 1,
};

function command(overrides: Partial<Extract<WebviewToHostMessage, { type: 'send' }>> = {}): WebviewToHostMessage {
  return {
    type: 'send',
    sessionPath: '/session/a',
    text: 'hello',
    localId: 'local-1',
    clientCommandId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

interface Harness {
  gate: BrowserCommandGate;
  routed: Array<{ msg: WebviewToHostMessage; context: RendererCommandContext }>;
  acks: Array<Record<string, unknown>>;
  closed: Array<{ rendererId: string; reason: string }>;
  rejectNext: { type: string; reason: string } | null;
}

function createHarness(): Harness {
  const routed: Array<{ msg: WebviewToHostMessage; context: RendererCommandContext }> = [];
  const acks: Array<Record<string, unknown>> = [];
  const closed: Array<{ rendererId: string; reason: string }> = [];
  const harness: Harness = {
    gate: null as unknown as BrowserCommandGate,
    routed,
    acks,
    closed,
    rejectNext: null,
  };
  harness.gate = new BrowserCommandGate({
    routeMessage: async (msg, context) => {
      routed.push({ msg, context });
      if (harness.rejectNext) {
        const rejection = harness.rejectNext;
        harness.rejectNext = null;
        context.onBrowserCommandRejected?.(rejection.type, rejection.reason);
      }
    },
    postToRenderer: (rendererId, message) => {
      acks.push({ rendererId, ...(message as Record<string, unknown>) });
    },
    closeRenderer: (rendererId, reason) => closed.push({ rendererId, reason }),
    now: () => 1_000,
  });
  return harness;
}

test('a schema-valid application command routes once and emits exactly one ack', async () => {
  const { gate, routed, acks } = createHarness();
  await gate.route(command(), CONTEXT);

  assert.equal(routed.length, 1);
  assert.equal(acks.length, 1);
  assert.equal(acks[0]?.type, 'commandAck');
  assert.equal(acks[0]?.decision, 'accepted');
  assert.equal(acks[0]?.clientCommandId, '11111111-1111-4111-8111-111111111111');
});

test('a command-level rejection records a rejected decision with the typed reason', async () => {
  const { gate, acks } = createHarness();
  const harness = createHarness();
  harness.rejectNext = { type: 'send', reason: 'session-not-open' };
  await harness.gate.route(command(), CONTEXT);

  assert.equal(harness.acks.length, 1);
  assert.equal(harness.acks[0]?.decision, 'rejected');
  assert.equal(harness.acks[0]?.reason, 'session-not-open');
});

test('duplicate clientCommandId with the same fingerprint: never re-run, never a second ack', async () => {
  const { gate, routed, acks } = createHarness();
  await gate.route(command(), CONTEXT);
  await gate.route(command(), CONTEXT);

  assert.equal(routed.length, 1, 'the duplicate is never routed again');
  assert.equal(acks.length, 1, 'no second ack emission');
});

test('duplicate clientCommandId with a different payload is a typed protocol violation: socket closed, no ack', async () => {
  const { gate, routed, acks, closed } = createHarness();
  await gate.route(command(), CONTEXT);
  await gate.route(command({ text: 'different payload' }), CONTEXT);

  assert.equal(routed.length, 1);
  assert.equal(acks.length, 1);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.rendererId, 'renderer-1');
  assert.equal(closed[0]?.reason, 'duplicate-client-command-id-with-different-payload');
});

test('commandStatusRequest is answered from the ledger, read-only', async () => {
  const { gate, routed, acks } = createHarness();
  await gate.route(command(), CONTEXT);
  routed.length = 0;

  await gate.route({ type: 'commandStatusRequest', clientCommandId: '11111111-1111-4111-8111-111111111111' }, CONTEXT);
  assert.equal(routed.length, 0, 'status queries never re-enter routing');
  assert.equal(acks.length, 2);
  assert.equal(acks[1]?.type, 'commandStatus');
  assert.equal(acks[1]?.decision, 'accepted');

  await gate.route({ type: 'commandStatusRequest', clientCommandId: '22222222-2222-4222-8222-222222222222' }, CONTEXT);
  assert.equal(acks[2]?.type, 'commandStatus');
  assert.equal(acks[2]?.decision, 'unknown');
});

test('non-command messages pass straight through without ack or ledger entry', async () => {
  const { gate, routed, acks } = createHarness();
  await gate.route({ type: 'refreshState' }, CONTEXT);
  await gate.route({ type: 'rendererVisibilityChanged', visible: true }, CONTEXT);

  assert.equal(routed.length, 2);
  assert.equal(acks.length, 0);
});

test('inlineConfirmResponse resolves through the confirmation hook, never routing', async () => {
  const { gate, routed, acks } = createHarness();
  const responses: Array<{ rendererId: string; confirmId: string; confirmed: boolean }> = [];
  const gate2 = new BrowserCommandGate({
    routeMessage: async () => undefined,
    postToRenderer: () => undefined,
    closeRenderer: () => undefined,
    onInlineConfirmResponse: (rendererId, confirmId, confirmed) => responses.push({ rendererId, confirmId, confirmed }),
  });
  await gate2.route({ type: 'inlineConfirmResponse', confirmId: 'confirm-1', confirmed: true }, CONTEXT);

  assert.equal(routed.length, 0);
  assert.equal(acks.length, 0);
  assert.deepEqual(responses, [{ rendererId: 'renderer-1', confirmId: 'confirm-1', confirmed: true }]);
});

test('a concurrent duplicate within the routing window is never re-run (pending fence)', async () => {
  const { routed, acks } = createHarness();
  const closed: Array<{ rendererId: string; reason: string }> = [];
  // Hold the first routing open so the duplicate arrives while it is in flight.
  let releaseRouting: () => void = () => undefined;
  const gate2 = new BrowserCommandGate({
    routeMessage: async (msg, context) => {
      routed.push({ msg, context });
      await new Promise<void>((resolve) => {
        releaseRouting = resolve;
      });
    },
    postToRenderer: (rendererId, message) => {
      acks.push({ rendererId, ...(message as Record<string, unknown>) });
    },
    closeRenderer: (rendererId, reason) => closed.push({ rendererId, reason }),
    now: () => 1_000,
  });

  const first = gate2.route(command(), CONTEXT);
  const duplicate = gate2.route(command(), CONTEXT);
  await Promise.resolve();
  releaseRouting();
  await Promise.all([first, duplicate]);

  assert.equal(routed.length, 1, 'the concurrent duplicate is never routed');
  assert.equal(acks.length, 1, 'exactly one ack');
  assert.equal(acks[0]?.decision, 'accepted');
  assert.equal(closed.length, 0, 'a same-payload concurrent duplicate is not a violation');
});

test('canonical fingerprint is stable and excludes clientCommandId/viewGeneration', () => {
  const a = command();
  const b = command({ clientCommandId: '99999999-9999-4999-8999-999999999999' });
  const c = command({ viewGeneration: 7 });
  const d = command({ text: 'different' });

  assert.equal(canonicalCommandFingerprint(a), canonicalCommandFingerprint(b));
  assert.equal(canonicalCommandFingerprint(a), canonicalCommandFingerprint(c));
  assert.notEqual(canonicalCommandFingerprint(a), canonicalCommandFingerprint(d));
});

test('the ledger is bounded: capacity evicts oldest entries', async () => {
  const { gate, acks } = createHarness();
  for (let index = 0; index < 300; index += 1) {
    await gate.route(command({
      clientCommandId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      text: `message ${index}`,
    }), CONTEXT);
  }
  // The first command's decision was evicted: its status is now unknown.
  await gate.route({ type: 'commandStatusRequest', clientCommandId: '11111111-1111-4111-8111-111111111111' }, CONTEXT);
  const status = acks[acks.length - 1];
  assert.equal(status?.type, 'commandStatus');
  assert.equal(status?.decision, 'unknown');
});
