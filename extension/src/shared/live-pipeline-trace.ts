import { createHash, createHmac } from 'node:crypto';

/** Increment when the JSONL record contract changes incompatibly. */
export const LIVE_PIPELINE_TRACE_SCHEMA_VERSION = 1 as const;

export const LIVE_PIPELINE_TRACE_PROCESSES = ['backend', 'host', 'webview'] as const;
export type LivePipelineTraceProcess = (typeof LIVE_PIPELINE_TRACE_PROCESSES)[number];

/** Closed stage catalog. A missing stage is evidence, never an inferred diagnosis. */
export const LIVE_PIPELINE_TRACE_STAGES = [
  'provider.phase.transition',
  'sdk.observed',
  'backend.mapped',
  'backend.observation.rejected',
  'backend.writer.queued',
  'backend.writer.settled',
  'backend.persistence.query',
  'backend.persistence.confirmed',
  'backend.checkpoint.built',
  'host.line.received',
  'host.payload.validated',
  'host.sequence.gap',
  'host.checkpoint.requested',
  'host.checkpoint.received',
  'host.checkpoint.failed',
  'host.reducer.applied',
  'host.projection.completed',
  'host.snapshot.built',
  'host.post.started',
  'host.post.settled',
  'host.post.timeout',
  'host.post.late',
  'webview.state.received',
  'webview.app.committed',
  'webview.transcript.committed',
  'webview.paint.observed',
  'host.readiness.transition',
  'host.recovery.action',
  'trace.health',
  // Phase 0 process/runtime evidence. These stages carry metadata only; they
  // never contain prompts, tool bodies, or recursive payloads.
  'process.lifecycle',
  'backend.request',
  'backend.event_loop',
  'backend.runtime',
  'backend.subagent',
] as const;
export type LivePipelineTraceStage = (typeof LIVE_PIPELINE_TRACE_STAGES)[number];

export const LIVE_PIPELINE_TRACE_KINDS = [
  'observation',
  'transition',
  'start',
  'success',
  'false',
  'rejected',
  'timeout',
  'late',
  'failure',
  'recovery',
  'health',
] as const;
export type LivePipelineTraceKind = (typeof LIVE_PIPELINE_TRACE_KINDS)[number];

export const LIVE_PIPELINE_TRACE_PHASES = [
  'provider_gate_queue',
  'headers',
  'pre_first_semantic',
  'semantic_stream',
  'tool_execution',
  'waiting_input',
  'retry_backoff',
  'abort_teardown',
  'terminal',
  'backend_mapping',
  'backend_writing',
  'host_reducing',
  'host_reconciling',
  'bridge_posting',
  'bridge_commit_wait',
  'renderer_suspense',
  'renderer_committed',
  'renderer_failed',
  'sdk_import',
  'service_loading',
  'resource_loading',
  'session_construction',
  'subscriptions',
  'prompt_guards',
  'request_received',
  'request_validated',
  'route_selected',
  'handler_queued',
  'handler_started',
  'handler_finished',
  'extension_hook',
  'source_update',
  'dedupe',
  'clone',
  'json_safe_normalization',
  'recursive_projection',
  'diff',
  'measure',
  'serialize',
  'write',
] as const;
export type LivePipelineTracePhase = (typeof LIVE_PIPELINE_TRACE_PHASES)[number];

