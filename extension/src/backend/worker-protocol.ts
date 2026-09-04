import { JSONL_MAX_LINE_BYTES } from '../shared/jsonl';
import {
  isDetailCursor,
  isDetailPagePayload,
  isDetailPageRef,
  isLiveSubagentDetailAddress,
  isPatchOperations,
  type DetailCursor,
  type DetailErrorCode,
  type DetailPagePayload,
  type DetailPageRef,
  type DetailRebaseReason,
  type LiveSubagentDetailAddress,
} from '../shared/protocol/subagent-detail.js';
import type { JsonStructuralPatchOperation } from '../shared/json-structural-patch.js';
import type { LazyDetailRef } from '../shared/protocol/messages.js';
import type {
  SdkSessionOwnershipReservation,
  SdkSessionReplacementIntent,
  SdkSessionTransferAuthorization,
  SdkSessionWriteLease,
} from './sdk';
import { SDK_PATCH_IDENTITY_VERSION, type SdkPatchIdentity } from './sdk-patch-barrier';

/** Private coordinator/worker protocol. It is intentionally independent from the public RPC protocol. */
export const WORKER_IPC_VERSION = 1 as const;
export const WORKER_IPC_MAX_FRAME_BYTES = JSONL_MAX_LINE_BYTES;
export const WORKER_IPC_MAX_ORDINARY_FRAME_BYTES = 256 * 1024;
export const WORKER_IPC_MAX_HEARTBEAT_FRAME_BYTES = 16 * 1024;

const MAX_KIND_BYTES = 32;
const MAX_ID_BYTES = 512;
const MAX_SESSION_PATH_BYTES = 16 * 1024;
const MAX_REASON_BYTES = 4 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 64 * 1024;

export interface WorkerFrameBase {
  ipcVersion: typeof WORKER_IPC_VERSION;
  coordinatorGeneration: number;
  workerId: string;
  workerGeneration: number;
  workerPid: number;
  /** Immutable root assigned when this process is spawned. */
  rootSessionPath: string;
  /** Current sole-writer lease identity. It may advance after a committed replacement. */
  leasePath: string;
  leaseRevision: number;
  /** Compatibility alias for the immutable root session path. */
  sessionPath: string;
  seq: number;
}

export type WorkerJsonPrimitive = string | number | boolean | null;
export type WorkerJsonValue = WorkerJsonPrimitive | WorkerJsonValue[] | { [key: string]: WorkerJsonValue };
export type WorkerJsonObject = { [key: string]: WorkerJsonValue };

export type WorkerRuntimeOperation =
  | 'session.open'
  | 'session.preload'
  | 'session.loadTranscriptPage'
  | 'session.loadDetail'
  | 'session.truncateAfter'
  | 'session.title.generate'
  | 'models.list'
  | 'liveTurn.checkpoint'
  | 'message.send'
  | 'operation.status'
  | 'message.continue'
  | 'message.compact'
  | 'message.clearQueue'
  | 'message.replaceQueue'
  | 'extension_ui.response'
  | 'settings.set'
  | 'systemPromptToggles.set'
  | 'test.extensionCommand';

export type WorkerRuntimeEventName =
  | 'session.opened'
  | 'message.started'
  | 'message.delta'
  | 'message.thinking'
  | 'message.toolCallDelta'
  | 'message.finished'
  | 'message.aborted'
  | 'message.custom'
  | 'message.queuedDelivered'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.finished'
  | 'agent.settled'
  | 'busy.changed'
  | 'contextUsage.changed'
  | 'extension_ui.request'
  | 'preflight.failed'
  | 'retry.started'
  | 'retry.ended'
  | 'retry.measured'
  | 'retry.stuck'
  | 'compaction.started'
  | 'compaction.ended'
  | 'auxiliary-llm.usage'
  | 'live.semantic'
  | 'live.lifecycle'
  | 'operational-error'
  | 'error';

export type WorkerSyncDomain =
  | 'settings'
  | 'catalog'
  | 'auth'
  | 'runtimePrefs'
  | 'providerPolicy'
  | 'sessionRegistry';

export type WorkerSyncPayload =
  | { domain: 'settings'; payload: { values: WorkerJsonObject } }
  | { domain: 'catalog'; payload: { models: WorkerJsonValue[] } }
  | { domain: 'auth'; payload: { authPath: string; fingerprint: string } }
  | { domain: 'runtimePrefs'; payload: { values: WorkerJsonObject } }
  | { domain: 'providerPolicy'; payload: { providers: WorkerJsonObject } }
  | { domain: 'sessionRegistry'; payload: { tabs: WorkerJsonValue[] } };

export type WorkerProviderReleaseOutcome = 'completed' | 'failed' | 'cancelled';
export type WorkerProviderObservationClassification = 'success' | 'http-error' | 'transport-error' | 'cancelled';

export interface WorkerBootstrapFrame extends WorkerFrameBase {
  kind: 'bootstrap';
  heartbeatIntervalMs: number;
  sdkPatchIdentity: SdkPatchIdentity;
}

export interface WorkerCommandFrame extends WorkerFrameBase {
  kind: 'command';
  requestId: string;
  operation: 'ping';
}

export interface WorkerRuntimePromoteFrame extends WorkerFrameBase {
  kind: 'runtime.promote';
  requestId: string;
  operationId: string;
  payload: WorkerJsonObject;
}

export interface WorkerRuntimeCommandFrame extends WorkerFrameBase {
  kind: 'runtime.command';
  requestId: string;
  operation: WorkerRuntimeOperation;
  payload: WorkerJsonObject;
}

export type WorkerSyncFrame = WorkerFrameBase & {
  kind: 'sync';
  requestId: string;
  revision: number;
} & WorkerSyncPayload;

export interface WorkerSyncAckFrame extends WorkerFrameBase {
  kind: 'sync.ack';
  requestId: string;
  domain: WorkerSyncDomain;
  revision: number;
}

export interface WorkerOwnershipReservedFrame extends WorkerFrameBase {
  kind: 'ownership.reserved';
  requestId: string;
  reservation: SdkSessionOwnershipReservation;
}

export interface WorkerOwnershipCommittedFrame extends WorkerFrameBase {
  kind: 'ownership.committed';
  requestId: string;
  authorization: SdkSessionTransferAuthorization;
}

export interface WorkerOwnershipConsumedFrame extends WorkerFrameBase {
  kind: 'ownership.consumed';
  requestId: string;
  authorizationId: string;
  lease: SdkSessionWriteLease;
}

export interface WorkerOwnershipAbortedFrame extends WorkerFrameBase {
  kind: 'ownership.aborted';
  requestId: string;
  reservationId: string;
}

export interface WorkerOwnershipRejectedFrame extends WorkerFrameBase {
  kind: 'ownership.rejected';
  requestId: string;
  phase: 'reserve' | 'commit' | 'consume' | 'abort' | 'runtimeReady';
  code: 'OWNERSHIP_CONFLICT' | 'STALE_OWNERSHIP' | 'OWNERSHIP_FAILED';
  message: string;
  retryable: boolean;
}

export interface WorkerOwnershipRuntimeReadyAckFrame extends WorkerFrameBase {
  kind: 'ownership.runtimeReadyAck';
  requestId: string;
  canonicalPath: string;
  ownershipRevision: number;
}

export interface WorkerProviderGrantedFrame extends WorkerFrameBase {
  kind: 'provider.granted';
  requestId: string;
  lease: {
    leaseId: string;
    provider: string;
    model: string;
    grantedAt: number;
    headerWaitMs: number;
    streamIdleTimeoutMs: number;
  };
}

export interface WorkerProviderCancelledFrame extends WorkerFrameBase {
  kind: 'provider.cancelled';
  requestId: string;
  reason: string;
}

export interface WorkerProviderRejectedFrame extends WorkerFrameBase {
  kind: 'provider.rejected';
  requestId: string;
  error: {
    name: string;
    message: string;
    retryable: boolean;
    httpStatus?: number;
  };
}

export interface WorkerProviderCancelAckFrame extends WorkerFrameBase {
  kind: 'provider.cancelAck';
  requestId: string;
  targetRequestId: string;
  status: 'queued' | 'granted' | 'not-found';
  leaseId?: string;
}

export interface WorkerProviderReleasedFrame extends WorkerFrameBase {
  kind: 'provider.released';
  requestId: string;
  leaseId: string;
}

export interface WorkerSettingsAuthoritativeFrame extends WorkerFrameBase {
  kind: 'settings.authoritative';
  requestId: string;
  revision: number;
  values: WorkerJsonObject;
}

export interface WorkerInterruptFrame extends WorkerFrameBase {
  kind: 'interrupt';
  requestId: string;
  targetRequestId?: string;
  reason: string;
}

export interface WorkerShutdownFrame extends WorkerFrameBase {
  kind: 'shutdown';
  requestId: string;
  reason: string;
}

export interface WorkerDetailSubscribeFrame extends WorkerFrameBase {
  kind: 'detail.subscribe';
  requestId: string;
  subscriptionId: string;
  address: LiveSubagentDetailAddress;
  cursor?: DetailCursor;
  maxPageBytes: number;
}

export interface WorkerDetailUnsubscribeFrame extends WorkerFrameBase {
  kind: 'detail.unsubscribe';
  requestId: string;
  subscriptionId: string;
}

export interface WorkerDetailFetchFrame extends WorkerFrameBase {
  kind: 'detail.fetch';
  requestId: string;
  subscriptionId: string;
  address: LiveSubagentDetailAddress;
  ref: DetailPageRef;
  maxPageBytes: number;
}

