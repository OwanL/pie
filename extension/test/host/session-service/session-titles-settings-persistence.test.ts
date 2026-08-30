import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPersistedSessionTitlesSettings,
  saveSessionTitlesSettings,
  type SessionTitlesSettingsStorage,
} from '../../../src/host/session-service/session-titles-settings-persistence';
import {
  DEFAULT_SESSION_TITLES_SETTINGS,
  mergeSessionTitlesSettings,
  type SessionTitlesSettings,
} from '../../../src/shared/protocol';

function storageWith(initial?: SessionTitlesSettings): SessionTitlesSettingsStorage {
  let value = initial;
  return {
    get: () => value,
    update: (next) => { value = next; },
  };
}

test('session-title settings merge preserves untouched model identity', () => {
  assert.deepEqual(
    mergeSessionTitlesSettings(DEFAULT_SESSION_TITLES_SETTINGS, { enabled: false }),
    { ...DEFAULT_SESSION_TITLES_SETTINGS, enabled: false },
  );
});

test('loads session-title settings from host storage when settings.json is unavailable', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const stored = { enabled: false, provider: 'local', model: 'tiny-title', thinkingLevel: 'low' as const, timeoutSec: 30 };
    const values: SessionTitlesSettings[] = [];
    await loadPersistedSessionTitlesSettings(storageWith(stored), (value) => values.push(value));
    assert.deepEqual(values, [stored]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('saves session-title settings to host storage as a fail-soft fallback', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const storage = storageWith();
    const values: SessionTitlesSettings[] = [];
    await saveSessionTitlesSettings(
      storage,
      (value) => values.push(value),
      () => DEFAULT_SESSION_TITLES_SETTINGS,
      { provider: 'ollama', model: 'qwen3.5:4b' },
      () => undefined,
    );
    const expected = { ...DEFAULT_SESSION_TITLES_SETTINGS, provider: 'ollama', model: 'qwen3.5:4b' };
    assert.deepEqual(storage.get(), expected);
    assert.deepEqual(values, [expected]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
