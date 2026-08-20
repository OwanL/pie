/**
 * Runtime validators for the host ↔ webview protocol.
 *
 * These guards are intentionally **hand-rolled and dependency-free** so they
 * can live in `shared/` (consumed by both backend and host) without pulling a
 * schema library into the webview bundle. They mirror the static types in
 * `./protocol.ts` and exist to catch protocol drift at the trust boundaries:
 *
 *   - Webview → host messages arrive as untyped JSON over `postMessage`.
 *     Bugs in the webview or a future fuzz/attacker could send malformed
 *     envelopes; the host should detect and log this rather than implicitly
 *     trusting `as WebviewToHostMessage`.
 *   - Backend ↔ host messages arrive as JSON-line envelopes; the existing
 *     `isEventEnvelope` / `isResponseEnvelope` checks only validate the outer
 *     shape, not the payload kind.
 *
 * Today the only consumer is `SidebarViewProvider` (audit-only logging — does
 * **not** drop messages). Tighten to rejection once the audit log is clean.
 */

import type {
  ChatPrefs,
  ComposerInputDraft,
  PruningMode,
  PruningSettings,
  ToolResultPruningSettings,
  AppCommittedPayload,
  PaintObservedPayload,
  RenderFailurePayload,
  StateReceivedPayload,
  TranscriptCommittedPayload,
  TranscriptCommitBlockedPayload,
  ThinkingLevel,
  WebviewToHostMessage,
  HostDetailRoute,
  HostToWebviewMessage,
} from './protocol';
import { isThinkingLevel, THINKING_LEVEL_SET } from './thinking-level.js';
import {
  COMPOSER_INITIAL_ROWS_MAX,
  COMPOSER_INITIAL_ROWS_MIN,
  UI_PATH_PARENT_DEPTH_MAX,
  UI_PATH_PARENT_DEPTH_MIN,
} from './protocol/settings.js';
import {
  isDetailCursor,
  isDetailPageRef,
  isLiveSubagentDetailAddress,
  type DetailChecksum,
  type DetailPagePayload,
  type DetailRebaseReason,
} from './protocol/subagent-detail.js';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalNonNegativeSafeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateRenderEvidenceBase(
  value: unknown,
): value is Record<string, unknown> & { revision: number; viewGeneration: number } {
  return isObject(value)
    && isNonNegativeSafeInteger(value.revision)
    && isNonNegativeSafeInteger(value.viewGeneration);
}

function validateStateReceivedPayload(value: unknown): value is StateReceivedPayload {
  return validateRenderEvidenceBase(value)
    && hasOnlyKeys(value, ['revision', 'viewGeneration', 'snapshotBytes'])
    && isNonNegativeSafeInteger(value.snapshotBytes);
}

function validateAppCommittedPayload(value: unknown): value is AppCommittedPayload {
  return validateRenderEvidenceBase(value)
    && hasOnlyKeys(value, ['revision', 'viewGeneration', 'surface'])
    && (value.surface === 'app'
      || value.surface === 'loading'
      || value.surface === 'empty'
      || value.surface === 'transcript-suspense'
      || value.surface === 'transcript');
}

function validateTranscriptCommittedPayload(
  value: unknown,
): value is TranscriptCommittedPayload & Record<string, unknown> {
  return validateRenderEvidenceBase(value)
    && hasOnlyKeys(value, ['revision', 'viewGeneration', 'identity', 'mountGeneration', 'evidence'])
    && typeof value.identity === 'string'
    && value.identity.length > 0
    && value.identity.length <= 256
    && isNonNegativeSafeInteger(value.mountGeneration)
    && (value.evidence === 'displayed' || value.evidence === 'offscreen' || value.evidence === 'no-transcript');
}

function validateTranscriptCommitBlockedPayload(value: unknown): value is TranscriptCommitBlockedPayload {
  return validateRenderEvidenceBase(value)
    && hasOnlyKeys(value, ['revision', 'viewGeneration', 'reason'])
    && (value.reason === 'window_mismatch'
      || value.reason === 'structure_mismatch'
      || value.reason === 'leaf_missing'
      || value.reason === 'leaf_mismatch');
}

function validatePaintObservedPayload(value: unknown): value is PaintObservedPayload {
  return validateRenderEvidenceBase(value)
    && hasOnlyKeys(value, ['revision', 'viewGeneration', 'identity', 'mountGeneration', 'evidence', 'latencyMs'])
    && typeof value.identity === 'string'
    && value.identity.length > 0
    && value.identity.length <= 256
    && isNonNegativeSafeInteger(value.mountGeneration)
    && (value.evidence === 'displayed' || value.evidence === 'offscreen' || value.evidence === 'no-transcript')
    && isFiniteNumber(value.latencyMs)
    && value.latencyMs >= 0;
}

