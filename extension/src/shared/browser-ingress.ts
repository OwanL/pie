/**
 * Fail-closed browser ingress validation (browser server plan §5.3).
 *
 * The VS Code webview is a trusted renderer: `validateWebviewToHostMessage`
 * is audit-only and `MessageRouter` handlers perform ad-hoc per-message
 * checks. A loopback-served browser is NOT trusted the same way — a remote
 * web page must never drive the command-capable host through a victim
 * browser. This module therefore applies an exact, bounded schema AFTER JSON
 * parsing and BEFORE `MessageRouter`:
 *
 *   - unknown fields are rejected (not ignored);
 *   - wrong types are rejected;
 *   - every string/array length and nesting depth is bounded;
 *   - base64 is rejected everywhere except the explicitly enumerated
 *     `imageBlob`/`ComposerInputDraft` image fields, with strict base64
 *     decoding and the attachment bounds below;
 *   - `extensionUiResponse` payloads are validated against their closed
 *     schema rather than arbitrary JSON;
 *   - `fileBlob` (arbitrary browser `File`) variants are rejected until
 *     Milestone 4;
 *   - every application command carries a browser-minted `clientCommandId`.
 *
 * A failing message is never routed. The caller (browser renderer transport)
 * closes the socket after repeated violations (≥ 5 within a bounded window).
 *
 * This module is host-side only: it is never imported by the webview bundle.
 */

import type { WebviewToHostMessage } from './protocol';
import { validateWebviewToHostMessage, type ValidationResult } from './protocol-validation';
import { isRecord } from './type-guards';
import { utf8ByteLength } from './utf8';

export const BROWSER_INGRESS_LIMITS = {
  /** Complete JSON command/frame including all known image payloads and
   *  envelope overhead. Matches Pie's existing 32 MiB record boundary. */
  maxFrameBytes: 32 * 1024 * 1024,
  /** Decoded raw image bytes per image. */
  maxImageRawBytes: 10 * 1024 * 1024,
  /** Aggregate decoded raw image bytes per composer/message. */
  maxImageAggregateRawBytes: 20 * 1024 * 1024,
  /** Encoded strict base64 bound for one image: 4 × ceil(10 MiB / 3). */
  maxImageEncodedBytes: 4 * Math.ceil((10 * 1024 * 1024) / 3),
  /** Generic string bound (UTF-8 bytes). Base64 image fields are exempt. */
  maxStringUtf8Bytes: 1024 * 1024,
  /** Session/path-like fields. */
  maxPathUtf8Bytes: 4096,
  /** Generic array bound. */
  maxArrayItems: 4096,
  /** Generic object key bound. */
  maxObjectKeys: 128,
  /** Maximum JSON nesting depth. */
  maxDepth: 64,
  /** Browser-minted command id (UUID). */
  maxClientCommandIdBytes: 64,
  /** `log.data` is inherently open diagnostic metadata; bound it tightly. */
  maxLogDataBytes: 8192,
  maxLogDataDepth: 8,
  maxLogDataKeys: 16,
  /** Composer input list bound (editMessage). */
  maxComposerInputs: 64,
  /** System-prompt toggle list bound. */
  maxSystemPromptToggles: 256,
} as const;

const CLIENT_COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Message types that are NOT application commands: handshake, render
 *  evidence, log forwarding, browser lifecycle, and confirm responses. They
 *  carry no `clientCommandId`. */
const NON_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'refreshState',
  'requestSnapshot',
  'stateReceived',
  'appCommitted',
  'transcriptCommitted',
  'transcriptCommitBlocked',
  'paintObserved',
  'renderFailure',
  'log',
  'rendererVisibilityChanged',
  'rendererFocusChanged',
  'commandStatusRequest',
  'inlineConfirmResponse',
]);

/** Exact top-level key allowlist per message type. The optional wrapper
 *  fields `viewGeneration` (all types) and `clientCommandId` (application
 *  commands only) are appended programmatically. */
