import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  ColdBrowseHelperClient,
  ColdBrowseHelperRequestError,
  type ColdBrowseHelperClientOptions,
  type ColdBrowseHelperTimingSample,
} from '../cold-browse-helper-client';
import {
  readColdBrowseFingerprintSync,
  type ColdBrowseHelperFence,
} from '../cold-browse-helper-protocol';
import {
  DurableDetailNotAddressableError,
  DurableDetailNotFoundError,
} from '../../../session-storage/transcripts/durable-detail-store';
import { SessionSnapshotTooLargeError } from '../../../session-storage/transcripts/snapshot-boundary.js';
import {
  createLegacyTestSdkRuntime,
  createSourceArtifactTestSdkRuntime,
} from '../../test/fixtures/sdk-runtime-selection.js';
import { buildSanitizedRealChildTestEnv } from '../../test/fixtures/sanitized-real-child-env.js';

const testSdkRuntime = () => createLegacyTestSdkRuntime(process.cwd());
const fixturePath = path.join(process.cwd(), 'harness', 'agent-processes', 'cold-browse-helper', 'test', 'fixtures', 'cold-browse-helper-client-fixture.mjs');
const fence: ColdBrowseHelperFence = {
  coordinatorGeneration: 1,
  sessionPath: path.join(process.cwd(), 'fixture.jsonl'),
  sessionPathKey: 'fixture',
  ownershipRevision: 0,
  fingerprint: 'fixture-fingerprint',
};
const openOptions = {
  modelSettings: { defaultModel: 'model-a', defaultThinkingLevel: 'medium' as const },
  availableModels: [],
};

test('client rejects malformed runtime routes and SDK path disagreement before spawn', () => {
  const valid = testSdkRuntime();
  const construct = (sdkRuntime: unknown, sdkPath = process.cwd()) => new ColdBrowseHelperClient({
    entryPath: fixturePath,
    sdkPath,
    sdkRuntime: sdkRuntime as any,
    startupCwd: process.cwd(),
  });
  for (const malformed of [
    undefined,
    { ...valid, kind: 'unknown' },
    { ...valid, descriptor: {} },
    { kind: 'legacy-patched', patchIdentity: (valid as any).patchIdentity, descriptor: {} },
  ]) assert.throws(() => construct(malformed), /runtime|selection|descriptor|route|sdk path/i);
  assert.throws(() => construct(valid, `${process.cwd()}-mismatch`), /runtime|selection|route|sdk path/i);
});

function client(
  mode: string,
  overrides: Partial<ColdBrowseHelperClientOptions> = {},
): ColdBrowseHelperClient {
  return new ColdBrowseHelperClient({
    entryPath: fixturePath,
    entryArgs: [mode],
    sdkPath: process.cwd(),
    sdkRuntime: testSdkRuntime(),
    startupCwd: process.cwd(),
    requestTimeoutMs: 2_000,
    ...overrides,
  });
}

test('helper timing records readiness and request durations without browse payloads', async () => {
  const timings: ColdBrowseHelperTimingSample[] = [];
  const helper = client('delayed', {
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    onTiming: (sample) => timings.push(sample),
  });
  try {
    const [, opened] = await Promise.all([
      helper.warm(),
      helper.openSnapshot(fence, openOptions),
    ]);
    assert.equal(opened.session.path, fence.sessionPath);
  } finally {
    await helper.dispose();
  }

  const start = timings.find((sample) => sample.stage === 'start');
  const warm = timings.find((sample) => sample.stage === 'operation' && sample.operation === 'warm');
  const open = timings.find((sample) => sample.stage === 'operation' && sample.operation === 'open');
  assert.ok(start, 'one helper generation start is timed');
  assert.ok(warm, 'readiness wait is timed for warm');
  assert.ok(open, 'the browse request is timed');
  assert.equal(start.outcome, 'success');
  assert.equal(warm.outcome, 'success');
  assert.equal(open.outcome, 'success');
  if (start.stage !== 'start' || warm.stage !== 'operation' || open.stage !== 'operation') {
    throw new Error('Helper timing stage did not match the expected record.');
  }
  assert.ok(start.durationMs >= 0 && start.durationMs < 2_000);
  assert.ok(warm.waitDurationMs >= 0 && warm.waitDurationMs < 2_000);
  assert.ok(open.waitDurationMs >= 0 && open.waitDurationMs < 2_000);
  assert.ok((open.requestDurationMs ?? -1) >= 0 && (open.requestDurationMs ?? 2_000) < 2_000);
  assert.deepEqual(Object.keys(open).sort(), [
    'operation', 'outcome', 'requestDurationMs', 'stage', 'waitDurationMs',
  ]);
});