function validateRenderFailurePayload(value: unknown): value is RenderFailurePayload {
  return isObject(value)
    && hasOnlyKeys(value, ['viewGeneration', 'revision', 'surface', 'classification'])
    && isNonNegativeSafeInteger(value.viewGeneration)
    && (value.revision === null || isNonNegativeSafeInteger(value.revision))
    && (value.surface === 'app' || value.surface === 'transcript' || value.surface === 'transcript-suspense' || value.surface === 'unknown')
    && (value.classification === 'component_error'
      || value.classification === 'uncaught_error'
      || value.classification === 'unhandled_rejection'
      || value.classification === 'unknown');
}

function validateComposerInputDraft(value: unknown): value is ComposerInputDraft {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case 'filesystemPathRef':
      return (
        isString(value.path)
        && isString(value.name)
        && (value.source === 'picker' || value.source === 'drop')
      );
    case 'imageBlob':
      return (
        isString(value.mimeType)
        && isString(value.name)
        && isFiniteNumber(value.sizeBytes)
        && isString(value.dataBase64)
        && (value.source === 'paste' || value.source === 'drop')
      );
    case 'fileBlob':
      return (
        isString(value.mimeType)
        && isString(value.name)
        && isFiniteNumber(value.sizeBytes)
        && isString(value.dataBase64)
        && (value.source === 'paste' || value.source === 'drop')
      );
    default:
      return false;
  }
}