const MESSAGE_KEYS: Readonly<Record<string, readonly string[]>> = {
  ready: ['type', 'assetVersion', 'buildId'],
  refreshState: ['type', 'assetVersion', 'buildId'],
  requestSnapshot: ['type', 'assetVersion', 'buildId', 'sessionPath'],
  openFilePicker: ['type'],
  openFile: ['type', 'path'],
  addComposerInput: ['type', 'sessionPath', 'input'],
  removeComposerInput: ['type', 'sessionPath', 'inputId'],
  setComposerDraft: ['type', 'sessionPath', 'text'],
  send: ['type', 'sessionPath', 'text', 'localId'],
  editMessage: ['type', 'sessionPath', 'messageId', 'text', 'inputs', 'localId', 'queued'],
  interrupt: ['type', 'sessionPath'],
  compact: ['type', 'sessionPath'],
  clearQueue: ['type', 'sessionPath'],
  newSession: ['type'],
  openSession: ['type', 'sessionPath'],
  closeSession: ['type', 'sessionPath', 'interactionId'],
  requestDetail: ['type', 'sessionPath', 'ref'],
  'detail.subscribe': ['type', 'viewGeneration', 'detailKey', 'detailAttempt', 'address', 'cursor'],
  'detail.unsubscribe': ['type', 'viewGeneration', 'detailKey', 'detailAttempt', 'reason'],
  'detail.fetchPages': ['type', 'viewGeneration', 'detailKey', 'detailAttempt', 'ref'],
  duplicateSession: ['type', 'sessionPath'],
  retryCreateOperation: ['type', 'operationId'],
  moveSessionTab: ['type', 'sessionPath', 'fromIndex', 'toIndex'],
  togglePinTab: ['type', 'sessionPath'],
  groupPinnedTab: ['type', 'sourcePath', 'targetPath'],
  mergePinnedGroups: ['type', 'sourcePath', 'targetPath'],
  ungroupPinnedTab: ['type', 'sourcePath', 'toItemIndex'],
  dissolvePinnedGroup: ['type', 'sourcePath'],
  unpinPinnedGroup: ['type', 'sourcePath'],
  movePinnedItem: ['type', 'sourcePath', 'toItemIndex'],
  loadOlderTranscript: ['type', 'sessionPath'],
  loadNewerTranscript: ['type', 'sessionPath'],
  jumpToLatestTranscript: ['type', 'sessionPath'],
  startNewTask: ['type', 'sessionPath'],
  continueTask: ['type', 'sessionPath'],
  setModel: ['type', 'sessionPath', 'defaultModel', 'defaultProvider', 'defaultThinkingLevel'],
  setPrefs: ['type', 'prefs'],
  mcpListRequested: ['type'],
  mcpSetServerEnabled: ['type', 'name', 'enabled'],
  mcpSetServerEnabledForSession: ['type', 'sessionPath', 'name', 'enabled'],
  setPrivacyMode: ['type', 'sessionPath', 'enabled'],
  setPruningSettings: ['type', 'settings'],
  setToolResultPruningSettings: ['type', 'settings'],
  setSessionTitlesSettings: ['type', 'settings'],
  startEdit: ['type', 'sessionPath', 'messageId'],
  cancelEdit: ['type', 'sessionPath'],
  truncateAfter: ['type', 'sessionPath', 'messageId'],
  dismissNotice: ['type'],
  openFileDiff: ['type', 'sessionPath', 'filePath'],
  openFileInEditor: ['type', 'sessionPath', 'filePath'],
  revertFile: ['type', 'sessionPath', 'filePath'],
  setFileRead: ['type', 'sessionPath', 'filePath', 'read'],
  setSystemPromptToggles: ['type', 'sessionPath', 'disabledEntries'],
  stateReceived: ['type', 'payload'],
  appCommitted: ['type', 'payload'],
  transcriptCommitted: ['type', 'payload'],
  transcriptCommitBlocked: ['type', 'payload'],
  paintObserved: ['type', 'payload'],
  renderFailure: ['type', 'payload'],
  extensionUiResponse: ['type', 'sessionPath', 'response'],
  setFileChangesExpanded: ['type', 'sessionPath', 'expanded'],
  showLogs: ['type'],
  openSettings: ['type'],
  restartBackend: ['type'],
  retrySend: ['type', 'sessionPath', 'text', 'localId', 'disablePruning'],
  log: ['type', 'level', 'scope', 'message', 'data'],
  rendererVisibilityChanged: ['type', 'visible'],
  rendererFocusChanged: ['type', 'focused'],
  commandStatusRequest: ['type', 'clientCommandId'],
  inlineConfirmResponse: ['type', 'confirmId', 'confirmed'],
};

