import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { loadSdk } from '../../lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../lib/sdk-integration/test/source-fixture';
import { createSourceArtifactTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection';
import { WorkerRuntimeHost } from '../worker-runtime-host';
import { WorkerRuntimeRouter } from '../../coordinator/worker-runtime-router';
import { WORKER_IPC_VERSION, parseWorkerToCoordinatorFrame } from '../../lib/rpc/worker-protocol';
import { BackendLiveTurnAccumulator } from '../live-turn-accumulator';
import { createInitialArchState } from '../../../../application/backend/conversation-state/arch-state';
import { reducer } from '../../../../application/backend/conversation-state/reducer';
import { selectViewState } from '../../../../application/backend/conversation-state/projections/projection';
import { SessionServiceEvents } from '../../../../application/backend/session-actions/events';
import { SessionServiceState } from '../../../../application/backend/session-actions/state';
import { BackendClient } from '../../../../application/backend/agent-connection/client';
import { NOOP_RUN_OBSERVER } from '../../../../application/backend/analytics-views';

// Exercise native persistence/subscription -> worker IPC validation -> router ->
// host handlers/reducer -> frontend ViewState. No provider calls or credentials.
for (const stopReason of ['stop', 'error'] as const) {
  test(`native worker ${stopReason} events preserve the public alias through frontend projection`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-public-address-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const canonicalDir = path.join(root, 'sessions');
    const aliasDir = path.join(root, 'public-sessions');
    fs.mkdirSync(canonicalDir);
    fs.symlinkSync(canonicalDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode);
    const { sdkRuntime } = await createSourceArtifactTestSdkRuntime(sourceDescriptor.artifactDir);
    const manager = sdk.SessionManager.create(root, canonicalDir);
    manager.appendThinkingLevelChange?.('off');
    await manager.flush?.();
    const canonicalPath = fs.realpathSync.native(manager.getSessionFile()!);
    const publicPath = path.join(aliasDir, path.basename(canonicalPath));
    const owner = { coordinatorGeneration: 1, workerId: 'public-address-worker', workerGeneration: 1 };
    const lease = { ...owner, canonicalSessionPath: canonicalPath, ownershipRevision: 1, nonce: 'offline-lease' };
    const summary = { path: publicPath, name: 'Alias fixture', cwd: root, modifiedAt: new Date(0).toISOString(), messageCount: 0 };
    const opened = { session: summary, transcript: [], transcriptWindow: {
      totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
    }, busy: false, runtimeReady: false };
    let state = createInitialArchState();
    state = { ...state, settings: { ...state.settings, backendReady: true }, sessions: {
      ...state.sessions, sessions: [summary], openTabPaths: [publicPath], activeSessionPath: publicPath,
    } };
    const dispatchArch = (event: any) => { state = reducer(state, event).state; };
    const serviceState = new SessionServiceState(new BackendClient(), () => undefined, () => state, dispatchArch);
    const events = new SessionServiceEvents({
      platform: { requestWindowAttention: () => undefined } as any,
      scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
      state: serviceState, dispatchArch, getArchState: () => state,
      triggers: { onSessionFinished: () => undefined } as any, getBackendGeneration: () => 1,
    });
    const forwarded: Array<{ event: string; payload: any }> = [];
    let router: WorkerRuntimeRouter;
    let seq = 0;
    const routing: Promise<void>[] = [];
    const server = {
      sendFrame(body: any) {
        const frame = JSON.parse(JSON.stringify({ ipcVersion: WORKER_IPC_VERSION, ...owner, workerPid: process.pid,
          rootSessionPath: publicPath, sessionPath: publicPath, leasePath: canonicalPath, leaseRevision: 1, seq: ++seq, ...body }));
        const parsed = parseWorkerToCoordinatorFrame(frame, { ...frame, expectedSeq: seq });
        assert.equal(parsed.status, 'accepted', parsed.status === 'invalid' ? parsed.detail : 'worker IPC rejected');
        const delivered = router.handleWorkerFrame(publicPath, frame);
        delivered.catch(() => undefined); // assertion below owns asynchronous failures
        routing.push(delivered);
        return true;
      },
      sendLiveSemanticFrame(payload: any) { return this.sendFrame({ kind: 'runtime.event', event: 'live.semantic', payload }); },
      sendRuntimeReportFrame: () => true, sendDetailFrame: () => true,
      onDetailDrain: () => () => undefined,
      requestFrame: async () => { throw new Error('No network or ownership replacement expected'); },
      failRuntime: (error: Error) => { throw error; },
    };
    const host = new WorkerRuntimeHost({ server: server as any, owner, sdkRuntime });
    const client = {
      getSnapshot: () => ({ status: 'ready', pid: process.pid }),
      requestFrame: async (body: any) => {
        if (body.kind === 'sync') { host.applySync(body.domain, body.revision, body.payload); return { kind: 'sync.ack', domain: body.domain, revision: body.revision }; }
        if (body.kind === 'runtime.promote') { await host.promote(body.payload); return { kind: 'runtime.ready' }; }
        throw new Error('Unexpected command');
      },
    };
    router = new WorkerRuntimeRouter({
      supervisor: { startWorker: async (_root: string, prepare: any) => {
        await prepare(owner); return { ...owner, sessionPath: publicPath, client };
      }, stopWorker: async () => undefined } as any,
      ownership: { registerHot: async () => lease, reconcileCrash: async () => undefined } as any,
      coldStore: { serializePromotionGrant: () => ({ grantId: 'offline-grant', creationReason: 'resume' }),
        consumePromotionGrant: () => undefined, abortPromotionGrant: () => undefined } as any,
      buildPromotionSnapshot: async () => ({ sdkPath: sourceDescriptor.sdkPath, sdkRuntime, agentDir,
        startupCwd: root, sessionDir: canonicalDir, openedPayload: opened,
        modelSettings: { defaultModel: '', defaultThinkingLevel: 'off' } }),
      emit: (event, payload) => {
        forwarded.push({ event, payload });
        events.handleBackendEvent({ type: 'event', event, payload } as any);
      },
    });
    try {
      await router.promote(publicPath);
      const context = (host as any).context;
      // Native SDK supplies the canonical manager path, while the host's tab
      // and operation remain addressed by the original public spelling.
      assert.equal(context.session.sessionManager.getSessionFile(), canonicalPath);
      context.activeRequest = { id: 'native-request', messageIndex: 0, aborted: false, modelId: 'offline-model', provider: 'offline',
        liveTurnAccumulator: new BackendLiveTurnAccumulator({ protocolVersion: 7, sessionPath: context.sessionPath,
          requestId: 'native-request', turnId: 'native-turn', attemptId: 'native-attempt', canonicalMessageId: 'native-request:1', startedAt: Date.now() }) };
      const session = context.session as any;
      const message = { role: 'assistant', content: stopReason === 'stop' ? [{ type: 'text', text: 'Hello' }] : [],
        api: 'openai-responses', provider: 'offline', model: 'offline-model', stopReason,
        ...(stopReason === 'error' ? { errorMessage: 'Offline provider failure' } : {}), timestamp: Date.now(),
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const user = { role: 'user', content: [{ type: 'text', text: 'Hello?' }], timestamp: Date.now() };
      await session._handleAgentEvent({ type: 'agent_start' });
      assert.ok(state.sessions.runningSessionPaths.includes(publicPath), 'SDK start owns the public busy address');
      await session._handleAgentEvent({ type: 'message_start', message: user });
      await session._handleAgentEvent({ type: 'message_end', message: user });
      await session._handleAgentEvent({ type: 'message_start', message });
      if (stopReason === 'stop') {
        await session._handleAgentEvent({ type: 'message_update', message,
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello', contentIndex: 0, partial: message } });
        assert.ok(selectViewState(state).transcript.some(row => row.role === 'assistant' && row.markdown === 'Hello'),
          'streamed assistant must appear in the selected frontend transcript');
      }
      await session._handleAgentEvent({ type: 'message_end', message });
      await session._emitAgentSettled();
      // Settlement launches one async authoritative transcript rebuild.
      for (let attempt = 0; attempt < 100 && !forwarded.some(frame => frame.event === 'session.opened' && frame.payload.transcript.length >= 2); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(forwarded.some(frame => frame.event === 'agent.settled' && frame.payload.sessionPath === publicPath));
      assert.ok(forwarded.filter(frame => frame.event === 'session.opened').every(frame => frame.payload.session.path === publicPath));
      await Promise.all(routing);
      const view = selectViewState(state);
      const reply = view.transcript.find(row => row.role === 'assistant');
      assert.ok(reply, 'durable assistant must appear in the selected frontend transcript');
      if (stopReason === 'stop') assert.equal(reply.markdown, 'Hello');
      else {
        assert.equal(reply.status, 'error');
        assert.match(reply.errorDetail ?? '', /Offline provider failure/);
      }
      assert.ok(!state.sessions.runningSessionPaths.includes(publicPath), 'settlement clears the public busy owner');
      assert.deepEqual(state.sessions.openTabPaths, [publicPath], 'canonical spelling must not create a second tab');
    } finally {
      await host.dispose();
    }
  });
}