/** Classification only. Never substitute an arbitrary Error message. */
export const LIVE_PIPELINE_TRACE_REASON_CODES = [
  'none',
  'unsupported_observation',
  'malformed_observation',
  'malformed_payload',
  'sequence_gap',
  'duplicate_sequence',
  'owner_missing',
  'checkpoint_mismatch',
  'checkpoint_timeout',
  'checkpoint_oversize',
  'post_false',
  'post_rejected',
  'post_timeout',
  'late_settlement',
  'commit_timeout',
  'commit_identity_mismatch',
  'commit_window_mismatch',
  'commit_structure_mismatch',
  'commit_leaf_missing',
  'commit_leaf_mismatch',
  'ledger_overflow',
  'readiness_lost',
  'readiness_exhausted',
  'reload_stuck',
  'render_component_error',
  'render_uncaught_error',
  'render_unhandled_rejection',
  'durability_timeout',
  'durability_mismatch',
  'durability_ambiguous',
  'backend_exit',
  'writer_progress_coalesced',
  'writer_progress_dropped',
  'writer_progress_superseded',
  'writer_overflow',
  'writer_failure',
  'provider_header_timeout',
  'provider_semantic_timeout',
  'provider_stream_disconnect',
  'provider_retry_exhausted',
  'tool_timeout',
  'abort_grace_exceeded',
  'unknown_unattributable',
] as const;
export type LivePipelineTraceReasonCode = (typeof LIVE_PIPELINE_TRACE_REASON_CODES)[number];

/** Closed payload classification for the byte counters. Metadata only; never content. */
export const LIVE_PIPELINE_TRACE_PAYLOAD_CLASSES = [
  'source',
  'compact',
  'detail_baseline',
  'detail_page',
  'detail_delta',
  'detail_terminal',
  'terminal_append',
  'terminal_transport',
  'control',
] as const;
export type LivePipelineTracePayloadClass = (typeof LIVE_PIPELINE_TRACE_PAYLOAD_CLASSES)[number];

/**
 * Reserved detail-delivery classification. Producers that do not implement
 * detail delivery leave the field absent; when present it must be one of
 * these closed values and must describe an actually performed delivery.
 */
export const LIVE_PIPELINE_TRACE_DETAIL_DELIVERIES = [
  'none',
  'baseline',
  'page',
  'delta',
  'rebase',
  'terminal',
] as const;
export type LivePipelineTraceDetailDelivery = (typeof LIVE_PIPELINE_TRACE_DETAIL_DELIVERIES)[number];

/** Closed reasons for an intentionally absent byte field. */
export const LIVE_PIPELINE_TRACE_AVAILABILITY_REASONS = [
  'detail_delivery_not_implemented_until_phase_5',
  'source_preview_not_serialized_at_producer_boundary',
  'sdk_durability_boundary_exposes_no_serialized_byte_counter',
] as const;
export type LivePipelineTraceAvailabilityReason = (typeof LIVE_PIPELINE_TRACE_AVAILABILITY_REASONS)[number];

/** Result of the bounded semantic-change comparison used by dedupe. */
export const LIVE_PIPELINE_TRACE_OUTCOMES = ['changed', 'duplicate'] as const;
export type LivePipelineTraceOutcome = (typeof LIVE_PIPELINE_TRACE_OUTCOMES)[number];

/** Closed writer lane catalog shared by `writerLane` and `activeWriteLane`. */
export const LIVE_PIPELINE_TRACE_WRITER_LANES = ['response', 'control', 'lifecycle', 'progress', 'detail'] as const;
export type LivePipelineTraceWriterLane = (typeof LIVE_PIPELINE_TRACE_WRITER_LANES)[number];

export type LivePipelineIdentifierKind =
  | 'session'
  | 'request'
  | 'turn'
  | 'attempt'
  | 'message'
  | 'tool'
  | 'hostInstance'
  | 'workerId';

export interface LivePipelineTraceFingerprint {
  /** Logical UTF-16 length for strings, element length for bytes. */
  length: number;
  /** Number of bytes actually hashed (bounded). */
  bytes: number;
  hash: string;
}

export interface LivePipelineTraceHealthMetadata {
  emitted: number;
  sampled: number;
  dropped: number;
  unflushed: number;
  writeFailures: number;
  rotations: number;
  currentBytes: number;
  retainedFiles: number;
  retentionMaxAgeMs: number;
  retentionMaxFiles: number;
}

/** Default fixed event-loop delay bucket upper boundaries in ms. */
export const LIVE_PIPELINE_TRACE_EVENT_LOOP_BUCKET_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000] as const;

