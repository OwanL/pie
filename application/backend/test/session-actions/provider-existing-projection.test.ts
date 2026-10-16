import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderManagementState, projectProviderManagementView } from '../../provider-management/state';
import { isProviderManagementSnapshot } from '../../../../harness/model-providers/management/validation';

test('host projects existing row origin and inventory errors without converting failure to empty success', () => {
  const state = createProviderManagementState();
  state.snapshot = { ...state.snapshot, revision: 1, loaded: true, providers: [{ id: 'legacy', name: 'Legacy',
    origin: 'existing', readOnly: true, configured: true, enabled: true, modelCount: 3, credentials: 'saved', discovery: 'unsupported' }] };
  assert.equal(isProviderManagementSnapshot(state.snapshot), true);
  assert.deepEqual(projectProviderManagementView(state).providers, state.snapshot.providers);
  state.snapshot.loaded = false;
  state.snapshot.error = 'Existing provider connections could not be loaded.';
  const failed = projectProviderManagementView(state);
  assert.equal(failed.loaded, false);
  assert.equal(failed.message, state.snapshot.error);
  assert.equal(failed.providers[0].readOnly, true);
  assert.equal(isProviderManagementSnapshot({ ...state.snapshot, providers: [{ ...state.snapshot.providers[0], readOnly: false }] }), false);
});
