import type { Int64Value } from './contracts.js';

/** Durable identity of an extension host that can participate in a future
 * all-host handoff. Registration is deliberately separate from completeness:
 * a caller must reconcile this set with runtime-generation leases and process
 * evidence before it may claim that every writer was quiesced. */
export type AnalyticsHostState = 'registered' | 'stopping' | 'stopped' | 'unsupported';

export interface AnalyticsHostRecord {
  hostInstanceId: string;
  workspaceId: string;
  generationId: string;
  buildId: string;
  processId: number;
  endpointName?: string;
  capabilities: string[];
  state: AnalyticsHostState;
  registeredAtMs: string;
  heartbeatAtMs: string;
  stoppedAtMs?: string;
  unsupportedReason?: string;
  updatedAtMs: string;
}

export interface AnalyticsHostPage {
  hosts: AnalyticsHostRecord[];
  truncated: boolean;
  nextCursor?: string;
}

export type AnalyticsWriterFencePurpose = 'analytics-activation' | 'storage-cutoff';
export type AnalyticsWriterFenceState = 'open' | 'fencing' | 'fenced';

/** Stable process/host identity used by the durable writer admission gate.
 * Per-boot keys and endpoint names intentionally stay outside this record. */
export interface AnalyticsWriterIdentity {
  hostInstanceId: string;
  workspaceId: string;
  generationId: string;
  buildId: string;
  processId: number;
}

function requireWriterIdentityField(value: string, name: string, maxLength = 512): string {
  if (!value || value.includes('\u0000')) throw new Error(`${name} is required and cannot contain NUL.`);
  if (value.length > maxLength) throw new Error(`${name} exceeds the bounded length.`);
  return value;
}

/** Pure, engine-neutral validation shared by analytics authority and the
 * lifecycle store that persists writer identities. */
export function requireWriterIdentity(value: AnalyticsWriterIdentity, name: string): AnalyticsWriterIdentity {
  if (!value || typeof value !== 'object') throw new Error(`${name} is invalid.`);
  return {
    hostInstanceId: requireWriterIdentityField(value.hostInstanceId, `${name}.hostInstanceId`),
    workspaceId: requireWriterIdentityField(value.workspaceId, `${name}.workspaceId`),
    generationId: requireWriterIdentityField(value.generationId, `${name}.generationId`),
    buildId: requireWriterIdentityField(value.buildId, `${name}.buildId`),
    processId: (() => {
      if (!Number.isSafeInteger(value.processId) || value.processId <= 0) {
        throw new Error(`${name}.processId must be a positive safe integer.`);
      }
      return value.processId;
    })(),
  };
}

export interface AnalyticsWriterFenceRecord {
  workspaceId: string;
  operationId: string;
  purpose: AnalyticsWriterFencePurpose;
  fenceEpoch: number;
  state: AnalyticsWriterFenceState;
  expectedHosts: AnalyticsWriterIdentity[];
  acknowledgedHostInstanceIds: string[];
  startedAtMs: string;
  updatedAtMs: string;
}

export interface AnalyticsWriterFenceAcknowledgement {
  workspaceId: string;
  operationId: string;
  fenceEpoch: number;
  identity: AnalyticsWriterIdentity;
  activeWriterCount: number;
  acknowledgedAtMs: string;
}

export interface AnalyticsWriterLeaseRecord extends AnalyticsWriterIdentity {
  leaseId: string;
  fenceEpoch: number;
  acquiredAtMs: string;
}

export interface AnalyticsWriterAdmissionState {
  workspaceId: string;
  state: AnalyticsWriterFenceState;
  fenceEpoch: number;
}

export interface BeginAnalyticsWriterFenceOptions {
  workspaceId: string;
  operationId: string;
  purpose: AnalyticsWriterFencePurpose;
  expectedHosts: readonly AnalyticsWriterIdentity[];
  nowMs: Int64Value;
}

export interface AcknowledgeAnalyticsWriterFenceOptions {
  workspaceId: string;
  operationId: string;
  fenceEpoch: number;
  identity: AnalyticsWriterIdentity;
  activeWriterCount: number;
  nowMs: Int64Value;
}

export interface ReopenAnalyticsWriterAdmissionOptions {
  workspaceId: string;
  operationId: string;
  purpose: 'analytics-activation';
  admittedHosts: readonly AnalyticsWriterIdentity[];
  nowMs: Int64Value;
}

export interface ReconcileOpenAnalyticsWriterAdmissionOptions {
  identity: AnalyticsWriterIdentity;
  nowMs: Int64Value;
}

/** Minimal analytics-owned view of the canonical host registry. The host
 * lifecycle store satisfies this port structurally; analytics does not depend
 * on its harness implementation. */
export interface AnalyticsHostRegistryPort {
  registerAnalyticsHost(
    host: Omit<AnalyticsHostRecord, 'state' | 'heartbeatAtMs' | 'updatedAtMs'> & {
      state?: AnalyticsHostState;
      heartbeatAtMs?: Int64Value;
      updatedAtMs?: Int64Value;
    },
  ): AnalyticsHostRecord;
  heartbeatAnalyticsHost(
    hostInstanceId: string,
    processId: number,
    generationId: string,
    nowMs: Int64Value,
  ): AnalyticsHostRecord;
  markAnalyticsHostState(
    hostInstanceId: string,
    processId: number,
    generationId: string,
    state: Extract<AnalyticsHostState, 'stopping' | 'stopped'>,
    nowMs: Int64Value,
  ): AnalyticsHostRecord;
  recoverAnalyticsHostAfterProcessExit(
    identity: AnalyticsWriterIdentity,
    nowMs: Int64Value,
  ): AnalyticsHostRecord;
  getAnalyticsHost(hostInstanceId: string): AnalyticsHostRecord | undefined;
  listAnalyticsHosts(
    workspaceId: string,
    options?: { limit?: number; cursor?: string },
  ): AnalyticsHostPage;
  reconcileOpenAnalyticsWriterAdmission(
    options: ReconcileOpenAnalyticsWriterAdmissionOptions,
  ): AnalyticsWriterAdmissionState;
  listAnalyticsWriterLeases(workspaceId: string): AnalyticsWriterLeaseRecord[];
}
