import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  HISTORY_COMPACTION_ENV,
  resolveHistoryCompactionEffectiveSettings,
  resolveHistoryCompactionSettings,
  resolveHistoryCompactionThresholdTokens,
  type HistoryCompactionSettings,
  type ThinkingLevel,
} from '../shared/protocol';
import type { SessionEntryLike } from './transcript';
import type { MessageLike } from './transcript/types';

// ─── Minimal SDK contract ────────────────────────────────────────────────────
// We type only the surface the backend actually consumes. SDK breaking changes
// surface as TypeScript errors here instead of late runtime failures.

export interface SdkSessionEvent {
  type:
    | 'session_start'
    | 'agent_start'
    | 'agent_end'
    | 'message_start'
    | 'message_update'
    | 'message_end'
    | 'tool_execution_start'
    | 'tool_execution_update'
    | 'tool_execution_end'
    | string;
  message?: {
    role?: 'user' | 'assistant' | 'toolResult' | 'custom';
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
    diagnostics?: MessageLike['diagnostics'];
    usage?: MessageLike['usage'];
    toolCallId?: string;
  };
  assistantMessageEvent?: {
    type: 'text_delta' | 'thinking_delta' | 'toolcall_start' | 'toolcall_delta' | string;
    delta?: string;
    thinking?: string;
    contentIndex?: number;
    partial?: {
      content?: Array<{ type?: string; id?: string; name?: string }>;
    };
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  /** Partial result from onUpdate callback, present on tool_execution_update events. */
  partialResult?: unknown;
  /** `agent_end` is re-emitted by AgentSession with `willRetry: true` when the
   *  SDK will auto-retry the turn (a transient error occurred and the backoff
   *  sleep + retry are pending). The backend gates `agent_end` finalization on
   *  `!willRetry` so a mid-retry `agent_end` does not clear `activeRequest`
   *  (which would break the retry turn's streaming) or flicker `busy` false. */
  willRetry?: boolean;
  /** `auto_retry_start`: 1-based retry attempt about to sleep/retry. */
  attempt?: number;
  /** `auto_retry_start`: configured max retry attempts. */
  maxAttempts?: number;
  /** `auto_retry_start`: backoff delay (ms) before this attempt. */
  delayMs?: number;
  /** `auto_retry_start`: verbatim provider error that triggered the retry. */
  errorMessage?: string;
  /** `auto_retry_end`: whether the retry attempt succeeded. */
  success?: boolean;
  /** `auto_retry_end`: final error on a failed/exhausted/cancelled retry. */
  finalError?: string;
  /** History-compaction lifecycle metadata. */
  reason?: 'manual' | 'threshold' | 'overflow';
  /** Stable SDK session-entry ID, attached by Pie's persistence-order patch. */
  sessionEntryId?: string;
}

export interface SdkSessionManager {
  getCwd: () => string;
  getSessionId?: () => string;
  getSessionFile: () => string | undefined;
  getSessionName: () => string | undefined;
  getBranch: () => SessionEntryLike[];
  getEntries: () => SessionEntryLike[];
}

export interface SdkImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface SdkPromptOptions {
  expandPromptTemplates?: boolean;
  images?: SdkImageContent[];
  streamingBehavior?: 'steer' | 'followUp';
  source?: string;
  preflightResult?: (success: boolean) => void;
}

export interface SdkToolInfo {
  name: string;
  description: string;
  parameters?: unknown;
  sourceInfo?: unknown;
}

export interface SdkSession {
  model?: { id: string; provider?: string; contextWindow?: number; maxTokens?: number };
  thinkingLevel?: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  messages: unknown[];
  sessionManager: SdkSessionManager;
  subscribe: (listener: (event: SdkSessionEvent) => void) => () => void;
  prompt: (text: string, options?: SdkPromptOptions) => Promise<void>;
  /** Manually summarize older history to free context. */
  compact: (customInstructions?: string) => Promise<unknown>;
  abort: () => Promise<void>;
  /** Queue a follow-up message to run as a fresh turn after the current turn
   *  completes. Used by `message.send` when a turn is already running (steering)
   *  on an older SDK without `steer`. Throws synchronously if the text is an
   *  extension command. */
  followUp: (text: string, images?: SdkImageContent[]) => Promise<void>;
  /** Inject a steering message into the CURRENT turn (delivered after in-flight
   *  tool calls finish, before the next LLM call), preferred over `followUp`
   *  by `message.send` when a turn is already running. The agent loop emits
   *  `message_start` (role 'user') when it injects the message, which the
   *  backend forwards as `message.queuedDelivered` so the host promotes its
   *  optimistic 'queued' message to 'completed'. Optional: older SDKs only
   *  expose `followUp`. */
  steer?: (text: string, images?: SdkImageContent[]) => Promise<void>;
  /** Clear all queued steering + follow-up messages and return what was cleared.
   *  Synchronous. Used by `message.clearQueue` and on interrupt. */
  clearQueue: () => { steering: string[]; followUp: string[] };
  /** Billable windows that may still be running after `agent_end` (the backend
   *  already cleared `activeRequest` + emitted busy=false). `message.interrupt`
   *  treats any of these as "running" so a Stop hard-stops the spend instead of
   *  being rejected as SESSION_NOT_RUNNING. Optional: an older SDK that doesn't
   *  expose a predicate is `undefined` → falsy → the legacy guard behaviour. */
  isCompacting?: boolean;
  isRetrying?: boolean;
  isBashRunning?: boolean;
  /** Hard-stop the corresponding billable window. `session.abort()` alone does
   *  NOT stop these post-agent_end LLM/tool calls, so `message.interrupt` calls
   *  them synchronously before the un-awaited `abort()` runs. Each is a no-op
   *  when its window isn't running. Optional: older SDKs that don't expose them
   *  are unaffected (optional-chained at the call site). */
  abortCompaction?: () => void;
  abortBranchSummary?: () => void;
  abortBash?: () => void;
  abortRetry?: () => void;
  setModel?: (model: unknown) => Promise<void>;
  setThinkingLevel?: (level: string) => void;
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getAllTools?: () => SdkToolInfo[];
  /** Names of tools currently exposed to the provider. */
  getActiveToolNames?: () => string[];
  /** Replace the provider-visible tool set; synchronously rebuilds the prompt. */
  setActiveToolsByName?: (toolNames: string[]) => void;
}

export interface SdkContextFile {
  path: string;
  content: string;
}

export interface SdkSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: unknown;
  disableModelInvocation: boolean;
}