/**
 * Bounded event-loop delay histogram. Fixed bucket count; the last bucket
 * absorbs overflow. Never derived from stringified payloads.
 */
export interface LivePipelineTraceEventLoopHistogram {
  /** Upper bucket boundaries in ms, strictly increasing. */
  bucketMs: readonly number[];
  /** Sample counts per bucket; same length as bucketMs. */
  counts: readonly number[];
  /** Total samples folded into the histogram. */
  samples: number;
  /** Maximum observed delay in ms. */
  maxMs: number;
  /** Most recently observed interval drift in ms (observed minus expected interval). */
  driftMs?: number;
}

/**
 * Bounded event-loop delay accumulator. Instrumentation-only: invalid samples
 * are ignored rather than thrown so a trace call can never affect liveness.
 */
export class BoundedEventLoopHistogram {
  private readonly bucketMs: readonly number[];
  private readonly counts: number[];
  private samples = 0;
  private maxMs = 0;
  private driftMs: number | undefined;

  constructor(bucketMs: readonly number[] = LIVE_PIPELINE_TRACE_EVENT_LOOP_BUCKET_MS) {
    if (bucketMs.length < 1 || bucketMs.length > 64) throw new RangeError('Event-loop histogram needs 1..64 buckets.');
    for (const boundary of bucketMs) {
      if (!Number.isFinite(boundary) || boundary < 0) throw new RangeError('Event-loop histogram boundaries must be finite and non-negative.');
    }
    for (let i = 1; i < bucketMs.length; i += 1) {
      if (bucketMs[i]! <= bucketMs[i - 1]!) throw new RangeError('Event-loop histogram boundaries must be strictly increasing.');
    }
    this.bucketMs = [...bucketMs];
    this.counts = new Array<number>(bucketMs.length).fill(0);
  }

  record(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs < 0) return;
    let index = this.bucketMs.length - 1;
    for (let i = 0; i < this.bucketMs.length; i += 1) {
      if (delayMs < this.bucketMs[i]!) { index = i; break; }
    }
    this.counts[index]! += 1;
    this.samples += 1;
    if (delayMs > this.maxMs) this.maxMs = delayMs;
  }

  recordDrift(driftMs: number): void {
    if (Number.isFinite(driftMs)) this.driftMs = driftMs;
  }

  snapshot(): LivePipelineTraceEventLoopHistogram {
    return {
      bucketMs: [...this.bucketMs],
      counts: [...this.counts],
      samples: this.samples,
      maxMs: this.maxMs,
      ...(this.driftMs === undefined ? {} : { driftMs: this.driftMs }),
    };
  }

  reset(): void {
    this.counts.fill(0);
    this.samples = 0;
    this.maxMs = 0;
    this.driftMs = undefined;
  }
}

