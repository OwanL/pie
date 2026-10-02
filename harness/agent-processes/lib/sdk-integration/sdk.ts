import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { PiRuntimeTarget } from '../../../../lib/pi-runtime/artifact.mjs';
import { verifySdkRuntimeArtifactDescriptor } from './sdk-runtime-artifact';
import { createSourceSdkPolicyAdapter, type SourceSdkPolicyFactoryResult } from './source-sdk-policy';
import type * as SourceSdk from '@earendil-works/pi-coding-agent';
import { pathToFileURL } from 'node:url';

import {
  HISTORY_COMPACTION_ENV,
  resolveHistoryCompactionEffectiveSettings,
  resolveHistoryCompactionSettings,
  resolveHistoryCompactionThresholdTokens,
} from '../../../session-storage/settings/history-compaction.js';
import type { HistoryCompactionSettings } from '../../../session-storage/settings/history-compaction.js';
import { backendWarn } from '../../../../lib/structured-logging/backend-log';
import { isContextOverflowMessage } from '../../workers/history-compaction';
import type { SessionEntryLike } from '../../../session-storage/transcripts/transcript';
import type { MessageLike } from '../../../session-storage/transcripts/types';

// ─── Minimal SDK contract ────────────────────────────────────────────────────
// We type only the surface the backend actually consumes. SDK breaking changes
// surface as TypeScript errors here instead of late runtime failures.

