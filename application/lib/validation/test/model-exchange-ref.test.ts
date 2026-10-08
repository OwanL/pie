import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBrowserToHostMessage } from '../browser-ingress';
import { validateWebviewToHostMessage } from '../protocol-validation';
import { modelExchangeRef } from '../../../../harness/session-storage/transcripts/tool-model-exchange';

const ref = modelExchangeRef('/session', { id: 'tool|exact', name: 'display', input: {}, status: 'running' });

test('captured model exchange refs pass browser and protocol validators', () => {
  for (const validate of [(message: unknown) => validateBrowserToHostMessage(message, Buffer.byteLength(JSON.stringify(message))), validateWebviewToHostMessage]) {
    const message = { type: 'requestDetail', clientCommandId: '01234567-89ab-4cde-f012-3456789abcde', sessionPath: '/session', ref };
    assert.deepEqual(validate(message), { ok: true, value: message });
    assert.equal(validate({ ...message, ref: { ...ref, source: 'live' } }).ok, false);
    assert.equal(validate({ ...message, ref: { ...ref, toolCallId: undefined } }).ok, false);
    assert.equal(validate({ ...message, ref: { ...ref, toolCallId: '' } }).ok, false);
    assert.equal(validate({ ...message, ref: { ...ref, sizeBytes: -1 } }).ok, false);
    assert.equal(validate({ ...message, ref: { ...ref, kind: 'made-up' } }).ok, false);
  }
});
