import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWebviewToHostMessage } from '../../../src/shared/protocol-validation';

test('accepts a bounded session-title settings patch', () => {
  const result = validateWebviewToHostMessage({
    type: 'setSessionTitlesSettings',
    settings: { enabled: false, provider: 'ollama', model: 'qwen3.5:4b', thinkingLevel: 'low', timeoutSec: 30 },
  });
  assert.equal(result.ok, true);
});

test('rejects unknown or malformed session-title settings fields', () => {
  assert.equal(validateWebviewToHostMessage({
    type: 'setSessionTitlesSettings',
    settings: { enabled: 'yes' },
  }).ok, false);
  assert.equal(validateWebviewToHostMessage({
    type: 'setSessionTitlesSettings',
    settings: { timeoutMs: 10 },
  }).ok, false);
  assert.equal(validateWebviewToHostMessage({
    type: 'setSessionTitlesSettings',
    settings: { timeoutSec: 61 },
  }).ok, false);
});