/** Exact key allowlist for a `ComposerInputDraft`/`ComposerInput` image
 *  variant. `fileBlob` is rejected before Milestone 4. Drafts (addComposerInput)
 *  are `Omit<..., 'id'>` and reject a client-supplied `id`; host-owned inputs
 *  echoed back through `editMessage.inputs` may carry one. `width`/`height`
 *  are the optional post-compression dimensions the shared UI adds. */
const IMAGE_BLOB_KEYS: readonly string[] = ['kind', 'id', 'mimeType', 'name', 'sizeBytes', 'dataBase64', 'width', 'height', 'source'];
const FILESYSTEM_PATH_REF_KEYS: readonly string[] = ['kind', 'id', 'path', 'name', 'source'];
const IMAGE_BLOB_DRAFT_KEYS: readonly string[] = ['kind', 'mimeType', 'name', 'sizeBytes', 'dataBase64', 'width', 'height', 'source'];
const FILESYSTEM_PATH_REF_DRAFT_KEYS: readonly string[] = ['kind', 'path', 'name', 'source'];

/** Optional post-compression pixel dimensions: non-negative safe integers. */
function isBoundedDimension(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 16384;
}

/** Exact key allowlist for `requestDetail.ref`. */
const DETAIL_REF_KEYS: readonly string[] = [
  'key', 'kind', 'source', 'sessionPath', 'messageId', 'summary', 'available',
  'sizeBytes', 'toolCallId', 'executionId', 'partIndex', 'sourceRevision',
  'childCount', 'lineCount',
];

/** Closed schema for `extensionUiResponse.response`. */
const EXTENSION_UI_RESPONSE_KEYS: readonly string[] = ['id', 'value', 'confirmed', 'cancelled'];

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStrictBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/u.test(value);
}

/** Exact decoded byte length of a strict-base64 string (no Buffer needed). */
function decodedBase64Length(encoded: string): number {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}

/** Only the allowlisted imageBlob `dataBase64` locations are exempt from the
 *  generic string bound; the image-specific checks bound them exactly. A
 *  `dataBase64` key anywhere else (e.g. smuggled inside prefs or extension-UI
 *  payloads) stays under the generic string bound. The walk is type-agnostic,
 *  so the paths are the raw tree locations (`addComposerInput.input` and
 *  `editMessage.inputs[i]`); any other message carrying a top-level
 *  `input`/`inputs` key is still rejected by the exact-key allowlist. */
function isAllowlistedImageBase64Path(path: string): boolean {
  return path === 'message.input.dataBase64'
    || /^message\.inputs\[\d+\]\.dataBase64$/.test(path);
}

/**
 * Walk the parsed JSON tree once, enforcing JSON-safety (no `undefined`,
 * functions, BigInt, class instances, or cycles), nesting depth, string
 * bounds, array bounds, and object key bounds. Only the allowlisted
 * imageBlob `dataBase64` strings are exempt from the generic string bound.
 * Path-like fields (`sessionPath`, `path`, `filePath`, `sourcePath`,
 * `targetPath`) use the tighter 4 KiB bound.
 */
