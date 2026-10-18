import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import Module from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { deriveTrustedSdkRoot } from '../../agent-connection/trusted-sdk-root';
import type { GenerationPiRuntimeDescriptor } from '../../../hosts/lib/pi-runtime-resolution';
import { PROTOCOL_VERSION } from '../../../../harness/agent-processes/lib/rpc/wire.js';

test('deriveTrustedSdkRoot trusts the containing node_modules tree only', () => {
  assert.equal(
    deriveTrustedSdkRoot('C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent'),
    'C:\\tools\\node_modules',
  );
  assert.equal(deriveTrustedSdkRoot('C:\\tools\\pi-coding-agent'), undefined);
});

class ImmediateReadyStream extends PassThrough {
  private emitted = false;

  constructor(private readonly analyticsActivation?: Record<string, unknown>, private readonly analyticsContext?: Record<string, unknown>) {
    super();
  }

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (!this.emitted && eventName === 'data') {
      this.emitted = true;
      listener(Buffer.from(JSON.stringify({
        event: 'backend.ready',
        payload: {
          sdkPath: '/mock/sdk',
          agentDir: '/mock/agent',
          sdkVersion: '0.0.0-test',
          protocolVersion: PROTOCOL_VERSION,
          authPath: '/mock/auth.json',
          ...(this.analyticsActivation ? { analyticsActivation: this.analyticsActivation } : {}),
          ...(this.analyticsContext ? { analyticsContext: this.analyticsContext } : {}),
        },
      }) + '\n'));
    }
    return result;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout: PassThrough;
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killCount = 0;

  constructor(analyticsActivation?: Record<string, unknown>, analyticsContext?: Record<string, unknown>) {
    super();
    this.stdout = new ImmediateReadyStream(analyticsActivation, analyticsContext);
  }

  kill(): boolean {
    this.killCount += 1;
    this.emit('exit', 0);
    return true;
  }
}

class NeverReadyChildProcess extends FakeChildProcess {
  override readonly stdout = new PassThrough();
}

class DrainingChildProcess extends FakeChildProcess {
  readonly requestSeen: Promise<void>;
  private resolveRequestSeen!: () => void;
  private releaseAcceptedRequest!: () => void;
  private readonly acceptedRequestReleased: Promise<void>;
  private requestId = 'req-1';

  constructor() {
    super();
    this.requestSeen = new Promise<void>((resolve) => { this.resolveRequestSeen = resolve; });
    this.acceptedRequestReleased = new Promise<void>((resolve) => { this.releaseAcceptedRequest = resolve; });
    this.stdin.on('data', (chunk) => {
      const line = String(chunk);
      this.requestId = JSON.parse(line.trim()).id;
      this.resolveRequestSeen();
    });
    this.stdin.once('finish', () => {
      void this.acceptedRequestReleased.then(() => {
        this.stdout.write(`${JSON.stringify({ id: this.requestId, ok: true, result: {} })}\n`);
        setImmediate(() => this.emit('exit', 0));
      });
    });
  }

  releaseRequest(): void {
    this.releaseAcceptedRequest();
  }
}

