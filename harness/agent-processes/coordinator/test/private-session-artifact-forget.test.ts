import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { cleanupSessionTempOutputs, trackSessionTempOutput } from '../../../../lib/temporary-files/session-temp-output-lifecycle.js';
import { artifactDirectory as computerUseArtifactDirectory } from '../../../tools/computer-use/artifacts.js';
import { artifactDirectory as playwrightArtifactDirectory } from '../../../tools/playwright/artifacts.js';
import { STORAGE_CUTOFF_AUTHORIZATION_ENV } from '../../../../analytics/authority/storage-cutoff-authorization.js';
import { BackendServer } from '../server.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { WorkerRuntimeRouter } from '../worker-runtime-router.js';

function createServer(sessionDirectory: string): {
  forgetSession(sessionPath: string): Promise<void>;
  workerRuntimeRouter?: WorkerRuntimeRouter;
} {
  const server = new BackendServer({
    sdkPath: '/sdk',
    sourceArtifactDescriptor: createSyntheticSourceTestSdkRuntime(path.resolve('/sdk')).descriptor,
    cwd: sessionDirectory,
    workerEntryPath: '/worker.js',
  }) as unknown as {
    forgetSession(sessionPath: string): Promise<void>;
    workerRuntimeRouter?: WorkerRuntimeRouter;
    coldSessionStore: {
      leases: { invalidate(sessionPath: string): void };
      forget(sessionPath: string): Promise<void>;
    };
  };
  server.coldSessionStore = {
    leases: { invalidate: () => undefined },
    forget: async (sessionPath) => { await rm(sessionPath, { force: true }); },
  };
  return server;
}