export interface SdkBuildSystemPromptOptions {
  cwd: string;
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  contextFiles?: SdkContextFile[];
  skills?: SdkSkill[];
  /** Names of extensions that are currently active/enabled. */
  activeExtensions?: string[];
}

export interface SdkSystemPromptModule {
  buildSystemPrompt: (options: SdkBuildSystemPromptOptions) => string;
}

export interface SdkRuntime {
  session: SdkSession;
  services: {
    modelRegistry: {
      getAvailable: () => Array<{
        id: string;
        name: string;
        provider: string;
        reasoning: boolean;
        input: Array<'text' | 'image'>;
        contextWindow?: number;
        maxTokens?: number;
      }>;
      find: (provider: string, modelId: string) => unknown;
    };
    resourceLoader?: unknown;
    diagnostics?: unknown[];
  };
  dispose: () => Promise<void>;
}

export interface SdkSessionInfo {
  path: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
  modified: Date;
  messageCount: number;
}

export interface SdkModule {
  VERSION: string;
  AgentSession?: { prototype: Record<string, unknown> };
  /** Pure SDK compaction functions used by Pie's supported before-compact customization. */
  prepareCompaction?: (entries: unknown[], settings: SdkCompactionSettings) => SdkCompactionPreparation | undefined;
  compact?: (
    preparation: SdkCompactionPreparation,
    model: PatchableModel,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined,
    customInstructions: string | undefined,
    signal: AbortSignal | undefined,
    thinkingLevel: ThinkingLevel | undefined,
    streamFn: unknown,
    env: Record<string, string> | undefined,
  ) => Promise<SdkCompactionResult>;
  getAgentDir: () => string;
  formatSkillsForPrompt?: (skills: SdkSkill[]) => string;
  AuthStorage: {
    create: (filePath?: string) => unknown;
  };
  SessionManager: {
    continueRecent: (cwd: string) => SdkSessionManager;
    create: (cwd: string, sessionDir?: string) => SdkSessionManager;
    open: (sessionPath: string) => SdkSessionManager;
    forkFrom: (sourcePath: string, targetCwd: string, sessionDir?: string) => SdkSessionManager;
    listAll: (sessionDir?: string) => Promise<SdkSessionInfo[]>;
  };
  createAgentSessionServices: (options: unknown) => Promise<unknown>;
  createAgentSessionFromServices: (options: unknown) => Promise<unknown>;
  createAgentSessionRuntime: (factory: unknown, options: unknown) => Promise<SdkRuntime>;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

/**
 * Permitted parent directories for the SDK. The configured `sdkPath` must
 * resolve to a child of one of these locations to be loaded — defence in depth
 * against an attacker-controlled `--sdkPath` pointing at arbitrary code.
 *
 * Beyond the user profile and system program directories, the npm global
 * prefix (`NPM_CONFIG_PREFIX`, set by npm in every process it spawns) and the
 * host-supplied `PIE_TRUSTED_SDK_ROOT` are allowed so an SDK installed globally
 * under a non-standard prefix (e.g. `C:\nvm4w\nodejs` for nvm-windows, or a
 * proto-managed prefix) is loadable. The host derives `PIE_TRUSTED_SDK_ROOT`
 * from the sdkPath it resolved via `npm root -g`, so that root is
 * trusted-by-construction.
 */
function isPathAllowed(sdkPath: string): boolean {
  const normalized = path.resolve(sdkPath);
  const allowedRoots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
    process.env['APPDATA'],
    process.env['HOME'],
    process.env['USERPROFILE'],
    process.env['NPM_CONFIG_PREFIX'],
    process.env['PIE_TRUSTED_SDK_ROOT'],
    '/usr/local',
    '/usr/lib',
    '/opt',
  ].filter((r): r is string => typeof r === 'string' && r.length > 0);