test('BackendClient.start resolves when backend.ready arrives immediately as stdout listener attaches', async () => {
  // client.start spreads process.env into the spawn env, so a stale
  // PIE_TRUSTED_SDK_ROOT inherited from the parent environment would leak
  // through when the derived trusted root is undefined. Isolate the var so
  // the assertion below is deterministic regardless of the host environment.
  const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const previousDataRoot = process.env.PIE_DATA_DIR;
  const previousEditorVersion = process.env.PIE_EDITOR_VERSION;
  const previousWorkspaceSdkOptIn = process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK;
  delete process.env.PIE_TRUSTED_SDK_ROOT;
  delete process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK;
  const agentDir = path.resolve('/mock/agent');
  const dataRoot = path.join(agentDir, 'runtime-data');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = 'data/outcomes/sessions';
  process.env.PIE_DATA_DIR = dataRoot;

  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  const fakeProc = new FakeChildProcess();
  const noOrphans = async () => ({ candidates: [], reaped: [], failures: [] });
  let nextProc = fakeProc as unknown as cp.ChildProcess;
  let spawnOptions: cp.SpawnOptions | undefined;
  let spawnArgs: readonly string[] | undefined;
  const developmentEvents: string[] = [];
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'node:child_process' || request === 'child_process') {
      return {
        ...cp,
        spawn: ((_command: string, args?: readonly string[], options?: cp.SpawnOptions) => {
          spawnArgs = args;
          spawnOptions = options;
          developmentEvents.push('spawn');
          return nextProc;
        }) as typeof cp.spawn,
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  const { BackendClient } = await import('../../agent-connection/client');
  const client = new BackendClient({ editorVersion: '1.102.3-test', orphanReaper: noOrphans });
  const sourceArtifactDescriptor = {
    schemaVersion: 1,
    artifactDir: '/mock/pi-runtime',
    sdkPath: '/mock/sdk',
    cliPath: '/mock/sdk/dist/cli.js',
    identity: 'a'.repeat(64),
    manifest: {} as GenerationPiRuntimeDescriptor['manifest'],
  } as GenerationPiRuntimeDescriptor;
  try {
    const payload = await client.start({
      nodePath: '/mock/node',
      backendPath: '/mock/backend.js',
      sdkPath: '/mock/sdk',
      sourceArtifactDescriptor,
      cwd: '/mock/cwd',
    });

    assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
    assert.equal(payload.sdkPath, '/mock/sdk');
    assert.deepEqual(spawnArgs?.slice(-6), [
      '--hostPid', String(process.pid),
      '--backendGeneration', '1',
      '--lifetimeFd', '3',
    ]);
    const sourceDescriptorIndex = spawnArgs?.indexOf('--sourceArtifactDescriptor') ?? -1;
    assert.ok(sourceDescriptorIndex >= 0, 'the source artifact descriptor is passed explicitly on the CLI');
    assert.equal(spawnArgs?.[sourceDescriptorIndex + 1], JSON.stringify(sourceArtifactDescriptor));
    assert.equal(spawnArgs?.includes('--sdkRuntimeSelection'), false,
      'production keeps its source-artifact CLI route unchanged');
    assert.deepEqual(spawnOptions?.stdio, ['pipe', 'pipe', 'pipe', 'pipe']);
    assert.equal((spawnOptions?.env as NodeJS.ProcessEnv | undefined)?.PIE_EDITOR_VERSION, '1.102.3-test');
    assert.equal((spawnOptions?.env as NodeJS.ProcessEnv | undefined)?.PIE_TRUSTED_SDK_ROOT, undefined);

    const observedEvents: string[] = [];
    const eventSubscription = client.onEvent((event) => observedEvents.push(event.event));
    fakeProc.stdout.write(JSON.stringify({ event: 'test.event', payload: {} }) + '\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(observedEvents, ['test.event']);
    eventSubscription.dispose();
    fakeProc.stdout.write(JSON.stringify({ event: 'test.event.after-dispose', payload: {} }) + '\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(observedEvents, ['test.event'], 'disposed event subscriptions stop receiving backend events');
    const spawnedEnv = spawnOptions?.env as NodeJS.ProcessEnv | undefined;
    assert.equal(spawnedEnv?.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(spawnedEnv?.PI_CODING_AGENT_SESSION_DIR, path.join(agentDir, 'data/outcomes/sessions'));
    assert.equal(spawnedEnv?.PIE_REVIEWS_DIR, path.join(agentDir, 'data/outcomes/session-reviews'));
    assert.equal(spawnedEnv?.PIE_SESSION_SETTINGS_DIR, path.join(dataRoot, 'state/session-settings'));
    assert.equal(spawnedEnv?.PIE_LEGACY_SESSION_SETTINGS_DIR, path.join(agentDir, 'data/outcomes/session-reviews'));
    assert.equal(spawnedEnv?.PIE_DATA_DIR, dataRoot);
    assert.equal(spawnedEnv?.PIE_CACHE_DIR, path.join(dataRoot, 'cache'));

    // A standalone client must not inherit a stale editor marker from its
    // parent process when no VS Code composition metadata is supplied.
    process.env.PIE_EDITOR_VERSION = 'stale-vscode-version';
    const standaloneProc = new DrainingChildProcess();
    nextProc = standaloneProc as unknown as cp.ChildProcess;
    const standaloneClient = new BackendClient({ orphanReaper: noOrphans });
    await standaloneClient.start({
      nodePath: '/mock/node',
      backendPath: '/mock/backend.js',
      sdkPath: '/mock/sdk',
      cwd: '/mock/cwd',
    });
    assert.equal((spawnOptions?.env as NodeJS.ProcessEnv | undefined)?.PIE_EDITOR_VERSION, undefined);
    const standaloneStop = standaloneClient.stop();
    standaloneProc.releaseRequest();
    await standaloneStop;

    const activation = {
      generationId: '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f',
      buildId: 'build-1',
      manifestRevision: 4,
      manifestSha256: 'a'.repeat(64),
      workspaceId: 'workspace-1',
      hostInstanceId: 'host-1',
    };
    const descriptorProc = new FakeChildProcess(activation);
    nextProc = descriptorProc as unknown as cp.ChildProcess;
    const descriptorClient = new BackendClient({ orphanReaper: noOrphans });
    const descriptorPayload = await descriptorClient.start({
      nodePath: '/mock/node',
      backendPath: '/mock/backend.js',
      sdkPath: '/mock/sdk',
      cwd: '/mock/cwd',
      analyticsActivation: activation,
    });
    assert.deepEqual(descriptorPayload.analyticsActivation, activation);
    assert.deepEqual(spawnArgs?.slice(-12), [
      '--analyticsGenerationId', activation.generationId,
      '--analyticsBuildId', activation.buildId,
      '--analyticsManifestRevision', '4',
      '--analyticsManifestSha256', activation.manifestSha256,
      '--analyticsWorkspaceId', activation.workspaceId,
      '--analyticsHostInstanceId', activation.hostInstanceId,
    ]);
    descriptorClient.dispose();

    const mismatchedActivation = { ...activation, workspaceId: 'workspace-other' };
    const mismatchedProc = new FakeChildProcess(mismatchedActivation);
    nextProc = mismatchedProc as unknown as cp.ChildProcess;
    const mismatchedClient = new BackendClient({ orphanReaper: noOrphans });
    let mismatchedReadyEvents = 0;
    const mismatchedEvents = mismatchedClient.onEvent((event) => {
      if (event.event === 'backend.ready') mismatchedReadyEvents += 1;
    });
    await assert.rejects(
      mismatchedClient.start({
        nodePath: '/mock/node',
        backendPath: '/mock/backend.js',
        sdkPath: '/mock/sdk',
        cwd: '/mock/cwd',
        analyticsActivation: activation,
      }),
      /analytics activation descriptor mismatch/u,
    );
    assert.equal(mismatchedReadyEvents, 0, 'a mismatched ready payload is rejected before public event delivery');
    assert.equal(mismatchedProc.killCount, 1, 'the mismatched child is stopped before it can rearm consumers');
    mismatchedEvents.dispose();
    mismatchedClient.dispose();

    const context = { mode: 'canonical-only' as const, generationId: 'capture', buildId: 'capture-build', workspaceId: 'workspace', hostInstanceId: 'host' };
    nextProc = new FakeChildProcess(undefined, context) as unknown as cp.ChildProcess;
    const contextClient = new BackendClient({ orphanReaper: noOrphans });
    const ready = await contextClient.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd', analyticsContext: context });
    assert.deepEqual(ready.analyticsContext, context);
    assert.deepEqual(spawnArgs?.slice(-2), ['--analyticsContext', JSON.stringify(context)]);
    contextClient.dispose();
    for (const received of [{ ...context, hostInstanceId: 'other' }, { mode: 'canonical-only', generationId: 'capture' }]) {
      const proc = new FakeChildProcess(undefined, received);
      nextProc = proc as unknown as cp.ChildProcess;
      const rejectedClient = new BackendClient({ orphanReaper: noOrphans });
      await assert.rejects(rejectedClient.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd', analyticsContext: context }), /analytics context mismatch/);
      assert.equal(proc.killCount, 1);
      rejectedClient.dispose();
    }

    const correlatedFailures: any[] = [];
    const failureSubscription = client.onDidCorrelatedRequestFail((failure) => correlatedFailures.push(failure));
    const rejected = client.request('session.open', { sessionPath: '/mock/failure.jsonl' });
    fakeProc.stdout.write(JSON.stringify({
      id: 'req-1', ok: false, error: { code: 'SESSION_OPEN_FAILED', message: 'open failed' },
    }) + '\n');
    await assert.rejects(rejected, (error: any) => {
      assert.equal(error.name, 'BackendRpcError');
      assert.equal(error.requestId, 'req-1');
      assert.equal(error.code, 'SESSION_OPEN_FAILED');
      return true;
    });
    assert.deepEqual(correlatedFailures, [{
      backendGeneration: 1,
      requestId: 'req-1',
      method: 'session.open',
      code: 'SESSION_OPEN_FAILED',
      message: 'open failed',
      sessionPath: '/mock/failure.jsonl',
      incident: {
        incidentId: 'rpc:req-1',
        dedupeKey: 'request:req-1',
        sessionPath: '/mock/failure.jsonl',
        requestId: 'req-1',
        severity: 'error',
        certainty: 'definitive',
        phase: 'acceptance',
        code: 'SESSION_OPEN_FAILED',
        message: 'open failed',
        recovery: { retry: true, restart: false, showLogs: true },
      },
    }]);
    failureSubscription.dispose();

    // A destructive RPC may outlive the application-level waiter. Preserve
    // the exact req-N correlation after RequestTimeoutError so the host can
    // distinguish a late commit acknowledgement from an unknown outcome.
    const lateResponses: unknown[] = [];
    const delayedTruncate = client.request<{ sessionPath: string }>(
      'session.truncateAfter',
      { sessionPath: '/mock/edit.jsonl', entryId: 'message-to-replace' },
      {
        timeoutMs: 5,
        onCorrelatedResponse: (response) => lateResponses.push(response),
      },
    );
    await assert.rejects(delayedTruncate, /Timed out waiting for response to req-2/);
    assert.deepEqual(lateResponses, [], 'the local timeout is not fabricated as a backend response');
    fakeProc.stdout.write(JSON.stringify({
      id: 'req-2', ok: true, result: { sessionPath: '/mock/edit.jsonl' },
    }) + '\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(lateResponses, [{
      ok: true,
      result: { sessionPath: '/mock/edit.jsonl' },
    }]);

    const drainingProc = new DrainingChildProcess();
    nextProc = drainingProc as unknown as cp.ChildProcess;
    const drainingClient = new BackendClient({ orphanReaper: noOrphans });
    await drainingClient.start({
      nodePath: '/mock/node',
      backendPath: '/mock/backend.js',
      sdkPath: '/mock/sdk',
      cwd: '/mock/cwd',
    });
    const acceptedWrite = drainingClient.request('settings.set', { defaultThinkingLevel: 'high' });
    await drainingProc.requestSeen;
    let stopSettled = false;
    const gracefulStop = drainingClient.stop().then(() => { stopSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopSettled, false, 'stop waits while an accepted settings write is draining');
    drainingProc.releaseRequest();
    await Promise.all([acceptedWrite, gracefulStop]);
    assert.equal(stopSettled, true);
    assert.equal(drainingProc.killCount, 0, 'a responsive backend exits through stdin EOF without forced termination');
    assert.equal(drainingClient.isRuntimeLifetimeTeardownConfirmed(), true,
      'orderly stdin-drain completion confirms generation lifetime');

    const forceProc = new FakeChildProcess();
    nextProc = forceProc as unknown as cp.ChildProcess;
    await drainingClient.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });
    assert.equal(drainingClient.isRuntimeLifetimeTeardownConfirmed(), false, 'a live generation is unconfirmed');
    forceProc.stdin.destroy();
    await drainingClient.stop();
    assert.equal(forceProc.killCount, 1);
    assert.equal(drainingClient.isRuntimeLifetimeTeardownConfirmed(), false,
      'forced exit, even with code 0, confirms only coordinator exit');
    const replacementProc = new DrainingChildProcess();
    nextProc = replacementProc as unknown as cp.ChildProcess;
    await drainingClient.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });
    replacementProc.releaseRequest();
    await drainingClient.stop();
    assert.equal(drainingClient.isRuntimeLifetimeTeardownConfirmed(), false,
      'a later clean restart cannot erase an earlier uncertain generation');
    drainingClient.dispose();

    developmentEvents.length = 0;
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'pie-sdk-workspace-reader-'));
    try {
      process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK = '1';
      const developmentProc = new DrainingChildProcess();
      nextProc = developmentProc as unknown as cp.ChildProcess;
      const developmentClient = new BackendClient({
        orphanReaper: noOrphans,
        developmentReaderAcquirer: async (root) => {
          developmentEvents.push(`acquire:${root}`);
          return {
            release: async ({ teardownConfirmed }) => {
              developmentEvents.push(`release:${teardownConfirmed}`);
            },
          };
        },
      });
      await developmentClient.start({
        nodePath: '/mock/node',
        backendPath: '/mock/backend.js',
        sdkPath: path.join(workspaceRoot, 'packages', 'coding-agent'),
        sdkRuntimeSelection: { kind: 'workspace-development', workspaceRoot },
        cwd: '/mock/cwd',
      });
      assert.deepEqual(developmentEvents.slice(0, 2), [`acquire:${await realpath(workspaceRoot)}`, 'spawn'],
        'the Pi workspace reader must be acquired before a backend can import the SDK');
      const selectionIndex = spawnArgs?.indexOf('--sdkRuntimeSelection') ?? -1;
      assert.ok(selectionIndex >= 0, 'workspace selection is an explicit backend argument');
      assert.deepEqual(JSON.parse(spawnArgs?.[selectionIndex + 1] ?? 'null'), {
        kind: 'workspace-development', workspaceRoot,
      });
      await developmentClient.releaseDevelopmentReaders(false);
      assert.equal(developmentEvents.at(-1), 'release:false', 'uncertain runtime lifetime is retained by the reader API');
      const developmentStop = developmentClient.stop();
      developmentProc.releaseRequest();
      await developmentStop;
      assert.equal(developmentClient.isRuntimeLifetimeTeardownConfirmed(), true);
      await developmentClient.releaseDevelopmentReaders(true);
      assert.equal(developmentEvents.at(-1), 'release:true', 'confirmed owned shutdown releases the SDK reader');
      developmentClient.dispose();

      developmentEvents.length = 0;
      const concurrentProc = new DrainingChildProcess();
      nextProc = concurrentProc as unknown as cp.ChildProcess;
      let resolveConcurrentReader!: (reader: { release(options: { teardownConfirmed: boolean }): Promise<void> }) => void;
      let signalConcurrentAcquire!: () => void;
      const concurrentAcquireStarted = new Promise<void>((resolve) => { signalConcurrentAcquire = resolve; });
      const concurrentReader = new Promise<{ release(options: { teardownConfirmed: boolean }): Promise<void> }>(
        (resolve) => { resolveConcurrentReader = resolve; },
      );
      let concurrentAcquireCount = 0;
      const concurrentClient = new BackendClient({
        readyTimeoutMs: 30,
        orphanReaper: noOrphans,
        developmentReaderAcquirer: async (root) => {
          concurrentAcquireCount += 1;
          developmentEvents.push(`acquire:${root}`);
          signalConcurrentAcquire();
          return concurrentReader;
        },
      });
      const concurrentOptions = {
        nodePath: '/mock/node',
        backendPath: '/mock/backend.js',
        sdkPath: path.join(workspaceRoot, 'packages', 'coding-agent'),
        sdkRuntimeSelection: { kind: 'workspace-development' as const, workspaceRoot },
        cwd: '/mock/cwd',
      };
      const firstConcurrentStart = concurrentClient.start(concurrentOptions);
      await concurrentAcquireStarted;
      const secondConcurrentStart = concurrentClient.start(concurrentOptions);
      resolveConcurrentReader({
        release: async ({ teardownConfirmed }) => { developmentEvents.push(`release:${teardownConfirmed}`); },
      });
      const concurrentOutcomes = await Promise.allSettled([firstConcurrentStart, secondConcurrentStart]);
      assert.equal(concurrentOutcomes[0]?.status, 'fulfilled');
      assert.equal(concurrentOutcomes[1]?.status, 'rejected');
      if (concurrentOutcomes[1]?.status === 'rejected') {
        assert.match(String(concurrentOutcomes[1].reason), /Backend is already running/u);
      }
      assert.equal(concurrentAcquireCount, 1, 'concurrent starts share the synchronous startup reservation');
      assert.equal(developmentEvents.filter((event) => event === 'spawn').length, 1,
        'only the reserved start may spawn, leaving no orphaned second backend');
      const concurrentStop = concurrentClient.stop();
      concurrentProc.releaseRequest();
      await concurrentStop;
      await concurrentClient.releaseDevelopmentReaders(true);
      concurrentClient.dispose();

      developmentEvents.length = 0;
      const retryWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'pie-sdk-workspace-retry-'));
      try {
        let retryAcquisitions = 0;
        const retryProc = new DrainingChildProcess();
        nextProc = retryProc as unknown as cp.ChildProcess;
        const retryClient = new BackendClient({
          orphanReaper: noOrphans,
          developmentReaderAcquirer: async () => {
            retryAcquisitions += 1;
            if (retryAcquisitions === 1) throw new Error('synthetic reader acquisition failure');
            return { release: async ({ teardownConfirmed }) => { developmentEvents.push(`release:${teardownConfirmed}`); } };
          },
        });
        const retryOptions = {
          nodePath: '/mock/node',
          backendPath: '/mock/backend.js',
          sdkPath: path.join(retryWorkspaceRoot, 'packages', 'coding-agent'),
          sdkRuntimeSelection: { kind: 'workspace-development' as const, workspaceRoot: retryWorkspaceRoot },
          cwd: '/mock/cwd',
        };
        await assert.rejects(retryClient.start(retryOptions), /synthetic reader acquisition failure/u);
        await retryClient.start(retryOptions);
        assert.equal(retryAcquisitions, 2, 'a failed reader acquisition clears the reservation for retry');
        assert.equal(developmentEvents.filter((event) => event === 'spawn').length, 1);
        const retryStop = retryClient.stop();
        retryProc.releaseRequest();
        await retryStop;
        await retryClient.releaseDevelopmentReaders(true);
        retryClient.dispose();
      } finally {
        await rm(retryWorkspaceRoot, { recursive: true, force: true });
      }

      developmentEvents.length = 0;
      let resolveStoppedReader!: (reader: { release(options: { teardownConfirmed: boolean }): Promise<void> }) => void;
      let signalStoppedAcquire!: () => void;
      const stoppedAcquireStarted = new Promise<void>((resolve) => { signalStoppedAcquire = resolve; });
      const stoppedReader = new Promise<{ release(options: { teardownConfirmed: boolean }): Promise<void> }>(
        (resolve) => { resolveStoppedReader = resolve; },
      );
      const stoppedClient = new BackendClient({
        orphanReaper: noOrphans,
        developmentReaderAcquirer: async () => {
          signalStoppedAcquire();
          return stoppedReader;
        },
      });
      const stoppedStart = stoppedClient.start({
        nodePath: '/mock/node',
        backendPath: '/mock/backend.js',
        sdkPath: path.join(workspaceRoot, 'packages', 'coding-agent'),
        sdkRuntimeSelection: { kind: 'workspace-development', workspaceRoot },
        cwd: '/mock/cwd',
      });
      await stoppedAcquireStarted;
      const pendingStartupStop = stoppedClient.stop();
      resolveStoppedReader({
        release: async ({ teardownConfirmed }) => { developmentEvents.push(`release:${teardownConfirmed}`); },
      });
      await assert.rejects(stoppedStart, /Backend start was cancelled/u);
      await pendingStartupStop;
      assert.equal(developmentEvents.filter((event) => event === 'spawn').length, 0,
        'stop cancels and joins pending reader acquisition before a child can become untracked');
      assert.deepEqual(developmentEvents, ['release:true'],
        'the never-spawned attempt releases its newly acquired reader before stop settles');
      stoppedClient.dispose();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }

    const unexpectedProc = new FakeChildProcess();
    nextProc = unexpectedProc as unknown as cp.ChildProcess;
    const unexpectedClient = new BackendClient({ orphanReaper: noOrphans });
    assert.equal(unexpectedClient.isRuntimeLifetimeTeardownConfirmed(), true, 'no child ever spawned is safe');
    await unexpectedClient.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });
    unexpectedProc.emit('exit', 0);
    await unexpectedClient.stop();
    assert.equal(unexpectedClient.isRuntimeLifetimeTeardownConfirmed(), false, 'arbitrary exit 0 is not complete-drain evidence');
    unexpectedClient.dispose();

    const failedSpawnProc = new NeverReadyChildProcess();
    nextProc = failedSpawnProc as unknown as cp.ChildProcess;
    const failedSpawnClient = new BackendClient({ orphanReaper: noOrphans });
    const failedSpawn = failedSpawnClient.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });
    failedSpawnProc.emit('error', new Error('ENOENT'));
    await assert.rejects(failedSpawn, /ENOENT/);
    await failedSpawnClient.stop();
    assert.equal(failedSpawnClient.isRuntimeLifetimeTeardownConfirmed(), true, 'OS spawn failure with no PID consumed no child lifetime');
    failedSpawnClient.dispose();

    const unknownProc = new NeverReadyChildProcess();
    Object.defineProperty(unknownProc, 'pid', { value: 424242 }); // synthetic only
    nextProc = unknownProc as unknown as cp.ChildProcess;
    const unknownClient = new BackendClient({ orphanReaper: noOrphans });
    const unknownStart = unknownClient.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });
    unknownProc.emit('error', new Error('synthetic error after PID allocation'));
    await assert.rejects(unknownStart, /after PID allocation/);
    assert.equal(unknownClient.isRuntimeLifetimeTeardownConfirmed(), false,
      'error after PID allocation is not evidence that the owned tree exited');
    const afterUnknownProc = new DrainingChildProcess();
    nextProc = afterUnknownProc as unknown as cp.ChildProcess;
    await unknownClient.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });
    afterUnknownProc.releaseRequest();
    await unknownClient.stop();
    assert.equal(unknownClient.isRuntimeLifetimeTeardownConfirmed(), false,
      'a previous unconfirmed generation remains pending after a clean replacement');
    unknownProc.emit('exit', 0);
    assert.equal(unknownClient.isRuntimeLifetimeTeardownConfirmed(), false,
      'late arbitrary exit of the earlier generation cannot become orderly drain evidence');
    unknownClient.dispose();

    Object.defineProperty(fakeProc.stdin, 'write', {
      configurable: true,
      value: () => { throw new Error('EPIPE'); },
    });
    await assert.rejects(client.request('app.ping'), /Failed to write backend request req-3: EPIPE/);

    client.dispose();
    const stalledProc = new NeverReadyChildProcess();
    nextProc = stalledProc as unknown as cp.ChildProcess;
    const stalledClient = new BackendClient({ readyTimeoutMs: 5, orphanReaper: noOrphans });
    try {
      await assert.rejects(
        stalledClient.start({
          nodePath: '/mock/node',
          backendPath: '/mock/backend.js',
          sdkPath: '/mock/sdk',
          cwd: '/mock/cwd',
        }),
        /Timed out waiting for the pie backend to become ready/,
      );
      assert.equal(stalledProc.killCount, 1, 'a startup timeout terminates the unusable child');
      assert.equal(stalledClient.isRuntimeLifetimeTeardownConfirmed(), false, 'forced startup failure retains lifetime uncertainty');
      await assert.rejects(stalledClient.request('app.ping'), /Backend is not running/);
    } finally {
      stalledClient.dispose();
    }
  } finally {
    client.dispose();
    moduleWithLoad._load = originalLoad;
    if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
    else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    if (previousDataRoot === undefined) delete process.env.PIE_DATA_DIR;
    else process.env.PIE_DATA_DIR = previousDataRoot;
    if (previousEditorVersion === undefined) delete process.env.PIE_EDITOR_VERSION;
    else process.env.PIE_EDITOR_VERSION = previousEditorVersion;
    if (previousWorkspaceSdkOptIn === undefined) delete process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK;
    else process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK = previousWorkspaceSdkOptIn;
  }
});
