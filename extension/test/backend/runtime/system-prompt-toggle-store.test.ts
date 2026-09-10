import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  LEGACY_SESSION_SETTINGS_DIR_ENV,
  SESSION_SETTINGS_DIR_ENV,
  isSystemPromptTogglePersistenceAvailable,
  readSystemPromptToggles,
  readSystemPromptTogglesForSession,
  writeSystemPromptTogglesForSession,
} from '../../../src/backend/session-settings-store';

async function withSidecarDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-system-prompt-toggles-'));
  const previous = process.env[SESSION_SETTINGS_DIR_ENV];
  process.env[SESSION_SETTINGS_DIR_ENV] = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) {
      delete process.env[SESSION_SETTINGS_DIR_ENV];
    } else {
      process.env[SESSION_SETTINGS_DIR_ENV] = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('system-prompt toggle store persists, deduplicates, and removes per-session entries', async () => {
  await withSidecarDir(async (dir) => {
    await writeSystemPromptTogglesForSession('/sessions/one.jsonl', ['harness', 'harness', 'skills']);
    await writeSystemPromptTogglesForSession('/sessions/two.jsonl', ['tools']);

    assert.deepEqual(await readSystemPromptToggles(), {
      '/sessions/one.jsonl': ['harness', 'skills'],
      '/sessions/two.jsonl': ['tools'],
    });
    assert.deepEqual(await readSystemPromptTogglesForSession('/sessions/one.jsonl'), ['harness', 'skills']);

    await writeSystemPromptTogglesForSession('/sessions/one.jsonl', []);
    assert.deepEqual(await readSystemPromptToggles(), {
      '/sessions/two.jsonl': ['tools'],
    });
    assert.equal(
      await fs.readFile(path.join(dir, 'system-prompt-toggles.json'), 'utf8'),
      '{\n  "/sessions/two.jsonl": [\n    "tools"\n  ]\n}\n',
    );
  });
});

test('system-prompt toggle store serializes concurrent read-modify-write updates', async () => {
  await withSidecarDir(async (dir) => {
    await Promise.all([
      writeSystemPromptTogglesForSession('/sessions/one.jsonl', ['harness']),
      writeSystemPromptTogglesForSession('/sessions/two.jsonl', ['skills']),
      writeSystemPromptTogglesForSession('/sessions/three.jsonl', ['tools']),
    ]);

    assert.deepEqual(await readSystemPromptToggles(), {
      '/sessions/one.jsonl': ['harness'],
      '/sessions/two.jsonl': ['skills'],
      '/sessions/three.jsonl': ['tools'],
    });
    assert.deepEqual(
      (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')),
      [],
      'completed atomic writes clean up their temporary files',
    );
  });
});

test('system-prompt toggle store treats missing and malformed sidecars as empty', async () => {
  await withSidecarDir(async (dir) => {
    assert.deepEqual(await readSystemPromptToggles(), {});

    await fs.writeFile(path.join(dir, 'system-prompt-toggles.json'), '{ malformed', 'utf8');
    assert.deepEqual(await readSystemPromptTogglesForSession('/sessions/one.jsonl'), []);
  });
});

test('system-prompt toggles read the legacy review sidecar and scrub it after migration', async () => {
  const currentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-settings-'));
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-legacy-session-settings-'));
  const previousCurrent = process.env[SESSION_SETTINGS_DIR_ENV];
  const previousLegacy = process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
  process.env[SESSION_SETTINGS_DIR_ENV] = currentDir;
  process.env[LEGACY_SESSION_SETTINGS_DIR_ENV] = legacyDir;
  try {
    const sessionPath = '/sessions/legacy.jsonl';
    await fs.writeFile(
      path.join(legacyDir, 'system-prompt-toggles.json'),
      JSON.stringify({ [sessionPath]: ['harness'], '/sessions/other.jsonl': ['tools'] }) + '\n',
      'utf8',
    );
    assert.deepEqual(await readSystemPromptTogglesForSession(sessionPath), ['harness']);

    await writeSystemPromptTogglesForSession(sessionPath, ['skills']);
    assert.deepEqual(await readSystemPromptTogglesForSession(sessionPath), ['skills']);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(currentDir, 'system-prompt-toggles.json'), 'utf8')),
      { [sessionPath]: ['skills'], '/sessions/other.jsonl': ['tools'] },
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(legacyDir, 'system-prompt-toggles.json'), 'utf8')),
      { '/sessions/other.jsonl': ['tools'] },
    );
  } finally {
    if (previousCurrent === undefined) delete process.env[SESSION_SETTINGS_DIR_ENV];
    else process.env[SESSION_SETTINGS_DIR_ENV] = previousCurrent;
    if (previousLegacy === undefined) delete process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
    else process.env[LEGACY_SESSION_SETTINGS_DIR_ENV] = previousLegacy;
    await fs.rm(currentDir, { recursive: true, force: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});

test('system-prompt toggle store exposes when no durable sidecar directory is configured', async () => {
  const previous = process.env[SESSION_SETTINGS_DIR_ENV];
  const previousLegacy = process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
  delete process.env[SESSION_SETTINGS_DIR_ENV];
  delete process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
  try {
    assert.equal(isSystemPromptTogglePersistenceAvailable(), false);
    await writeSystemPromptTogglesForSession('/sessions/one.jsonl', ['harness'], true);
  } finally {
    if (previous !== undefined) process.env[SESSION_SETTINGS_DIR_ENV] = previous;
    if (previousLegacy !== undefined) process.env[LEGACY_SESSION_SETTINGS_DIR_ENV] = previousLegacy;
  }
});
