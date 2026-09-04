import type { ComposerInput, ExtensionUIResponsePayload, FilesystemPathComposerInput, ImageBlobComposerInput, ModelSettings, NestedAllowedBuckets, SubagentBucketCanSpawn, SubagentBuckets, ThinkingLevel, TranscriptMode, TranscriptPageDirection, buildRuntimePrefsPayload } from '../shared/protocol';
import { isThinkingLevel } from '../shared/thinking-level';
import { ALL_NESTED_BUCKETS_ALLOWED, ALL_SUBAGENT_BUCKETS_CAN_SPAWN, DEFAULT_HISTORY_COMPACTION_SETTINGS } from '../shared/protocol';
import { ALLOWED_IMAGE_MIME_TYPES, decodedBase64ByteLength, MAX_AGGREGATE_IMAGE_INPUT_BYTES, MAX_IMAGE_INPUT_BYTES } from '../shared/image-constraints';
import { THINKING_LEVELS } from '../shared/thinking-level.js';
import { isPendingTabPath } from '../shared/tab-behavior.js';
import {
  isDetailCursor,
  isDetailPageRef,
  isLiveSubagentDetailAddress,
  type DetailCursor,
  type DetailPageRef,
  type LiveSubagentDetailAddress,
} from '../shared/protocol/subagent-detail.js';
import { BackendError } from './server-io';

export { MAX_IMAGE_INPUT_BYTES } from '../shared/image-constraints';

/** Mirrors the isolated coordinator authority's finite per-phase safety cap. */
const PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS = 5 * 60;

// ─── Argument parsing ────────────────────────────────────────────────────────

export interface BackendArgs {
  sdkPath: string;
  cwd: string;
  /** Host-authoritative process generation, shared by public/detail/worker fences. */
  backendGeneration: number;
  /** Extension-host PID used to reap the backend after a host crash. */
  hostPid?: number;
  /** Dedicated inherited descriptor whose EOF proves the host disappeared. */
  lifetimeFd?: number;
}

export function parseArgs(argv: string[]): BackendArgs {
  let sdkPath = '';
  let cwd = process.cwd();
  let hostPid: number | undefined;
  let lifetimeFd: number | undefined;
  let backendGeneration = 1;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--sdkPath' && value) {
      sdkPath = value;
      index += 1;
      continue;
    }
    if (arg === '--cwd' && value) {
      cwd = value;
      index += 1;
      continue;
    }
    if (arg === '--hostPid' && value) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        hostPid = parsed;
      }
      index += 1;
      continue;
    }
    if (arg === '--backendGeneration' && value) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('Invalid --backendGeneration argument.');
      }
      backendGeneration = parsed;
      index += 1;
      continue;
    }
    if (arg === '--lifetimeFd' && value) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 3) {
        throw new Error('Invalid --lifetimeFd argument.');
      }
      lifetimeFd = parsed;
      index += 1;
    }
  }

  if (!sdkPath) {
    throw new Error('Missing required --sdkPath argument.');
  }

  return {
    sdkPath,
    cwd,
    backendGeneration,
    ...(hostPid === undefined ? {} : { hostPid }),
    ...(lifetimeFd === undefined ? {} : { lifetimeFd }),
  };
}

// ─── RPC parameter validation ────────────────────────────────────────────────

export interface SessionPathParams {
  sessionPath: string;
}

export interface LiveTurnCheckpointParams extends SessionPathParams {
  turnId?: string;
  attemptId?: string;
}

export interface SessionTitleGenerateParams {
  sessionPath: string;
  prompt: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  timeoutSec: number;
}

export interface MessageSendParams {
  sessionPath: string;
  text: string;
  inputs: ComposerInput[];
  /** Stable host mutation identity. Optional only for legacy callers. */
  operationId?: string;
  operationAttempt?: number;
  /** Host-side optimistic message ID for this send. For queued (steering/
   *  followUp) messages the backend mirrors the SDK's FIFO drain order in
   *  `SessionContext.queuedLocalIds` and echoes the ID back in
   *  `message.queuedDelivered` so the host can promote the exact message.
   *  Optional for backward compatibility with older hosts. */
  localId?: string;
}

export interface QueuedMessageParams {
  localId: string;
  text: string;
  inputs: ComposerInput[];
}

export interface MessageReplaceQueueParams {
  sessionPath: string;
  messages: QueuedMessageParams[];
  fallbackMessages: QueuedMessageParams[];
}

export function validateMessageReplaceQueue(params: unknown): MessageReplaceQueueParams {
  if (!isObj(params)) fail('message.replaceQueue', 'expected an object');
  const { sessionPath } = validateSessionPath('message.replaceQueue', params);
  const validateEntries = (field: 'messages' | 'fallbackMessages'): QueuedMessageParams[] => {
    const raw = params[field];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 256) {
      fail('message.replaceQueue', `${field} must contain between 1 and 256 queued messages`);
    }
    return raw.map((entry, index) => {
      if (!isObj(entry) || typeof entry['localId'] !== 'string' || !entry['localId']) {
        fail('message.replaceQueue', `${field}[${index}].localId must be a non-empty string`);
      }
      const validated = validateMessageSend({
        sessionPath,
        text: entry['text'],
        inputs: entry['inputs'],
        localId: entry['localId'],
      });
      return { localId: entry['localId'] as string, text: validated.text, inputs: validated.inputs };
    });
  };
  const messages = validateEntries('messages');
  const fallbackMessages = validateEntries('fallbackMessages');
  if (messages.length !== fallbackMessages.length
    || messages.some((message, index) => message.localId !== fallbackMessages[index]?.localId)) {
    fail('message.replaceQueue', 'messages and fallbackMessages must contain the same localIds in the same order');
  }
  return { sessionPath, messages, fallbackMessages };
}

export interface SessionCreateParams {
  cwd?: string;
  selectionToken?: string;
  /** Host-generated create-operation identity, stable across retries. Additive
   *  optional during compatibility rollout: when present the backend dedupes
   *  concurrent/retried `session.create` RPCs by it, reuses a completed durable
   *  result, and echoes it on the resulting `session.opened`. */
  operationId?: string;
  operationAttempt?: number;
}

export interface SessionOpenParams extends SessionPathParams {
  selectionToken?: string;
  /** Stable host lifecycle identity echoed by session.opened. */
  operationId?: string;
  operationAttempt?: number;
  /** How much transcript to ship back. Defaults to `'tail'` (full tail window)
   *  for backward compatibility; `'skip'` requests a metadata-only response
   *  (host already has the transcript loaded). See {@link TranscriptMode}. */
  transcript?: TranscriptMode;
}

export interface SessionViewedParams extends SessionPathParams {
  /** Host-observed predecessor for this actual visual selection transition.
   * `null` means no session was previously selected. */
  previousSessionPath: string | null;
}

export interface SessionDuplicateParams {
  sessionPath: string;
  selectionToken?: string;
  /** Host-generated create-operation identity, stable across retries. Additive
   *  optional during compatibility rollout: when present the backend dedupes
   *  concurrent/retried `session.duplicate` RPCs by it, reuses a completed
   *  durable result, and echoes it on the resulting `session.opened`. */
  operationId?: string;
  operationAttempt?: number;
}

export function validateSessionDuplicate(params: unknown): SessionDuplicateParams {
  if (!isObj(params)) fail('session.duplicate', 'expected an object');
  const { sessionPath } = validateSessionPath('session.duplicate', params);
  const operationId = readOperationId('session.duplicate', params);
  const operationAttempt = readOperationAttempt('session.duplicate', params);
  return {
    sessionPath,
    selectionToken: readSelectionToken('session.duplicate', params),
    ...(operationId !== undefined ? { operationId } : {}),
    ...(operationAttempt !== undefined ? { operationAttempt } : {}),
  };
}

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function fail(method: string, detail: string): never {
  throw new BackendError('INVALID_PARAMS', `Invalid params for ${method}: ${detail}`);
}