function walkJson(value: unknown, depth: number, path: string, maxDepth: number = BROWSER_INGRESS_LIMITS.maxDepth): string | null {
  if (depth > maxDepth) return 'nesting depth exceeds bound';
  if (value === null) return null;
  switch (typeof value) {
    case 'string': {
      if (isAllowlistedImageBase64Path(path)) return null;
      const segment = path.slice(path.lastIndexOf('.') + 1);
      const limit = segment === 'sessionPath' || segment === 'path' || segment === 'filePath'
        || segment === 'sourcePath' || segment === 'targetPath'
        ? BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes
        : BROWSER_INGRESS_LIMITS.maxStringUtf8Bytes;
      if (utf8ByteLength(value) > limit) {
        return `string exceeds ${limit} bytes at ${path}`;
      }
      return null;
    }
    case 'number':
      return Number.isFinite(value) ? null : `non-finite number at ${path}`;
    case 'boolean':
      return null;
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length > BROWSER_INGRESS_LIMITS.maxArrayItems) {
          return `array exceeds ${BROWSER_INGRESS_LIMITS.maxArrayItems} items at ${path}`;
        }
        for (let index = 0; index < value.length; index += 1) {
          const problem = walkJson(value[index], depth + 1, `${path}[${index}]`, maxDepth);
          if (problem !== null) return problem;
        }
        return null;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > BROWSER_INGRESS_LIMITS.maxObjectKeys) {
        return `object exceeds ${BROWSER_INGRESS_LIMITS.maxObjectKeys} keys at ${path}`;
      }
      for (const key of keys) {
        const problem = walkJson(record[key], depth + 1, `${path}.${key}`, maxDepth);
        if (problem !== null) return problem;
      }
      return null;
    }
    default:
      return `non-JSON value at ${path}`;
  }
}

function isClientCommandId(value: unknown): value is string {
  return typeof value === 'string'
    && CLIENT_COMMAND_ID_PATTERN.test(value)
    && utf8ByteLength(value) <= BROWSER_INGRESS_LIMITS.maxClientCommandIdBytes;
}

function isApplicationCommand(type: string): boolean {
  return !NON_COMMAND_TYPES.has(type);
}

/** Whether a message type is an application command under the browser
 *  fail-closed policy (carries a browser-minted `clientCommandId`, gets
 *  exactly one host decision + one `commandAck` emission). Exported for the
 *  host-side command-decision gate. */
export function isBrowserApplicationCommand(type: string): boolean {
  return isApplicationCommand(type);
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && utf8ByteLength(value) <= maxBytes;
}

/** Validate one composer input (draft or host-owned) under the browser
 *  base64 policy. Returns the decoded image bytes for aggregate accounting.
 *  `allowId` is true only for host-owned inputs echoed through
 *  `editMessage.inputs`; drafts reject a client-supplied `id`. */