function isStringBooleanRecord(value: unknown): value is Record<string, boolean> {
  if (!isObject(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== 'boolean') return false;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/** A valid explicit model/reasoning assignment for a subagent bucket. */
function isSubagentBucketAssignment(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ['model', 'thinkingLevel'])
    && typeof value.model === 'string'
    && value.model.trim().length > 0
    && isThinkingLevel(value.thinkingLevel);
}

/** A valid `SubagentBuckets` patch: object with optional `small`/`medium`/
 * `frontier` assignment-array fields. Extra bucket keys are tolerated (the
 * reducer normalizes them away), but legacy string entries are rejected. */
function isSubagentBucketsPatch(value: unknown): boolean {
  if (!isObject(value)) return false;
  for (const key of ['small', 'medium', 'frontier'] as const) {
    const v = value[key];
    if (v !== undefined && (!Array.isArray(v) || !v.every(isSubagentBucketAssignment))) return false;
  }
  return true;
}

/** A partial {@link NestedAllowedBuckets} patch: an object whose present
 *  `small`/`medium`/`frontier` keys are each a boolean (missing keys are allowed
 *  and normalized to `true` by the reducer). */
function isNestedAllowedBucketsPatch(value: unknown): boolean {
  if (!isObject(value)) return false;
  for (const key of ['small', 'medium', 'frontier'] as const) {
    const v = value[key];
    if (v !== undefined && typeof v !== 'boolean') return false;
  }
  return true;
}

function isHistoryCompactionModelProfile(value: unknown): boolean {
  if (!isObject(value)) return false;
  const allowedKeys = ['softThreshold', 'hardThreshold', 'keepRecentTokens'];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return false;
  for (const key of allowedKeys) {
    const n = value[key];
    if (!isNonNegativeSafeInteger(n)) return false;
  }
  const soft = value.softThreshold as number;
  const hard = value.hardThreshold as number;
  const keep = value.keepRecentTokens as number;
  return keep < soft && soft < hard && soft >= 1_000 && hard <= 10_000_000;
}

function isHistoryCompactionSettings(value: unknown): boolean {
  if (!isObject(value)) return false;
  const allowedKeys = [
    'enabled',
    'thresholdMode',
    'softThreshold',
    'hardThreshold',
    'keepRecentTokens',
    'summaryInstructions',
    'summaryThinkingLevel',
    'summaryModel',
    'modelProfiles',
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return false;
  if (typeof value.enabled !== 'boolean') return false;
  if (value.thresholdMode !== 'percentage' && value.thresholdMode !== 'tokens') return false;
  if (!isFiniteNumber(value.softThreshold) || !isFiniteNumber(value.hardThreshold)) return false;
  const minimum = value.thresholdMode === 'tokens' ? 1_000 : 1;
  const maximum = value.thresholdMode === 'tokens' ? 10_000_000 : 99;
  if (value.softThreshold < minimum
    || value.hardThreshold > maximum
    || value.softThreshold >= value.hardThreshold) {
    return false;
  }
  if (value.keepRecentTokens !== undefined && !isNonNegativeSafeInteger(value.keepRecentTokens)) return false;
  if (value.keepRecentTokens !== undefined && value.keepRecentTokens > 10_000_000) return false;
  if (value.thresholdMode === 'tokens'
    && value.keepRecentTokens !== undefined
    && value.keepRecentTokens >= value.softThreshold) return false;
  if (value.summaryInstructions !== undefined && (
    typeof value.summaryInstructions !== 'string'
    || value.summaryInstructions.length > 4_000
  )) {
    return false;
  }
  if (value.summaryThinkingLevel !== undefined
    && value.summaryThinkingLevel !== 'inherit'
    && !THINKING_LEVEL_SET.has(value.summaryThinkingLevel as ThinkingLevel)) {
    return false;
  }
  if (value.summaryModel !== undefined && value.summaryModel !== null) {
    if (!isObject(value.summaryModel)) return false;
    const model = value.summaryModel as Record<string, unknown>;
    if (Object.keys(model).some((key) => !['provider', 'id'].includes(key))) return false;
    if (typeof model.provider !== 'string' || !model.provider) return false;
    if (typeof model.id !== 'string' || !model.id) return false;
  }
  if (value.modelProfiles !== undefined) {
    if (!isObject(value.modelProfiles)) return false;
    const profiles = value.modelProfiles as Record<string, unknown>;
    for (const entry of Object.values(profiles)) {
      if (!isHistoryCompactionModelProfile(entry)) return false;
    }
  }
  return true;
}

function validateChatPrefsPatch(value: unknown): value is Partial<ChatPrefs> {
  if (!isObject(value)) return false;
  const booleanKeys: Array<keyof ChatPrefs> = [
    'autoExpandReasoning',
    'autoExpandToolCalls',
    'autoExpandSubagentCalls',
    'suppressCompletionNotifications',
    'showPruningMessages',
    'autonomousMode',
    'subagentAlwaysParentModel',
    'subagentRouteAroundSaturatedProviders',
    'subagentFallbackOnProviderFailure',
    'runtimeAuditLog',
    'bashFastPath',
    'hideStatusStrip',
    'hideTokenRate',
    'hideSessionTokens',
    'hideSessionCost',
    'hideContextIndicator',
    'hideRunStatus',
  ];
  const toggleKeys: Array<keyof ChatPrefs> = [
    'extensionToggles',
    'providerToggles',
    'subagentProviderDefaults',
  ];
  const numericRanges: Record<string, [number, number]> = {
    completionSoundVolume: [0, 100],
    subagentMaxDepth: [0, 8],
    subagentMaxTreeSessions: [5, 200],
    subagentMaxInflight: [1, 16],
    bashWarmPoolSize: [0, 8],
    bashWarmupTimeoutMs: [0, 60000],
    bashDefaultTimeout: [1, 600],
    uiBaseFontSize: [10, 24],
    uiComposerFontSize: [11, 28],
    composerInitialRows: [COMPOSER_INITIAL_ROWS_MIN, COMPOSER_INITIAL_ROWS_MAX],
    expandedSectionFontSize: [8, 32],
    expandedSectionMaxHeight: [80, 1600],
    uiPathParentDepth: [UI_PATH_PARENT_DEPTH_MIN, UI_PATH_PARENT_DEPTH_MAX],
    uiMessageWidth: [40, 100],
    uiCornerRadius: [0, 24],
    activityTailLines: [1, 12],
    uiMessageRailSize: [8, 40],
  };
  const integerNumericKeys = new Set(['composerInitialRows', 'uiPathParentDepth']);
  const stringKeys: Array<keyof ChatPrefs> = [
    'uiFontSans',
    'uiFontMono',
    'uiAccentColor',
    'uiMutedColor',
    'uiLinkColor',
    'uiBackground',
    'uiForeground',
    'uiBorder',
    'bashShellPath',
  ];
  const validDensities = new Set(['compact', 'comfortable', 'spacious']);
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (key === 'uiDensity') {
      if (v !== undefined && !validDensities.has(v as string)) return false;
      continue;
    }
    if (key === 'historyCompaction') {
      if (v !== undefined && !isHistoryCompactionSettings(v)) return false;
      continue;
    }
    if (key === 'subagentBuckets') {
      if (v !== undefined && !isSubagentBucketsPatch(v)) return false;
      continue;
    }
    if (key === 'subagentProviderTogglesBySession') {
      if (v !== undefined && (!isObject(v) || Object.values(v).some((entry) => !isStringBooleanRecord(entry)))) return false;
      continue;
    }
    if (key === 'subagentNestedAllowedBuckets') {
      if (v !== undefined && !isNestedAllowedBucketsPatch(v)) return false;
      continue;
    }
    if (key === 'subagentDropTools') {
      if (v !== undefined && !(Array.isArray(v) && v.every((entry) => typeof entry === 'string'))) return false;
      continue;
    }
    if ((booleanKeys as string[]).includes(key)) {
      if (v !== undefined && typeof v !== 'boolean') return false;
    } else if ((toggleKeys as string[]).includes(key)) {
      if (v !== undefined && !isStringBooleanRecord(v)) return false;
    } else if ((stringKeys as string[]).includes(key)) {
      if (v !== undefined && typeof v !== 'string') return false;
    } else {
      const range = numericRanges[key];
      if (!range) return false;
      if (v !== undefined && (
        !isFiniteNumber(v)
        || (v as number) < range[0]
        || (v as number) > range[1]
        || (integerNumericKeys.has(key) && !Number.isInteger(v))
      )) return false;
    }
  }
  return true;
}

const VALID_PRUNING_MODES = new Set<PruningMode>(['auto', 'shadow', 'off', 'custom']);

function validatePruningSettingsPatch(value: unknown): value is Partial<PruningSettings> {
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (key === 'mode') {
      if (v !== undefined && (typeof v !== 'string' || !VALID_PRUNING_MODES.has(v as PruningMode))) return false;
    } else if (key === 'skillCeiling' || key === 'toolCeiling') {
      if (v !== undefined && (!isFiniteNumber(v) || (v as number) < 1)) return false;
    } else if (key === 'skillAlwaysKeep' || key === 'toolAlwaysKeep') {
      if (v !== undefined && (!Array.isArray(v) || !v.every((entry) => typeof entry === 'string'))) return false;
    } else if (key === 'model' || key === 'provider') {
      if (v !== undefined && (typeof v !== 'string' || v.length === 0)) return false;
    } else if (key === 'thinkingLevel') {
      if (v !== undefined && (typeof v !== 'string' || !THINKING_LEVEL_SET.has(v as ThinkingLevel))) return false;
    } else {
      return false;
    }
  }
  return true;
}