function readSelectionToken(method: string, params: Record<string, unknown>): string | undefined {
  const selectionToken = params['selectionToken'];
  if (selectionToken !== undefined && typeof selectionToken !== 'string') {
    fail(method, 'selectionToken must be a string when provided');
  }
  return selectionToken as string | undefined;
}

/** Optional `operationId` for create/duplicate dedupe (§6.3). Must be a
 *  non-empty string when provided so it can serve as a stable ledger key. */
function readOperationId(method: string, params: Record<string, unknown>): string | undefined {
  const operationId = params['operationId'];
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId)) {
    fail(method, 'operationId must be a non-empty string when provided');
  }
  return operationId as string | undefined;
}

function readOperationAttempt(method: string, params: Record<string, unknown>): number | undefined {
  const attempt = params['operationAttempt'];
  if (attempt !== undefined && (!Number.isInteger(attempt) || (attempt as number) < 1)) {
    fail(method, 'operationAttempt must be a positive integer when provided');
  }
  return attempt as number | undefined;
}

function rejectPendingSessionPath(method: string, sessionPath: string): void {
  if (isPendingTabPath(sessionPath)) {
    fail(method, 'sessionPath must reference a resolved session');
  }
}

export function validateSessionPath(method: string, params: unknown): SessionPathParams {
  if (!isObj(params) || typeof params['sessionPath'] !== 'string' || !params['sessionPath']) {
    fail(method, 'requires a string sessionPath');
  }
  const sessionPath = params['sessionPath'] as string;
  rejectPendingSessionPath(method, sessionPath);
  return { sessionPath };
}

export function validateLiveTurnCheckpoint(params: unknown): LiveTurnCheckpointParams {
  if (!isObj(params)) fail('liveTurn.checkpoint', 'expected an object');
  const { sessionPath } = validateSessionPath('liveTurn.checkpoint', params);
  const turnId = params['turnId'];
  const attemptId = params['attemptId'];
  if ((turnId !== undefined && (typeof turnId !== 'string' || !turnId))
    || (attemptId !== undefined && (typeof attemptId !== 'string' || !attemptId))) {
    fail('liveTurn.checkpoint', 'turnId and attemptId must be non-empty strings when provided');
  }
  if ((turnId === undefined) !== (attemptId === undefined)) {
    fail('liveTurn.checkpoint', 'turnId and attemptId must be provided together');
  }
  return {
    sessionPath,
    ...(typeof turnId === 'string' ? { turnId, attemptId: attemptId as string } : {}),
  };
}

export function validateSessionCreate(params: unknown): SessionCreateParams {
  if (params === undefined || params === null) return {};
  if (!isObj(params)) fail('session.create', 'expected an object');
  const cwd = (params as Record<string, unknown>)['cwd'];
  if (cwd !== undefined && typeof cwd !== 'string') {
    fail('session.create', 'cwd must be a string when provided');
  }
  const operationId = readOperationId('session.create', params);
  const operationAttempt = readOperationAttempt('session.create', params);
  return {
    cwd: cwd as string | undefined,
    selectionToken: readSelectionToken('session.create', params),
    ...(operationId !== undefined ? { operationId } : {}),
    ...(operationAttempt !== undefined ? { operationAttempt } : {}),
  };
}

export function validateSessionOpen(params: unknown): SessionOpenParams {
  if (!isObj(params)) fail('session.open', 'expected an object');
  const { sessionPath } = validateSessionPath('session.open', params);
  const transcript = (params as Record<string, unknown>)['transcript'];
  if (transcript !== undefined && transcript !== 'tail' && transcript !== 'skip') {
    fail('session.open', `transcript must be 'tail' or 'skip' when provided`);
  }
  const operationId = readOperationId('session.open', params);
  const operationAttempt = readOperationAttempt('session.open', params);
  return {
    sessionPath,
    selectionToken: readSelectionToken('session.open', params),
    transcript: transcript as SessionOpenParams['transcript'],
    ...(operationId !== undefined ? { operationId } : {}),
    ...(operationAttempt !== undefined ? { operationAttempt } : {}),
  };
}

export function validateSessionViewed(params: unknown): SessionViewedParams {
  if (!isObj(params)) fail('session.viewed', 'expected an object');
  const { sessionPath } = validateSessionPath('session.viewed', params);
  const previous = params['previousSessionPath'];
  if (previous !== null && typeof previous !== 'string') {
    fail('session.viewed', 'previousSessionPath must be a string or null');
  }
  if (typeof previous === 'string') {
    if (!previous) fail('session.viewed', 'previousSessionPath must be non-empty when provided');
    rejectPendingSessionPath('session.viewed', previous);
  }
  return { sessionPath, previousSessionPath: previous as string | null };
}

export interface LoadTranscriptPageParams extends SessionPathParams {
  direction: TranscriptPageDirection;
  loadedStart?: number;
  loadedEnd?: number;
}

const TRANSCRIPT_PAGE_DIRECTIONS: TranscriptPageDirection[] = ['older', 'newer', 'latest'];

export function validateLoadTranscriptPage(params: unknown): LoadTranscriptPageParams {
  if (!isObj(params)) {
    fail('session.loadTranscriptPage', 'expected an object');
  }

  const sessionPath = params['sessionPath'];
  if (typeof sessionPath !== 'string' || !sessionPath) {
    fail('session.loadTranscriptPage', 'requires a string sessionPath');
  }
  rejectPendingSessionPath('session.loadTranscriptPage', sessionPath);

  const direction = params['direction'];
  if (typeof direction !== 'string' || !TRANSCRIPT_PAGE_DIRECTIONS.includes(direction as TranscriptPageDirection)) {
    fail('session.loadTranscriptPage', `direction must be one of ${TRANSCRIPT_PAGE_DIRECTIONS.join(', ')}`);
  }

  const loadedStartRaw = params['loadedStart'];
  const loadedEndRaw = params['loadedEnd'];

  if (loadedStartRaw !== undefined && (!Number.isInteger(loadedStartRaw) || Number(loadedStartRaw) < 0)) {
    fail('session.loadTranscriptPage', 'loadedStart must be a non-negative integer when provided');
  }

  if (loadedEndRaw !== undefined && (!Number.isInteger(loadedEndRaw) || Number(loadedEndRaw) < 0)) {
    fail('session.loadTranscriptPage', 'loadedEnd must be a non-negative integer when provided');
  }

  const loadedStart = typeof loadedStartRaw === 'number' ? loadedStartRaw : undefined;
  const loadedEnd = typeof loadedEndRaw === 'number' ? loadedEndRaw : undefined;

  if (loadedStart !== undefined && loadedEnd !== undefined && loadedStart > loadedEnd) {
    fail('session.loadTranscriptPage', 'loadedStart must be less than or equal to loadedEnd when both are provided');
  }

  return {
    sessionPath,
    direction: direction as TranscriptPageDirection,
    loadedStart,
    loadedEnd,
  };
}

export interface TruncateAfterParams {
  sessionPath: string;
  entryId: string;
}

export function validateTruncateAfter(params: unknown): TruncateAfterParams {
  if (!isObj(params)) fail('session.truncateAfter', 'expected an object');
  const { sessionPath } = validateSessionPath('session.truncateAfter', params);
  const eid = (params as Record<string, unknown>)['entryId'];
  if (typeof eid !== 'string' || !eid) fail('session.truncateAfter', 'requires a string entryId');
  return { sessionPath, entryId: eid as string };
}

export interface ExtensionUiResponseParams {
  sessionPath: string;
  response: ExtensionUIResponsePayload;
}