  return allowedRoots.some((root) => {
    const r = path.resolve(root);
    return normalized === r || normalized.startsWith(r + path.sep);
  });
}

function assertAllowedSdkPath(sdkPath: string): void {
  if (!isPathAllowed(sdkPath)) {
    throw new Error(
      `Refusing to load SDK from disallowed path: ${sdkPath}. ` +
        `Set pie.sdkPath in VS Code settings (or the PI_SDK_PATH env var) to a directory under your user profile, system program directories, or the npm global prefix.`,
    );
  }
}

// ─── SDK retry-classifier hot-patch ──────────────────────────────────────────
// The SDK's transient-error retry classifier has moved between versions:
//  - Legacy: an inline regex in `dist/core/agent-session.js`
//    (`/...|stream ended before message_stop|.../i.test(err)`).
//  - Current: a pattern array in
//    `node_modules/@earendil-works/pi-ai/dist/utils/retry.js`
//    (`"stream ended before message_stop",`), joined into a RegExp by
//    `buildProviderErrorPattern`. The host prefers the local extension
//    `node_modules` SDK (runtime-resolution priority 3), which ships this
//    current shape. The hot-patch MUST handle the array shape or it silently
//    no-ops (`unsupported-shape`) and stream cuts/stalls are never retried.
//
// The patterns added cover saturation-induced failure modes that pi-ai
// surfaces as `stopReason=error` but the upstream classifier does NOT match:
//  - `stream ended before a terminal response event`: pi-ai throws this when
//    an OpenAI Responses SSE stream ends without `response.completed`/
//    `response.incomplete`/`response.failed`. This is EXACTLY what the
//    host-side ProviderGate's stream-liveness watchdog produces when it
//    terminates a stalled upstream (it errors the stream, which the Responses
//    parser does not recognise as a terminal event) — and what an upstream
//    truncation produces. Without this pattern, a stalled/truncated stream is
//    a silent interruption (never retried) instead of a retried turn.
//  - `upstream stream stalled` / `upstream header phase stalled` /
//    `upstream transport circuit open`: the ProviderGate's own terminal error
//    texts, should they ever surface in an errorMessage. Belt-and-suspenders —
//    the synthetic 503/504 paths are also retryable by status.
const RETRY_HOT_PATCH_INSERTS = [
  'stream ended before a terminal response event',
  'upstream stream stalled',
  'upstream header phase stalled',
  'upstream transport circuit open',
] as const;
type RetryHotPatchShape = 'array' | 'inline';
interface RetryHotPatchCandidate {
  /** Path segments relative to the SDK root. */
  rel: readonly string[];
  /** Literal substring unique to this file's shape. The replacement appends the
   *  missing patterns in the shape-appropriate syntax at this location. */
  needle: string;
  shape: RetryHotPatchShape;
}
// Current shape first (the host-preferred local SDK ships it), then the legacy
// inline shape so a global npm install that still has the inline classifier is
// also covered.
const RETRY_HOT_PATCH_CANDIDATES: readonly RetryHotPatchCandidate[] = [
  {
    // Quoted array entry WITH trailing comma so it does NOT match the comment
    // line above that also mentions `stream ended before message_stop`.
    rel: ['node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'],
    needle: '"stream ended before message_stop",',
    shape: 'array',
  },
  {
    rel: ['dist', 'core', 'agent-session.js'],
    needle: 'stream ended before message_stop',
    shape: 'inline',
  },
];

