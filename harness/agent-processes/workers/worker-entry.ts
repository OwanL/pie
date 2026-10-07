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
import type { WorkerRuntimeHost, WorkerRuntimePromotionPayload } from './worker-runtime-host';
import {
  openWorkerServerTransport, parseWorkerServerArgs, WorkerServer,
  type WorkerServerHandlers, type WorkerServerIdentity,
} from '../lib/rpc/worker-server.js';

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
  const mainStartedNs = process.hrtime.bigint();
  const reportBootstrapTiming = (phase: 'main-entry' | 'verify-start' | 'verify-complete'): void => {
    if (process.env.PIE_TEST_WORKER_BOOTSTRAP_TIMING !== '1') return;
    const nowNs = phase === 'main-entry' ? mainStartedNs : process.hrtime.bigint();
    process.stderr.write(`[pie-worker-bootstrap-timing] ${JSON.stringify({
      pid: process.pid,
      phase,
      hrtimeNs: nowNs.toString(),
      elapsedNs: (nowNs - mainStartedNs).toString(),
    })}\n`);
  };
  reportBootstrapTiming('main-entry');
  // Provider traffic originates in the isolated worker, not the coordinator.
  // Install the observer in this process before promotion can load the SDK or
  // issue a provider fetch; otherwise HTTP/transport incidents never reach the
  // session that owns the request and the UI falls back to opaque SDK errors.
  installProviderTrafficObserver();
  const identity = parseWorkerServerArgs(process.argv.slice(2));
  const server = new WorkerServer(identity, process, openWorkerServerTransport(identity),
    createWorkerEntryHandlers(identity, { reportBootstrapTiming }));
  server.start();
}

type RuntimeHost = Pick<WorkerRuntimeHost,
  'applySync' | 'promote' | 'command' | 'subscribeDetail' | 'unsubscribeDetail' | 'fetchDetail'
  | 'acknowledgeAnalytics' | 'interrupt' | 'dispose'>;

/** SDK-free load seam; the production module is loaded only on promotion. */
export function createWorkerEntryHandlers(
  identity: WorkerServerIdentity,
  options: {
    loadHost?: () => Promise<{
      WorkerRuntimeHost: new (options: ConstructorParameters<typeof WorkerRuntimeHost>[0]) => RuntimeHost;
    }>;
    verifyRuntime?: typeof verifySdkRuntimeSelection;
    reportBootstrapTiming?: (phase: 'verify-start' | 'verify-complete') => void;
  } = {},
): WorkerServerHandlers {
  let sdkRuntime: SdkRuntimeSelection | undefined;
  let host: RuntimeHost | undefined;
  let creation: Promise<RuntimeHost | undefined> | undefined;
  let stopping = false;
  const promotions = new Set<Promise<void>>();
  const pendingSync = new Map<string, { revision: number; payload: WorkerJsonObject }>();
  const getHost = (currentServer: WorkerServer): Promise<RuntimeHost | undefined> => {
    if (stopping) return Promise.resolve(undefined);
    if (!sdkRuntime) throw new Error('Worker runtime promotion arrived before SDK runtime validation.');
    const verifiedRuntime = sdkRuntime;
    creation ??= (async () => {
      const module = await (options.loadHost ?? (() => import('./worker-runtime-host')))();
      // Shutdown can be admitted while the module loads. Never construct a
      // resource-owning host after that boundary.
      if (stopping) return undefined;
      host = new module.WorkerRuntimeHost({
        server: currentServer,
        owner: {
          coordinatorGeneration: identity.coordinatorGeneration,
          workerId: identity.workerId,
          workerGeneration: identity.workerGeneration,
        },
        sdkRuntime: verifiedRuntime,
      });
      for (const [domain, sync] of pendingSync) host.applySync(domain, sync.revision, sync.payload);
      pendingSync.clear();
      return host;
    })();
    return creation;
  };
  return {
    validateBootstrap: async (frame) => {
      const sdkPath = sdkRuntimeSdkPath(frame.sdkRuntime);
      options.reportBootstrapTiming?.('verify-start');
      sdkRuntime = await (options.verifyRuntime ?? verifySdkRuntimeSelection)(sdkPath, frame.sdkRuntime);
      options.reportBootstrapTiming?.('verify-complete');
    },
    onFrame: async (frame, currentServer) => {
      if (frame.kind === 'runtime.promote') {
        if (stopping) return;
        const promotion = (async () => {
          const runtimeHost = await getHost(currentServer);
          if (!runtimeHost || stopping) return;
          await runtimeHost.promote(frame.payload as WorkerRuntimePromoteFrame['payload'] & WorkerRuntimePromotionPayload);
          if (stopping) return;
          currentServer.sendFrame({
            kind: 'runtime.ready',
            requestId: frame.requestId,
            runtimeMetadata: { mode: 'phase4', startedAt: Date.now() },
          });
        })();
        promotions.add(promotion);
        try { await promotion; } finally { promotions.delete(promotion); }
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
    onInterrupt: async () => {
      // Join creation only, not promotion: interruption must not queue behind
      // runtime work. A load-time interrupt still reaches the admitted host.
      const runtimeHost = host ?? await creation;
      if (!stopping) await runtimeHost?.interrupt();
    },
    onShutdown: async () => {
      stopping = true;
      try { await creation; } catch { /* Failed loading owns no host resources. */ }
      // Promotion can create its runtime/session after an SDK or factory await.
      // Join every admitted promotion before disposing the actual host; errors
      // still propagate through their ordinary onFrame handlers.
      await Promise.allSettled([...promotions]);
      pendingSync.clear();
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
  };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[pie-worker] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
