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
  RunOutcome,
  StateAppliedPayload,
  ThinkingLevel,
  WebviewToHostMessage,
} from './protocol';
import { isThinkingLevel, THINKING_LEVEL_SET } from './thinking-level.js';

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateStateAppliedPayload(value: unknown): value is StateAppliedPayload {
  return (
    isObject(value)
    && isFiniteNumber(value.revision)
    && typeof value.backendReady === 'boolean'
    && typeof value.transcriptLoaded === 'boolean'
    && isFiniteNumber(value.openTabCount)
    && isFiniteNumber(value.transcriptCount)
    && isFiniteNumber(value.systemPromptCount)
    && typeof value.domTranscriptLoaderPresent === 'boolean'
    && typeof value.domTabsConnectingPresent === 'boolean'
    && typeof value.renderSignature === 'string'
    && (value.domRenderSignature === null || typeof value.domRenderSignature === 'string')
  );
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

function validateRunOutcome(value: unknown): value is RunOutcome {
  return (
    isObject(value)
    && (value.resolution === 'resolved'
      || value.resolution === 'partially_resolved'
      || value.resolution === 'unresolved')
    && isFiniteNumber(value.satisfaction)
  );
}

function isStringBooleanRecord(value: unknown): value is Record<string, boolean> {
  if (!isObject(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== 'boolean') return false;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** A valid `SubagentBuckets` patch: object with optional `small`/`medium`/
 *  `frontier` string-array fields. Extra keys are tolerated (the reducer
 *  normalizes via `resolveChatPrefs`). */
function isSubagentBucketsPatch(value: unknown): boolean {
  if (!isObject(value)) return false;
  for (const key of ['small', 'medium', 'frontier'] as const) {
    const v = value[key];
    if (v !== undefined && !isStringArray(v)) return false;
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

function validateChatPrefsPatch(value: unknown): value is Partial<ChatPrefs> {
  if (!isObject(value)) return false;
  const booleanKeys: Array<keyof ChatPrefs> = [
    'autoExpandReasoning',
    'autoExpandToolCalls',
    'autoExpandSubagentCalls',
    'suppressCompletionNotifications',
    'showPruningMessages',
    'subagentAlwaysParentModel',
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
  ];
  const numericRanges: Record<string, [number, number]> = {
    completionSoundVolume: [0, 100],
    subagentMaxDepth: [0, 8],
    subagentMaxTreeSessions: [5, 200],
    subagentMaxInflight: [1, 16],
    subagentMaxConcurrency: [1, 16],
    subagentMaxParallelTasks: [1, 16],
    bashWarmPoolSize: [0, 8],
    bashWarmupTimeoutMs: [0, 60000],
    bashDefaultTimeout: [1, 600],
    uiBaseFontSize: [10, 24],
    uiComposerFontSize: [11, 28],
    expandedSectionFontSize: [8, 32],
    expandedSectionMaxHeight: [80, 1600],
    uiMessageWidth: [40, 100],
    uiCornerRadius: [0, 24],
    activityTailLines: [1, 12],
    uiMessageRailSize: [8, 40],
  };
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
    if (key === 'subagentBuckets') {
      if (v !== undefined && !isSubagentBucketsPatch(v)) return false;
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
      if (v !== undefined && (!isFiniteNumber(v) || (v as number) < range[0] || (v as number) > range[1])) return false;
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

  switch (type) {
    case 'ready':
    case 'refreshState':
      if (!isOptionalString(value.assetVersion)) return fail(`${type}: invalid \`assetVersion\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'requestSnapshot':
      if (!isOptionalString(value.assetVersion)) return fail('requestSnapshot: invalid `assetVersion`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openFilePicker':
    case 'newSession':
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
      return { ok: true, value: value as WebviewToHostMessage };

    case 'interrupt':
      if (!isString(value.sessionPath)) return fail('interrupt: missing `sessionPath`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'cancelDeferredTrigger':
      if (!isString(value.sessionPath)) return fail('cancelDeferredTrigger: missing `sessionPath`');
      if (value.triggerId !== undefined && !isString(value.triggerId)) return fail('cancelDeferredTrigger: bad `triggerId`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openSession':
    case 'closeSession':
    case 'duplicateSession':
    case 'togglePinTab':
      if (!isString(value.sessionPath)) return fail(`${type}: missing string \`sessionPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'moveSessionTab':
      if (!isOptionalString(value.sessionPath)) return fail('moveSessionTab: bad `sessionPath`');
      if (!isFiniteNumber(value.fromIndex)) return fail('moveSessionTab: missing `fromIndex`');
      if (!isFiniteNumber(value.toIndex)) return fail('moveSessionTab: missing `toIndex`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'loadOlderTranscript':
    case 'loadNewerTranscript':
    case 'jumpToLatestTranscript':
      if (!isOptionalString(value.sessionPath)) return fail(`${type}: bad \`sessionPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'recordOutcome':
      if (!isString(value.sessionPath)) return fail('recordOutcome: missing `sessionPath`');
      if (!validateRunOutcome(value.outcome)) return fail('recordOutcome: invalid `outcome`');
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

    case 'openOutcomeDialog':
      if (!isString(value.sessionPath)) return fail('openOutcomeDialog: missing string `sessionPath`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'closeOutcomeDialog':
      if (!isString(value.sessionPath)) return fail('closeOutcomeDialog: missing string `sessionPath`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'stateApplied':
      if (!validateStateAppliedPayload(value.payload)) return fail('stateApplied: invalid `payload`');
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

    default:
      return fail(`unknown message type: ${type}`);
  }
}
