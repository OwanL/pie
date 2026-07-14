import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendError, extractRequestError } from '../../../src/backend/server-io';
import { validateMessageSend } from '../../../src/backend/rpc';

test('extractRequestError surfaces a BackendError code verbatim', () => {
  const details = extractRequestError(new BackendError('STREAMING_BUSY', 'currently streaming'));
  assert.equal(details.code, 'STREAMING_BUSY');
  assert.equal(details.message, 'currently streaming');
});

test('extractRequestError forwards BackendError data when provided', () => {
  const details = extractRequestError(new BackendError('MODEL_UNAVAILABLE', 'nope', { modelId: 'm-1' }));
  assert.equal(details.code, 'MODEL_UNAVAILABLE');
  assert.deepEqual(details.data, { modelId: 'm-1' });
});

test('extractRequestError omits data when the BackendError carries none', () => {
  const details = extractRequestError(new BackendError('STREAMING_BUSY', 'busy'));
  assert.equal('data' in details, false);
});

test('extractRequestError falls back to BACKEND_ERROR for plain Error (backward compat)', () => {
  const details = extractRequestError(new Error('boom'));
  assert.equal(details.code, 'BACKEND_ERROR');
  assert.equal(details.message, 'boom');
});

test('extractRequestError falls back to BACKEND_ERROR for non-Error values', () => {
  const details = extractRequestError('something odd');
  assert.equal(details.code, 'BACKEND_ERROR');
  assert.equal(details.message, 'something odd');
});

test('BackendError is still an Error with a stable name', () => {
  const err = new BackendError('REQUEST_IN_PROGRESS', 'busy');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'BackendError');
  assert.equal(err.code, 'REQUEST_IN_PROGRESS');
});

test('rpc fail() produces a BackendError with INVALID_PARAMS code', () => {
  // validateMessageSend delegates to fail() on missing sessionPath.
  try {
    validateMessageSend({ text: 'hello' });
    assert.fail('expected validateMessageSend to throw');
  } catch (error) {
    assert.ok(error instanceof BackendError, 'should be a BackendError');
    assert.equal((error as BackendError).code, 'INVALID_PARAMS');
    assert.match((error as Error).message, /Invalid params for message\.send/);
  }
});