function validateComposerInputForBrowser(
  input: unknown,
  path: string,
  allowId: boolean,
): { ok: true; decodedBytes: number } | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: `${path}: invalid input` };
  const kind = input.kind;
  if (kind === 'fileBlob') {
    return { ok: false, reason: `${path}: fileBlob rejected before Milestone 4` };
  }
  if (kind === 'filesystemPathRef') {
    if (!hasOnlyKeys(input, allowId ? FILESYSTEM_PATH_REF_KEYS : FILESYSTEM_PATH_REF_DRAFT_KEYS)) {
      return { ok: false, reason: `${path}: unknown fields in filesystemPathRef` };
    }
    if (!boundedString(input.path, BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes)) {
      return { ok: false, reason: `${path}: invalid or oversized path` };
    }
    if (!boundedString(input.name, BROWSER_INGRESS_LIMITS.maxStringUtf8Bytes)) {
      return { ok: false, reason: `${path}: invalid or oversized name` };
    }
    if (input.source !== 'picker' && input.source !== 'drop') {
      return { ok: false, reason: `${path}: invalid source` };
    }
    return { ok: true, decodedBytes: 0 };
  }
  if (kind === 'imageBlob') {
    if (!hasOnlyKeys(input, allowId ? IMAGE_BLOB_KEYS : IMAGE_BLOB_DRAFT_KEYS)) {
      return { ok: false, reason: `${path}: unknown fields in imageBlob` };
    }
    if (!boundedString(input.mimeType, 256)) {
      return { ok: false, reason: `${path}: invalid or oversized mimeType` };
    }
    if (!boundedString(input.name, BROWSER_INGRESS_LIMITS.maxStringUtf8Bytes)) {
      return { ok: false, reason: `${path}: invalid or oversized name` };
    }
    if (input.source !== 'paste' && input.source !== 'drop') {
      return { ok: false, reason: `${path}: invalid source` };
    }
    if (allowId && input.id !== undefined && !boundedString(input.id, 256)) {
      return { ok: false, reason: `${path}: invalid id` };
    }
    if (input.width !== undefined && !isBoundedDimension(input.width)) {
      return { ok: false, reason: `${path}: invalid width` };
    }
    if (input.height !== undefined && !isBoundedDimension(input.height)) {
      return { ok: false, reason: `${path}: invalid height` };
    }
    const encoded = input.dataBase64;
    if (typeof encoded !== 'string' || !isStrictBase64(encoded)) {
      return { ok: false, reason: `${path}: dataBase64 is not strict base64` };
    }
    if (encoded.length > BROWSER_INGRESS_LIMITS.maxImageEncodedBytes) {
      return { ok: false, reason: `${path}: encoded image exceeds bound` };
    }
    const decoded = decodedBase64Length(encoded);
    if (decoded > BROWSER_INGRESS_LIMITS.maxImageRawBytes) {
      return { ok: false, reason: `${path}: decoded image exceeds 10 MiB` };
    }
    if (input.sizeBytes !== decoded) {
      return { ok: false, reason: `${path}: sizeBytes does not match decoded length` };
    }
    return { ok: true, decodedBytes: decoded };
  }
  return { ok: false, reason: `${path}: unknown input kind` };
}

function validateAddComposerInput(value: Record<string, unknown>): ValidationResult<WebviewToHostMessage> {
  if (!boundedString(value.sessionPath, BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes)) {
    return fail('addComposerInput: invalid or oversized sessionPath');
  }
  const input = validateComposerInputForBrowser(value.input, 'addComposerInput.input', false);
  if (!input.ok) return fail(input.reason);
  return { ok: true, value: value as unknown as WebviewToHostMessage };
}

function validateEditMessageInputs(value: Record<string, unknown>): ValidationResult<WebviewToHostMessage> {
  if (!boundedString(value.sessionPath, BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes)) {
    return fail('editMessage: invalid or oversized sessionPath');
  }
  if (!boundedString(value.messageId, 256)) return fail('editMessage: invalid or oversized messageId');
  if (value.inputs === undefined) return { ok: true, value: value as unknown as WebviewToHostMessage };
  if (!Array.isArray(value.inputs)) return fail('editMessage: `inputs` must be an array');
  if (value.inputs.length > BROWSER_INGRESS_LIMITS.maxComposerInputs) {
    return fail('editMessage: too many composer inputs');
  }
  let aggregate = 0;
  for (let index = 0; index < value.inputs.length; index += 1) {
    const input = validateComposerInputForBrowser(value.inputs[index], `editMessage.inputs[${index}]`, true);
    if (!input.ok) return fail(input.reason);
    aggregate += input.decodedBytes;
  }
  if (aggregate > BROWSER_INGRESS_LIMITS.maxImageAggregateRawBytes) {
    return fail('editMessage: aggregate image bytes exceed 20 MiB');
  }
  return { ok: true, value: value as unknown as WebviewToHostMessage };
}

