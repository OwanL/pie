import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readBackendSessionInventorySignature,
  resolveBackendSessionDir,
} from '../../../src/backend/session-directory';
import { getDeferredTriggersDir } from '../../../src/shared/deferred-triggers-paths';
import {
  resolveHostSessionStoragePaths,
  resolveSessionSidecarDirs,
} from '../../../src/shared/session-storage-paths';

test('resolveBackendSessionDir preserves absolute config and resolves relative config from agentDir', () => {
  const agentDir = path.resolve('/agent');
  const absolute = path.resolve('/canonical/sessions');

  assert.equal(resolveBackendSessionDir(agentDir, absolute), absolute);
  assert.equal(
    resolveBackendSessionDir(agentDir, 'data/outcomes/sessions'),
    path.join(agentDir, 'data/outcomes/sessions'),
  );
  assert.equal(resolveBackendSessionDir(agentDir, '   '), undefined);
  assert.equal(resolveBackendSessionDir(agentDir, undefined), undefined);
});

test('relative session and sidecar directories share the same agent-dir authority', () => {
  const agentDir = path.resolve('/agent');
  const sessionDir = resolveBackendSessionDir(agentDir, 'data/outcomes/sessions');

  assert.equal(sessionDir, path.join(agentDir, 'data/outcomes/sessions'));
  assert.deepEqual(resolveSessionSidecarDirs(sessionDir), {
    reviewsDir: path.join(agentDir, 'data/outcomes/session-reviews'),
    triggersDir: path.join(agentDir, 'data/outcomes/deferred-triggers'),
  });
});

test('host deferred-trigger lookup resolves a relative session directory from agentDir', () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = path.resolve('/agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = 'data/outcomes/sessions';
  try {
    assert.equal(
      getDeferredTriggersDir(),
      path.join(agentDir, 'data/outcomes/deferred-triggers'),
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
  }
});

test('host storage authority bases an explicit relative session path on the SDK default agent directory', () => {
  const cwd = path.resolve('/workspace');
  const homeDir = path.resolve('/home');
  const agentDir = path.join(homeDir, '.pi', 'agent');
  const sessionDir = path.join(agentDir, 'custom', 'sessions');

  assert.deepEqual(
    resolveHostSessionStoragePaths(undefined, '  custom/sessions  ', { cwd, homeDir }),
    {
      agentDir,
      sessionDir,
      reviewsDir: path.join(agentDir, 'custom', 'session-reviews'),
      triggersDir: path.join(agentDir, 'custom', 'deferred-triggers'),
    },
  );
});

test('host storage authority resolves a relative agent once before applying the relative default session path', () => {
  const cwd = path.resolve('/workspace');
  const homeDir = path.resolve('/home');
  const agentDir = path.resolve(cwd, 'relative-agent');
  const sessionDir = path.join(agentDir, 'data', 'outcomes', 'sessions');

  assert.deepEqual(
    resolveHostSessionStoragePaths('  relative-agent  ', undefined, { cwd, homeDir }),
    {
      agentDir,
      sessionDir,
      reviewsDir: path.join(agentDir, 'data', 'outcomes', 'session-reviews'),
      triggersDir: path.join(agentDir, 'data', 'outcomes', 'deferred-triggers'),
    },
  );
});

test('host storage authority expands tilde and preserves SDK defaults when no path is configured', () => {
  const cwd = path.resolve('/workspace');
  const homeDir = path.resolve('/home');

  assert.deepEqual(resolveHostSessionStoragePaths(undefined, undefined, { cwd, homeDir }), {});
  assert.equal(
    resolveHostSessionStoragePaths(' ~/custom-agent ', undefined, { cwd, homeDir }).agentDir,
    path.join(homeDir, 'custom-agent'),
  );
  assert.equal(
    resolveHostSessionStoragePaths(undefined, ' ~/custom-sessions ', { cwd, homeDir }).sessionDir,
    path.join(homeDir, 'custom-sessions'),
  );
});

test('session inventory signature covers canonical flat/nested and legacy nested JSONL paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-inventory-'));
  try {
    const agentDir = path.join(root, 'agent');
    const configuredDir = path.join(root, 'canonical');
    const canonicalNested = path.join(configuredDir, '--repo--');
    const legacyNested = path.join(agentDir, 'sessions', '--legacy--');
    await Promise.all([
      fs.mkdir(canonicalNested, { recursive: true }),
      fs.mkdir(legacyNested, { recursive: true }),
    ]);

    const empty = await readBackendSessionInventorySignature(agentDir, configuredDir);
    await fs.writeFile(path.join(configuredDir, 'flat.jsonl'), '');
    const flat = await readBackendSessionInventorySignature(agentDir, configuredDir);
    await fs.writeFile(path.join(canonicalNested, 'nested.jsonl'), '');
    const nested = await readBackendSessionInventorySignature(agentDir, configuredDir);
    await fs.writeFile(path.join(legacyNested, 'legacy.jsonl'), '');
    const legacy = await readBackendSessionInventorySignature(agentDir, configuredDir);

    assert.notEqual(flat, empty);
    assert.notEqual(nested, flat);
    assert.notEqual(legacy, nested);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session inventory treats missing roots as empty but surfaces inaccessible roots', async () => {
  const agentDir = path.resolve('/agent');
  const configuredDir = path.resolve('/configured/sessions');
  const failingRead = (code: string) => async (): Promise<never> => {
    throw Object.assign(new Error(`readdir failed: ${code}`), { code });
  };

  assert.equal(
    await readBackendSessionInventorySignature(agentDir, configuredDir, failingRead('ENOENT')),
    '[]',
  );
  assert.equal(
    await readBackendSessionInventorySignature(agentDir, configuredDir, failingRead('ENOTDIR')),
    '[]',
  );
  await assert.rejects(
    readBackendSessionInventorySignature(agentDir, configuredDir, failingRead('EACCES')),
    (error: NodeJS.ErrnoException) => error.code === 'EACCES',
  );
  await assert.rejects(
    readBackendSessionInventorySignature(agentDir, configuredDir, failingRead('EBUSY')),
    (error: NodeJS.ErrnoException) => error.code === 'EBUSY',
  );
});
