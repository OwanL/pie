import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { BackendServer } from '../server.js';
import { loadSdk } from '../../lib/sdk-integration/sdk.js';
import { sourceDescriptor, sourceLoadMode } from '../../lib/sdk-integration/test/source-fixture.js';
import { ColdSessionStore } from '../../../session-storage/lifecycle/cold-session-store.js';
import { getAdmissionFallbackTitle } from '../../../session-storage/metadata/session-title.js';
import { LiveSessionTitles } from '../live-session-titles.js';

test('real SDK restored untitled sessions are durable, addressable, and replaceable across coordinator generations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-admission-titles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sdk = await loadSdk(sourceDescriptor.sdkPath, { ...sourceLoadMode, surface: 'cold' });
  const paths = ['a', 'b'].map((id) => path.join(root, `${id}.jsonl`));
  for (const [index, sessionPath] of paths.entries()) {
    await fs.writeFile(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id: `admission-${index}`,
      cwd: root, timestamp: '2026-10-18T00:00:00.000Z' })}\n`);
  }
  let revision = 0;
  async function restoredServer() {
    const server = new BackendServer({ sdkPath: sourceDescriptor.sdkPath, sourceArtifactDescriptor: sourceDescriptor,
      cwd: root, workerEntryPath: path.join(root, 'unused-worker.js') });
    t.after(() => server.dispose());
    const internal = server as unknown as {
      sdk: typeof sdk;
      coldSessionStore: ColdSessionStore;
      emitSessionListChanged(): Promise<void>;
      applyHostLiveMembership(snapshot: unknown): void;
      titleNamespaceHydration?: Promise<void>;
      liveSessionTitles: LiveSessionTitles;
      handleWorkerSessionControl(frame: unknown, source: string): Promise<{ result: Record<string, unknown> }>;
      finalizeGeneratedLiveSessionTitle(path: string, prompt: string, generation: object, requestId: string): Promise<unknown>;
      resolveSessionControlTarget(action: string, payload: object, source: string): { sessionPath: string };
    };
    internal.sdk = sdk;
    internal.coldSessionStore = new ColdSessionStore({ sdk, coordinatorGeneration: 1, startupCwd: root, agentDir: root, sessionDir: root });
    // Keep this fixture on live-title authority, not unrelated archive discovery.
    internal.emitSessionListChanged = async () => undefined;
    internal.applyHostLiveMembership({ revision: ++revision, timestamp: Date.now(), closing: [],
      sessions: paths.map((sessionPath) => ({ path: sessionPath, name: 'New Session', activity: 'idle' })) });
    await internal.titleNamespaceHydration;
    assert.equal(internal.liveSessionTitles.ready, true);
    return internal;
  }
  const first = await restoredServer();
  assert.equal(first.liveSessionTitles.assigned(paths[0]), 'New Session');
  assert.equal(first.liveSessionTitles.assigned(paths[1]), 'New Session (2)');
  for (const sessionPath of paths) {
    const manager = sdk.SessionManager.open(sessionPath);
    assert.equal(getAdmissionFallbackTitle(manager), first.liveSessionTitles.assigned(sessionPath));
    const title = first.liveSessionTitles.assigned(sessionPath)!;
    for (const action of ['read', 'message', 'settings.get', 'settings.set', 'close']) {
      assert.equal(first.resolveSessionControlTarget(action, { title }, paths[0]).sessionPath, sessionPath);
    }
  }
  const before = await Promise.all(paths.map((sessionPath) => fs.readFile(sessionPath, 'utf8')));
  const second = await restoredServer();
  assert.deepEqual(await Promise.all(paths.map((sessionPath) => fs.readFile(sessionPath, 'utf8'))), before,
    'restart preserves the exact durable titles without another write');
  const listed = await second.handleWorkerSessionControl({ action: 'list', requestId: 'list', payload: {} }, paths[0]);
  assert.deepEqual((listed.result.sessions as Array<{ title: string }>).map((row) => row.title), ['New Session', 'New Session (2)']);
  assert.deepEqual(await second.finalizeGeneratedLiveSessionTitle(paths[0], 'Fix login',
    { generated: true, name: 'Fix Login' }, 'generated'), { generated: true, name: 'Fix Login' });
  assert.equal(sdk.SessionManager.open(paths[0]).getSessionName(), 'Fix Login');
  assert.equal(getAdmissionFallbackTitle(sdk.SessionManager.open(paths[0])), undefined);
  assert.equal(second.liveSessionTitles.resolve('New Session'), undefined);
  assert.deepEqual(await second.finalizeGeneratedLiveSessionTitle(paths[1], 'Investigate login',
    { generated: false, reason: 'timeout' }, 'failed'), { generated: true, reason: 'timeout', name: 'Investigate login' });
  assert.equal(getAdmissionFallbackTitle(sdk.SessionManager.open(paths[1])), undefined);
  await second.finalizeGeneratedLiveSessionTitle(paths[1], 'Do not rename again', { generated: true, name: 'Later' }, 'later');
  assert.equal(sdk.SessionManager.open(paths[1]).getSessionName(), 'Investigate login', 'generation-failure title stays stable');
});