function logRetryHotPatchResult(sdkPath: string, result: SdkRetryHotPatchResult): void {
  console.warn(`[pie:backend] ${JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: 'backend-sdk',
    event: 'retry-hotpatch',
    sdkPath,
    result,
  })}`);
}

export type SdkRetryHotPatchResult =
  | 'patched'
  | 'already-present'
  | 'missing-target'
  | 'unsupported-shape';

/** Build the replacement text for `needle` in the given shape, appending the
 *  missing retryable patterns in the shape-appropriate syntax.
 *  - `array`: `"stream ended before message_stop", "pat1", "pat2", ...,`
 *    (new array entries after the matched one).
 *  - `inline`: `stream ended before message_stop|pat1|pat2|...` (new regex
 *    alternatives after the matched alternative). */
function buildRetryHotPatchReplacement(
  needle: string,
  shape: RetryHotPatchShape,
  inserts: readonly string[],
): string {
  if (shape === 'array') {
    return `${needle} ${inserts.map((p) => `"${p}"`).join(', ')},`;
  }
  return `${needle}|${inserts.join('|')}`;
}

export async function applySdkRetryHotPatch(sdkPath: string): Promise<SdkRetryHotPatchResult> {
  assertAllowedSdkPath(sdkPath);

  let foundAnyFile = false;
  for (const candidate of RETRY_HOT_PATCH_CANDIDATES) {
    const filePath = path.join(sdkPath, ...candidate.rel);
    let source: string;
    try {
      source = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    foundAnyFile = true;

    const missingInserts = RETRY_HOT_PATCH_INSERTS.filter((pattern) => !source.includes(pattern));
    if (missingInserts.length === 0) return 'already-present';
    if (!source.includes(candidate.needle)) continue; // wrong shape — try next candidate

    await fs.writeFile(
      filePath,
      source.replace(
        candidate.needle,
        buildRetryHotPatchReplacement(candidate.needle, candidate.shape, missingInserts),
      ),
      'utf8',
    );
    return 'patched';
  }

  return foundAnyFile ? 'unsupported-shape' : 'missing-target';
}

export type SdkTerminalDurabilityPatchResult =
  | 'patched'
  | 'already-present'
  | 'missing-target'
  | 'unsupported-shape';

/**
 * Patch SDK 0.80.x so message_end subscribers run only after the session entry
 * append returns, and receive its stable `sessionEntryId`. Extension hooks still
 * run before persistence; Pie's backend subscriber uses the post-persistence
 * public event. This changes no session format and introduces no journal.
 */
export async function applySdkTerminalDurabilityPatch(
  sdkPath: string,
): Promise<SdkTerminalDurabilityPatchResult> {
  assertAllowedSdkPath(sdkPath);
  const filePath = path.join(sdkPath, 'dist', 'core', 'agent-session.js');
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing-target';
    throw error;
  }
  if (source.includes('sessionEntryId = this.sessionManager.appendMessage')) return 'already-present';

  const notifyNeedle = `        // Notify all listeners\n        this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);\n        // Handle session persistence`;
  const notifyReplacement = `        // Notify non-terminal events immediately. message_end is published only\n        // after append returns below, with its stable sessionEntryId.\n        const emittedEvent = event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event;\n        if (event.type !== "message_end")\n            this._emit(emittedEvent);\n        // Handle session persistence`;
  const customNeedle = `                this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);`;
  const customReplacement = `                const sessionEntryId = this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);\n                this._emit({ ...emittedEvent, sessionEntryId });`;
  const regularNeedle = `                this.sessionManager.appendMessage(event.message);\n            }\n            // Other message types`;
  const regularReplacement = `                const sessionEntryId = this.sessionManager.appendMessage(event.message);\n                this._emit({ ...emittedEvent, sessionEntryId });\n            }\n            else {\n                this._emit(emittedEvent);\n            }\n            // Other message types`;

  if (!source.includes(notifyNeedle) || !source.includes(customNeedle) || !source.includes(regularNeedle)) {
    return 'unsupported-shape';
  }
  source = source
    .replace(notifyNeedle, notifyReplacement)
    .replace(customNeedle, customReplacement)
    .replace(regularNeedle, regularReplacement);
  await fs.writeFile(filePath, source, 'utf8');
  return 'patched';
}