/** Transient input. Raw identifiers are HMACed before record construction. */
export interface LivePipelineTraceEvent {
  process: LivePipelineTraceProcess;
  /** Logical role is separate from the historical process catalog so the
   * schema remains compatible when coordinator/worker processes are added. */
  processRole?: 'coordinator' | 'worker' | 'host' | 'webview';
  pid?: number;
  coordinatorGeneration?: number;
  workerGeneration?: number;
  stage: LivePipelineTraceStage;
  kind: LivePipelineTraceKind;
  identifiers?: Partial<Record<LivePipelineIdentifierKind, string | Uint8Array>>;
  eventKind?: 'text' | 'reasoning' | 'tool_draft' | 'tool_start' | 'tool_progress' | 'tool_terminal' | 'turn_start' | 'turn_terminal' | 'control' | 'checkpoint' | 'snapshot' | 'render';
  eventSeq?: number;
  checkpointSeq?: number;
  revision?: number;
  viewGeneration?: number;
  operationId?: number;
  phase?: LivePipelineTracePhase;
  reasonCode?: LivePipelineTraceReasonCode;
  durationMs?: number;
  queueDepth?: number;
  queueBytes?: number;
  queueOldestAgeMs?: number;
  writerLane?: LivePipelineTraceWriterLane;
  /** Stable per-enqueue writer frame identity; pairs `backend.writer.queued`
   *  with its `backend.writer.settled`/dropped record. */
  writerSeq?: number;
  /** Identity of the frame the OS is currently writing when this frame was
   *  enqueued (absent when the writer is idle). */
  activeWriteSeq?: number;
  /** Lane of the active OS write (absent when the writer is idle). */
  activeWriteLane?: LivePipelineTraceWriterLane;
  /** TRUE iff this frame is ahead of a response frame present in the writer.
   *  Queued frames join the tail, so this is FALSE at enqueue (response
   *  priority drains before events even when array position differs); the
   *  settling frame (the active OS write) is TRUE when a response was queued
   *  behind it and could not preempt the in-flight write. */
  aheadOfResponse?: boolean;
  /** TRUE iff a response frame was queued ahead of this frame at enqueue
   *  (FIFO within the response lane; responses also drain before events). */
  queuedBehindResponse?: boolean;
  writeDurationMs?: number;
  eventLoopDelayMs?: number;
  eventLoopMaxDelayMs?: number;
  sourcePayloadBytes?: number;
  producedPayloadBytes?: number;
  childCount?: number;
  messageCount?: number;
  maxRecursiveDepth?: number;
  detailSubscriberCount?: number;
  /** Optional semantic-change/dedupe result; never inferred by the bridge. */
  outcome?: LivePipelineTraceOutcome;
  payloadClass?: LivePipelineTracePayloadClass;
  detailDelivery?: LivePipelineTraceDetailDelivery;
  /** Present only when a payload class is declared but its exact bytes are unavailable. */
  availabilityReason?: LivePipelineTraceAvailabilityReason;
  eventLoopHistogram?: LivePipelineTraceEventLoopHistogram;
  snapshotBytes?: number;
  transcriptCount?: number;
  liveTextChars?: number;
  liveReasoningChars?: number;
  toolStateRevision?: number;
  fingerprint?: LivePipelineTraceFingerprint;
  readiness?: 'ready' | 'not_ready' | 'reloading' | 'hidden';
  postResult?: 'true' | 'false' | 'rejected' | 'timeout' | 'late';
  health?: LivePipelineTraceHealthMetadata;
}

/** Serialized metadata-only record. It has no free-form content field. */
export interface LivePipelineTraceRecord extends Omit<LivePipelineTraceEvent, 'identifiers'> {
  schemaVersion: typeof LIVE_PIPELINE_TRACE_SCHEMA_VERSION;
  ts: string;
  monoMs: number;
  /** Shared run identity (HMACed) for cross-process timeline merge. */
  runIdHash?: string;
  /** Process-local monotonic record sequence for timeline merge. */
  processSeq?: number;
  sessionHash?: string;
  requestHash?: string;
  turnHash?: string;
  attemptHash?: string;
  messageHash?: string;
  toolHash?: string;
  hostInstanceHash?: string;
  workerIdHash?: string;
  processRole?: 'coordinator' | 'worker' | 'host' | 'webview';
  pid?: number;
  coordinatorGeneration?: number;
  workerGeneration?: number;
}

export interface CreateLivePipelineTraceRecordOptions {
  hmacKey: string | Uint8Array;
  wallTimestampMs: number;
  monoMs: number;
  /** Shared run identity; hashed into runIdHash with hmacKey. */
  runId?: string;
  /** Process-local monotonic record sequence. */
  processSeq?: number;
}

const DEFAULT_FINGERPRINT_MAX_BYTES = 4_096;

export function isLivePipelineTraceStage(value: unknown): value is LivePipelineTraceStage {
  return typeof value === 'string' && (LIVE_PIPELINE_TRACE_STAGES as readonly string[]).includes(value);
}

