import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunAnalyticsStorage } from '../../../src/host/stats-service/storage';
import { RUN_ANALYTICS_SCHEMA_VERSION, type OutcomeHistoryLogEntry } from '../../../src/host/run-analytics';
import { serializeJsonLine } from '../../../src/shared/jsonl';
import {
  buildWorkspaceAnalyticsId,
  getDataOutcomesRootPath,
  getDefaultRunAnalyticsExportPath,
} from '../../../src/host/run-analytics/storage';

function createFileUri(fileSystemPath: string, raw = `file://${fileSystemPath}`) {
  return {
    scheme: 'file',
    fsPath: fileSystemPath,
    toString: () => raw,
  };
}

test('buildWorkspaceAnalyticsId canonicalizes multi-root file folders across order and casing', () => {
  const left = buildWorkspaceAnalyticsId({
    workspaceFolders: [
      { uri: createFileUri('C:\\Repo\\Two') },
      { uri: createFileUri('c:\\repo\\one') },
    ],
    noWorkspaceId: 'unused-left',
    platform: 'win32',
  });

  const right = buildWorkspaceAnalyticsId({
    workspaceFolders: [
      { uri: createFileUri('c:\\REPO\\ONE') },
      { uri: createFileUri('C:\\repo\\two') },
    ],
    noWorkspaceId: 'unused-right',
    platform: 'win32',
  });

  assert.equal(left, right);
  assert.equal(left, JSON.stringify({
    folders: [
      'file:c:/repo/one',
      'file:c:/repo/two',
    ],
  }));
});

test('buildWorkspaceAnalyticsId serializes folder sets without delimiter collisions', () => {
  const left = buildWorkspaceAnalyticsId({
    workspaceFolders: [
      { uri: { scheme: 'mem', toString: () => 'mem:/a' } },
      { uri: { scheme: 'mem', toString: () => 'mem:/b|mem:/c' } },
    ],
    noWorkspaceId: 'unused',
  });

  const right = buildWorkspaceAnalyticsId({
    workspaceFolders: [
      { uri: { scheme: 'mem', toString: () => 'mem:/a|mem:/b' } },
      { uri: { scheme: 'mem', toString: () => 'mem:/c' } },
    ],
    noWorkspaceId: 'unused',
  });

  assert.notEqual(left, right);
});

test('buildWorkspaceAnalyticsId falls back to the workspace file when no folders are open', () => {
  const workspaceId = buildWorkspaceAnalyticsId({
    workspaceFile: createFileUri('/workspaces/pie/pie.code-workspace'),
    noWorkspaceId: 'unused',
    platform: 'linux',
  });

  assert.equal(workspaceId, JSON.stringify({
    workspaceFile: 'file:/workspaces/pie/pie.code-workspace',
  }));
});

test('buildWorkspaceAnalyticsId uses the persisted no-workspace id as a collision-proof fallback', () => {
  const workspaceId = buildWorkspaceAnalyticsId({
    noWorkspaceId: 'window-analytics-id',
  });

  assert.equal(workspaceId, JSON.stringify({
    noWorkspaceId: 'window-analytics-id',
  }));
});

test('getDataOutcomesRootPath prefers PI_CODING_AGENT_DIR when configured', () => {
  const savedEnv = process.env.PIE_ANALYTICS_DIR;
  delete process.env.PIE_ANALYTICS_DIR;
  try {
    assert.equal(
      getDataOutcomesRootPath('  /repo/root  ', '/global/storage'),
      path.join('/repo/root', 'data', 'outcomes'),
    );
    assert.equal(
      getDataOutcomesRootPath('', '/global/storage'),
      path.join('/global/storage', 'data', 'outcomes'),
    );
  } finally {
    if (savedEnv !== undefined) {
      process.env.PIE_ANALYTICS_DIR = savedEnv;
    }
  }
});

test('getDataOutcomesRootPath prefers PIE_ANALYTICS_DIR env var over all other sources', () => {
  const savedEnv = process.env.PIE_ANALYTICS_DIR;
  process.env.PIE_ANALYTICS_DIR = '/custom/analytics';
  try {
    assert.equal(
      getDataOutcomesRootPath('/repo/root', '/global/storage'),
      path.resolve('/custom/analytics'),
    );
  } finally {
    if (savedEnv !== undefined) {
      process.env.PIE_ANALYTICS_DIR = savedEnv;
    } else {
      delete process.env.PIE_ANALYTICS_DIR;
    }
  }
});

test('getDefaultRunAnalyticsExportPath prefers the configured PI repo path when available', () => {
  assert.equal(
    getDefaultRunAnalyticsExportPath('/pi-config', '/global/storage', '/workspace/project'),
    path.join('/pi-config', 'analysis', 'data', 'exports', 'run-analytics-export.json'),
  );
});

test('getDefaultRunAnalyticsExportPath falls back to extension global storage outside the PI repo', () => {
  assert.equal(
    getDefaultRunAnalyticsExportPath('', '/global/storage', '/workspace/project'),
    path.join('/global/storage', 'exports', 'project', 'run-analytics-export.json'),
  );
});

test('RunAnalyticsStorage prunes CRLF JSONL using actual UTF-8 bytes and keeps the newest record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-storage-crlf-'));
  try {
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'crlf-test',
      now: () => new Date('2026-07-13T10:00:00.000Z'),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 10,
      maxRunHistoryBytes: 400,
      autoExportSetTimeout: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
    });

    await storage.start();
    const storageDir = storage.getStorageDir();
    const filePath = path.join(storageDir, 'outcome-history.jsonl');

    const outcome = (runId: string, text: string) => ({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_outcome' as const,
      recordedAt: '2026-07-13T10:00:00.000Z',
      sessionPath: '/s',
      runId,
      taskGroupId: 't',
      outcome: { resolution: 'resolved' as const, satisfaction: 4 },
      text,
    } as OutcomeHistoryLogEntry);

    // Seed the file with CRLF line endings and multi-byte characters so the
    // UTF-8 byte count exceeds the naive string-length + 1 estimate.
    const seeded = [outcome('r1', 'éé'), outcome('r2', '€€'), outcome('r3', 'ññ')];
    const crlfContent = seeded.map((line) => serializeJsonLine(line)).join('').replace(/\n/g, '\r\n');
    await fs.writeFile(filePath, crlfContent, 'utf8');

    const fullBytes = Buffer.byteLength(crlfContent, 'utf8');
    assert.ok(fullBytes > 400, `seeded CRLF file ${fullBytes} B should exceed the byte limit`);

    // Appending a new record triggers the post-flush prune.
    const newest = outcome('r4', 'üü');
    storage.schedulePersist(undefined, newest);
    await storage.flush();

    const raw = await fs.readFile(filePath, 'utf8');
    const keptLines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const keptIds = keptLines.map((line) => JSON.parse(line).runId);

    assert.ok(raw.includes('\r\n'), 'rewritten file preserves CRLF line endings');
    assert.deepEqual(keptIds, ['r3', 'r4'], 'oldest two records are pruned; newest two survive');
    const prunedBytes = Buffer.byteLength(raw, 'utf8');
    assert.ok(prunedBytes <= 400, `pruned file ${prunedBytes} B must stay within the byte limit`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