interface HistoryCompactionUsage {
  tokens: number | null;
  contextWindow: number;
}

interface PatchableModel {
  id: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

interface SdkCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

interface SdkCompactionPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  [key: string]: unknown;
}

interface SdkCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  details?: unknown;
}

interface BeforeCompactEvent {
  type: 'session_before_compact';
  preparation: SdkCompactionPreparation;
  branchEntries: unknown[];
  customInstructions?: string;
  reason: 'manual' | 'threshold' | 'overflow';
  willRetry: boolean;
  signal?: AbortSignal;
}

interface PatchableExtensionRunner {
  __pieHistoryCompactionCustomizationInstalled?: boolean;
  hasHandlers(eventType: string): boolean;
  emit(event: unknown): Promise<unknown>;
}

interface PatchableModelRegistry {
  find(provider: string, id: string): PatchableModel | undefined;
}

interface PatchableAgentSession {
  agent: {
    prepareNextTurnWithContext?: (turn: { context: Record<string, unknown> }, signal?: AbortSignal) => Promise<Record<string, unknown> | undefined>;
    state: { messages: unknown[] };
    streamFn?: unknown;
  };
  model?: PatchableModel;
  thinkingLevel?: ThinkingLevel;
  settingsManager?: { getCompactionSettings(): SdkCompactionSettings };
  sessionManager: { getBranch(): Array<{ type?: string; id?: string }> };
  _modelRegistry?: PatchableModelRegistry;
  _extensionRunner?: PatchableExtensionRunner;
  _getCompactionRequestAuth?: (model: PatchableModel) => Promise<{
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }>;
  _isAgentRunActive?: boolean;
  _installAgentNextTurnRefresh(): void;
  _buildRuntime?: (...args: unknown[]) => unknown;
  _checkCompaction(assistantMessage: PatchableAssistantMessage, skipAbortedCheck?: boolean): Promise<boolean>;
  _runAutoCompaction(reason: 'threshold', willRetry: boolean): Promise<boolean>;
  getContextUsage(): HistoryCompactionUsage | undefined;
}

export type SdkHistoryCompactionPatchResult = 'patched' | 'already-present' | 'missing-target' | 'unsupported-shape';

function readLiveHistoryCompactionSettings(): HistoryCompactionSettings | undefined {
  const raw = process.env[HISTORY_COMPACTION_ENV];
  if (!raw) return undefined;
  try {
    return resolveHistoryCompactionSettings(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function historyCompactionModelKey(model: Pick<PatchableModel, 'provider' | 'id'> | undefined): string | undefined {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
}

function effectiveHistoryCompactionSettings(
  settings: HistoryCompactionSettings,
  model: Pick<PatchableModel, 'provider' | 'id'> | undefined,
): HistoryCompactionSettings {
  const key = historyCompactionModelKey(model);
  if (!key) return settings;
  const effective = resolveHistoryCompactionEffectiveSettings(settings, key);
  return { ...settings, ...effective };
}

/** Pure threshold decision shared by the runtime patch and focused tests. */
export function shouldRunHistoryCompaction(
  settings: HistoryCompactionSettings | undefined,
  usage: HistoryCompactionUsage | undefined,
  trigger: 'soft' | 'hard',
  model?: Pick<PatchableModel, 'provider' | 'id'>,
): boolean {
  if (!settings?.enabled || !usage || usage.tokens === null || usage.contextWindow <= 0) return false;
  const effective = effectiveHistoryCompactionSettings(settings, model);
  return usage.tokens >= resolveHistoryCompactionThresholdTokens(effective, usage.contextWindow, trigger);
}

function latestCompactionId(session: PatchableAgentSession): string | undefined {
  const branch = session.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === 'compaction') return entry.id;
  }
  return undefined;
}

async function runPatchedHistoryCompaction(
  session: PatchableAgentSession,
  trigger: 'soft' | 'hard',
  continueRun: boolean,
): Promise<{ compacted: boolean; continueRequested: boolean }> {
  const settings = readLiveHistoryCompactionSettings();
  if (!shouldRunHistoryCompaction(settings, session.getContextUsage(), trigger, session.model)) {
    return { compacted: false, continueRequested: false };
  }
  const before = latestCompactionId(session);
  const continueRequested = await session._runAutoCompaction('threshold', continueRun);
  return {
    compacted: latestCompactionId(session) !== before,
    continueRequested,
  };
}

interface PatchableAssistantMessage {
  stopReason?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
  };
}

