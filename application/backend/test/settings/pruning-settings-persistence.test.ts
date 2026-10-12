import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadPersistedPruningSettings,
  savePruningSettings,
  type PruningSettingsStorage,
} from '../../settings/pruning-settings-persistence';
import type { PruningSettings } from '../../../lib/protocol/index.js';
import { DEFAULT_PRUNING_SETTINGS } from '../../../lib/protocol/index.js';
import { readPruningSettings, writePruningSettings } from '../../settings/pruning-settings';

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
      { mode: 'off', toolCeiling: 7, mainAgentEnabled: false, subagentEnabled: false },
      (message) => errors.push(message),
    );

    const expected: PruningSettings = {
      ...DEFAULT_PRUNING_SETTINGS,
      mode: 'off',
      toolCeiling: 7,
      mainAgentEnabled: false,
      subagentEnabled: false,
    };
    assert.deepEqual(dispatched, [expected]);
    assert.deepEqual(storage.get(), expected);
    assert.deepEqual(errors, []);

    const written = JSON.parse(readFileSync(path.join(tempDir, 'settings.json'), 'utf8'));
    assert.equal(written.pruning.mode, 'off');
    assert.equal(written.pruning.tools.ceiling, 7);
    assert.equal(written.pruning.mainAgentEnabled, false);
    assert.equal(written.pruning.subagentEnabled, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    if (previous !== undefined) {
      process.env.PI_CODING_AGENT_DIR = previous;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  }
});

test('follow-up pruning reads legacy defaults and persists updates without disturbing other fields', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pie-pruning-follow-up-'));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  const settingsPath = path.join(tempDir, 'settings.json');
  const original = {
    unrelated: { enabled: true },
    pruning: {
      mode: 'shadow', model: 'custom-model', provider: 'custom-provider', thinkingLevel: 'high',
      mainAgentEnabled: false, subagentEnabled: true, prepassTimeoutSec: 45,
      prepass: { temperature: 0.2, maxTransportRetries: 3 },
      skills: { ceiling: 9, pinned: ['diagnose'], alwaysKeep: ['develop-pie'] },
      tools: { ceiling: 7, dependencies: { edit: ['read'] }, alwaysKeep: ['bash'] },
      futureField: { keep: 'unchanged' },
    },
  };
  try {
    assert.equal((await readPruningSettings()).refreshAfterCompaction, true);
    for (const refreshAfterCompaction of [undefined, 'true', 1, null, false, true]) {
      writeFileSync(settingsPath, JSON.stringify({ ...original, pruning: { ...original.pruning, refreshAfterCompaction } }));
      assert.equal((await readPruningSettings()).refreshAfterCompaction, refreshAfterCompaction !== false);
    }
    for (const refreshAfterCompaction of [false, true]) {
      writeFileSync(settingsPath, JSON.stringify(original));
      assert.equal((await writePruningSettings({ refreshAfterCompaction })).refreshAfterCompaction, refreshAfterCompaction);
      assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {
        ...original, pruning: { ...original.pruning, refreshAfterCompaction },
      });
      await writePruningSettings({});
      assert.equal((await readPruningSettings()).refreshAfterCompaction, refreshAfterCompaction);
    }
    writeFileSync(settingsPath, JSON.stringify(original));
    assert.equal((await readPruningSettings()).followUpEnabled, false);
    for (const followUpEnabled of [undefined, 'true', 1, null, false, true]) {
      writeFileSync(settingsPath, JSON.stringify({ ...original, pruning: { ...original.pruning, followUpEnabled } }));
      assert.equal((await readPruningSettings()).followUpEnabled, followUpEnabled === true);
    }
    writeFileSync(settingsPath, JSON.stringify(original));
    for (const followUpEnabled of [true, false]) {
      const updated = await writePruningSettings({ followUpEnabled });
      assert.equal(updated.followUpEnabled, followUpEnabled);
      assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {
        ...original, pruning: { ...original.pruning, followUpEnabled },
      });
      await writePruningSettings({});
      assert.equal((await readPruningSettings()).followUpEnabled, followUpEnabled);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
    else delete process.env.PI_CODING_AGENT_DIR;
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