export type CoordinatorToWorkerFrame =
  | WorkerBootstrapFrame
  | WorkerCommandFrame
  | WorkerRuntimePromoteFrame
  | WorkerRuntimeCommandFrame
  | WorkerSyncFrame
  | WorkerOwnershipReservedFrame
  | WorkerOwnershipCommittedFrame
  | WorkerOwnershipConsumedFrame
  | WorkerOwnershipAbortedFrame
  | WorkerOwnershipRejectedFrame
  | WorkerOwnershipRuntimeReadyAckFrame
  | WorkerProviderGrantedFrame
  | WorkerProviderCancelledFrame
  | WorkerProviderRejectedFrame
  | WorkerProviderCancelAckFrame
  | WorkerProviderReleasedFrame
  | WorkerSettingsAuthoritativeFrame
  | WorkerInterruptFrame
  | WorkerShutdownFrame
  | WorkerDetailSubscribeFrame
  | WorkerDetailUnsubscribeFrame
  | WorkerDetailFetchFrame;

export interface WorkerReadyFrame extends WorkerFrameBase {
  kind: 'ready';
  runtimeMetadata: {
    mode: 'phase2';
    startedAt: number;
  };
}

export interface WorkerRuntimeReadyFrame extends WorkerFrameBase {
  kind: 'runtime.ready';
  requestId: string;
  runtimeMetadata: {
    mode: 'phase4';
    startedAt: number;
  };
}

export interface WorkerRuntimeEventFrame extends WorkerFrameBase {
  kind: 'runtime.event';
  event: WorkerRuntimeEventName;
  payload: WorkerJsonObject;
}

/** Worker→coordinator runtime discovery report. The coordinator retains the
 * report (bounded, per worker) but never lets it replace the configured
 * catalog/settings authority. Fire-and-forget: no correlated ack. */
export interface WorkerRuntimeReportFrame extends WorkerFrameBase {
  kind: 'runtime.report';
  domain: 'catalog';
  payload: {
    models: WorkerJsonValue;
  };
}

export interface WorkerOwnershipReserveFrame extends WorkerFrameBase {
  kind: 'ownership.reserve';
  requestId: string;
  intent: SdkSessionReplacementIntent;
}

export interface WorkerOwnershipCommitFrame extends WorkerFrameBase {
  kind: 'ownership.commit';
  requestId: string;
  reservation: SdkSessionOwnershipReservation;
  sourceLease: SdkSessionWriteLease;
}

export interface WorkerOwnershipConsumeFrame extends WorkerFrameBase {
  kind: 'ownership.consume';
  requestId: string;
  authorization: SdkSessionTransferAuthorization;
  canonicalDestinationPath: string;
}

export interface WorkerOwnershipAbortFrame extends WorkerFrameBase {
  kind: 'ownership.abort';
  requestId: string;
  reservation: SdkSessionOwnershipReservation;
  reason: string;
}

export interface WorkerOwnershipRuntimeReadyFrame extends WorkerFrameBase {
  kind: 'ownership.runtimeReady';
  requestId: string;
  lease: SdkSessionWriteLease;
  canonicalPath: string;
}

export interface WorkerProviderAcquireFrame extends WorkerFrameBase {
  kind: 'provider.acquire';
  requestId: string;
  request: {
    provider: string;
    model: string;
    turnId: string;
    attemptId: string;
  };
}

export interface WorkerProviderCancelFrame extends WorkerFrameBase {
  kind: 'provider.cancel';
  requestId: string;
  targetRequestId: string;
  reason: string;
}

export interface WorkerProviderObservationFrame extends WorkerFrameBase {
  kind: 'provider.observation';
  leaseId: string;
  observation: {
    classification: WorkerProviderObservationClassification;
    status?: number;
    retryable: boolean;
  };
}

export interface WorkerProviderReleaseFrame extends WorkerFrameBase {
  kind: 'provider.release';
  requestId: string;
  leaseId: string;
  outcome: WorkerProviderReleaseOutcome;
}

export interface WorkerSettingsMutateFrame extends WorkerFrameBase {
  kind: 'settings.mutate';
  requestId: string;
  updates: WorkerJsonObject;
}

export type WorkerResponseResult =
  | { kind: 'pong' }
  | { kind: 'interrupted' }
  | { kind: 'shutting-down' }
  | { kind: 'runtime.command'; payload: WorkerJsonValue };

export type WorkerErrorCode = 'COMMAND_FAILED' | 'RUNTIME_COMMAND_FAILED' | 'INTERRUPT_FAILED' | 'SHUTDOWN_FAILED'
  | 'OPERATION_INTENT_MISMATCH';

export interface WorkerError {
  code: WorkerErrorCode;
  message: string;
  retryable: boolean;
}

export type WorkerResponseFrame = (WorkerFrameBase & {
  kind: 'response';
  requestId: string;
}) & (
  | { ok: true; result: WorkerResponseResult }
  | { ok: false; error: WorkerError }
);

export type WorkerHeartbeatPhase = 'bootstrapping' | 'ready' | 'busy' | 'interrupting' | 'shutting-down';

export interface WorkerHeartbeatFrame extends WorkerFrameBase {
  kind: 'heartbeat';
  heartbeat: {
    phase: WorkerHeartbeatPhase;
    activeRequestId?: string;
    lastEventSeq: number;
    lastDetailRevision: number;
    eventLoopDelayMs: number;
    lastDurableAppendId?: string;
  };
}

export type WorkerFatalCode = 'BOOTSTRAP_FAILED' | 'PROTOCOL_ERROR' | 'IPC_ERROR' | 'INTERNAL_ERROR';
export type WorkerFatalPhase = 'bootstrap' | 'command' | 'interrupt' | 'shutdown' | 'ipc';

export interface WorkerDetailStartFrame extends WorkerFrameBase {
  kind: 'detail.start';
  requestId: string;
  subscriptionId: string;
  address: LiveSubagentDetailAddress;
  source: 'live' | 'durable';
  baselineRevision: number;
  pageCount: number;
  totalBytes: number;
  totalCodePoints: number;
}

export interface WorkerDetailPageFrame extends WorkerFrameBase {
  kind: 'detail.page';
  requestId?: string;
  subscriptionId: string;
  ref: DetailPageRef;
  payload: DetailPagePayload;
  payloadBytes: number;
  checksum: string;
}

export interface WorkerDetailDeltaFrame extends WorkerFrameBase {
  kind: 'detail.delta';
  subscriptionId: string;
  baseRevision: number;
  revision: number;
  operations: JsonStructuralPatchOperation[];
}

export interface WorkerDetailRebaseFrame extends WorkerFrameBase {
  kind: 'detail.rebase';
  subscriptionId: string;
  currentRevision: number;
  reason: DetailRebaseReason;
}

export interface WorkerDetailTerminalFrame extends WorkerFrameBase {
  kind: 'detail.terminal';
  subscriptionId: string;
  revision: number;
  durableRef: LazyDetailRef;
}

export interface WorkerDetailErrorFrame extends WorkerFrameBase {
  kind: 'detail.error';
  requestId?: string;
  subscriptionId: string;
  code: DetailErrorCode;
  message: string;
  retryable: boolean;
}

export interface WorkerDetailUnsubscribedFrame extends WorkerFrameBase {
  kind: 'detail.unsubscribed';
  requestId: string;
  subscriptionId: string;
}

export interface WorkerFatalFrame extends WorkerFrameBase {
  kind: 'fatal';
  requestId?: string;
  error: {
    code: WorkerFatalCode;
    phase: WorkerFatalPhase;
    message: string;
  };
}

export type WorkerToCoordinatorFrame =
  | WorkerReadyFrame
  | WorkerRuntimeReadyFrame
  | WorkerRuntimeEventFrame
  | WorkerRuntimeReportFrame
  | WorkerSyncAckFrame
  | WorkerOwnershipReserveFrame
  | WorkerOwnershipCommitFrame
  | WorkerOwnershipConsumeFrame
  | WorkerOwnershipAbortFrame
  | WorkerOwnershipRuntimeReadyFrame
  | WorkerProviderAcquireFrame
  | WorkerProviderCancelFrame
  | WorkerProviderObservationFrame
  | WorkerProviderReleaseFrame
  | WorkerSettingsMutateFrame
  | WorkerResponseFrame
  | WorkerHeartbeatFrame
  | WorkerFatalFrame
  | WorkerDetailStartFrame
  | WorkerDetailPageFrame
  | WorkerDetailDeltaFrame
  | WorkerDetailRebaseFrame
  | WorkerDetailTerminalFrame
  | WorkerDetailErrorFrame
  | WorkerDetailUnsubscribedFrame;

export type WorkerIpcFrame = CoordinatorToWorkerFrame | WorkerToCoordinatorFrame;
export type WorkerIpcFrameKind = WorkerIpcFrame['kind'];
export type WorkerIpcFrameDraft<T extends WorkerIpcFrame = WorkerIpcFrame> =
  T extends WorkerIpcFrame ? Omit<T, 'seq'> : never;

type WorkerFrameIdentityKey = keyof WorkerFrameBase;
type FrameBody<T extends WorkerIpcFrame> = T extends WorkerIpcFrame ? Omit<T, WorkerFrameIdentityKey> : never;
type RequestFrameBody<T extends WorkerIpcFrame> = T extends WorkerIpcFrame
  ? T extends { requestId: string }
    ? Omit<T, WorkerFrameIdentityKey | 'requestId'>
    : never
  : never;

