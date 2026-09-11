/**
 * Engine-neutral analytics contracts.
 *
 * This module deliberately contains no storage, SDK, or runtime imports. It is
 * the shared boundary for observations produced by Pie hosts, subagents and
 * extensions. A recorder may add commit metadata, but it must not invent a
 * second identity or normalization vocabulary around these values.
 */

export const ANALYTICS_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_GENERATION_VERSION = 1 as const;

/** JSON-safe integer input. BigInt is accepted by pure helpers before a value
 * is put on the wire; values outside the safe JS range are serialized as
 * decimal strings. */
export type Int64Value = number | string | bigint;

export type AnalyticsTimestampMs = Int64Value;

export type AnalyticsProducerKind =
  | 'host'
  | 'backend'
  | 'subagent'
  | 'extension'
  | 'mcp'
  | 'pruner'
  | 'query'
  | 'system'
  | 'test'
  | (string & {});

export type AnalyticsEntityKind =
  | 'session'
  | 'execution'
  | 'providerCall'
  | 'toolCall'
  | 'toolFacet'
  | 'activitySpan'
  | 'componentDefinition'
  | 'configurationVersion'
  | 'capabilityContextSet'
  | 'capabilityObservation'
  | 'featureObservation'
  | 'detailPayload'
  | 'branch'
  | 'copy'
  | (string & {});

export type AnalyticsObservationKind =
  | 'begin'
  | 'phase'
  | 'end'
  | 'providerSettlement'
  | 'transcriptEvidence'
  | 'attributionLink'
  | 'detailCompletion'
  | 'observation'
  | (string & {});

export type AnalyticsCoverage = 'known' | 'unknown' | 'not_applicable';

export interface AnalyticsWorkspaceScope {
  /** Canonical workspace URI or sorted multi-root URI-set identity. */
  workspaceId?: string;
  workspaceCoverage: AnalyticsCoverage;
  /** The observed cwd, retained as metadata and never used as storage authority. */
  cwd?: string;
}

export interface AnalyticsScope extends AnalyticsWorkspaceScope {
  sessionId?: string;
  rootSessionId?: string;
  executionId?: string;
  invocationId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  branchId?: string;
}

/** The trusted subject used by close-time deletion. It is independent from
 * nullable analytical attribution. */
export type AnalyticsCaptureSubject =
  | { kind: 'session'; rootSessionId: string }
  | { kind: 'pendingCreate'; operationId: string }
  | { kind: 'host'; hostId: string };

export interface AnalyticsProducerIdentity {
  /** Pie/extension build identity, not a user credential. */
  buildId: string;
  processId?: string | number;
  processGeneration?: string;
}

export interface AnalyticsUsageChannels {
  inputTokens?: Int64Value | null;
  outputTokens?: Int64Value | null;
  cacheReadTokens?: Int64Value | null;
  cacheWriteTokens?: Int64Value | null;
  /** A provider-reported reasoning subset may already be included in output. */
  reasoningTokens?: Int64Value | null;
  providerTotalTokens?: Int64Value | null;
}

export interface AnalyticsPricingSnapshot {
  /** Usage/channel normalization algorithm, independent of catalog identity. */
  normalizationVersion: 'oracle-v1';
  /** Immutable pricing-catalog content identity used for historical reproduction. */
  catalogVersion?: string;
  currency: 'USD';
  inputUsdPerMillionTokens?: number | null;
  outputUsdPerMillionTokens?: number | null;
  cacheReadUsdPerMillionTokens?: number | null;
  cacheWriteUsdPerMillionTokens?: number | null;
}

