import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSessionTitleGenerate } from '../../../src/backend/rpc';

const auxiliary = { thinkingLevel: 'off' as const, timeoutSec: 15 };

test('validates provider-qualified hot session title requests', () => {
  const request = {
    sessionPath: '/sessions/a.jsonl',
    prompt: 'Investigate intermittent login failures.',
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
    ...auxiliary,
  };
  assert.deepEqual(validateSessionTitleGenerate(request), request);
});

test('rejects pending paths, empty prompts, and invalid auxiliary controls', () => {
  assert.throws(() => validateSessionTitleGenerate({
    sessionPath: '__pending__:new', prompt: 'Fix it', provider: 'ollama', model: 'model', ...auxiliary,
  }));
  assert.throws(() => validateSessionTitleGenerate({
    sessionPath: '/sessions/a.jsonl', prompt: ' ', provider: 'ollama', model: 'model', ...auxiliary,
  }));
  assert.throws(() => validateSessionTitleGenerate({
    sessionPath: '/sessions/a.jsonl', prompt: 'Fix it', provider: 'ollama', model: 'model', thinkingLevel: 'huge', timeoutSec: 15,
  }));
  assert.throws(() => validateSessionTitleGenerate({
    sessionPath: '/sessions/a.jsonl', prompt: 'Fix it', provider: 'ollama', model: 'model', thinkingLevel: 'off', timeoutSec: 0,
  }));
});
