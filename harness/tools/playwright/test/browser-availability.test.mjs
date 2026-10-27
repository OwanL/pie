import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRunBrowserTests } from './browser-availability.mjs';

test('browser tests are eligible by default only with the full browser executable', () => {
  assert.equal(shouldRunBrowserTests({ optIn: false, fullBrowserExecutableExists: true }), true);
  assert.equal(shouldRunBrowserTests({ optIn: false, fullBrowserExecutableExists: false }), false);
});

test('explicit browser-test opt-in allows tests without probing browser availability', () => {
  assert.equal(shouldRunBrowserTests({ optIn: true, fullBrowserExecutableExists: false }), true);
});