export interface AnalyticsProviderCallFields extends AnalyticsUsageChannels {
  invocationId: string;
  sourceId: string;
  purpose?: string;
  provider?: string;
  dispatchedModel?: string;
  reportedModel?: string;
  thinkingLevel?: string;
  retryGroupId?: string;
  attemptId?: string;
  startedAtMs?: Int64Value | null;
  endedAtMs?: Int64Value | null;
  settledAtMs?: Int64Value | null;
  outcome?: string;
  reportedCostUsd?: number | null;
  /** Producer-calculated cost is usable only when calculatedCostComplete is true. */
  calculatedCostUsd?: number | null;
  calculatedCostComplete?: boolean;
  /** Explicit provider protocol conventions used to normalize overlapping channels. */
  inputIncludesCache?: boolean;
  outputIncludesReasoning?: boolean;
  cacheChannelsOmittedAsZero?: boolean;
  pricing?: AnalyticsPricingSnapshot | null;
  coverage?: AnalyticsCoverage;
  errorDetailId?: string | null;
}

export interface AnalyticsSessionFields {
  sessionId: string;
  firstObservedAtMs?: Int64Value | null;
  transcriptReference?: string | null;
  lifecycleState?: 'open' | 'closed' | 'expired' | 'unknown';
  captureStartedAtMs?: Int64Value | null;
}

export interface AnalyticsExecutionFields {
  operationId?: string;
  childId?: string;
  attemptId?: string;
  operationKind?: string;
  source?: string;
  runId?: string;
  turnId?: string;
  requestId?: string;
  messageId?: string;
  /** Exact persisted transcript entry that proves this execution reached a
   * durable row. Execution end alone does not imply transcript durability. */
  durableEntryId?: string;
  parentExecutionId?: string;
  parentToolCallId?: string;
  startedAtMs?: Int64Value | null;
  endedAtMs?: Int64Value | null;
  outcome?: string;
  reason?: string;
  acceptanceEvidence?: string;
  commitEvidence?: string;
  captureIncomplete?: boolean;
  /** Recorder-confirmed contiguous producer sequence observed before this
   * fact was sealed. Absence means no acknowledgement was available. */
  lastAcknowledgedSequence?: Int64Value | null;
  /** Producer sequence submitted before this fact was sealed. This is queue
   * ownership evidence only and must not be interpreted as recorder durable. */
  lastSubmittedSequence?: Int64Value | null;
  terminalDetailPayloadId?: string | null;
  terminalDetailComplete?: boolean;
  terminalWatermark?: {
    requestId: string;
    turnId: string;
    attemptId: string;
    finalSequence: Int64Value;
    terminalKind: 'completed' | 'interrupted' | 'error';
    durableEntryId: string;
    occurredAt: number;
  };
}

export interface AnalyticsToolFacetFields {
  toolCallId: string;
  facetId: string;
  commands?: string[];
  cwd?: string | null;
  observedPaths?: string[];
  attemptedAddedLines?: number | null;
  attemptedRemovedLines?: number | null;
  verification?: 'verified' | 'unverified' | 'not_applicable' | 'unknown';
  detailPayloadId?: string | null;
}

export interface AnalyticsToolCallFields {
  toolCallId: string;
  toolDefinitionId?: string;
  parentToolCallId?: string;
  startedAtMs?: Int64Value | null;
  executionEndedAtMs?: Int64Value | null;
  durableEntryId?: string | null;
  outcome?: string;
  argumentsPayloadId?: string | null;
  resultPayloadId?: string | null;
  errorPayloadId?: string | null;
  mcpTarget?: string | null;
}

export interface AnalyticsActivitySpanFields {
  spanId: string;
  kind: string;
  startedAtMs: Int64Value;
  endedAtMs?: Int64Value | null;
  durationMs?: number | null;
  clockDomain: string;
  clockResolutionMs?: number | null;
  coverage: 'observed' | 'estimated' | 'unknown';
  parentSpanId?: string | null;
}

export interface AnalyticsDetailPayloadFields {
  payloadId: string;
  digest: string;
  mediaType: string;
  encoding: string;
  byteLength: Int64Value;
  complete: boolean;
  captureSource?: string;
  omissionReason?: string | null;
  sourceVersion?: string;
}

export interface AnalyticsComponentDefinitionFields {
  definitionId: string;
  kind: 'extension' | 'skill' | 'tool' | 'server' | string;
  name: string;
  packageVersion?: string | null;
  contentVersion?: string | null;
  ownerId?: string | null;
  contentDigest?: string | null;
  detailPayloadId?: string | null;
}