test('client keeps correlated operation errors local to the request', async () => {
  const helper = client('error');
  try {
    await helper.warm();
    await assert.rejects(
      helper.openSnapshot(fence, openOptions),
      (error) => error instanceof ColdBrowseHelperRequestError
        && error.code === 'FIXTURE_ERROR'
        && error.message === 'fixture operation failed',
    );
    await assert.rejects(helper.openSnapshot(fence, openOptions), ColdBrowseHelperRequestError);
  } finally {
    await helper.dispose();
  }
});

test('client rejects pending work when the helper crashes', async () => {
  const helper = client('crash');
  try {
    await helper.warm();
    await assert.rejects(helper.openSnapshot(fence, openOptions), /exited unexpectedly|EPIPE/u);
  } finally {
    await helper.dispose();
  }
});

test('client fails the generation closed on an unknown correlation', async () => {
  const helper = client('wrong-correlation');
  try {
    await helper.warm();
    await assert.rejects(helper.openSnapshot(fence, openOptions), /unknown correlation/u);
  } finally {
    await helper.dispose();
  }
});

test('client bounds helper readiness and terminates the hung generation', async () => {
  const helper = client('hang-ready', { startupTimeoutMs: 100, shutdownTimeoutMs: 250 });
  try {
    await assert.rejects(helper.warm(), /readiness timed out/u);
  } finally {
    await helper.dispose();
  }
});

test('client rejects a success frame whose fingerprint does not match its request fence', async () => {
  const helper = client('stale-fingerprint');
  try {
    await helper.warm();
    await assert.rejects(helper.openSnapshot(fence, openOptions), /wrong durable fingerprint/u);
  } finally {
    await helper.dispose();
  }
});

test('client preserves a fenced oversized-snapshot error as the shared typed error', async () => {
  const helper = client('oversized');
  try {
    await helper.warm();
    await assert.rejects(
      helper.openSnapshot(fence, openOptions),
      (error) => error instanceof SessionSnapshotTooLargeError
        && error.code === 'SESSION_SNAPSHOT_TOO_LARGE'
        && error.data.requiredMessageId === 'required',
    );
  } finally {
    await helper.dispose();
  }
});

test('client preserves a fingerprint-change signal only for its exact request fence', async () => {
  const helper = client('fingerprint-changed');
  try {
    await helper.warm();
    await assert.rejects(
      helper.openSnapshot(fence, openOptions),
      (error) => error instanceof ColdBrowseHelperRequestError
        && error.code === 'FINGERPRINT_CHANGED'
        && error.fingerprint === fence.fingerprint,
    );
  } finally {
    await helper.dispose();
  }
});

test('client preserves original durable-detail resolution error types', async () => {
  for (const [mode, ErrorType] of [
    ['durable-detail-not-found', DurableDetailNotFoundError],
    ['durable-detail-not-addressable', DurableDetailNotAddressableError],
  ] as const) {
    const helper = client(mode);
    try {
      await helper.warm();
      await assert.rejects(
        helper.resolveDurableDetail!(fence, {
          sessionPath: fence.sessionPath,
          turnId: 'turn',
          rootToolCallId: 'root-tool-call',
          rootAttemptId: 'attempt',
          lineage: [{ childId: 'child', spawningToolCallId: 'root-tool-call', attemptId: 'attempt' }],
        }),
        (error) => error instanceof ErrorType,
      );
    } finally {
      await helper.dispose();
    }
  }
});

