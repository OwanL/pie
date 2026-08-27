import * as fsSync from 'node:fs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { isParentProcessAlive, startParentProcessWatchdog } from '../../../src/backend/cold-browse-helper-entry';
import { readColdBrowseFingerprintSync, type ColdBrowseHelperFence } from '../../../src/backend/cold-browse-helper-protocol';
import { ColdBrowseHelperRuntime } from '../../../src/backend/cold-browse-helper-runtime';
import { loadSdk } from '../../../src/backend/sdk';
import { sessionSnapshotLineBytes, SessionSnapshotTooLargeError } from '../../../src/shared/transcript-window';

const pageOptions = { transport: { kind: 'response', requestId: 'runtime-page' } } as const;

function header(cwd: string) {
  return { type: 'session', version: 3, id: 'helper-runtime', timestamp: '2026-08-25T00:00:00.000Z', cwd };
}

function user(id: string, text: string) {
  return {
    type: 'message', id, parentId: null, timestamp: '2026-08-25T00:00:01.000Z',
    message: { role: 'user', content: text, timestamp: 1 },
  };
}

async function writeRows(filePath: string, rows: unknown[]): Promise<void> {
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function fence(sessionPath: string): ColdBrowseHelperFence {
  return {
    coordinatorGeneration: 1,
    sessionPath,
    sessionPathKey: process.platform === 'win32' ? path.resolve(sessionPath).toLowerCase() : path.resolve(sessionPath),
    ownershipRevision: 0,
    fingerprint: readColdBrowseFingerprintSync(sessionPath),
  };
}

test('helper owns a manager-free projection cache and fences changes around every response', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-helper-runtime-'));
  try {
    const sessionPath = path.join(root, 'session.jsonl');
    await writeRows(sessionPath, [header(root), user('one', 'one')]);
    const sdkPath = path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent');
    const sdk = await loadSdk(sdkPath, { mode: 'cold-coordinator' });
    let opens = 0;
    const runtime = new ColdBrowseHelperRuntime({
      sdk: {
        SessionManager: {
          open(openedPath: string) {
            opens += 1;
            return sdk.SessionManager.open(openedPath);
          },
        },
      } as any,
      startupCwd: root,
    });

    const initialFence = fence(sessionPath);
    const opened = await runtime.execute({
      operation: 'open',
      fence: initialFence,
      options: {
        modelSettings: { defaultModel: 'model-a', defaultThinkingLevel: 'medium' },
        availableModels: [],
      },
    });
    const page = await runtime.execute({ operation: 'page', fence: initialFence, direction: 'latest', options: pageOptions });
    assert.equal(opens, 1, 'open and page share one helper-owned projection');
    assert.equal((opened.result as any).transcript[0].id, 'one');
    assert.equal((page.result as any).transcript[0].id, 'one');
    assert.equal('manager' in (opened.result as object), false);

    await writeRows(sessionPath, [header(root), user('two', 'changed durable value')]);
    await assert.rejects(
      runtime.execute({ operation: 'page', fence: initialFence, direction: 'latest', options: pageOptions }),
      /COLD_BROWSE_FINGERPRINT_CHANGED/,
    );
    const nextFence = fence(sessionPath);
    const refreshed = await runtime.execute({ operation: 'page', fence: nextFence, direction: 'latest', options: pageOptions });
    assert.equal((refreshed.result as any).transcript[0].id, 'two');
    assert.equal(opens, 2);

    await runtime.execute({ operation: 'invalidate', sessionPathKey: nextFence.sessionPathKey });
    await runtime.execute({ operation: 'page', fence: nextFence, direction: 'latest', options: pageOptions });
    assert.equal(opens, 3, 'explicit invalidation promptly releases the helper cache');
    runtime.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('helper byte-fits pages before IPC and preserves a typed required-row overflow', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-helper-page-bound-'));
  try {
    const sessionPath = path.join(root, 'session.jsonl');
    await writeRows(sessionPath, [header(root), user('durable', 'small durable source')]);
    const branch = [
      user('one', 'x'.repeat(1_500)),
      user('two', 'y'.repeat(1_500)),
    ];
    const sdk = {
      SessionManager: {
        open: () => ({
          getBranch: () => branch,
          getSessionName: () => undefined,
          getCwd: () => root,
          getSessionId: () => 'helper-runtime',
          buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
        }),
      },
    } as any;
    const boundedRuntime = new ColdBrowseHelperRuntime({
      sdk,
      startupCwd: root,
      maxResponseLineBytes: 2_500,
    });
    const bounded = await boundedRuntime.execute({
      operation: 'page',
      fence: fence(sessionPath),
      direction: 'latest',
      options: pageOptions,
    });
    const page = bounded.result as any;
    assert.deepEqual(page.transcript.map((message: any) => message.id), ['two']);
    assert.ok(sessionSnapshotLineBytes(page, pageOptions.transport) <= 2_500);

    const requiredRuntime = new ColdBrowseHelperRuntime({
      sdk,
      startupCwd: root,
      maxResponseLineBytes: 500,
    });
    await assert.rejects(
      requiredRuntime.execute({
        operation: 'page',
        fence: fence(sessionPath),
        direction: 'latest',
        options: { ...pageOptions, requiredMessageId: 'two' },
      }),
      (error) => error instanceof SessionSnapshotTooLargeError
        && error.data.requiredMessageId === 'two',
    );
    boundedRuntime.dispose();
    requiredRuntime.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('parent watchdog liveness probe recognizes the current process and a missing pid', () => {
  assert.equal(isParentProcessAlive(process.pid), true);
  assert.equal(isParentProcessAlive(2_147_483_647), false);
});

test('parent watchdog observes parent loss independently of helper initialization', async () => {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('parent watchdog did not fire')), 500);
    const stop = startParentProcessWatchdog(2_147_483_647, () => {
      clearTimeout(timeout);
      stop();
      resolve();
    }, 10);
  });
});

test('helper rejects a file changed by SessionManager.open before publishing its projection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-helper-mid-open-'));
  try {
    const sessionPath = path.join(root, 'session.jsonl');
    const originalRows = [header(root), user('old', 'old')];
    await writeRows(sessionPath, originalRows);
    const runtime = new ColdBrowseHelperRuntime({
      sdk: {
        SessionManager: {
          open(openedPath: string) {
            fsSync.appendFileSync(openedPath, `${JSON.stringify(user('new', 'new'))}\n`, 'utf8');
            return {
              getBranch: () => originalRows.slice(1),
              getSessionName: () => undefined,
              getCwd: () => root,
              getSessionId: () => 'helper-runtime',
              buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
            };
          },
        },
      } as any,
      startupCwd: root,
    });
    await assert.rejects(
      runtime.execute({ operation: 'page', fence: fence(sessionPath), direction: 'latest', options: pageOptions }),
      /COLD_BROWSE_FINGERPRINT_CHANGED/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