function isSilentContextOverflow(
  message: PatchableAssistantMessage,
  contextWindow: number | undefined,
): boolean {
  if (!contextWindow || contextWindow <= 0 || !message.usage) return false;
  const input = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0);
  if (message.stopReason === 'stop') return input > contextWindow;
  return message.stopReason === 'length'
    && (message.usage.output ?? 0) === 0
    && input >= contextWindow * 0.99;
}

function isBeforeCompactEvent(event: unknown): event is BeforeCompactEvent {
  return !!event && typeof event === 'object'
    && (event as { type?: unknown }).type === 'session_before_compact'
    && Array.isArray((event as { branchEntries?: unknown }).branchEntries);
}

function mergeCompactionInstructions(persistent: string, oneTime: string | undefined): string | undefined {
  const parts = [persistent.trim(), oneTime?.trim() ?? ''].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\nAdditional one-time focus:\n') : undefined;
}

function mergeCompactionDetails(
  details: unknown,
  pieDetails: Record<string, unknown>,
): Record<string, unknown> {
  const base = details && typeof details === 'object' && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
  return { ...base, pieCompaction: pieDetails };
}

async function createCustomizedCompaction(
  sdk: Pick<SdkModule, 'prepareCompaction' | 'compact'>,
  session: PatchableAgentSession,
  event: BeforeCompactEvent,
): Promise<SdkCompactionResult | undefined> {
  const settings = readLiveHistoryCompactionSettings();
  const prepareCompaction = sdk.prepareCompaction;
  const compact = sdk.compact;
  const activeModel = session.model;
  const nativeSettings = session.settingsManager?.getCompactionSettings();
  if (!settings || !prepareCompaction || !compact || !activeModel || !nativeSettings) return undefined;

  const effective = effectiveHistoryCompactionSettings(settings, activeModel);
  const preparation = prepareCompaction(event.branchEntries, {
    ...nativeSettings,
    keepRecentTokens: effective.keepRecentTokens,
  });
  if (!preparation) return undefined;

  let summaryModel = activeModel;
  if (settings.summaryModel) {
    const selected = session._modelRegistry?.find(settings.summaryModel.provider, settings.summaryModel.id);
    if (!selected) return undefined;
    summaryModel = selected;
  }
  if (!session._getCompactionRequestAuth) return undefined;

  try {
    const auth = await session._getCompactionRequestAuth(summaryModel);
    const thinkingLevel = settings.summaryThinkingLevel === 'inherit'
      ? session.thinkingLevel
      : settings.summaryThinkingLevel;
    const instructions = mergeCompactionInstructions(settings.summaryInstructions, event.customInstructions);
    const result = await compact(
      preparation,
      summaryModel,
      auth.apiKey,
      auth.headers,
      instructions,
      event.signal,
      thinkingLevel,
      session.agent.streamFn,
      auth.env,
    );
    return {
      ...result,
      details: mergeCompactionDetails(result.details, {
        version: 1,
        reason: event.reason,
        modelId: summaryModel.id,
        provider: summaryModel.provider,
        thinkingLevel: thinkingLevel ?? 'off',
        keepRecentTokens: effective.keepRecentTokens,
        instructionsApplied: !!instructions,
      }),
    };
  } catch {
    // Returning no override delegates to pi's native compactor. This is
    // especially important for provider-overflow recovery: a missing override
    // model or failed custom summary must never suppress the built-in fallback.
    return undefined;
  }
}

