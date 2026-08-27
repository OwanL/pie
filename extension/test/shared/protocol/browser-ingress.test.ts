/**
 * Fail-closed browser ingress schema tests (browser server plan Milestone 0).
 *
 * Acceptance: the schema rejects unknown fields, wrong types, oversized
 * strings/arrays, base64 outside the allowlisted `imageBlob`/`ComposerInputDraft`
 * paths, over-limit decoded images/full frames, and malformed extension-UI
 * payloads before routing; bounded valid image inputs and other valid messages
 * pass unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_INGRESS_LIMITS,
  validateBrowserToHostMessage,
} from '../../../src/shared/browser-ingress';
import { compactDurableMessageDetails } from '../../../src/shared/lazy-details';
import type { WebviewToHostMessage } from '../../../src/shared/protocol';

const UUID = '01234567-89ab-4cde-f012-3456789abcde';

function base64OfBytes(byteLength: number): string {
  return Buffer.alloc(byteLength, 7).toString('base64');
}

function validImageBlob(rawBytes: number) {
  return {
    kind: 'imageBlob',
    mimeType: 'image/png',
    name: 'paste.png',
    sizeBytes: rawBytes,
    dataBase64: base64OfBytes(rawBytes),
    source: 'paste',
  };
}

function validSend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'send',
    sessionPath: '/sessions/a',
    text: 'hello',
    clientCommandId: UUID,
    ...overrides,
  };
}

function expectOk(value: unknown, frameBytes = 1024): void {
  const result = validateBrowserToHostMessage(value, frameBytes);
  assert.equal(result.ok, true, `expected valid: ${result.ok ? '' : result.reason}`);
}

function expectRejected(value: unknown, frameBytes = 1024): void {
  const result = validateBrowserToHostMessage(value, frameBytes);
  assert.equal(result.ok, false, 'expected rejection');
}

// ─── Valid messages pass unchanged ───────────────────────────────────────────

test('valid application commands pass with a clientCommandId', () => {
  expectOk(validSend());
  expectOk({ type: 'interrupt', sessionPath: '/sessions/a', clientCommandId: UUID });
  expectOk({ type: 'setModel', sessionPath: '/sessions/a', defaultModel: 'm', defaultThinkingLevel: 'high', clientCommandId: UUID });
  expectOk({ type: 'newSession', clientCommandId: UUID });
  expectOk({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: { id: 'req-1', confirmed: true }, clientCommandId: UUID });
  expectOk({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: { id: 'req-1', value: 'text', cancelled: false }, clientCommandId: UUID });
  expectOk({ type: 'setPrefs', prefs: { uiDensity: 'compact' }, clientCommandId: UUID });
  expectOk({ type: 'detail.subscribe', viewGeneration: 3, detailKey: 'card-1', detailAttempt: 1, address: {
    sessionPath: '/sessions/a', turnId: 'turn-1', rootToolCallId: 'tool-1', rootAttemptId: 'attempt-1',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
  }, clientCommandId: UUID });
  expectOk({ type: 'retrySend', sessionPath: '/sessions/a', text: 'draft', localId: 'local-1', disablePruning: true, clientCommandId: UUID });
});

test('producer-generated reasoning and subagent detail refs pass browser ingress', () => {
  const sessionPath = '/sessions/a';
  const reasoningMessage = compactDurableMessageDetails({
    id: 'reasoning-message',
    role: 'assistant',
    createdAt: '2026-08-27T00:00:00.000Z',
    status: 'completed',
    markdown: '',
    parts: [{ kind: 'reasoning', text: 'reasoning line\n'.repeat(2_000) }],
  }, sessionPath);
  const reasoningPart = reasoningMessage.parts?.[0];
  assert.ok(reasoningPart?.kind === 'reasoning' && reasoningPart.detailRef);
  assert.equal(typeof reasoningPart.detailRef.lineCount, 'number', 'fixture exercises producer lineCount metadata');

  const subagentMessage = compactDurableMessageDetails({
    id: 'subagent-message',
    role: 'assistant',
    createdAt: '2026-08-27T00:00:01.000Z',
    status: 'completed',
    markdown: '',
    parts: [{
      kind: 'toolCall',
      toolCall: {
        id: 'subagent-tool',
        name: 'subagent',
        input: {},
        status: 'completed',
        result: {
          details: {
            results: [{
              agent: 'worker',
              task: 'inspect',
              exitCode: 0,
              messages: [{ role: 'assistant', content: [{ type: 'text', text: 'detail'.repeat(4_000) }] }],
            }],
          },
        },
      },
    }],
  }, sessionPath);
  const subagentPart = subagentMessage.parts?.[0];
  assert.ok(subagentPart?.kind === 'toolCall' && subagentPart.toolCall.detailRef);
  assert.equal(typeof subagentPart.toolCall.detailRef.childCount, 'number', 'fixture exercises producer childCount metadata');

  for (const ref of [reasoningPart.detailRef, subagentPart.toolCall.detailRef]) {
    // Match the browser WebSocket boundary: JSON serialization removes
    // undefined optional fields before the fail-closed host validator runs.
    const encoded = JSON.stringify({ type: 'requestDetail', sessionPath, ref, clientCommandId: UUID });
    expectOk(JSON.parse(encoded), Buffer.byteLength(encoded, 'utf8'));
  }
});

test('handshake, evidence, lifecycle, and log messages pass without a clientCommandId', () => {
  expectOk({ type: 'ready', assetVersion: 'v1', viewGeneration: 1 });
  expectOk({ type: 'refreshState', assetVersion: 'v1', viewGeneration: 1 });
  expectOk({ type: 'requestSnapshot', assetVersion: 'v1', viewGeneration: 1, sessionPath: '/sessions/a' });
  expectOk({ type: 'stateReceived', payload: { revision: 1, viewGeneration: 1, snapshotBytes: 10 } });
  expectOk({ type: 'appCommitted', payload: { revision: 1, viewGeneration: 1, surface: 'app' } });
  expectOk({ type: 'transcriptCommitted', payload: { revision: 1, viewGeneration: 1, identity: 'id', mountGeneration: 1, evidence: 'displayed' } });
  expectOk({ type: 'transcriptCommitBlocked', payload: { revision: 1, viewGeneration: 1, reason: 'leaf_missing' } });
  expectOk({ type: 'paintObserved', payload: { revision: 1, viewGeneration: 1, identity: 'id', mountGeneration: 1, evidence: 'displayed', latencyMs: 5 } });
  expectOk({ type: 'renderFailure', payload: { viewGeneration: 1, revision: 1, surface: 'transcript', classification: 'component_error' } });
  expectOk({ type: 'rendererVisibilityChanged', visible: true });
  expectOk({ type: 'rendererFocusChanged', focused: false });
  expectOk({ type: 'commandStatusRequest', clientCommandId: UUID });
  expectOk({ type: 'log', level: 'warn', scope: 'host-sync', message: 'note', data: { note: 'x' } });
});

test('bounded valid image inputs pass unchanged', () => {
  const tenMiB = 10 * 1024 * 1024;
  expectOk({ type: 'addComposerInput', sessionPath: '/sessions/a', input: validImageBlob(tenMiB), clientCommandId: UUID }, 32 * 1024 * 1024);
  expectOk({ type: 'addComposerInput', sessionPath: '/sessions/a', input: {
    kind: 'filesystemPathRef', path: '/tmp/a.png', name: 'a.png', source: 'picker',
  }, clientCommandId: UUID });
  // editMessage inputs: two images under the aggregate bound.
  expectOk({
    type: 'editMessage', sessionPath: '/sessions/a', messageId: 'm1', text: 'edit',
    inputs: [validImageBlob(1024), validImageBlob(2048)],
    clientCommandId: UUID,
  }, 32 * 1024 * 1024);
});

// ─── Unknown fields are rejected, not ignored ────────────────────────────────

test('unknown top-level fields are rejected', () => {
  expectRejected({ ...validSend(), extra: 'x' });
  expectRejected({ ...validSend(), dataBase64: base64OfBytes(64) });
  expectRejected({ type: 'ready', assetVersion: 'v1', viewGeneration: 1, clientCommandId: UUID });
});

test('unknown nested fields are rejected', () => {
  expectRejected({ type: 'addComposerInput', sessionPath: '/sessions/a', input: {
    kind: 'filesystemPathRef', path: '/tmp/a.png', name: 'a.png', source: 'picker', dataBase64: base64OfBytes(64),
  }, clientCommandId: UUID });
  expectRejected({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: { id: 'req-1', confirmed: true, extra: 1 }, clientCommandId: UUID });
  expectRejected({ type: 'requestDetail', sessionPath: '/sessions/a', ref: {
    key: 'k', kind: 'tool-result', source: 'durable', sessionPath: '/sessions/a', messageId: 'm',
    summary: 's', available: true, sizeBytes: 1, extra: 'x',
  }, clientCommandId: UUID });
  expectRejected({ type: 'stateReceived', payload: { revision: 1, viewGeneration: 1, snapshotBytes: 10, extra: true } });
});

// ─── Wrong types are rejected ───────────────────────────────────────────────

test('wrong types are rejected', () => {
  expectRejected({ ...validSend(), text: 42 });
  expectRejected({ ...validSend(), sessionPath: null });
  expectRejected({ type: 'interrupt', sessionPath: '/sessions/a', clientCommandId: 7 });
  expectRejected({ type: 'rendererVisibilityChanged', visible: 'yes' });
  expectRejected({ type: 'rendererFocusChanged', focused: 1 });
  expectRejected({ type: 'commandStatusRequest', clientCommandId: 42 });
  expectRejected({ type: 'setPrefs', prefs: 'compact', clientCommandId: UUID });
  expectRejected({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: { id: 'req-1', confirmed: 'yes' }, clientCommandId: UUID });
  expectRejected({ type: 'log', level: 'info', scope: 's', message: 'm' });
  expectRejected({ type: 'send', sessionPath: '/sessions/a', text: 'x', clientCommandId: UUID, viewGeneration: -1 });
});

test('detail ref counts must be non-negative safe integers', () => {
  const ref = {
    key: 'durable:tool:key', kind: 'tool-result', source: 'durable', sessionPath: '/sessions/a',
    messageId: 'message', toolCallId: 'tool', sizeBytes: 100, summary: 'summary', available: true,
  };
  expectOk({ type: 'requestDetail', sessionPath: '/sessions/a', ref: { ...ref, childCount: 0, lineCount: 1 }, clientCommandId: UUID });
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    expectRejected({ type: 'requestDetail', sessionPath: '/sessions/a', ref: { ...ref, childCount: invalid }, clientCommandId: UUID });
    expectRejected({ type: 'requestDetail', sessionPath: '/sessions/a', ref: { ...ref, lineCount: invalid }, clientCommandId: UUID });
  }
});

// ─── Oversized strings and arrays ───────────────────────────────────────────

test('oversized strings are rejected', () => {
  const bigText = 'x'.repeat(BROWSER_INGRESS_LIMITS.maxStringUtf8Bytes + 1);
  expectRejected({ ...validSend(), text: bigText });
  const bigPath = 'p'.repeat(BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes + 1);
  expectRejected({ ...validSend(), sessionPath: bigPath });
  expectRejected({ type: 'openFile', path: bigPath, clientCommandId: UUID });
  expectRejected({ type: 'setComposerDraft', sessionPath: '/sessions/a', text: bigText, clientCommandId: UUID });
});

test('oversized arrays are rejected', () => {
  expectRejected({
    type: 'setSystemPromptToggles', sessionPath: '/sessions/a',
    disabledEntries: Array.from({ length: BROWSER_INGRESS_LIMITS.maxSystemPromptToggles + 1 }, (_, i) => `e${i}`),
    clientCommandId: UUID,
  });
  expectRejected({
    type: 'editMessage', sessionPath: '/sessions/a', messageId: 'm', text: 'x',
    inputs: Array.from({ length: BROWSER_INGRESS_LIMITS.maxComposerInputs + 1 }, () => validImageBlob(1)),
    clientCommandId: UUID,
  });
});

test('excessive nesting depth is rejected', () => {
  let nested: Record<string, unknown> = { leaf: 'x' };
  for (let i = 0; i < BROWSER_INGRESS_LIMITS.maxDepth + 2; i += 1) nested = { nested };
  expectRejected({ type: 'setPrefs', prefs: nested, clientCommandId: UUID });
});

// ─── Base64 policy ──────────────────────────────────────────────────────────

test('drafts reject a client-supplied id; host-owned inputs may carry one', () => {
  expectRejected({
    type: 'addComposerInput', sessionPath: '/sessions/a',
    input: { ...validImageBlob(4), id: 'client-id' },
    clientCommandId: UUID,
  });
  expectOk({
    type: 'editMessage', sessionPath: '/sessions/a', messageId: 'm', text: 'x',
    inputs: [{ ...validImageBlob(4), id: 'host-id' }],
    clientCommandId: UUID,
  });
});

test('post-compression width/height are accepted and bounded', () => {
  expectOk({
    type: 'addComposerInput', sessionPath: '/sessions/a',
    input: { ...validImageBlob(4), width: 1024, height: 768 },
    clientCommandId: UUID,
  });
  expectRejected({
    type: 'addComposerInput', sessionPath: '/sessions/a',
    input: { ...validImageBlob(4), width: -1 },
    clientCommandId: UUID,
  });
  expectRejected({
    type: 'addComposerInput', sessionPath: '/sessions/a',
    input: { ...validImageBlob(4), height: 1.5 },
    clientCommandId: UUID,
  });
  expectRejected({
    type: 'addComposerInput', sessionPath: '/sessions/a',
    input: { ...validImageBlob(4), width: 999999 },
    clientCommandId: UUID,
  });
});

test('dataBase64 smuggled outside the allowlisted image paths is bounded', () => {
  // A multi-megabyte base64 value inside a non-image field trips the generic
  // string bound even though the key is named dataBase64.
  expectRejected({
    type: 'setPrefs',
    prefs: { subagentBuckets: { dataBase64: base64OfBytes(2 * 1024 * 1024) } },
    clientCommandId: UUID,
  });
  expectRejected({
    type: 'extensionUiResponse', sessionPath: '/sessions/a',
    response: { id: 'req-1', value: { dataBase64: base64OfBytes(2 * 1024 * 1024) } },
    clientCommandId: UUID,
  });
});

test('fileBlob variants are rejected before Milestone 4', () => {
  expectRejected({ type: 'addComposerInput', sessionPath: '/sessions/a', input: {
    kind: 'fileBlob', mimeType: 'text/plain', name: 'a.txt', sizeBytes: 4, dataBase64: base64OfBytes(4), source: 'drop',
  }, clientCommandId: UUID });
  expectRejected({
    type: 'editMessage', sessionPath: '/sessions/a', messageId: 'm', text: 'x',
    inputs: [{ kind: 'fileBlob', id: 'i1', mimeType: 'text/plain', name: 'a.txt', sizeBytes: 4, dataBase64: base64OfBytes(4), source: 'drop' }],
    clientCommandId: UUID,
  });
});

test('base64 outside the allowlisted image fields is rejected', () => {
  // A large base64 payload smuggled into a non-image field trips the string bound.
  expectRejected({ type: 'openFile', path: base64OfBytes(2 * 1024 * 1024), clientCommandId: UUID });
  // A dataBase64 key on a filesystemPathRef is an unknown field.
  expectRejected({ type: 'addComposerInput', sessionPath: '/sessions/a', input: {
    kind: 'filesystemPathRef', path: '/tmp/a.png', name: 'a.png', source: 'picker', dataBase64: base64OfBytes(16),
  }, clientCommandId: UUID });
  // Non-strict base64 in an image field is rejected.
  expectRejected({ type: 'addComposerInput', sessionPath: '/sessions/a', input: {
    kind: 'imageBlob', mimeType: 'image/png', name: 'p.png', sizeBytes: 3, dataBase64: 'abc!', source: 'paste',
  }, clientCommandId: UUID });
  // sizeBytes must match the decoded length exactly.
  expectRejected({ type: 'addComposerInput', sessionPath: '/sessions/a', input: {
    kind: 'imageBlob', mimeType: 'image/png', name: 'p.png', sizeBytes: 99, dataBase64: base64OfBytes(3), source: 'paste',
  }, clientCommandId: UUID });
});

// ─── Image and frame bounds ──────────────────────────────────────────────────

test('decoded images above 10 MiB are rejected', () => {
  const over = 10 * 1024 * 1024 + 1;
  expectRejected({ type: 'addComposerInput', sessionPath: '/sessions/a', input: validImageBlob(over), clientCommandId: UUID }, 32 * 1024 * 1024);
});

test('aggregate image bytes above 20 MiB are rejected', () => {
  const tenMiB = 10 * 1024 * 1024;
  expectRejected({
    type: 'editMessage', sessionPath: '/sessions/a', messageId: 'm', text: 'x',
    inputs: [validImageBlob(tenMiB), validImageBlob(tenMiB + 1)],
    clientCommandId: UUID,
  }, 32 * 1024 * 1024);
});

test('full frames above 32 MiB are rejected', () => {
  expectRejected(validSend(), BROWSER_INGRESS_LIMITS.maxFrameBytes + 1);
  expectRejected({ type: 'ready', assetVersion: 'v1', viewGeneration: 1 }, BROWSER_INGRESS_LIMITS.maxFrameBytes + 1);
});

// ─── clientCommandId policy ─────────────────────────────────────────────────

test('application commands require a valid clientCommandId', () => {
  expectRejected({ type: 'send', sessionPath: '/sessions/a', text: 'x' });
  expectRejected({ ...validSend(), clientCommandId: 'not-a-uuid' });
  expectRejected({ ...validSend(), clientCommandId: '01234567-89ab-4cde-f012-3456789abcdef0-extra' });
  expectRejected({ ...validSend(), clientCommandId: '' });
});

test('non-command messages reject a clientCommandId', () => {
  expectRejected({ type: 'ready', assetVersion: 'v1', viewGeneration: 1, clientCommandId: UUID });
  expectRejected({ type: 'log', level: 'warn', scope: 's', message: 'm', clientCommandId: UUID });
  expectRejected({ type: 'rendererVisibilityChanged', visible: true, clientCommandId: UUID });
  // commandStatusRequest carries the id it queries and must satisfy the UUID policy.
  expectRejected({ type: 'commandStatusRequest', clientCommandId: 'not-a-uuid' });
  expectRejected({ type: 'commandStatusRequest' });
  expectOk({ type: 'commandStatusRequest', clientCommandId: UUID });
});

// ─── Non-JSON values ─────────────────────────────────────────────────────────

test('non-JSON values are rejected', () => {
  expectRejected({ ...validSend(), text: undefined });
  expectRejected({ ...validSend(), text: 1n });
  expectRejected({ ...validSend(), text: () => 'x' });
  expectRejected({ ...validSend(), text: Number.NaN });
  expectRejected({ ...validSend(), text: Number.POSITIVE_INFINITY });
  expectRejected({ type: 'setPrefs', prefs: { uiDensity: 'compact', nested: { deep: undefined } }, clientCommandId: UUID });
});

// ─── Malformed extension-UI payloads ────────────────────────────────────────

test('malformed extension-UI payloads are rejected before routing', () => {
  expectRejected({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: {}, clientCommandId: UUID });
  expectRejected({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: { id: '' }, clientCommandId: UUID });
  expectRejected({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: { id: 'req-1', value: 42 }, clientCommandId: UUID });
  expectRejected({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: { id: 'req-1', confirmed: true, cancelled: 'no' }, clientCommandId: UUID });
  expectRejected({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: { id: 'req-1', value: 'x'.repeat(BROWSER_INGRESS_LIMITS.maxStringUtf8Bytes + 1) }, clientCommandId: UUID });
  expectRejected({ type: 'extensionUiResponse', sessionPath: '/sessions/a', response: 'not-an-object', clientCommandId: UUID });
});

// ─── log.data bounds ────────────────────────────────────────────────────────

test('log data is tightly bounded', () => {
  expectRejected({ type: 'log', level: 'warn', scope: 's', message: 'm', data: { big: 'x'.repeat(BROWSER_INGRESS_LIMITS.maxLogDataBytes + 1) } });
  expectRejected({ type: 'log', level: 'warn', scope: 's', message: 'm', data: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17 } });
  expectRejected({ type: 'log', level: 'warn', scope: 's', message: 'm', data: 'string' });
  expectOk({ type: 'log', level: 'warn', scope: 's', message: 'm', data: { note: 'x' } });
});

// ─── frameBytes validation ───────────────────────────────────────────────────

test('invalid frameBytes is rejected', () => {
  expectRejected(validSend(), -1);
  expectRejected(validSend(), 1.5);
  expectRejected(validSend(), Number.NaN);
});
