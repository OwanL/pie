import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BackendServer } from '../server.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { DurableDetailStore } from '../../../session-storage/transcripts/durable-detail-store.js';
import { STORAGE_CUTOFF_AUTHORIZATION_ENV, STORAGE_CUTOFF_AUTHORIZATION_VALUE } from '../../../../analytics/authority/storage-cutoff-authorization.js';

for (const deferred of [false, true]) test(`lifecycle cleanup invalidates ${deferred ? 'pending' : 'cached'} detail and fences retained/hot fallback admission`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pie-lifecycle-detail-'));
  const oldRoot = process.env.PIE_DATA_DIR;
  const oldAuthorization = process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
  process.env.PIE_DATA_DIR = root;
  process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = STORAGE_CUTOFF_AUTHORIZATION_VALUE;
  let server: any;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const sessions = path.join(root, 'sessions');
    await mkdir(sessions, { recursive: true });
    const sessionPath = path.join(sessions, 'session.jsonl'); // deliberately absent
    server = new BackendServer({
      analyticsContext: { mode: 'canonical-only', generationId: 'test', buildId: 'test', workspaceId: 'test', hostInstanceId: 'test' },
      sdkPath: '/sdk', sourceArtifactDescriptor: createSyntheticSourceTestSdkRuntime(path.resolve('/sdk')).descriptor,
      cwd: root, agentDir: root, workerEntryPath: '/worker.js',
    });
    const { store } = server.initializeFilesystemLifecycle();
    await server.lifecycleScheduler.stop();
    store.registerTranscript('session', 'session.jsonl', 1);
    store.registerArtifact({ sessionId: 'session', artifactId: 'transcript', kind: 'transcript', locationKind: 'root_relative', rootName: 'sessions', location: 'session.jsonl' }, 1);
    store.resolveClose('session', 'close', 2);
    const emitted: any[] = [];
    server.durableDetailStore = new DurableDetailStore({
      resolve: async () => { if (deferred) await gate; return { value: { text: 'fixture' }, sizeBytes: 20, messageId: 'm', toolCallId: 't', kind: 'tool-result' }; },
      emit: (message: any) => { emitted.push(message); return true; },
    });
    let hot = false;
    let onSubscribe = async () => { throw new Error('NOT_FOUND: gone'); };
    server.workerRuntimeRouter = { hasHotOwner: () => hot, subscribeDetail: () => onSubscribe() };
    const address = { sessionPath, turnId: 'turn', rootToolCallId: 't', rootAttemptId: 'attempt', lineage: [] };
    const params = { subscriptionId: 's', address, maxPageBytes: 4096 };
    // Retained public history remains readable, even when the transcript is absent.
    const pending = server.routeDetailSubscribe('s', params);
    if (!deferred) await pending;
    else await new Promise(resolve => setImmediate(resolve));
    const page = emitted.find(message => message.kind === 'detail.page');
    if (!deferred) assert.ok(page);
    // Exercise the actual cleaner wired by the server's scheduler.
    await server.lifecycleScheduler.options.cleaner.cleanupSession('session', 'cleanup');
    release();
    await pending;
    assert.deepEqual(server.durableDetailStore.debugState(), { sources: 0, subscriptions: 0, canonicalBytes: 0 });
    const alias = { ...address, sessionPath: path.join(sessions, 'nested', '..', 'session.jsonl') };
    await assert.rejects(server.routeDetailSubscribe('after', { ...params, address: alias }), /deleted/);
    await assert.rejects(server.routeDetailFetch('fetch', { ...params, address: alias, ref: page?.ref }), /deleted/);
    assert.equal(store.get('session').cleanupState, 'deleted');
    // A lifecycle transition while waiting for a live owner must be rechecked
    // before the durable fallback can admit any work.
    store.registerTranscript('second', 'second.jsonl', 1);
    store.registerArtifact({ sessionId: 'second', artifactId: 'transcript', kind: 'transcript', locationKind: 'root_relative', rootName: 'sessions', location: 'second.jsonl' }, 1);
    hot = true;
    onSubscribe = async () => {
      store.resolveClose('second', 'close-second', 2);
      store.claimCleanup('second', 'cleanup-second', 86_400_003);
      store.markCleanupBlocked('second', 'cleanup-second', 'failure', 4);
      throw new Error('NOT_FOUND: gone');
    };
    await assert.rejects(server.routeDetailSubscribe('fallback', { ...params, address: { ...address, sessionPath: path.join(sessions, 'second.jsonl') } }), /deleted/);
  } finally {
    release();
    server?.durableDetailStore?.dispose();
    await server?.lifecycleScheduler?.stop();
    server?.lifecycleStore?.close();
    if (oldRoot === undefined) delete process.env.PIE_DATA_DIR; else process.env.PIE_DATA_DIR = oldRoot;
    if (oldAuthorization === undefined) delete process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV]; else process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = oldAuthorization;
    await rm(root, { recursive: true, force: true });
  }
});
