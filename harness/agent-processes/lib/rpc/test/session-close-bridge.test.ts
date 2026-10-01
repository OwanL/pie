import assert from 'node:assert/strict';
import test from 'node:test';

import { isSessionCloseRequestedPayload } from '../event-payload-validation.js';

test('typed session close requests require an explicit self-handoff decision', () => {
  const payload = {
    sessionPath: '/workspace/target.jsonl',
    requestId: 'close-1',
    delete: false,
    selfHandoffRequired: false,
  };
  assert.equal(isSessionCloseRequestedPayload(payload), true);
  assert.equal(isSessionCloseRequestedPayload({ ...payload, selfHandoffRequired: true }), true);
  const legacyPayload: Record<string, unknown> = { ...payload };
  delete legacyPayload.selfHandoffRequired;
  assert.equal(isSessionCloseRequestedPayload(legacyPayload), false);
  assert.equal(isSessionCloseRequestedPayload({ ...payload, selfHandoffRequired: 'yes' }), false);
});
