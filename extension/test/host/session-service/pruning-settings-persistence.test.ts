import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadPersistedPruningSettings,
  savePruningSettings,
  type PruningSettingsStorage,
} from '../../../src/host/session-service/pruning-settings-persistence';
import type { PruningSettings } from '../../../src/shared/protocol';
import { DEFAULT_PRUNING_SETTINGS } from '../../../src/shared/protocol';

function createStorage(initial?: PruningSettings): PruningSettingsStorage {
  let value: PruningSettings | undefined = initial;
  return {
    get: () => value,
    update: (next) => {
      value = next;
    },
  };
}

test('loadPersistedPruningSettings restores persisted settings from storage when PI_CODING_AGENT_DIR is absent', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const stored: PruningSettings = {
      mode: 'off',
      skillCeiling: 1,
      toolCeiling: 2,
      skillAlwaysKeep: ['diagnose'],
      toolAlwaysKeep: ['bash'],
      model: 'custom-model',
      provider: 'custom-provider',
      thinkingLevel: 'high',
      prepassTimeoutSec: 30,
    };
    const dispatched: PruningSettings[] = [];
    const storage = createStorage(stored);

    await loadPersistedPruningSettings(storage, (settings) => dispatched.push(settings));

    assert.deepEqual(dispatched, [stored]);
  } finally {
    if (previous !== undefined) {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});

test('loadPersistedPruningSettings keeps defaults when no persisted source is available', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const dispatched: PruningSettings[] = [];
    const storage = createStorage();

    await loadPersistedPruningSettings(storage, (settings) => dispatched.push(settings));

    assert.deepEqual(dispatched, []);
  } finally {
    if (previous !== undefined) {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});

test('savePruningSettings persists to storage when PI_CODING_AGENT_DIR is absent', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const dispatched: PruningSettings[] = [];
    const errors: string[] = [];
    const storage = createStorage();

    await savePruningSettings(
      storage,
      (settings) => dispatched.push(settings),
      () => DEFAULT_PRUNING_SETTINGS,
      { mode: 'shadow', skillCeiling: 2 },
      (message) => errors.push(message),
    );

    const expected: PruningSettings = {
      ...DEFAULT_PRUNING_SETTINGS,
      mode: 'shadow',
      skillCeiling: 2,
    };
    assert.deepEqual(dispatched, [expected]);
    assert.deepEqual(storage.get(), expected);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Failed to update pruning settings/);
  } finally {
    if (previous !== undefined) {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});

test('loadPersistedPruningSettings reads from settings.json and mirrors to storage when PI_CODING_AGENT_DIR is set', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pie-pruning-load-'));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  try {
    const stored: PruningSettings = {
      ...DEFAULT_PRUNING_SETTINGS,
      mode: 'shadow',
      skillCeiling: 9,
      toolCeiling: 4,
    };
    writeFileSync(
      path.join(tempDir, 'settings.json'),
      JSON.stringify({
        pruning: {
          mode: stored.mode,
          skills: { ceiling: stored.skillCeiling },
          tools: { ceiling: stored.toolCeiling },
        },
      }, null, 2) + '\n',
      'utf8',
    );
    const dispatched: PruningSettings[] = [];
    const storage = createStorage();

    await loadPersistedPruningSettings(storage, (settings) => dispatched.push(settings));

    assert.deepEqual(dispatched, [stored]);
    assert.deepEqual(storage.get(), stored);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    if (previous !== undefined) {
      process.env.PI_CODING_AGENT_DIR = previous;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  }
});

test('savePruningSettings writes to settings.json and mirrors to storage when PI_CODING_AGENT_DIR is set', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pie-pruning-persist-'));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  try {
    writeFileSync(path.join(tempDir, 'settings.json'), '{}\n', 'utf8');
    const dispatched: PruningSettings[] = [];
    const errors: string[] = [];
    const storage = createStorage();

    await savePruningSettings(
      storage,
      (settings) => dispatched.push(settings),
      () => DEFAULT_PRUNING_SETTINGS,
      { mode: 'off', toolCeiling: 7 },
      (message) => errors.push(message),
    );

    const expected: PruningSettings = {
      ...DEFAULT_PRUNING_SETTINGS,
      mode: 'off',
      toolCeiling: 7,
    };
    assert.deepEqual(dispatched, [expected]);
    assert.deepEqual(storage.get(), expected);
    assert.deepEqual(errors, []);

    const written = JSON.parse(readFileSync(path.join(tempDir, 'settings.json'), 'utf8'));
    assert.equal(written.pruning.mode, 'off');
    assert.equal(written.pruning.tools.ceiling, 7);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    if (previous !== undefined) {
      process.env.PI_CODING_AGENT_DIR = previous;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  }
});

test('savePruningSettings persists prepassTimeoutSec to settings.json (set then clear)', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pie-pruning-timeout-'));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  try {
    writeFileSync(path.join(tempDir, 'settings.json'), '{}\n', 'utf8');
    const dispatched: PruningSettings[] = [];
    const storage = createStorage();

    // Set a timeout override.
    await savePruningSettings(
      storage,
      (settings) => dispatched.push(settings),
      () => DEFAULT_PRUNING_SETTINGS,
      { prepassTimeoutSec: 60 },
      () => {},
    );
    assert.equal(dispatched[0]?.prepassTimeoutSec, 60);
    assert.equal(storage.get()?.prepassTimeoutSec, 60);
    let written = JSON.parse(readFileSync(path.join(tempDir, 'settings.json'), 'utf8'));
    assert.equal(written.pruning.prepassTimeoutSec, 60, 'timeout must be written to disk');

    // Clear the override: null is a real value, distinct from omitted.
    await savePruningSettings(
      storage,
      (settings) => dispatched.push(settings),
      () => ({ ...DEFAULT_PRUNING_SETTINGS, prepassTimeoutSec: 60 }),
      { prepassTimeoutSec: null },
      () => {},
    );
    assert.equal(dispatched[1]?.prepassTimeoutSec, null, 'clearing produces null in state');
    assert.equal(storage.get()?.prepassTimeoutSec, null);
    written = JSON.parse(readFileSync(path.join(tempDir, 'settings.json'), 'utf8'));
    assert.equal(written.pruning.prepassTimeoutSec, null, 'null must be written to disk (clear)');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    if (previous !== undefined) {
      process.env.PI_CODING_AGENT_DIR = previous;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  }
});