export function isLivePipelineTraceKind(value: unknown): value is LivePipelineTraceKind {
  return typeof value === 'string' && (LIVE_PIPELINE_TRACE_KINDS as readonly string[]).includes(value);
}

export function isLivePipelineTraceOutcome(value: unknown): value is LivePipelineTraceOutcome {
  return typeof value === 'string' && (LIVE_PIPELINE_TRACE_OUTCOMES as readonly string[]).includes(value);
}

export function isLivePipelineTraceWriterLane(value: unknown): value is LivePipelineTraceWriterLane {
  return typeof value === 'string' && (LIVE_PIPELINE_TRACE_WRITER_LANES as readonly string[]).includes(value);
}

export function createHardenedLivePipelineTraceIdentifier(
  identifier: string | Uint8Array,
  hmacKey: string | Uint8Array,
): string {
  if (hmacKey.length === 0) throw new RangeError('Live pipeline trace HMAC key must not be empty.');
  return createHmac('sha256', hmacKey).update(identifier).digest('base64url');
}

export function createBoundedLivePipelineTraceFingerprint(
  value: string | Uint8Array,
  maxBytes = DEFAULT_FINGERPRINT_MAX_BYTES,
): LivePipelineTraceFingerprint {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : DEFAULT_FINGERPRINT_MAX_BYTES;
  const prefix = typeof value === 'string' ? Buffer.from(value.slice(0, limit), 'utf8') : value.subarray(0, limit);
  const bounded = prefix.subarray(0, limit);
  return {
    length: value.length,
    bytes: bounded.byteLength,
    hash: createHash('sha256').update(bounded).digest('hex'),
  };
}

export function createLivePipelineTraceRecord(
  event: LivePipelineTraceEvent,
  options: CreateLivePipelineTraceRecordOptions,
): LivePipelineTraceRecord {
  if (!(LIVE_PIPELINE_TRACE_PROCESSES as readonly string[]).includes(event.process)) {
    throw new RangeError('Live pipeline trace process must be allowlisted.');
  }
  if (!isLivePipelineTraceStage(event.stage) || !isLivePipelineTraceKind(event.kind)) {
    throw new RangeError('Live pipeline trace stage and kind must be allowlisted.');
  }
  const record: LivePipelineTraceRecord = {
    schemaVersion: LIVE_PIPELINE_TRACE_SCHEMA_VERSION,
    ts: new Date(finiteNonNegative(options.wallTimestampMs)).toISOString(),
    monoMs: finiteNonNegative(options.monoMs),
    process: event.process,
    stage: event.stage,
    kind: event.kind,
  };
  copyIdentifiers(record, event.identifiers, options.hmacKey);
  copyOptionalMetadata(record, event);
  if (options.runId !== undefined) record.runIdHash = createHardenedLivePipelineTraceIdentifier(options.runId, options.hmacKey);
  if (options.processSeq !== undefined) record.processSeq = nonNegativeSafeInteger(options.processSeq);
  return record;
}

function copyIdentifiers(
  record: LivePipelineTraceRecord,
  identifiers: LivePipelineTraceEvent['identifiers'],
  key: string | Uint8Array,
): void {
  if (!identifiers) return;
  const names: Array<[LivePipelineIdentifierKind, keyof LivePipelineTraceRecord]> = [
    ['session', 'sessionHash'], ['request', 'requestHash'], ['turn', 'turnHash'],
    ['attempt', 'attemptHash'], ['message', 'messageHash'], ['tool', 'toolHash'],
    ['hostInstance', 'hostInstanceHash'], ['workerId', 'workerIdHash'],
  ];
  for (const [source, target] of names) {
    const value = identifiers[source];
    if (value !== undefined) (record as unknown as Record<string, unknown>)[target] = createHardenedLivePipelineTraceIdentifier(value, key);
  }
}

