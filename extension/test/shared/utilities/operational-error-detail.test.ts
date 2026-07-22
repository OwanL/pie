import assert from 'node:assert/strict';
import test from 'node:test';

import { formatOperationalErrorDetail } from '../../../src/shared/operational-error-detail';

test('operational error detail retains code, backend cause, and request correlation', () => {
  assert.equal(formatOperationalErrorDetail({
    code: 'PROVIDER_SEMANTIC_TIMEOUT',
    message: 'The provider stopped producing semantic response events.',
    detail: [
      'Provider: umans',
      'Model: umans-test',
      'Last provider error: upstream header phase stalled for 30000ms',
    ].join('\n'),
    sessionPath: '/workspace/session.jsonl',
    requestId: 'req-provider-1',
  }), [
    'Code: PROVIDER_SEMANTIC_TIMEOUT',
    'Provider: umans',
    'Model: umans-test',
    'Last provider error: upstream header phase stalled for 30000ms',
    'Request: req-provider-1',
  ].join('\n'));
});

test('operational error detail remains useful without optional backend fields', () => {
  assert.equal(formatOperationalErrorDetail({
    code: 'RETRY_STUCK',
    message: 'The retry did not settle.',
    sessionPath: '/workspace/session.jsonl',
  }), 'Code: RETRY_STUCK');
});