export function validateExtensionUiResponse(params: unknown): ExtensionUiResponseParams {
  if (!isObj(params)) fail('extension_ui.response', 'expected an object');
  const { sessionPath } = validateSessionPath('extension_ui.response', params);
  const response = params['response'];
  if (!isObj(response) || typeof response['id'] !== 'string' || !response['id']) {
    fail('extension_ui.response', 'requires a response.id string');
  }
  // `id` is validated above; the optional `value`/`confirmed`/`cancelled` fields
  // are genuinely optional and consumed by `uiBridge.resolveRequest`, which
  // tolerates their absence. Single cast at the validated seam (S6 pattern).
  return { sessionPath, response: response as unknown as ExtensionUIResponsePayload };
}

function readNonEmptyString(method: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || !value) {
    fail(method, `${field} must be a non-empty string`);
  }
  return value;
}

function readAllowedString<T extends string>(method: string, field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(method, `${field} must be ${allowed.map((a) => `"${a}"`).join(' or ')}`);
  }
  return value as T;
}

function readPositiveNumber(method: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(method, `${field} must be a positive number`);
  }
  return value;
}

function readOptionalPositiveNumber(method: string, field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return readPositiveNumber(method, `${field} must be a positive number when provided`, value);
}

function readEnvelope(method: string, index: number, input: unknown): Record<string, unknown> {
  if (!isObj(input)) {
    fail(method, `inputs[${index}] must be an object`);
  }
  return input;
}

function readIdAndKind(method: string, index: number, input: Record<string, unknown>): { id: string; kind: string } {
  const id = readNonEmptyString(method, `inputs[${index}].id`, input['id']);
  const kind = readNonEmptyString(method, `inputs[${index}].kind`, input['kind']);
  return { id, kind };
}

function validateFilesystemPathRefInput(method: string, index: number, id: string, kind: string, input: Record<string, unknown>): FilesystemPathComposerInput {
  const path = readNonEmptyString(method, `inputs[${index}].path`, input['path']);
  const name = readNonEmptyString(method, `inputs[${index}].name`, input['name']);
  const source = readAllowedString(method, `inputs[${index}].source`, input['source'], ['picker', 'drop']);
  return { id, kind: 'filesystemPathRef', path, name, source };
}

function validateImageBlobInput(method: string, index: number, id: string, kind: string, input: Record<string, unknown>): ImageBlobComposerInput {
  const rawMimeType = input['mimeType'];
  if (typeof rawMimeType !== 'string' || !ALLOWED_IMAGE_MIME_TYPES.has(rawMimeType.toLowerCase())) {
    fail(method, `inputs[${index}].mimeType must be one of ${[...ALLOWED_IMAGE_MIME_TYPES].join(', ')}`);
  }
  const mimeType = rawMimeType as string;
  const name = readNonEmptyString(method, `inputs[${index}].name`, input['name']);
  const sizeBytes = readPositiveNumber(method, `inputs[${index}].sizeBytes`, input['sizeBytes']);
  if (sizeBytes > MAX_IMAGE_INPUT_BYTES) {
    fail(method, `inputs[${index}] exceeds the ${MAX_IMAGE_INPUT_BYTES} byte image limit`);
  }
  const dataBase64 = input['dataBase64'];
  if (typeof dataBase64 !== 'string' || !dataBase64.trim()) {
    fail(method, `inputs[${index}].dataBase64 must be a non-empty string`);
  }
  if (decodedBase64ByteLength(dataBase64) > MAX_IMAGE_INPUT_BYTES) {
    fail(method, `inputs[${index}] decoded data exceeds the ${MAX_IMAGE_INPUT_BYTES} byte image limit`);
  }
  const source = readAllowedString(method, `inputs[${index}].source`, input['source'], ['paste', 'drop']);
  const width = readOptionalPositiveNumber(method, `inputs[${index}].width`, input['width']);
  const height = readOptionalPositiveNumber(method, `inputs[${index}].height`, input['height']);
  return { id, kind: 'imageBlob', mimeType, name, sizeBytes, dataBase64, width, height, source };
}

function validateComposerInput(method: string, input: unknown, index: number): ComposerInput {
  const envelope = readEnvelope(method, index, input);
  const { id, kind } = readIdAndKind(method, index, envelope);

  if (kind === 'filesystemPathRef') {
    return validateFilesystemPathRefInput(method, index, id, kind, envelope);
  }
  if (kind === 'imageBlob') {
    return validateImageBlobInput(method, index, id, kind, envelope);
  }
  if (kind === 'fileBlob') {
    fail(method, 'Arbitrary pasted file attachments are not supported yet. Please attach a filesystem path instead.');
  }
  fail(method, `inputs[${index}].kind is not supported: ${String(kind)}`);
}

export function validateSessionTitleGenerate(params: unknown): SessionTitleGenerateParams {
  const method = 'session.title.generate';
  if (!isObj(params)) fail(method, 'expected an object');
  const value = params as Record<string, unknown>;
  const sessionPath = value.sessionPath;
  const prompt = value.prompt;
  const provider = value.provider;
  const model = value.model;
  const thinkingLevel = value.thinkingLevel;
  const timeoutSec = value.timeoutSec;
  if (typeof sessionPath !== 'string' || !sessionPath) fail(method, 'requires a string sessionPath');
  rejectPendingSessionPath(method, sessionPath);
  if (typeof prompt !== 'string' || !prompt.trim()) fail(method, 'requires a non-empty prompt');
  if (prompt.length > 100_000) fail(method, 'prompt exceeds the 100000 character limit');
  if (typeof provider !== 'string' || !provider.trim()) fail(method, 'requires a non-empty provider');
  if (typeof model !== 'string' || !model.trim()) fail(method, 'requires a non-empty model');
  if (!isThinkingLevel(thinkingLevel)) fail(method, 'requires a valid thinkingLevel');
  if (!Number.isInteger(timeoutSec) || (timeoutSec as number) < 1 || (timeoutSec as number) > 60) fail(method, 'requires timeoutSec from 1 to 60');
  return { sessionPath, prompt, provider, model, thinkingLevel, timeoutSec: timeoutSec as number };
}

function validateMessageContent(
  method: 'message.send' | 'message.edit',
  params: Record<string, unknown>,
): { sessionPath: string; text: string; inputs: ComposerInput[]; localId?: string } {
  const text = params['text'];
  if (typeof text !== 'string') fail(method, 'text must be a string');
  const sessionPath = params['sessionPath'];
  if (typeof sessionPath !== 'string' || !sessionPath) fail(method, 'requires a string sessionPath');
  rejectPendingSessionPath(method, sessionPath);

  const rawInputs = params['inputs'];
  let inputs: ComposerInput[] = [];
  if (rawInputs !== undefined) {
    if (!Array.isArray(rawInputs)) fail(method, 'inputs must be an array when provided');
    inputs = rawInputs.map((input, index) => validateComposerInput(method, input, index));
    const aggregateImageBytes = inputs.reduce(
      (total, input) => total + (input.kind === 'imageBlob'
        ? Math.max(input.sizeBytes, decodedBase64ByteLength(input.dataBase64))
        : 0),
      0,
    );
    if (aggregateImageBytes > MAX_AGGREGATE_IMAGE_INPUT_BYTES) {
      fail(method, `image inputs exceed the ${MAX_AGGREGATE_IMAGE_INPUT_BYTES} byte aggregate limit`);
    }
  }
  if (!text.trim() && inputs.length === 0) fail(method, 'requires non-empty text or at least one input');

  const localId = params['localId'];
  if (localId !== undefined && typeof localId !== 'string') {
    fail(method, 'localId must be a string when provided');
  }
  return { sessionPath, text, inputs, ...(typeof localId === 'string' ? { localId } : {}) };
}

