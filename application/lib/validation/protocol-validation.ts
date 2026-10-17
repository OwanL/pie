/**
 * Runtime validators for the host ↔ webview protocol.
 *
 * These guards are hand-written and use the protocol types from
 * `../protocol/index.js` without a schema-library dependency. They catch
 * protocol drift at trust boundaries:
 *
 *   - Webview → host messages arrive as untyped JSON over `postMessage`.
 *     Browser ingress enforces this validator before routing commands; the
 *     VS Code `SidebarViewProvider` also uses it for audit-only logging and
 *     does not drop messages.
 *   - Backend ↔ host messages arrive as JSON-line envelopes; the existing
 *     `isEventEnvelope` / `isResponseEnvelope` checks only validate the outer
 *     shape, not the payload kind.
 */

import type {
  ChatPrefs,
  ComposerInputDraft,
  PruningMode,
  PruningSettings,
  SessionTitlesSettings,
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
  RendererCommandContext,
} from '../protocol/index.js';
import { isThinkingLevel, THINKING_LEVEL_SET } from '../protocol/thinking-level.js';
import { isFiniteNumber } from '../../../lib/validation/type-guards.js';
import { MAX_IMAGE_PREVIEW_PATH_BYTES, MAX_IMAGE_PREVIEW_BYTES, IMAGE_PREVIEW_MIME_BY_EXTENSION } from '../protocol/image-preview.js';
import {
  DEFAULT_SUBAGENT_MAX_INFLIGHT,
  isSubagentConcurrencyLimit,
} from '../../../lib/concurrency-config.js';
import { utf8ByteLength } from '../../../lib/utf8.js';
import {
  COMPOSER_INITIAL_ROWS_MAX,
  COMPOSER_INITIAL_ROWS_MIN,
  UI_PATH_PARENT_DEPTH_MAX,
  UI_PATH_PARENT_DEPTH_MIN,
} from '../protocol/settings.js';
import {
  PROVIDER_MAX_AFTERBURN_SECONDS,
  PROVIDER_MAX_CONCURRENT_REQUESTS,
  PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS,
  PROVIDER_UNLIMITED_CONCURRENCY,
} from '../protocol/provider-concurrency.js';
import {
  DETAIL_REF_KEY_MAX_BYTES,
  isDetailCursor,
  isDetailPageRef,
  isLiveSubagentDetailAddress,
  type DetailChecksum,
  type DetailPagePayload,
  type DetailRebaseReason,
} from '../../../harness/agent-processes/lib/rpc/subagent-detail.js';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/** Host microphone capability is transport context, never a renderer field.
 *  VS Code is a native host surface; browsers require explicit loopback-server
 *  authorization supplied by the trusted transport. */
