import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKPOINT_MIGRATIONS,
  MIGRATION_FAILED,
  migrateCheckpoint,
  type CheckpointMigration,
} from '../../../src/host/shared/checkpoint-migrations';
import { parseCheckpoint } from '../../../src/host/shared/checkpoint-io';
import { RUN_ANALYTICS_SCHEMA_VERSION } from '../../../src/host/run-analytics/types';

test('the real CHECKPOINT_MIGRATIONS registry is empty for v1', () => {
  assert.equal(CHECKPOINT_MIGRATIONS.length, 0);
});

test('migrateCheckpoint refuses a same-version no-op', () => {
  assert.equal(migrateCheckpoint({ schemaVersion: 1 }, 1, 1), MIGRATION_FAILED);
});

test('migrateCheckpoint refuses a downgrade (newer than target)', () => {
  assert.equal(migrateCheckpoint({ schemaVersion: 3 }, 3, 1), MIGRATION_FAILED);
});

test('migrateCheckpoint walks a synthetic contiguous chain v0 -> v1 -> v2', () => {
  const registry: CheckpointMigration[] = [
    {
      from: 0,
      to: 1,
      up: (raw) => ({ ...(raw as object), schemaVersion: 1, addedV1: true }),
    },
    {
      from: 1,
      to: 2,
      up: (raw) => ({ ...(raw as object), schemaVersion: 2, addedV2: true }),
    },
  ];
  const out = migrateCheckpoint({ schemaVersion: 0, base: 'x' }, 0, 2, registry);
  assert.deepEqual(out, { schemaVersion: 2, base: 'x', addedV1: true, addedV2: true });
});

test('migrateCheckpoint returns MIGRATION_FAILED when a step is missing (no silent mis-migrate)', () => {
  // Only have 0->1; asking for 0->2 requires a missing 1->2 step.
  const registry: CheckpointMigration[] = [
    { from: 0, to: 1, up: (raw) => ({ ...(raw as object), schemaVersion: 1 }) },
  ];
  assert.equal(migrateCheckpoint({ schemaVersion: 0 }, 0, 2, registry), MIGRATION_FAILED);
});

test('migrateCheckpoint returns MIGRATION_FAILED when a step is non-sequential', () => {
  // Gap: jumps 1 -> 3 instead of 1 -> 2.
  const registry: CheckpointMigration[] = [
    { from: 0, to: 1, up: (raw) => ({ ...(raw as object), schemaVersion: 1 }) },
    { from: 1, to: 3, up: (raw) => ({ ...(raw as object), schemaVersion: 3 }) },
  ];
  assert.equal(migrateCheckpoint({ schemaVersion: 0 }, 0, 3, registry), MIGRATION_FAILED);
});

test('migrateCheckpoint returns MIGRATION_FAILED when a duplicate `from` exists', () => {
  const registry: CheckpointMigration[] = [
    { from: 0, to: 1, up: (raw) => ({ ...(raw as object), schemaVersion: 1 }) },
    { from: 0, to: 1, up: (raw) => ({ ...(raw as object), schemaVersion: 1 }) },
  ];
  assert.equal(migrateCheckpoint({ schemaVersion: 0 }, 0, 1, registry), MIGRATION_FAILED);
});

test('migrateCheckpoint returns MIGRATION_FAILED when an up step throws', () => {
  const registry: CheckpointMigration[] = [
    { from: 0, to: 1, up: () => { throw new Error('boom'); } },
  ];
  assert.equal(migrateCheckpoint({ schemaVersion: 0 }, 0, 1, registry), MIGRATION_FAILED);
});

test('parseCheckpoint: v1 data round-trips unchanged (zero behavior change for v1)', () => {
  const checkpoint = parseCheckpoint(JSON.stringify({
    schemaVersion: 1,
    seq: 5,
    sessions: {
      '/repo/session.jsonl': {
        currentRun: null,
        lastRun: null,
        nextTaskIntent: 'continue_task',
        queuedUnsupportedInputCount: 3,
        busyStartedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }));
  assert.equal(checkpoint?.schemaVersion, RUN_ANALYTICS_SCHEMA_VERSION);
  assert.equal(checkpoint?.seq, 5);
  assert.equal(checkpoint?.sessions['/repo/session.jsonl']?.nextTaskIntent, 'continue_task');
  assert.equal(checkpoint?.sessions['/repo/session.jsonl']?.queuedUnsupportedInputCount, 3);
});

test('parseCheckpoint: a future/newer schema version returns null (loud drop, not silent)', () => {
  // Capture console.warn to assert the loud-drop path fires (and silence it).
  const originalWarn = console.warn;
  let warned = false;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('newer schema version')) {
      warned = true;
    }
  };
  try {
    const result = parseCheckpoint(JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION + 1,
      seq: 1,
      sessions: {},
    }));
    assert.equal(result, null);
    assert.equal(warned, true, 'parseCheckpoint should console.warn on a newer-than-current version');
  } finally {
    console.warn = originalWarn;
  }
});

test('parseCheckpoint: malformed type fields still return null', () => {
  assert.equal(parseCheckpoint('{not json}'), null);
  assert.equal(parseCheckpoint(JSON.stringify({ schemaVersion: 'bad', seq: 1, sessions: {} })), null);
  assert.equal(parseCheckpoint(JSON.stringify({ schemaVersion: 1, seq: 'bad', sessions: {} })), null);
  assert.equal(parseCheckpoint(JSON.stringify({ schemaVersion: 1, seq: 1, sessions: null })), null);
});