export function validateMessageSend(params: unknown): MessageSendParams {
  if (!isObj(params)) fail('message.send', 'expected an object');
  const content = validateMessageContent('message.send', params);
  const operationId = readOperationId('message.send', params);
  const operationAttempt = readOperationAttempt('message.send', params);
  return {
    ...content,
    localId: content.localId,
    ...(operationId ? { operationId } : {}),
    ...(operationAttempt !== undefined ? { operationAttempt } : {}),
  };
}

export interface MessageEditParams {
  sessionPath: string;
  entryId: string;
  text: string;
  inputs: ComposerInput[];
  localId?: string;
  operationId: string;
  operationAttempt: number;
}

export function validateMessageEdit(params: unknown): MessageEditParams {
  const method = 'message.edit';
  if (!isObj(params)) fail(method, 'expected an object');
  const content = validateMessageContent(method, params);
  const entryId = params['entryId'];
  const messageId = params['messageId'];
  if (entryId !== undefined && messageId !== undefined && entryId !== messageId) {
    fail(method, 'entryId and messageId must match when both are provided');
  }
  const targetId = entryId ?? messageId;
  if (typeof targetId !== 'string' || !targetId) fail(method, 'requires a non-empty entryId or messageId');
  const operationId = readOperationId(method, params);
  const operationAttempt = readOperationAttempt(method, params);
  if (!operationId || operationAttempt === undefined) {
    fail(method, 'operationId and operationAttempt are required');
  }
  return { ...content, entryId: targetId, operationId, operationAttempt };
}

export interface MessageOperationParams extends SessionPathParams {
  operationId?: string;
  operationAttempt?: number;
}

export interface MessageInterruptParams extends SessionPathParams {
  operationId?: string;
  operationAttempt?: number;
}

/** Stable identity is required as a pair by production callers. Both fields
 * remain optional together for legacy clients during protocol migration. */
export function validateMessageInterrupt(params: unknown): MessageInterruptParams {
  const method = 'message.interrupt';
  if (!isObj(params)) fail(method, 'expected an object');
  const { sessionPath } = validateSessionPath(method, params);
  const operationId = readOperationId(method, params);
  const operationAttempt = readOperationAttempt(method, params);
  if ((operationId === undefined) !== (operationAttempt === undefined)) {
    fail(method, 'operationId and operationAttempt must be provided together');
  }
  return { sessionPath, ...(operationId ? { operationId, operationAttempt } : {}) };
}

export interface CompactOperationParams extends MessageOperationParams {
  reason: 'manual';
}

export function validateMessageOperation(
  method: 'message.continue' | 'message.compact',
  params: unknown,
): MessageOperationParams | CompactOperationParams {
  if (!isObj(params)) fail(method, 'expected an object');
  const { sessionPath } = validateSessionPath(method, params);
  const operationId = readOperationId(method, params);
  const operationAttempt = readOperationAttempt(method, params);
  if ((operationId === undefined) !== (operationAttempt === undefined)) {
    fail(method, 'operationId and operationAttempt must be provided together');
  }
  if (method === 'message.compact') {
    const reason = params.reason ?? 'manual';
    if (reason !== 'manual') fail(method, 'reason must be manual');
    return {
      sessionPath,
      reason,
      ...(operationId ? { operationId, operationAttempt } : {}),
    };
  }
  return { sessionPath, ...(operationId ? { operationId, operationAttempt } : {}) };
}

export interface OperationStatusParams extends SessionPathParams {
  operationId: string;
  backendGeneration?: number;
}

export function validateOperationStatus(params: unknown): OperationStatusParams {
  if (!isObj(params)) fail('operation.status', 'expected an object');
  const { sessionPath } = validateSessionPath('operation.status', params);
  const operationId = readOperationId('operation.status', params as Record<string, unknown>);
  if (!operationId) fail('operation.status', 'requires operationId');
  const backendGeneration = params.backendGeneration;
  if (backendGeneration !== undefined
    && (!Number.isSafeInteger(backendGeneration) || (backendGeneration as number) < 1)) {
    fail('operation.status', 'backendGeneration must be a positive integer when provided');
  }
  return {
    sessionPath,
    operationId,
    ...(backendGeneration !== undefined ? { backendGeneration: backendGeneration as number } : {}),
  };
}

export interface SettingsSetParams extends Partial<ModelSettings> {
  sessionPath?: string;
}

function validateOptionalInt(
  method: string,
  fieldName: string,
  raw: unknown,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max || Math.floor(raw) !== raw) {
    fail(method, `${fieldName} must be an integer between ${min} and ${max} when provided`);
  }
  return raw;
}

const BUCKET_FIELD_KEYS = ['small', 'medium', 'frontier'] as const;

/**
 * Validate an optional `subagentBuckets` payload. Accepts `undefined` (omitted)
 * or an object whose `small`/`medium`/`frontier` fields are arrays of explicit
 * `{ model, thinkingLevel }` assignments. Missing bucket keys are allowed.
 * Returns a normalized {@link SubagentBuckets} with copies of the arrays, or
 * `undefined` when omitted so the host can skip the env update.
 */
function validateOptionalSubagentBuckets(
  method: string,
  raw: unknown,
): SubagentBuckets | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw) || Array.isArray(raw)) {
    fail(method, 'subagentBuckets must be an object when provided');
  }
  const src = raw as Record<string, unknown>;
  const validLevels = new Set<string>(THINKING_LEVELS);
  const out: SubagentBuckets = { small: [], medium: [], frontier: [] };
  for (const key of BUCKET_FIELD_KEYS) {
    const v = src[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      fail(method, `subagentBuckets.${key} must be an array of model/reasoning assignments when provided`);
    }
    out[key] = (v as unknown[]).map((entry) => {
      if (!isObj(entry) || Array.isArray(entry)) {
        fail(method, `subagentBuckets.${key} entries must be objects with model and thinkingLevel`);
      }
      const assignment = entry as Record<string, unknown>;
      if (Object.keys(assignment).some((field) => field !== 'model' && field !== 'thinkingLevel')
        || typeof assignment.model !== 'string'
        || assignment.model.trim().length === 0
        || typeof assignment.thinkingLevel !== 'string'
        || !validLevels.has(assignment.thinkingLevel)) {
        fail(method, `subagentBuckets.${key} entries require a non-empty model and supported thinkingLevel`);
      }
      return {
        model: assignment.model.trim(),
        thinkingLevel: assignment.thinkingLevel as ThinkingLevel,
      };
    });
  }
  return out;
}

/**
 * Validate an optional `subagentNestedAllowedBuckets` payload. Accepts `undefined`
 * (omitted) or an object whose `small`/`medium`/`frontier` fields are each a
 * boolean. Missing bucket keys default to `true` (allowed). Returns a normalized
 * {@link NestedAllowedBuckets}, or `undefined` when omitted so the host can skip
 * the env update.
 */
function validateOptionalBucketBooleanPolicy<T extends NestedAllowedBuckets | SubagentBucketCanSpawn>(
  method: string,
  fieldName: string,
  raw: unknown,
  defaults: T,
): T | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw) || Array.isArray(raw)) {
    fail(method, `${fieldName} must be an object when provided`);
  }
  const src = raw as Record<string, unknown>;
  const out: T = { ...defaults };
  for (const key of BUCKET_FIELD_KEYS) {
    const v = src[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') {
      fail(method, `${fieldName}.${key} must be a boolean when provided`);
    }
    out[key] = v;
  }
  return out;
}

