import type { ComposerInput, ExtensionUIResponsePayload, FilesystemPathComposerInput, ImageBlobComposerInput, ModelSettings, NestedAllowedBuckets, SubagentBuckets, ThinkingLevel, TranscriptMode, TranscriptPageDirection } from '../shared/protocol';
import { ALL_NESTED_BUCKETS_ALLOWED } from '../shared/protocol';
import { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_INPUT_BYTES } from '../shared/image-constraints';
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

export interface SessionPathOptionalParams {
  sessionPath?: string;
}

export interface MessageSendParams {
  sessionPath: string;
  text: string;
  inputs: ComposerInput[];
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

export function validateSessionPathOptional(params: unknown): SessionPathOptionalParams {
  if (params === undefined || params === null) return {};
  if (!isObj(params)) return {};
  const sp = params['sessionPath'];
  if (sp !== undefined && typeof sp !== 'string') {
    fail('<rpc>', 'sessionPath must be a string when provided');
  }
  return { sessionPath: sp as string | undefined };
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
  }

  if (!text.trim() && inputs.length === 0) {
    fail('message.send', 'requires non-empty text or at least one input');
  }

  return { text: text as string, sessionPath: sp as string, inputs };
}

export interface RuntimePrefsSetParams {
  providerToggles: Record<string, boolean>;
  extensionToggles: Record<string, boolean>;
  subagentAlwaysParentModel?: boolean;
  subagentMaxDepth?: number;
  subagentMaxTreeSessions?: number;
  subagentMaxInflight?: number;
  subagentMaxConcurrency?: number;
  subagentMaxParallelTasks?: number;
  bashWarmPoolSize?: number;
  bashFastPath?: boolean;
  bashShellPath?: string;
  /** Warmup wait (ms) for a bash process to print the ready marker. 0 = built-in
   *  default. Mirrored via PIE_BASH_WARMUP_TIMEOUT_MS. Range [0, 60000]. */
  bashWarmupTimeoutMs?: number;
  /** Acquire wait (ms) for a ready worker when the pool is empty. 0 = built-in
   *  default. Mirrored via PIE_BASH_ACQUIRE_TIMEOUT_MS. Range [0, 60000]. */
  bashAcquireTimeoutMs?: number;
  /** Default timeout (seconds) for bash commands that don't specify one.
   *  Range [1, 600]. Mirrored via PIE_BASH_DEFAULT_TIMEOUT. */
  bashDefaultTimeout?: number;
  subagentBuckets?: SubagentBuckets;
  subagentNestedAllowedBuckets?: NestedAllowedBuckets;
  subagentDropTools?: string[];
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
  const rawAlwaysParent = (params as Record<string, unknown>)['subagentAlwaysParentModel'];
  const subagentAlwaysParentModel =
    rawAlwaysParent === undefined ? undefined : typeof rawAlwaysParent === 'boolean' ? rawAlwaysParent : fail('runtimePrefs.set', 'subagentAlwaysParentModel must be a boolean when provided');
  const subagentMaxDepth = validateOptionalInt('runtimePrefs.set', 'subagentMaxDepth', (params as Record<string, unknown>)['subagentMaxDepth'], 0, 8);
  const subagentMaxTreeSessions = validateOptionalInt('runtimePrefs.set', 'subagentMaxTreeSessions', (params as Record<string, unknown>)['subagentMaxTreeSessions'], 5, 200);
  const subagentBuckets = validateOptionalSubagentBuckets('runtimePrefs.set', (params as Record<string, unknown>)['subagentBuckets']);
  const subagentNestedAllowedBuckets = validateOptionalNestedAllowedBuckets('runtimePrefs.set', (params as Record<string, unknown>)['subagentNestedAllowedBuckets']);
  const rawSubagentDropTools = (params as Record<string, unknown>)['subagentDropTools'];
  const subagentDropTools = rawSubagentDropTools === undefined ? undefined : Array.isArray(rawSubagentDropTools) && rawSubagentDropTools.every((entry) => typeof entry === 'string') ? [...(rawSubagentDropTools as string[])] : fail('runtimePrefs.set', 'subagentDropTools must be an array of strings when provided');
  const subagentMaxInflight = validateOptionalInt('runtimePrefs.set', 'subagentMaxInflight', (params as Record<string, unknown>)['subagentMaxInflight'], 1, 16);
  const subagentMaxConcurrency = validateOptionalInt('runtimePrefs.set', 'subagentMaxConcurrency', (params as Record<string, unknown>)['subagentMaxConcurrency'], 1, 16);
  const subagentMaxParallelTasks = validateOptionalInt('runtimePrefs.set', 'subagentMaxParallelTasks', (params as Record<string, unknown>)['subagentMaxParallelTasks'], 1, 16);
  const bashWarmPoolSize = validateOptionalInt('runtimePrefs.set', 'bashWarmPoolSize', (params as Record<string, unknown>)['bashWarmPoolSize'], 0, 8);
  const rawBashFastPath = (params as Record<string, unknown>)['bashFastPath'];
  const bashFastPath = rawBashFastPath === undefined ? undefined : typeof rawBashFastPath === 'boolean' ? rawBashFastPath : fail('runtimePrefs.set', 'bashFastPath must be a boolean when provided');
  const rawBashShellPath = (params as Record<string, unknown>)['bashShellPath'];
  const bashShellPath = rawBashShellPath === undefined ? undefined : typeof rawBashShellPath === 'string' ? rawBashShellPath : fail('runtimePrefs.set', 'bashShellPath must be a string when provided');
  const bashWarmupTimeoutMs = validateOptionalInt('runtimePrefs.set', 'bashWarmupTimeoutMs', (params as Record<string, unknown>)['bashWarmupTimeoutMs'], 0, 60000);
  const bashAcquireTimeoutMs = validateOptionalInt('runtimePrefs.set', 'bashAcquireTimeoutMs', (params as Record<string, unknown>)['bashAcquireTimeoutMs'], 0, 60000);
  const bashDefaultTimeout = validateOptionalInt('runtimePrefs.set', 'bashDefaultTimeout', (params as Record<string, unknown>)['bashDefaultTimeout'], 1, 600);
  return { providerToggles, extensionToggles, subagentAlwaysParentModel, subagentMaxDepth, subagentMaxTreeSessions, subagentMaxInflight, subagentMaxConcurrency, subagentMaxParallelTasks, bashWarmPoolSize, bashFastPath, bashShellPath, bashWarmupTimeoutMs, bashAcquireTimeoutMs, bashDefaultTimeout, subagentBuckets, subagentNestedAllowedBuckets, subagentDropTools };
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