test('client fails the helper generation on a fingerprint-change signal for the wrong fence', async () => {
  const helper = client('fingerprint-changed-wrong-fence');
  try {
    await helper.warm();
    await assert.rejects(
      helper.openSnapshot(fence, openOptions),
      /invalid fingerprint-change error frame/u,
    );
  } finally {
    await helper.dispose();
  }
});

test('serialized requests receive queue-position-adjusted timeout budgets', async () => {
  // The fixture delays each response 100ms. The original 150ms budget had no
  // headroom: under full-suite load the delayed child's IPC + startup latency
  // alone could exceed it and expire the first request's timer. The queue
  // scaling under test is unchanged (budget = timeout × queue position).
  const helper = client('delayed', { requestTimeoutMs: 500 });
  try {
    await helper.warm();
    const [first, second] = await Promise.all([
      helper.openSnapshot(fence, openOptions),
      helper.openSnapshot(fence, openOptions),
    ]);
    assert.equal(first.session.path, fence.sessionPath);
    assert.equal(second.session.path, fence.sessionPath);
  } finally {
    await helper.dispose();
  }
});

test('invalidation does not spawn a helper before the first browse', async () => {
  let spawnCalls = 0;
  const helper = new ColdBrowseHelperClient({
    entryPath: fixturePath,
    sdkPath: process.cwd(),
    sdkRuntime: testSdkRuntime(),
    startupCwd: process.cwd(),
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('must not spawn');
    }) as any,
  });
  await helper.invalidatePath('unused');
  assert.equal(spawnCalls, 0);
  await helper.dispose();
});

test('client performs a typed durable-detail request and clean shutdown', async () => {
  const helper = client('success', { shutdownTimeoutMs: 1_000 });
  await helper.warm();
  const result = await helper.resolveDurableDetail!(fence, {
    sessionPath: fence.sessionPath,
    turnId: 'turn',
    rootToolCallId: 'root-tool-call',
    rootAttemptId: 'attempt',
    lineage: [{ childId: 'child', spawningToolCallId: 'root-tool-call', attemptId: 'attempt' }],
  });
  assert.deepEqual(result, {
    value: { fixture: true },
    sizeBytes: 16,
    messageId: 'fixture-message',
    toolCallId: 'fixture-tool-call',
    kind: 'tool-result',
  });
  const opened = await helper.openSnapshot(fence, openOptions);
  const childPid = (opened as any).fixturePid as number;
  assert.equal(opened.session.path, fence.sessionPath);
  const startedAt = Date.now();
  await helper.dispose();
  assert.ok(Date.now() - startedAt < 1_000, 'clean shutdown exits before the forced-kill window');
  assert.equal(isProcessAlive(childPid), false);
});

test('client kills a child that acknowledges shutdown but retains a live handle', async () => {
  // The fixture keeps a live handle after its shutdown ack. 100ms forced-kill
  // confirmation had no headroom under full-suite Windows load; 500ms still
  // exercises the ack-then-kill path while tolerating scheduler latency.
  const helper = client('sticky-shutdown', { shutdownTimeoutMs: 500 });
  await helper.warm();
  const result = await helper.openSnapshot(fence, openOptions);
  const childPid = (result as any).fixturePid as number;
  await helper.dispose();
  assert.equal(isProcessAlive(childPid), false);
});

test('concurrent dispose callers join confirmed helper exit', async () => {
  const helper = client('sticky-shutdown', { shutdownTimeoutMs: 500 });
  await helper.warm();
  const result = await helper.openSnapshot(fence, openOptions);
  const childPid = (result as any).fixturePid as number;
  const firstDisposal = helper.dispose();
  let secondDisposalSettled = false;
  const secondDisposal = helper.dispose().then(() => { secondDisposalSettled = true; });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(secondDisposalSettled, false, 'a repeated call cannot claim shutdown before the first confirms exit');
    await Promise.all([firstDisposal, secondDisposal]);
    assert.equal(isProcessAlive(childPid), false);
  } finally {
    await firstDisposal;
  }
});

