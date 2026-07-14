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

export type LivePipelineIdentifierKind =
  | 'session'
  | 'request'
  | 'turn'
  | 'attempt'
  | 'message'
  | 'tool'
  | 'hostInstance';

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

/** Transient input. Raw identifiers are HMACed before record construction. */
export interface LivePipelineTraceEvent {
  process: LivePipelineTraceProcess;
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
  sessionHash?: string;
  requestHash?: string;
  turnHash?: string;
  attemptHash?: string;
  messageHash?: string;
  toolHash?: string;
  hostInstanceHash?: string;
}

export interface CreateLivePipelineTraceRecordOptions {
  hmacKey: string | Uint8Array;
  wallTimestampMs: number;
  monoMs: number;
}

const DEFAULT_FINGERPRINT_MAX_BYTES = 4_096;

export function isLivePipelineTraceStage(value: unknown): value is LivePipelineTraceStage {
  return typeof value === 'string' && (LIVE_PIPELINE_TRACE_STAGES as readonly string[]).includes(value);
}

export function isLivePipelineTraceKind(value: unknown): value is LivePipelineTraceKind {
  return typeof value === 'string' && (LIVE_PIPELINE_TRACE_KINDS as readonly string[]).includes(value);
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
    ['hostInstance', 'hostInstanceHash'],
  ];
  for (const [source, target] of names) {
    const value = identifiers[source];
    if (value !== undefined) (record as unknown as Record<string, unknown>)[target] = createHardenedLivePipelineTraceIdentifier(value, key);
  }
}

function copyOptionalMetadata(record: LivePipelineTraceRecord, event: LivePipelineTraceEvent): void {
  const integerFields = [
    'eventSeq', 'checkpointSeq', 'revision', 'viewGeneration', 'operationId', 'queueDepth',
    'queueBytes', 'snapshotBytes', 'transcriptCount', 'liveTextChars', 'liveReasoningChars', 'toolStateRevision',
  ] as const;
  for (const field of integerFields) {
    const value = event[field];
    if (value !== undefined) record[field] = nonNegativeSafeInteger(value);
  }
  if (event.durationMs !== undefined) record.durationMs = finiteNonNegative(event.durationMs);
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
