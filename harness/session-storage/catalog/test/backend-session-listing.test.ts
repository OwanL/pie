import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { listSessions } from '../session-listing';
import type { SdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-metadata-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('listSessions derives placeholder names from the session file and sorts by modified time', async () => {
  await withTempDir(async (dir) => {
    const derivedFile = path.join(dir, 'derived.jsonl');
    const namedFile = path.join(dir, 'named.jsonl');

    await fs.writeFile(derivedFile, [
      '{not json}',
      JSON.stringify({ id: 'entry-1', type: 'message', message: { role: 'user', content: 'Refactor the analytics pipeline now' } }),
    ].join('\n'), 'utf8');
    await fs.writeFile(namedFile, '', 'utf8');

    const sdk = {
      SessionManager: {
        listAll: async () => [
          {
            path: derivedFile,
            cwd: '/repo',
            modified: new Date('2026-01-01T00:00:00.000Z'),
            messageCount: 2,
          },
          {
            path: namedFile,
            cwd: '/repo',
            name: 'Named Session',
            modified: new Date('2026-01-02T00:00:00.000Z'),
            messageCount: 1,
          },
        ],
      },
    } as Pick<SdkModule, 'SessionManager'> as SdkModule;

    const sessions = await listSessions(sdk);

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.name, 'Named Session');
    assert.equal(sessions[0]?.isPlaceholder, false);
    assert.equal(sessions[1]?.name, 'Refactor the analytics pipeline now');
    assert.equal(sessions[1]?.isPlaceholder, true);
  });
});

test('listSessions derives names from SDK metadata without rereading the transcript file', async () => {
  const missingPath = path.resolve('/not-present/session.jsonl');
  const sdk = {
    SessionManager: {
      listAll: async () => [{
        path: missingPath,
        cwd: '/repo',
        modified: new Date('2026-01-01T00:00:00.000Z'),
        messageCount: 1,
        firstMessage: 'Make session switching fast and transparent',
      }],
    },
  } as Pick<SdkModule, 'SessionManager'> as SdkModule;

  const sessions = await listSessions(sdk);

  assert.equal(sessions[0]?.name, 'Make session switching fast and transpa…');
  assert.equal(sessions[0]?.isPlaceholder, true);
});

test('listSessions lists only the configured canonical root and does not scan the SDK legacy default', async () => {
  const configuredDir = path.resolve('/configured/sessions');
  const canonicalPath = path.join(configuredDir, 'canonical.jsonl');
  const legacyPath = path.resolve('/sdk-default/sessions/legacy.jsonl');
  const sdk = {
    SessionManager: {
      listAll: async (sessionDir?: string) => sessionDir === configuredDir
        ? [{
            path: canonicalPath,
            cwd: '/repo',
            name: 'Canonical Session',
            modified: new Date('2026-01-02T00:00:00.000Z'),
            messageCount: 1,
          }]
        : [{
            path: legacyPath,
            cwd: '/repo',
            name: 'Legacy Session',
            modified: new Date('2026-01-01T00:00:00.000Z'),
            messageCount: 1,
          }],
    },
  } as Pick<SdkModule, 'SessionManager'> as SdkModule;

  const sessions = await listSessions(sdk, configuredDir);

  // The legacy SDK-default root is retired once a canonical root is configured;
  // its sessions are migrated by the installer and surfaced by `npm run doctor`.
  assert.deepEqual(sessions.map((session) => session.path), [canonicalPath]);
});

test('listSessions de-duplicates paths using platform filesystem semantics', async () => {
  const configuredDir = path.resolve('/configured/sessions');
  const canonicalPath = path.join(configuredDir, 'canonical.jsonl');
  const duplicatePath = process.platform === 'win32' ? canonicalPath.toUpperCase() : canonicalPath;
  const info = (pathname: string, name: string) => ({
    path: pathname,
    cwd: '/repo',
    name,
    modified: new Date('2026-01-01T00:00:00.000Z'),
    messageCount: 1,
  });
  const sdk = {
    SessionManager: {
      listAll: async (sessionDir?: string) => sessionDir
        ? [info(canonicalPath, 'Canonical'), info(duplicatePath, 'Duplicate')]
        : [],
    },
  } as Pick<SdkModule, 'SessionManager'> as SdkModule;

  const sessions = await listSessions(sdk, configuredDir);

  assert.deepEqual(sessions.map((session) => session.name), ['Canonical']);
});

test('listSessions includes migrated per-cwd directories under the configured root', async () => {
  await withTempDir(async (configuredDir) => {
    const nestedDir = path.join(configuredDir, '--workspace--');
    await fs.mkdir(nestedDir);
    const flatPath = path.join(configuredDir, 'flat.jsonl');
    const nestedPath = path.join(nestedDir, 'nested.jsonl');
    const sdk = {
      SessionManager: {
        listAll: async (sessionDir?: string) => {
          if (sessionDir === configuredDir) return [{
            path: flatPath, cwd: '/repo', name: 'Flat',
            modified: new Date('2026-01-02T00:00:00.000Z'), messageCount: 1,
          }];
          if (sessionDir === nestedDir) return [{
            path: nestedPath, cwd: '/repo', name: 'Nested',
            modified: new Date('2026-01-01T00:00:00.000Z'), messageCount: 1,
          }];
          return [];
        },
      },
    } as Pick<SdkModule, 'SessionManager'> as SdkModule;

    const sessions = await listSessions(sdk, configuredDir);

    assert.deepEqual(sessions.map((session) => session.path), [flatPath, nestedPath]);
  });
});