export function isDictationMicrophoneAllowed(context: RendererCommandContext | undefined): boolean {
  return context?.kind === 'vscode'
    || (context?.kind === 'browser' && context.hostMicrophoneAllowed === true);
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function boundedProviderString(value: unknown, max = 4096): value is string { return typeof value === 'string' && utf8ByteLength(value) <= max; }
function isProviderSetupCommand(value: unknown): boolean {
  if (!isObject(value) || !isString(value.type)) return false;
  const keys: Record<string, string[]> = {
    open: [], close: [], back: [], add: [], save: [], cancel: [], reload: [],
    choose: ['kind', 'definitionId'], 'auth-method': ['method'], models: ['id'], edit: ['id'], refresh: ['id'], remove: ['id'], 'confirm-remove': [],
    change: ['field', 'value'], enabled: ['value'], credential: ['value'],
    'model-preference': ['id', 'field', 'value'], 'manual-model-add': ['id'],
  };
  if (!Object.hasOwn(keys, value.type) || !hasOnlyKeys(value, ['type', ...keys[value.type]])) return false;
  switch (value.type) {
    case 'choose': return ['chatgpt', 'openai', 'anthropic', 'copilot', 'ollama', 'custom'].includes(value.kind as string) && (value.definitionId === undefined || boundedProviderString(value.definitionId, 128));
    case 'auth-method': return ['oauth', 'api-key', 'local'].includes(value.method as string);
    case 'remove': case 'models': case 'edit': case 'refresh': case 'manual-model-add': return boundedProviderString(value.id, 256) && value.id.length > 0;
    case 'change': return ['id', 'api', 'baseUrl', 'environmentName'].includes(value.field as string) && boundedProviderString(value.value);
    case 'enabled': return typeof value.value === 'boolean';
    case 'credential': return ['default', 'saved', 'environment'].includes(value.value as string);
    case 'model-preference': return boundedProviderString(value.id, 256) && ['visible', 'subagentEligible'].includes(value.field as string) && ['unset', 'yes', 'no'].includes(value.value as string);
    default: return true;
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalNonNegativeSafeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeSafeInteger(value);
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

function isProviderConcurrencyPatch(value: unknown): boolean {
  if (!isObject(value)) return false;
  const allowedKeys = new Set([
    'maxConcurrentRequests',
    'afterburnSeconds',
    'queueWaitSeconds',
    'headerWaitSeconds',
  ]);
  for (const overrides of Object.values(value)) {
    if (!isObject(overrides)) return false;
    for (const [key, setting] of Object.entries(overrides)) {
      if (!allowedKeys.has(key)) return false;
      if (key === 'maxConcurrentRequests') {
        if (!Number.isInteger(setting)
          || (setting as number) < PROVIDER_UNLIMITED_CONCURRENCY
          || (setting as number) > PROVIDER_MAX_CONCURRENT_REQUESTS) return false;
      } else if (key === 'afterburnSeconds') {
        if (!isFiniteNumber(setting) || setting < 0 || setting > PROVIDER_MAX_AFTERBURN_SECONDS) return false;
      } else if (!Number.isInteger(setting)
        || (setting as number) < 0
        || (setting as number) > PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS) {
        return false;
      }
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
    'mcpEnabled',
    'subagentAlwaysParentModel',
    'subagentRouteAroundSaturatedProviders',
    'subagentFallbackOnProviderFailure',
    'runtimeAuditLog',
    'bashFastPath',
    'hideStatusStrip',
    'hideTokenRate',
    'hideSessionCost',
    'hideContextIndicator',
    'hideRunStatus',
  ];
  const toggleKeys: Array<keyof ChatPrefs> = [
    'extensionToggles',
    'providerToggles',
    'subagentProviderDefaults',
    'autonomousModeBySession',
  ];
  const numericRanges: Record<string, [number, number]> = {
    completionSoundVolume: [0, 100],
    subagentMaxDepth: [0, 8],
    subagentMaxTreeSessions: [5, 200],
    bashWarmPoolSize: [0, 8],
    bashWarmupTimeoutMs: [0, 60000],
    bashDefaultTimeout: [1, 600],
    uiBaseFontSize: [10, 24],
    uiComposerFontSize: [11, 28],
    composerInitialRows: [COMPOSER_INITIAL_ROWS_MIN, COMPOSER_INITIAL_ROWS_MAX],
    expandedSectionFontSize: [8, 32],
    expandedSectionMaxHeight: [80, 1600],
    uiPathParentDepth: [UI_PATH_PARENT_DEPTH_MIN, UI_PATH_PARENT_DEPTH_MAX],
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
    if (key === 'subagentMaxInflight') {
      if (v !== undefined && !isSubagentConcurrencyLimit(v)) return false;
      continue;
    }
    if (key === 'subagentMaxInflightSource') {
      if (v !== undefined && v !== 'configured-default' && v !== 'saved-preference') return false;
      continue;
    }
    if (key === 'historyCompaction') {
      if (v !== undefined && !isHistoryCompactionSettings(v)) return false;
      continue;
    }
    if (key === 'providerConcurrency') {
      if (v !== undefined && !isProviderConcurrencyPatch(v)) return false;
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
    if (key === 'subagentNestedAllowedBuckets' || key === 'subagentBucketCanSpawn') {
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
  if (value.subagentMaxInflightSource !== undefined) {
    if (value.subagentMaxInflight === undefined) return false;
    if (value.subagentMaxInflightSource === 'configured-default'
      && value.subagentMaxInflight !== DEFAULT_SUBAGENT_MAX_INFLIGHT) return false;
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
    } else if (key === 'mainAgentEnabled' || key === 'subagentEnabled' || key === 'followUpEnabled' || key === 'refreshAfterCompaction') {
      if (v !== undefined && typeof v !== 'boolean') return false;
    } else {
      return false;
    }
  }
  return true;
}

const VALID_TOOL_RESULT_PRUNING_PROFILES = new Set<ToolResultPruningSettings['profile']>(['default', 'security']);

/** Strict patch validation for the `sessionTitles` family: closed key set,
 *  boolean `enabled`, non-empty provider/model strings. */
function validateSessionTitlesSettingsPatch(value: unknown): value is Partial<SessionTitlesSettings> {
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (key === 'enabled') {
      if (v !== undefined && typeof v !== 'boolean') return false;
    } else if (key === 'provider' || key === 'model') {
      if (v !== undefined && (typeof v !== 'string' || v.length === 0)) return false;
    } else if (key === 'thinkingLevel') {
      if (v !== undefined && !isThinkingLevel(v)) return false;
    } else if (key === 'timeoutSec') {
      if (v !== undefined && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 60)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function validateToolResultPruningSettingsPatch(value: unknown): value is Partial<ToolResultPruningSettings> {
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (key === 'enabled') {
      if (v !== undefined && typeof v !== 'boolean') return false;
    } else if (key === 'profile') {
      if (v !== undefined && (typeof v !== 'string' || !VALID_TOOL_RESULT_PRUNING_PROFILES.has(v as ToolResultPruningSettings['profile']))) return false;
    } else if (key === 'rules') {
      if (v !== undefined) {
        if (!isObject(v)) return false;
        for (const [ruleKey, ruleValue] of Object.entries(v)) {
          if (!['ansi', 'whitespace', 'blankRun', 'jsonMinify', 'lsLong', 'gitLog', 'grepGroup'].includes(ruleKey)) return false;
          if (ruleValue !== undefined && typeof ruleValue !== 'boolean') return false;
        }
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

const DETAIL_REASON_SET: ReadonlySet<string> = new Set(['collapse', 'unmount', 'session-change']);
const DETAIL_REBASE_REASON_SET: ReadonlySet<string> = new Set(['gap', 'backpressure', 'evicted', 'generation-change']);
const DETAIL_ERROR_CODE_SET: ReadonlySet<string> = new Set([
  'INVALID_ADDRESS', 'NOT_LIVE_ADDRESSABLE', 'NOT_FOUND', 'STALE_CURSOR',
  'CHECKSUM_MISMATCH', 'SUBSCRIPTION_CONFLICT', 'UNAVAILABLE', 'INTERNAL_ERROR',
]);

function isDetailKey(value: unknown): value is string {
  // Composite detail keys (`subagent:${toolCallId}:${index}`) embed opaque
  // provider tool-call IDs; they share the bounded composite ref-key limit.
  return isString(value) && value.length > 0 && utf8ByteLength(value) <= DETAIL_REF_KEY_MAX_BYTES;
}

function validateHostDetailRoute(value: Record<string, unknown>): value is HostDetailRoute & Record<string, unknown> {
  return isString(value.hostInstanceId) && value.hostInstanceId.length > 0
    && isNonNegativeSafeInteger(value.hostGeneration)
    && isNonNegativeSafeInteger(value.viewGeneration)
    && isString(value.rendererId)
    && isNonNegativeSafeInteger(value.rendererGeneration)
    && Number.isSafeInteger(value.detailAttempt) && (value.detailAttempt as number) > 0
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
        && isNonNegativeSafeInteger(value.totalBytes)
        && isNonNegativeSafeInteger(value.totalCodePoints);
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
        && (value.durableRef.kind === 'tool-result' || value.durableRef.kind === 'reasoning' || value.durableRef.kind === 'model-exchange')
        && (value.durableRef.kind !== 'model-exchange' || (value.durableRef.source === 'durable' && isString(value.durableRef.toolCallId) && value.durableRef.toolCallId.length > 0))
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
    case 'dictationStart':
      if (!hasOnlyKeys(value, ['type', 'sessionPath', 'recordingId', 'draftText', 'selectionStart', 'selectionEnd', 'viewGeneration', 'clientCommandId'])) return fail('dictationStart: unknown fields');
      if (!(value.sessionPath === null || (isString(value.sessionPath) && value.sessionPath.length > 0))) return fail('dictationStart: invalid `sessionPath`');
      if (!isString(value.recordingId) || value.recordingId.length === 0 || utf8ByteLength(value.recordingId) > 128) return fail('dictationStart: invalid `recordingId`');
      if (!isString(value.draftText) || utf8ByteLength(value.draftText) > 256 * 1024) return fail('dictationStart: invalid `draftText`');
      if (!isNonNegativeSafeInteger(value.selectionStart) || !isNonNegativeSafeInteger(value.selectionEnd)
        || value.selectionStart > value.selectionEnd || value.selectionEnd > value.draftText.length) return fail('dictationStart: invalid selection');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'dictationStop':
    case 'dictationCancel':
      if (!hasOnlyKeys(value, ['type', 'sessionPath', 'recordingId', 'viewGeneration', 'clientCommandId'])) return fail(`${type}: unknown fields`);
      if (!isString(value.sessionPath) || value.sessionPath.length === 0) return fail(`${type}: invalid \`sessionPath\``);
      if (!isString(value.recordingId) || value.recordingId.length === 0 || utf8ByteLength(value.recordingId) > 128) return fail(`${type}: invalid \`recordingId\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'providerManagementCommand':
      if (!hasOnlyKeys(value, ['type', 'command', 'viewGeneration', 'clientCommandId']) || !isProviderSetupCommand(value.command)) return fail('providerManagementCommand: invalid command');
      return { ok: true, value: value as WebviewToHostMessage };
    case 'providerManagementConnect':
      if (!hasOnlyKeys(value, ['type', 'method', 'apiKey', 'viewGeneration', 'clientCommandId']) || !['signin', 'api-key', 'local'].includes(value.method as string)
        || !(value.apiKey === undefined || boundedProviderString(value.apiKey, 16384)) || (value.method !== 'api-key' && value.apiKey !== undefined)) return fail('providerManagementConnect: invalid request');
      return { ok: true, value: value as WebviewToHostMessage };
    case 'providerManagementAuthResponse':
      if (!hasOnlyKeys(value, ['type', 'operationId', 'promptId', 'value', 'viewGeneration', 'clientCommandId']) || !boundedProviderString(value.operationId, 128) || !boundedProviderString(value.promptId, 128) || !boundedProviderString(value.value, 16384)) return fail('providerManagementAuthResponse: invalid request');
      return { ok: true, value: value as WebviewToHostMessage };
    case 'ready':
    case 'refreshState':
      if (!isOptionalString(value.assetVersion)) return fail(`${type}: invalid \`assetVersion\``);
      if (!isOptionalString(value.buildId)) return fail(`${type}: invalid \`buildId\``);
      if (!isOptionalNonNegativeSafeInteger(value.viewGeneration)) return fail(`${type}: invalid \`viewGeneration\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'requestSnapshot':
      if (!isOptionalString(value.assetVersion)) return fail('requestSnapshot: invalid `assetVersion`');
      if (!isOptionalString(value.buildId)) return fail('requestSnapshot: invalid `buildId`');
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

    case 'performImageAction': {
      if (!isString(value.requestId) || value.requestId.length === 0 || value.requestId.length > 256) return fail('performImageAction: invalid requestId');
      if (!['copy', 'openInBrowser', 'reveal'].includes(value.action as string)) return fail('performImageAction: invalid action');
      const source = value.source;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return fail('performImageAction: invalid source');
      const s = source as Record<string, unknown>;
      if (s.kind === 'file') {
        if (!isString(s.path) || !s.path.length || s.path.length > MAX_IMAGE_PREVIEW_PATH_BYTES
          || !isOptionalString(s.reference) || !isOptionalString(s.workingDirectory)
          || (typeof s.reference === 'string' && s.reference.length > MAX_IMAGE_PREVIEW_PATH_BYTES)
          || (typeof s.workingDirectory === 'string' && s.workingDirectory.length > MAX_IMAGE_PREVIEW_PATH_BYTES)) return fail('performImageAction: invalid file source');
      } else if (s.kind === 'inline') {
        if (!isString(s.base64) || !s.base64.length || s.base64.length > Math.ceil(MAX_IMAGE_PREVIEW_BYTES / 3) * 4
          || (s.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s.base64))
          || !Object.values(IMAGE_PREVIEW_MIME_BY_EXTENSION).includes(s.mimeType as string)) return fail('performImageAction: invalid inline source');
      } else return fail('performImageAction: invalid source kind');
      return { ok: true, value: value as WebviewToHostMessage };
    }

    case 'openFile':
      if (!isString(value.path)) return fail('openFile: missing string `path`');
      if (!isOptionalString(value.reference)) return fail('openFile: invalid `reference`');
      if (!isOptionalString(value.workingDirectory)) return fail('openFile: invalid `workingDirectory`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'prepareLocalFileOpen':
      if (!isString(value.requestId) || value.requestId.length === 0 || value.requestId.length > 256) return fail('prepareLocalFileOpen: invalid requestId');
      if (!isString(value.path) || value.path.length === 0 || value.path.length > MAX_IMAGE_PREVIEW_PATH_BYTES) return fail('prepareLocalFileOpen: invalid `path`');
      if (!isOptionalString(value.reference)
        || (typeof value.reference === 'string' && value.reference.length > MAX_IMAGE_PREVIEW_PATH_BYTES)) return fail('prepareLocalFileOpen: invalid `reference`');
      if (!isOptionalString(value.workingDirectory)
        || (typeof value.workingDirectory === 'string' && value.workingDirectory.length > MAX_IMAGE_PREVIEW_PATH_BYTES)) return fail('prepareLocalFileOpen: invalid `workingDirectory`');
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

    case 'setPruningRefreshPending':
      if (!isString(value.sessionPath) || typeof value.pending !== 'boolean') return fail('setPruningRefreshPending: requires sessionPath and boolean pending');
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

    case 'requestImagePreview':
      if (!isString(value.requestId) || value.requestId.length === 0 || value.requestId.length > 256) {
        return fail('requestImagePreview: invalid `requestId`');
      }
      if (!isString(value.sessionPath) || utf8ByteLength(value.sessionPath) > MAX_IMAGE_PREVIEW_PATH_BYTES) {
        return fail('requestImagePreview: invalid or oversized `sessionPath`');
      }
      if (!isString(value.path) || utf8ByteLength(value.path) > MAX_IMAGE_PREVIEW_PATH_BYTES) {
        return fail('requestImagePreview: invalid or oversized `path`');
      }
      if (!isOptionalString(value.reference)
        || (value.reference !== undefined && utf8ByteLength(value.reference) > MAX_IMAGE_PREVIEW_PATH_BYTES)) {
        return fail('requestImagePreview: invalid or oversized `reference`');
      }
      if (!isOptionalString(value.workingDirectory)
        || (value.workingDirectory !== undefined && utf8ByteLength(value.workingDirectory) > MAX_IMAGE_PREVIEW_PATH_BYTES)) {
        return fail('requestImagePreview: invalid or oversized `workingDirectory`');
      }
      return { ok: true, value: value as WebviewToHostMessage };

    case 'requestDetail':
      if (!isString(value.sessionPath)) return fail('requestDetail: missing string `sessionPath`');
      if (!isObject(value.ref) || !isString(value.ref.key)
        || (value.ref.kind !== 'tool-result' && value.ref.kind !== 'reasoning' && value.ref.kind !== 'model-exchange')
        || (value.ref.kind === 'model-exchange' && (value.ref.source !== 'durable' || !isString(value.ref.toolCallId) || value.ref.toolCallId.length === 0))
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
          && (!Number.isSafeInteger(value.ref.sourceRevision) || (value.ref.sourceRevision as number) < 0))
        || (value.ref.childCount !== undefined
          && (!Number.isSafeInteger(value.ref.childCount) || (value.ref.childCount as number) < 0))
        || (value.ref.lineCount !== undefined
          && (!Number.isSafeInteger(value.ref.lineCount) || (value.ref.lineCount as number) < 0))) {
        return fail('requestDetail: invalid `ref`');
      }
      return { ok: true, value: value as WebviewToHostMessage };

    case 'detail.subscribe':
      if (!isNonNegativeSafeInteger(value.viewGeneration)) return fail('detail.subscribe: invalid `viewGeneration`');
      if (!isDetailKey(value.detailKey)) return fail('detail.subscribe: invalid `detailKey`');
      if (!Number.isSafeInteger(value.detailAttempt) || (value.detailAttempt as number) <= 0) return fail('detail.subscribe: invalid `detailAttempt`');
      if (!isLiveSubagentDetailAddress(value.address)) return fail('detail.subscribe: invalid `address`');
      if (value.cursor !== undefined && !isDetailCursor(value.cursor)) return fail('detail.subscribe: invalid `cursor`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'detail.unsubscribe':
      if (!isNonNegativeSafeInteger(value.viewGeneration)) return fail('detail.unsubscribe: invalid `viewGeneration`');
      if (!isDetailKey(value.detailKey)) return fail('detail.unsubscribe: invalid `detailKey`');
      if (!Number.isSafeInteger(value.detailAttempt) || (value.detailAttempt as number) <= 0) return fail('detail.unsubscribe: invalid `detailAttempt`');
      if (!isString(value.reason) || !DETAIL_REASON_SET.has(value.reason)) return fail('detail.unsubscribe: invalid `reason`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'detail.fetchPages':
      if (!isNonNegativeSafeInteger(value.viewGeneration)) return fail('detail.fetchPages: invalid `viewGeneration`');
      if (!isDetailKey(value.detailKey)) return fail('detail.fetchPages: invalid `detailKey`');
      if (!Number.isSafeInteger(value.detailAttempt) || (value.detailAttempt as number) <= 0) return fail('detail.fetchPages: invalid `detailAttempt`');
      if (!isDetailPageRef(value.ref)) return fail('detail.fetchPages: invalid `ref`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'closeSession':
      if (!isString(value.sessionPath)) return fail('closeSession: missing string `sessionPath`');
      if (!isOptionalString(value.interactionId)) return fail('closeSession: invalid `interactionId`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'snoozeSession':
      if (!isString(value.sessionPath) || !value.sessionPath.length) return fail('snoozeSession: missing string `sessionPath`');
      if (value.durationHours !== 'monday' && ![4, 8, 12, 24, 48].includes(value.durationHours as number)) {
        return fail('snoozeSession: invalid `durationHours`');
      }
      return { ok: true, value: value as WebviewToHostMessage };

    case 'restoreSnoozedSession':
      if (!isString(value.sessionPath) || !value.sessionPath.length) return fail('restoreSnoozedSession: missing string `sessionPath`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openSession':
    case 'duplicateSession':
    case 'togglePinTab':
    case 'pinAndMergePinnedTab':
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

    case 'dissolvePinnedGroup':
    case 'unpinPinnedGroup':
      if (!isString(value.sourcePath) || value.sourcePath.length === 0) return fail(`${type}: invalid \`sourcePath\``);
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

    case 'setBrowserServerLanEnabled':
      if (typeof value.enabled !== 'boolean') return fail('setBrowserServerLanEnabled: missing boolean `enabled`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setBrowserServerEnabled':
      if (typeof value.enabled !== 'boolean') return fail('setBrowserServerEnabled: missing boolean `enabled`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'mcpListRequested':
      return { ok: true, value: value as WebviewToHostMessage };

    case 'mcpSetServerEnabled':
      if (!isString(value.name) || value.name.length === 0) return fail('mcpSetServerEnabled: missing string `name`');
      if (typeof value.enabled !== 'boolean') return fail('mcpSetServerEnabled: missing boolean `enabled`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'mcpSetServerEnabledForSession':
      if (!isString(value.sessionPath)) return fail('mcpSetServerEnabledForSession: missing string `sessionPath`');
      if (!isString(value.name) || value.name.length === 0) return fail('mcpSetServerEnabledForSession: missing string `name`');
      if (typeof value.enabled !== 'boolean') return fail('mcpSetServerEnabledForSession: missing boolean `enabled`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setPruningSettings':
      if (!validatePruningSettingsPatch(value.settings)) return fail('setPruningSettings: invalid `settings` patch');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setToolResultPruningSettings':
      if (!validateToolResultPruningSettingsPatch(value.settings)) return fail('setToolResultPruningSettings: invalid `settings` patch');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setSessionTitlesSettings':
      if (!validateSessionTitlesSettingsPatch(value.settings)) return fail('setSessionTitlesSettings: invalid `settings` patch');
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

    case 'truncateAfter':
      if (!isString(value.sessionPath)) return fail('truncateAfter: missing string `sessionPath`');
      if (!isString(value.messageId)) return fail('truncateAfter: missing string `messageId`');
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