function installHistoryCompactionCustomization(
  sdk: Pick<SdkModule, 'prepareCompaction' | 'compact'>,
  session: PatchableAgentSession,
): void {
  const runner = session._extensionRunner;
  if (!runner || runner.__pieHistoryCompactionCustomizationInstalled) return;
  const originalEmit = runner.emit;
  const originalHasHandlers = runner.hasHandlers;
  if (typeof originalEmit !== 'function' || typeof originalHasHandlers !== 'function') return;

  // The SDK avoids constructing before-compact events unless at least one
  // extension handler exists. Advertise Pie's synthetic final handler so the
  // supported event path is actually invoked; preserve all native answers for
  // every other event type.
  runner.hasHandlers = function pieHistoryCompactionHasHandlers(eventType: string): boolean {
    return eventType === 'session_before_compact' || originalHasHandlers.call(this, eventType);
  };
  runner.emit = async function pieHistoryCompactionEmit(event: unknown): Promise<unknown> {
    const existing = await originalEmit.call(this, event);
    if (!isBeforeCompactEvent(event)) return existing;
    if (existing && typeof existing === 'object') {
      const prior = existing as { cancel?: unknown; compaction?: unknown };
      if (prior.cancel || prior.compaction) return existing;
    }
    const compaction = await createCustomizedCompaction(sdk, session, event);
    return compaction ? { compaction } : existing;
  };
  Object.defineProperty(runner, '__pieHistoryCompactionCustomizationInstalled', {
    value: true,
    enumerable: false,
    configurable: false,
  });
}

/**
 * Add Pie's proactive soft/hard scheduler and supported before-compact
 * customization to the pinned SDK without changing its persisted session
 * format. Hard checks run from the SDK's awaited prepare-next-turn barrier
 * (after all tool results, before another provider request). While the
 * proactive policy is enabled, its thresholds replace pi's native near-window
 * threshold; provider overflow/error recovery remains delegated to pi.
 */