function validateBooleanMap(
  method: string,
  fieldName: string,
  raw: unknown,
): Record<string, boolean> {
  if (raw === undefined) return {};
  if (!isObj(raw) || Array.isArray(raw)) {
    fail(method, `${fieldName} must be an object when provided`);
  }
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean') {
      // Keys with non-identifier characters (e.g. "skill-pruner") render with
      // bracket notation so the error message is parseable.
      const isIdentLike = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
      const path = isIdentLike ? `${fieldName}.${key}` : `${fieldName}['${key}']`;
      fail(method, `${path} must be a boolean`);
    }
    out[key] = value;
  }
  return out;
}

function validateNestedBooleanMap(method: string, fieldName: string, raw: unknown): Record<string, Record<string, boolean>> {
  if (raw === undefined) return {};
  if (!isObj(raw) || Array.isArray(raw)) fail(method, `${fieldName} must be an object when provided`);
  const out: Record<string, Record<string, boolean>> = {};
  for (const [sessionPath, value] of Object.entries(raw)) {
    out[sessionPath] = validateBooleanMap(method, `${fieldName}[${JSON.stringify(sessionPath)}]`, value);
  }
  return out;
}

/** Wire shape of a `runtimePrefs.set` payload, derived from
 *  {@link buildRuntimePrefsPayload} so the backend validator tracks the
 *  producer. Local replacement for the former protocol-level
 *  `RuntimePrefsSetParams` (now inlined on `buildRuntimePrefsPayload`). */
type RuntimePrefsSetParams = ReturnType<typeof buildRuntimePrefsPayload>;

/** Validate an optional `providerConcurrency` payload. Accepts `undefined`
 *  (omitted) or an object whose keys are provider names and values are objects
 *  with optional numeric fields (`maxConcurrentRequests`, `afterburnSeconds`,
 *  `queueWaitSeconds`, `headerWaitSeconds`). Returns a normalized copy, or
 *  `undefined` when omitted so the host can skip the reconfigure. */
function validateOptionalProviderConcurrency(
  method: string,
  raw: unknown,
): RuntimePrefsSetParams['providerConcurrency'] {
  if (raw === undefined) return undefined;
  if (!isObj(raw) || Array.isArray(raw)) {
    fail(method, 'providerConcurrency must be an object when provided');
  }
  const src = raw as Record<string, unknown>;
  const out: NonNullable<RuntimePrefsSetParams['providerConcurrency']> = {};
  for (const [provider, overrides] of Object.entries(src)) {
    if (overrides === undefined || overrides === null) continue;
    if (!isObj(overrides) || Array.isArray(overrides)) {
      fail(method, `providerConcurrency.${provider} must be an object when provided`);
    }
    const o = overrides as Record<string, unknown>;
    const cleaned: NonNullable<RuntimePrefsSetParams['providerConcurrency']>[string] = {};
    const maxConcurrent = o['maxConcurrentRequests'];
    if (maxConcurrent !== undefined) {
      if (typeof maxConcurrent !== 'number' || !Number.isFinite(maxConcurrent) || maxConcurrent < 1 || Math.floor(maxConcurrent) !== maxConcurrent) {
        fail(method, `providerConcurrency.${provider}.maxConcurrentRequests must be a positive integer when provided`);
      }
      cleaned.maxConcurrentRequests = maxConcurrent;
    }
    const afterburn = o['afterburnSeconds'];
    if (afterburn !== undefined) {
      if (typeof afterburn !== 'number' || !Number.isFinite(afterburn) || afterburn < 0) {
        fail(method, `providerConcurrency.${provider}.afterburnSeconds must be a non-negative number when provided`);
      }
      cleaned.afterburnSeconds = afterburn;
    }
    const queueWait = o['queueWaitSeconds'];
    if (queueWait !== undefined) {
      if (typeof queueWait !== 'number' || !Number.isInteger(queueWait)
        || queueWait < 0 || queueWait > PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS) {
        fail(method, `providerConcurrency.${provider}.queueWaitSeconds must be an integer from 0 to ${PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS} when provided`);
      }
      cleaned.queueWaitSeconds = queueWait;
    }
    const headerWait = o['headerWaitSeconds'];
    if (headerWait !== undefined) {
      if (typeof headerWait !== 'number' || !Number.isInteger(headerWait)
        || headerWait < 0 || headerWait > PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS) {
        fail(method, `providerConcurrency.${provider}.headerWaitSeconds must be an integer from 0 to ${PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS} when provided`);
      }
      cleaned.headerWaitSeconds = headerWait;
    }
    out[provider] = cleaned;
  }
  return out;
}

function validateHistoryCompactionModelProfile(
  method: string,
  key: string,
  raw: unknown,
): { softThreshold: number; hardThreshold: number; keepRecentTokens: number } {
  if (!isObj(raw)) fail(method, `historyCompaction.modelProfiles['${key}'] must be an object`);
  const allowedKeys = ['softThreshold', 'hardThreshold', 'keepRecentTokens'];
  for (const k of Object.keys(raw)) {
    if (!allowedKeys.includes(k)) {
      fail(method, `historyCompaction.modelProfiles['${key}'] has unknown key ${k}`);
    }
  }
  for (const field of allowedKeys) {
    const n = raw[field];
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      fail(method, `historyCompaction.modelProfiles['${key}'].${field} must be a non-negative integer`);
    }
  }
  const soft = raw.softThreshold as number;
  const hard = raw.hardThreshold as number;
  const keep = raw.keepRecentTokens as number;
  if (soft < 1_000 || hard > 10_000_000 || keep >= soft || soft >= hard) {
    fail(method, `historyCompaction.modelProfiles['${key}'] requires 0 <= keep < soft < hard`);
  }
  return { softThreshold: soft, hardThreshold: hard, keepRecentTokens: keep };
}