/** Identity-free frame bodies used by the transport APIs; the transport owns all fences and sequence fields. */
export type CoordinatorToWorkerFrameBody = FrameBody<CoordinatorToWorkerFrame>;
export type WorkerToCoordinatorFrameBody = FrameBody<WorkerToCoordinatorFrame>;

export type CoordinatorToWorkerRequestFrame = Extract<CoordinatorToWorkerFrame, {
  kind: 'command' | 'runtime.promote' | 'runtime.command' | 'sync' | 'interrupt' | 'shutdown'
    | 'detail.subscribe' | 'detail.unsubscribe' | 'detail.fetch';
}>;
export type WorkerToCoordinatorResponseFrame = Extract<WorkerToCoordinatorFrame, {
  kind: 'response' | 'runtime.ready' | 'sync.ack' | 'detail.start' | 'detail.unsubscribed';
}> | WorkerDetailPageFrame | WorkerDetailErrorFrame;
export type WorkerToCoordinatorRequestFrame = Extract<WorkerToCoordinatorFrame, {
  kind: 'ownership.reserve' | 'ownership.commit' | 'ownership.consume' | 'ownership.abort' | 'ownership.runtimeReady'
    | 'provider.acquire' | 'provider.cancel' | 'provider.release' | 'settings.mutate';
}>;
export type CoordinatorToWorkerResponseFrame = Extract<CoordinatorToWorkerFrame, {
  kind: 'ownership.reserved' | 'ownership.committed' | 'ownership.consumed' | 'ownership.aborted' | 'ownership.rejected'
    | 'ownership.runtimeReadyAck' | 'provider.granted' | 'provider.cancelled' | 'provider.rejected' | 'provider.cancelAck'
    | 'provider.released' | 'settings.authoritative';
}>;
export type CoordinatorToWorkerRequestBody = RequestFrameBody<CoordinatorToWorkerRequestFrame>;
export type WorkerToCoordinatorRequestBody = RequestFrameBody<WorkerToCoordinatorRequestFrame>;

export interface WorkerFrameExpectation {
  coordinatorGeneration: number;
  workerId: string;
  workerGeneration: number;
  workerPid: number;
  rootSessionPath: string;
  leasePath: string;
  leaseRevision: number;
  /** Compatibility alias; it must equal rootSessionPath. */
  sessionPath: string;
  expectedSeq: number;
}

export type WorkerFrameInvalidReason =
  | 'not_serializable'
  | 'frame_too_large'
  | 'ordinary_frame_too_large'
  | 'heartbeat_frame_too_large'
  | 'invalid_shape'
  | 'wrong_direction'
  | 'version_mismatch'
  | 'future_generation'
  | 'identity_mismatch'
  | 'sequence_gap';

export type WorkerFrameStaleReason = 'coordinator_generation' | 'worker_generation' | 'sequence';

export type WorkerFrameValidation<T extends WorkerIpcFrame> =
  | { status: 'accepted'; frame: T; bytes: number }
  | { status: 'stale'; frame: T; bytes: number; reason: WorkerFrameStaleReason }
  | { status: 'invalid'; reason: WorkerFrameInvalidReason; detail: string; bytes?: number };

type ShapeResult<T> = { ok: true; value: T } | { ok: false; detail: string };

export function workerIpcFrameByteLimit(frame: unknown): number {
  const kind = isRecord(frame) && typeof frame.kind === 'string' ? frame.kind : undefined;
  if (kind === 'heartbeat') return WORKER_IPC_MAX_HEARTBEAT_FRAME_BYTES;
  if (kind === 'runtime.event') {
    // `session.opened` re-emits the full promotion snapshot (including the
    // bounded transcript) so the host observes a runtime-hydrated open. It is
    // the one ordinary-kind frame that legitimately approaches the wire cap.
    return isRecord(frame) && frame.event === 'session.opened'
      ? WORKER_IPC_MAX_FRAME_BYTES
      : WORKER_IPC_MAX_ORDINARY_FRAME_BYTES;
  }
  if (kind === 'detail.page' || kind === 'detail.delta') return WORKER_IPC_MAX_ORDINARY_FRAME_BYTES;
  // Control, response, and lifecycle frames (runtime.promote, runtime.command,
  // sync, ownership, provider, detail.start/terminal, etc.) are request/response
  // correlated and low-volume; they may carry large payloads such as the
  // promotion snapshot or the configured model catalog.
  return WORKER_IPC_MAX_FRAME_BYTES;
}

