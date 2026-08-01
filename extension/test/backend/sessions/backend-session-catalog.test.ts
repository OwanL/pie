import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionCatalog } from '../../../src/backend/session-catalog';
import type { SdkModule } from '../../../src/backend/sdk';
import type { SessionSummary } from '../../../src/shared/protocol';

function summary(pathname: string, name: string, modifiedAt: string): SessionSummary {
  return { path: pathname, name, cwd: '/repo', modifiedAt, messageCount: 1 };
}

function canonicalSdk(calls: Array<string | undefined>): SdkModule {
  return {
    SessionManager: {
      listAll: async (sessionDir?: string) => {
        calls.push(sessionDir);
        return sessionDir ? [{
          path: path.join(sessionDir, 'canonical.jsonl'),
          cwd: '/repo',
          name: 'Canonical',
          modified: new Date('2026-01-01T00:00:00.000Z'),
          messageCount: 1,
        }] : [];
      },
    },
  } as Pick<SdkModule, 'SessionManager'> as SdkModule;
}

test('SessionCatalog scans once and overlays live session metadata', async () => {
  const configuredDir = path.resolve('/configured/sessions');
  const canonicalPath = path.join(configuredDir, 'canonical.jsonl');
  const calls: Array<string | undefined> = [];
  const sdk = {
    SessionManager: {
      listAll: async (sessionDir?: string) => {
        calls.push(sessionDir);
        return [{
          path: canonicalPath,
          cwd: '/repo',
          name: 'Canonical',
          modified: new Date('2026-01-01T00:00:00.000Z'),
          messageCount: 1,
        }];
      },
    },
  } as Pick<SdkModule, 'SessionManager'> as SdkModule;
  const catalog = new SessionCatalog();

  assert.equal((await catalog.list(sdk, configuredDir)).length, 1);
  const livePath = process.platform === 'win32' ? canonicalPath.toUpperCase() : canonicalPath;
  const live = summary(livePath, 'Live canonical', '2026-01-02T00:00:00.000Z');
  const second = await catalog.list(sdk, configuredDir, [live]);

  assert.deepEqual(calls, [configuredDir]);
  assert.equal(second.length, 1, 'live metadata replaces the discovered path instead of duplicating it');
  assert.equal(second[0]?.name, 'Live canonical');
  assert.equal(second.filter((item) => item.name === 'Live canonical').length, 1);
});

test('SessionCatalog invalidates only when the visible JSONL inventory changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-catalog-'));
  try {
    const agentDir = path.join(root, 'agent');
    const configuredDir = path.join(root, 'canonical');
    await fs.mkdir(configuredDir, { recursive: true });
    const canonicalPath = path.join(configuredDir, 'canonical.jsonl');
    await fs.writeFile(canonicalPath, '');
    const externalPath = path.join(configuredDir, 'external.jsonl');
    let includeExternal = false;
    const calls: Array<string | undefined> = [];
    const sdk = {
      SessionManager: {
        listAll: async (sessionDir?: string) => {
          calls.push(sessionDir);
          if (sessionDir === undefined) return [];
          const sessions = [{
            path: canonicalPath,
            cwd: '/repo',
            name: 'Canonical',
            modified: new Date('2026-01-01T00:00:00.000Z'),
            messageCount: 1,
          }];
          if (includeExternal) sessions.push({
            path: externalPath,
            cwd: '/repo',
            name: 'External',
            modified: new Date('2026-01-02T00:00:00.000Z'),
            messageCount: 1,
          });
          return sessions;
        },
      },
    } as Pick<SdkModule, 'SessionManager'> as SdkModule;
    const catalog = new SessionCatalog();

    assert.deepEqual(
      (await catalog.list(sdk, configuredDir, [], agentDir)).map((item) => item.name),
      ['Canonical'],
    );
    assert.equal(await catalog.invalidateIfInventoryChanged(agentDir, configuredDir), false);
    assert.deepEqual((await catalog.list(sdk, configuredDir, [], agentDir)).map((item) => item.name), ['Canonical']);
    assert.deepEqual(calls, [configuredDir], 'unchanged inventory remains cache-fast');

    await fs.appendFile(canonicalPath, '{"type":"message"}\n');
    assert.equal(
      await catalog.invalidateIfInventoryChanged(agentDir, configuredDir),
      false,
      'streaming appends do not trigger an expensive full catalog rescan',
    );

    includeExternal = true;
    await fs.writeFile(externalPath, '');
    assert.equal(await catalog.invalidateIfInventoryChanged(agentDir, configuredDir), true);
    assert.deepEqual(
      (await catalog.list(sdk, configuredDir, [], agentDir)).map((item) => item.name),
      ['External', 'Canonical'],
    );
    assert.deepEqual(calls, [configuredDir, configuredDir]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionCatalog preserves its cached discovery when an inventory refresh cannot read a directory', async () => {
  const configuredDir = path.resolve('/configured/sessions');
  const agentDir = path.resolve('/agent');
  const calls: Array<string | undefined> = [];
  let inventoryReads = 0;
  const sdk = canonicalSdk(calls);
  const catalog = new SessionCatalog({
    readInventorySignature: async () => {
      inventoryReads += 1;
      if (inventoryReads === 1) return '["canonical.jsonl"]';
      throw Object.assign(new Error('inventory unavailable'), { code: 'EACCES' });
    },
  });

  assert.equal((await catalog.list(sdk, configuredDir, [], agentDir)).length, 1);
  await assert.rejects(
    catalog.invalidateIfInventoryChanged(agentDir, configuredDir),
    (error: NodeJS.ErrnoException) => error.code === 'EACCES',
  );
  assert.equal((await catalog.list(sdk, configuredDir, [], agentDir)).length, 1);
  assert.deepEqual(calls, [configuredDir], 'failed inventory reads must retain the last complete catalog');
});

test('SessionCatalog discovers through an initial signature failure and forces a refresh after recovery', async () => {
  const configuredDir = path.resolve('/configured/sessions');
  const agentDir = path.resolve('/agent');
  const calls: Array<string | undefined> = [];
  let inventoryReads = 0;
  const sdk = canonicalSdk(calls);
  const catalog = new SessionCatalog({
    readInventorySignature: async () => {
      inventoryReads += 1;
      if (inventoryReads === 1) {
        throw Object.assign(new Error('inventory temporarily unavailable'), { code: 'EBUSY' });
      }
      return '["canonical.jsonl"]';
    },
  });

  assert.equal((await catalog.list(sdk, configuredDir, [], agentDir)).length, 1);
  assert.deepEqual(calls, [configuredDir], 'signature failure must not block discovery');
  assert.equal(
    await catalog.invalidateIfInventoryChanged(agentDir, configuredDir),
    true,
    'the first successful signature after an unknown baseline must force a safe refresh',
  );
  assert.equal((await catalog.list(sdk, configuredDir, [], agentDir)).length, 1);
  assert.deepEqual(calls, [configuredDir, configuredDir]);
});
