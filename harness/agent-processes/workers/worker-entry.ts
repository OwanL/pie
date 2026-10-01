import {
  sdkRuntimeSdkPath,
  verifySdkRuntimeSelection,
  type SdkRuntimeSelection,
} from '../lib/sdk-integration/sdk-runtime-selection.js';
import { installProviderTrafficObserver } from '../../model-providers/traffic-observation/provider-traffic-observer';
import type {
  WorkerError,
  WorkerErrorCode,
  WorkerJsonObject,
  WorkerRuntimePromoteFrame,
} from '../lib/rpc/worker-protocol.js';
import { WorkerRuntimeHost, type WorkerRuntimePromotionPayload } from './worker-runtime-host';
import { openWorkerServerTransport, parseWorkerServerArgs, WorkerServer } from '../lib/rpc/worker-server.js';

export function serializeRuntimeCommandError(error: unknown): WorkerError {
  const candidateCode = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const code: WorkerErrorCode = candidateCode === 'OPERATION_INTENT_MISMATCH'
    || candidateCode === 'AGENT_MESSAGE_PROVENANCE_UNAVAILABLE'
    ? candidateCode
    : 'RUNTIME_COMMAND_FAILED';
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function main(): void {
  // Provider traffic originates in the isolated worker, not the coordinator.
  // Install the observer in this process before promotion can load the SDK or
  // issue a provider fetch; otherwise HTTP/transport incidents never reach the
  // session that owns the request and the UI falls back to opaque SDK errors.
  installProviderTrafficObserver();
  const identity = parseWorkerServerArgs(process.argv.slice(2));
  let sdkRuntime: SdkRuntimeSelection | undefined;
  let host: WorkerRuntimeHost | undefined;
  const pendingSync = new Map<string, { revision: number; payload: WorkerJsonObject }>();
  const server = new WorkerServer(identity, process, openWorkerServerTransport(identity), {
    validateBootstrap: async (frame) => {
      const sdkPath = sdkRuntimeSdkPath(frame.sdkRuntime);
      sdkRuntime = await verifySdkRuntimeSelection(sdkPath, frame.sdkRuntime);
    },
    onFrame: async (frame, currentServer) => {
      if (frame.kind === 'runtime.promote') {
        if (!sdkRuntime) throw new Error('Worker runtime promotion arrived before SDK runtime validation.');
        host ??= new WorkerRuntimeHost({
          server: currentServer,
          owner: {
            coordinatorGeneration: identity.coordinatorGeneration,
            workerId: identity.workerId,
            workerGeneration: identity.workerGeneration,
          },
          sdkRuntime,
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
            error: serializeRuntimeCommandError(error),
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
      if (frame.kind === 'analytics.ack') {
        if (!host) return; // late acknowledgement after retirement is harmless
        host.acknowledgeAnalytics(frame.acknowledgement);
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
    onShutdown: async () => {
      const report = await host?.dispose();
      if (report?.status === 'timed-out') {
        const facts = report.facts;
        throw new Error(
          `Analytics worker shutdown did not settle admitted frames (admitted=${facts.admitted}, `
          + `writerSent=${facts.writerSent}, rejected=${facts.rejected}, failed=${facts.failed}, `
          + `unsettled=${facts.unsettledTimeout}, durableAcks=${facts.durableAcksObserved}).`,
        );
      }
    },
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