function validateOptionalHistoryCompaction(
  raw: unknown,
): RuntimePrefsSetParams['historyCompaction'] {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) fail('runtimePrefs.set', 'historyCompaction must be an object when provided');
  const enabled = raw.enabled;
  const thresholdMode = raw.thresholdMode;
  const softThreshold = raw.softThreshold;
  const hardThreshold = raw.hardThreshold;
  if (typeof enabled !== 'boolean') fail('runtimePrefs.set', 'historyCompaction.enabled must be a boolean');
  if (thresholdMode !== 'percentage' && thresholdMode !== 'tokens') {
    fail('runtimePrefs.set', 'historyCompaction.thresholdMode must be percentage or tokens');
  }
  if (typeof softThreshold !== 'number' || !Number.isFinite(softThreshold)
      || typeof hardThreshold !== 'number' || !Number.isFinite(hardThreshold)) {
    fail('runtimePrefs.set', 'historyCompaction thresholds must be finite numbers');
  }
  const minimum = thresholdMode === 'tokens' ? 1_000 : 1;
  const maximum = thresholdMode === 'tokens' ? 10_000_000 : 99;
  if (softThreshold < minimum || hardThreshold > maximum || softThreshold >= hardThreshold) {
    fail('runtimePrefs.set', `historyCompaction requires ${minimum} <= soft < hard <= ${maximum}`);
  }

  const keepRecentTokensRaw = raw.keepRecentTokens;
  const keepRecentTokens = keepRecentTokensRaw === undefined
    ? undefined
    : (typeof keepRecentTokensRaw === 'number' && Number.isFinite(keepRecentTokensRaw) && Number.isInteger(keepRecentTokensRaw) && keepRecentTokensRaw >= 0 && keepRecentTokensRaw <= 10_000_000
      ? keepRecentTokensRaw
      : fail('runtimePrefs.set', 'historyCompaction.keepRecentTokens must be an integer between 0 and 10,000,000'));
  if (thresholdMode === 'tokens' && keepRecentTokens !== undefined && keepRecentTokens >= softThreshold) {
    fail('runtimePrefs.set', 'historyCompaction token mode requires keepRecentTokens < softThreshold');
  }

  const summaryInstructionsRaw = raw.summaryInstructions;
  const summaryInstructions = summaryInstructionsRaw === undefined
    ? undefined
    : (typeof summaryInstructionsRaw === 'string' && summaryInstructionsRaw.length <= 4_000
      ? summaryInstructionsRaw
      : fail('runtimePrefs.set', 'historyCompaction.summaryInstructions must be a string of at most 4,000 characters'));

  const summaryThinkingLevelRaw = raw.summaryThinkingLevel;
  const summaryThinkingLevel = summaryThinkingLevelRaw === undefined
    ? undefined
    : (summaryThinkingLevelRaw === 'inherit' || THINKING_LEVELS.includes(summaryThinkingLevelRaw as ThinkingLevel)
      ? summaryThinkingLevelRaw as 'inherit' | ThinkingLevel
      : fail('runtimePrefs.set', 'historyCompaction.summaryThinkingLevel must be inherit or a supported thinking level'));

  const summaryModelRaw = raw.summaryModel;
  const summaryModel = summaryModelRaw === undefined
    ? undefined
    : (summaryModelRaw === null
      ? null
      : (isObj(summaryModelRaw)
        ? (typeof summaryModelRaw.provider === 'string' && summaryModelRaw.provider
            && typeof summaryModelRaw.id === 'string' && summaryModelRaw.id
          ? { provider: summaryModelRaw.provider, id: summaryModelRaw.id }
          : fail('runtimePrefs.set', 'historyCompaction.summaryModel must contain non-empty provider and id'))
        : fail('runtimePrefs.set', 'historyCompaction.summaryModel must be null or an object')));

  const modelProfilesRaw = raw.modelProfiles;
  const modelProfiles = modelProfilesRaw === undefined
    ? undefined
    : (isObj(modelProfilesRaw) && !Array.isArray(modelProfilesRaw)
      ? (() => {
        const out: Record<string, { softThreshold: number; hardThreshold: number; keepRecentTokens: number }> = {};
        for (const [key, entry] of Object.entries(modelProfilesRaw)) {
          out[key] = validateHistoryCompactionModelProfile('runtimePrefs.set', key, entry);
        }
        return out;
      })()
      : fail('runtimePrefs.set', 'historyCompaction.modelProfiles must be an object'));

  return {
    enabled,
    thresholdMode,
    softThreshold,
    hardThreshold,
    keepRecentTokens: keepRecentTokens ?? DEFAULT_HISTORY_COMPACTION_SETTINGS.keepRecentTokens,
    summaryInstructions: summaryInstructions ?? DEFAULT_HISTORY_COMPACTION_SETTINGS.summaryInstructions,
    summaryThinkingLevel: summaryThinkingLevel ?? DEFAULT_HISTORY_COMPACTION_SETTINGS.summaryThinkingLevel,
    summaryModel: summaryModel ?? DEFAULT_HISTORY_COMPACTION_SETTINGS.summaryModel,
    modelProfiles: modelProfiles ?? DEFAULT_HISTORY_COMPACTION_SETTINGS.modelProfiles,
  };
}

export function validateRuntimePrefsSet(params: unknown): RuntimePrefsSetParams {
  if (!isObj(params)) fail('runtimePrefs.set', 'expected an object');
  const providerToggles = validateBooleanMap(
    'runtimePrefs.set',
    'providerToggles',
    (params as Record<string, unknown>)['providerToggles'],
  );
  const extensionToggles = validateBooleanMap(
    'runtimePrefs.set',
    'extensionToggles',
    (params as Record<string, unknown>)['extensionToggles'],
  );
  const rawSubagentProviderDefaults = (params as Record<string, unknown>)['subagentProviderDefaults'];
  const subagentProviderDefaults = rawSubagentProviderDefaults === undefined
    ? undefined
    : validateBooleanMap('runtimePrefs.set', 'subagentProviderDefaults', rawSubagentProviderDefaults);
  const rawSubagentProviderToggles = (params as Record<string, unknown>)['subagentProviderTogglesBySession'];
  const subagentProviderTogglesBySession = rawSubagentProviderToggles === undefined
    ? undefined
    : validateNestedBooleanMap('runtimePrefs.set', 'subagentProviderTogglesBySession', rawSubagentProviderToggles);
  const rawAutonomousMode = (params as Record<string, unknown>)['autonomousMode'];
  const autonomousMode = rawAutonomousMode === undefined
    ? undefined
    : typeof rawAutonomousMode === 'boolean'
      ? rawAutonomousMode
      : fail('runtimePrefs.set', 'autonomousMode must be a boolean when provided');
  const rawMcpEnabled = (params as Record<string, unknown>)['mcpEnabled'];
  const mcpEnabled = rawMcpEnabled === undefined
    ? undefined
    : typeof rawMcpEnabled === 'boolean'
      ? rawMcpEnabled
      : fail('runtimePrefs.set', 'mcpEnabled must be a boolean when provided');
  const rawAlwaysParent = (params as Record<string, unknown>)['subagentAlwaysParentModel'];
  const subagentAlwaysParentModel =
    rawAlwaysParent === undefined ? undefined : typeof rawAlwaysParent === 'boolean' ? rawAlwaysParent : fail('runtimePrefs.set', 'subagentAlwaysParentModel must be a boolean when provided');
  const rawRouteAroundSaturated = (params as Record<string, unknown>)['subagentRouteAroundSaturatedProviders'];
  const subagentRouteAroundSaturatedProviders =
    rawRouteAroundSaturated === undefined ? undefined : typeof rawRouteAroundSaturated === 'boolean' ? rawRouteAroundSaturated : fail('runtimePrefs.set', 'subagentRouteAroundSaturatedProviders must be a boolean when provided');
  const rawFallbackOnProviderFailure = (params as Record<string, unknown>)['subagentFallbackOnProviderFailure'];
  const subagentFallbackOnProviderFailure =
    rawFallbackOnProviderFailure === undefined ? undefined : typeof rawFallbackOnProviderFailure === 'boolean' ? rawFallbackOnProviderFailure : fail('runtimePrefs.set', 'subagentFallbackOnProviderFailure must be a boolean when provided');
  const subagentMaxDepth = validateOptionalInt('runtimePrefs.set', 'subagentMaxDepth', (params as Record<string, unknown>)['subagentMaxDepth'], 0, 8);
  const subagentMaxTreeSessions = validateOptionalInt('runtimePrefs.set', 'subagentMaxTreeSessions', (params as Record<string, unknown>)['subagentMaxTreeSessions'], 5, 200);
  const subagentBuckets = validateOptionalSubagentBuckets('runtimePrefs.set', (params as Record<string, unknown>)['subagentBuckets']);
  const subagentNestedAllowedBuckets = validateOptionalBucketBooleanPolicy(
    'runtimePrefs.set',
    'subagentNestedAllowedBuckets',
    (params as Record<string, unknown>)['subagentNestedAllowedBuckets'],
    ALL_NESTED_BUCKETS_ALLOWED,
  );
  const subagentBucketCanSpawn = validateOptionalBucketBooleanPolicy(
    'runtimePrefs.set',
    'subagentBucketCanSpawn',
    (params as Record<string, unknown>)['subagentBucketCanSpawn'],
    ALL_SUBAGENT_BUCKETS_CAN_SPAWN,
  );
  const rawSubagentDropTools = (params as Record<string, unknown>)['subagentDropTools'];
  const subagentDropTools = rawSubagentDropTools === undefined ? undefined : Array.isArray(rawSubagentDropTools) && rawSubagentDropTools.every((entry) => typeof entry === 'string') ? [...(rawSubagentDropTools as string[])] : fail('runtimePrefs.set', 'subagentDropTools must be an array of strings when provided');
  const subagentMaxInflight = validateOptionalInt('runtimePrefs.set', 'subagentMaxInflight', (params as Record<string, unknown>)['subagentMaxInflight'], 1, 16);
  const bashWarmPoolSize = validateOptionalInt('runtimePrefs.set', 'bashWarmPoolSize', (params as Record<string, unknown>)['bashWarmPoolSize'], 0, 8);
  const rawBashFastPath = (params as Record<string, unknown>)['bashFastPath'];
  const bashFastPath = rawBashFastPath === undefined ? undefined : typeof rawBashFastPath === 'boolean' ? rawBashFastPath : fail('runtimePrefs.set', 'bashFastPath must be a boolean when provided');
  const rawBashShellPath = (params as Record<string, unknown>)['bashShellPath'];
  const bashShellPath = rawBashShellPath === undefined ? undefined : typeof rawBashShellPath === 'string' ? rawBashShellPath : fail('runtimePrefs.set', 'bashShellPath must be a string when provided');
  const bashWarmupTimeoutMs = validateOptionalInt('runtimePrefs.set', 'bashWarmupTimeoutMs', (params as Record<string, unknown>)['bashWarmupTimeoutMs'], 0, 60000);
  const bashDefaultTimeout = validateOptionalInt('runtimePrefs.set', 'bashDefaultTimeout', (params as Record<string, unknown>)['bashDefaultTimeout'], 1, 600);
  const providerConcurrency = validateOptionalProviderConcurrency('runtimePrefs.set', (params as Record<string, unknown>)['providerConcurrency']);
  const historyCompaction = validateOptionalHistoryCompaction((params as Record<string, unknown>)['historyCompaction']);
  return { providerToggles, ...(subagentProviderDefaults !== undefined ? { subagentProviderDefaults } : {}), ...(subagentProviderTogglesBySession !== undefined ? { subagentProviderTogglesBySession } : {}), extensionToggles, autonomousMode, mcpEnabled, subagentAlwaysParentModel, subagentRouteAroundSaturatedProviders, subagentFallbackOnProviderFailure, subagentMaxDepth, subagentMaxTreeSessions, subagentMaxInflight, bashWarmPoolSize, bashFastPath, bashShellPath, bashWarmupTimeoutMs, bashDefaultTimeout, subagentBuckets, subagentNestedAllowedBuckets, subagentBucketCanSpawn, subagentDropTools, providerConcurrency, ...(historyCompaction !== undefined ? { historyCompaction } : {}) };
}