export interface AnalyticsCapabilityContextSetFields {
  setId: string;
  role: 'discovered' | 'exposed';
  memberDefinitionIds: string[];
  configurationId?: string | null;
  executionId?: string | null;
  invocationId?: string | null;
}

export interface AnalyticsCapabilityObservationFields {
  observation: 'discovered' | 'exposed' | 'pruned' | 'read' | 'recovered' | 'missing';
  reason?: string;
  sourceRoute?: string;
  measuredSizeEffect?: number | null;
  estimatedSizeEffect?: number | null;
  detailPayloadId?: string | null;
}

export interface AnalyticsFeatureObservationFields {
  feature: 'pruning' | 'resultPruning' | 'warmBash' | 'runtimeHealth' | string;
  decision?: string;
  ruleVersion?: string | null;
  beforePayloadId?: string | null;
  afterPayloadId?: string | null;
  measuredSizeEffect?: number | null;
  estimatedSizeEffect?: number | null;
  providerCallId?: string | null;
}

export interface AnalyticsTranscriptEvidenceFields {
  sessionId: string;
  entryId: string;
  entryKind: string;
  executionId?: string | null;
  toolCallId?: string | null;
  terminal: boolean;
}

export interface AnalyticsAttributionLinkFields {
  targetEntityKind: AnalyticsEntityKind;
  targetEntityKey: string;
  linkKind: 'workspace' | 'session' | 'execution' | 'invocation' | 'tool' | 'branch' | string;
  evidenceSourceKey: string;
}

export interface AnalyticsLatencyFields {
  requestToFirstOutputMs?: number | null;
  providerHeaderWaitMs?: number | null;
  providerFirstOutputWaitMs?: number | null;
  fullOperationMs?: number | null;
  coverage: AnalyticsCoverage;
}

export interface AnalyticsContextObservationFields {
  source: 'provider' | 'initialEstimate' | 'recovered' | string;
  modelId?: string | null;
  contextLimitTokens?: Int64Value | null;
  inputTokens?: Int64Value | null;
  outputTokens?: Int64Value | null;
  observedAtMs: Int64Value;
  estimate: boolean;
}

export interface AnalyticsConfigurationVersionFields {
  configurationId: string;
  effectiveNonSecretDigest: string;
  source?: string;
  modelSettingsDigest?: string;
  pricingReference?: string;
}

export interface AnalyticsBranchFields {
  branchId: string;
  parentBranchId?: string | null;
  sourceSelectionId?: string | null;
  sourceEntryId?: string | null;
}

export interface AnalyticsCopyFields {
  copySessionId: string;
  sourceSessionId: string;
  inheritedInvocationIds?: string[];
}

/** Default heterogeneous payload boundary. Concrete producers may supply a
 * typed field object without inventing a string index signature. */
export type AnalyticsFields = Record<string, unknown>;

export interface AnalyticsSink {
  submit<Fields extends object>(observation: AnalyticsObservation<Fields>): void | Promise<void>;
}

/** Independently-owned rich detail handed off by a producer before its
 * execution-local objects are reclaimed. `bytes` is a detached snapshot, not
 * a reference to mutable SDK state. The recorder expands it into linked,
 * content-addressed leaves off the agent path. */
export interface AnalyticsDetailCapture {
  schemaVersion: number;
  generationId: string;
  /** Root-subject-qualified immutable producer origin. Unlike process IDs, this
   * survives helper replacement and is safe to use in source identities. */
  stableOriginId?: string;
  producerKind?: AnalyticsProducerKind;
  producer?: AnalyticsProducerIdentity;
  payloadId: string;
  sourceKey: string;
  observedAtMs: AnalyticsTimestampMs;
  captureSubject: AnalyticsCaptureSubject;
  mediaType: 'application/x-pie-subagent-result' | 'application/x-pie-tool-observation';
  encoding: 'node-v8';
  complete: true;
  bytes: Uint8Array;
  metadata: {
    childId?: string;
    attemptId?: string;
    parentToolCallId?: string;
    outcome?: string;
    captureStage?: string;
    sourceVersion?: string;
  };
}

