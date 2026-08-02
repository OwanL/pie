import type { ComposerInput, ExtensionUIResponsePayload, FilesystemPathComposerInput, ImageBlobComposerInput, ModelSettings, NestedAllowedBuckets, SubagentBuckets, ThinkingLevel, TranscriptMode, TranscriptPageDirection, buildRuntimePrefsPayload } from '../shared/protocol';
import { ALL_NESTED_BUCKETS_ALLOWED, DEFAULT_HISTORY_COMPACTION_SETTINGS } from '../shared/protocol';
import { ALLOWED_IMAGE_MIME_TYPES, decodedBase64ByteLength, MAX_AGGREGATE_IMAGE_INPUT_BYTES, MAX_IMAGE_INPUT_BYTES } from '../shared/image-constraints';
import { THINKING_LEVELS } from '../shared/thinking-level.js';
import { BackendError } from './server-io';

export { MAX_IMAGE_INPUT_BYTES } from '../shared/image-constraints';

// ─── Argument parsing ────────────────────────────────────────────────────────

export interface BackendArgs {
  sdkPath: string;
  cwd: string;
}

export function parseArgs(argv: string[]): BackendArgs {
  let sdkPath = '';
  let cwd = process.cwd();

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
    }
  }

  if (!sdkPath) {
    throw new Error('Missing required --sdkPath argument.');
  }

  return { sdkPath, cwd };
}

// ─── RPC parameter validation ────────────────────────────────────────────────

export interface SessionPathParams {
  sessionPath: string;
}

export interface MessageSendParams {
  sessionPath: string;
  text: string;
  inputs: ComposerInput[];
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
}

export interface SessionOpenParams extends SessionPathParams {
  selectionToken?: string;
  /** How much transcript to ship back. Defaults to `'tail'` (full tail window)
   *  for backward compatibility; `'skip'` requests a metadata-only response
   *  (host already has the transcript loaded). See {@link TranscriptMode}. */
  transcript?: TranscriptMode;
}

export interface SessionDuplicateParams {
  sessionPath: string;
  selectionToken?: string;
}

