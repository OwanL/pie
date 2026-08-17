import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAvailableExtensions } from '../../../src/host/session-service/available-extensions';
import { deriveBundledExtensions } from '../../../src/shared/bundled-extensions';

test('deriveBundledExtensions provides settings metadata before runtime discovery', () => {
  const extensions = deriveBundledExtensions();
  assert.ok(extensions.some((extension) => extension.id === 'skill-pruner'));
  assert.ok(extensions.some((extension) => extension.id === 'warm-bash'));
});

test('deriveAvailableExtensions shows loaded extensions even when their tools were pruned', () => {
  const extensions = deriveAvailableExtensions([
    'subagent',
    'ask-user',
    'session-reviewer',
    'safeguard',
  ]);

  assert.deepEqual(extensions.map((extension) => extension.id), [
    'subagent',
    'safeguard',
    'ask-user',
    'session-reviewer',
  ]);
});

test('deriveAvailableExtensions includes loaded extensions without hardcoded metadata', () => {
  const extensions = deriveAvailableExtensions(['vendor-new-extension']);

  assert.deepEqual(extensions, [{
    id: 'vendor-new-extension',
    label: 'Vendor New Extension',
    description: 'Loaded pi extension',
  }]);
});