export interface AnalyticsDetailSink {
  /** Optional bounded preflight for producers that have not yet cloned or
   * serialized a large rich value. It acquires no ownership. */
  preflightDetail?(value: unknown): void;
  /** Synchronous ownership transfer only. Implementations must not wait for
   * persistence or queue drainage and must fail visibly if capacity is absent. */
  submitDetail(capture: AnalyticsDetailCapture): void;
}

/** Producers outside Pie can use this sink without branching their capture
 * code. It intentionally does not acknowledge or buffer anything. */
export const NOOP_ANALYTICS_SINK: AnalyticsSink = Object.freeze({
  submit: () => undefined,
});

/** The record submitted to the recorder. Commit sequence/time are deliberately
 * absent; the recorder owns those fields after accepting the observation. */
export interface AnalyticsObservation<Fields extends object = AnalyticsFields> {
  schemaVersion: number;
  generationId: string;
  producerKind: AnalyticsProducerKind;
  /** Stable identity for one producer sequence stream. It must survive recorder
   * helper replacement and must not contain a transcript/session path. */
  stableOriginId?: string;
  /** Monotonic sequence in this producer process generation. Required for new
   * production adapters; optional only for schema-v1/prototype compatibility. */
  sourceSequence?: Int64Value;
  sourceKey: string;
  entityKind: AnalyticsEntityKind;
  entityKey: string;
  observationKind: AnalyticsObservationKind;
  idempotencyKey: string;
  observedAtMs: AnalyticsTimestampMs;
  scope: AnalyticsScope;
  captureSubject: AnalyticsCaptureSubject;
  producer: AnalyticsProducerIdentity;
  fields: Fields;
}

export interface CommittedAnalyticsObservation<Fields extends object = AnalyticsFields>
  extends AnalyticsObservation<Fields> {
  commitSequence: Int64Value;
  committedAtMs: AnalyticsTimestampMs;
}

export interface AnalyticsDeletionMarker {
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  deletedAtMs: AnalyticsTimestampMs;
  reason: 'privateClose' | 'explicitForget';
  sourceKey: string;
}

export type AnalyticsPrivacyMode = 'on' | 'off';
export type AnalyticsCloseDisposition = 'delete' | 'retain';

export function closeDispositionForPrivacy(mode: AnalyticsPrivacyMode): AnalyticsCloseDisposition {
  return mode === 'on' ? 'delete' : 'retain';
}

export interface ObservationValidationIssue {
  path: string;
  code: 'invalid_type' | 'missing' | 'invalid_value';
  message: string;
}

export class AnalyticsValidationError extends Error {
  readonly issues: readonly ObservationValidationIssue[];

  constructor(issues: readonly ObservationValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'AnalyticsValidationError';
    this.issues = issues;
  }
}

export class AnalyticsSourceConflictError extends Error {
  readonly registryKey: string;
  readonly existingFingerprint: string;
  readonly incomingFingerprint: string;

  constructor(registryKey: string, existingFingerprint: string, incomingFingerprint: string) {
    super(`Conflicting analytics observation for source key ${registryKey}.`);
    this.name = 'AnalyticsSourceConflictError';
    this.registryKey = registryKey;
    this.existingFingerprint = existingFingerprint;
    this.incomingFingerprint = incomingFingerprint;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INT64_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function assertInt64Range(value: bigint, fieldName: string): bigint {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new AnalyticsValidationError([{
      path: fieldName,
      code: 'invalid_value',
      message: 'must fit in signed 64-bit range',
    }]);
  }
  return value;
}

/** Parse a signed 64-bit value without passing it through a 32-bit binding. */
export function parseInt64(value: unknown, fieldName = 'value'): bigint {
  if (typeof value === 'bigint') return assertInt64Range(value, fieldName);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new AnalyticsValidationError([{
        path: fieldName,
        code: 'invalid_value',
        message: 'must be a safe integer when represented as a number',
      }]);
    }
    return assertInt64Range(BigInt(value), fieldName);
  }
  if (typeof value === 'string' && INT64_PATTERN.test(value)) {
    return assertInt64Range(BigInt(value), fieldName);
  }
  throw new AnalyticsValidationError([{
    path: fieldName,
    code: 'invalid_type',
    message: 'must be an integer number, decimal string, or bigint',
  }]);
}

