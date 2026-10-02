import * as fsSync from 'node:fs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  isParentProcessAlive,
  parseColdBrowseHelperInputFrame,
  startParentProcessWatchdog,
} from '../cold-browse-helper-entry';
import {
  COLD_BROWSE_HELPER_PROTOCOL_VERSION,
  readColdBrowseFingerprintSync,
  type ColdBrowseHelperFence,
} from '../cold-browse-helper-protocol';
import {
  createSyntheticSourceTestSdkRuntime,
  createSourceArtifactTestSdkRuntime,
} from '../../test/fixtures/sdk-runtime-selection.js';
import {
  ColdBrowseHelperResponseTooLargeError,
  ColdBrowseHelperRuntime,
} from '../cold-browse-helper-runtime';
import { loadSdk } from '../../lib/sdk-integration/sdk';
import {
  sdkRuntimeLoadMode,
  verifySdkRuntimeSelection,
} from '../../lib/sdk-integration/sdk-runtime-selection.js';
import { sourceDescriptor } from '../../lib/sdk-integration/test/source-fixture.js';
import { sessionSnapshotLineBytes, SessionSnapshotTooLargeError } from '../../../session-storage/transcripts/snapshot-boundary.js';

const pageOptions = { transport: { kind: 'response', requestId: 'runtime-page' } } as const;
const detailAddress = {
  sessionPath: '',
  turnId: 'turn',
  rootToolCallId: 'root-tool-call',
  rootAttemptId: 'attempt',
  lineage: [{ childId: 'child', spawningToolCallId: 'root-tool-call', attemptId: 'attempt' }],
} as const;

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
    const artifactDir = sourceDescriptor.artifactDir;
    const selectedRuntime = await createSourceArtifactTestSdkRuntime(artifactDir);
    const verifiedRuntime = await verifySdkRuntimeSelection(selectedRuntime.sdkPath, selectedRuntime.sdkRuntime);
    const mode = sdkRuntimeLoadMode(verifiedRuntime, 'cold');
    if (mode.mode !== 'source-artifact') throw new Error('Real cold helper test requires a source artifact runtime.');
    const sdk = await loadSdk(selectedRuntime.sdkPath, { ...mode, surface: 'cold' });
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
          getEntries: () => branch,
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

test('helper durable-detail resolution matches the pure durable address and refuses an oversized response before IPC', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-helper-detail-'));
  try {
    const sessionPath = path.join(root, 'session.jsonl');
    await writeRows(sessionPath, [header(root), user('root', 'prompt')]);
    const target = {
      liveAddressable: true,
      lineage: detailAddress.lineage,
      payload: 'detail-value',
    };
    const branch = [
      {
        id: 'user', parentId: null, type: 'message', timestamp: '2026-08-25T00:00:01.000Z',
        message: { role: 'user', content: 'prompt', timestamp: 1 },
      },
      {
        id: 'assistant', parentId: 'user', type: 'message', timestamp: '2026-08-25T00:00:02.000Z',
        message: {
          role: 'assistant', content: [{ type: 'toolCall', id: 'root-tool-call', name: 'subagent', arguments: {} }],
          provider: 'mock', model: 'model-a', stopReason: 'stop', timestamp: 2,
        },
      },
      {
        id: 'tool-result', parentId: 'assistant', type: 'message', timestamp: '2026-08-25T00:00:03.000Z',
        message: { role: 'toolResult', toolCallId: 'root-tool-call', details: { results: [target] }, timestamp: 3 },
      },
    ];
    const sdk = {
      SessionManager: {
        open: () => ({
          getBranch: () => branch,
          getEntries: () => branch,
          getSessionName: () => undefined,
          getCwd: () => root,
          getSessionId: () => 'helper-detail',
          buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
        }),
      },
    } as any;
    const runtime = new ColdBrowseHelperRuntime({ sdk, startupCwd: root });
    const resolved = await runtime.execute({
      operation: 'durable-detail',
      fence: { ...fence(sessionPath), sessionPath },
      address: { ...detailAddress, sessionPath },
    }, 'detail-request');
    assert.deepEqual(resolved.result, {
      value: target,
      sizeBytes: Buffer.byteLength(JSON.stringify(target), 'utf8'),
      messageId: 'assistant',
      toolCallId: 'root-tool-call',
      kind: 'tool-result',
    });
    runtime.dispose();

    const oversizedBranch = [{
      ...branch[0],
    }, {
      ...branch[1],
    }, {
      ...branch[2],
      message: {
        ...branch[2]!.message,
        details: { results: [{ ...target, payload: 'x'.repeat(2_000) }] },
      },
    }];
    const oversizedRuntime = new ColdBrowseHelperRuntime({
      sdk: {
        SessionManager: {
          open: () => ({
            getEntries: () => oversizedBranch,
            getBranch: () => oversizedBranch,
            getSessionName: () => undefined,
            getCwd: () => root,
            getSessionId: () => 'helper-detail-oversized',
            buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
          }),
        },
      } as any,
      startupCwd: root,
      maxResponseLineBytes: 512,
    });
    await assert.rejects(
      oversizedRuntime.execute({
        operation: 'durable-detail',
        fence: { ...fence(sessionPath), sessionPath },
        address: { ...detailAddress, sessionPath },
      }, 'detail-request'),
      (error) => error instanceof ColdBrowseHelperResponseTooLargeError
        && error.data.maxBytes === 512
        && error.data.bytes > 512,
    );
    oversizedRuntime.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cold helper initialization rejects missing, mixed, unknown, and legacy-discriminator runtime routes', () => {
  const sdkRuntime = createSyntheticSourceTestSdkRuntime('/sdk');
  const initialization = {
    protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
    kind: 'initialize',
    sdkPath: '/sdk',
    sdkRuntime,
    startupCwd: '/tmp/cold-helper',
    parentPid: 123,
  };
  assert.equal(parseColdBrowseHelperInputFrame(initialization)?.kind, 'initialize');
  assert.equal(parseColdBrowseHelperInputFrame({ ...initialization, protocolVersion: 1 }), undefined);
  for (const malformed of [
    { ...initialization, sdkRuntime: undefined },
    { ...initialization, sdkRuntime: { ...sdkRuntime, descriptor: {} } },
    { ...initialization, sdkRuntime: { ...sdkRuntime, kind: 'unknown' } },
    { ...initialization, sdkRuntime: { ...sdkRuntime, patchIdentity: {} } },
    { ...initialization, sdkRuntime: { kind: 'legacy-patched', patchIdentity: {} } },
    { ...initialization, sdkPatchIdentity: {} },
  ]) assert.equal(parseColdBrowseHelperInputFrame(malformed), undefined);
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
              getEntries: () => originalRows.slice(1),
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
