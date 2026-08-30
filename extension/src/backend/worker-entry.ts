import type { SdkPatchIdentity } from './sdk-patch-barrier';
import { validateSdkPatchBarrier } from './sdk-patch-barrier';
import { installProviderTrafficObserver } from './provider-traffic-observer';
import type { WorkerJsonObject, WorkerRuntimePromoteFrame } from './worker-protocol';
import { WorkerRuntimeHost, type WorkerRuntimePromotionPayload } from './worker-runtime-host';
import { openWorkerServerTransport, parseWorkerServerArgs, WorkerServer } from './worker-server';

function main(): void {
  // Provider traffic originates in the isolated worker, not the coordinator.
  // Install the observer in this process before promotion can load the SDK or
  // issue a provider fetch; otherwise HTTP/transport incidents never reach the
  // session that owns the request and the UI falls back to opaque SDK errors.
  installProviderTrafficObserver();
  const identity = parseWorkerServerArgs(process.argv.slice(2));
  let patchIdentity: SdkPatchIdentity | undefined;
  let host: WorkerRuntimeHost | undefined;
  const pendingSync = new Map<string, { revision: number; payload: WorkerJsonObject }>();
  const server = new WorkerServer(identity, process, openWorkerServerTransport(identity), {
    validateBootstrap: async (frame) => {
      await validateSdkPatchBarrier(frame.sdkPatchIdentity.sdkPath, frame.sdkPatchIdentity);
      patchIdentity = frame.sdkPatchIdentity;
    },
    onFrame: async (frame, currentServer) => {
      if (frame.kind === 'runtime.promote') {
        if (!patchIdentity) throw new Error('Worker runtime promotion arrived before SDK patch validation.');
        host ??= new WorkerRuntimeHost({
          server: currentServer,
          owner: {
            coordinatorGeneration: identity.coordinatorGeneration,
            workerId: identity.workerId,
            workerGeneration: identity.workerGeneration,
          },
          patchIdentity,
        });
        for (const [domain, sync] of pendingSync) host.applySync(domain, sync.revision, sync.payload);
        pendingSync.clear();
        await host.promote(frame.payload as WorkerRuntimePromoteFrame['payload'] & WorkerRuntimePromotionPayload);
        currentServer.sendFrame({
          kind: 'runtime.ready',
          requestId: frame.requestId,
          runtimeMetadata: { mode: 'phase4', startedAt: Date.now() },
        });
        return;
      }
      if (frame.kind === 'runtime.command') {
        if (!host) throw new Error('Runtime command arrived before promotion.');
        try {
          const publicRequestId = typeof frame.payload.publicRequestId === 'string'
            ? frame.payload.publicRequestId
            : frame.requestId;
          const result = await host.command(frame.operation, frame.payload as WorkerJsonObject, publicRequestId);
          currentServer.sendFrame({
            kind: 'response',
            requestId: frame.requestId,
            ok: true,
            result: { kind: 'runtime.command', payload: result },
          });
        } catch (error) {
          currentServer.sendFrame({
            kind: 'response',
            requestId: frame.requestId,
            ok: false,
            error: {
              code: 'RUNTIME_COMMAND_FAILED',
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            },
          });
        }
        return;
      }
      if (frame.kind === 'detail.subscribe') {
        if (!host) throw new Error('Detail subscription arrived before runtime promotion.');
        host.subscribeDetail(frame.requestId, frame.subscriptionId, frame.address, frame.cursor, frame.maxPageBytes);
        return;
      }
      if (frame.kind === 'detail.unsubscribe') {
        if (!host) throw new Error('Detail unsubscribe arrived before runtime promotion.');
        host.unsubscribeDetail(frame.requestId, frame.subscriptionId);
        return;
      }
      if (frame.kind === 'detail.fetch') {
        if (!host) throw new Error('Detail fetch arrived before runtime promotion.');
        host.fetchDetail(frame.requestId, frame.subscriptionId, frame.address, frame.ref, frame.maxPageBytes);
        return;
      }
      if (frame.kind === 'sync') {
        const payload = frame.payload as WorkerJsonObject;
        if (host) host.applySync(frame.domain, frame.revision, payload);
        else pendingSync.set(frame.domain, { revision: frame.revision, payload });
        return;
      }
      throw new Error(`Unsupported Phase 4 worker frame ${frame.kind}.`);
    },
    onInterrupt: async () => { await host?.interrupt(); },
    onShutdown: async () => { await host?.dispose(); },
  });
  server.start();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[pie-worker] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
