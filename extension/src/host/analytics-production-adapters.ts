import {
  AnalyticsAllHostHandoffCoordinator,
  ANALYTICS_WRITER_FENCE_MAX_HOSTS,
  type AnalyticsAllHostFenceParticipant,
  type AnalyticsAllHostHandoffOptions,
} from './analytics-all-host-handoff.js';
import {
  createAuthenticatedAnalyticsHostStatusProbe,
  discoverAnalyticsHostWriters,
  sendBoundedAnalyticsFrame,
  type AnalyticsBoundedFrameSender,
  type AnalyticsHostDiscoveryOptions,
  type AnalyticsHostDiscoveryResult,
} from './analytics-handoff-discovery.js';
import type {
  AnalyticsHostRecord,
  SessionLifecycleStore,
} from '../backend/session-lifecycle-store.js';
import type {
  ProcessOwnerReadResult,
  RuntimeGenerationIdentity,
  RuntimeLeaseReadResult,
} from './analytics-handoff-discovery.js';
import type { AnalyticsWriterFencePurpose } from '../backend/session-lifecycle-store.js';

const MAX_REGISTRY_PAGE = 64;

export interface ProductionAnalyticsHostAdapterOptions {
  workspaceId: string;
  registry: SessionLifecycleStore;
  runtimeRootPath: string;
  runtimeIdentity: RuntimeGenerationIdentity;
  analyticsGenerationId?: string;
  /** True only when the caller has proved that no canonical analytics
   * generation is active yet; see the discovery option of the same name. */
  allowAbsentAnalyticsDescriptor?: boolean;
  /** Per-boot keys are supplied by the launch/control channel and are never
   * read from or written to the lifecycle registry. */
  keyForHost: (host: AnalyticsHostRecord) => string | undefined;
  probeTimeoutMs?: number;
  now?: () => number;
  readRuntimeLeases?: () => Promise<RuntimeLeaseReadResult>;
  readProcessOwners?: () => Promise<ProcessOwnerReadResult>;
  send?: AnalyticsBoundedFrameSender;
}

export interface ProductionAnalyticsHostAdapters {
  discover: (options?: {
    readonly ignoreStoppedHosts?: boolean;
    /** Per-census override of the bound analytics generation. */
    readonly analyticsGenerationId?: string;
    /** Per-census override of the absent-descriptor allowance. */
    readonly allowAbsentAnalyticsDescriptor?: boolean;
  }) => Promise<AnalyticsHostDiscoveryResult>;
  participants: readonly AnalyticsAllHostFenceParticipant[];
  coordinator: (purpose: AnalyticsWriterFencePurpose) => AnalyticsAllHostHandoffCoordinator;
}

/** Read the complete bounded registry snapshot used to construct production
 * participants. Pagination is explicit; an incomplete page is an error rather
 * than permission to fence only the hosts visible in the first page. */
export function readCompleteProductionAnalyticsHosts(
  registry: Pick<SessionLifecycleStore, 'listAnalyticsHosts'>,
  workspaceId: string,
): AnalyticsHostRecord[] {
  const hosts: AnalyticsHostRecord[] = [];
  let cursor: string | undefined;
  let previousCursor: string | undefined;
  for (;;) {
    const page = registry.listAnalyticsHosts(workspaceId, {
      limit: MAX_REGISTRY_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    hosts.push(...page.hosts);
    if (hosts.length > ANALYTICS_WRITER_FENCE_MAX_HOSTS) {
      throw new Error('Analytics host registry exceeds the bounded production census.');
    }
    if (!page.truncated) return hosts;
    if (!page.nextCursor || page.nextCursor === previousCursor) {
      throw new Error('Analytics host registry pagination is incomplete.');
    }
    previousCursor = page.nextCursor;
    cursor = page.nextCursor;
  }
}

export function createProductionAnalyticsHostAdapters(
  options: ProductionAnalyticsHostAdapterOptions,
): ProductionAnalyticsHostAdapters {
  const now = options.now ?? Date.now;
  const send = options.send ?? sendBoundedAnalyticsFrame;
  const statusSend = (endpointName: string, request: Parameters<AnalyticsBoundedFrameSender>[1], timeoutMs: number): Promise<unknown> => (
    send(endpointName, request, timeoutMs)
  );
  const hosts = readCompleteProductionAnalyticsHosts(options.registry, options.workspaceId);
  const statusProbe = createAuthenticatedAnalyticsHostStatusProbe({
    keyForHost: options.keyForHost,
    timeoutMs: options.probeTimeoutMs,
    now,
    send: statusSend,
  });
  const discoveryOptions: AnalyticsHostDiscoveryOptions = {
    workspaceId: options.workspaceId,
    registry: options.registry,
    runtimeRootPath: options.runtimeRootPath,
    runtimeIdentity: options.runtimeIdentity,
    ...(options.analyticsGenerationId ? { analyticsGenerationId: options.analyticsGenerationId } : {}),
    ...(options.allowAbsentAnalyticsDescriptor === true ? { allowAbsentAnalyticsDescriptor: true } : {}),
    ...(options.readRuntimeLeases ? { readRuntimeLeases: options.readRuntimeLeases } : {}),
    ...(options.readProcessOwners ? { readProcessOwners: options.readProcessOwners } : {}),
    requireAuthenticatedHostStatus: true,
    readAuthenticatedHostStatus: statusProbe,
  };
  const participants = hosts
    .filter((host) => host.state === 'registered')
    .map((host): AnalyticsAllHostFenceParticipant => {
    return {
      identity: {
        hostInstanceId: host.hostInstanceId,
        workspaceId: host.workspaceId,
        generationId: host.generationId,
        buildId: host.buildId,
        processId: host.processId,
        endpointName: host.endpointName,
        capabilities: host.capabilities,
      },
      key: options.keyForHost(host) ?? '',
      send: (request) => host.endpointName
        ? send(host.endpointName, request, options.probeTimeoutMs ?? 5_000)
        : Promise.reject(new Error(`Analytics host ${host.hostInstanceId} has no authenticated endpoint.`)),
    };
  });
  const discover = (
    overrides?: {
      readonly ignoreStoppedHosts?: boolean;
      /** Per-census override. The post-restart census explicitly names the
       * committed analytics generation instead of the pre-activation one. */
      readonly analyticsGenerationId?: string;
      /** Per-census override. The post-restart census must prove the new
       * generation's descriptor, so callers pass `false` explicitly. */
      readonly allowAbsentAnalyticsDescriptor?: boolean;
    },
  ): Promise<AnalyticsHostDiscoveryResult> => discoverAnalyticsHostWriters({
    ...discoveryOptions,
    ...overrides,
  });
  return {
    discover,
    participants,
    coordinator: (purpose) => {
      const coordinatorOptions: AnalyticsAllHostHandoffOptions = {
        workspaceId: options.workspaceId,
        registry: options.registry,
        discover: () => discover({ ignoreStoppedHosts: true }),
        participants,
        purpose,
        requireAuthenticatedHostStatus: true,
        now,
        requestTimeoutMs: options.probeTimeoutMs,
      };
      return new AnalyticsAllHostHandoffCoordinator(coordinatorOptions);
    },
  };
}