const VALID_TOOL_RESULT_PRUNING_PROFILES = new Set<ToolResultPruningSettings['profile']>(['default', 'security']);

function validateToolResultPruningSettingsPatch(value: unknown): value is Partial<ToolResultPruningSettings> {
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (key === 'enabled') {
      if (v !== undefined && typeof v !== 'boolean') return false;
    } else if (key === 'profile') {
      if (v !== undefined && (typeof v !== 'string' || !VALID_TOOL_RESULT_PRUNING_PROFILES.has(v as ToolResultPruningSettings['profile']))) return false;
    } else if (key === 'rules') {
      if (v !== undefined && !isObject(v)) return false;
      const rules = v as Record<string, unknown>;
      for (const ruleKey of Object.keys(rules)) {
        if (!['ansi', 'whitespace', 'blankRun', 'jsonMinify', 'lsLong', 'gitLog', 'grepGroup'].includes(ruleKey)) return false;
        const ruleValue = rules[ruleKey];
        if (ruleValue !== undefined && typeof ruleValue !== 'boolean') return false;
      }
    } else if (key === 'tools') {
      if (v !== undefined && v !== null && !Array.isArray(v)) return false;
      if (Array.isArray(v)) {
        for (const entry of v) {
          if (typeof entry !== 'string' || entry.length === 0) return false;
        }
      }
    } else {
      return false;
    }
  }
  return true;
}

const DETAIL_KEY_MAX_BYTES = 512;
const DETAIL_REASON_SET: ReadonlySet<string> = new Set(['collapse', 'unmount', 'session-change']);
const DETAIL_REBASE_REASON_SET: ReadonlySet<string> = new Set(['gap', 'backpressure', 'evicted', 'generation-change']);
const DETAIL_ERROR_CODE_SET: ReadonlySet<string> = new Set([
  'INVALID_ADDRESS', 'NOT_LIVE_ADDRESSABLE', 'NOT_FOUND', 'STALE_CURSOR',
  'CHECKSUM_MISMATCH', 'SUBSCRIPTION_CONFLICT', 'UNAVAILABLE', 'INTERNAL_ERROR',
]);

