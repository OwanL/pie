import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWebviewToHostMessage } from '../protocol-validation';
import { validateBrowserToHostMessage as validateBrowser } from '../browser-ingress';
const validateBrowserToHostMessage = (value: unknown) => validateBrowser(value, Buffer.byteLength(JSON.stringify(value)));

const command = { type: 'performImageAction', requestId: 'image:1', action: 'copy', source: { kind: 'inline', base64: 'aGVsbG8=', mimeType: 'image/png' } };
const clientCommandId = '01234567-89ab-4cde-f012-3456789abcde';

test('image action protocol accepts all actions and file context', () => {
  for (const action of ['copy', 'openInBrowser', 'reveal']) {
    assert.equal(validateWebviewToHostMessage({ ...command, action }).ok, true);
    assert.equal(validateBrowserToHostMessage({ ...command, action, clientCommandId }).ok, true);
  }
  assert.equal(validateBrowserToHostMessage({ ...command, clientCommandId, source: { kind: 'file', path: '/a.png', reference: 'a.png', workingDirectory: '/workspace' } }).ok, true);
});

test('browser image actions permit bounded large inline data but reject oversized payloads', () => {
  const source = { kind: 'inline', mimeType: 'image/png', base64: Buffer.alloc(2 * 1024 * 1024).toString('base64') };
  assert.equal(validateBrowserToHostMessage({ ...command, clientCommandId, source }).ok, true);
  source.base64 = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
  assert.equal(validateBrowserToHostMessage({ ...command, clientCommandId, source }).ok, false);
});

test('image action protocol rejects malformed and unsupported payloads', () => {
  for (const override of [
    { requestId: '' }, { action: 'delete' }, { source: null },
    { source: { kind: 'file', path: '' } },
    { source: { kind: 'file', path: '/a', reference: 1 } },
    { source: { kind: 'inline', base64: 'x', mimeType: 'image/png' } },
    { source: { kind: 'inline', base64: 'aGVsbG8=', mimeType: 'image/svg+xml' } },
  ]) {
    assert.equal(validateWebviewToHostMessage({ ...command, ...override }).ok, false);
    assert.equal(validateBrowserToHostMessage({ ...command, ...override, clientCommandId }).ok, false);
  }
  assert.equal(validateBrowserToHostMessage({ ...command, clientCommandId, source: { ...command.source, extra: true } }).ok, false);
  assert.equal(validateBrowserToHostMessage({ ...command, clientCommandId, extra: true }).ok, false);
});