export function applySdkHistoryCompactionRuntimePatch(
  sdk: Pick<SdkModule, 'AgentSession' | 'prepareCompaction' | 'compact'>,
): SdkHistoryCompactionPatchResult {
  const prototype = sdk.AgentSession?.prototype as (Record<string, unknown> & {
    __pieHistoryCompactionPatched?: boolean;
  }) | undefined;
  if (!prototype) return 'missing-target';
  if (prototype.__pieHistoryCompactionPatched) return 'already-present';
  const originalInstall = prototype._installAgentNextTurnRefresh;
  const originalBuildRuntime = prototype._buildRuntime;
  const originalCheck = prototype._checkCompaction;
  if (typeof originalInstall !== 'function' || typeof originalCheck !== 'function') return 'unsupported-shape';

  if (typeof originalBuildRuntime === 'function' && sdk.prepareCompaction && sdk.compact) {
    prototype._buildRuntime = function patchedBuildRuntime(
      this: PatchableAgentSession,
      ...args: unknown[]
    ): unknown {
      const result = (originalBuildRuntime as (...runtimeArgs: unknown[]) => unknown).apply(this, args);
      installHistoryCompactionCustomization(sdk, this);
      return result;
    };
  }

  prototype._installAgentNextTurnRefresh = function patchedInstall(this: PatchableAgentSession): void {
    (originalInstall as (this: PatchableAgentSession) => void).call(this);
    const previousPrepare = this.agent.prepareNextTurnWithContext;
    if (typeof previousPrepare !== 'function') return;
    this.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const previousSnapshot = await previousPrepare.call(this.agent, turn, signal);
      const result = await runPatchedHistoryCompaction(this, 'hard', true);
      if (!result.compacted) return previousSnapshot;
      const baseContext = (previousSnapshot?.context ?? turn.context) as Record<string, unknown>;
      return {
        ...(previousSnapshot ?? {}),
        context: {
          ...baseContext,
          messages: this.agent.state.messages.slice(),
        },
      };
    };
  };

  prototype._checkCompaction = async function patchedCheck(
    this: PatchableAgentSession,
    assistantMessage: PatchableAssistantMessage,
    skipAbortedCheck = true,
  ): Promise<boolean> {
    // Provider errors and silent overflow signals must reach pi's native
    // classifier first so overflow compacts, removes a truncated assistant
    // where required, and performs its one bounded retry. Normal successful
    // responses continue to use Pie's proactive soft/hard timing.
    if (assistantMessage.stopReason === 'error'
        || isSilentContextOverflow(assistantMessage, this.model?.contextWindow)
        || (skipAbortedCheck && assistantMessage.stopReason === 'aborted')) {
      return await (originalCheck as PatchableAgentSession['_checkCompaction']).call(
        this,
        assistantMessage,
        skipAbortedCheck,
      );
    }
    const trigger = this._isAgentRunActive ? 'soft' : 'hard';
    const result = await runPatchedHistoryCompaction(this, trigger, false);
    if (result.compacted) return result.continueRequested;
    // Any valid live Pie policy owns normal threshold timing completely,
    // including enabled=false. Native error/overflow handling was delegated
    // above; falling through while disabled would silently re-enable pi's
    // default `contextWindow - reserveTokens` threshold and ignore the user's
    // toggle. Only an absent/unreadable policy delegates normal timing.
    if (readLiveHistoryCompactionSettings()) return false;
    return await (originalCheck as PatchableAgentSession['_checkCompaction']).call(
      this,
      assistantMessage,
      skipAbortedCheck,
    );
  };

  Object.defineProperty(prototype, '__pieHistoryCompactionPatched', {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return 'patched';
}

export async function loadSdk(sdkPath: string): Promise<SdkModule> {
  assertAllowedSdkPath(sdkPath);
  const durabilityPatchResult = await applySdkTerminalDurabilityPatch(sdkPath);
  if (durabilityPatchResult === 'missing-target' || durabilityPatchResult === 'unsupported-shape') {
    throw new Error(`SDK terminal durability patch failed: ${durabilityPatchResult}.`);
  }
  const patchResult = await applySdkRetryHotPatch(sdkPath);
  logRetryHotPatchResult(sdkPath, patchResult);

  const entryUrl = pathToFileURL(path.join(sdkPath, 'dist', 'index.js')).href;
  const mod = (await dynamicImport(entryUrl)) as Partial<SdkModule>;

  if (
    typeof mod.VERSION !== 'string' ||
    typeof mod.getAgentDir !== 'function' ||
    typeof mod.SessionManager?.listAll !== 'function' ||
    typeof mod.createAgentSessionRuntime !== 'function'
  ) {
    throw new Error(
      `SDK at ${sdkPath} is missing required exports (expected pi-coding-agent contract).`,
    );
  }

  const typed = mod as SdkModule;
  // The pinned SDK documents and ships compaction as an internal module, but
  // does not re-export prepareCompaction from dist/index.js. Loading only the
  // package root leaves that value undefined, so the model-override hook is
  // never installed and pi silently compacts with the active chat model.
  const compactionModule = typed.prepareCompaction && typed.compact
    ? typed
    : await loadSdkInternalModule<Pick<SdkModule, 'prepareCompaction' | 'compact'>>(
        sdkPath,
        path.join('core', 'compaction', 'index.js'),
      );
  if (typeof compactionModule.prepareCompaction !== 'function'
      || typeof compactionModule.compact !== 'function') {
    throw new Error('SDK history-compaction patch failed: compaction functions are unavailable.');
  }
  const historyCompactionPatch = applySdkHistoryCompactionRuntimePatch({
    AgentSession: typed.AgentSession,
    prepareCompaction: compactionModule.prepareCompaction,
    compact: compactionModule.compact,
  });
  if (historyCompactionPatch === 'missing-target' || historyCompactionPatch === 'unsupported-shape') {
    throw new Error(`SDK history-compaction patch failed: ${historyCompactionPatch}.`);
  }
  return typed;
}

export async function loadSdkInternalModule<TModule>(
  sdkPath: string,
  relativePath: string,
): Promise<TModule> {
  assertAllowedSdkPath(sdkPath);
  const entryUrl = pathToFileURL(path.join(sdkPath, 'dist', relativePath)).href;
  return (await dynamicImport(entryUrl)) as TModule;
}