function isDetailKey(value: unknown): value is string {
  return isString(value) && value.length > 0 && utf8Length(value) <= DETAIL_KEY_MAX_BYTES;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateHostDetailRoute(value: Record<string, unknown>): value is HostDetailRoute & Record<string, unknown> {
  return isString(value.hostInstanceId) && value.hostInstanceId.length > 0
    && isNonNegativeSafeInteger(value.hostGeneration)
    && isNonNegativeSafeInteger(value.viewGeneration)
    && Number.isSafeInteger(value.backendGeneration) && (value.backendGeneration as number) > 0
    && Number.isSafeInteger(value.coordinatorGeneration) && (value.coordinatorGeneration as number) > 0
    && isDetailKey(value.detailKey)
    && isString(value.subscriptionId) && value.subscriptionId.length > 0
    && (value.workerId === undefined || isString(value.workerId))
    && (value.workerGeneration === undefined || Number.isSafeInteger(value.workerGeneration))
    && (value.workerId === undefined) === (value.workerGeneration === undefined);
}

function validateJsonPatchOperations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 4_096) return false;
  return value.every((operation) => {
    if (!isObject(operation) || !Array.isArray(operation.path) || operation.path.length > 128) return false;
    if (operation.op === 'delete') return true;
    if (operation.op === 'appendString') return typeof operation.value === 'string';
    if (operation.op === 'appendArray') return Array.isArray(operation.value);
    return operation.op === 'set';
  });
}

function validateDetailPagePayload(value: unknown): value is DetailPagePayload {
  return isObject(value)
    && value.kind === 'json-segment' && value.encoding === 'utf8-json'
    && isString(value.segmentId) && isString(value.text)
    && Array.isArray(value.semanticPath)
    && isNonNegativeSafeInteger(value.startByte) && isNonNegativeSafeInteger(value.endByte)
    && isNonNegativeSafeInteger(value.totalBytes) && isNonNegativeSafeInteger(value.startCodePoint)
    && isNonNegativeSafeInteger(value.endCodePoint) && isNonNegativeSafeInteger(value.totalCodePoints);
}