export interface SdkSessionEvent {
  type:
    | 'session_start'
    | 'agent_start'
    | 'agent_end'
    | 'agent_settled'
    | 'message_start'
    | 'message_update'
    | 'message_end'
    | 'tool_execution_start'
    | 'tool_execution_update'
    | 'tool_execution_end'
    | string;
  message?: {
    role?: 'user' | 'assistant' | 'toolResult' | 'custom';
    timestamp?: string | number;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
    diagnostics?: MessageLike['diagnostics'];
    usage?: MessageLike['usage'];
    toolCallId?: string;
  };
  assistantMessageEvent?: {
    type: 'text_delta' | 'thinking_delta' | 'toolcall_start' | 'toolcall_delta' | 'toolcall_end' | string;
    delta?: string;
    thinking?: string;
    contentIndex?: number;
    partial?: {
      content?: Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>;
    };
    /** Full finalized call supplied by the pinned SDK on toolcall_end. */
    toolCall?: { type?: string; id?: string; name?: string; arguments?: unknown };
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
  /** `compaction_end`: true when the compaction was cancelled by abort. */
  aborted?: boolean;
  /** Session lifecycle or history-compaction reason metadata. */
  reason?: 'manual' | 'threshold' | 'overflow' | 'new' | 'resume' | 'fork' | 'startup' | 'reload' | 'quit';
  previousSessionFile?: string;
  /** Stable SDK session-entry ID emitted after source-owned persistence. */
  sessionEntryId?: string;
}

export interface SdkWorkerOwnershipIdentity {
  coordinatorGeneration: number;
  workerId: string;
  workerGeneration: number;
}

export interface SdkSessionWriteLease extends SdkWorkerOwnershipIdentity {
  canonicalSessionPath: string;
  ownershipRevision: number;
  nonce: string;
}

export interface SdkSessionOwnershipFingerprint {
  exists: boolean;
  size: number;
  sha256: string | null;
}

export type SdkSessionReplacementReason =
  | 'new'
  | 'switch'
  | 'root-fork'
  | 'branch-fork'
  | 'clone'
  | 'import'
  | 'self-reopen';

export interface SdkSessionReplacementIntent {
  operationId: string;
  reason: SdkSessionReplacementReason;
  source: SdkSessionWriteLease;
  destinationPath: string;
  destinationMustNotExist: boolean;
  requestedPath?: string;
  importSourcePath?: string;
  parentSessionPath?: string;
  entryId?: string;
  position?: 'before' | 'at';
}

export interface SdkSessionOwnershipReservation {
  reservationId: string;
  operationId: string;
  canonicalSourcePath: string;
  canonicalDestinationPath: string;
  ownershipRevision: number;
  nonce: string;
  destinationFingerprint: SdkSessionOwnershipFingerprint;
}

export interface SdkSessionTransferAuthorization {
  authorizationId: string;
  reservationId: string;
  canonicalDestinationPath: string;
  ownershipRevision: number;
  nonce: string;
  destinationLease: SdkSessionWriteLease;
}

/** Supported Pie adapter consumed by the source SDK in worker mode.
 * Cold callers omit it and retain the SDK's ordinary durable behavior. */
export interface SdkSessionOwnershipAdapter {
  reserveReplacement(intent: SdkSessionReplacementIntent): Promise<SdkSessionOwnershipReservation>;
  abortPrecommit(reservation: SdkSessionOwnershipReservation, reason: string): Promise<void>;
  commitTransfer(
    reservation: SdkSessionOwnershipReservation,
    sourceLease: SdkSessionWriteLease,
  ): Promise<SdkSessionTransferAuthorization>;
  consumeTransferAuthorization(
    authorization: SdkSessionTransferAuthorization,
    canonicalDestinationPath: string,
  ): Promise<SdkSessionWriteLease>;
  assertWriteLease(lease: SdkSessionWriteLease, canonicalPath: string, seam: string): void;
  /** Optional until the P7b storage cutoff is explicitly authorized. When
   * installed, the source SDK encloses the complete same-session mutation in
   * this cross-process lifecycle critical section. */
  runWriteMutation?<T>(
    lease: SdkSessionWriteLease,
    canonicalPath: string,
    seam: string,
    sessionId: string,
    mutation: () => T,
  ): T;
  runtimeReady(lease: SdkSessionWriteLease, canonicalPath: string): Promise<void>;
  failClosed(error: unknown): Promise<never>;
}

export interface SdkSessionManager {
  getCwd: () => string;
  getSessionDir?: () => string;
  getSessionId?: () => string;
  getSessionFile: () => string | undefined;
  getSessionName: () => string | undefined;
  getBranch: () => SessionEntryLike[];
  getEntries: () => SessionEntryLike[];
  /** Constant-time lookup from the pinned SDK's durable entry index. */
  getEntry?: (entryId: string) => SessionEntryLike | undefined;
  /** Runtime-free durable context projection supplied by SessionManager. */
  buildContextEntries?: () => SessionEntryLike[];
  buildSessionContext?: () => {
    messages: unknown[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  getHeader?: () => unknown;
  /** Atomically append cold model/thinking settings as one durable commit. */
  appendPieModelSettingsChange?: (
    provider: string | undefined,
    modelId: string | undefined,
    thinkingLevel: string | undefined,
  ) => {
    modelChangeId?: string;
    thinkingLevelChangeId?: string;
  };
  /** Atomically append a durable session_info title entry (pinned SDK seam
   * used by the coordinator-owned cold title assignment path). */
  appendSessionInfo?: (name: string) => string;
  attachPieWriteLease?: (adapter: SdkSessionOwnershipAdapter, lease: SdkSessionWriteLease) => void;
  revokePieWriteLease?: () => void;
  activatePiePrepared?: (authorization: SdkSessionTransferAuthorization) => Promise<SdkSessionWriteLease>;
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
  /** One-line system-prompt catalog text for this registered tool. Older SDK
   * getAllTools implementations omit it, so inventory callers may fall back to
   * getToolDefinition(name). */
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  sourceInfo?: unknown;
}

export interface SdkToolPromptDefinition {
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface SdkReplacedSessionContext {
  sessionManager: SdkSessionManager;
  sendMessage: (message: unknown, options?: unknown) => Promise<void>;
  sendUserMessage: (content: unknown, options?: unknown) => Promise<void>;
}

export interface SdkSessionReplacementOptions {
  withSession?: (context: SdkReplacedSessionContext) => Promise<void>;
}

export interface SdkNewSessionOptions extends SdkSessionReplacementOptions {
  parentSession?: string;
  setup?: (sessionManager: SdkSessionManager) => Promise<void>;
}

export interface SdkForkOptions extends SdkSessionReplacementOptions {
  position?: 'before' | 'at';
}

export interface SdkNavigateTreeOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface SdkExtensionError {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}

export interface SdkExtensionBindings {
  uiContext: unknown;
  mode: 'rpc';
  commandContextActions: {
    waitForIdle: () => Promise<void>;
    newSession: (options?: SdkNewSessionOptions) => Promise<{ cancelled: boolean }>;
    fork: (entryId: string, options?: SdkForkOptions) => Promise<{ cancelled: boolean }>;
    navigateTree: (targetId: string, options?: SdkNavigateTreeOptions) => Promise<{ cancelled: boolean }>;
    switchSession: (sessionPath: string, options?: SdkSessionReplacementOptions) => Promise<{ cancelled: boolean }>;
    reload: () => Promise<void>;
  };
  shutdownHandler?: () => void;
  onError?: (error: SdkExtensionError) => void;
}

export interface SdkSession {
  /** Pinned AgentSession default-write callbacks invoked by setModel/setThinkingLevel. */
  settingsManager?: {
    setDefaultModelAndProvider(provider: string, id: string): void;
    setDefaultThinkingLevel(level: string): void;
  };
  model?: { id: string; provider?: string; contextWindow?: number; maxTokens?: number };
  thinkingLevel?: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  messages: unknown[];
  sessionManager: SdkSessionManager;
  subscribe: (listener: (event: SdkSessionEvent) => void) => () => void;
  bindExtensions: (bindings: SdkExtensionBindings) => Promise<void>;
  waitForIdle: () => Promise<void>;
  navigateTree: (targetId: string, options?: SdkNavigateTreeOptions) => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
  prompt: (text: string, options?: SdkPromptOptions) => Promise<void>;
  /** Resume an interrupted turn without appending a new user message or running
   * the before_agent_start prompt preflight. Adapted by Pie's source policy
   * through the SDK's public continuation decision API. */
  continueAfterInterruption?: () => Promise<void>;
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
  /** SDK activity predicates used by Pie's single billable-activity authority.
   * `isStreaming` spans the complete agent run through `agent_settled`; the
   * remaining getters cover maintenance, retry, queue, and user-bash windows
   * that can exist outside an ordinary provider turn. */
  isCompacting?: boolean;
  isRetrying?: boolean;
  isBashRunning?: boolean;
  hasPendingBashMessages?: boolean;
  pendingMessageCount?: number;
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
  /** Full registered definition metadata. Present in the pinned SDK even when
   * getAllTools omits promptSnippet for compatibility. */
  getToolDefinition?: (name: string) => SdkToolPromptDefinition | undefined;
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
  /** Source SDK runtime ownership adapter. */
  ownershipAdapter?: SdkSessionOwnershipAdapter;
  services: {
    modelRegistry: SdkModelRegistry;
    resourceLoader?: unknown;
    diagnostics?: unknown[];
  };
  /** Rebind host-owned subscription/UI state after SDK session replacement. */
  setRebindSession?: (rebind: (session: SdkSession) => void | Promise<void>) => void;
  newSession?: (options?: SdkNewSessionOptions) => Promise<{ cancelled: boolean }>;
  fork?: (entryId: string, options?: SdkForkOptions) => Promise<{ cancelled: boolean; text?: string }>;
  switchSession?: (sessionPath: string, options?: SdkSessionReplacementOptions) => Promise<{ cancelled: boolean }>;
  dispose: () => Promise<void>;
}

export interface SdkCatalogModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  contextWindow?: number;
  maxTokens?: number;
  baseUrl?: string;
}

export interface SdkModelRegistry {
  refresh?: () => void;
  getError?: () => string | undefined;
  getAvailable: () => SdkCatalogModel[];
  /** Includes unavailable built-in models when supported by the pinned SDK. */
  getAll?: () => Array<{
    id: string;
    provider: string;
    baseUrl?: string;
  }>;
  find: (provider: string, modelId: string) => unknown;
}

export interface SdkAuthStorage {
  reload?: () => void;
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
  /** Pure SDK compaction functions used by Pie's supported before-compact customization. */
  prepareCompaction?: typeof SourceSdk.prepareCompaction;
  compact?: typeof SourceSdk.compact;
  getAgentDir: () => string;
  formatSkillsForPrompt?: (skills: SdkSkill[]) => string;
  AuthStorage: {
    create: (filePath?: string) => SdkAuthStorage;
  };
  ModelRegistry?: {
    create: (authStorage: SdkAuthStorage, modelsJsonPath?: string) => SdkModelRegistry;
  };
  SessionManager: {
    /** Public class prototype, exposed for contract inspection only. */
    prototype?: typeof SourceSdk.SessionManager.prototype;
    continueRecent: (cwd: string) => SdkSessionManager;
    create: (cwd: string, sessionDir?: string) => SdkSessionManager;
    /** Ephemeral manager used by temporary inventory workers. */
    inMemory: (cwd?: string) => SdkSessionManager;
    open: (sessionPath: string) => SdkSessionManager;
    forkFrom: (sourcePath: string, targetCwd: string, sessionDir?: string) => SdkSessionManager;
    preparePieCreate?: (
      cwd: string,
      sessionDir: string,
      options: { parentSession?: string } | undefined,
      adapter: SdkSessionOwnershipAdapter,
    ) => SdkSessionManager;
    preparePieOpen?: (
      sessionPath: string,
      sessionDir: string | undefined,
      cwdOverride: string | undefined,
      adapter: SdkSessionOwnershipAdapter,
    ) => SdkSessionManager;
    preparePieBranched?: (
      source: SdkSessionManager,
      leafId: string,
      adapter: SdkSessionOwnershipAdapter,
    ) => SdkSessionManager;
    preparePieImport?: (
      sourcePath: string,
      destinationPath: string,
      sessionDir: string,
      cwdOverride: string | undefined,
      adapter: SdkSessionOwnershipAdapter,
    ) => SdkSessionManager;
    listAll: (sessionDir?: string) => Promise<SdkSessionInfo[]>;
  };
  createAgentSessionServices: (options: unknown) => Promise<unknown>;
  createAgentSessionFromServices: (options: unknown) => Promise<unknown>;
  createAgentSessionRuntime: (factory: unknown, options: {
    cwd: string;
    agentDir: string;
    sessionManager: SdkSessionManager;
    sessionStartEvent?: SdkSessionEvent;
    ownershipAdapter?: SdkSessionOwnershipAdapter;
    writeLease?: SdkSessionWriteLease;
  }) => Promise<SdkRuntime>;
}

/** Runtime-free SDK surface loaded by an isolated coordinator. Importing this
 * surface must not evaluate the package root, compaction internals, or the
 * AgentSession implementation. */
export type ColdCoordinatorSdkModule = Pick<
  SdkModule,
  'VERSION' | 'getAgentDir' | 'AuthStorage' | 'SessionManager'
> & { ModelRegistry: NonNullable<SdkModule['ModelRegistry']> };

// ─── Loader ──────────────────────────────────────────────────────────────────

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

interface HistoryCompactionUsage {
  tokens: number | null;
  contextWindow: number;
}

type HistoryCompactionModel = NonNullable<SourceSdk.AgentSession['model']>;
type BeforeCompactEvent = Parameters<NonNullable<SourceSdk.CompactionHooks['beforeCompact']>>[0];
type CompactionPolicySession = Pick<SourceSdk.AgentSession,
  'model' | 'thinkingLevel' | 'settingsManager' | 'agent' | 'modelRegistry' | 'getCompactionRequestAuth'>;

export type InterruptedContinuationTail =
  | 'aborted-assistant'
  | 'overflow-assistant'
  | 'open-provider-turn'
  | 'completed-assistant';

/** Classify the transcript boundaries a zero-prompt continuation can resume
 * from. If the provider had started a response, agent-core retains an aborted
 * assistant. If interruption won before the next response started (including
 * after tools completed), the context still ends at a user/tool-result message.
 * A settled turn can also end at a normal completed assistant reply (a stop, or
 * a length stop with delivered output and no dangling tool calls); continuing
 * keeps that reply in the provider context instead of removing it. All are
 * valid zero-prompt continuation points. Arbitrary provider errors that are
 * not classified as context overflow remain non-continuable. */
export function classifyInterruptedContinuationTail(
  messages: unknown,
  contextWindow?: number,
): InterruptedContinuationTail | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object') return undefined;
  const role = (last as { role?: unknown }).role;
  if (role === 'user' || role === 'toolResult') return 'open-provider-turn';
  if (role !== 'assistant') return undefined;
  const assistant = last as ContinuationAssistantMessage;
  if (assistant.stopReason === 'aborted') return 'aborted-assistant';
  if (isContextOverflowMessage(assistant as MessageLike, contextWindow)) return 'overflow-assistant';
  if ((assistant.stopReason === 'stop' || assistant.stopReason === 'length')
      && !hasAssistantToolCall(assistant)) return 'completed-assistant';
  return undefined;
}

function readLiveHistoryCompactionSettings(): HistoryCompactionSettings | undefined {
  const raw = process.env[HISTORY_COMPACTION_ENV];
  if (!raw) return undefined;
  try {
    return resolveHistoryCompactionSettings(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function historyCompactionModelKey(model: Pick<HistoryCompactionModel, 'provider' | 'id'> | undefined): string | undefined {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
}

function effectiveHistoryCompactionSettings(
  settings: HistoryCompactionSettings,
  model: Pick<HistoryCompactionModel, 'provider' | 'id'> | undefined,
): HistoryCompactionSettings {
  const key = historyCompactionModelKey(model);
  if (!key) return settings;
  const effective = resolveHistoryCompactionEffectiveSettings(settings, key);
  return { ...settings, ...effective };
}

/** Pure threshold decision shared by the source policy and workers. */
export function shouldRunHistoryCompaction(
  settings: HistoryCompactionSettings | undefined,
  usage: HistoryCompactionUsage | undefined,
  trigger: 'soft' | 'hard',
  model?: Pick<HistoryCompactionModel, 'provider' | 'id'>,
): boolean {
  if (!settings?.enabled || !usage || usage.tokens === null || usage.contextWindow <= 0) return false;
  const effective = effectiveHistoryCompactionSettings(settings, model);
  return usage.tokens >= resolveHistoryCompactionThresholdTokens(effective, usage.contextWindow, trigger);
}

interface ContinuationAssistantMessage {
  stopReason?: string;
  content?: unknown[];
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
  };
}

function hasAssistantToolCall(message: ContinuationAssistantMessage | undefined): boolean {
  return Array.isArray(message?.content)
    && message.content.some((part) =>
      !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'toolCall');
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

type CustomizedCompactionDecision =
  | { compaction: SourceSdk.CompactionResult }
  | { cancel: true };

function blockActiveModelCompactionFallback(
  settings: HistoryCompactionSettings,
  activeModel: HistoryCompactionModel | undefined,
  reason: string,
): CustomizedCompactionDecision | undefined {
  if (!settings.summaryModel) return undefined;
  backendWarn('backend-history-compaction', 'configured-summary-model-fallback-blocked', {
    reason,
    configuredProvider: settings.summaryModel.provider,
    configuredModelId: settings.summaryModel.id,
    activeProvider: activeModel?.provider,
    activeModelId: activeModel?.id,
  });
  return { cancel: true };
}

async function createCustomizedCompaction(
  sdk: Pick<SdkModule, 'prepareCompaction' | 'compact'>,
  session: CompactionPolicySession,
  event: BeforeCompactEvent,
): Promise<CustomizedCompactionDecision | undefined> {
  const activeModel = session.model;
  const settings = readLiveHistoryCompactionSettings();
  if (!settings) {
    backendWarn('backend-history-compaction', 'active-model-fallback-blocked', {
      reason: 'history-compaction-policy-unavailable',
      activeProvider: activeModel?.provider,
      activeModelId: activeModel?.id,
    });
    return { cancel: true };
  }

  const prepareCompaction = sdk.prepareCompaction;
  const compact = sdk.compact;
  const nativeSettings = session.settingsManager?.getCompactionSettings();
  if (!prepareCompaction || !compact || !activeModel || !nativeSettings) {
    return blockActiveModelCompactionFallback(settings, activeModel, 'custom-compactor-unavailable');
  }

  const effective = effectiveHistoryCompactionSettings(settings, activeModel);
  const preparation = prepareCompaction(event.branchEntries, {
    ...nativeSettings,
    keepRecentTokens: effective.keepRecentTokens,
  });
  if (!preparation) {
    return blockActiveModelCompactionFallback(settings, activeModel, 'custom-preparation-unavailable');
  }

  let summaryModel = activeModel;
  if (settings.summaryModel) {
    const selected = session.modelRegistry?.find(settings.summaryModel.provider, settings.summaryModel.id);
    if (!selected) {
      return blockActiveModelCompactionFallback(settings, activeModel, 'configured-model-unavailable');
    }
    summaryModel = selected;
  }
  if (!session.getCompactionRequestAuth) {
    return blockActiveModelCompactionFallback(settings, activeModel, 'compaction-auth-unavailable');
  }

  try {
    const auth = await session.getCompactionRequestAuth(summaryModel);
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
      compaction: {
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
      },
    };
  } catch {
    // With an explicit summary model, fail closed: delegating would make pi
    // silently issue the summary request to the active (potentially costly)
    // chat model. Native fallback remains available only when the user chose
    // "Active model" for summaries.
    return blockActiveModelCompactionFallback(settings, activeModel, 'configured-model-request-failed');
  }
}

/** Source factories preserve authoritative typed ownership and policy options. */
export type SourceArtifactSdkModule = Omit<typeof SourceSdk,
  'createAgentSession' | 'createAgentSessionFromServices' | 'createAgentSessionRuntime'> & {
  createAgentSession: (options?: SourceSdk.CreateAgentSessionOptions) => Promise<SourceSdkPolicyFactoryResult<SourceSdk.CreateAgentSessionResult>>;
  createAgentSessionFromServices: (options: SourceSdk.CreateAgentSessionFromServicesOptions) => Promise<SourceSdkPolicyFactoryResult<SourceSdk.CreateAgentSessionResult>>;
  createAgentSessionRuntime: (factory: SourceSdk.CreateAgentSessionRuntimeFactory, options: SourceSdk.CreateAgentSessionRuntimeOptions) =>
    Promise<Omit<SourceSdk.AgentSessionRuntime, 'session'> & { session: SourceSdkPolicyFactoryResult<SourceSdk.CreateAgentSessionResult>['session'] }>;
};

export interface SourceSdkLoadMode {
  mode: 'source-artifact';
  descriptor: unknown;
  backendTarget: PiRuntimeTarget;
  surface?: 'cold' | 'full';
}

export type SdkLoadMode = SourceSdkLoadMode;

export async function loadSdk(
  sdkPath: string,
  mode: SourceSdkLoadMode & { surface?: 'full' },
): Promise<SourceArtifactSdkModule>;
export async function loadSdk(
  sdkPath: string,
  mode: SourceSdkLoadMode & { surface: 'cold' },
): Promise<ColdCoordinatorSdkModule>;
export async function loadSdk(
  sdkPath: string,
  mode: SdkLoadMode,
): Promise<ColdCoordinatorSdkModule | SourceArtifactSdkModule>;
export async function loadSdk(
  sdkPath: string,
  mode: SdkLoadMode,
): Promise<ColdCoordinatorSdkModule | SourceArtifactSdkModule> {
  return loadSourceSdk(sdkPath, mode);
}

function assertSourceLoadMode(mode: SourceSdkLoadMode): void {
  if (!mode || mode.mode !== 'source-artifact') {
    throw new TypeError('An explicit source-artifact SDK descriptor selection is required.');
  }
  if (mode.surface !== undefined && mode.surface !== 'cold' && mode.surface !== 'full') {
    throw new TypeError('Source SDK surface must be cold or full.');
  }
}

async function verifiedSourceSdkPath(sdkPath: string, mode: SourceSdkLoadMode): Promise<string> {
  assertSourceLoadMode(mode);
  if (!mode.backendTarget) throw new TypeError('An explicit source SDK backend target is required.');
  const executingTarget: PiRuntimeTarget = {
    platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
  };
  for (const key of ['platform', 'arch', 'nodeAbi'] as const) {
    if (mode.backendTarget[key] !== executingTarget[key]) {
      throw new Error(`Source SDK backend target.${key} mismatch with executing process.`);
    }
  }
  const descriptor = await verifySdkRuntimeArtifactDescriptor(mode.descriptor, mode.backendTarget);
  if (!path.isAbsolute(sdkPath) || await realpath(sdkPath) !== descriptor.sdkPath) {
    throw new Error('Explicit SDK path does not match the verified source artifact.');
  }
  return descriptor.sdkPath;
}

async function sourceInternalPath(sdkPath: string, relativePath: string): Promise<string> {
  const dist = await realpath(path.join(sdkPath, 'dist'));
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error('Source SDK internal path must be relative to dist.');
  }
  const candidate = path.resolve(dist, relativePath);
  const contained = (entry: string) => {
    const relative = path.relative(dist, entry);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!contained(candidate)) throw new Error('Source SDK internal path escapes dist containment.');
  const canonical = await realpath(candidate);
  if (!contained(canonical)) throw new Error('Source SDK internal path escapes canonical dist containment.');
  return canonical;
}

async function loadSourceSdk(sdkPath: string, mode: SourceSdkLoadMode): Promise<SourceArtifactSdkModule | ColdCoordinatorSdkModule> {
  const verifiedPath = await verifiedSourceSdkPath(sdkPath, mode);
  const policy = createSourceSdkPolicyAdapter({
    readHistoryCompactionSettings: readLiveHistoryCompactionSettings,
    beforeCompact: (event, session) => createCustomizedCompaction(compaction, session, event),
  });
  const compaction: Pick<SdkModule, 'prepareCompaction' | 'compact'> = {};
  let exports: Partial<SdkModule>;
  if (mode.surface === 'cold') {
    const [config, auth, models, sessions] = await Promise.all([
      'config.js', 'core/auth-storage.js', 'core/model-registry.js', 'core/session-manager.js',
    ].map(async (entry) => dynamicImport(pathToFileURL(await sourceInternalPath(verifiedPath, entry)).href))) as Partial<SdkModule>[];
    exports = { VERSION: config.VERSION, getAgentDir: config.getAgentDir, AuthStorage: auth.AuthStorage,
      ModelRegistry: models.ModelRegistry, SessionManager: sessions.SessionManager };
  } else {
    exports = await dynamicImport(pathToFileURL(await sourceInternalPath(verifiedPath, 'index.js')).href) as Partial<SdkModule>;
  }
  if (typeof exports.VERSION !== 'string' || typeof exports.getAgentDir !== 'function'
      || typeof exports.AuthStorage?.create !== 'function' || typeof exports.ModelRegistry?.create !== 'function'
      || ['create', 'open', 'forkFrom', 'listAll', 'inMemory', 'continueRecent'].some(key =>
        typeof (exports.SessionManager as unknown as Record<string, unknown>)?.[key] !== 'function')) {
    throw new Error(`SDK at ${verifiedPath} is missing required cold coordinator exports.`);
  }
  const manager = exports.SessionManager as unknown as typeof SourceSdk.SessionManager;
  if (typeof manager.prototype.setContextMessageOmissionsResolver !== 'function') {
    throw new Error('Source SDK is missing initial context projection support.');
  }
  // Return a constructor facade, never alter the imported class/prototype.
  const managerFacade = new Proxy(manager, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || !['create', 'open', 'inMemory', 'continueRecent', 'forkFrom',
        'preparePieCreate', 'preparePieOpen', 'preparePieBranched', 'preparePieImport'].includes(key)
          || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const instance = Reflect.apply(value, target, args) as SourceSdk.SessionManager;
        instance.setContextMessageOmissionsResolver(policy.contextMessageOmissions());
        return instance;
      };
    },
  });
  const adapted = { ...exports, SessionManager: managerFacade };
  if (mode.surface === 'cold') return adapted as unknown as ColdCoordinatorSdkModule;
  const source = exports as unknown as typeof SourceSdk;
  if (typeof source.createAgentSession !== 'function'
      || typeof source.createAgentSessionServices !== 'function'
      || typeof source.createAgentSessionFromServices !== 'function'
      || typeof source.createAgentSessionRuntime !== 'function'
      || typeof source.AgentSession?.prototype.continueAfterInterruption !== 'function'
      || typeof source.AgentSession?.prototype.getCompactionRequestAuth !== 'function'
      || typeof source.prepareCompaction !== 'function' || typeof source.compact !== 'function') {
    throw new Error(`SDK at ${verifiedPath} is missing required source exports.`);
  }
  Object.assign(compaction, { prepareCompaction: source.prepareCompaction, compact: source.compact });
  return {
    ...adapted,
    createAgentSession: (options: SourceSdk.CreateAgentSessionOptions = {}) =>
      policy.wrapFactory(source.createAgentSession)(options),
    createAgentSessionFromServices: policy.wrapFactory(source.createAgentSessionFromServices),
    createAgentSessionRuntime: (factory: SourceSdk.CreateAgentSessionRuntimeFactory, options: SourceSdk.CreateAgentSessionRuntimeOptions) =>
      source.createAgentSessionRuntime(policy.wrapContinuationFactory(factory), {
        ...options,
        contextMessageOmissions: policy.contextMessageOmissions(options.contextMessageOmissions),
        compactionHooks: policy.compactionHooks(options.compactionHooks),
      }),
  } as unknown as SourceArtifactSdkModule;
}

export async function loadSdkInternalModule<TModule>(
  sdkPath: string,
  relativePath: string,
  mode: SdkLoadMode,
): Promise<TModule> {
  const verifiedPath = await verifiedSourceSdkPath(sdkPath, mode);
  const entry = await sourceInternalPath(verifiedPath, relativePath);
  return await dynamicImport(pathToFileURL(entry).href) as TModule;
}