function copyOptionalMetadata(record: LivePipelineTraceRecord, event: LivePipelineTraceEvent): void {
  const integerFields = [
    'eventSeq', 'checkpointSeq', 'revision', 'viewGeneration', 'operationId', 'queueDepth',
    'queueBytes', 'writerSeq', 'activeWriteSeq', 'snapshotBytes', 'sourcePayloadBytes', 'producedPayloadBytes',
    'childCount', 'messageCount', 'maxRecursiveDepth', 'detailSubscriberCount', 'coordinatorGeneration',
    'workerGeneration', 'transcriptCount', 'liveTextChars', 'liveReasoningChars', 'toolStateRevision',
  ] as const;
  for (const field of integerFields) {
    const value = event[field];
    if (value !== undefined) record[field] = nonNegativeSafeInteger(value);
  }
  if (event.durationMs !== undefined) record.durationMs = finiteNonNegative(event.durationMs);
  if (event.queueOldestAgeMs !== undefined) record.queueOldestAgeMs = finiteNonNegative(event.queueOldestAgeMs);
  if (event.writeDurationMs !== undefined) record.writeDurationMs = finiteNonNegative(event.writeDurationMs);
  if (event.eventLoopDelayMs !== undefined) record.eventLoopDelayMs = finiteNonNegative(event.eventLoopDelayMs);
  if (event.eventLoopMaxDelayMs !== undefined) record.eventLoopMaxDelayMs = finiteNonNegative(event.eventLoopMaxDelayMs);
  if (event.payloadClass !== undefined) {
    if (!(LIVE_PIPELINE_TRACE_PAYLOAD_CLASSES as readonly string[]).includes(event.payloadClass)) throw new RangeError('Trace payload class must be allowlisted.');
    record.payloadClass = event.payloadClass;
  }
  if (event.outcome !== undefined) {
    if (!isLivePipelineTraceOutcome(event.outcome)) throw new RangeError('Trace outcome must be allowlisted.');
    record.outcome = event.outcome;
  }
  if (event.detailDelivery !== undefined) {
    if (!(LIVE_PIPELINE_TRACE_DETAIL_DELIVERIES as readonly string[]).includes(event.detailDelivery)) throw new RangeError('Trace detail delivery must be allowlisted.');
    record.detailDelivery = event.detailDelivery;
  }
  if (event.availabilityReason !== undefined) {
    if (!(LIVE_PIPELINE_TRACE_AVAILABILITY_REASONS as readonly string[]).includes(event.availabilityReason)) throw new RangeError('Trace availability reason must be allowlisted.');
    record.availabilityReason = event.availabilityReason;
  }
  if (event.eventLoopHistogram !== undefined) record.eventLoopHistogram = normalizedEventLoopHistogram(event.eventLoopHistogram);
  if (event.writerLane !== undefined) {
    if (!isLivePipelineTraceWriterLane(event.writerLane)) throw new RangeError('Trace writer lane must be allowlisted.');
    record.writerLane = event.writerLane;
  }
  if (event.activeWriteLane !== undefined) {
    if (!isLivePipelineTraceWriterLane(event.activeWriteLane)) throw new RangeError('Trace active-write lane must be allowlisted.');
    record.activeWriteLane = event.activeWriteLane;
  }
  if (event.aheadOfResponse !== undefined) record.aheadOfResponse = event.aheadOfResponse;
  if (event.queuedBehindResponse !== undefined) record.queuedBehindResponse = event.queuedBehindResponse;
  if (event.processRole !== undefined) {
    if (!(['coordinator', 'worker', 'host', 'webview'] as readonly string[]).includes(event.processRole)) {
      throw new RangeError('Trace process role must be allowlisted.');
    }
    record.processRole = event.processRole;
  }
  if (event.pid !== undefined) record.pid = nonNegativeSafeInteger(event.pid);
  if (event.eventKind !== undefined) record.eventKind = event.eventKind;
  if (event.phase !== undefined) {
    if (!(LIVE_PIPELINE_TRACE_PHASES as readonly string[]).includes(event.phase)) throw new RangeError('Trace phase must be allowlisted.');
    record.phase = event.phase;
  }
  if (event.reasonCode !== undefined) {
    if (!(LIVE_PIPELINE_TRACE_REASON_CODES as readonly string[]).includes(event.reasonCode)) throw new RangeError('Trace reason must be allowlisted.');
    record.reasonCode = event.reasonCode;
  }
  if (event.fingerprint !== undefined) record.fingerprint = normalizedFingerprint(event.fingerprint);
  if (event.readiness !== undefined) record.readiness = event.readiness;
  if (event.postResult !== undefined) record.postResult = event.postResult;
  if (event.health !== undefined) record.health = normalizedHealth(event.health);
}