export function parseNonNegativeInt64(value: unknown, fieldName = 'value'): bigint {
  const parsed = parseInt64(value, fieldName);
  if (parsed < 0n) {
    throw new AnalyticsValidationError([{
      path: fieldName,
      code: 'invalid_value',
      message: 'must be non-negative',
    }]);
  }
  return parsed;
}

/** Return a JSON-friendly number for safe values and a decimal string for large values. */
export function encodeInt64(value: Int64Value): number | string {
  const parsed = parseInt64(value);
  return parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(parsed)
    : parsed.toString();
}

export function canonicalInt64(value: Int64Value): string {
  return parseInt64(value).toString();
}

function addIssue(
  issues: ObservationValidationIssue[],
  path: string,
  code: ObservationValidationIssue['code'],
  message: string,
): void {
  issues.push({ path, code, message });
}

function validateId(value: unknown, path: string, issues: ObservationValidationIssue[]): void {
  if (typeof value !== 'string') {
    addIssue(issues, path, 'invalid_type', 'must be a non-empty string');
    return;
  }
  if (value.length === 0 || value.includes('\u0000')) {
    addIssue(issues, path, 'invalid_value', 'must be non-empty and contain no NUL');
  }
}

function validateInt64Field(
  value: unknown,
  path: string,
  issues: ObservationValidationIssue[],
  nonNegative = false,
): void {
  try {
    const parsed = parseInt64(value, path);
    if (nonNegative && parsed < 0n) {
      addIssue(issues, path, 'invalid_value', 'must be non-negative');
    }
  } catch (error) {
    if (error instanceof AnalyticsValidationError) issues.push(...error.issues);
    else addIssue(issues, path, 'invalid_value', 'must be a valid int64');
  }
}

function validateSubject(value: unknown, issues: ObservationValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, 'captureSubject', 'invalid_type', 'must be an object');
    return;
  }
  if (value.kind !== 'session' && value.kind !== 'pendingCreate' && value.kind !== 'host') {
    addIssue(issues, 'captureSubject.kind', 'invalid_value', 'must be session, pendingCreate, or host');
    return;
  }
  const key = value.kind === 'session'
    ? 'rootSessionId'
    : value.kind === 'pendingCreate' ? 'operationId' : 'hostId';
  validateId(value[key], `captureSubject.${key}`, issues);
}

function validateScope(value: unknown, issues: ObservationValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, 'scope', 'invalid_type', 'must be an object');
    return;
  }
  if (value.workspaceCoverage !== 'known'
    && value.workspaceCoverage !== 'unknown'
    && value.workspaceCoverage !== 'not_applicable') {
    addIssue(issues, 'scope.workspaceCoverage', 'invalid_value', 'must be known, unknown, or not_applicable');
  }
  for (const key of [
    'workspaceId', 'cwd', 'sessionId', 'rootSessionId', 'executionId',
    'invocationId', 'toolCallId', 'parentToolCallId', 'branchId',
  ]) {
    if (value[key] !== undefined && value[key] !== null) validateId(value[key], `scope.${key}`, issues);
  }
}

function validateProducer(value: unknown, issues: ObservationValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, 'producer', 'invalid_type', 'must be an object');
    return;
  }
  validateId(value.buildId, 'producer.buildId', issues);
  if (value.processId !== undefined && value.processId !== null) {
    if (typeof value.processId !== 'string' && typeof value.processId !== 'number') {
      addIssue(issues, 'producer.processId', 'invalid_type', 'must be a string or number');
    }
  }
  if (value.processGeneration !== undefined && value.processGeneration !== null) {
    validateId(value.processGeneration, 'producer.processGeneration', issues);
  }
}

