import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYTICS_REHEARSAL_MODE_ENV,
  TOTAL_DISABLED_REHEARSAL_MODE,
  isFreshLegacyActivationState,
  isTotalAnalyticsDisabled,
  resolveAnalyticsPolicy,
} from '../../src/host/analytics-policy.js';

test('analytics policy defaults to normal and ignores malformed rehearsal values', () => {
  assert.equal(resolveAnalyticsPolicy({}), 'normal');
  assert.equal(resolveAnalyticsPolicy({ [ANALYTICS_REHEARSAL_MODE_ENV]: '' }), 'normal');
  assert.equal(resolveAnalyticsPolicy({ [ANALYTICS_REHEARSAL_MODE_ENV]: 'total-disabled' }), 'normal');
  assert.equal(resolveAnalyticsPolicy({ [ANALYTICS_REHEARSAL_MODE_ENV]: 'TOTAL-DISABLED-V1' }), 'normal');
  assert.equal(isTotalAnalyticsDisabled('normal'), false);
});

test('only the exact process-local rehearsal value selects total-disabled', () => {
  assert.equal(
    resolveAnalyticsPolicy({ [ANALYTICS_REHEARSAL_MODE_ENV]: TOTAL_DISABLED_REHEARSAL_MODE }),
    'total-disabled',
  );
  assert.equal(isTotalAnalyticsDisabled('total-disabled'), true);
});

test('disabled rehearsal accepts only a fresh legacy activation state', () => {
  assert.equal(isFreshLegacyActivationState({ authority: 'legacy', manifest: null, tombstonePresent: false }), true);
  assert.equal(isFreshLegacyActivationState({ authority: 'canonical', manifest: null, tombstonePresent: false }), false);
  assert.equal(isFreshLegacyActivationState({ authority: 'legacy', manifest: {} as never, tombstonePresent: false }), false);
  assert.equal(isFreshLegacyActivationState({ authority: 'legacy', manifest: null, tombstonePresent: true }), false);
});