function normalizedEventLoopHistogram(value: LivePipelineTraceEventLoopHistogram): LivePipelineTraceEventLoopHistogram {
  if (!Array.isArray(value.bucketMs) || !Array.isArray(value.counts)) throw new RangeError('Trace event-loop histogram needs bucketMs and counts arrays.');
  if (value.bucketMs.length < 1 || value.bucketMs.length > 64) throw new RangeError('Trace event-loop histogram needs 1..64 buckets.');
  if (value.counts.length !== value.bucketMs.length) throw new RangeError('Trace event-loop histogram counts must match bucket boundaries.');
  for (const boundary of value.bucketMs) {
    if (!Number.isFinite(boundary) || boundary < 0) throw new RangeError('Trace event-loop histogram boundaries must be finite and non-negative.');
  }
  for (let i = 1; i < value.bucketMs.length; i += 1) {
    if (value.bucketMs[i]! <= value.bucketMs[i - 1]!) throw new RangeError('Trace event-loop histogram boundaries must be strictly increasing.');
  }
  for (const count of value.counts) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Trace event-loop histogram counts must be non-negative safe integers.');
  }
  if (!Number.isSafeInteger(value.samples) || value.samples < 0) throw new RangeError('Trace event-loop histogram samples must be a non-negative safe integer.');
  if (!Number.isFinite(value.maxMs) || value.maxMs < 0) throw new RangeError('Trace event-loop histogram maxMs must be finite and non-negative.');
  if (value.driftMs !== undefined && !Number.isFinite(value.driftMs)) throw new RangeError('Trace event-loop histogram driftMs must be finite.');
  return {
    bucketMs: [...value.bucketMs],
    counts: [...value.counts],
    samples: value.samples,
    maxMs: value.maxMs,
    ...(value.driftMs === undefined ? {} : { driftMs: value.driftMs }),
  };
}

function normalizedFingerprint(value: LivePipelineTraceFingerprint): LivePipelineTraceFingerprint {
  if (!Number.isSafeInteger(value.length) || value.length < 0
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0
    || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.hash)) {
    throw new RangeError('Trace fingerprint must contain bounded sizes and a SHA-256 hash.');
  }
  return { length: value.length, bytes: value.bytes, hash: value.hash };
}

function normalizedHealth(value: LivePipelineTraceHealthMetadata): LivePipelineTraceHealthMetadata {
  return {
    emitted: nonNegativeSafeInteger(value.emitted),
    sampled: nonNegativeSafeInteger(value.sampled),
    dropped: nonNegativeSafeInteger(value.dropped),
    unflushed: nonNegativeSafeInteger(value.unflushed),
    writeFailures: nonNegativeSafeInteger(value.writeFailures),
    rotations: nonNegativeSafeInteger(value.rotations),
    currentBytes: nonNegativeSafeInteger(value.currentBytes),
    retainedFiles: nonNegativeSafeInteger(value.retainedFiles),
    retentionMaxAgeMs: nonNegativeSafeInteger(value.retentionMaxAgeMs),
    retentionMaxFiles: nonNegativeSafeInteger(value.retentionMaxFiles),
  };
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Trace numeric metadata must be finite and non-negative.');
  return value;
}

function nonNegativeSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Trace integer metadata must be a non-negative safe integer.');
  return value;
}