function validateExtensionUiResponse(value: Record<string, unknown>): ValidationResult<WebviewToHostMessage> {
  if (!boundedString(value.sessionPath, BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes)) {
    return fail('extensionUiResponse: invalid or oversized sessionPath');
  }
  const response = value.response;
  if (!isRecord(response)) return fail('extensionUiResponse: missing `response` object');
  if (!hasOnlyKeys(response, EXTENSION_UI_RESPONSE_KEYS)) {
    return fail('extensionUiResponse: unknown fields in `response`');
  }
  if (!boundedString(response.id, 256) || response.id.length === 0) {
    return fail('extensionUiResponse: invalid `response.id`');
  }
  if (response.value !== undefined && !boundedString(response.value, BROWSER_INGRESS_LIMITS.maxStringUtf8Bytes)) {
    return fail('extensionUiResponse: invalid or oversized `response.value`');
  }
  if (response.confirmed !== undefined && typeof response.confirmed !== 'boolean') {
    return fail('extensionUiResponse: `response.confirmed` must be a boolean');
  }
  if (response.cancelled !== undefined && typeof response.cancelled !== 'boolean') {
    return fail('extensionUiResponse: `response.cancelled` must be a boolean');
  }
  return { ok: true, value: value as unknown as WebviewToHostMessage };
}

function validateRequestDetailRef(value: Record<string, unknown>): ValidationResult<WebviewToHostMessage> {
  if (!boundedString(value.sessionPath, BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes)) {
    return fail('requestDetail: invalid or oversized sessionPath');
  }
  const ref = value.ref;
  if (!isRecord(ref)) return fail('requestDetail: invalid `ref`');
  if (!hasOnlyKeys(ref, DETAIL_REF_KEYS)) return fail('requestDetail: unknown fields in `ref`');
  if (!boundedString(ref.key, 512) || ref.key.length === 0) return fail('requestDetail: invalid `ref.key`');
  if (!boundedString(ref.sessionPath, BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes)) {
    return fail('requestDetail: invalid `ref.sessionPath`');
  }
  if (!boundedString(ref.messageId, 256)) return fail('requestDetail: invalid `ref.messageId`');
  if (!boundedString(ref.summary, BROWSER_INGRESS_LIMITS.maxStringUtf8Bytes)) {
    return fail('requestDetail: invalid `ref.summary`');
  }
  if (ref.toolCallId !== undefined && !boundedString(ref.toolCallId, 256)) {
    return fail('requestDetail: invalid `ref.toolCallId`');
  }
  if (ref.executionId !== undefined && !boundedString(ref.executionId, 256)) {
    return fail('requestDetail: invalid `ref.executionId`');
  }
  if (ref.childCount !== undefined
    && (!Number.isSafeInteger(ref.childCount) || (ref.childCount as number) < 0)) {
    return fail('requestDetail: invalid `ref.childCount`');
  }
  if (ref.lineCount !== undefined
    && (!Number.isSafeInteger(ref.lineCount) || (ref.lineCount as number) < 0)) {
    return fail('requestDetail: invalid `ref.lineCount`');
  }
  return { ok: true, value: value as unknown as WebviewToHostMessage };
}

function validateLogData(value: Record<string, unknown>): ValidationResult<WebviewToHostMessage> {
  if (value.data === undefined) return { ok: true, value: value as unknown as WebviewToHostMessage };
  if (!isRecord(value.data)) return fail('log: `data` must be an object');
  const keys = Object.keys(value.data);
  if (keys.length > BROWSER_INGRESS_LIMITS.maxLogDataKeys) return fail('log: `data` has too many keys');
  const problem = walkJson(value.data, 1, 'log.data', BROWSER_INGRESS_LIMITS.maxLogDataDepth);
  if (problem !== null) return fail(`log: ${problem}`);
  let bytes = 0;
  try {
    bytes = utf8ByteLength(JSON.stringify(value.data));
  } catch {
    return fail('log: `data` is not serializable');
  }
  if (bytes > BROWSER_INGRESS_LIMITS.maxLogDataBytes) return fail('log: `data` exceeds 8 KiB');
  return { ok: true, value: value as unknown as WebviewToHostMessage };
}

function validateSystemPromptToggles(value: Record<string, unknown>): ValidationResult<WebviewToHostMessage> {
  if (!boundedString(value.sessionPath, BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes)) {
    return fail('setSystemPromptToggles: invalid or oversized sessionPath');
  }
  if (!Array.isArray(value.disabledEntries)) return fail('setSystemPromptToggles: missing `disabledEntries` array');
  if (value.disabledEntries.length > BROWSER_INGRESS_LIMITS.maxSystemPromptToggles) {
    return fail('setSystemPromptToggles: too many entries');
  }
  for (const entry of value.disabledEntries) {
    if (!boundedString(entry, 512)) return fail('setSystemPromptToggles: invalid entry');
  }
  return { ok: true, value: value as unknown as WebviewToHostMessage };
}