export function measureWorkerIpcMessage(value: unknown): { ok: true; bytes: number; serialized: string } | { ok: false; detail: string } {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { ok: false, detail: 'IPC message is not JSON-serializable.' };
    return { ok: true, bytes: Buffer.byteLength(serialized, 'utf8'), serialized };
  } catch (error) {
    return { ok: false, detail: `IPC message is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function parseCoordinatorToWorkerFrame(
  value: unknown,
  expectation: WorkerFrameExpectation,
): WorkerFrameValidation<CoordinatorToWorkerFrame> {
  return validateFrame(value, expectation, 'coordinator');
}

export function parseWorkerToCoordinatorFrame(
  value: unknown,
  expectation: WorkerFrameExpectation,
): WorkerFrameValidation<WorkerToCoordinatorFrame> {
  return validateFrame(value, expectation, 'worker');
}

/** Shape-only validation used by the writer before a sequence is committed. */
export function parseWorkerIpcFrameShape(value: unknown): ShapeResult<WorkerIpcFrame> {
  return parseWorkerIpcFrameShapeInternal(value, true);
}

/**
 * Validate an outbound draft before constructing or serializing a frame with a
 * sequence number. This deliberately shares the closed shape checks with
 * inbound parsing, but does not require `seq`, which the writer owns.
 */
export function validateWorkerIpcFrameDraft(value: unknown): string | undefined {
  const result = parseWorkerIpcFrameShapeInternal(value, false);
  return result.ok ? undefined : result.detail;
}

function parseWorkerIpcFrameShapeInternal(value: unknown, requireSeq: boolean): ShapeResult<WorkerIpcFrame> {
  if (!isRecord(value)) return { ok: false, detail: 'Frame must be a plain object.' };
  const kind = value.kind;
  if (!boundedString(kind, MAX_KIND_BYTES)) return { ok: false, detail: 'Frame kind must be a bounded non-empty string.' };
  const base = validateBase(value, requireSeq);
  if (base) return { ok: false, detail: base };

  let detail: string | undefined;
  switch (kind) {
    case 'bootstrap': detail = validateBootstrap(value, requireSeq); break;
    case 'command': detail = validateCommand(value, requireSeq); break;
    case 'runtime.promote': detail = validateRuntimePromote(value, requireSeq); break;
    case 'runtime.ready': detail = validateRuntimeReady(value, requireSeq); break;
    case 'runtime.command': detail = validateRuntimeCommand(value, requireSeq); break;
    case 'runtime.event': detail = validateRuntimeEvent(value, requireSeq); break;
    case 'runtime.report': detail = validateRuntimeReport(value, requireSeq); break;
    case 'ownership.reserve': detail = validateOwnershipReserve(value, requireSeq); break;
    case 'ownership.reserved': detail = validateOwnershipReserved(value, requireSeq); break;
    case 'ownership.commit': detail = validateOwnershipCommit(value, requireSeq); break;
    case 'ownership.committed': detail = validateOwnershipCommitted(value, requireSeq); break;
    case 'ownership.consume': detail = validateOwnershipConsume(value, requireSeq); break;
    case 'ownership.consumed': detail = validateOwnershipConsumed(value, requireSeq); break;
    case 'ownership.abort': detail = validateOwnershipAbort(value, requireSeq); break;
    case 'ownership.aborted': detail = validateOwnershipAborted(value, requireSeq); break;
    case 'ownership.rejected': detail = validateOwnershipRejected(value, requireSeq); break;
    case 'ownership.runtimeReady': detail = validateOwnershipRuntimeReady(value, requireSeq); break;
    case 'ownership.runtimeReadyAck': detail = validateOwnershipRuntimeReadyAck(value, requireSeq); break;
    case 'provider.acquire': detail = validateProviderAcquire(value, requireSeq); break;
    case 'provider.granted': detail = validateProviderGranted(value, requireSeq); break;
    case 'provider.cancel': detail = validateProviderCancel(value, requireSeq); break;
    case 'provider.cancelled': detail = validateProviderCancelled(value, requireSeq); break;
    case 'provider.rejected': detail = validateProviderRejected(value, requireSeq); break;
    case 'provider.cancelAck': detail = validateProviderCancelAck(value, requireSeq); break;
    case 'provider.observation': detail = validateProviderObservation(value, requireSeq); break;
    case 'provider.release': detail = validateProviderRelease(value, requireSeq); break;
    case 'provider.released': detail = validateProviderReleased(value, requireSeq); break;
    case 'settings.mutate': detail = validateSettingsMutate(value, requireSeq); break;
    case 'settings.authoritative': detail = validateSettingsAuthoritative(value, requireSeq); break;
    case 'sync': detail = validateSync(value, requireSeq); break;
    case 'sync.ack': detail = validateSyncAck(value, requireSeq); break;
    case 'interrupt': detail = validateInterrupt(value, requireSeq); break;
    case 'shutdown': detail = validateShutdown(value, requireSeq); break;
    case 'ready': detail = validateReady(value, requireSeq); break;
    case 'response': detail = validateResponse(value, requireSeq); break;
    case 'heartbeat': detail = validateHeartbeat(value, requireSeq); break;
    case 'fatal': detail = validateFatal(value, requireSeq); break;
    case 'detail.subscribe': detail = validateDetailSubscribe(value, requireSeq); break;
    case 'detail.unsubscribe': detail = validateDetailUnsubscribe(value, requireSeq); break;
    case 'detail.fetch': detail = validateDetailFetch(value, requireSeq); break;
    case 'detail.start': detail = validateDetailStart(value, requireSeq); break;
    case 'detail.page': detail = validateDetailPage(value, requireSeq); break;
    case 'detail.delta': detail = validateDetailDelta(value, requireSeq); break;
    case 'detail.rebase': detail = validateDetailRebase(value, requireSeq); break;
    case 'detail.terminal': detail = validateDetailTerminal(value, requireSeq); break;
    case 'detail.error': detail = validateDetailError(value, requireSeq); break;
    case 'detail.unsubscribed': detail = validateDetailUnsubscribed(value, requireSeq); break;
    default: return { ok: false, detail: 'Unknown frame kind.' };
  }
  return detail ? { ok: false, detail } : { ok: true, value: value as unknown as WorkerIpcFrame };
}

function validateFrame<T extends WorkerIpcFrame>(
  value: unknown,
  expectation: WorkerFrameExpectation,
  direction: 'coordinator' | 'worker',
): WorkerFrameValidation<T> {
  const measurement = measureWorkerIpcMessage(value);
  if (!measurement.ok) return { status: 'invalid', reason: 'not_serializable', detail: measurement.detail };
  const wireBytes = measurement.bytes + 1; // final JSONL LF is part of every transport frame
  if (wireBytes > WORKER_IPC_MAX_FRAME_BYTES) {
    return invalidSize('frame_too_large', wireBytes, WORKER_IPC_MAX_FRAME_BYTES);
  }

  const rawKind = isRecord(value) && typeof value.kind === 'string' ? value.kind : undefined;
  if (rawKind !== undefined) {
    const semanticLimit = workerIpcFrameByteLimit(value);
    if (wireBytes > semanticLimit) {
      return invalidSize(rawKind === 'heartbeat' ? 'heartbeat_frame_too_large' : 'ordinary_frame_too_large', wireBytes, semanticLimit);
    }
  }

  const shaped = parseWorkerIpcFrameShape(value);
  if (!shaped.ok) return { status: 'invalid', reason: 'invalid_shape', detail: shaped.detail, bytes: measurement.bytes };
  const frame = shaped.value;

  const coordinatorKinds: ReadonlySet<WorkerIpcFrameKind> = new Set([
    'bootstrap', 'command', 'runtime.promote', 'runtime.command', 'sync',
    'ownership.reserved', 'ownership.committed', 'ownership.consumed', 'ownership.aborted', 'ownership.rejected', 'ownership.runtimeReadyAck',
    'provider.granted', 'provider.cancelled', 'provider.rejected', 'provider.cancelAck', 'provider.released', 'settings.authoritative', 'interrupt', 'shutdown',
    'detail.subscribe', 'detail.unsubscribe', 'detail.fetch',
  ]);
  if ((direction === 'coordinator') !== coordinatorKinds.has(frame.kind)) {
    return { status: 'invalid', reason: 'wrong_direction', detail: `Frame kind ${frame.kind} is not valid in the ${direction}-to-peer direction.`, bytes: measurement.bytes };
  }
  if (frame.ipcVersion !== WORKER_IPC_VERSION) {
    return { status: 'invalid', reason: 'version_mismatch', detail: `Unsupported IPC version ${frame.ipcVersion}.`, bytes: measurement.bytes };
  }

  const coordinatorFence = compareFence(frame.coordinatorGeneration, expectation.coordinatorGeneration);
  if (coordinatorFence === 'stale') return { status: 'stale', frame: frame as T, bytes: measurement.bytes, reason: 'coordinator_generation' };
  if (coordinatorFence === 'future') return futureGeneration('coordinator', frame.coordinatorGeneration, expectation.coordinatorGeneration, measurement.bytes);
  const workerFence = compareFence(frame.workerGeneration, expectation.workerGeneration);
  if (workerFence === 'stale') return { status: 'stale', frame: frame as T, bytes: measurement.bytes, reason: 'worker_generation' };
  if (workerFence === 'future') return futureGeneration('worker', frame.workerGeneration, expectation.workerGeneration, measurement.bytes);

  if (frame.workerId !== expectation.workerId || frame.workerPid !== expectation.workerPid
      || frame.rootSessionPath !== expectation.rootSessionPath
      || frame.sessionPath !== expectation.sessionPath
      || frame.sessionPath !== frame.rootSessionPath
      || frame.leasePath !== expectation.leasePath
      || frame.leaseRevision !== expectation.leaseRevision) {
    return { status: 'invalid', reason: 'identity_mismatch', detail: 'Frame worker, PID, root, or current lease identity does not match the assigned worker.', bytes: measurement.bytes };
  }
  if (frame.seq < expectation.expectedSeq) return { status: 'stale', frame: frame as T, bytes: measurement.bytes, reason: 'sequence' };
  if (frame.seq > expectation.expectedSeq) {
    return { status: 'invalid', reason: 'sequence_gap', detail: `Expected sequence ${expectation.expectedSeq}, received ${frame.seq}.`, bytes: measurement.bytes };
  }
  return { status: 'accepted', frame: frame as T, bytes: measurement.bytes };
}

function invalidSize(reason: 'frame_too_large' | 'ordinary_frame_too_large' | 'heartbeat_frame_too_large', bytes: number, limit: number): WorkerFrameValidation<never> {
  return { status: 'invalid', reason, detail: `IPC frame is ${bytes} UTF-8 bytes; limit is ${limit}.`, bytes };
}

function futureGeneration(name: string, actual: number, expected: number, bytes: number): WorkerFrameValidation<never> {
  return { status: 'invalid', reason: 'future_generation', detail: `Frame declares future ${name} generation ${actual}; expected ${expected}.`, bytes };
}

function compareFence(actual: number, expected: number): 'current' | 'stale' | 'future' {
  return actual === expected ? 'current' : actual < expected ? 'stale' : 'future';
}

function validateBase(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  if (!isSafePositiveInteger(value.ipcVersion)) return 'ipcVersion must be a positive safe integer.';
  if (!isSafePositiveInteger(value.coordinatorGeneration)) return 'coordinatorGeneration must be a positive safe integer.';
  if (!boundedString(value.workerId, MAX_ID_BYTES)) return 'workerId must be a bounded non-empty string.';
  if (!isSafePositiveInteger(value.workerGeneration)) return 'workerGeneration must be a positive safe integer.';
  if (!isSafePositiveInteger(value.workerPid)) return 'workerPid must be a positive safe integer.';
  if (!boundedString(value.rootSessionPath, MAX_SESSION_PATH_BYTES)) return 'rootSessionPath must be a bounded non-empty string.';
  if (!boundedString(value.leasePath, MAX_SESSION_PATH_BYTES)) return 'leasePath must be a bounded non-empty string.';
  if (!isSafePositiveInteger(value.leaseRevision)) return 'leaseRevision must be a positive safe integer.';
  if (!boundedString(value.sessionPath, MAX_SESSION_PATH_BYTES)) return 'sessionPath must be a bounded non-empty string.';
  if (value.sessionPath !== value.rootSessionPath) return 'sessionPath must equal immutable rootSessionPath.';
  if (requireSeq && !isSafePositiveInteger(value.seq)) return 'seq must be a positive safe integer.';
  return undefined;
}

const FRAME_BASE_KEYS = [
  'ipcVersion', 'coordinatorGeneration', 'workerId', 'workerGeneration', 'workerPid',
  'rootSessionPath', 'leasePath', 'leaseRevision', 'sessionPath', 'seq', 'kind',
] as const;
const DRAFT_BASE_KEYS = [
  'ipcVersion', 'coordinatorGeneration', 'workerId', 'workerGeneration', 'workerPid',
  'rootSessionPath', 'leasePath', 'leaseRevision', 'sessionPath', 'kind',
] as const;

function baseKeys(requireSeq: boolean): readonly string[] {
  return requireSeq ? FRAME_BASE_KEYS : DRAFT_BASE_KEYS;
}

function validateBootstrap(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'heartbeatIntervalMs', 'sdkPatchIdentity']);
  if (extra) return extra;
  if (!isSafePositiveInteger(value.heartbeatIntervalMs) || value.heartbeatIntervalMs > 60_000) return 'heartbeatIntervalMs must be a safe integer from 1 through 60000.';
  return validateSdkPatchIdentityShape(value.sdkPatchIdentity);
}

function validateSdkPatchIdentityShape(value: unknown): string | undefined {
  if (!isRecord(value)) return 'sdkPatchIdentity must be an object.';
  const root = exactKeys(value, [
    'identityVersion',
    'sdkPath',
    'sdkVersion',
    'terminalDurability',
    'retryClassifier',
    'coldCreateDurability',
    'sessionOwnershipAdapter',
    'sessionReplacementAdapter',
  ]);
  if (root) return `sdkPatchIdentity ${root}`;
  if (value.identityVersion !== SDK_PATCH_IDENTITY_VERSION) {
    return `sdkPatchIdentity.identityVersion must be ${SDK_PATCH_IDENTITY_VERSION}.`;
  }
  if (!boundedString(value.sdkPath, MAX_SESSION_PATH_BYTES)) return 'sdkPatchIdentity.sdkPath must be a bounded non-empty string.';
  if (!boundedString(value.sdkVersion, MAX_ID_BYTES)) return 'sdkPatchIdentity.sdkVersion must be a bounded non-empty string.';
  for (const [name, file] of [
    ['terminalDurability', value.terminalDurability],
    ['retryClassifier', value.retryClassifier],
    ['coldCreateDurability', value.coldCreateDurability],
    ['sessionOwnershipAdapter', value.sessionOwnershipAdapter],
    ['sessionReplacementAdapter', value.sessionReplacementAdapter],
  ] as const) {
    if (!isRecord(file)) return `sdkPatchIdentity.${name} must be an object.`;
    const nested = exactKeys(file, ['patchVersion', 'relativePath', 'sha256']);
    if (nested) return `sdkPatchIdentity.${name} ${nested}`;
    if (!isSafePositiveInteger(file.patchVersion)) return `sdkPatchIdentity.${name}.patchVersion must be a positive safe integer.`;
    if (!boundedString(file.relativePath, MAX_SESSION_PATH_BYTES)) return `sdkPatchIdentity.${name}.relativePath must be a bounded non-empty string.`;
    if (!boundedString(file.sha256, 64) || !/^[a-f0-9]{64}$/u.test(file.sha256)) return `sdkPatchIdentity.${name}.sha256 must be a lowercase SHA-256 digest.`;
  }
  return undefined;
}

function validateCommand(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'operation']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (value.operation !== 'ping') return 'operation must be the Phase 2 ping command.';
  return undefined;
}

const RUNTIME_OPERATIONS: ReadonlySet<WorkerRuntimeOperation> = new Set([
  'session.open', 'session.preload', 'session.loadTranscriptPage', 'session.loadDetail',
  'session.truncateAfter', 'session.title.generate', 'models.list', 'liveTurn.checkpoint', 'message.send', 'operation.status', 'message.continue', 'message.compact',
  'message.clearQueue', 'message.replaceQueue', 'extension_ui.response',
  'settings.set', 'systemPromptToggles.set', 'test.extensionCommand',
]);

const RUNTIME_EVENT_NAMES: ReadonlySet<WorkerRuntimeEventName> = new Set([
  'session.opened', 'message.started', 'message.delta', 'message.thinking',
  'message.toolCallDelta', 'message.finished', 'message.aborted', 'message.custom',
  'message.queuedDelivered', 'tool.started', 'tool.progress', 'tool.finished',
  'agent.settled', 'busy.changed', 'contextUsage.changed', 'extension_ui.request', 'preflight.failed',
  'retry.started', 'retry.ended', 'retry.measured', 'retry.stuck',
  'compaction.started', 'compaction.ended', 'auxiliary-llm.usage', 'live.semantic',
  'live.lifecycle', 'operational-error', 'error',
]);

const SYNC_DOMAINS: ReadonlySet<WorkerSyncDomain> = new Set([
  'settings', 'catalog', 'auth', 'runtimePrefs', 'providerPolicy', 'sessionRegistry',
]);

function validateRuntimePromote(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'operationId', 'payload']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!boundedString(value.operationId, MAX_ID_BYTES)) return 'operationId must be a bounded non-empty string.';
  if (!isRecord(value.payload)) return 'runtime.promote.payload must be an object.';
  const payloadKeys = exactKeys(value.payload, [
    'sdkPath', 'agentDir', 'startupCwd', 'sessionDir', 'sessionPath', 'creationReason',
    'writeLease', 'openedPayload', 'modelSettings',
  ]);
  if (payloadKeys) return `runtime.promote.payload ${payloadKeys}`;
  for (const key of ['sdkPath', 'agentDir', 'startupCwd', 'sessionDir', 'sessionPath'] as const) {
    if (!boundedString(value.payload[key], MAX_SESSION_PATH_BYTES)) return `runtime.promote.payload.${key} must be a bounded non-empty string.`;
  }
  if (value.payload.creationReason !== 'new' && value.payload.creationReason !== 'resume') return 'runtime.promote.payload.creationReason is invalid.';
  const leaseError = validateLease(value.payload.writeLease, value, true);
  if (leaseError) return `runtime.promote.payload.writeLease ${leaseError}`;
  if (!isRecord(value.payload.openedPayload) || !isRecord(value.payload.modelSettings)) return 'runtime.promote openedPayload and modelSettings must be objects.';
  return validateJsonObject(value.payload, 'runtime.promote.payload');
}

function validateRuntimeReady(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'runtimeMetadata']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!isRecord(value.runtimeMetadata)) return 'runtimeMetadata must be an object.';
  const nested = exactKeys(value.runtimeMetadata, ['mode', 'startedAt']);
  if (nested) return `runtimeMetadata ${nested}`;
  if (value.runtimeMetadata.mode !== 'phase4') return 'runtimeMetadata.mode must be phase4.';
  if (!isSafeNonNegativeInteger(value.runtimeMetadata.startedAt)) return 'runtimeMetadata.startedAt must be a non-negative safe integer.';
  return undefined;
}

function validateRuntimeCommand(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'operation', 'payload']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (typeof value.operation !== 'string' || !RUNTIME_OPERATIONS.has(value.operation as WorkerRuntimeOperation)) return 'runtime.command.operation is invalid.';
  if (!isRecord(value.payload)) return 'runtime.command.payload must be an object.';
  const payloadKeys = exactKeys(value.payload, ['params', 'publicRequestId']);
  if (payloadKeys) return `runtime.command.payload ${payloadKeys}`;
  if (!boundedString(value.payload.publicRequestId, MAX_ID_BYTES)) return 'runtime.command.payload.publicRequestId must be bounded.';
  return validateJsonValue(value.payload.params, 'runtime.command.payload.params');
}

function validateRuntimeEvent(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'event', 'payload']);
  if (extra) return extra;
  if (typeof value.event !== 'string' || !RUNTIME_EVENT_NAMES.has(value.event as WorkerRuntimeEventName)) return 'runtime.event.event is invalid.';
  return validateJsonObject(value.payload, 'runtime.event.payload');
}

function validateRuntimeReport(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'domain', 'payload']);
  if (extra) return extra;
  if (value.domain !== 'catalog') return 'runtime.report.domain must be catalog.';
  if (!isRecord(value.payload)) return 'runtime.report.payload must be an object.';
  const nested = exactKeys(value.payload, ['models']);
  if (nested) return `runtime.report.payload ${nested}`;
  if (!Array.isArray(value.payload.models)) return 'runtime.report.payload.models must be an array.';
  return validateJsonValue(value.payload.models, 'runtime.report.payload.models');
}

function validateOwnershipReserve(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'intent']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  return validateReplacementIntent(value.intent, value);
}

function validateOwnershipReserved(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'reservation']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  return validateCurrentReservation(value.reservation, value);
}

function validateOwnershipCommit(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'reservation', 'sourceLease']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  return validateCurrentReservation(value.reservation, value) ?? validateLease(value.sourceLease, value, true);
}

function validateOwnershipCommitted(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'authorization']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  return validateTransferAuthorization(value.authorization, value);
}

function validateOwnershipConsume(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'authorization', 'canonicalDestinationPath']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (value.canonicalDestinationPath !== value.leasePath) return 'ownership consume destination must match the current leasePath.';
  const detail = validateTransferAuthorization(value.authorization, value);
  if (detail) return detail;
  const authorization = value.authorization as Record<string, unknown>;
  return authorization.canonicalDestinationPath === value.canonicalDestinationPath
    ? undefined
    : 'ownership consume authorization destination mismatch.';
}

function validateOwnershipConsumed(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'authorizationId', 'lease']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.authorizationId, MAX_ID_BYTES)) {
    return 'requestId and authorizationId must be bounded non-empty strings.';
  }
  return validateLease(value.lease, value, true);
}

function validateOwnershipAbort(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'reservation', 'reason']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!boundedString(value.reason, MAX_REASON_BYTES)) return 'reason must be a bounded non-empty string.';
  return validateCurrentReservation(value.reservation, value);
}

function validateOwnershipAborted(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'reservationId']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.reservationId, MAX_ID_BYTES)) return 'requestId and reservationId must be bounded non-empty strings.';
  return undefined;
}

function validateOwnershipRejected(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'phase', 'code', 'message', 'retryable']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (value.phase !== 'reserve' && value.phase !== 'commit' && value.phase !== 'consume'
      && value.phase !== 'abort' && value.phase !== 'runtimeReady') return 'ownership.rejected.phase is invalid.';
  if (value.code !== 'OWNERSHIP_CONFLICT' && value.code !== 'STALE_OWNERSHIP' && value.code !== 'OWNERSHIP_FAILED') return 'ownership.rejected.code is invalid.';
  if (!boundedString(value.message, MAX_ERROR_MESSAGE_BYTES)) return 'ownership.rejected.message must be bounded.';
  if (typeof value.retryable !== 'boolean') return 'ownership.rejected.retryable must be boolean.';
  return undefined;
}

function validateOwnershipRuntimeReady(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'lease', 'canonicalPath']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!boundedString(value.canonicalPath, MAX_SESSION_PATH_BYTES) || value.canonicalPath !== value.leasePath) return 'canonicalPath must equal the current leasePath.';
  return validateLease(value.lease, value, true);
}

function validateOwnershipRuntimeReadyAck(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'canonicalPath', 'ownershipRevision']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (value.canonicalPath !== value.leasePath || value.ownershipRevision !== value.leaseRevision) return 'runtime-ready acknowledgement must match the current lease identity.';
  return undefined;
}

function validateProviderAcquire(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'request']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!isRecord(value.request)) return 'provider.acquire.request must be an object.';
  const nested = exactKeys(value.request, ['provider', 'model', 'turnId', 'attemptId']);
  if (nested) return `provider.acquire.request ${nested}`;
  for (const key of ['provider', 'model', 'turnId', 'attemptId'] as const) {
    if (!boundedString(value.request[key], MAX_ID_BYTES)) return `provider.acquire.request.${key} must be a bounded non-empty string.`;
  }
  return undefined;
}

function validateProviderGranted(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'lease']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!isRecord(value.lease)) return 'provider.granted.lease must be an object.';
  const nested = exactKeys(value.lease, [
    'leaseId', 'provider', 'model', 'grantedAt', 'headerWaitMs', 'streamIdleTimeoutMs',
  ]);
  if (nested) return `provider.granted.lease ${nested}`;
  for (const key of ['leaseId', 'provider', 'model'] as const) {
    if (!boundedString(value.lease[key], MAX_ID_BYTES)) return `provider.granted.lease.${key} must be a bounded non-empty string.`;
  }
  if (!isSafeNonNegativeInteger(value.lease.grantedAt)) return 'provider.granted.lease.grantedAt must be a non-negative safe integer.';
  if (!isSafePositiveInteger(value.lease.headerWaitMs)) return 'provider.granted.lease.headerWaitMs must be a positive safe integer.';
  if (!isSafePositiveInteger(value.lease.streamIdleTimeoutMs)) return 'provider.granted.lease.streamIdleTimeoutMs must be a positive safe integer.';
  return undefined;
}

function validateProviderCancel(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'targetRequestId', 'reason']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.targetRequestId, MAX_ID_BYTES)) {
    return 'requestId and targetRequestId must be bounded non-empty strings.';
  }
  if (!boundedString(value.reason, MAX_REASON_BYTES)) return 'provider.cancel.reason must be bounded.';
  return undefined;
}

function validateProviderCancelled(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'reason']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.reason, MAX_REASON_BYTES)) {
    return 'provider.cancelled fields must be bounded non-empty strings.';
  }
  return undefined;
}

function validateProviderRejected(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'error']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!isRecord(value.error)) return 'provider.rejected.error must be an object.';
  const nested = exactKeys(value.error, ['name', 'message', 'retryable'], ['httpStatus']);
  if (nested) return `provider.rejected.error ${nested}`;
  if (!boundedString(value.error.name, MAX_ID_BYTES)) return 'provider.rejected.error.name must be bounded.';
  if (!boundedString(value.error.message, MAX_ERROR_MESSAGE_BYTES)) return 'provider.rejected.error.message must be bounded.';
  if (typeof value.error.retryable !== 'boolean') return 'provider.rejected.error.retryable must be boolean.';
  if (value.error.httpStatus !== undefined
      && (!Number.isSafeInteger(value.error.httpStatus) || Number(value.error.httpStatus) < 100 || Number(value.error.httpStatus) > 599)) {
    return 'provider.rejected.error.httpStatus must be an HTTP status from 100 through 599.';
  }
  return undefined;
}

function validateProviderCancelAck(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'targetRequestId', 'status'], ['leaseId']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.targetRequestId, MAX_ID_BYTES)) {
    return 'requestId and targetRequestId must be bounded non-empty strings.';
  }
  if (value.status !== 'queued' && value.status !== 'granted' && value.status !== 'not-found') {
    return 'provider.cancelAck.status is invalid.';
  }
  if (value.leaseId !== undefined && !boundedString(value.leaseId, MAX_ID_BYTES)) return 'provider.cancelAck.leaseId must be bounded.';
  if (value.status === 'granted' && value.leaseId === undefined) return 'provider.cancelAck granted status requires leaseId.';
  return undefined;
}

function validateProviderObservation(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'leaseId', 'observation']);
  if (extra) return extra;
  if (!boundedString(value.leaseId, MAX_ID_BYTES)) return 'provider.observation.leaseId must be bounded.';
  if (!isRecord(value.observation)) return 'provider.observation.observation must be an object.';
  const nested = exactKeys(value.observation, ['classification', 'retryable'], ['status']);
  if (nested) return `provider.observation.observation ${nested}`;
  if (value.observation.classification !== 'success' && value.observation.classification !== 'http-error'
      && value.observation.classification !== 'transport-error' && value.observation.classification !== 'cancelled') {
    return 'provider.observation.classification is invalid.';
  }
  if (typeof value.observation.retryable !== 'boolean') return 'provider.observation.retryable must be boolean.';
  if (value.observation.status !== undefined
      && (!isSafeNonNegativeInteger(value.observation.status) || Number(value.observation.status) > 999)) {
    return 'provider.observation.status is invalid.';
  }
  return undefined;
}

function validateProviderRelease(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'leaseId', 'outcome']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.leaseId, MAX_ID_BYTES)) return 'requestId and leaseId must be bounded non-empty strings.';
  if (value.outcome !== 'completed' && value.outcome !== 'failed' && value.outcome !== 'cancelled') return 'provider.release.outcome is invalid.';
  return undefined;
}

function validateProviderReleased(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'leaseId']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.leaseId, MAX_ID_BYTES)) return 'requestId and leaseId must be bounded non-empty strings.';
  return undefined;
}

function validateSettingsMutate(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'updates']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  return validateJsonObject(value.updates, 'settings.mutate.updates');
}

function validateSettingsAuthoritative(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'revision', 'values']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!isSafePositiveInteger(value.revision)) return 'settings.authoritative.revision must be positive.';
  return validateJsonObject(value.values, 'settings.authoritative.values');
}

function validateSync(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'domain', 'revision', 'payload']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (typeof value.domain !== 'string' || !SYNC_DOMAINS.has(value.domain as WorkerSyncDomain)) return 'sync.domain is invalid.';
  if (!isSafePositiveInteger(value.revision)) return 'sync.revision must be a positive safe integer.';
  if (!isRecord(value.payload)) return 'sync.payload must be an object.';
  switch (value.domain) {
    case 'settings':
    case 'runtimePrefs': {
      const nested = exactKeys(value.payload, ['values']);
      return nested ? `sync.payload ${nested}` : validateJsonObject(value.payload.values, 'sync.payload.values');
    }
    case 'catalog': {
      const nested = exactKeys(value.payload, ['models']);
      if (nested) return `sync.payload ${nested}`;
      if (!Array.isArray(value.payload.models)) return 'sync.payload.models must be an array.';
      return validateJsonValue(value.payload.models, 'sync.payload.models');
    }
    case 'auth': {
      const nested = exactKeys(value.payload, ['authPath', 'fingerprint']);
      if (nested) return `sync.payload ${nested}`;
      if (!boundedString(value.payload.authPath, MAX_SESSION_PATH_BYTES) || !boundedString(value.payload.fingerprint, MAX_ID_BYTES)) return 'auth sync payload fields must be bounded non-empty strings.';
      return undefined;
    }
    case 'providerPolicy': {
      const nested = exactKeys(value.payload, ['providers']);
      return nested ? `sync.payload ${nested}` : validateJsonObject(value.payload.providers, 'sync.payload.providers');
    }
    case 'sessionRegistry': {
      const nested = exactKeys(value.payload, ['tabs']);
      if (nested) return `sync.payload ${nested}`;
      if (!Array.isArray(value.payload.tabs)) return 'sync.payload.tabs must be an array.';
      return validateJsonValue(value.payload.tabs, 'sync.payload.tabs');
    }
  }
}

function validateSyncAck(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'domain', 'revision']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (typeof value.domain !== 'string' || !SYNC_DOMAINS.has(value.domain as WorkerSyncDomain)) return 'sync.ack.domain is invalid.';
  if (!isSafePositiveInteger(value.revision)) return 'sync.ack.revision must be a positive safe integer.';
  return undefined;
}

function validateInterrupt(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'reason'], ['targetRequestId']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (value.targetRequestId !== undefined && !boundedString(value.targetRequestId, MAX_ID_BYTES)) return 'targetRequestId must be a bounded non-empty string.';
  if (!boundedString(value.reason, MAX_REASON_BYTES)) return 'reason must be a bounded non-empty string.';
  return undefined;
}

function validateShutdown(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'reason']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!boundedString(value.reason, MAX_REASON_BYTES)) return 'reason must be a bounded non-empty string.';
  return undefined;
}

function validateReady(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'runtimeMetadata']);
  if (extra) return extra;
  if (!isRecord(value.runtimeMetadata)) return 'runtimeMetadata must be an object.';
  const nested = exactKeys(value.runtimeMetadata, ['mode', 'startedAt']);
  if (nested) return `runtimeMetadata ${nested}`;
  if (value.runtimeMetadata.mode !== 'phase2') return 'runtimeMetadata.mode must be phase2.';
  if (!isSafeNonNegativeInteger(value.runtimeMetadata.startedAt)) return 'runtimeMetadata.startedAt must be a non-negative safe integer.';
  return undefined;
}

function validateResponse(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const allowed = value.ok === true
    ? [...baseKeys(requireSeq), 'requestId', 'ok', 'result']
    : [...baseKeys(requireSeq), 'requestId', 'ok', 'error'];
  const extra = exactKeys(value, allowed);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (value.ok === true) return validateResponseResult(value.result);
  if (value.ok === false) return validateWorkerError(value.error);
  return 'response.ok must be boolean.';
}

function validateResponseResult(value: unknown): string | undefined {
  if (!isRecord(value)) return 'response.result must be an object.';
  if (value.kind === 'runtime.command') {
    const extra = exactKeys(value, ['kind', 'payload']);
    return extra ? `response.result ${extra}` : validateJsonValue(value.payload, 'response.result.payload');
  }
  const extra = exactKeys(value, ['kind']);
  if (extra) return `response.result ${extra}`;
  if (value.kind !== 'pong' && value.kind !== 'interrupted' && value.kind !== 'shutting-down') return 'response.result.kind is invalid.';
  return undefined;
}

function validateWorkerError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'response.error must be an object.';
  const extra = exactKeys(value, ['code', 'message', 'retryable']);
  if (extra) return `response.error ${extra}`;
  if (value.code !== 'COMMAND_FAILED' && value.code !== 'RUNTIME_COMMAND_FAILED'
      && value.code !== 'INTERRUPT_FAILED' && value.code !== 'SHUTDOWN_FAILED'
      && value.code !== 'OPERATION_INTENT_MISMATCH') return 'response.error.code is invalid.';
  if (!boundedString(value.message, MAX_ERROR_MESSAGE_BYTES)) return 'response.error.message must be a bounded non-empty string.';
  if (typeof value.retryable !== 'boolean') return 'response.error.retryable must be boolean.';
  return undefined;
}

function validateDetailSubscribe(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'subscriptionId', 'address', 'maxPageBytes'], ['cursor']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.subscriptionId, MAX_ID_BYTES)) return 'detail subscribe identities must be bounded.';
  if (!isLiveSubagentDetailAddress(value.address)) return 'detail.subscribe.address is invalid or not producer-addressable.';
  if (value.cursor !== undefined && !isDetailCursor(value.cursor)) return 'detail.subscribe.cursor is invalid.';
  if (!isSafePositiveInteger(value.maxPageBytes) || value.maxPageBytes > WORKER_IPC_MAX_ORDINARY_FRAME_BYTES) return 'detail.subscribe.maxPageBytes is invalid.';
  return undefined;
}

function validateDetailUnsubscribe(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'subscriptionId']);
  if (extra) return extra;
  return boundedString(value.requestId, MAX_ID_BYTES) && boundedString(value.subscriptionId, MAX_ID_BYTES)
    ? undefined : 'detail unsubscribe identities must be bounded.';
}

function validateDetailFetch(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'subscriptionId', 'address', 'ref', 'maxPageBytes']);
  if (extra) return extra;
  if (!boundedString(value.requestId, MAX_ID_BYTES) || !boundedString(value.subscriptionId, MAX_ID_BYTES)) return 'detail fetch identities must be bounded.';
  if (!isLiveSubagentDetailAddress(value.address) || !isDetailPageRef(value.ref)) return 'detail.fetch address or ref is invalid.';
  if (!isSafePositiveInteger(value.maxPageBytes) || value.maxPageBytes > WORKER_IPC_MAX_ORDINARY_FRAME_BYTES) return 'detail.fetch.maxPageBytes is invalid.';
  return undefined;
}

function validateDetailStart(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'subscriptionId', 'address', 'source', 'baselineRevision', 'pageCount', 'totalBytes', 'totalCodePoints']);
  if (extra) return extra;
  return boundedString(value.requestId, MAX_ID_BYTES) && boundedString(value.subscriptionId, MAX_ID_BYTES)
    && isLiveSubagentDetailAddress(value.address) && (value.source === 'live' || value.source === 'durable')
    && isSafeNonNegativeInteger(value.baselineRevision) && isSafePositiveInteger(value.pageCount)
    && isSafeNonNegativeInteger(value.totalBytes) && isSafeNonNegativeInteger(value.totalCodePoints)
    ? undefined : 'detail.start fields are invalid.';
}

function validateDetailPage(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'subscriptionId', 'ref', 'payload', 'payloadBytes', 'checksum'], ['requestId']);
  if (extra) return extra;
  if (value.requestId !== undefined && !boundedString(value.requestId, MAX_ID_BYTES)) return 'detail.page.requestId is invalid.';
  if (!boundedString(value.subscriptionId, MAX_ID_BYTES) || !isDetailPageRef(value.ref)
    || !isDetailPagePayload(value.payload) || !isSafeNonNegativeInteger(value.payloadBytes)
    || value.payloadBytes !== Buffer.byteLength(JSON.stringify(value.payload), 'utf8')
    || !boundedString(value.checksum, 64) || !/^[a-f0-9]{64}$/u.test(value.checksum)) return 'detail.page fields are invalid.';
  return undefined;
}

function validateDetailDelta(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'subscriptionId', 'baseRevision', 'revision', 'operations']);
  if (extra) return extra;
  return boundedString(value.subscriptionId, MAX_ID_BYTES)
    && isSafeNonNegativeInteger(value.baseRevision) && isSafePositiveInteger(value.revision)
    && value.revision > value.baseRevision && isPatchOperations(value.operations)
    ? undefined : 'detail.delta fields are invalid.';
}

function validateDetailRebase(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'subscriptionId', 'currentRevision', 'reason']);
  if (extra) return extra;
  return boundedString(value.subscriptionId, MAX_ID_BYTES) && isSafeNonNegativeInteger(value.currentRevision)
    && (value.reason === 'gap' || value.reason === 'backpressure' || value.reason === 'evicted' || value.reason === 'generation-change')
    ? undefined : 'detail.rebase fields are invalid.';
}

function validateDetailTerminal(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'subscriptionId', 'revision', 'durableRef']);
  if (extra) return extra;
  return boundedString(value.subscriptionId, MAX_ID_BYTES) && isSafeNonNegativeInteger(value.revision)
    ? validateDetailLazyRef(value.durableRef) : 'detail.terminal fields are invalid.';
}

function validateDetailError(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'subscriptionId', 'code', 'message', 'retryable'], ['requestId']);
  if (extra) return extra;
  if (value.requestId !== undefined && !boundedString(value.requestId, MAX_ID_BYTES)) return 'detail.error.requestId is invalid.';
  const codes: ReadonlySet<string> = new Set(['INVALID_ADDRESS', 'NOT_LIVE_ADDRESSABLE', 'NOT_FOUND', 'STALE_CURSOR', 'CHECKSUM_MISMATCH', 'SUBSCRIPTION_CONFLICT', 'UNAVAILABLE', 'INTERNAL_ERROR']);
  return boundedString(value.subscriptionId, MAX_ID_BYTES) && typeof value.code === 'string' && codes.has(value.code)
    && boundedString(value.message, MAX_ERROR_MESSAGE_BYTES) && typeof value.retryable === 'boolean'
    ? undefined : 'detail.error fields are invalid.';
}

function validateDetailUnsubscribed(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'requestId', 'subscriptionId']);
  if (extra) return extra;
  return boundedString(value.requestId, MAX_ID_BYTES) && boundedString(value.subscriptionId, MAX_ID_BYTES)
    ? undefined : 'detail.unsubscribed fields are invalid.';
}

function validateDetailLazyRef(value: unknown): string | undefined {
  if (!isRecord(value)) return 'detail durableRef must be an object.';
  const extra = exactKeys(value,
    ['key', 'kind', 'source', 'sessionPath', 'messageId', 'sizeBytes', 'summary', 'available'],
    ['toolCallId', 'executionId', 'partIndex', 'sourceRevision', 'childCount', 'lineCount']);
  if (extra) return `detail durableRef ${extra}`;
  if (!boundedString(value.key, MAX_SESSION_PATH_BYTES) || value.kind !== 'tool-result' || value.source !== 'durable'
    || !boundedString(value.sessionPath, MAX_SESSION_PATH_BYTES) || !boundedString(value.messageId, MAX_ID_BYTES)
    || !isSafeNonNegativeInteger(value.sizeBytes) || typeof value.summary !== 'string' || typeof value.available !== 'boolean') return 'detail durableRef fields are invalid.';
  for (const key of ['toolCallId', 'executionId'] as const) if (value[key] !== undefined && !boundedString(value[key], MAX_ID_BYTES)) return `detail durableRef.${key} is invalid.`;
  for (const key of ['partIndex', 'sourceRevision', 'childCount', 'lineCount'] as const) if (value[key] !== undefined && !isSafeNonNegativeInteger(value[key])) return `detail durableRef.${key} is invalid.`;
  return undefined;
}

function validateHeartbeat(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'heartbeat']);
  if (extra) return extra;
  if (!isRecord(value.heartbeat)) return 'heartbeat must be an object.';
  const nested = exactKeys(value.heartbeat,
    ['phase', 'lastEventSeq', 'lastDetailRevision', 'eventLoopDelayMs'],
    ['activeRequestId', 'lastDurableAppendId']);
  if (nested) return `heartbeat ${nested}`;
  if (value.heartbeat.phase !== 'bootstrapping' && value.heartbeat.phase !== 'ready'
    && value.heartbeat.phase !== 'busy' && value.heartbeat.phase !== 'interrupting'
    && value.heartbeat.phase !== 'shutting-down') return 'heartbeat.phase is invalid.';
  if (value.heartbeat.activeRequestId !== undefined && !boundedString(value.heartbeat.activeRequestId, MAX_ID_BYTES)) return 'heartbeat.activeRequestId must be a bounded non-empty string.';
  if (!isSafeNonNegativeInteger(value.heartbeat.lastEventSeq)) return 'heartbeat.lastEventSeq must be a non-negative safe integer.';
  if (!isSafeNonNegativeInteger(value.heartbeat.lastDetailRevision)) return 'heartbeat.lastDetailRevision must be a non-negative safe integer.';
  if (!isSafeNonNegativeInteger(value.heartbeat.eventLoopDelayMs)) return 'heartbeat.eventLoopDelayMs must be a non-negative safe integer.';
  if (value.heartbeat.lastDurableAppendId !== undefined && !boundedString(value.heartbeat.lastDurableAppendId, MAX_ID_BYTES)) return 'heartbeat.lastDurableAppendId must be a bounded non-empty string.';
  return undefined;
}

function validateFatal(value: Record<string, unknown>, requireSeq: boolean): string | undefined {
  const extra = exactKeys(value, [...baseKeys(requireSeq), 'error'], ['requestId']);
  if (extra) return extra;
  if (value.requestId !== undefined && !boundedString(value.requestId, MAX_ID_BYTES)) return 'requestId must be a bounded non-empty string.';
  if (!isRecord(value.error)) return 'fatal.error must be an object.';
  const nested = exactKeys(value.error, ['code', 'phase', 'message']);
  if (nested) return `fatal.error ${nested}`;
  if (value.error.code !== 'BOOTSTRAP_FAILED' && value.error.code !== 'PROTOCOL_ERROR'
    && value.error.code !== 'IPC_ERROR' && value.error.code !== 'INTERNAL_ERROR') return 'fatal.error.code is invalid.';
  if (value.error.phase !== 'bootstrap' && value.error.phase !== 'command'
    && value.error.phase !== 'interrupt' && value.error.phase !== 'shutdown'
    && value.error.phase !== 'ipc') return 'fatal.error.phase is invalid.';
  if (!boundedString(value.error.message, MAX_ERROR_MESSAGE_BYTES)) return 'fatal.error.message must be a bounded non-empty string.';
  return undefined;
}

function validateLease(value: unknown, frame: Record<string, unknown>, requireCurrent: boolean): string | undefined {
  if (!isRecord(value)) return 'session write lease must be an object.';
  const extra = exactKeys(value, [
    'coordinatorGeneration', 'workerId', 'workerGeneration',
    'canonicalSessionPath', 'ownershipRevision', 'nonce',
  ]);
  if (extra) return `session write lease ${extra}`;
  if (!isSafePositiveInteger(value.coordinatorGeneration)
      || !boundedString(value.workerId, MAX_ID_BYTES)
      || !isSafePositiveInteger(value.workerGeneration)
      || !boundedString(value.canonicalSessionPath, MAX_SESSION_PATH_BYTES)
      || !isSafePositiveInteger(value.ownershipRevision)
      || !boundedString(value.nonce, MAX_ID_BYTES)) return 'session write lease fields are invalid.';
  if (value.coordinatorGeneration !== frame.coordinatorGeneration
      || value.workerId !== frame.workerId
      || value.workerGeneration !== frame.workerGeneration) return 'session write lease owner does not match the frame generation.';
  if (requireCurrent && (value.canonicalSessionPath !== frame.leasePath || value.ownershipRevision !== frame.leaseRevision)) {
    return 'session write lease does not match the frame current lease identity.';
  }
  return undefined;
}

function validateFingerprint(value: unknown): string | undefined {
  if (!isRecord(value)) return 'destinationFingerprint must be an object.';
  const extra = exactKeys(value, ['exists', 'size', 'sha256']);
  if (extra) return `destinationFingerprint ${extra}`;
  if (typeof value.exists !== 'boolean' || !isSafeNonNegativeInteger(value.size)) return 'destinationFingerprint fields are invalid.';
  if (value.sha256 !== null && (!boundedString(value.sha256, 64) || !/^[a-f0-9]{64}$/u.test(value.sha256))) return 'destinationFingerprint.sha256 must be null or a lowercase SHA-256 digest.';
  return undefined;
}

function validateCurrentReservation(value: unknown, frame: Record<string, unknown>): string | undefined {
  const detail = validateReservation(value);
  if (detail) return detail;
  return (value as Record<string, unknown>).canonicalSourcePath === frame.leasePath
    ? undefined
    : 'ownership reservation source does not match the frame current lease path.';
}

function validateReservation(value: unknown): string | undefined {
  if (!isRecord(value)) return 'ownership reservation must be an object.';
  const extra = exactKeys(value, [
    'reservationId', 'operationId', 'canonicalSourcePath', 'canonicalDestinationPath',
    'ownershipRevision', 'nonce', 'destinationFingerprint',
  ]);
  if (extra) return `ownership reservation ${extra}`;
  for (const key of ['reservationId', 'operationId', 'nonce'] as const) {
    if (!boundedString(value[key], MAX_ID_BYTES)) return `ownership reservation ${key} must be a bounded non-empty string.`;
  }
  for (const key of ['canonicalSourcePath', 'canonicalDestinationPath'] as const) {
    if (!boundedString(value[key], MAX_SESSION_PATH_BYTES)) return `ownership reservation ${key} must be a bounded non-empty path.`;
  }
  if (!isSafePositiveInteger(value.ownershipRevision)) return 'ownership reservation ownershipRevision must be a positive safe integer.';
  return validateFingerprint(value.destinationFingerprint);
}

function validateReplacementIntent(value: unknown, frame: Record<string, unknown>): string | undefined {
  if (!isRecord(value)) return 'ownership replacement intent must be an object.';
  const extra = exactKeys(value,
    ['operationId', 'reason', 'source', 'destinationPath', 'destinationMustNotExist'],
    ['requestedPath', 'importSourcePath', 'parentSessionPath', 'entryId', 'position']);
  if (extra) return `ownership replacement intent ${extra}`;
  if (!boundedString(value.operationId, MAX_ID_BYTES)) return 'ownership replacement operationId must be a bounded non-empty string.';
  if (value.reason !== 'new' && value.reason !== 'switch' && value.reason !== 'root-fork'
      && value.reason !== 'branch-fork' && value.reason !== 'clone' && value.reason !== 'import'
      && value.reason !== 'self-reopen') return 'ownership replacement reason is invalid.';
  if (!boundedString(value.destinationPath, MAX_SESSION_PATH_BYTES) || typeof value.destinationMustNotExist !== 'boolean') return 'ownership replacement destination fields are invalid.';
  for (const key of ['requestedPath', 'importSourcePath', 'parentSessionPath'] as const) {
    if (value[key] !== undefined && !boundedString(value[key], MAX_SESSION_PATH_BYTES)) return `ownership replacement ${key} must be a bounded non-empty path.`;
  }
  if (value.entryId !== undefined && !boundedString(value.entryId, MAX_ID_BYTES)) return 'ownership replacement entryId must be a bounded non-empty string.';
  if (value.position !== undefined && value.position !== 'before' && value.position !== 'at') return 'ownership replacement position is invalid.';
  return validateLease(value.source, frame, true);
}

function validateTransferAuthorization(value: unknown, frame: Record<string, unknown>): string | undefined {
  if (!isRecord(value)) return 'transfer authorization must be an object.';
  const extra = exactKeys(value, [
    'authorizationId', 'reservationId', 'canonicalDestinationPath',
    'ownershipRevision', 'nonce', 'destinationLease',
  ]);
  if (extra) return `transfer authorization ${extra}`;
  for (const key of ['authorizationId', 'reservationId', 'nonce'] as const) {
    if (!boundedString(value[key], MAX_ID_BYTES)) return `transfer authorization ${key} must be a bounded non-empty string.`;
  }
  if (!boundedString(value.canonicalDestinationPath, MAX_SESSION_PATH_BYTES) || !isSafePositiveInteger(value.ownershipRevision)) return 'transfer authorization destination identity is invalid.';
  const leaseDetail = validateLease(value.destinationLease, frame, false);
  if (leaseDetail) return leaseDetail;
  const lease = value.destinationLease as Record<string, unknown>;
  if (lease.canonicalSessionPath !== value.canonicalDestinationPath || lease.ownershipRevision !== value.ownershipRevision) return 'transfer authorization destination lease does not match its destination identity.';
  return undefined;
}

function validateJsonObject(value: unknown, label: string): string | undefined {
  if (!isRecord(value)) return `${label} must be a JSON object.`;
  return validateJsonValue(value, label);
}

function validateJsonValue(value: unknown, label: string): string | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    nodes += 1;
    if (nodes > 100_000) return `${label} is too structurally complex.`;
    if (item.depth > 64) return `${label} exceeds the maximum nesting depth.`;
    const current = item.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return `${label} contains a non-finite number.`;
      continue;
    }
    if (Array.isArray(current)) {
      for (const child of current) stack.push({ value: child, depth: item.depth + 1 });
      continue;
    }
    if (!isRecord(current)) return `${label} contains a non-JSON value.`;
    for (const [key, child] of Object.entries(current)) {
      if (!boundedString(key, MAX_ID_BYTES)) return `${label} contains an invalid object key.`;
      stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): string | undefined {
  const allowed = [...required, ...optional];
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  let ownKeyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return 'Frame fields must be enumerable data properties.';
    }
    if (!allowedSet.has(key)) {
      const safeKey = key.length <= 128 ? key : '<oversized-key>';
      return `contains unknown field ${safeKey}.`;
    }
    ownKeyCount += 1;
    // Stop inspecting a hostile object after the closed shape's maximum
    // possible key count. JSON.stringify is never allowed to discover the
    // remainder of an invalid object for us.
    if (ownKeyCount > allowed.length) return 'contains too many fields.';
    // An explicitly undefined optional property is omitted by JSON.stringify,
    // so it has the same wire shape as an absent property. Required undefined
    // values remain for the field-specific type check below.
    if (value[key] === undefined && !optionalSet.has(key)) continue;
  }
  const missing = required.find((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !descriptor.enumerable;
  });
  return missing ? `is missing required field ${missing}.` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
