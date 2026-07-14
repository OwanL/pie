import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalMessageId } from '../../../src/shared/local-message-id';

test('createLocalMessageId creates send ids by default', (t) => {
  t.mock.method(crypto, 'randomUUID', () => 'test-uuid-1');

  assert.equal(createLocalMessageId(), 'local:test-uuid-1');
});

test('createLocalMessageId creates edit ids with the edit prefix', (t) => {
  t.mock.method(crypto, 'randomUUID', () => 'test-uuid-2');

  assert.equal(createLocalMessageId('edit'), 'local:edit:test-uuid-2');
});