export interface OpenTabsSetParams {
  /** Open-tab summaries the host pushes so the `session_review` tool can list
   *  currently-open sessions without host state access. Published through the
   *  coordinator's revisioned worker-sync domain and mirrored into
   *  `process.env.PIE_OPEN_TABS` (JSON) for compatibility. */
  tabs: unknown[];
  /** Monotonic host-authority revision. Optional for legacy callers. */
  revision?: number;
}

const MAX_OPEN_TABS = 512;
const MAX_OPEN_TABS_PAYLOAD_BYTES = 192 * 1024;
const OPEN_TAB_STRING_LIMITS = {
  path: 16 * 1024,
  name: 4 * 1024,
  cwd: 16 * 1024,
  modifiedAt: 256,
  modelId: 512,
  provider: 256,
  thinkingLevel: 64,
} as const;

export interface McpSetServerEnabledParams {
  name: string;
  enabled: boolean;
}

/** Validate `mcp.setServerEnabled` (host → backend). The name identifies a
 *  configured server in the effective MCP config; the writer itself re-checks
 *  existence semantics on the merged config. */
export function validateMcpSetServerEnabled(params: unknown): McpSetServerEnabledParams {
  if (!isObj(params)) fail('mcp.setServerEnabled', 'expected an object');
  const rawName = (params as Record<string, unknown>)['name'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name.length === 0) fail('mcp.setServerEnabled', 'name must be a non-empty string');
  if (name.length > 256) fail('mcp.setServerEnabled', 'name must be at most 256 characters');
  const enabled = (params as Record<string, unknown>)['enabled'];
  if (typeof enabled !== 'boolean') fail('mcp.setServerEnabled', 'enabled must be a boolean');
  return { name, enabled };
}

export interface McpSetSessionServerEnabledParams {
  sessionPath: string;
  /** Full desired per-session override set; the backend writes/removes the
   *  session artifact from it (host state is the source of truth, the file is
   *  the carrier). */
  overrides: Record<string, boolean>;
  /** True when the host considers the session idle and wants the session's
   *  worker recycled so the adapter re-reads config at the next session
   *  start. The backend still refuses to retire a busy worker. */
  recycle: boolean;
}

/** Validate `mcp.setSessionServerEnabled` (host → backend). Per-session
 *  server overrides — a Pi-agent-dir-layer config artifact plus optional
 *  worker recycle; never the project `.pi/mcp.json` file. */
export function validateMcpSetSessionServerEnabled(params: unknown): McpSetSessionServerEnabledParams {
  if (!isObj(params)) fail('mcp.setSessionServerEnabled', 'expected an object');
  const source = params as Record<string, unknown>;
  const rawSessionPath = source['sessionPath'];
  const sessionPath = typeof rawSessionPath === 'string' ? rawSessionPath.trim() : '';
  if (sessionPath.length === 0) fail('mcp.setSessionServerEnabled', 'sessionPath must be a non-empty string');
  const rawOverrides = source['overrides'];
  if (!isObj(rawOverrides)) fail('mcp.setSessionServerEnabled', 'overrides must be an object');
  const overrides: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
    if (typeof value !== 'boolean') fail('mcp.setSessionServerEnabled', `overrides[${key}] must be a boolean`);
    overrides[key] = value;
  }
  if (Object.keys(overrides).length > 256) fail('mcp.setSessionServerEnabled', 'overrides must contain at most 256 entries');
  const recycle = source['recycle'];
  if (recycle !== undefined && typeof recycle !== 'boolean') fail('mcp.setSessionServerEnabled', 'recycle must be a boolean when provided');
  return { sessionPath, overrides, recycle: recycle === true };
}

/** Validate `openTabs.set` (host → backend). The tabs are open-tab summaries;
 *  we only require each be an object with a non-empty string `path` (the rest
 *  is passed through opaquely and stringified to env for the tool to parse). */
export function validateOpenTabsSet(params: unknown): OpenTabsSetParams {
  if (!isObj(params)) fail('openTabs.set', 'expected an object');
  const rawTabs = (params as Record<string, unknown>)['tabs'];
  if (!Array.isArray(rawTabs)) fail('openTabs.set', 'tabs must be an array');
  if (rawTabs.length > MAX_OPEN_TABS) fail('openTabs.set', `tabs must contain at most ${MAX_OPEN_TABS} entries`);
  const tabs: unknown[] = [];
  for (let i = 0; i < rawTabs.length; i += 1) {
    const entry = rawTabs[i];
    if (!isObj(entry)) fail('openTabs.set', `tabs[${i}] must be an object`);
    const source = entry as Record<string, unknown>;
    const p = source['path'];
    if (typeof p !== 'string' || !p) fail('openTabs.set', `tabs[${i}].path must be a non-empty string`);
    const normalized: Record<string, unknown> = {};
    for (const [key, limit] of Object.entries(OPEN_TAB_STRING_LIMITS)) {
      const value = source[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
        fail('openTabs.set', `tabs[${i}].${key} must be a non-empty string of at most ${limit} characters`);
      }
      normalized[key] = value;
    }
    const messageCount = source['messageCount'];
    if (messageCount !== undefined) {
      if (!Number.isSafeInteger(messageCount) || (messageCount as number) < 0) {
        fail('openTabs.set', `tabs[${i}].messageCount must be a non-negative safe integer`);
      }
      normalized['messageCount'] = messageCount;
    }
    for (const key of ['pinned', 'isRunning'] as const) {
      const value = source[key];
      if (value !== undefined && typeof value !== 'boolean') {
        fail('openTabs.set', `tabs[${i}].${key} must be a boolean when provided`);
      }
      if (value !== undefined) normalized[key] = value;
    }
    tabs.push(normalized);
  }
  if (Buffer.byteLength(JSON.stringify(tabs), 'utf8') > MAX_OPEN_TABS_PAYLOAD_BYTES) {
    fail('openTabs.set', `tabs payload must be at most ${MAX_OPEN_TABS_PAYLOAD_BYTES} UTF-8 bytes`);
  }
  const rawRevision = (params as Record<string, unknown>)['revision'];
  const revision = rawRevision === undefined
    ? undefined
    : Number.isSafeInteger(rawRevision) && (rawRevision as number) > 0
      ? rawRevision as number
      : fail('openTabs.set', 'revision must be a positive safe integer when provided');
  return { tabs, ...(revision === undefined ? {} : { revision }) };
}