async function createSession(sessionPath: string, sessionId: string): Promise<void> {
  await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: sessionId })}\n`, 'utf8');
}

async function withStorageCutoffDisabled(run: () => Promise<void>): Promise<void> {
  const previous = process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
  delete process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
  try {
    await run();
  } finally {
    if (previous !== undefined) process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = previous;
  }
}

async function assertMissing(targetPath: string): Promise<void> {
  await assert.rejects(access(targetPath), `${targetPath} should be absent`);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function createRouter(
  sessionPath: string,
  options: {
    runtimePromotionGate?: Promise<void>;
    onRuntimePromotionStart?: () => void;
    stopWorker?: (sessionPath: string) => Promise<void>;
  } = {},
): WorkerRuntimeRouter {
  let workerGeneration = 0;
  const workers = new Map<string, any>();
  const supervisor = {
    startWorker: async (rootPath: string, prepare: (identity: any) => Promise<{ leasePath: string; leaseRevision: number }>) => {
      workerGeneration += 1;
      const identity = { workerId: `forget-worker-${workerGeneration}`, workerGeneration, sessionPath: rootPath };
      const assignment = await prepare(identity);
      const worker = {
        ...identity,
        sessionPath: assignment.leasePath,
        client: {
          getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
          requestFrame: async (frame: any) => {
            if (frame.kind === 'sync') {
              return { kind: 'sync.ack', domain: frame.domain, revision: frame.revision };
            }
            if (frame.kind === 'runtime.promote') {
              options.onRuntimePromotionStart?.();
              await options.runtimePromotionGate;
              return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: workerGeneration } };
            }
            return { kind: 'response', ok: true, result: { kind: 'runtime.command', payload: {} } };
          },
          sendFrame: () => true,
        },
      };
      workers.set(assignment.leasePath, worker);
      return worker;
    },
    stopWorker: async (workerPath: string) => {
      await options.stopWorker?.(workerPath);
      workers.delete(workerPath);
    },
    listWorkers: () => [...workers.values()],
  };
  return new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({
        grantId: `forget-grant-${workerGeneration}`, coordinatorGeneration: 1,
        sessionPath: target, sessionPathKey: target, fingerprint: 'forget-test', creationReason: 'resume',
      }),
      consumePromotionGrant: (grant: unknown) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({
        ...owner, canonicalSessionPath: target, ownershipRevision: owner.workerGeneration, nonce: `forget-${owner.workerGeneration}`,
      }),
      reconcileCrash: async () => undefined,
    } as any,
    emit: () => undefined,
    buildPromotionSnapshot: async (target: string) => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: path.dirname(target),
      openedPayload: {
        session: { path: sessionPath, name: 'private', cwd: '/', modifiedAt: new Date(0).toISOString(), messageCount: 0 },
        transcript: [],
        transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
        busy: false, runtimeReady: false, systemPrompts: [], analyticsFactors: {},
      } as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });
}

function tempOutputManifestPath(sessionId: string, outputPath: string): string {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  return path.join(tmpdir(), `pie-session-temp-output-${digest(sessionId)}-${digest(outputPath)}.json`);
}

async function writeOwnedTempOutput(sessionId: string, outputPath: string, owner: object): Promise<void> {
  await writeFile(outputPath, 'worker-owned temporary output', 'utf8');
  assert.equal(await trackSessionTempOutput(sessionId, 'bash', outputPath, owner, sessionId), true);
}

async function assertNoTempOutputAfterPurge(sessionId: string, outputPath: string): Promise<void> {
  await assertMissing(outputPath);
  await assertMissing(tempOutputManifestPath(sessionId, outputPath));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assertMissing(outputPath);
  await assertMissing(tempOutputManifestPath(sessionId, outputPath));
}

test('fallback private forget removes only the forgotten session artifact directories', async () => {
  await withStorageCutoffDisabled(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pie-private-artifacts-'));
    try {
      const sessions = path.join(root, 'sessions');
      await mkdir(sessions, { recursive: true });
      const privateSession = path.join(sessions, 'private-one.jsonl');
      const siblingSession = path.join(sessions, 'sibling-two.jsonl');
      await createSession(privateSession, 'private-one');
      await createSession(siblingSession, 'sibling-two');

      const privateComputer = await computerUseArtifactDirectory(privateSession, 'computer-private');
      const siblingComputer = await computerUseArtifactDirectory(siblingSession, 'computer-sibling');
      const privatePlaywright = await playwrightArtifactDirectory(privateSession, 'pw-private');
      const siblingPlaywright = await playwrightArtifactDirectory(siblingSession, 'pw-sibling');
      for (const artifactPath of [privateComputer, siblingComputer, privatePlaywright, siblingPlaywright]) {
        await writeFile(path.join(artifactPath, 'evidence.txt'), 'temporary test artifact', 'utf8');
      }

      await createServer(sessions).forgetSession(privateSession);

      await assertMissing(privateSession);
      await assertMissing(privateComputer);
      await assertMissing(path.dirname(privateComputer));
      await assertMissing(privatePlaywright);
      await access(siblingComputer);
      await access(path.join(siblingComputer, 'evidence.txt'));
      await access(siblingPlaywright);
      await access(path.join(siblingPlaywright, 'evidence.txt'));
      assert.equal(existsSync(siblingSession), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('private forget waits for promotion before purging late worker output manifests', async () => {
  await withStorageCutoffDisabled(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pie-private-promoting-forget-'));
    const promotionGate = deferred<void>();
    const promotionStarted = deferred<void>();
    const sessions = path.join(root, 'sessions');
    const privateSession = path.join(sessions, 'private-promoting.jsonl');
    const sessionId = 'private-promoting';
    const outputPath = path.join(tmpdir(), `pi-bash-${randomBytes(8).toString('hex')}.log`);
    const owner = {};
    let promotion: Promise<unknown> | undefined;
    try {
      await mkdir(sessions, { recursive: true });
      await createSession(privateSession, sessionId);
      const router = createRouter(privateSession, {
        runtimePromotionGate: promotionGate.promise,
        onRuntimePromotionStart: () => promotionStarted.resolve(),
        stopWorker: async () => await writeOwnedTempOutput(sessionId, outputPath, owner),
      });
      promotion = router.promote(privateSession);
      await promotionStarted.promise;
      assert.equal(router.getRoute(privateSession).state, 'promoting');

      const server = createServer(sessions);
      server.workerRuntimeRouter = router;
      let forgotten = false;
      const forgetting = server.forgetSession(privateSession).then(() => { forgotten = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(forgotten, false, 'private cleanup must join the in-flight promotion');

      promotionGate.resolve();
      await promotion;
      await forgetting;
      assert.equal(router.getRoute(privateSession).state, 'cold');
      await assertNoTempOutputAfterPurge(sessionId, outputPath);
    } finally {
      promotionGate.resolve();
      await promotion?.catch(() => undefined);
      await cleanupSessionTempOutputs(sessionId, owner, sessionId).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('private forget joins an existing retirement before manifest cleanup', async () => {
  await withStorageCutoffDisabled(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pie-private-retiring-forget-'));
    const stopStarted = deferred<void>();
    const stopGate = deferred<void>();
    const sessions = path.join(root, 'sessions');
    const privateSession = path.join(sessions, 'private-retiring.jsonl');
    const sessionId = 'private-retiring';
    const outputPath = path.join(tmpdir(), `pi-bash-${randomBytes(8).toString('hex')}.log`);
    const owner = {};
    let retirement: Promise<void> | undefined;
    try {
      await mkdir(sessions, { recursive: true });
      await createSession(privateSession, sessionId);
      const router = createRouter(privateSession, {
        stopWorker: async () => {
          stopStarted.resolve();
          await stopGate.promise;
        },
      });
      await router.promote(privateSession);
      retirement = router.retire(privateSession, 'test retirement');
      await stopStarted.promise;
      assert.equal(router.getRoute(privateSession).state, 'retiring');

      const server = createServer(sessions);
      server.workerRuntimeRouter = router;
      let forgotten = false;
      const forgetting = server.forgetSession(privateSession).then(() => { forgotten = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(forgotten, false, 'private cleanup must join the in-flight retirement');
      await writeOwnedTempOutput(sessionId, outputPath, owner);

      stopGate.resolve();
      await retirement;
      await forgetting;
      await assertNoTempOutputAfterPurge(sessionId, outputPath);
    } finally {
      stopGate.resolve();
      await retirement?.catch(() => undefined);
      await cleanupSessionTempOutputs(sessionId, owner, sessionId).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('private forget cancels a worker transition before joining deferred worker-tool completion', async () => {
  await withStorageCutoffDisabled(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pie-private-transition-forget-'));
    const transitionWork = deferred<void>();
    const workerStopped = deferred<void>();
    const sessions = path.join(root, 'sessions');
    const privateSession = path.join(sessions, 'private-transition.jsonl');
    const sessionId = 'private-transition';
    const outputPath = path.join(tmpdir(), `pi-bash-${randomBytes(8).toString('hex')}.log`);
    const owner = {};
    let transition: Promise<unknown> | undefined;
    try {
      await mkdir(sessions, { recursive: true });
      await createSession(privateSession, sessionId);
      const router = createRouter(privateSession, {
        stopWorker: async () => {
          await writeOwnedTempOutput(sessionId, outputPath, owner);
          transitionWork.resolve();
          workerStopped.resolve();
        },
      });
      await router.promote(privateSession);
      transition = router.runHotTransition(privateSession, 'deferred-worker-tool-close', async (control) => {
        // Models an in-flight worker tool whose response is released by worker
        // retirement. Forget must stop/cancel first, not await this completion
        // while leaving its worker alive.
        await transitionWork.promise;
        await control.retire('transition resumed after deferred worker tool');
      });
      assert.equal(router.getRoute(privateSession).state, 'transitioning');

      const server = createServer(sessions);
      server.workerRuntimeRouter = router;
      const forgetting = server.forgetSession(privateSession);
      await workerStopped.promise;
      await forgetting;
      await assert.rejects(transition, /interrupted|cancelled|SESSION_OPERATION_CANCELLED/i);
      await assert.equal(router.getRoute(privateSession).state, 'cold');
      await assertNoTempOutputAfterPurge(sessionId, outputPath);
    } finally {
      transitionWork.resolve();
      await transition?.catch(() => undefined);
      await cleanupSessionTempOutputs(sessionId, owner, sessionId).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('fallback private forget refuses an ambiguous sanitized computer-use partition', async () => {
  await withStorageCutoffDisabled(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pie-private-artifact-collision-'));
    try {
      const sessions = path.join(root, 'sessions');
      await mkdir(sessions, { recursive: true });
      const privateSession = path.join(sessions, 'private session.jsonl');
      const collidingSession = path.join(sessions, 'private-session.jsonl');
      await createSession(privateSession, 'private-one');
      await createSession(collidingSession, 'private-two');

      const privateComputer = await computerUseArtifactDirectory(privateSession, 'computer-private');
      await writeFile(path.join(privateComputer, 'evidence.txt'), 'must remain', 'utf8');
      const privatePlaywright = await playwrightArtifactDirectory(privateSession, 'pw-private');
      await writeFile(path.join(privatePlaywright, 'evidence.txt'), 'must remain', 'utf8');

      await assert.rejects(createServer(sessions).forgetSession(privateSession), /may be shared.*refusing private cleanup/);

      assert.equal(existsSync(privateSession), true);
      await access(path.join(privateComputer, 'evidence.txt'));
      await access(path.join(privatePlaywright, 'evidence.txt'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