test('real source-artifact child initializes cold transport and opens only a sanitized temporary session', {
  timeout: 180_000,
}, async (t) => {
  if (process.env['PIE_RUN_REAL_COLD_HELPER_TESTS'] !== '1') {
    t.skip('Set PIE_RUN_REAL_COLD_HELPER_TESTS=1 to run the real source-artifact cold-helper acceptance.');
    return;
  }
  const repoRoot = path.resolve(__dirname, '../../../../');
  const artifactDir = process.env['PIE_REAL_RUNTIME_ARTIFACT_DIR']?.trim()
    || 'C:/Users/OwanLazic/AppData/Local/Temp/pie-b1-b3-final-1790865003945/pi-runtime';
  const selectedRuntime = await createSourceArtifactTestSdkRuntime(artifactDir);
  const tsxLoader = path.join(repoRoot, 'application', 'hosts', 'vscode', 'node_modules', 'tsx', 'dist', 'loader.cjs');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-source-child-'));
  const agentDir = path.join(tempDir, 'agent');
  const authDir = path.join(tempDir, 'auth');
  const sessionDir = path.join(tempDir, 'sessions');
  const sessionPath = path.join(tempDir, 'session.jsonl');
  let helper: ColdBrowseHelperClient | undefined;
  try {
    await Promise.all([
      ...['home', 'tmp', 'appdata', 'local-appdata', 'xdg-config', 'xdg-data'].map((name) => (
        fs.mkdir(path.join(tempDir, name), { recursive: true })
      )),
      fs.mkdir(agentDir, { recursive: true }),
      fs.mkdir(authDir, { recursive: true }),
      fs.mkdir(sessionDir, { recursive: true }),
    ]);
    await fs.writeFile(sessionPath, `${JSON.stringify({
      type: 'session', version: 3, id: 'sanitized-cold-test',
      timestamp: '2026-10-02T00:00:00.000Z', cwd: tempDir,
    })}\n${JSON.stringify({
      type: 'message', id: 'temporary-user-message', parentId: null,
      timestamp: '2026-10-02T00:00:01.000Z',
      message: { role: 'user', content: 'offline cold browse fixture', timestamp: 1 },
    })}\n`, 'utf8');
    const fence: ColdBrowseHelperFence = {
      coordinatorGeneration: 1,
      sessionPath,
      sessionPathKey: process.platform === 'win32' ? path.resolve(sessionPath).toLowerCase() : path.resolve(sessionPath),
      ownershipRevision: 0,
      fingerprint: readColdBrowseFingerprintSync(sessionPath),
    };
    helper = new ColdBrowseHelperClient({
      entryPath: path.resolve(__dirname, '..', 'cold-browse-helper-entry.ts'),
      sdkPath: selectedRuntime.sdkPath,
      sdkRuntime: selectedRuntime.sdkRuntime,
      startupCwd: tempDir,
      nodePath: process.execPath,
      startupTimeoutMs: 90_000,
      requestTimeoutMs: 90_000,
      shutdownTimeoutMs: 5_000,
      spawnProcess: ((command: string, args: readonly string[], options: any) => spawn(
        command,
        ['--require', tsxLoader, ...args],
        {
          ...options,
          env: buildSanitizedRealChildTestEnv(options.env ?? {}, tempDir, 'cold-helper'),
        },
      )) as any,
    });
    await helper.warm();
    const opened = await helper.openSnapshot(fence, {
      modelSettings: { defaultModel: 'offline-model', defaultThinkingLevel: 'medium' },
      availableModels: [],
    });
    assert.equal(opened.session.path, sessionPath);
    assert.ok(opened.transcript.some((message) => message.id === 'temporary-user-message'));
  } finally {
    await helper?.dispose().catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