/** Validate the required observation envelope without imposing engine-specific DDL. */
const NON_NEGATIVE_INT_FIELD_NAMES = new Set([
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'reasoningTokens', 'providerTotalTokens', 'byteLength', 'attemptedAddedLines',
  'attemptedRemovedLines', 'contextLimitTokens',
]);
const TIMESTAMP_INT_FIELD_NAMES = new Set([
  'firstObservedAtMs', 'captureStartedAtMs', 'startedAtMs', 'endedAtMs',
  'settledAtMs', 'executionEndedAtMs', 'observedAtMs',
]);
const NON_NEGATIVE_FLOAT_FIELD_NAMES = new Set([
  'reportedCostUsd', 'calculatedCostUsd', 'durationMs', 'clockResolutionMs',
  'measuredSizeEffect', 'estimatedSizeEffect', 'requestToFirstOutputMs',
  'providerHeaderWaitMs', 'providerFirstOutputWaitMs', 'fullOperationMs',
  'inputUsdPerMillionTokens', 'outputUsdPerMillionTokens',
  'cacheReadUsdPerMillionTokens', 'cacheWriteUsdPerMillionTokens',
]);

function validateKnownFieldNumbers(
  value: unknown,
  path: string,
  issues: ObservationValidationIssue[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateKnownFieldNumbers(item, `${path}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (child === null || child === undefined) continue;
    if (NON_NEGATIVE_INT_FIELD_NAMES.has(key)) {
      try {
        parseNonNegativeInt64(child, childPath);
      } catch (error) {
        if (error instanceof AnalyticsValidationError) issues.push(...error.issues);
      }
    } else if (TIMESTAMP_INT_FIELD_NAMES.has(key)) {
      validateInt64Field(child, childPath, issues);
    } else if (NON_NEGATIVE_FLOAT_FIELD_NAMES.has(key)) {
      if (typeof child !== 'number' || !Number.isFinite(child) || child < 0) {
        addIssue(issues, childPath, 'invalid_value', 'must be a finite non-negative number');
      }
    }
    validateKnownFieldNumbers(child, childPath, issues);
  }
}

/** Deterministic idempotency identity scoped to observation kind, stable source
 * origin and analytics generation. */
export function deriveAnalyticsIdempotencyKey(
  observation: Pick<AnalyticsObservation, 'generationId' | 'observationKind' | 'sourceKey'>,
): string {
  // A JSON tuple is unambiguous while remaining a valid opaque ID: unlike a
  // NUL-delimited string, it does not violate the shared no-NUL ID invariant.
  return JSON.stringify([
    observation.generationId,
    observation.observationKind,
    observation.sourceKey,
  ]);
}

export const analyticsIdempotencyKey = deriveAnalyticsIdempotencyKey;

export function validateAnalyticsObservation(value: unknown): ObservationValidationIssue[] {
  const issues: ObservationValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ path: '', code: 'invalid_type', message: 'observation must be an object' }];
  }
  if (typeof value.schemaVersion !== 'number' || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    addIssue(issues, 'schemaVersion', 'invalid_value', 'must be a positive safe integer');
  }
  for (const key of [
    'generationId', 'producerKind', 'sourceKey', 'entityKind', 'entityKey',
    'observationKind', 'idempotencyKey',
  ]) validateId(value[key], key, issues);
  if (typeof value.generationId === 'string'
    && typeof value.observationKind === 'string'
    && typeof value.sourceKey === 'string'
    && typeof value.idempotencyKey === 'string'
    && value.idempotencyKey !== deriveAnalyticsIdempotencyKey(value as Pick<AnalyticsObservation, 'generationId' | 'observationKind' | 'sourceKey'>)) {
    addIssue(
      issues,
      'idempotencyKey',
      'invalid_value',
      'must match the generation, observation kind, and source key',
    );
  }
  if (value.stableOriginId !== undefined) validateId(value.stableOriginId, 'stableOriginId', issues);
  if (value.sourceSequence !== undefined && value.sourceSequence !== null) {
    validateInt64Field(value.sourceSequence, 'sourceSequence', issues, true);
    try {
      if (parseInt64(value.sourceSequence, 'sourceSequence') < 1n) {
        addIssue(issues, 'sourceSequence', 'invalid_value', 'must start at 1');
      }
    } catch { /* the typed validation issue was already recorded */ }
  }
  if (value.observedAtMs === undefined || value.observedAtMs === null) {
    addIssue(issues, 'observedAtMs', 'missing', 'is required');
  } else {
    validateInt64Field(value.observedAtMs, 'observedAtMs', issues);
  }
  validateScope(value.scope, issues);
  validateSubject(value.captureSubject, issues);
  validateProducer(value.producer, issues);
  if (!isRecord(value.fields)) addIssue(issues, 'fields', 'invalid_type', 'must be an object');
  else validateKnownFieldNumbers(value.fields, 'fields', issues);
  return issues;
}

export function assertValidAnalyticsObservation(
  value: unknown,
): asserts value is AnalyticsObservation {
  const issues = validateAnalyticsObservation(value);
  if (issues.length > 0) throw new AnalyticsValidationError(issues);
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'bigint') return { $int64: value.toString() };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot fingerprint non-finite analytics number.');
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

/** Stable key for source-key idempotency within one analytics generation. */
export function analyticsObservationRegistryKey(observation: Pick<AnalyticsObservation, 'generationId' | 'sourceKey'>): string {
  return `${observation.generationId}\u0000${observation.sourceKey}`;
}

/** Deterministic content identity used to distinguish exact redelivery from a
 * conflicting reuse of a source key. */
export function analyticsObservationFingerprint<Fields extends object>(observation: AnalyticsObservation<Fields>): string {
  const { sourceSequence: _sourceSequence, stableOriginId: _stableOriginId, producer, ...payload } = observation;
  // Delivery sequence/origin and process identity are transport receipts, not
  // source payload. Excluding them permits exact replay after helper/producer
  // replacement while build attribution remains conflict-checked.
  return JSON.stringify(canonicalize({
    ...payload,
    producer: { buildId: producer.buildId },
  }));
}

export interface AnalyticsObservationRegistry {
  readonly [registryKey: string]: string;
}

export type ObservationAcceptanceStatus = 'accepted' | 'duplicate' | 'conflict' | 'invalid';

export interface ObservationAcceptance {
  status: ObservationAcceptanceStatus;
  registryKey?: string;
  fingerprint?: string;
  state: AnalyticsObservationRegistry;
  issues?: readonly ObservationValidationIssue[];
}

/** Pure source-key acceptance helper for recorder and parity fixtures. It does
 * not persist anything and never hides a conflicting source key. */
export function acceptAnalyticsObservation<Fields extends object>(
  state: AnalyticsObservationRegistry,
  observation: AnalyticsObservation<Fields>,
): ObservationAcceptance {
  const issues = validateAnalyticsObservation(observation);
  if (issues.length > 0) return { status: 'invalid', state, issues };
  const registryKey = analyticsObservationRegistryKey(observation);
  const fingerprint = analyticsObservationFingerprint(observation);
  const existing = state[registryKey];
  if (existing === undefined) {
    return {
      status: 'accepted',
      registryKey,
      fingerprint,
      state: { ...state, [registryKey]: fingerprint },
    };
  }
  if (existing === fingerprint) {
    return { status: 'duplicate', registryKey, fingerprint, state };
  }
  return { status: 'conflict', registryKey, fingerprint, state };
}

/** Throws only for a conflict; exact redelivery remains a no-op. */
export function assertAnalyticsObservationCompatible<Fields extends object>(
  state: AnalyticsObservationRegistry,
  observation: AnalyticsObservation<Fields>,
): ObservationAcceptance {
  const result = acceptAnalyticsObservation(state, observation);
  if (result.status === 'invalid') throw new AnalyticsValidationError(result.issues ?? []);
  if (result.status === 'conflict') {
    throw new AnalyticsSourceConflictError(
      result.registryKey!,
      state[result.registryKey!]!,
      result.fingerprint!,
    );
  }
  return result;
}