export function validateSessionDuplicate(params: unknown): SessionDuplicateParams {
  if (!isObj(params)) fail('session.duplicate', 'expected an object');
  const { sessionPath } = validateSessionPath('session.duplicate', params);
  return {
    sessionPath,
    selectionToken: readSelectionToken('session.duplicate', params),
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

export function validateSessionPath(method: string, params: unknown): SessionPathParams {
  if (!isObj(params) || typeof params['sessionPath'] !== 'string' || !params['sessionPath']) {
    fail(method, 'requires a string sessionPath');
  }
  return { sessionPath: params['sessionPath'] as string };
}

export function validateSessionCreate(params: unknown): SessionCreateParams {
  if (params === undefined || params === null) return {};
  if (!isObj(params)) fail('session.create', 'expected an object');
  const cwd = (params as Record<string, unknown>)['cwd'];
  if (cwd !== undefined && typeof cwd !== 'string') {
    fail('session.create', 'cwd must be a string when provided');
  }
  return {
    cwd: cwd as string | undefined,
    selectionToken: readSelectionToken('session.create', params),
  };
}

export function validateSessionOpen(params: unknown): SessionOpenParams {
  if (!isObj(params)) fail('session.open', 'expected an object');
  const { sessionPath } = validateSessionPath('session.open', params);
  const transcript = (params as Record<string, unknown>)['transcript'];
  if (transcript !== undefined && transcript !== 'tail' && transcript !== 'skip') {
    fail('session.open', `transcript must be 'tail' or 'skip' when provided`);
  }
  return {
    sessionPath,
    selectionToken: readSelectionToken('session.open', params),
    transcript: transcript as SessionOpenParams['transcript'],
  };
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
  const sp = (params as Record<string, unknown>)['sessionPath'];
  if (typeof sp !== 'string' || !sp) fail('session.truncateAfter', 'requires a string sessionPath');
  const eid = (params as Record<string, unknown>)['entryId'];
  if (typeof eid !== 'string' || !eid) fail('session.truncateAfter', 'requires a string entryId');
  return { sessionPath: sp as string, entryId: eid as string };
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

function validateComposerInput(input: unknown, index: number): ComposerInput {
  const method = 'message.send';
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

export function validateMessageSend(params: unknown): MessageSendParams {
  if (!isObj(params)) fail('message.send', 'expected an object');
  const text = (params as Record<string, unknown>)['text'];
  if (typeof text !== 'string') {
    fail('message.send', 'text must be a string');
  }
  const sp = (params as Record<string, unknown>)['sessionPath'];
  if (typeof sp !== 'string' || !sp) {
    fail('message.send', 'requires a string sessionPath');
  }

  const rawInputs = (params as Record<string, unknown>)['inputs'];
  let inputs: ComposerInput[] = [];
  if (rawInputs !== undefined) {
    if (!Array.isArray(rawInputs)) {
      fail('message.send', 'inputs must be an array when provided');
    }
    inputs = rawInputs.map((input, index) => validateComposerInput(input, index));
    const aggregateImageBytes = inputs.reduce(
      (total, input) => total + (input.kind === 'imageBlob'
        ? Math.max(input.sizeBytes, decodedBase64ByteLength(input.dataBase64))
        : 0),
      0,
    );
    if (aggregateImageBytes > MAX_AGGREGATE_IMAGE_INPUT_BYTES) {
      fail('message.send', `image inputs exceed the ${MAX_AGGREGATE_IMAGE_INPUT_BYTES} byte aggregate limit`);
    }
  }

  if (!text.trim() && inputs.length === 0) {
    fail('message.send', 'requires non-empty text or at least one input');
  }

  const localId = (params as Record<string, unknown>)['localId'];
  if (localId !== undefined && typeof localId !== 'string') {
    fail('message.send', 'localId must be a string when provided');
  }

  return { text: text as string, sessionPath: sp as string, inputs, localId };
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
 * or an object whose `small`/`medium`/`frontier` fields are each a string
 * array. Missing bucket keys are allowed (treated as empty by the reducer).
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
  const out: SubagentBuckets = { small: [], medium: [], frontier: [] };
  for (const key of BUCKET_FIELD_KEYS) {
    const v = src[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((entry) => typeof entry === 'string')) {
      fail(method, `subagentBuckets.${key} must be an array of strings when provided`);
    }
    out[key] = [...(v as string[])];
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
function validateOptionalNestedAllowedBuckets(
  method: string,
  raw: unknown,
): NestedAllowedBuckets | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw) || Array.isArray(raw)) {
    fail(method, 'subagentNestedAllowedBuckets must be an object when provided');
  }
  const src = raw as Record<string, unknown>;
  const out: NestedAllowedBuckets = { ...ALL_NESTED_BUCKETS_ALLOWED };
  for (const key of BUCKET_FIELD_KEYS) {
    const v = src[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') {
      fail(method, `subagentNestedAllowedBuckets.${key} must be a boolean when provided`);
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
      if (typeof queueWait !== 'number' || !Number.isFinite(queueWait) || queueWait < 0) {
        fail(method, `providerConcurrency.${provider}.queueWaitSeconds must be a non-negative number when provided`);
      }
      cleaned.queueWaitSeconds = queueWait;
    }
    const headerWait = o['headerWaitSeconds'];
    if (headerWait !== undefined) {
      if (typeof headerWait !== 'number' || !Number.isFinite(headerWait) || headerWait < 0) {
        fail(method, `providerConcurrency.${provider}.headerWaitSeconds must be a non-negative number when provided`);
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
  const subagentNestedAllowedBuckets = validateOptionalNestedAllowedBuckets('runtimePrefs.set', (params as Record<string, unknown>)['subagentNestedAllowedBuckets']);
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
  return { providerToggles, ...(subagentProviderDefaults !== undefined ? { subagentProviderDefaults } : {}), ...(subagentProviderTogglesBySession !== undefined ? { subagentProviderTogglesBySession } : {}), extensionToggles, autonomousMode, subagentAlwaysParentModel, subagentRouteAroundSaturatedProviders, subagentFallbackOnProviderFailure, subagentMaxDepth, subagentMaxTreeSessions, subagentMaxInflight, bashWarmPoolSize, bashFastPath, bashShellPath, bashWarmupTimeoutMs, bashDefaultTimeout, subagentBuckets, subagentNestedAllowedBuckets, subagentDropTools, providerConcurrency, ...(historyCompaction !== undefined ? { historyCompaction } : {}) };
}

export interface OpenTabsSetParams {
  /** Open-tab summaries the host pushes so the `session_review` tool can list
   *  currently-open sessions without host state access. Stored verbatim into
   *  `process.env.PIE_OPEN_TABS` (JSON) for the tool to read. */
  tabs: unknown[];
}

/** Validate `openTabs.set` (host → backend). The tabs are open-tab summaries;
 *  we only require each be an object with a non-empty string `path` (the rest
 *  is passed through opaquely and stringified to env for the tool to parse). */
export function validateOpenTabsSet(params: unknown): OpenTabsSetParams {
  if (!isObj(params)) fail('openTabs.set', 'expected an object');
  const rawTabs = (params as Record<string, unknown>)['tabs'];
  if (!Array.isArray(rawTabs)) fail('openTabs.set', 'tabs must be an array');
  const tabs: unknown[] = [];
  for (let i = 0; i < rawTabs.length; i += 1) {
    const entry = rawTabs[i];
    if (!isObj(entry)) fail('openTabs.set', `tabs[${i}] must be an object`);
    const p = (entry as Record<string, unknown>)['path'];
    if (typeof p !== 'string' || !p) fail('openTabs.set', `tabs[${i}].path must be a non-empty string`);
    tabs.push(entry);
  }
  return { tabs };
}

export function validateSettingsSet(params: unknown): SettingsSetParams {
  if (!isObj(params)) fail('settings.set', 'expected an object');
  const out: SettingsSetParams = {};
  const sessionPath = (params as Record<string, unknown>)['sessionPath'];
  if (sessionPath !== undefined) {
    if (typeof sessionPath !== 'string' || !sessionPath) {
      fail('settings.set', 'sessionPath must be a non-empty string when provided');
    }
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