function validateCommandStatusRequest(value: Record<string, unknown>): ValidationResult<WebviewToHostMessage> {
  if (!isClientCommandId(value.clientCommandId)) return fail('commandStatusRequest: invalid clientCommandId');
  return { ok: true, value: value as unknown as WebviewToHostMessage };
}

function validateInlineConfirmResponse(value: Record<string, unknown>): ValidationResult<WebviewToHostMessage> {
  if (!boundedString(value.confirmId, 64) || value.confirmId.length === 0) {
    return fail('inlineConfirmResponse: invalid confirmId');
  }
  if (typeof value.confirmed !== 'boolean') {
    return fail('inlineConfirmResponse: `confirmed` must be a boolean');
  }
  return { ok: true, value: value as unknown as WebviewToHostMessage };
}

/**
 * Fail-closed validation of one browser→host message. `frameBytes` is the
 * complete raw WebSocket frame size measured by the transport (including
 * envelope overhead); the validator enforces the 32 MiB record limit on it.
 */
export function validateBrowserToHostMessage(
  value: unknown,
  frameBytes: number,
): ValidationResult<WebviewToHostMessage> {
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 0) return fail('invalid frameBytes');
  if (frameBytes > BROWSER_INGRESS_LIMITS.maxFrameBytes) {
    return fail('frame exceeds 32 MiB transport record limit');
  }
  if (!isRecord(value)) return fail('not an object');
  const type = value.type;
  if (typeof type !== 'string') return fail('missing string `type`');

  // Type-specific field validation first (shared with the trusted webview
  // path), then the browser-only bounds walk, then exact-key closure.
  const base = validateWebviewToHostMessage(value);
  if (!base.ok) return base;

  const walkProblem = walkJson(value, 1, 'message');
  if (walkProblem !== null) return fail(walkProblem);

  // Exact top-level key allowlist: unknown fields are rejected, not ignored.
  const allowed = MESSAGE_KEYS[type];
  if (!allowed) return fail(`unknown message type: ${type}`);
  const command = isApplicationCommand(type);
  const allowedKeys = command
    ? [...allowed, 'viewGeneration', 'clientCommandId']
    : [...allowed, 'viewGeneration'];
  if (!hasOnlyKeys(value, allowedKeys)) return fail(`${type}: unknown fields`);

  // Command identity: every application command carries a browser-minted
  // clientCommandId; lifecycle/handshake/evidence messages never do. The one
  // exception is `commandStatusRequest`, which carries the id it queries and
  // must satisfy the same UUID policy.
  if (command) {
    if (!isClientCommandId(value.clientCommandId)) {
      return fail(`${type}: missing or invalid clientCommandId`);
    }
  } else if (value.clientCommandId !== undefined) {
    if (type !== 'commandStatusRequest') {
      return fail(`${type}: clientCommandId not allowed`);
    }
    if (!isClientCommandId(value.clientCommandId)) {
      return fail(`${type}: invalid clientCommandId`);
    }
  }

  // Per-type closed-schema checks beyond the shared validator.
  switch (type) {
    case 'addComposerInput':
      return validateAddComposerInput(value);
    case 'editMessage':
      return validateEditMessageInputs(value);
    case 'extensionUiResponse':
      return validateExtensionUiResponse(value);
    case 'requestDetail':
      return validateRequestDetailRef(value);
    case 'log':
      return validateLogData(value);
    case 'setSystemPromptToggles':
      return validateSystemPromptToggles(value);
    case 'commandStatusRequest':
      return validateCommandStatusRequest(value);
    case 'inlineConfirmResponse':
      return validateInlineConfirmResponse(value);
    default:
      return { ok: true, value: value as unknown as WebviewToHostMessage };
  }
}