function isDetailChecksum(value: unknown): value is DetailChecksum {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * Validate a host→webview detail imperative. Unlike ordinary `HostToWebviewMessage`
 * values (which are host-constructed), these cross the webview trust boundary
 * from `postMessage`, so the renderer validates every field before applying it
 * to its key-scoped store.
 */
export function validateHostToWebviewDetailMessage(
  value: unknown,
): value is Extract<HostToWebviewMessage, { type: `detail.${string}` }> {
  if (!isObject(value) || !isString(value.type)) return false;
  const route = validateHostDetailRoute(value);
  if (!route) return false;
  switch (value.type) {
    case 'detail.start':
      return isLiveSubagentDetailAddress(value.address)
        && (value.source === 'live' || value.source === 'durable')
        && isNonNegativeSafeInteger(value.baselineRevision)
        && Number.isSafeInteger(value.pageCount) && (value.pageCount as number) > 0
        && isNonNegativeSafeInteger(value.totalBytes);
    case 'detail.page':
      return isDetailPageRef(value.ref)
        && validateDetailPagePayload(value.payload)
        && isNonNegativeSafeInteger(value.payloadBytes)
        && isDetailChecksum(value.checksum);
    case 'detail.delta':
      return isNonNegativeSafeInteger(value.baseRevision)
        && Number.isSafeInteger(value.revision) && (value.revision as number) > (value.baseRevision as number)
        && validateJsonPatchOperations(value.operations);
    case 'detail.rebase':
      return isNonNegativeSafeInteger(value.currentRevision)
        && isString(value.reason) && DETAIL_REBASE_REASON_SET.has(value.reason as DetailRebaseReason);
    case 'detail.terminal':
      return isNonNegativeSafeInteger(value.revision)
        && isObject(value.durableRef) && isString(value.durableRef.key)
        && (value.durableRef.kind === 'tool-result' || value.durableRef.kind === 'reasoning')
        && (value.durableRef.source === 'durable' || value.durableRef.source === 'live')
        && isString(value.durableRef.sessionPath) && isString(value.durableRef.messageId)
        && isNonNegativeSafeInteger(value.durableRef.sizeBytes)
        && isString(value.durableRef.summary) && typeof value.durableRef.available === 'boolean';
    case 'detail.error':
      return isString(value.code) && DETAIL_ERROR_CODE_SET.has(value.code as string)
        && isString(value.message) && typeof value.retryable === 'boolean';
    default:
      return false;
  }
}

/**
 * Validate a JSON value as a `WebviewToHostMessage`. Returns a discriminated
 * union: `{ ok: true, value }` on success, `{ ok: false, reason }` on failure.
 *
 * Validation depth: outer envelope plus the fields the host actually branches
 * on. Deeper payload validation (e.g. exhaustive composer-input checks) is
 * intentionally light — the host is expected to defensively narrow before
 * acting on individual fields, and over-strict gating here would force the
 * validator to track every future protocol addition.
 */
export function validateWebviewToHostMessage(
  value: unknown,
): ValidationResult<WebviewToHostMessage> {
  if (!isObject(value)) return fail('not an object');
  const type = value.type;
  if (!isString(type)) return fail('missing string `type`');
  if (!isOptionalNonNegativeSafeInteger(value.viewGeneration)) return fail(`${type}: invalid \`viewGeneration\``);

  switch (type) {
    case 'ready':
    case 'refreshState':
      if (!isOptionalString(value.assetVersion)) return fail(`${type}: invalid \`assetVersion\``);
      if (!isOptionalNonNegativeSafeInteger(value.viewGeneration)) return fail(`${type}: invalid \`viewGeneration\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'requestSnapshot':
      if (!isOptionalString(value.assetVersion)) return fail('requestSnapshot: invalid `assetVersion`');
      if (!isOptionalNonNegativeSafeInteger(value.viewGeneration)) return fail('requestSnapshot: invalid `viewGeneration`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openFilePicker':
    case 'newSession':
    case 'showLogs':
    case 'openSettings':
    case 'restartBackend':
      return { ok: true, value: value as WebviewToHostMessage };

    case 'retrySend':
      if (!isString(value.sessionPath)) return fail('retrySend: missing string `sessionPath`');
      if (!isString(value.text)) return fail('retrySend: missing string `text`');
      if (!isString(value.localId)) return fail('retrySend: missing string `localId`');
      if (value.disablePruning !== undefined && typeof value.disablePruning !== 'boolean') {
        return fail('retrySend: `disablePruning` must be a boolean when provided');
      }
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openFile':
      if (!isString(value.path)) return fail('openFile: missing string `path`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'addComposerInput':
      if (!isString(value.sessionPath)) return fail('addComposerInput: missing `sessionPath`');
      if (!validateComposerInputDraft(value.input)) return fail('addComposerInput: invalid `input`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'removeComposerInput':
      if (!isString(value.sessionPath)) return fail('removeComposerInput: missing `sessionPath`');
      if (!isString(value.inputId)) return fail('removeComposerInput: missing `inputId`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setComposerDraft':
      if (!isString(value.sessionPath)) return fail('setComposerDraft: missing `sessionPath`');
      if (!isString(value.text)) return fail('setComposerDraft: missing string `text`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'send':
      if (!isString(value.sessionPath)) return fail('send: missing `sessionPath`');
      if (!isString(value.text)) return fail('send: missing string `text`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'editMessage':
      if (!isString(value.sessionPath)) return fail('editMessage: missing `sessionPath`');
      if (!isString(value.messageId)) return fail('editMessage: missing `messageId`');
      if (!isString(value.text)) return fail('editMessage: missing `text`');
      if (value.inputs !== undefined && !Array.isArray(value.inputs)) return fail('editMessage: `inputs` must be an array when provided');
      if (value.queued !== undefined && typeof value.queued !== 'boolean') return fail('editMessage: `queued` must be a boolean when provided');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'interrupt':
      if (!isString(value.sessionPath)) return fail('interrupt: missing `sessionPath`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'compact':
      if (!isString(value.sessionPath)) return fail('compact: missing `sessionPath`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'cancelDeferredTrigger':
      if (!isString(value.sessionPath)) return fail('cancelDeferredTrigger: missing `sessionPath`');
      if (value.triggerId !== undefined && !isString(value.triggerId)) return fail('cancelDeferredTrigger: bad `triggerId`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'clearQueue':
      if (!isString(value.sessionPath)) return fail('clearQueue: missing string `sessionPath`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'requestDetail':
      if (!isString(value.sessionPath)) return fail('requestDetail: missing string `sessionPath`');
      if (!isObject(value.ref) || !isString(value.ref.key)
        || (value.ref.kind !== 'tool-result' && value.ref.kind !== 'reasoning')
        || (value.ref.source !== 'durable' && value.ref.source !== 'live')
        || value.ref.sessionPath !== value.sessionPath
        || !isString(value.ref.messageId)
        || !isString(value.ref.summary)
        || typeof value.ref.available !== 'boolean'
        || !Number.isSafeInteger(value.ref.sizeBytes) || (value.ref.sizeBytes as number) < 0
        || !isOptionalString(value.ref.toolCallId)
        || !isOptionalString(value.ref.executionId)
        || (value.ref.partIndex !== undefined && !Number.isSafeInteger(value.ref.partIndex))
        || (value.ref.sourceRevision !== undefined
          && (!Number.isSafeInteger(value.ref.sourceRevision) || (value.ref.sourceRevision as number) < 0))) {
        return fail('requestDetail: invalid `ref`');
      }
      return { ok: true, value: value as WebviewToHostMessage };

    case 'detail.subscribe':
      if (!isNonNegativeSafeInteger(value.viewGeneration)) return fail('detail.subscribe: invalid `viewGeneration`');
      if (!isDetailKey(value.detailKey)) return fail('detail.subscribe: invalid `detailKey`');
      if (!isLiveSubagentDetailAddress(value.address)) return fail('detail.subscribe: invalid `address`');
      if (value.cursor !== undefined && !isDetailCursor(value.cursor)) return fail('detail.subscribe: invalid `cursor`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'detail.unsubscribe':
      if (!isNonNegativeSafeInteger(value.viewGeneration)) return fail('detail.unsubscribe: invalid `viewGeneration`');
      if (!isDetailKey(value.detailKey)) return fail('detail.unsubscribe: invalid `detailKey`');
      if (!isString(value.reason) || !DETAIL_REASON_SET.has(value.reason)) return fail('detail.unsubscribe: invalid `reason`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'detail.fetchPages':
      if (!isNonNegativeSafeInteger(value.viewGeneration)) return fail('detail.fetchPages: invalid `viewGeneration`');
      if (!isDetailKey(value.detailKey)) return fail('detail.fetchPages: invalid `detailKey`');
      if (!isDetailPageRef(value.ref)) return fail('detail.fetchPages: invalid `ref`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'closeSession':
      if (!isString(value.sessionPath)) return fail('closeSession: missing string `sessionPath`');
      if (!isOptionalString(value.interactionId)) return fail('closeSession: invalid `interactionId`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openSession':
    case 'duplicateSession':
    case 'togglePinTab':
      if (!isString(value.sessionPath)) return fail(`${type}: missing string \`sessionPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'retryCreateOperation':
      if (!isString(value.operationId)) return fail('retryCreateOperation: missing string `operationId`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'moveSessionTab':
      if (!isOptionalString(value.sessionPath)) return fail('moveSessionTab: bad `sessionPath`');
      if (!isFiniteNumber(value.fromIndex)) return fail('moveSessionTab: missing `fromIndex`');
      if (!isFiniteNumber(value.toIndex)) return fail('moveSessionTab: missing `toIndex`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'groupPinnedTab':
    case 'mergePinnedGroups':
      if (!isString(value.sourcePath) || value.sourcePath.length === 0) return fail(`${type}: invalid \`sourcePath\``);
      if (!isString(value.targetPath) || value.targetPath.length === 0) return fail(`${type}: invalid \`targetPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'ungroupPinnedTab':
    case 'movePinnedItem':
      if (!isString(value.sourcePath) || value.sourcePath.length === 0) return fail(`${type}: invalid \`sourcePath\``);
      if (!isNonNegativeSafeInteger(value.toItemIndex)) return fail(`${type}: invalid \`toItemIndex\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'loadOlderTranscript':
    case 'loadNewerTranscript':
    case 'jumpToLatestTranscript':
      if (!isOptionalString(value.sessionPath)) return fail(`${type}: bad \`sessionPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'startNewTask':
    case 'continueTask':
      if (!isString(value.sessionPath)) return fail(`${type}: missing string \`sessionPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setModel':
      if (!isOptionalString(value.sessionPath)) return fail('setModel: bad `sessionPath`');
      if (!isString(value.defaultModel)) return fail('setModel: missing `defaultModel`');
      if (!isThinkingLevel(value.defaultThinkingLevel)) return fail('setModel: invalid `defaultThinkingLevel`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setPrefs':
      if (!validateChatPrefsPatch(value.prefs)) return fail('setPrefs: invalid `prefs` patch');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setPrivacyMode':
      if (!isString(value.sessionPath)) return fail('setPrivacyMode: missing string `sessionPath`');
      if (typeof value.enabled !== 'boolean') return fail('setPrivacyMode: missing boolean `enabled`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setPruningSettings':
      if (!validatePruningSettingsPatch(value.settings)) return fail('setPruningSettings: invalid `settings` patch');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setToolResultPruningSettings':
      if (!validateToolResultPruningSettingsPatch(value.settings)) return fail('setToolResultPruningSettings: invalid `settings` patch');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openFileDiff':
    case 'openFileInEditor':
    case 'revertFile':
      if (!isString(value.sessionPath)) return fail(`${type}: missing string \`sessionPath\``);
      if (!isString(value.filePath)) return fail(`${type}: missing string \`filePath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setFileRead':
      if (!isString(value.sessionPath)) return fail('setFileRead: missing string `sessionPath`');
      if (!isString(value.filePath)) return fail('setFileRead: missing string `filePath`');
      if (typeof value.read !== 'boolean') return fail('setFileRead: missing boolean `read`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setSystemPromptToggles':
      if (!isString(value.sessionPath)) return fail('setSystemPromptToggles: missing string `sessionPath`');
      if (!Array.isArray(value.disabledEntries)) return fail('setSystemPromptToggles: missing `disabledEntries` array');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'startEdit':
      if (!isString(value.sessionPath)) return fail('startEdit: missing string `sessionPath`');
      if (!isString(value.messageId)) return fail('startEdit: missing string `messageId`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'cancelEdit':
      if (!isString(value.sessionPath)) return fail('cancelEdit: missing string `sessionPath`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'dismissNotice':
      return { ok: true, value: value as WebviewToHostMessage };

    case 'stateReceived':
      if (!validateStateReceivedPayload(value.payload)) return fail('stateReceived: invalid `payload`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'appCommitted':
      if (!validateAppCommittedPayload(value.payload)) return fail('appCommitted: invalid `payload`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'transcriptCommitted':
      if (!validateTranscriptCommittedPayload(value.payload)) return fail('transcriptCommitted: invalid `payload`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'transcriptCommitBlocked':
      if (!validateTranscriptCommitBlockedPayload(value.payload)) return fail('transcriptCommitBlocked: invalid `payload`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'paintObserved':
      if (!validatePaintObservedPayload(value.payload)) return fail('paintObserved: invalid `payload`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'renderFailure':
      if (!validateRenderFailurePayload(value.payload)) return fail('renderFailure: invalid `payload`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'extensionUiResponse':
      // Webview-supplied response to a backend-driven UI prompt. Must be
      // session-addressed so the host can route it back to the right backend
      // session without falling back to the active session (R3 / B4).
      if (!isString(value.sessionPath)) return fail('extensionUiResponse: missing string `sessionPath`');
      if (!isObject(value.response)) return fail('extensionUiResponse: missing `response` object');
      if (!isString((value.response as { id?: unknown }).id)) {
        return fail('extensionUiResponse: missing string `response.id`');
      }
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setFileChangesExpanded':
      if (!isString(value.sessionPath)) return fail('setFileChangesExpanded: missing string `sessionPath`');
      if (typeof value.expanded !== 'boolean') return fail('setFileChangesExpanded: missing boolean `expanded`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'log':
      // H4: webview → host log routing. The webview cannot import host
      // utilities, so it forwards diagnostic logs; the host routes them through
      // `appendPieLog`. Without this case every webview log produced a
      // `message.invalid` audit entry (and the log was dropped).
      if (value.level !== 'warn' && value.level !== 'error') return fail('log: invalid `level`');
      if (!isString(value.scope)) return fail('log: missing string `scope`');
      if (!isString(value.message)) return fail('log: missing string `message`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'rendererVisibilityChanged':
      if (typeof value.visible !== 'boolean') return fail('rendererVisibilityChanged: missing boolean `visible`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'rendererFocusChanged':
      if (typeof value.focused !== 'boolean') return fail('rendererFocusChanged: missing boolean `focused`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'commandStatusRequest':
      if (!isString(value.clientCommandId) || value.clientCommandId.length === 0) {
        return fail('commandStatusRequest: missing string `clientCommandId`');
      }
      return { ok: true, value: value as WebviewToHostMessage };

    default:
      return fail(`unknown message type: ${type}`);
  }
}