export function validateSettingsSet(params: unknown): SettingsSetParams {
  if (!isObj(params)) fail('settings.set', 'expected an object');
  const out: SettingsSetParams = {};
  const sessionPath = (params as Record<string, unknown>)['sessionPath'];
  if (sessionPath !== undefined) {
    if (typeof sessionPath !== 'string' || !sessionPath) {
      fail('settings.set', 'sessionPath must be a non-empty string when provided');
    }
    rejectPendingSessionPath('settings.set', sessionPath);
    out.sessionPath = sessionPath;
  }
  const dm = (params as Record<string, unknown>)['defaultModel'];
  if (dm !== undefined) {
    if (typeof dm !== 'string') fail('settings.set', 'defaultModel must be a string');
    out.defaultModel = dm;
  }
  const dp = (params as Record<string, unknown>)['defaultProvider'];
  if (dp !== undefined) {
    if (typeof dp !== 'string' || !dp) fail('settings.set', 'defaultProvider must be a non-empty string when provided');
    out.defaultProvider = dp;
  }
  const dt = (params as Record<string, unknown>)['defaultThinkingLevel'];
  if (dt !== undefined) {
    if (typeof dt !== 'string' || !THINKING_LEVELS.includes(dt as ThinkingLevel)) {
      fail('settings.set', `defaultThinkingLevel must be one of ${THINKING_LEVELS.join(',')}`);
    }
    out.defaultThinkingLevel = dt as ThinkingLevel;
  }
  return out;
}

export interface SystemPromptTogglesSetParams {
  sessionPath: string;
  /** Complete set of disabled entry ids for the session (not a delta). An
   *  empty array re-enables everything. */
  disabledEntries: string[];
}

/** Validate `systemPromptToggles.set` (host -> backend). The host sends the
 *  complete disabled-entry set for a session; the backend persists it, rewrites
 *  the SDK base prompt, and re-emits `session.opened`. */
export function validateSystemPromptTogglesSet(params: unknown): SystemPromptTogglesSetParams {
  if (!isObj(params)) fail('systemPromptToggles.set', 'expected an object');
  const sessionPath = (params as Record<string, unknown>)['sessionPath'];
  if (typeof sessionPath !== 'string' || !sessionPath) {
    fail('systemPromptToggles.set', 'sessionPath must be a non-empty string');
  }
  rejectPendingSessionPath('systemPromptToggles.set', sessionPath);
  const rawEntries = (params as Record<string, unknown>)['disabledEntries'];
  if (!Array.isArray(rawEntries)) {
    fail('systemPromptToggles.set', 'disabledEntries must be an array of strings');
  }
  const disabledEntries: string[] = [];
  for (let i = 0; i < rawEntries.length; i += 1) {
    const entry = rawEntries[i];
    if (typeof entry !== 'string' || !entry) {
      fail('systemPromptToggles.set', `disabledEntries[${i}] must be a non-empty string`);
    }
    disabledEntries.push(entry);
  }
  return { sessionPath: sessionPath as string, disabledEntries };
}

// ─── Detail subscription RPC validation ─────────────────────────────
// The wire shapes mirror `HostToCoordinatorDetailMessage` from
// `shared/protocol/subagent-detail.ts`; the JSONL `id` becomes `requestId` at
// the server routing seam, so these validators accept everything except it.

export interface DetailSubscribeParams {
  subscriptionId: string;
  address: LiveSubagentDetailAddress;
  cursor?: DetailCursor;
  maxPageBytes: number;
}

export interface DetailUnsubscribeParams {
  subscriptionId: string;
  reason: 'collapse' | 'rebase' | 'session-change' | 'host-dispose';
}

export interface DetailFetchParams {
  subscriptionId: string;
  address: LiveSubagentDetailAddress;
  ref: DetailPageRef;
  maxPageBytes: number;
}

function readSubscriptionId(method: string, params: Record<string, unknown>): string {
  const subscriptionId = params['subscriptionId'];
  if (typeof subscriptionId !== 'string' || !subscriptionId) {
    fail(method, 'subscriptionId must be a non-empty string');
  }
  return subscriptionId as string;
}

function readMaxPageBytes(method: string, params: Record<string, unknown>): number {
  const maxPageBytes = params['maxPageBytes'];
  if (typeof maxPageBytes !== 'number' || !Number.isSafeInteger(maxPageBytes) || maxPageBytes <= 0) {
    fail(method, 'maxPageBytes must be a positive safe integer');
  }
  return maxPageBytes as number;
}

export function validateDetailSubscribe(params: unknown): DetailSubscribeParams {
  if (!isObj(params)) fail('detail.subscribe', 'expected an object');
  const record = params as Record<string, unknown>;
  const subscriptionId = readSubscriptionId('detail.subscribe', record);
  const maxPageBytes = readMaxPageBytes('detail.subscribe', record);
  if (!isLiveSubagentDetailAddress(record['address'])) {
    fail('detail.subscribe', 'address must be a valid live subagent detail address');
  }
  const cursor = record['cursor'];
  if (cursor !== undefined && !isDetailCursor(cursor)) {
    fail('detail.subscribe', 'cursor must be a valid detail cursor when provided');
  }
  return {
    subscriptionId,
    address: record['address'] as LiveSubagentDetailAddress,
    ...(cursor !== undefined ? { cursor: cursor as DetailCursor } : {}),
    maxPageBytes,
  };
}

export function validateDetailUnsubscribe(params: unknown): DetailUnsubscribeParams {
  if (!isObj(params)) fail('detail.unsubscribe', 'expected an object');
  const record = params as Record<string, unknown>;
  const subscriptionId = readSubscriptionId('detail.unsubscribe', record);
  const reason = record['reason'];
  if (reason !== 'collapse' && reason !== 'rebase' && reason !== 'session-change' && reason !== 'host-dispose') {
    fail('detail.unsubscribe', `reason must be one of collapse, rebase, session-change, host-dispose`);
  }
  return { subscriptionId, reason: reason as DetailUnsubscribeParams['reason'] };
}

export function validateDetailFetch(params: unknown): DetailFetchParams {
  if (!isObj(params)) fail('detail.fetch', 'expected an object');
  const record = params as Record<string, unknown>;
  const subscriptionId = readSubscriptionId('detail.fetch', record);
  const maxPageBytes = readMaxPageBytes('detail.fetch', record);
  if (!isLiveSubagentDetailAddress(record['address'])) {
    fail('detail.fetch', 'address must be a valid live subagent detail address');
  }
  if (!isDetailPageRef(record['ref'])) {
    fail('detail.fetch', 'ref must be a valid detail page ref');
  }
  return {
    subscriptionId,
    address: record['address'] as LiveSubagentDetailAddress,
    ref: record['ref'] as DetailPageRef,
    maxPageBytes,
  };
}
