import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../../../../src/host/core/dispatch';
import { createInitialArchState } from '../../../../src/host/core/arch-state';

test('dispatch is a pure function — returns { state, effects } with no side effects', () => {
  const state = createInitialArchState();
  const result = dispatch(state, { kind: 'BackendReadyChanged', ready: true });
  assert.ok(result.state, 'returns new state');
  assert.ok(Array.isArray(result.effects), 'returns effects array');
  // Dispatching again with the original state is deterministic (no hidden mutable state)
  const result2 = dispatch(state, { kind: 'BackendReadyChanged', ready: true });
  assert.deepEqual(result.effects, result2.effects, 'deterministic — no hidden state between calls');
});
