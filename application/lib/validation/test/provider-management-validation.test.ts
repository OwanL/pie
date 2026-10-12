import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWebviewToHostMessage } from '../protocol-validation.js';
import { validateBrowserToHostMessage } from '../browser-ingress.js';
const clientCommandId = '11111111-1111-4111-8111-111111111111';
test('provider commands accept only exact bounded nested fields in both ingress validators', () => {
  for (const command of [{ type: 'open' }, { type: 'choose', kind: 'custom' }, { type: 'change', field: 'baseUrl', value: 'https://example.test/v1' }, { type: 'model-preference', id: 'model', field: 'visible', value: 'no' }]) {
    const message = { type: 'providerManagementCommand', command, clientCommandId, viewGeneration: 1 };
    assert.equal(validateWebviewToHostMessage(message).ok, true);
    assert.equal(validateBrowserToHostMessage(message, 512).ok, true);
    assert.equal(validateWebviewToHostMessage({ ...message, command: { ...command, apiKey: 'PRIVATE' } }).ok, false);
    assert.equal(validateBrowserToHostMessage({ ...message, command: { ...command, apiKey: 'PRIVATE' } }, 512).ok, false);
  }
  for (const command of [{ type: 'change', field: 'apiKey', value: 'PRIVATE' }, { type: 'change', field: 'id', value: 'x'.repeat(4097) }, { type: 'enabled', value: 'yes' }, { type: 'save', draft: {} }, { type: 'choose', kind: 'unknown' }, { type: 'constructor' }]) {
    assert.equal(validateWebviewToHostMessage({ type: 'providerManagementCommand', command }).ok, false);
  }
});
test('private ingress rejects extra fields, wrong method, overlong keys/codes with safe fixed reasons', () => {
  const connect = { type: 'providerManagementConnect', method: 'api-key', apiKey: 'PRIVATE', clientCommandId, viewGeneration: 2 };
  const auth = { type: 'providerManagementAuthResponse', operationId: 'auth', promptId: 'prompt', value: 'PRIVATE', clientCommandId, viewGeneration: 2 };
  for (const message of [connect, auth]) {
    assert.equal(validateWebviewToHostMessage(message).ok, true);
    assert.equal(validateBrowserToHostMessage(message, 512).ok, true);
    const result = validateWebviewToHostMessage({ ...message, extra: 'PRIVATE' });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.equal(validateBrowserToHostMessage({ ...message, extra: 'PRIVATE' }, 512).ok, false);
  }
  assert.equal(validateWebviewToHostMessage({ ...connect, method: 'signin' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ ...connect, apiKey: 'x'.repeat(16385) }).ok, false);
  assert.equal(validateWebviewToHostMessage({ ...auth, value: 'x'.repeat(16385) }).ok, false);
  assert.equal(validateBrowserToHostMessage({ ...connect, viewGeneration: -1 }, 512).ok, false);
});
