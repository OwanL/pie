import type { SessionLifecycleStore } from '../../harness/session-storage/lifecycle/session-lifecycle-store.js';
import type {
  AnalyticsHostRecord,
  AnalyticsWriterIdentity,
  AnalyticsWriterLeaseRecord,
} from './session-lifecycle-writer-store.js';
import type { ProcessOwnerReadResult } from './process-census.js';

export interface AnalyticsHostRecoveryOptions {
  registry: Pick<SessionLifecycleStore,
    'listAnalyticsHosts' | 'listAnalyticsWriterLeases' | 'recoverAnalyticsHostAfterProcessExit'>;
  workspaceId: string;
  readProcessCensus: () => Promise<ProcessOwnerReadResult>;
  now: () => number;
  log?: (
    level: 'info' | 'warn',
    message: string,
    data?: Record<string, unknown>,
  ) => void;
}

export interface AnalyticsHostRecoveryResult {
  /** Hosts transitioned to stopped by a successful process-exit recovery. */
  retiredHosts: number;
  /** Previously observed writer leases confirmed absent after recovery. */
  reclaimedLeases: number;
}

function sameWriterIdentity(left: AnalyticsWriterIdentity, right: AnalyticsWriterIdentity): boolean {
  return left.hostInstanceId === right.hostInstanceId
    && left.workspaceId === right.workspaceId
    && left.generationId === right.generationId
    && left.buildId === right.buildId
    && left.processId === right.processId;
}

function leasesForHost(
  leases: readonly AnalyticsWriterLeaseRecord[],
  host: AnalyticsHostRecord,
): AnalyticsWriterLeaseRecord[] {
  return leases.filter((lease) => sameWriterIdentity(lease, host));
}

/** Retire only hosts proved unable to write by a complete OS process census. */
export async function recoverStaleAnalyticsHosts(
  options: AnalyticsHostRecoveryOptions,
): Promise<AnalyticsHostRecoveryResult> {
  let leases: AnalyticsWriterLeaseRecord[];
  try {
    // This bounded store census returns every lease or throws on truncation.
    leases = options.registry.listAnalyticsWriterLeases(options.workspaceId);
  } catch (error) {
    options.log?.('warn', 'stale-host recovery skipped; writer lease census is unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { retiredHosts: 0, reclaimedLeases: 0 };
  }

  // Snapshot candidates BEFORE collecting OS evidence. A host registered during
  // collection may be absent from that process snapshot despite being live.
  // Keep only nonterminal identities and stopped identities with orphan leases,
  // not the potentially large clean stopped history.
  const candidates: AnalyticsHostRecord[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = options.registry.listAnalyticsHosts(options.workspaceId, {
      ...(cursor ? { cursor } : {}),
    });
    for (const host of page.hosts) {
      if (host.state !== 'stopped' || leasesForHost(leases, host).length > 0) candidates.push(host);
    }
    if (!page.truncated || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const processCensus = await options.readProcessCensus();
  if (!processCensus.complete) {
    options.log?.('warn', 'stale-host recovery skipped; process census is incomplete', {
      reasonCodes: processCensus.reasons.map(({ code }) => code).slice(0, 16),
    });
    return { retiredHosts: 0, reclaimedLeases: 0 };
  }

  const processById = new Map(processCensus.processes.map((entry) => [entry.processId, entry] as const));
  const recorderWorkers = processCensus.processes.filter(
    (entry) => entry.analyticsRecorderWorkerParentProcessId !== undefined,
  );
  const leaseIdsToConfirm = new Set<string>();
  let retiredHosts = 0;

  for (const host of candidates) {
    const process = processById.get(host.processId);
    let registeredAtMs: bigint;
    try {
      registeredAtMs = BigInt(host.registeredAtMs);
    } catch {
      // Invalid timestamps are not evidence that a writer identity is dead.
      continue;
    }
    const sameHostProcessIsLive = process !== undefined
      && (process.processCreatedAtMs === null
        || BigInt(process.processCreatedAtMs) <= registeredAtMs + 2_000n);
    const backendMayStillWrite = processCensus.backendOwners.some((owner) =>
      owner.hostProcessId === host.processId
      && (!owner.analyticsHostInstanceId || owner.analyticsHostInstanceId === host.hostInstanceId));
    // A recorder child may finish an admitted write after its parent exits.
    // Compare births so PID reuse cannot disguise an old writer as a new one.
    const recorderWorkerMayStillWrite = recorderWorkers.some((worker) => {
      if (worker.analyticsRecorderWorkerParentProcessId !== host.processId) return false;
      if (!process) return true;
      if (process.processCreatedAtMs === null || worker.processCreatedAtMs === null) return true;
      return worker.processCreatedAtMs < process.processCreatedAtMs;
    });
    if (sameHostProcessIsLive || backendMayStillWrite || recorderWorkerMayStillWrite) continue;

    try {
      options.registry.recoverAnalyticsHostAfterProcessExit({
        hostInstanceId: host.hostInstanceId,
        workspaceId: host.workspaceId,
        generationId: host.generationId,
        buildId: host.buildId,
        processId: host.processId,
      }, options.now());
      if (host.state !== 'stopped') retiredHosts += 1;
      for (const lease of leasesForHost(leases, host)) leaseIdsToConfirm.add(lease.leaseId);
    } catch (error) {
      options.log?.('warn', 'stale host could not be retired', {
        state: host.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let reclaimedLeases = 0;
  if (leaseIdsToConfirm.size > 0) {
    try {
      const remainingLeaseIds = new Set(
        options.registry.listAnalyticsWriterLeases(options.workspaceId).map(({ leaseId }) => leaseId),
      );
      reclaimedLeases = [...leaseIdsToConfirm].filter((leaseId) => !remainingLeaseIds.has(leaseId)).length;
    } catch (error) {
      options.log?.('warn', 'reclaimed writer leases could not be confirmed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (retiredHosts > 0) {
    options.log?.('info', 'retired stale writer hosts', { count: retiredHosts, reclaimedLeases });
  } else if (reclaimedLeases > 0) {
    options.log?.('info', 'reclaimed orphaned writer leases from stopped hosts', { count: reclaimedLeases });
  }
  return { retiredHosts, reclaimedLeases };
}
