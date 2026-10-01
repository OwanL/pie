import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { sessionMcpOverridePath } from '../../session-storage/settings/mcp-session-config';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { BoundedEventLoopHistogram } from '../../../lib/structured-logging/live-pipeline-trace';
import { resolveSessionIdentity } from '../../session-storage/ownership/session-identity';
import { resolvePieDataPaths } from '../../../lib/data-root/pie-data-root.js';
import { cleanupSessionTempOutputManifests } from '../../../lib/temporary-files/session-temp-output-lifecycle.js';
import { BackendAnalyticsActivation } from '../../../analytics/authority/backend-analytics-activation.js';
import type { AnalyticsBackendDescriptor } from '../../../analytics/authority/activation.js';
import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES } from '../lib/rpc/jsonl.js';
import { toErrorMessage, parseJsonOrThrow } from '../../../lib/structured-logging/error-message';
import { updateSettingsJsonObject } from '../../../lib/temporary-files/settings-json-update';
import { boundTranscriptSnapshot } from '../../session-storage/transcripts/snapshot-boundary.js';
import { projectSessionControlTranscript } from './session-control-transcript.js';
import { WorkerRequestTimeoutError } from '../lib/rpc/worker-client.js';
import {
  STORAGE_CUTOFF_AUTHORIZATION_ENV,
  STORAGE_CUTOFF_AUTHORIZATION_VALUE,
} from '../../../analytics/authority/storage-cutoff-authorization';
import { PROTOCOL_VERSION } from '../lib/rpc/wire.js';
import type { RequestEnvelope } from '../lib/rpc/wire.js';
import {
  AGENT_SESSION_MESSAGE_LOCAL_ID_PREFIX,
  type DetailResult,
  type LazyDetailRef,
} from '../lib/rpc/message-contract.js';
import type { ModelSettings } from '../../model-providers/catalog/model-contract.js';
import { isThinkingLevel, type ThinkingLevel } from '../../model-providers/catalog/thinking-level.js';
import type {
  AgentMessagePayload,
  SessionCloseRequestedPayload,
  SessionCloseResponseDeliveredPayload,
  SessionListChangedPayload,
  SessionOpenedPayload,
  SessionSummary,
  TranscriptPageDirection,
  TranscriptPagePayload,
} from '../lib/rpc/session-events.js';
import type { SessionCloseAcknowledgementParams } from '../lib/rpc/backend-rpc.js';
import type {
  HostLiveMembershipSnapshotParams,
  LiveSessionClosingEntry,
  LiveSessionMembershipEntry,
} from '../lib/rpc/live-session-control.js';
import {
  SESSION_CONTROL_SETTINGS_REQUEST_EVENT,
  validateSessionControlSettingsAcknowledgement,
  validateSessionControlSettingsRequest,
  type SessionControlExecutionSettings,
  type SessionControlExecutionSettingsPatch,
  type SessionControlSettingsAcknowledgement,
} from '../lib/rpc/session-control-settings.js';
import {
  createSessionControlSender,
  isSessionControlSender,
  parseSessionReplyReference,
  type SessionControlSender,
  type SessionControlSenderIdentity,
} from '../lib/rpc/session-control-attribution.js';
import { PIE_BUILD_ID } from '../../../lib/build-identity.js';
import { getDefaultAuthDir, ensureDir, isInsideGitWorkTree, migrateAuthFile } from '../../model-providers/authentication/auth.js';
import {
  formatInterruptWatchdogDuration,
  handleBackendRequest,
  parseLivePipelineToggleParams,
  waitForSessionTransition,
  type ModelSettingsUnsetKey,
  type SessionOpenTimingSample,
  type TranscriptPageLoadOptions,
} from './request-handler.js';
import {
  validateDetailFetch,
  validateDetailSubscribe,
  validateDetailUnsubscribe,
  validateMessageEdit,
  validateMessageInterrupt,
  validateOperationStatus,
  validateSessionTitleGenerate,
  validateSettingsSet,
  validateSystemPromptTogglesSet,
  validateTruncateAfter,
  type MessageEditParams,
  type DetailFetchParams,
  type DetailSubscribeParams,
  type DetailUnsubscribeParams,
} from '../lib/rpc/backend-rpc.js';
import { backendSessionPathKey, resolveBackendSessionDir, statBackendSessionFile } from '../../session-storage/catalog/session-directory';
import {
  loadAvailableModels,
  loadConfiguredModels,
} from '../../model-providers/catalog/model-catalog';
import { SessionCatalog } from '../../session-storage/catalog/session-catalog';
import { forgetLegacyReviewArtifacts } from '../../session-storage/lifecycle/legacy-review-artifact-cleanup';
import { SessionLifecycleStore, type LifecycleArtifactRecord } from '../../session-storage/lifecycle/session-lifecycle-store';
import {
  SessionExpiryScheduler,
  SessionFilesystemMutationBarrier,
  SessionLifecycleCleaner,
  filesystemArtifactIdentity,
  verifyFilesystemArtifactIdentity,
} from '../../session-storage/lifecycle/session-filesystem-lifecycle';
import {
  isSystemPromptTogglePersistenceAvailable,
  readSystemPromptTogglesForSession,
  writeSystemPromptTogglesForSession,
} from '../../session-storage/settings/session-settings-store';
import {
  ensureSdkPatchBarrier,
  loadSdk,
  type ColdCoordinatorSdkModule,
  type SdkAuthStorage,
  type SdkModelRegistry,
} from '../lib/sdk-integration/sdk';
import { verifySdkRuntimeSelection, sdkRuntimeLoadMode, type SdkRuntimeSelection } from '../lib/sdk-integration/sdk-runtime-selection';
import { ProviderGate, type ProviderConcurrencyConfig } from '../../model-providers/concurrency/provider-gate.js';
import { resolveProviderMaxConcurrentRequests } from '../../model-providers/concurrency/provider-concurrency.js';
import { markDisabledEntries } from '../../agent-instructions/prompt-assembly/system-prompts.js';
import { CreateOperationLedger } from './create-operation-ledger.js';
import {
  canonicalEditIntentFingerprint,
  SendOperationLedger,
  type SendOperationAcceptance,
} from './send-operation-ledger.js';
import {
  canonicalInterruptIntentFingerprint,
  InterruptOperationLedger,
  type InterruptOperationResult,
} from './interrupt-operation-ledger.js';
import {
  BackendError,
  extractRequestError,
  isExpectedSessionOperationCancellation,
  log,
  responseError,
  responseOk,
  writeStdout,
} from './server-io.js';
import {
  flushBackendLivePipelineTrace,
  getBackendLivePipelineTraceHealth,
  isBackendLivePipelineTraceEnabled,
  recordBackendLivePipelineTrace,
  setBackendLivePipelineTraceEnabled,
} from './live-pipeline-trace-runtime.js';
import {
  type SessionContextCreationReason,
} from './server-types.js';
import { backendTrace, backendError, backendInfo, backendWarn, backendLog } from '../../../lib/structured-logging/backend-log.js';
import { classifyWorkerDiagnosticChunk } from '../lib/process-lifecycle/worker-diagnostics.js';
import { isCoordinatorOperationAllowed } from './coordinator-operations.js';
import { ColdSessionStore, StaleColdSessionLeaseError, type ColdSessionManagerHandle } from '../../session-storage/lifecycle/cold-session-store';
import { ColdBrowseHelperClient } from '../cold-browse-helper/cold-browse-helper-client';
import { InitialContextEstimateClient } from '../context-inventory/initial-context-estimate-client.js';
import { DurableDetailStore, type ResolvedDurableDetail } from '../../session-storage/transcripts/durable-detail-store';
import type { BackendDetailFence, LiveSubagentDetailAddress } from '../lib/rpc/subagent-detail';
import { WorkerSupervisor } from '../lib/process-lifecycle/worker-supervisor.js';
import { SessionOwnershipAuthority } from '../../session-storage/ownership/session-ownership-authority';
import { WorkerRuntimeRouter } from './worker-runtime-router.js';
import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../../session-storage/metadata/session-name';
import { readIndexedSessionMetadata } from '../../session-storage/metadata/session-metadata';
import {
  type LiveSessionTitleEntry,
  LiveSessionTitleReservation,
  LiveSessionTitles,
  LiveTitleNamespaceUnavailableError,
  normalizeSessionControlBaseTitle,
} from './live-session-titles.js';

import type {
  WorkerJsonObject,
  WorkerJsonValue,
  WorkerSessionControlAction,
  WorkerSessionControlFrame,
} from '../lib/rpc/worker-protocol.js';
import type { WorkerSessionControlOutcome } from './worker-runtime-router.js';

const ISOLATED_PROMOTION_METHODS = new Set([
  'message.send',
  'message.continue',
  'message.compact',
]);
/** Keep a transition-bound Stop below the host's 15-second RPC deadline. */
const INTERRUPT_TRANSITION_WAIT_MS = 10_000;
const AGENT_SESSION_CONTROL_MAX_LIST_ITEMS = 256;
const AGENT_SESSION_CONTROL_MAX_RESULT_BYTES = 192 * 1024;
const AGENT_SESSION_CONTROL_MAX_MESSAGE_BYTES = 64 * 1024;
const LIVE_TITLE_NAMESPACE_RETRY_BASE_DELAY_MS = 100;
const LIVE_TITLE_NAMESPACE_RETRY_MAX_DELAY_MS = 5_000;
const LIVE_TITLE_NAMESPACE_RETRY_LIMIT = 5;

/** Coordinator-side state for one outgoing host close request. `accepted`
 *  resolves once the host has taken ownership of the close; `settled` resolves
 *  exactly once with the typed terminal phase. Joiners share the same owner. */
interface HostCloseRequestEntry {
  sessionPath: string;
  requestId: string;
  delete: boolean;
  acceptPromise: Promise<boolean>;
  settlePromise: Promise<HostCloseOutcome>;
  accept?: (ok: boolean) => void;
  settle?: (outcome: HostCloseOutcome) => void;
  /** Set once at terminal settlement so duplicate settle calls are no-ops. */
  settled?: boolean;
  /** Set when the host acknowledged the request; an accepted entry keeps its
   *  admission fence and terminal-ack budget alive past a self-close return
   *  until the terminal acknowledgement or its timeout arrives. */
  accepted?: boolean;
  handoffRequired?: boolean;
  handoffReleased?: boolean;
  handoffTimer?: ReturnType<typeof setTimeout>;
  timers?: ReturnType<typeof setTimeout>[];
}

/** Terminal phases acknowledged by the host close bridge. `unknown` covers a
 *  missing acknowledgement; it is never converted into success. */
interface HostCloseOutcome {
  phase: 'completed' | 'failed' | 'unknown';
  error?: string;
}

interface HostSessionSettingsRequestEntry {
  sessionPath: string;
  action: 'capture' | 'apply';
  resolve: (acknowledgement: SessionControlSettingsAcknowledgement | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentSessionModelChoice {
  provider: string;
  id: string;
}

interface AgentSessionSettingsPatch {
  model?: AgentSessionModelChoice;
  reasoning?: ThinkingLevel;
  autonomousMode?: boolean;
  subagentProviderChoices?: Record<string, boolean>;
  disabledSystemPromptEntries?: string[];
}

interface AgentSessionSettingsSnapshot extends SessionControlExecutionSettings {
  model: AgentSessionModelChoice;
  reasoning: ThinkingLevel;
  disabledSystemPromptEntries: string[];
}

const HOST_SESSION_SETTINGS_ACK_TIMEOUT_MS = 20_000;
const HOST_SESSION_SETTINGS_ERROR_MAX_CHARS = 1_000;
const AGENT_SESSION_SETTINGS_MAX_DISABLED_PROMPTS = 256;

function workerJson(value: unknown): WorkerJsonValue {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? null : JSON.parse(serialized)) as WorkerJsonValue;
}

function boundedAgentString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

/** Live worker detail errors that mean the worker no longer retains the
 *  source and the durable JSONL is authoritative. */
function isLiveDetailGoneError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.startsWith('NOT_FOUND:') || error.message.startsWith('NOT_LIVE_ADDRESSABLE:'));
}

function requestSessionPath(params: unknown): string | undefined {
  return params && typeof params === 'object' && !Array.isArray(params)
    && typeof (params as { sessionPath?: unknown }).sessionPath === 'string'
    ? (params as { sessionPath: string }).sessionPath
    : undefined;
}

export function extractPreviewRequestId(preview: string): string | undefined {
  const match = /"id"\s*:\s*"([^"\\]{1,200})"/.exec(preview);
  return match?.[1];
}

/** Build id used by the durable analytics writer identity.
 *
 * Durable admission compares the backend's writer identity against the
 * registered lifecycle host row byte-for-byte (`assertRegisteredWriterIdentity`
 * via `sameWriterIdentity`), and that row carries the **loaded runtime's own
 * coordinated marker** — the value the extension host registers and
 * authenticates with. It is deliberately NOT the activation descriptor's
 * `buildId`: that is the manifest / qualification identity, which the
 * two-space convention (a plan bound to a source-equivalence receipt, where
 * `plan.buildId` must be the qualification's coordinated build id and
 * `candidateBuildId` the staged marker) makes a different value. Using the
 * descriptor id here would make every writer inadmissible and stall startup.
 *
 * Both host and backend bundles of one runtime generation compile the same
 * `PIE_BUILD_ID`, so this is exactly the marker the host registered. */
export function analyticsWriterBuildId(): string {
  return PIE_BUILD_ID;
}

/** Simple stopwatch for backend timing probes. */
function timed<T>(label: string, op: () => T): T;
function timed<T>(label: string, op: () => Promise<T>): Promise<T>;
function timed<T>(label: string, op: () => T | Promise<T>): T | Promise<T> {
  const start = Date.now();
  const traceFailure = (error: unknown): void => {
    if (isExpectedSessionOperationCancellation(error)) {
      backendTrace('timing', 'op.cancelled', {
        code: error.code,
        durationMs: Date.now() - start,
        label,
      });
      return;
    }
    backendTrace('timing', 'op.failed', { level: 'warn', label, durationMs: Date.now() - start, error: toErrorMessage(error) });
  };
  const finish = (result: T | Promise<T>): T | Promise<T> => {
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          backendTrace('timing', 'op.completed', { label, durationMs: Date.now() - start });
          return value;
        },
        (error) => {
          traceFailure(error);
          throw error;
        },
      );
    }
    backendTrace('timing', 'op.completed', { label, durationMs: Date.now() - start });
    return result;
  };
  try {
    return finish(op());
  } catch (error) {
    traceFailure(error);
    throw error;
  }
}

/** Convert models.json concurrency declarations into the JSON policy shared by
 * the real cross-worker admission authority. URL prefixes stay in the payload
 * so workers can classify internal pruning/failover fetches by their actual
 * destination instead of blindly charging the root session's provider. */
export function providerPoliciesFromConfigs(configs: readonly ProviderConcurrencyConfig[]): WorkerJsonObject {
  return Object.fromEntries(configs.map((config) => {
    const maxLimit = resolveProviderMaxConcurrentRequests(undefined, config.maxConcurrentRequests);
    return [config.provider, {
      maxConcurrentRequests: maxLimit.value,
      maxConcurrentRequestsSource: maxLimit.source,
      queueWaitSeconds: config.queueWaitSeconds ?? 30,
      headerWaitSeconds: (config.headerWaitSeconds ?? 0) > 0 ? config.headerWaitSeconds! : 120,
      streamIdleTimeoutSeconds: 120,
      afterburnSeconds: config.afterburnSeconds ?? 0,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.baseUrls && config.baseUrls.length > 0 ? { baseUrls: [...config.baseUrls] } : {}),
    }];
  })) as WorkerJsonObject;
}

export function mergeProviderPolicies(base: WorkerJsonObject, overrides: unknown): WorkerJsonObject {
  const overrideMap = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    ? overrides as WorkerJsonObject
    : {};
  const providers = new Set([...Object.keys(base), ...Object.keys(overrideMap)]);
  return Object.fromEntries([...providers].map((provider) => {
    const basePolicy = base[provider];
    const override = overrideMap[provider];
    const baseRecord = basePolicy && typeof basePolicy === 'object' && !Array.isArray(basePolicy)
      ? basePolicy as WorkerJsonObject
      : {};
    const overrideRecord = override && typeof override === 'object' && !Array.isArray(override)
      ? override as WorkerJsonObject
      : {};
    const maxLimit = resolveProviderMaxConcurrentRequests(
      overrideRecord.maxConcurrentRequests,
      baseRecord.maxConcurrentRequests,
    );
    const normalizedOverride = { ...overrideRecord };
    delete normalizedOverride.maxConcurrentRequests;
    // Provenance is derived here; settings cannot supply or retain stale source metadata.
    delete normalizedOverride.maxConcurrentRequestsSource;
    // Public settings use zero to mean "restore the provider default" for the
    // header phase. Resolve that against the current models.json base snapshot,
    // not whichever older override happens to be installed in the authority.
    if (normalizedOverride.headerWaitSeconds === 0) delete normalizedOverride.headerWaitSeconds;
    return [provider, {
      ...baseRecord,
      ...normalizedOverride,
      maxConcurrentRequests: maxLimit.value,
      maxConcurrentRequestsSource: maxLimit.source,
    }];
  })) as WorkerJsonObject;
}

/** Module-level guard: install the fatal handlers at most once even if
 *  `start()` is invoked more than once. */
let backendFatalHandlersInstalled = false;
const SESSION_CATALOG_POLL_INTERVAL_MS = 10_000;

interface PreparedViewedSessionTransition {
  changed: boolean;
  revision: number;
  hadPrevious: boolean;
  previous?: string;
}

function modelSettingsFromRecord(
  parsed: Partial<ModelSettings> | Record<string, unknown>,
  defaults: ModelSettings,
): ModelSettings {
  const result: ModelSettings = {
    defaultModel: typeof parsed.defaultModel === 'string' ? parsed.defaultModel : defaults.defaultModel,
    defaultThinkingLevel: typeof parsed.defaultThinkingLevel === 'string'
      ? parsed.defaultThinkingLevel as ThinkingLevel
      : defaults.defaultThinkingLevel,
  };
  if (typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.length > 0) {
    result.defaultProvider = parsed.defaultProvider;
  }
  return result;
}

function sameModelSettings(left: ModelSettings, right: ModelSettings): boolean {
  return left.defaultModel === right.defaultModel
    && left.defaultThinkingLevel === right.defaultThinkingLevel
    && left.defaultProvider === right.defaultProvider;
}

function applyModelSettingsMutation(
  existing: Record<string, unknown>,
  updates: Partial<ModelSettings>,
  unset: readonly ModelSettingsUnsetKey[] = [],
): Record<string, unknown> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
    if (value === undefined || (key === 'defaultProvider' && value === null)) delete next[key];
    else next[key] = value;
  }
  for (const key of unset) delete next[key];
  return next;
}

/** Surface swallowed promise rejections and uncaught exceptions on stderr (the
 *  host captures backend stderr) instead of letting them die invisibly. We
 *  deliberately do NOT `process.exit` — the host's backend-exit detection
 *  owns crash handling; this only prevents silent invisibility. */
function installBackendFatalHandlers(): void {
  if (backendFatalHandlersInstalled) return;
  backendFatalHandlersInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? String(reason.stack ?? reason) : String(reason);
    backendError('backend', 'unhandledRejection', { error });
  });
  process.on('uncaughtException', (err) => {
    const error = err instanceof Error ? String(err.stack ?? err) : String(err);
    backendError('backend', 'uncaughtException', { error });
  });
  // Node's default warning text omits the creation stack in normal runs. Keep a
  // structured copy so listener leaks and deprecations point to the call site
  // that created them rather than only reporting the final listener count.
  process.on('warning', (warning) => {
    backendWarn('backend', 'process.warning', {
      warningName: warning.name,
      message: warning.message,
      stack: warning.stack,
      listenerCounts: {
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
        exit: process.listenerCount('exit'),
        warning: process.listenerCount('warning'),
      },
    });
  });
}

export class BackendServer {
  private sdk!: ColdCoordinatorSdkModule;
  private readonly sdkPath: string;
  private readonly sourceArtifactDescriptor: unknown;
  private sdkRuntime!: SdkRuntimeSelection;
  private readonly startupCwd: string;
  /** Host-authoritative generation shared by backend, coordinator, worker, and detail fences. */
  private readonly backendGeneration: number;
  /** Analytics descriptor validation + writer-admission/fence supervision,
   * owned by the analytics authority module behind the prepared port. When a
   * canonical descriptor is present, startup validates it against the active
   * manifest before any worker route can be promoted. */
  private analyticsAuthority?: BackendAnalyticsActivation;
  private sessionDir?: string;
  private sessionDirResolved = false;
  private agentDir = '';
  private authStorage?: SdkAuthStorage;
  /** Runtime-free coordinator registry used for cold-session catalog
   * hydration. This preserves built-in providers represented by
   * `modelOverrides` without creating an AgentSession in the coordinator. */
  private modelRegistry?: SdkModelRegistry;
  private viewedSessionPath?: string;
  /** Monotonic fence preventing a slow session.open from overwriting a newer
   * host-local visual transition after its durable read completes. */
  private viewedSessionRevision = 0;
  private runtimePrefs: WorkerJsonObject = {};
  /** models.json is the baseline provider policy. Runtime preferences are
   * sparse overrides and must never erase these configured capacities. */
  private providerBasePolicies: WorkerJsonObject = {};
  private readonly sessionCatalog: SessionCatalog;
  /** One runtime-free store is installed after SDK load and shares the
   * coordinator generation/catalog/settings authority. */
  private coldSessionStore?: ColdSessionStore;
  /** Newly created/forked/truncated managers remain process-local and are
   * transferred exactly once on first legacy promotion. Keys are normalized
   * only for ownership lookup; public paths retain their original spelling. */
  private readonly coldSessionManagerHandles = new Map<string, {
    handle: ColdSessionManagerHandle;
    creationReason: SessionContextCreationReason;
  }>();
  /** Cold destructive mutations reserve their path before the first await so
   * promotion cannot install a writer while truncate/forget owns the file. */
  private readonly pendingColdSessionMutations = new Map<string, Promise<unknown>>();
  /** Distinct public duplicate operations against one source execute in receipt
   * order. A hot duplicate rekeys its worker to the first destination; only
   * after that transfer settles may the next request reselect the original
   * source as cold and create its own destination. */
  private readonly pendingSessionDuplicates = new Map<string, Promise<unknown>>();
  /** Non-serialized generation stamp checked synchronously at correlated stdout
   * publication, after the request handler's final await has unwound. */
  private readonly browseResponseOwners = new WeakMap<object, {
    sessionPath: string;
    fingerprint?: string;
  }>();
  /** Predecessor captured when a cold session first becomes viewed. Promotion
   * consumes this immutable identity instead of rereading viewedSessionPath. */
  private readonly browsePreviousSessionFiles = new Map<string, string | undefined>();
  /** Paths currently being forgotten; prevents a racing open from installing
   *  a runtime after its transcript has been removed. */
  private readonly forgottenSessionPaths = new Set<string>();
  /** P7b lifecycle authority is instantiated only under the explicit inactive-source authorization gate. */
  private lifecycleStore?: SessionLifecycleStore;
  private lifecycleBarrier?: SessionFilesystemMutationBarrier;
  private lifecycleScheduler?: SessionExpiryScheduler;
  private sessionCatalogPollTimer?: ReturnType<typeof setInterval>;
  private sessionCatalogPollingActive = false;
  private sessionCatalogPollInFlight = false;
  /** Auth-file fingerprint baseline; a moved fingerprint refreshes workers. */
  private authFingerprint = '';
  /** models.json fingerprint baseline; a moved fingerprint re-broadcasts the
   *  configured catalog authority to hot workers. */
  private modelsJsonFingerprint = '';

  /** True once `dispose()` has begun. Suppresses stale events and payload
   *  builds from in-flight async paths (recovery replacement emissions, catalog
   *  polling, late SDK events) so a dying backend cannot push post-shutdown
   *  state to a host that is already tearing it down. */
  private disposed = false;
  /** Accepted stdin requests that have not yet completed. EOF-driven restart
   * drains these before disposal so a settings writer cannot be killed while
   * holding the shared settings lock. */
  private readonly inFlightInputRequests = new Set<Promise<void>>();
  /** All shutdown callers join one teardown. A second EOF/watchdog signal must
   * not observe `disposed` and exit while the first caller still owns workers. */
  private disposePromise?: Promise<void>;
  /** Generation/process-scoped create-operation ledger (§6.3): dedupes
   *  concurrent/retried `session.create`/`session.duplicate` by the optional
   *  host-generated `operationId` and retains in-flight and completed durable
   *  results for this backend generation. A backend restart (generation
   *  death) naturally drops the ledger with the process. */
  private readonly createOperationLedger = new CreateOperationLedger();
  /** Coordinator-generation authority for compound edit operations. Unlike a
   * worker send ledger, this survives the edit's deliberate worker replacement
   * and therefore owns both commit evidence and retry replay. */
  private readonly editOperationLedger = new SendOperationLedger();
  private readonly editOperationSessions = new Map<string, string>();
  /** Coordinator-generation Stop authority survives the worker generation it
   * may have to force-retire. */
  private readonly interruptOperationLedger = new InterruptOperationLedger();
  private readonly interruptOperationSessions = new Map<string, string>();
  private readonly workerEntryPath?: string;
  private readonly coldBrowseHelperEntryPath?: string;
  private coldBrowseHelper?: ColdBrowseHelperClient;
  private readonly initialContextEstimateEntryPath?: string;
  private initialContextEstimateClient?: InitialContextEstimateClient;
  private workerSupervisor?: WorkerSupervisor;
  private sessionOwnershipAuthority?: SessionOwnershipAuthority;
  private workerRuntimeRouter?: WorkerRuntimeRouter;
  /** Internal public-request identities used only when a stamped cold
   * `session.opened` must be replayed through the worker that won promotion. */
  private coldPublicationRefreshSequence = 0;
  /** Correlation identity for coordinator-originated hot snapshot commands
   * that are not part of a public request. */
  private workerSnapshotRequestSequence = 0;
  /** Highest coordinator-owned registry revision published to the legacy
   * process env mirror. Broadcast acknowledgements can settle out of order,
   * so completion order must never be allowed to roll this mirror back. */
  private durableDetailStore?: DurableDetailStore;
  private authPath = '';
  private hostWatchdogTimer?: ReturnType<typeof setInterval>;
  private readonly hostPid?: number;
  private readonly lifetimeFd?: number;
  private hostLifetimeStream?: fsSync.ReadStream;
  private hostLossHandled = false;
  private eventLoopDelayMonitor?: ReturnType<typeof monitorEventLoopDelay>;
  private eventLoopHistogram?: BoundedEventLoopHistogram;
  private eventLoopDelayTimer?: ReturnType<typeof setInterval>;
  private eventLoopNextSampleAt?: number;
  /** Request identities whose successful diagnostics off transition must be
   * completed by handleLine after its matching handler_finished record. Each
   * entry also owns the one monitor callback for that transition. */
  private readonly pendingLivePipelineTraceDisables = new Map<string, {
    generation: number;
    onApplied: () => void;
  }>();
  /** Monotonic diagnostics-toggle generation. Advanced once per received
   * toggle request (on or off) at request receipt, so concurrent requests are
   * ordered by receipt, not settlement. A newer request supersedes older
   * deferred off requests without allowing their completion to turn the
   * global trace back off. */
  private livePipelineTraceToggleGeneration = 0;
  /** Outgoing coordinator→host close requests, keyed by the typed bridge
   *  request ID. The host acknowledges through `session.closeAcknowledgement`;
   *  every joiner receives its own self/foreign outcome. */
  private readonly hostCloseRequests = new Map<string, HostCloseRequestEntry>();
  /** Correlated coordinator→host settings capture/apply requests. A missing
   * acknowledgement is unknown; mutations are never retried automatically. */
  private readonly hostSessionSettingsRequests = new Map<string, HostSessionSettingsRequestEntry>();
  private hostSessionSettingsRequestSequence = 0;
  /** Closing-session admission fence, keyed by session path-identity. Present
   *  exactly while one outstanding host-owned close request owns the path. */
  private readonly closingSessionRequests = new Map<string, HostCloseRequestEntry>();
  /** Bounded coordinator budgets for the typed host close bridge. */
  private readonly hostCloseAcceptTimeoutMs: number;
  private readonly hostCloseCompleteTimeoutMs: number;
  private readonly hostCloseHandoffTimeoutMs: number;
  /** Latest ordered host→coordinator live-membership snapshot (in memory
   *  only; never a durable second list). Undefined until the first snapshot
   *  arrives; undefined membership keeps legacy non-host embedders working. */
  private hostMembershipSessions: {
    revision: number;
    sessions: Map<string, { entry: LiveSessionMembershipEntry }>;
  } = { revision: 0, sessions: new Map() };
  private hostMembershipClosing = new Map<string, LiveSessionClosingEntry>();
  private hostMembershipRevision = 0;
  private hostMembershipSeen = false;
  /** Coordinator-owned unique live-title authority (agent session-control
   *  §§1–2). Allocation and publication ownership; no coordinator JSONL write
   *  while a worker owns a session's lease. */
  private readonly liveSessionTitles = new LiveSessionTitles();
  /** Initial namespace hydration from the first complete restored host
   *  membership. The namespace stays unavailable (fail closed) until this
   *  settles; transient failures get a finite, backoff-bounded retry budget. */
  private titleNamespaceHydration?: Promise<void>;
  private titleNamespaceRetryTimer?: ReturnType<typeof setTimeout>;
  private titleNamespaceRetryAttempt = 0;
  private titleAdmission?: Promise<void>;
  private readonly pendingLiveTitlePaths = new Set<string>();
  private readonly newCreatePublicationPaths = new Set<string>();
  private readonly pendingOpenedTitleAdmissions = new Map<string, Promise<void>>();
  /** Live+closing path union of the last snapshot applied after the namespace
   *  became ready, keyed by the membership path key with the public path
   *  spelling captured (a retired session no longer appears in later
   *  snapshots). A session present in the previous set but absent from both
   *  maps of a later complete snapshot is confirmed closed (failed closes
   *  restore membership instead) and releases its assigned title. */
  private authoritativeLiveTitlePaths = new Map<string, string>();

  constructor(options: {
    sdkPath: string;
    /** Explicit candidate opt-in only. Host startup does not supply this. */
    sourceArtifactDescriptor?: unknown;
    cwd: string;
    backendGeneration?: number;
    hostPid?: number;
    lifetimeFd?: number;
    workerEntryPath?: string;
    /** Production explicitly supplies the bundled helper. Direct test
     * constructions remain coordinator-only unless they opt in. */
    coldBrowseHelperEntryPath?: string;
    /** Bundled one-shot full-runtime inventory worker. */
    initialContextEstimateEntryPath?: string;
    /** Test seam for causally blocking a cold catalog operation at the public
     * JSONL/writer boundary. Production always constructs the default. */
    sessionCatalog?: SessionCatalog;
    /** Canonical analytics descriptor from the extension host. */
    analyticsActivation?: AnalyticsBackendDescriptor;
    /** Injected coordinator budgets for the typed host close bridge (tests). */
    hostCloseAcceptTimeoutMs?: number;
    hostCloseCompleteTimeoutMs?: number;
    hostCloseHandoffTimeoutMs?: number;
  }) {
    this.sdkPath = options.sdkPath;
    if (Object.hasOwn(options, 'sourceArtifactDescriptor') && options.sourceArtifactDescriptor === undefined) {
      throw new TypeError('Explicit sourceArtifactDescriptor must not be undefined.');
    }
    this.sourceArtifactDescriptor = options.sourceArtifactDescriptor;
    this.startupCwd = options.cwd;
    this.backendGeneration = options.backendGeneration ?? 1;
    if (!Number.isSafeInteger(this.backendGeneration) || this.backendGeneration <= 0) {
      throw new Error('backendGeneration must be a positive safe integer.');
    }
    this.analyticsAuthority = options.analyticsActivation
      ? new BackendAnalyticsActivation(
          {
            agentDir: () => this.agentDir,
            buildId: analyticsWriterBuildId(),
            hostPid: () => this.hostPid,
          },
          { descriptor: options.analyticsActivation },
        )
      : undefined;
    this.hostPid = options.hostPid;
    this.lifetimeFd = options.lifetimeFd;
    this.hostCloseAcceptTimeoutMs = options.hostCloseAcceptTimeoutMs ?? 15_000;
    this.hostCloseCompleteTimeoutMs = options.hostCloseCompleteTimeoutMs ?? 120_000;
    this.hostCloseHandoffTimeoutMs = options.hostCloseHandoffTimeoutMs ?? 15_000;
    this.workerEntryPath = options.workerEntryPath;
    this.coldBrowseHelperEntryPath = options.coldBrowseHelperEntryPath;
    this.initialContextEstimateEntryPath = options.initialContextEstimateEntryPath;
    this.sessionCatalog = options.sessionCatalog ?? new SessionCatalog({
      onCatalogChanged: () => {
        void this.emitSessionListChanged();
      },
    });
    if (!this.workerEntryPath) {
      throw new Error('The session runtime requires a bundled worker entry path.');
    }
  }

  private getSessionDir(): string | undefined {
    if (!this.sessionDirResolved) {
      this.sessionDir = resolveBackendSessionDir(
        this.agentDir,
        process.env.PI_CODING_AGENT_SESSION_DIR,
      );
      this.sessionDirResolved = true;
    }
    return this.sessionDir;
  }

  private initializeColdSessionStore(): ColdSessionStore {
    this.coldSessionStore ??= new ColdSessionStore({
      sdk: this.sdk,
      coordinatorGeneration: this.backendGeneration,
      startupCwd: this.startupCwd,
      agentDir: this.agentDir,
      sessionDir: this.getSessionDir(),
      sessionCatalog: this.sessionCatalog,
      browseHelper: this.coldBrowseHelper,
      writerAdmission: this.analyticsAuthority?.admission,
    });
    return this.coldSessionStore;
  }

  private coldManagerKey(sessionPath: string): string {
    return backendSessionPathKey(sessionPath);
  }

  private retainColdSessionManager(
    handle: ColdSessionManagerHandle,
    creationReason: SessionContextCreationReason,
  ): void {
    const key = this.coldManagerKey(handle.sessionPath);
    if (this.coldSessionManagerHandles.has(key)) {
      throw new BackendError('SESSION_OWNERSHIP_CONFLICT', `A cold manager is already retained for ${handle.sessionPath}.`);
    }
    this.coldSessionManagerHandles.set(key, { handle, creationReason });
  }

  private async runColdSessionMutation<T>(
    sessionPath: string,
    operation: () => Promise<T>,
    lifecycleAdministrative = false,
  ): Promise<T> {
    const key = this.coldManagerKey(sessionPath);
    if (this.pendingColdSessionMutations.has(key)) {
      throw new BackendError('SESSION_OWNERSHIP_CONFLICT', `A cold mutation is already active for ${sessionPath}.`);
    }
    const pending = Promise.resolve().then(async () => {
      if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE || !fsSync.existsSync(sessionPath)) {
        return await operation();
      }
      const { barrier } = this.initializeFilesystemLifecycle();
      const sessionId = resolveSessionIdentity(sessionPath).sessionId;
      return lifecycleAdministrative
        ? await barrier.runAdministrativeAsync(sessionId, 'coordinator-cold-mutation', operation)
        : await barrier.runWriteMutationAsync(sessionId, 'coordinator-cold-mutation', operation);
    });
    this.pendingColdSessionMutations.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingColdSessionMutations.get(key) === pending) {
        this.pendingColdSessionMutations.delete(key);
      }
    }
  }

  private registerColdResult(result: object): void {
    const stamp = this.initializeColdSessionStore().ownershipStamp(result)?.[0];
    if (stamp) {
      this.browseResponseOwners.set(result, {
        sessionPath: stamp.sessionPath,
        fingerprint: stamp.fingerprint,
      });
    }
  }

  async start(): Promise<void> {
    // Install fatal handlers first so even an early spawn-time rejection is
    // surfaced. Idempotent (module-level guard).
    installBackendFatalHandlers();
    // Create the generation-scoped supervisor and verify the stable worker
    // artifact. The coordinator owns the patching barrier and workers only
    // validate it.
    const sdkRuntime: SdkRuntimeSelection = this.sourceArtifactDescriptor === undefined
      ? { kind: 'legacy-patched', patchIdentity: await ensureSdkPatchBarrier(this.sdkPath) }
      : await verifySdkRuntimeSelection(this.sdkPath, { kind: 'source-artifact', descriptor: this.sourceArtifactDescriptor });
    this.sdkRuntime = sdkRuntime;
    if (this.initialContextEstimateEntryPath) {
      this.initialContextEstimateClient = new InitialContextEstimateClient({
        entryPath: this.initialContextEstimateEntryPath,
        sdkPath: this.sdkPath,
        sdkRuntime,
        onDiagnostic: (chunk) => backendWarn('backend-initial-context-inventory', 'worker diagnostic', { chunk }),
        onTiming: (sample) => backendLog('info', 'backend-timing', 'initial-context-inventory.stage', { ...sample }),
      });
    }
    if (this.coldBrowseHelperEntryPath) {
      this.coldBrowseHelper = new ColdBrowseHelperClient({
        entryPath: this.coldBrowseHelperEntryPath,
        sdkPath: this.sdkPath,
        sdkRuntime,
        startupCwd: this.startupCwd,
        parentPid: process.pid,
        onDiagnostic: (chunk) => backendWarn('backend-cold-browse-helper', 'helper diagnostic', { chunk }),
        onTiming: (sample) => backendLog('info', 'backend-timing', 'cold-browse-helper.stage', { ...sample }),
      });
      // Eagerly validate/import the helper SDK while coordinator startup does
      // independent work. Failure is deliberately non-fatal: the first exact
      // v3 miss retries lazily, then ColdSessionStore preserves semantics with
      // its synchronous fallback if the helper is still unavailable.
      void this.coldBrowseHelper.warm().catch((error) => {
        backendWarn('backend-cold-browse-helper', 'eager warm failed', { error: toErrorMessage(error) });
      });
    }
    this.workerSupervisor = new WorkerSupervisor({
      workerEntryPath: this.workerEntryPath!,
      coordinatorGeneration: this.backendGeneration,
      sdkRuntime,
      mcpConfigPathFor: (sessionPath) => {
        const overridePath = sessionMcpOverridePath(sessionPath);
        try {
          return fsSync.existsSync(overridePath) ? overridePath : undefined;
        } catch {
          return undefined;
        }
      },
      onWorkerStateChange: (rootSessionPath, snapshot, identity) => {
        void this.workerRuntimeRouter?.handleWorkerStateChange(rootSessionPath, snapshot, identity).catch((error) => {
          backendError('backend-worker', 'runtime state reconciliation failed', {
            rootSessionPath,
            error: toErrorMessage(error),
          });
        });
      },
      onWorkerFrame: (rootSessionPath, frame) => {
        void this.workerRuntimeRouter?.handleWorkerFrame(rootSessionPath, frame).catch((error) => {
          backendError('backend-worker', 'runtime frame failed', {
            rootSessionPath,
            error: toErrorMessage(error),
          });
        });
      },
      onDiagnostic: (rootSessionPath, stream, chunk) => {
        // Worker IPC uses dedicated inherited descriptors, leaving stdout and
        // stderr as diagnostics. Routine extension stdout is informational;
        // stderr carries structured levels and keeps raw crash output at error.
        const level = classifyWorkerDiagnosticChunk(stream, chunk);
        backendLog(level, 'backend-worker', `worker ${stream}`, { rootSessionPath, chunk });
      },
    });
    await this.workerSupervisor.initialize();
    const sdkStartedAt = performance.now();
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'start',
      phase: 'sdk_import',
      processRole: 'coordinator',
      pid: process.pid,
    });
    try {
      await timed('start.loadSdk', async () => {
        this.sdk = await loadSdk(
          this.sdkPath,
          sdkRuntime.kind === 'source-artifact'
            ? sdkRuntimeLoadMode(sdkRuntime, 'cold')
            : { mode: 'cold-coordinator' },
        );
        this.agentDir = this.sdk.getAgentDir();
        this.analyticsAuthority?.validate();
        if (this.analyticsAuthority) {
          this.analyticsAuthority.openWriterAdmission();
        }
        this.sessionCatalog.setWriterAdmission(this.analyticsAuthority?.admission);
        this.getSessionDir();
        this.initializeColdSessionStore();
        if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] === STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
          this.initializeFilesystemLifecycle();
        }
      });
    } catch (error) {
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'failure',
        phase: 'sdk_import',
        durationMs: Math.max(0, performance.now() - sdkStartedAt),
        reasonCode: 'unknown_unattributable',
        processRole: 'coordinator',
        pid: process.pid,
      });
      throw error;
    }
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'success',
      phase: 'sdk_import',
      durationMs: Math.max(0, performance.now() - sdkStartedAt),
      processRole: 'coordinator',
      pid: process.pid,
    });

    // Install the host-side provider gate BEFORE any session runtime is
    // created. The gate wraps globalThis.fetch to enforce per-provider
    // concurrency, afterburn sticky slots, stream-liveness, and circuit
    // breaking — replacing the LiteLLM proxy. Configs are read from
    // models.json (in agentDir) which is generated by sync-models from
    // models.yaml providers.<p>.concurrency.
    await timed('start.providerGate', async () => {
      try {
        const modelsJsonPath = path.join(this.agentDir, 'models.json');
        const raw = await fs.readFile(modelsJsonPath, 'utf8');
        const modelsJson = JSON.parse(raw);
        const configs = ProviderGate.resolveConfigs(modelsJson);
        this.providerBasePolicies = providerPoliciesFromConfigs(configs);
        // Install whenever at least one provider ships a concurrency block.
        // The gate matches outbound requests by each config's `baseUrl`, so
        // only providers in `configs` are gated; user overrides via
        // runtimePrefs.set reconfigure the live gate in place (no restart).
        if (configs.length > 0) {
          ProviderGate.install(configs, 120);
        }
      } catch (error) {
        // Non-fatal: if models.json is missing or unreadable, the gate is
        // simply not installed — requests go direct (no concurrency cap).
        backendInfo('backend', 'providerGate.notInstalled', { error: (error as Error).message });
      }
    });

    const authDir = process.env.PI_CODING_AGENT_AUTH_DIR?.trim();
    let authPath = '';

    await timed('start.authSetup', async () => {
      if (authDir) {
        // Explicit override — use as-is.
        authPath = path.resolve(authDir, 'auth.json');
      } else {
        // Default: check if agentDir is inside a git tree.
        const agentDirAuthPath = path.resolve(this.agentDir, 'auth.json');
        if (await isInsideGitWorkTree(agentDirAuthPath)) {
          const allowInTree = process.env.PIE_ALLOW_IN_TREE_AUTH === '1';
          if (allowInTree) {
            authPath = agentDirAuthPath;
          } else {
            // Auto-resolve to platform-standard safe location.
            const safeDir = getDefaultAuthDir();
            authPath = path.resolve(safeDir, 'auth.json');
            // Migrate existing in-tree auth.json to the safe location.
            await migrateAuthFile(agentDirAuthPath, authPath);
          }
        } else {
          authPath = agentDirAuthPath;
        }
      }

      // Ensure the auth directory exists so the SDK can write to it.
      await ensureDir(path.dirname(authPath));

      this.authPath = authPath;
      this.authStorage = this.sdk.AuthStorage.create(authPath);
      this.modelRegistry = this.sdk.ModelRegistry.create(
        this.authStorage,
        path.join(this.agentDir, 'models.json'),
      );
      this.registerProviderGateModelUrls();
    });

    const coldStore = this.initializeColdSessionStore();
    this.sessionOwnershipAuthority = new SessionOwnershipAuthority({
      coldLeaseAuthority: coldStore.leases,
      writerAdmission: this.analyticsAuthority?.admission,
    });
    this.durableDetailStore = new DurableDetailStore({
      resolve: (sessionPath, address, durableRef) => this.resolveDurableDetail(sessionPath, address, durableRef),
      emit: (message) => {
        this.emit('detail.stream', message as unknown as WorkerJsonObject);
        return true;
      },
    });
    this.workerRuntimeRouter = new WorkerRuntimeRouter({
        supervisor: this.workerSupervisor!,
        coordinatorGeneration: this.backendGeneration,
        ...(this.analyticsAuthority?.descriptor
          ? {
              analyticsActivation: {
                generationId: this.analyticsAuthority.descriptor.generationId,
                buildId: this.analyticsAuthority.descriptor.buildId,
                workspaceId: this.analyticsAuthority.descriptor.workspaceId,
              },
              ...(this.analyticsAuthority.admission && this.analyticsAuthority.identity && this.analyticsAuthority.stateDir
                ? {
                    analyticsWriterAdmission: {
                      stateDir: this.analyticsAuthority.stateDir,
                      identity: this.analyticsAuthority.identity,
                    },
                  }
                : {}),
            }
          : {}),
        coldStore,
        ownership: this.sessionOwnershipAuthority,
        emit: (event, payload) => this.emit(event, payload),
        emitDetail: (message) => this.emit('detail.stream', message as unknown as WorkerJsonObject),
        onSessionControl: (frame, source) => this.handleWorkerSessionControl(frame, source.sessionPath),
        assertExecutionAdmissionOpen: (sessionPath) => this.assertSessionNotClosing(sessionPath),
        assertSessionControlSendAdmissionOpen: (sessionPath) => this.assertSessionControlSendAdmissionOpen(sessionPath),
        onSessionReplaced: (sourcePath, destinationPath) => {
          if (this.viewedSessionPath && backendSessionPathKey(this.viewedSessionPath) === backendSessionPathKey(sourcePath)) {
            this.recordViewedSessionTransition(destinationPath, sourcePath);
            this.setViewedSessionPath(destinationPath);
          }
        },
        writeModelSettings: (updates) => this.writeModelSettings(updates),
        writeModelSettingsIfCurrent: (expected, updates, unset) => (
          this.writeModelSettingsIfCurrent(expected, updates, unset)
        ),
        readModelSettings: () => this.readModelSettings(),
        readRuntimePrefs: () => ({ ...this.runtimePrefs }),
        buildPromotionSnapshot: async (sessionPath) => {
          const retainedKey = this.coldManagerKey(sessionPath);
          const retained = this.coldSessionManagerHandles.get(retainedKey);
          const exactSessionPath = retained?.handle.sessionPath ?? sessionPath;
          const openedPayload = await this.buildSessionOpenedPayload(
            exactSessionPath,
            undefined,
            'tail',
            undefined,
            undefined,
            undefined,
            undefined,
            false,
          );
          return {
            sdkPath: this.sdkPath,
            sdkRuntime: this.sdkRuntime,
            agentDir: this.agentDir,
            startupCwd: this.startupCwd,
            sessionDir: this.getSessionDir() ?? path.join(this.agentDir, 'sessions'),
            openedPayload,
            modelSettings: await this.readModelSettings(),
            creationReason: retained?.creationReason ?? 'resume',
            exactSessionPath,
            runtimePrefs: { ...this.runtimePrefs },
            commitPromotion: () => {
              if (retained && this.coldSessionManagerHandles.get(retainedKey) === retained) {
                this.coldSessionManagerHandles.delete(retainedKey);
                coldStore.retireHandle(retained.handle);
              }
            },
            abortPromotion: () => {
              if (retained && this.coldSessionManagerHandles.get(retainedKey) === retained) {
                coldStore.refreshHandle(retained.handle);
              }
            },
            authPath: this.authPath || path.join(this.agentDir, 'auth.json'),
            authFingerprint: await fs.stat(this.authPath || path.join(this.agentDir, 'auth.json'))
              .then((stat) => `${stat.size}:${stat.mtimeMs}`)
              .catch(() => 'missing'),
          };
        },
      });
      await this.workerRuntimeRouter.syncProviderPolicy(mergeProviderPolicies(
        this.providerBasePolicies,
        this.runtimePrefs.providerConcurrency,
      ));
      this.authFingerprint = await fs.stat(this.authPath || path.join(this.agentDir, 'auth.json'))
        .then((stat) => `${stat.size}:${stat.mtimeMs}`)
        .catch(() => 'missing');
      this.modelsJsonFingerprint = await fs.stat(path.join(this.agentDir, 'models.json'))
        .then((stat) => `${stat.size}:${stat.mtimeMs}`)
        .catch(() => 'missing');

    // Attach the stdin reader BEFORE emitting backend.ready so that any
    // request the client sends immediately after receiving ready is captured,
    // rather than racing with reader attachment.
    const detachReader = attachJsonlLineReader(process.stdin, (line) => {
      const request = this.handleLine(line);
      this.inFlightInputRequests.add(request);
      void request.catch((error) => {
        log(`backend request drain failed: ${toErrorMessage(error)}`);
      }).finally(() => {
        this.inFlightInputRequests.delete(request);
      });
    }, {
      maxLineBytes: JSONL_MAX_LINE_BYTES,
      onOverflow: ({ maxLineBytes, preview }) => {
        const requestId = extractPreviewRequestId(preview);
        log(JSON.stringify({
          level: 'error',
          event: 'protocol.stdin-overflow',
          maxLineBytes,
          requestId: requestId ?? null,
          preview,
        }));
        if (requestId) {
          writeStdout(responseError(
            requestId,
            'REQUEST_TOO_LARGE',
            `Request exceeds the ${maxLineBytes}-byte JSONL transport limit.`,
          ));
        }
      },
    });

    process.stdin.on('end', () => {
      detachReader();
      void (async () => {
        await Promise.allSettled([...this.inFlightInputRequests]);
        await this.dispose();
      })().then(
        () => process.exit(0),
        (error) => { log(`backend disposal failed closed: ${toErrorMessage(error)}`); process.exitCode = 1; },
      );
    });

    this.startHostLifetimeWatch();
    this.startHostWatchdog();
    // The event-loop monitor is diagnostics-only: it must not run (native
    // histogram + interval sampling) while the live-pipeline trace is
    // disabled. The toggle handler restarts it when diagnostics are enabled.
    if (isBackendLivePipelineTraceEnabled()) {
      this.startEventLoopMonitor();
    }

    // Record readiness before publishing the public event. The trace therefore
    // cannot claim readiness after a host has already observed it.
    recordBackendLivePipelineTrace({
      stage: 'process.lifecycle',
      kind: 'success',
      phase: 'backend_mapping',
      readiness: 'ready',
      processRole: 'coordinator',
      pid: process.pid,
    });
    this.emit('backend.ready', {
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      backendGeneration: this.backendGeneration,
      sdkVersion: this.sdk.VERSION,
      protocolVersion: PROTOCOL_VERSION,
      authPath,
      ...(this.analyticsAuthority?.descriptor ? { analyticsActivation: this.analyticsAuthority.descriptor } : {}),
    });

    // Preload only validated SDK modules in one short-lived spare. The child
    // does not see session cwd/model/agent settings or discover user extensions
    // until an actual cold open consumes it; idle expiry and dispose own it.
    void this.initialContextEstimateClient?.warm().catch((error) => {
      backendWarn('backend-initial-context-inventory', 'eager warm failed', { error: toErrorMessage(error) });
    });
    this.startSessionCatalogPolling();
  }

  /** Opt-in packaged-artifact probe through the real cold store, promotion
   * router, full worker SDK/runtime, command transport, and retirement. */
  async runPhase2WorkerSmoke(_sessionPath: string): Promise<void> {
    if (!this.workerRuntimeRouter) {
      throw new Error('Worker promotion smoke requires an initialized coordinator.');
    }
    const store = this.initializeColdSessionStore();
    const handle = store.create({ cwd: this.startupCwd });
    const switchTarget = store.create({ cwd: this.startupCwd });
    (switchTarget.manager as typeof switchTarget.manager & {
      appendCustomEntry(customType: string, data?: unknown): string;
    }).appendCustomEntry('phase4-switch-fork-source', { durable: true });
    this.retainColdSessionManager(handle, 'new');
    this.retainColdSessionManager(switchTarget, 'new');
    const commandResultPath = process.env.PIE_PHASE4_EXTENSION_FIXTURE_RESULT;
    if (!commandResultPath) throw new Error('Packaged extension replacement smoke requires PIE_PHASE4_EXTENSION_FIXTURE_RESULT.');
    await fs.rm(commandResultPath, { force: true });
    const first = await this.workerRuntimeRouter.promote(handle.sessionPath);
    let currentPath = handle.sessionPath;
    try {
      await this.workerRuntimeRouter.routeExisting({
        id: 'packaged-worker-promotion-smoke',
        method: 'models.list',
        params: { sessionPath: handle.sessionPath },
      });
      await this.handleRequest({
        id: 'packaged-worker-prefs-smoke',
        method: 'runtimePrefs.set',
        params: { providerToggles: {}, extensionToggles: {}, autonomousMode: true },
      });
      const beforeSettings = await this.readModelSettings();
      const nextThinkingLevel: ThinkingLevel = beforeSettings.defaultThinkingLevel === 'low' ? 'medium' : 'low';
      const updatedSettings = await this.handleRequest({
        id: 'packaged-worker-settings-smoke',
        method: 'settings.set',
        params: { sessionPath: handle.sessionPath, defaultThinkingLevel: nextThinkingLevel },
      }) as ModelSettings;
      if (updatedSettings.defaultThinkingLevel !== nextThinkingLevel
        || (await this.readModelSettings()).defaultThinkingLevel !== nextThinkingLevel) {
        throw new Error('Session-scoped worker settings mutation did not commit through the coordinator.');
      }
      const waitForCommandResult = async <T>(label: string): Promise<T> => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            return JSON.parse(await fs.readFile(commandResultPath, 'utf8')) as T;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
        }
        throw new Error(`Timed out waiting for packaged extension command result: ${label}`);
      };
      const dispatchNoAgentExtensionCommand = async (sessionPath: string): Promise<void> => {
        await fs.rm(commandResultPath, { force: true });
        const encodedResultPath = Buffer.from(commandResultPath).toString('base64url');
        const result = await this.workerRuntimeRouter!.routeExisting({
          id: 'packaged-worker-public-no-agent-command',
          method: 'message.send',
          params: { sessionPath, text: `/phase4-no-agent ${encodedResultPath}`, inputs: [] },
        }) as { requestId?: string };
        if (typeof result.requestId !== 'string') {
          throw new Error('Packaged public no-agent extension command did not receive an early acknowledgement.');
        }
        const completed = await waitForCommandResult('no-agent');
        if (!completed || typeof (completed as { sessionPath?: unknown }).sessionPath !== 'string') {
          throw new Error('Packaged no-agent extension command returned an invalid result.');
        }
      };
      await dispatchNoAgentExtensionCommand(currentPath);

      const sourcePaths: string[] = [];
      const dispatchExtensionReplacement = async (
        action: 'new' | 'switch' | 'fork',
        sourcePath: string,
        switchPath?: string,
      ): Promise<string> => {
        await fs.rm(commandResultPath, { force: true });
        const encodedArgs = Buffer.from(JSON.stringify({ action, resultPath: commandResultPath, switchPath }))
          .toString('base64url');
        const result = await this.workerRuntimeRouter!.routeExisting({
          id: `packaged-worker-public-extension-command:${action}`,
          method: 'message.send',
          params: { sessionPath: sourcePath, text: `/phase4-replace ${encodedArgs}`, inputs: [] },
        }) as { requestId?: string };
        if (typeof result.requestId !== 'string') {
          throw new Error(`Packaged public ${action} extension command did not receive an early acknowledgement.`);
        }
        const replacement = await waitForCommandResult(action) as {
          action: string;
          sourcePath: string;
          finalPath: string;
        };
        if (replacement.action !== action || typeof replacement.sourcePath !== 'string'
            || typeof replacement.finalPath !== 'string') {
          throw new Error(`Packaged extension command returned an invalid ${action} replacement result.`);
        }
        sourcePaths.push(replacement.sourcePath);
        return replacement.finalPath;
      };
      currentPath = await dispatchExtensionReplacement('new', currentPath);
      currentPath = await dispatchExtensionReplacement('switch', currentPath, switchTarget.sessionPath);
      currentPath = await dispatchExtensionReplacement('fork', currentPath);
      await fs.writeFile(commandResultPath, JSON.stringify({ sourcePaths, finalPath: currentPath }));
      const destinationRoute = this.workerRuntimeRouter.getRoute(currentPath);
      if (destinationRoute.state !== 'hot' || destinationRoute.owner.workerId !== first.owner.workerId) {
        throw new Error('Extension replacement destination was not rekeyed to the initiating coordinator owner.');
      }
      const destinationOwnership = await this.sessionOwnershipAuthority!.inspect(currentPath);
      if (destinationOwnership?.state !== 'hot'
          || destinationOwnership.owner.workerId !== first.owner.workerId
          || !destinationOwnership.transferConsumed) {
        throw new Error('Extension replacement destination did not reach consumed hot ownership.');
      }
      const durableDestination = await fs.readFile(currentPath, 'utf8');
      if (!durableDestination.includes('phase4-extension-durable')) {
        throw new Error('Extension replacement destination marker was not durable before command completion.');
      }
      for (const releasedPath of [...new Set(sourcePaths)]) {
        if (releasedPath === currentPath) continue;
        if (this.workerRuntimeRouter.getRoute(releasedPath).state !== 'cold') {
          throw new Error(`Extension replacement source was not released as cold: ${releasedPath}`);
        }
        const reused = await this.workerRuntimeRouter.promote(releasedPath);
        if (reused.owner.workerId === first.owner.workerId) {
          throw new Error('Released extension replacement source was not reusable by an independent worker.');
        }
        await this.workerRuntimeRouter.routeExisting({
          id: `packaged-worker-source-reuse:${releasedPath}`,
          method: 'models.list',
          params: { sessionPath: releasedPath },
        });
        await this.workerRuntimeRouter.retire(releasedPath, 'packaged extension replacement source reuse complete');
      }
      const truncated = await this.handleRequest({
        id: 'packaged-worker-hot-truncate-smoke',
        method: 'session.truncateAfter',
        params: { sessionPath: currentPath, entryId: 'missing-smoke-entry' },
      }) as { sessionPath: string };
      currentPath = truncated.sessionPath;
      const replacement = this.workerRuntimeRouter.getRoute(truncated.sessionPath);
      if (replacement.state !== 'hot' || replacement.owner.workerId === first.owner.workerId) {
        throw new Error('Hot truncate did not publish a fresh worker generation.');
      }
      await this.workerRuntimeRouter.routeExisting({
        id: 'packaged-worker-post-truncate-smoke',
        method: 'models.list',
        params: { sessionPath: truncated.sessionPath },
      });
      const futureWorkerSettings = await this.workerRuntimeRouter.routeExisting({
        id: 'packaged-worker-future-settings-smoke',
        method: 'settings.set',
        params: { sessionPath: truncated.sessionPath, defaultThinkingLevel: nextThinkingLevel },
      }) as WorkerJsonObject;
      if (futureWorkerSettings.defaultThinkingLevel !== nextThinkingLevel) {
        throw new Error('Fresh worker did not receive authoritative coordinator settings.');
      }
    } finally {
      if (this.workerRuntimeRouter.hasHotOwner(currentPath)) {
        await this.workerRuntimeRouter.retire(currentPath, 'packaged promotion smoke complete');
      }
    }
  }

  private startEventLoopMonitor(): void {
    if (this.eventLoopDelayTimer) return;
    // Diagnostics gate: never start the native monitor or its sampling timer
    // while the live-pipeline trace is disabled.
    if (!isBackendLivePipelineTraceEnabled()) return;
    const nativeMonitor = monitorEventLoopDelay({ resolution: 20 });
    nativeMonitor.enable();
    this.eventLoopDelayMonitor = nativeMonitor;
    this.eventLoopHistogram = new BoundedEventLoopHistogram();
    const intervalMs = 1_000;
    this.eventLoopNextSampleAt = performance.now() + intervalMs;
    this.eventLoopDelayTimer = setInterval(() => {
      if (this.disposed) return;
      if (!isBackendLivePipelineTraceEnabled()) {
        // Toggle-off safety net: never keep sampling once diagnostics are
        // disabled, even if the toggle callback wiring was missed.
        this.stopEventLoopMonitor();
        return;
      }
      const now = performance.now();
      const expected = this.eventLoopNextSampleAt ?? now;
      const driftMs = now - expected;
      // The interval sample is a real coordinator scheduling observation. It
      // is deliberately kept separate from the native monitor's aggregate
      // mean/max, which supplies the finer-grained delay evidence.
      this.eventLoopHistogram?.record(Math.max(0, driftMs));
      this.eventLoopHistogram?.recordDrift(driftMs);
      this.eventLoopNextSampleAt = now + intervalMs;
      const mean = Number.isFinite(nativeMonitor.mean) ? nativeMonitor.mean / 1e6 : 0;
      const max = Number.isFinite(nativeMonitor.max) ? nativeMonitor.max / 1e6 : 0;
      recordBackendLivePipelineTrace({
        stage: 'backend.event_loop',
        kind: 'observation',
        phase: 'backend_mapping',
        eventLoopDelayMs: Math.max(0, mean),
        eventLoopMaxDelayMs: Math.max(0, max),
        eventLoopHistogram: this.eventLoopHistogram?.snapshot(),
        processRole: 'coordinator',
        pid: process.pid,
      });
      nativeMonitor.reset();
      this.eventLoopHistogram?.reset();
    }, intervalMs);
    this.eventLoopDelayTimer.unref?.();
  }

  private stopEventLoopMonitor(): void {
    if (this.eventLoopDelayTimer) clearInterval(this.eventLoopDelayTimer);
    this.eventLoopDelayTimer = undefined;
    this.eventLoopDelayMonitor?.disable();
    this.eventLoopDelayMonitor = undefined;
    this.eventLoopHistogram = undefined;
    this.eventLoopNextSampleAt = undefined;
  }

  /** Reserve a monotonic diagnostics-toggle generation at request receipt.
   * Every received toggle request (on or off) advances the generation, so
   * concurrent requests are ordered by receipt, not settlement. Superseded
   * pending off entries can no longer apply and are pruned here; their exact
   * identities are never reused. */
  private reserveLivePipelineTraceToggle(): number {
    this.livePipelineTraceToggleGeneration += 1;
    for (const [requestId, pending] of this.pendingLivePipelineTraceDisables) {
      if (pending.generation < this.livePipelineTraceToggleGeneration) {
        this.pendingLivePipelineTraceDisables.delete(requestId);
      }
    }
    return this.livePipelineTraceToggleGeneration;
  }

  private deferLivePipelineTraceDisable(requestId: string, generation: number, onApplied?: () => void): boolean {
    if (this.disposed) return false;
    // Set semantics are intentional: a retry of the same request identity
    // remains deferred until handleLine's final attempt completes. The
    // callback is replaced by a retry's callback, but can still run only once.
    this.pendingLivePipelineTraceDisables.set(requestId, {
      generation,
      onApplied: onApplied ?? (() => this.stopEventLoopMonitor()),
    });
    return true;
  }

  private completeLivePipelineTraceDisable(requestId: string): boolean {
    const pending = this.pendingLivePipelineTraceDisables.get(requestId);
    if (!pending) return false;
    this.pendingLivePipelineTraceDisables.delete(requestId);
    // A newer on request wins over an older deferred off request. The exact
    // request entry is still removed here, but it must not change global state.
    if (pending.generation !== this.livePipelineTraceToggleGeneration) return false;
    // These synchronous state changes form one transition at the request's
    // completion boundary: no monitor sample can be scheduled after tracing is
    // disabled, and no later request can consume this request's pending state.
    setBackendLivePipelineTraceEnabled(false);
    pending.onApplied();
    return true;
  }

  private markLivePipelineTraceEnabled(): void {
    // The generation was already reserved at request receipt
    // (`reserveLivePipelineTraceToggle`); applying the enable here only
    // starts the trace-gated monitor.
    this.startEventLoopMonitor();
  }

  private cancelLivePipelineTraceDisable(requestId: string): void {
    this.pendingLivePipelineTraceDisables.delete(requestId);
  }

  /**
   * Stdio EOF is not sufficient when Node is launched through a process
   * manager: the manager can retain the pipe after the extension host dies.
   * Keep a low-cost, unref'd ownership check so a backend cannot outlive its
   * host indefinitely. The host PID is optional for compatibility with direct
   * backend launches and unit tests.
   */
  private startHostWatchdog(): void {
    const hostPid = this.hostPid;
    if (hostPid === undefined || hostPid === process.pid) return;

    const checkHost = (): void => {
      try {
        process.kill(hostPid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') return;
        this.handleHostLoss('pid-watchdog', { hostPid });
      }
    };

    this.hostWatchdogTimer = setInterval(checkHost, 2_000);
    this.hostWatchdogTimer.unref?.();
    checkHost();
  }

  private stopHostWatchdog(): void {
    if (this.hostWatchdogTimer) clearInterval(this.hostWatchdogTimer);
    this.hostWatchdogTimer = undefined;
  }

  /** The host owns the write side of fd 3. OS-level EOF is a stronger lifetime
   * signal than stdio or PID polling: it is immediate, has no PID-reuse race,
   * and remains independent of accepted RPC drainage. */
  private startHostLifetimeWatch(): void {
    const lifetimeFd = this.lifetimeFd;
    if (lifetimeFd === undefined) return;
    try {
      const stream = fsSync.createReadStream('', { fd: lifetimeFd, autoClose: true });
      this.hostLifetimeStream = stream;
      stream.once('end', () => this.handleHostLoss('lifetime-pipe-eof', { lifetimeFd }));
      stream.once('error', (error) => {
        if (this.disposed) return;
        backendWarn('backend', 'host lifetime pipe failed; PID watchdog remains active', {
          lifetimeFd,
          error: toErrorMessage(error),
        });
      });
      stream.resume();
    } catch (error) {
      backendWarn('backend', 'could not open host lifetime pipe; PID watchdog remains active', {
        lifetimeFd,
        error: toErrorMessage(error),
      });
    }
  }

  private stopHostLifetimeWatch(): void {
    const stream = this.hostLifetimeStream;
    this.hostLifetimeStream = undefined;
    stream?.destroy();
  }

  private handleHostLoss(source: string, details: Record<string, unknown>): void {
    if (this.hostLossHandled || this.disposed) return;
    this.hostLossHandled = true;
    this.stopHostWatchdog();
    this.stopHostLifetimeWatch();
    backendWarn('backend', 'extension host disappeared; stopping backend', { source, ...details });

    const forcedExit = setTimeout(() => {
      log('backend host-loss disposal exceeded 3 seconds; forcing process exit');
      process.exit(1);
    }, 3_000);
    forcedExit.unref?.();
    void this.dispose().then(
      () => {
        clearTimeout(forcedExit);
        process.exit(0);
      },
      (error) => {
        clearTimeout(forcedExit);
        log(`backend disposal failed closed: ${toErrorMessage(error)}`);
        process.exit(1);
      },
    );
  }







  private isSessionForgotten(sessionPath: string): boolean {
    if (this.forgottenSessionPaths.has(sessionPath)) return true;
    const key = this.coldManagerKey(sessionPath);
    for (const candidatePath of this.forgottenSessionPaths) {
      if (this.coldManagerKey(candidatePath) === key) return true;
    }
    return false;
  }

  private prepareViewedSessionPath(sessionPath: string): PreparedViewedSessionTransition {
    const prepared: PreparedViewedSessionTransition = {
      changed: false,
      revision: this.viewedSessionRevision,
      hadPrevious: this.browsePreviousSessionFiles.has(sessionPath),
      previous: this.browsePreviousSessionFiles.get(sessionPath),
    };
    if (this.isSessionForgotten(sessionPath) || this.viewedSessionPath === sessionPath) {
      return prepared;
    }
    prepared.changed = true;
    this.browsePreviousSessionFiles.set(sessionPath, this.viewedSessionPath);
    return prepared;
  }

  private discardPreparedViewedSessionPath(
    sessionPath: string,
    prepared?: PreparedViewedSessionTransition,
  ): void {
    if (!prepared?.changed || prepared.revision !== this.viewedSessionRevision) return;
    if (prepared.hadPrevious) this.browsePreviousSessionFiles.set(sessionPath, prepared.previous);
    else this.browsePreviousSessionFiles.delete(sessionPath);
  }

  private commitPreparedViewedSessionPath(
    sessionPath: string,
    prepared?: PreparedViewedSessionTransition,
  ): boolean {
    if (!prepared?.changed || prepared.revision !== this.viewedSessionRevision
      || this.isSessionForgotten(sessionPath)) return false;
    this.viewedSessionPath = sessionPath;
    this.viewedSessionRevision += 1;
    return true;
  }

  private recordViewedSessionTransition(
    sessionPath: string,
    previousSessionPath: string | null,
  ): boolean {
    if (this.isSessionForgotten(sessionPath) || previousSessionPath === sessionPath) return false;
    this.browsePreviousSessionFiles.set(sessionPath, previousSessionPath ?? undefined);
    this.viewedSessionPath = sessionPath;
    this.viewedSessionRevision += 1;
    return true;
  }

  private setViewedSessionPath(sessionPath: string | undefined): void {
    if ((sessionPath && this.isSessionForgotten(sessionPath))
      || this.viewedSessionPath === sessionPath) return;
    this.viewedSessionPath = sessionPath;
    this.viewedSessionRevision += 1;
  }

  private setViewedSessionPathIfCurrent(sessionPath: string, revision: unknown): boolean {
    if (revision !== this.viewedSessionRevision || this.isSessionForgotten(sessionPath)) return false;
    this.setViewedSessionPath(sessionPath);
    return true;
  }


  private readColdBrowseFileFingerprintSync(sessionPath: string): string {
    const stat = fsSync.statSync(sessionPath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  private async loadTranscriptPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
    options?: TranscriptPageLoadOptions,
  ): Promise<TranscriptPagePayload> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.initializeColdSessionStore().loadPage(
          sessionPath,
          direction,
          loadedStart,
          loadedEnd,
          options,
        );
        this.registerColdResult(result);
        return result;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) continue;
        throw error;
      }
    }
    throw new BackendError('SESSION_CHANGED_DURING_READ', `The session changed repeatedly while it was being paged: ${sessionPath}`);
  }

  private async loadDetail(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult> {
    if (ref.source !== 'durable') {
      return { sessionPath, key: ref.key, status: 'unavailable', message: 'Live detail is owned by the extension host.' };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.initializeColdSessionStore().loadDetail(sessionPath, ref);
        this.registerColdResult(result);
        return result;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) continue;
        throw error;
      }
    }
    throw new BackendError('SESSION_CHANGED_DURING_READ', `The session changed repeatedly while detail was being read: ${sessionPath}`);
  }

  // ─── Detail routing: live worker vs coordinator durable authority ──

  /** Route `detail.subscribe`. A hot session's live source wins (the worker's
   *  canonical store is authoritative while the subagent runs); a terminal or
   *  cold source is answered by the durable paged authority directly from the
   *  durable JSONL. A live NOT_FOUND/NOT_LIVE_ADDRESSABLE means the worker no
   *  longer retains the source (terminal or evicted) and the durable JSONL is
   *  authoritative, so it falls back to durable. */
  private async routeDetailSubscribe(requestId: string, params: DetailSubscribeParams): Promise<void> {
    const router = this.workerRuntimeRouter;
    if (!router) {
      throw new BackendError('UNKNOWN_METHOD', 'Detail subscription routing is unavailable.');
    }
    const fence = this.detailFence();
    const sessionPath = params.address.sessionPath;
    if (router.hasHotOwner(sessionPath)) {
      try {
        await router.subscribeDetail({
          kind: 'detail.subscribe',
          requestId,
          subscriptionId: params.subscriptionId,
          address: params.address,
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
          maxPageBytes: params.maxPageBytes,
        });
        return;
      } catch (error) {
        if (!isLiveDetailGoneError(error)) throw error;
        // The live source is gone (terminal handoff or eviction); the durable
        // JSONL now owns the exact detail.
      }
    }
    const durable = this.durableDetailStore;
    if (!durable) {
      throw new BackendError('UNKNOWN_METHOD', 'Durable detail subscription routing is unavailable.');
    }
    await durable.subscribe(requestId, params.subscriptionId, params.address, params.maxPageBytes, fence);
  }

  private async routeDetailUnsubscribe(requestId: string, params: DetailUnsubscribeParams): Promise<void> {
    const router = this.workerRuntimeRouter;
    const durable = this.durableDetailStore;
    if (!router && !durable) {
      throw new BackendError('UNKNOWN_METHOD', 'Detail subscription routing is unavailable.');
    }
    // Both registries no-op for subscription ids they do not own.
    durable?.unsubscribe(requestId, params.subscriptionId);
    if (router) {
      await router.unsubscribeDetail({
        kind: 'detail.unsubscribe',
        requestId,
        subscriptionId: params.subscriptionId,
        reason: params.reason,
      });
    }
  }

  private async routeDetailFetch(requestId: string, params: DetailFetchParams): Promise<void> {
    const router = this.workerRuntimeRouter;
    const durable = this.durableDetailStore;
    if (durable?.owns(params.subscriptionId)) {
      await durable.fetch(requestId, params.subscriptionId, params.address, params.ref, params.maxPageBytes, this.detailFence());
      return;
    }
    if (!router) {
      throw new BackendError('UNKNOWN_METHOD', 'Detail subscription routing is unavailable.');
    }
    router.fetchDetail({
      kind: 'detail.fetch',
      requestId,
      subscriptionId: params.subscriptionId,
      address: params.address,
      ref: params.ref,
      maxPageBytes: params.maxPageBytes,
    });
  }

  /** Coordinator-owned durable detail authority: resolve the address against
   *  the durable JSONL under the cold ownership lease (stable cold reads are
   *  permitted while a worker owns the path; the terminal tool result is
   *  written before the terminal handoff). */
  private async resolveDurableDetail(
    sessionPath: string,
    address: LiveSubagentDetailAddress,
    durableRef?: LazyDetailRef,
  ): Promise<ResolvedDurableDetail> {
    return await this.initializeColdSessionStore().resolveDurableDetail(sessionPath, address, durableRef);
  }

  private detailFence(): BackendDetailFence {
    return { backendGeneration: this.backendGeneration, coordinatorGeneration: this.backendGeneration };
  }








  private async readModelSettings(): Promise<ModelSettings> {
    const defaults: ModelSettings = { defaultModel: '', defaultThinkingLevel: 'high' };
    try {
      const raw = await fs.readFile(path.join(this.agentDir, 'settings.json'), 'utf8');
      const parsed = parseJsonOrThrow<Partial<ModelSettings>>(raw, 'settings.json');
      return modelSettingsFromRecord(parsed, defaults);
    } catch (error) {
      backendTrace('modelSettings', 'read.failed', { level: 'warn', error: toErrorMessage(error) });
      return defaults;
    }
  }

  /** Rewrite the SDK session's cached `_baseSystemPrompt` (and the structured
   *  `_baseSystemPromptOptions`) so the next turn sends a prompt with the
   *  disabled entries removed. The SDK reads `_baseSystemPrompt` each turn
   *  (falling back to it when no extension overrides), so this mutation takes
   *  effect on the next `message.send` without restarting the session.
   *
   *  The filtered options are always rebuilt from the unfiltered
   *  `_originalSystemPromptOptions` snapshot (captured before any filtering),
   *  never from the already-filtered live `_baseSystemPromptOptions`. This keeps
   *  re-enabling an entry a true inverse of disabling it (the prior behavior
   *  rebuilt from filtered options, so a toggled-off context file never came
   *  back) and lets rapid toggles compose instead of accumulating drift. */

  private async writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings> {
    const settingsPath = path.join(this.agentDir, 'settings.json');
    let written: ModelSettings | undefined;
    // Model updates run in the backend while pruning updates run in the
    // extension host. Share the same cross-process lock so their
    // read-modify-write cycles cannot silently overwrite each other. Return
    // the snapshot produced inside that lock; a later writer must not change
    // the rollback guard before this request sees its own result.
    await updateSettingsJsonObject(settingsPath, (existing) => {
      const next = applyModelSettingsMutation(existing, updates);
      written = modelSettingsFromRecord(next, { defaultModel: '', defaultThinkingLevel: 'high' });
      return next;
    });
    return written ?? await this.readModelSettings();
  }

  private async writeModelSettingsIfCurrent(
    expected: ModelSettings,
    updates: Partial<ModelSettings>,
    unset: readonly ModelSettingsUnsetKey[] = [],
  ): Promise<boolean> {
    const settingsPath = path.join(this.agentDir, 'settings.json');
    let applied = false;
    await updateSettingsJsonObject(settingsPath, (existing) => {
      const current = modelSettingsFromRecord(existing, { defaultModel: '', defaultThinkingLevel: 'high' });
      if (!sameModelSettings(current, expected)) return existing;
      applied = true;
      return applyModelSettingsMutation(existing, updates, unset);
    });
    return applied;
  }




  private async buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../lib/rpc/session-events.js').TranscriptMode,
    transport?: import('../../session-storage/transcripts/snapshot-boundary.js').SessionSnapshotTransport,
    operationId?: string,
    operationAttempt?: number,
    systemPromptDisabledEntries?: readonly string[],
    includeInitialContextInventory = true,
    publicRequestId?: string,
  ): Promise<SessionOpenedPayload> {
    return await timed('buildSessionOpenedPayload', async () => {
      const router = this.workerRuntimeRouter;
      if (router?.hasHotOwner(sessionPath)) {
        const snapshotRequestId = publicRequestId
          ?? `coordinator-session-snapshot:${++this.workerSnapshotRequestSequence}`;
        return await router.buildHotSessionOpenedPayload(
          sessionPath,
          {
            sessionPath,
            ...(selectionToken !== undefined ? { selectionToken } : {}),
            ...(transcript !== undefined ? { transcript } : {}),
            ...(operationId !== undefined ? { operationId } : {}),
            ...(operationAttempt !== undefined ? { operationAttempt } : {}),
          },
          snapshotRequestId,
        );
      }
      const catalog = await loadConfiguredModels(this.agentDir, this.modelRegistry);
      const availableModels = catalog.models;
      const modelSettings = await this.readModelSettings();
      const store = this.initializeColdSessionStore();
      const retained = this.coldSessionManagerHandles.get(this.coldManagerKey(sessionPath));
      try {
        const disabledEntries = systemPromptDisabledEntries !== undefined
          ? [...new Set(systemPromptDisabledEntries)]
          : await readSystemPromptTogglesForSession(sessionPath);
        const options = {
          modelSettings,
          availableModels: catalog.ok ? availableModels : undefined,
          selectionToken,
          transcript,
          transport,
          operationId,
          operationAttempt,
          systemPromptDisabledEntries: disabledEntries,
        };
        const openColdSnapshot = async (openOptions: typeof options & {
          systemPrompts?: SessionOpenedPayload['systemPrompts'];
          initialContextEstimate?: SessionOpenedPayload['initialContextEstimate'];
        }): Promise<SessionOpenedPayload> => (
          retained
            ? await store.openHandleSnapshot(retained.handle, openOptions)
            : await store.openSnapshot(sessionPath, openOptions)
        );
        const resolveInventoryTarget = (snapshot: SessionOpenedPayload) => {
          const modelId = snapshot.session.modelId ?? modelSettings.defaultModel;
          const provider = snapshot.session.provider ?? modelSettings.defaultProvider
            ?? availableModels.find((model) => model.id === modelId)?.provider;
          return modelId && provider
            ? { cwd: snapshot.session.cwd || this.startupCwd, model: { provider, id: modelId } }
            : undefined;
        };
        const disabledKey = (entries: readonly string[]) => (
          JSON.stringify([...new Set(entries)].sort())
        );
        const isInitialEstimateEligible = (snapshot: SessionOpenedPayload) => (
          snapshot.transcriptWindow.hasUserMessages === false
          && snapshot.contextUsage === undefined
          && (snapshot.sessionUsage?.samples.length ?? 0) === 0
        );
        // The fresh inventory target comes from this authoritative session
        // snapshot (cwd/model), so discovery cannot safely overlap this read.
        let payload = await openColdSnapshot(options);
        if (includeInitialContextInventory
          && payload.runtimeReady === false
          && this.initialContextEstimateClient) {
          // Discovery is intentionally outside the cold ownership critical
          // section. Fence its cwd/model and sidecar inputs against a fresh
          // final snapshot so a concurrent cold settings/toggle/history write
          // cannot publish a mixed catalog or stale empty-session estimate.
          // Bounded retries fail closed by returning
          // the ordinary catalog-free snapshot.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const target = resolveInventoryTarget(payload);
            if (!target) break;
            const inventory = await this.initialContextEstimateClient.discover({
              cwd: target.cwd,
              agentDir: this.agentDir,
              model: target.model,
            });
            if (!inventory) break;
            const observedDisabledEntries = await readSystemPromptTogglesForSession(sessionPath);
            const includeEstimate = isInitialEstimateEligible(payload);
            const candidate = await openColdSnapshot({
              ...options,
              systemPromptDisabledEntries: observedDisabledEntries,
              systemPrompts: markDisabledEntries(
                inventory.systemPrompts,
                new Set(observedDisabledEntries),
              ),
              ...(includeEstimate ? { initialContextEstimate: inventory.estimate } : {}),
            });
            const confirmedDisabledEntries = await readSystemPromptTogglesForSession(sessionPath);
            const confirmedTarget = resolveInventoryTarget(candidate);
            if (confirmedTarget
              && confirmedTarget.cwd === target.cwd
              && confirmedTarget.model.id === target.model.id
              && confirmedTarget.model.provider === target.model.provider
              && disabledKey(confirmedDisabledEntries) === disabledKey(observedDisabledEntries)
              && isInitialEstimateEligible(candidate) === includeEstimate) {
              payload = candidate;
              break;
            }
            options.systemPromptDisabledEntries = confirmedDisabledEntries;
            payload = await openColdSnapshot(options);
          }
        }
        this.registerColdResult(payload);
        return payload;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) {
          if (retained
            && this.coldSessionManagerHandles.get(this.coldManagerKey(sessionPath)) === retained) {
            // An external durable rewrite invalidates a retained empty manager.
            // Evict it once; the retry reopens current durable authority rather
            // than selecting the same stale handle forever.
            this.coldSessionManagerHandles.delete(this.coldManagerKey(sessionPath));
            return await this.buildSessionOpenedPayload(
              sessionPath,
              selectionToken,
              transcript,
              transport,
              operationId,
              operationAttempt,
              systemPromptDisabledEntries,
              includeInitialContextInventory,
            );
          }
          throw new BackendError(
            'SESSION_CHANGED_DURING_READ',
            `The session changed while its cold snapshot was being built: ${sessionPath}`,
          );
        }
        throw error;
      }
    });
  }

  private async emitSessionListChanged(
    liveSummaries: readonly SessionSummary[] = [],
  ): Promise<void> {
    if (this.disposed) return;
    // Rejection-safe: most callers fire-and-forget this (`void …`). A thrown
    // session-list scan must log and swallow instead of becoming an unhandled
    // rejection; the next catalog poll/emit refreshes the list opportunistically.
    try {
      const sessions = await this.listSessionSummaries(liveSummaries);
      const payload: SessionListChangedPayload = {
        sessions,
        activeSessionPath: this.viewedSessionPath,
        sessionCatalogProgress: this.sessionCatalog.getProgress(),
      };
      this.coldSessionStore?.transferOwnershipStamp(sessions, payload);
      this.emit('session.list.changed', payload);
    } catch (error) {
      backendWarn('backend-session', 'emitSessionListChanged.failed', {
        error: toErrorMessage(error),
      });
    }
  }

  /** Wait for the current route owner to settle before choosing cold versus
   * hot browse authority. Promotion installs its cold-lease fence before the
   * worker is ready, so retrying through ColdSessionStore in that interval is
   * guaranteed to fail even though the transition is healthy. Re-read after
   * each settlement because retirement/transition may hand directly to a new
   * promotion. Bounded churn remains a genuine publication failure. */
  private async waitForSessionBrowseAuthority(sessionPath: string): Promise<void> {
    const router = this.workerRuntimeRouter;
    if (!router) return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const route = router.getRoute(sessionPath);
      const settlement = route.state === 'promoting'
        ? route.promotion
        : route.state === 'retiring'
          ? route.retirement
          : route.state === 'transitioning'
            ? route.completion
            : undefined;
      if (!settlement) return;
      await settlement.catch(() => undefined);
    }
    throw new BackendError(
      'SESSION_CHANGED_DURING_READ',
      `The session ownership changed repeatedly while its browse authority was being selected: ${sessionPath}`,
    );
  }

  /** Select the source owner for duplicate at the mutation boundary. A cold
   * route can start promotion after the public pre-dispatch check but before
   * ColdSessionStore captures its stamp; that stale capture is a re-selection
   * signal, not a failed duplicate. Once a cold stamp is captured, its final
   * fork commit is synchronous and cannot overlap a new promotion. */
  private async duplicateSessionFromCurrentOwner(
    sessionPath: string,
    publicRequestId: string,
    pendingCreateOperationId?: string,
  ): Promise<{ sessionPath: string }> {
    const key = this.coldManagerKey(sessionPath);
    const predecessor = this.pendingSessionDuplicates.get(key) ?? Promise.resolve();
    const pending = predecessor.catch(() => undefined).then(async () => (
      await this.executeDuplicateSessionFromCurrentOwner(
        sessionPath,
        publicRequestId,
        pendingCreateOperationId,
      )
    ));
    this.pendingSessionDuplicates.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingSessionDuplicates.get(key) === pending) {
        this.pendingSessionDuplicates.delete(key);
      }
    }
  }

  private async executeDuplicateSessionFromCurrentOwner(
    sessionPath: string,
    publicRequestId: string,
    pendingCreateOperationId?: string,
  ): Promise<{ sessionPath: string }> {
    const replayPath = this.resolvePendingCreateReplay(pendingCreateOperationId);
    if (replayPath) return { sessionPath: replayPath };
    const store = this.initializeColdSessionStore();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.waitForSessionBrowseAuthority(sessionPath);
      const router = this.workerRuntimeRouter;
      if (router?.hasHotOwner(sessionPath)) {
        const duplicated = await router.duplicateHotSession(sessionPath, { sessionPath }, publicRequestId);
        await this.registerNewSessionLifecycle(duplicated.sessionPath, pendingCreateOperationId);
        return duplicated;
      }
      let handle: ColdSessionManagerHandle;
      try {
        handle = await this.runColdSessionMutation(sessionPath, async () => store.duplicate(sessionPath));
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) continue;
        throw error;
      }
      this.retainColdSessionManager(handle, 'new');
      await this.registerNewSessionLifecycle(handle.sessionPath, pendingCreateOperationId);
      return { sessionPath: handle.sessionPath };
    }
    throw new BackendError(
      'SESSION_CHANGED_DURING_READ',
      `The session ownership changed repeatedly while it was being duplicated: ${sessionPath}`,
    );
  }

  /** Recover a cold payload rejected at the final publication fence. A hot
   * winner rebuilds inside its SDK runtime (and emits the authoritative event)
   * while a still-cold winner gets one fresh durable projection. Never weaken
   * the cold stamp or publish the rejected payload. */
  private async refreshStaleSessionOpened(
    sessionPath: string,
    opened: Partial<SessionOpenedPayload>,
  ): Promise<void> {
    await this.waitForSessionBrowseAuthority(sessionPath);
    if (this.disposed || this.isSessionForgotten(sessionPath)) return;
    const router = this.workerRuntimeRouter;
    if (router?.hasHotOwner(sessionPath)) {
      const params = {
        sessionPath,
        ...(typeof opened.selectionToken === 'string'
          ? { selectionToken: opened.selectionToken } : {}),
        ...(opened.transcriptSkipped === true ? { transcript: 'skip' as const } : {}),
        ...(typeof opened.operationId === 'string'
          ? { operationId: opened.operationId } : {}),
        ...(Number.isSafeInteger(opened.operationAttempt) && (opened.operationAttempt ?? 0) > 0
          ? { operationAttempt: opened.operationAttempt } : {}),
      };
      this.coldPublicationRefreshSequence += 1;
      await router.routeExisting({
        id: `cold-publication-refresh:${this.coldPublicationRefreshSequence}`,
        method: 'session.open',
        params,
      });
      return;
    }
    const authoritative = await this.buildSessionOpenedPayload(
      sessionPath,
      opened.selectionToken,
      opened.transcriptSkipped ? 'skip' : 'tail',
      undefined,
      opened.operationId,
      opened.operationAttempt,
    );
    this.emit('session.opened', authoritative);
  }

  private async listSessionSummaries(
    liveSummaries: readonly SessionSummary[] = [],
  ): Promise<SessionSummary[]> {
    return await this.initializeColdSessionStore().list(liveSummaries);
  }

  private startSessionCatalogPolling(intervalMs = SESSION_CATALOG_POLL_INTERVAL_MS): void {
    if (this.sessionCatalogPollTimer) return;
    this.sessionCatalogPollingActive = true;
    // Restored-startup hosts do not issue session.list: publish the complete
    // catalog once even when its inventory fingerprint has not changed.
    void this.emitSessionListChanged();
    this.sessionCatalogPollTimer = setInterval(() => {
      void this.pollSessionCatalog();
    }, intervalMs);
    this.sessionCatalogPollTimer.unref();
  }

  private registerProviderGateModelUrls(): void {
    const gate = ProviderGate.getInstance();
    const registry = this.modelRegistry;
    if (!gate || !registry) return;
    try {
      // getAll includes hydrated built-in/OAuth models that may be unavailable
      // until credentials are present; getAvailable supplies configured models
      // on SDK versions where getAll is not exposed.
      gate.registerModelBaseUrls([
        ...(registry.getAll?.() ?? []),
        ...registry.getAvailable(),
      ]);
    } catch (error) {
      backendWarn('backend', 'providerGate.modelUrls.failed', { error: toErrorMessage(error) });
    }
  }

  private async pollSessionCatalog(): Promise<void> {
    if (!this.sessionCatalogPollingActive || this.sessionCatalogPollInFlight) return;
    this.sessionCatalogPollInFlight = true;
    let catalogChanged = false;
    try {
      catalogChanged = await this.sessionCatalog.invalidateIfInventoryChanged(
        this.agentDir,
        this.getSessionDir(),
      );
    } catch (error) {
      backendWarn('backend-session', 'catalogInventoryPoll.failed', {
        error: toErrorMessage(error),
      });
    }

    try {
      if (catalogChanged && this.sessionCatalogPollingActive) {
        await this.emitSessionListChanged();
      }

      // Monotonic worker sync: auth fingerprint refresh bumps/broadcasts (or
      // retires unacknowledging workers) and a moved models.json re-broadcasts
      // the configured catalog authority. Both are best-effort poll extensions;
      // the next poll retries a failed broadcast.
      if (this.workerRuntimeRouter) {
        try {
          const authPath = this.authPath || path.join(this.agentDir, 'auth.json');
          const authFingerprint = await fs.stat(authPath)
            .then((stat) => `${stat.size}:${stat.mtimeMs}`)
            .catch(() => 'missing');
          if (authFingerprint !== this.authFingerprint) {
            this.authFingerprint = authFingerprint;
            this.authStorage?.reload?.();
            await this.workerRuntimeRouter.refreshAuth(authFingerprint, authPath);
          }
        } catch (error) {
          backendWarn('backend-session', 'authFingerprintPoll.failed', {
            error: toErrorMessage(error),
          });
        }
        try {
          const modelsPath = path.join(this.agentDir, 'models.json');
          const modelsFingerprint = await fs.stat(modelsPath)
            .then((stat) => `${stat.size}:${stat.mtimeMs}`)
            .catch(() => 'missing');
          if (modelsFingerprint !== this.modelsJsonFingerprint) {
            const rawModels = JSON.parse(await fs.readFile(modelsPath, 'utf8'));
            const providerConfigs = ProviderGate.resolveConfigs(rawModels);
            this.providerBasePolicies = providerPoliciesFromConfigs(providerConfigs);
            if (providerConfigs.length > 0) ProviderGate.install(providerConfigs, 120);
            else ProviderGate.uninstall();
            await this.workerRuntimeRouter.syncProviderPolicy(mergeProviderPolicies(
              this.providerBasePolicies,
              this.runtimePrefs.providerConcurrency,
            ));
            const catalog = await loadConfiguredModels(this.agentDir, this.modelRegistry);
            if (!catalog.ok) {
              throw new Error(`Configured model catalog reload failed: ${catalog.error}`);
            }
            this.registerProviderGateModelUrls();
            await this.workerRuntimeRouter.syncCatalog(catalog.models as unknown as WorkerJsonValue[]);
            // Commit only after every authority publication succeeds. A
            // transient parse/sync failure must see the same fingerprint as
            // pending on the next poll rather than suppressing its own retry.
            this.modelsJsonFingerprint = modelsFingerprint;
          }
        } catch (error) {
          backendWarn('backend-session', 'modelsJsonPoll.failed', {
            error: toErrorMessage(error),
          });
        }
      }
    } finally {
      this.sessionCatalogPollInFlight = false;
    }
  }

  private emit(event: string, payload?: unknown): void {
    // After disposal begins, suppress every event so in-flight async paths
    // (recovery replacement emissions, catalog polling, late SDK events) cannot
    // push stale state to a host that is already tearing the backend down.
    if (this.disposed) return;
    if (event === 'session.list.changed' && payload && typeof payload === 'object'
      && this.coldSessionStore?.ownershipStamp(payload as object)) {
      try {
        this.coldSessionStore.publishSync(payload, () => undefined);
      } catch (error) {
        if (!(error instanceof StaleColdSessionLeaseError)) throw error;
        void this.emitSessionListChanged();
        return;
      }
    }
    if (event === 'session.opened' && payload && typeof payload === 'object') {
      const opened = payload as Partial<SessionOpenedPayload>;
      const sessionPath = opened.session?.path;
      if (typeof sessionPath === 'string') {
        const coldStamps = this.coldSessionStore?.ownershipStamp(payload as object);
        if (coldStamps) {
          try {
            this.coldSessionStore!.publishSync(payload, () => undefined);
          } catch (error) {
            if (!(error instanceof StaleColdSessionLeaseError)) throw error;
            if (this.isSessionForgotten(sessionPath)) return;
            void this.refreshStaleSessionOpened(sessionPath, opened).catch((refreshError) => {
              backendWarn('backend-session', 'sessionOpened.coldPublicationRefreshFailed', {
                sessionPath,
                error: toErrorMessage(refreshError),
              });
            });
            return;
          }
        }
        // Final publication fence: ownership can change after the payload's
        // last awaited check but before its caller resumes to emit. Rebuild on
        // the winning generation while preserving selection ownership instead
        // of silently dropping the tokened open event.
        if (this.isSessionForgotten(sessionPath)) return;
      }
    }
    if (isBackendLivePipelineTraceEnabled()) {
      const scoped = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
      recordBackendLivePipelineTrace({
        stage: 'backend.mapped',
        kind: 'success',
        identifiers: {
          ...(typeof scoped?.sessionPath === 'string' ? { session: scoped.sessionPath } : {}),
          ...(typeof scoped?.requestId === 'string' ? { request: scoped.requestId } : {}),
          ...(typeof scoped?.turnId === 'string' ? { turn: scoped.turnId } : {}),
          ...(typeof scoped?.attemptId === 'string' ? { attempt: scoped.attemptId } : {}),
          ...(typeof scoped?.messageId === 'string' ? { message: scoped.messageId } : {}),
          ...(typeof scoped?.toolCallId === 'string' ? { tool: scoped.toolCallId } : {}),
        },
        eventKind: backendTraceEventKind(event),
        eventSeq: typeof scoped?.seq === 'number' && Number.isSafeInteger(scoped.seq) && scoped.seq >= 0
          ? scoped.seq
          : undefined,
      });
    }
    writeStdout({ event, payload });
  }

  private isBrowseResponseCurrent(result: unknown): boolean {
    if (!result || typeof result !== 'object') return true;
    if (this.coldSessionStore?.ownershipStamp(result as object)) {
      try {
        this.coldSessionStore.publishSync(result, () => undefined);
      } catch {
        return false;
      }
    }
    const stamp = this.browseResponseOwners.get(result as object);
    if (!stamp) return true;
    if (this.disposed || this.isSessionForgotten(stamp.sessionPath)) return false;
    if (!stamp.fingerprint) return false;
    try {
      return this.readColdBrowseFileFingerprintSync(stamp.sessionPath) === stamp.fingerprint;
    } catch {
      return false;
    }
  }

  async handleLine(line: string): Promise<void> {
    let request: RequestEnvelope;
    try {
      request = parseJsonOrThrow<RequestEnvelope>(line, 'request envelope');
    } catch (error) {
      writeStdout(responseError('parse-error', 'PARSE_ERROR', String(error)));
      return;
    }

    backendTrace('request', 'received', { id: request.id, method: request.method });
    // Reserve the diagnostics-toggle generation at production request
    // receipt, before any awaited handler work, so concurrent toggle requests
    // are ordered by receipt, not settlement. The reserved generation is
    // bound to this exact request and gates its off transition at completion:
    // an older off settling after a newer on must not disable tracing or stop
    // the event-loop monitor. Invalid toggles never reserve (they never
    // apply), so they cannot supersede a valid request's transition.
    const toggleGeneration = request.method === 'diagnostics.livePipeline.setEnabled'
      && parseLivePipelineToggleParams(request.params)
      ? this.reserveLivePipelineTraceToggle()
      : undefined;
    recordBackendLivePipelineTrace({
      stage: 'backend.request',
      kind: 'observation',
      phase: 'request_received',
      identifiers: { request: request.id },
      processRole: 'coordinator',
      pid: process.pid,
    });
    const requestStartedAt = performance.now();
    let requestValidated = false;
    const onRequestValidated = (): void => {
      if (requestValidated) return;
      requestValidated = true;
      recordBackendLivePipelineTrace({
        stage: 'backend.request',
        kind: 'success',
        phase: 'request_validated',
        identifiers: { request: request.id },
        processRole: 'coordinator',
        pid: process.pid,
      });
    };
    const invoke = () => this.handleRequest(
      request,
      onRequestValidated,
      toggleGeneration,
      request.method === 'session.open'
        ? (sample) => backendLog('info', 'backend-timing', 'session.open.stages', {
            requestId: request.id,
            ...sample,
          })
        : undefined,
    );
    // Exactly one finish/error completion per request: the success record is
    // emitted only after the final (possibly retried) handler run settles, and
    // a later response-write failure must not also emit a failure completion.
    let completionEmitted = false;
    try {
      let result = await timed(`request:${request.method}:${request.id}`, invoke);
      // Correlated browse responses do not pass through emit(), so perform the
      // generation/file fence at the actual writer boundary. The check and
      // write are synchronous with no event-loop gap; a superseded result is
      // rebuilt from the winning hot owner or fresh durable file.
      for (let attempt = 0; !this.isBrowseResponseCurrent(result); attempt += 1) {
        if (attempt >= 2) {
          throw new BackendError(
            'SESSION_CHANGED_DURING_READ',
            `The session changed repeatedly while ${request.method} was being published.`,
          );
        }
        result = await invoke();
      }
      backendTrace('request', 'handled', { id: request.id, method: request.method });
      recordBackendLivePipelineTrace({
        stage: 'backend.request',
        kind: 'success',
        phase: 'handler_finished',
        durationMs: Math.max(0, performance.now() - requestStartedAt),
        identifiers: { request: request.id },
        processRole: 'coordinator',
        pid: process.pid,
      });
      completionEmitted = true;
      if (this.completeLivePipelineTraceDisable(request.id)
        && result && typeof result === 'object' && 'health' in result) {
        // handleBackendRequest composes the same public response shape before
        // returning, while the server owns the actual off transition. Refresh
        // only the already-public health field after the atomic transition.
        result = { ...result, health: getBackendLivePipelineTraceHealth() };
      }
      writeStdout(responseOk(request.id, result));
    } catch (error) {
      this.cancelLivePipelineTraceDisable(request.id);
      const details = extractRequestError(error);
      const expectedCancellation = isExpectedSessionOperationCancellation(error);
      // A correlated handler failure has exactly one public owner: the RPC
      // response. Emitting a second generic `error` event made the host show and
      // count the same failure twice. Structured trace/stderr remains the
      // diagnostic channel; later asynchronous incidents use their dedicated
      // event families and identities.
      backendTrace('request', expectedCancellation ? 'cancelled' : 'error', {
        level: expectedCancellation ? 'debug' : 'warn',
        id: request.id,
        method: request.method,
        code: details.code,
        message: details.message,
      });
      if (!completionEmitted) {
        recordBackendLivePipelineTrace({
          stage: 'backend.request',
          kind: expectedCancellation ? 'transition' : 'failure',
          phase: 'handler_finished',
          durationMs: Math.max(0, performance.now() - requestStartedAt),
          identifiers: { request: request.id },
          ...(expectedCancellation
            ? {
              operationTerminalOutcome: 'cancelled' as const,
              operationTerminalReason: 'interrupted-before-commit' as const,
            }
            : { reasonCode: 'unknown_unattributable' as const }),
          processRole: 'coordinator',
          pid: process.pid,
        });
      }
      writeStdout(responseError(request.id, details.code, details.message, details.data));
    }
  }

  private initializeFilesystemLifecycle(): {
    store: SessionLifecycleStore;
    barrier: SessionFilesystemMutationBarrier;
  } {
    if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
      throw new BackendError('UNAVAILABLE', 'Filesystem lifecycle cutoff is not authorized.');
    }
    if (!this.lifecycleStore || !this.lifecycleBarrier) {
      const dataPaths = resolvePieDataPaths({ agentDir: this.agentDir });
      this.lifecycleStore = new SessionLifecycleStore(path.join(dataPaths.stateDir, 'session-lifecycle.sqlite'));
      this.lifecycleBarrier = new SessionFilesystemMutationBarrier({
        store: this.lifecycleStore,
        lockRoot: path.join(dataPaths.stateDir, 'session-mutation-locks'),
        writerAdmission: this.analyticsAuthority?.admission,
      });
      const cleaner = new SessionLifecycleCleaner({
        store: this.lifecycleStore,
        barrier: this.lifecycleBarrier,
        roots: { sessions: dataPaths.sessionsDir, artifacts: dataPaths.artifactsDir },
        cleanupExternalArtifact: async (artifact) => {
          if (artifact.artifactId === 'review-sidecar-entry') {
            forgetLegacyReviewArtifacts(artifact.location, artifact.sessionId);
            return;
          }
          if (artifact.artifactId === 'prompt-setting-entry') {
            await this.lifecycleBarrier!.runAdministrativeAsync(
              '__aggregate_session_prompt_settings__',
              'session.cleanup.prompt-setting-entry',
              () => writeSystemPromptTogglesForSession(artifact.location, [], true),
            );
            return;
          }
          throw new Error(`Unsupported external lifecycle artifact: ${artifact.artifactId}`);
        },
      });
      this.lifecycleScheduler = new SessionExpiryScheduler({
        store: this.lifecycleStore,
        cleaner,
        onError: (error) => log(`session lifecycle expiry failed closed: ${toErrorMessage(error)}`),
      });
      this.lifecycleScheduler.start();
    }
    return { store: this.lifecycleStore, barrier: this.lifecycleBarrier };
  }

  private async canonicalSessionArtifactPath(sessionPath: string): Promise<string> {
    const absolutePath = path.resolve(sessionPath);
    try { return await fs.realpath(absolutePath); } catch { return absolutePath; }
  }

  private managedSessionArtifactDirectories(canonicalPath: string): {
    baseName: string;
    directories: readonly { artifactId: string; path: string }[];
  } {
    const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
    const baseName = sanitize(path.basename(canonicalPath, path.extname(canonicalPath)));
    return {
      baseName,
      directories: [
        { artifactId: 'computer-use-artifacts', path: path.join(path.dirname(canonicalPath), 'computer-use', baseName) },
        {
          artifactId: 'playwright-artifacts',
          path: path.join(
            path.dirname(canonicalPath),
            'playwright',
            `${baseName}-${createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12)}`,
          ),
        },
      ],
    };
  }

  /** The computer-use owner partitions by a sanitized transcript basename,
   * unlike Playwright's canonical-path hash. Refuse cleanup if a sibling file
   * currently maps to that same partition rather than deleting shared data. */
  private async assertComputerArtifactDirectoryIsSessionScoped(canonicalPath: string, baseName: string): Promise<void> {
    const sessionDirectory = path.dirname(canonicalPath);
    for (const entry of await fs.readdir(sessionDirectory, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const candidatePath = path.join(sessionDirectory, entry.name);
      let candidateCanonicalPath: string;
      try {
        candidateCanonicalPath = await fs.realpath(candidatePath);
        if (!(await fs.stat(candidateCanonicalPath)).isFile()) continue;
      } catch {
        continue;
      }
      if (candidateCanonicalPath === canonicalPath
        || path.dirname(candidateCanonicalPath) !== sessionDirectory) continue;
      const candidateBaseName = path.basename(candidateCanonicalPath, path.extname(candidateCanonicalPath))
        .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
      if (candidateBaseName === baseName) {
        throw new Error(`Computer-use artifacts for ${canonicalPath} may be shared with ${candidateCanonicalPath}; refusing private cleanup.`);
      }
    }
  }

  private registerLifecycleArtifacts(
    store: SessionLifecycleStore,
    sessionId: string,
    sessionPath: string,
    nowMs: number,
    canonicalPath: string,
  ): void {
    const registered = new Set(store.listArtifacts(sessionId).map((artifact) => artifact.artifactId));
    if (!registered.has('transcript')) {
      store.registerArtifact({
        sessionId,
        artifactId: 'transcript',
        kind: 'transcript',
        locationKind: 'fixed_absolute',
        location: path.resolve(sessionPath),
      }, nowMs);
    }
    if (!registered.has('review-sidecar-entry')) {
      store.registerArtifact({
        sessionId, artifactId: 'review-sidecar-entry', kind: 'external_reference',
        locationKind: 'external', location: sessionPath,
      }, nowMs);
    }
    if (!registered.has('prompt-setting-entry')) {
      store.registerArtifact({
        sessionId, artifactId: 'prompt-setting-entry', kind: 'external_reference',
        locationKind: 'external', location: sessionPath,
      }, nowMs);
    }
    const mcpPath = sessionMcpOverridePath(sessionPath);
    if (!registered.has('mcp-override') && fsSync.existsSync(mcpPath)) {
      store.registerArtifact({
        sessionId, artifactId: 'mcp-override', kind: 'session_sidecar',
        locationKind: 'fixed_absolute', location: path.resolve(mcpPath),
        identityJson: filesystemArtifactIdentity(mcpPath),
      }, nowMs);
    }
    const managedDirectories = this.managedSessionArtifactDirectories(canonicalPath).directories;
    for (const { artifactId, path: artifactPath } of managedDirectories) {
      if (registered.has(artifactId) || !fsSync.existsSync(artifactPath)) continue;
      store.registerArtifact({
        sessionId, artifactId, kind: 'managed_cache', locationKind: 'fixed_absolute',
        location: artifactPath, identityJson: filesystemArtifactIdentity(artifactPath),
      }, nowMs);
    }
  }

  /** Recover a create/duplicate whose durable lifecycle registration committed
   * before the process-local request ledger recorded its path. Never create a
   * second transcript for an already-owned operation after backend restart. */
  private resolvePendingCreateReplay(pendingCreateOperationId?: string): string | undefined {
    if (
      process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE
      || !pendingCreateOperationId
    ) return undefined;
    const operationId = pendingCreateOperationId;
    const { store } = this.initializeFilesystemLifecycle();
    const existing = store.getByPendingCreateOperationId(operationId);
    if (!existing) return undefined;
    const transcriptRelativePath = existing.transcriptRelativePath;
    if (!transcriptRelativePath || existing.cleanupState !== 'open') {
      throw new Error(`Pending-create operation ${operationId} no longer has an open transcript.`);
    }
    const sessionRoot = path.resolve(this.getSessionDir()!);
    const sessionPath = path.resolve(sessionRoot, transcriptRelativePath);
    const relative = path.relative(sessionRoot, sessionPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Pending-create operation ${operationId} has an invalid transcript path.`);
    }
    if (!fsSync.existsSync(sessionPath)) {
      throw new Error(`Pending-create operation ${operationId} lost its registered transcript.`);
    }
    return sessionPath;
  }

  private async registerNewSessionLifecycle(sessionPath: string, pendingCreateOperationId?: string): Promise<void> {
    if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) return;
    const { store, barrier } = this.initializeFilesystemLifecycle();
    const sessionId = resolveSessionIdentity(sessionPath).sessionId;
    const canonicalPath = await this.canonicalSessionArtifactPath(sessionPath);
    barrier.runAdministrative(sessionId, 'coordinator-create-register', () => {
      const nowMs = Date.now();
      this.registerLifecycleArtifacts(store, sessionId, sessionPath, nowMs, canonicalPath);
      if (pendingCreateOperationId) {
        store.registerPendingCreateOperation(sessionId, pendingCreateOperationId, nowMs);
      }
      store.setPrivacyMode(sessionId, 'off', nowMs);
    });
  }

  private async withAnalyticsWriterAdmission<T>(operation: () => T): Promise<T> {
    const releaseAdmission = this.analyticsAuthority?.admission?.acquire();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseAdmission?.();
    };
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return await Promise.resolve(result).finally(release) as T;
      }
      release();
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async runSessionFilesystemMutation<T>(
    sessionPath: string,
    seam: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] === STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
      const { barrier } = this.initializeFilesystemLifecycle();
      const sessionId = resolveSessionIdentity(sessionPath).sessionId;
      return await barrier.runWriteMutationAsync(sessionId, seam, operation);
    }
    // Analytics activation can fence writers before storage-cutoff lifecycle
    // mode is authorized. Direct sidecar/filesystem mutations still need a
    // durable lease in that ordinary production mode.
    return await this.withAnalyticsWriterAdmission(operation);
  }

  /** Correlated coordinator→host execution-settings bridge. The request is
   * registered before emit so an immediate host acknowledgement cannot race
   * registration; a bounded missing response is explicitly unknown. */
  private async requestHostSessionControlSettings(
    sessionPath: string,
    action: 'capture' | 'apply',
    settings?: SessionControlExecutionSettingsPatch,
  ): Promise<SessionControlSettingsAcknowledgement | undefined> {
    const requestId = `agent-settings:${++this.hostSessionSettingsRequestSequence}:${randomUUID()}`;
    const request = validateSessionControlSettingsRequest({
      requestId,
      sessionPath,
      action,
      ...(settings ? { settings } : {}),
    });
    let resolve!: HostSessionSettingsRequestEntry['resolve'];
    const result = new Promise<SessionControlSettingsAcknowledgement | undefined>((settle) => {
      resolve = settle;
    });
    const entry: HostSessionSettingsRequestEntry = {
      sessionPath,
      action,
      resolve,
      timer: setTimeout(() => {
        if (this.hostSessionSettingsRequests.get(requestId) !== entry) return;
        this.hostSessionSettingsRequests.delete(requestId);
        entry.resolve(undefined);
      }, HOST_SESSION_SETTINGS_ACK_TIMEOUT_MS),
    };
    this.hostSessionSettingsRequests.set(requestId, entry);
    try {
      this.emit(SESSION_CONTROL_SETTINGS_REQUEST_EVENT, request);
    } catch (error) {
      clearTimeout(entry.timer);
      this.hostSessionSettingsRequests.delete(requestId);
      throw error;
    }
    return await result;
  }

  private async acknowledgeHostSessionControlSettings(
    acknowledgement: SessionControlSettingsAcknowledgement,
  ): Promise<{ ok: boolean; acknowledged: boolean }> {
    const validated = validateSessionControlSettingsAcknowledgement(acknowledgement);
    const entry = this.hostSessionSettingsRequests.get(validated.requestId);
    if (!entry
      || entry.action !== validated.action
      || backendSessionPathKey(entry.sessionPath) !== backendSessionPathKey(validated.sessionPath)) {
      return { ok: true, acknowledged: false };
    }
    this.hostSessionSettingsRequests.delete(validated.requestId);
    clearTimeout(entry.timer);
    entry.resolve(validated);
    return { ok: true, acknowledged: true };
  }

  /** Typed coordinator→host close bridge. Emits `session.close.requested` for
   *  the host's reducer-owned close lifecycle and waits for the typed
   *  `session.closeAcknowledgement` RPC. The request marks whether the target
   *  is the requesting worker's own session: foreign closes start stopping
   *  after host acceptance, while self-close waits until its result is sent
   *  to the caller. A bounded handoff fallback keeps self-close cleanup alive
   *  if the source worker disappears. Repeated close joins the owning request
   *  under the same path admission fence. */
  private async requestHostSessionClose(
    sessionPath: string,
    requestId: string,
    deleteRequested: boolean,
    selfRequester: boolean,
  ): Promise<WorkerSessionControlOutcome> {
    const fencingKey = backendSessionPathKey(sessionPath);
    const existing = this.closingSessionRequests.get(fencingKey);
    if (existing) {
      if (!existing.settled && existing.delete !== deleteRequested) {
        throw new BackendError(
          'OPERATION_INTENT_MISMATCH',
          'The session already has an owning close request with a different deletion intent.',
        );
      }
      return await this.closeOutcomeForCaller(existing, selfRequester);
    }
    const entry: HostCloseRequestEntry = {
      sessionPath,
      requestId,
      delete: deleteRequested,
      acceptPromise: undefined as unknown as Promise<boolean>,
      settlePromise: undefined as unknown as Promise<HostCloseOutcome>,
    };
    entry.acceptPromise = new Promise<boolean>((resolve) => {
      entry.accept = resolve;
    });
    entry.settlePromise = new Promise<HostCloseOutcome>((resolve) => {
      entry.settle = resolve;
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (this.hostCloseAcceptTimeoutMs > 0) {
      timers.push(setTimeout(() => entry.accept?.(false), this.hostCloseAcceptTimeoutMs));
    }
    if (this.hostCloseCompleteTimeoutMs > 0) {
      timers.push(setTimeout(() => {
        if (entry.handoffRequired && !entry.handoffReleased) this.releaseHostCloseHandoff(entry);
        this.settleHostCloseRequest(
          entry,
          { phase: 'unknown', error: 'The host close acknowledgement did not arrive within the request budget.' },
        );
      }, this.hostCloseCompleteTimeoutMs));
    }
    entry.timers = timers;
    // Invalidate sends that captured this path before configuration began.
    // This is an admission-generation fence only; it does not interrupt an
    // already-running SDK operation or alter ordinary Stop policy.
    this.workerRuntimeRouter?.invalidatePendingRuntimeOperations?.(sessionPath);
    // Register the admission fence BEFORE the host is told about the close:
    // the host processes the request synchronously (UI close admission +
    // membership sync + ack effects), so every racing admission on this
    // coordinator must already be fenced before the request crosses the
    // bridge.
    this.hostCloseRequests.set(requestId, entry);
    this.closingSessionRequests.set(fencingKey, entry);
    this.emit('session.close.requested', {
      sessionPath,
      requestId,
      delete: deleteRequested,
      selfHandoffRequired: selfRequester,
    } satisfies SessionCloseRequestedPayload);
    try {
      return await this.closeOutcomeForCaller(entry, selfRequester);
    } finally {
      if (entry.settled) {
        for (const timer of timers) clearTimeout(timer);
      } else if (entry.accepted !== true) {
        // The request ended without the host ever acknowledging it: release
        // the fence so the session is not admission-blocked forever.
        for (const timer of timers) clearTimeout(timer);
        this.settleHostCloseRequest(entry, {
          phase: 'unknown',
          error: 'The host close request ended without a terminal acknowledgement.',
        });
      }
      // Accepted but not yet terminal: the fence and the terminal-ack budget
      // stay active so host cleanup keeps fencing new admission and a late
      // acknowledgement still settles exactly once.
    }
  }

  /** Close outcome for one caller, preserving the self/foreign rule: self
   *  reports `closeRequested` and never claims completion; cross-session
   *  close reports confirmed completion or an explicit failure/unknown. */
  private closeRequestWorkerResult(
    entry: HostCloseRequestEntry,
    selfRequester: boolean,
    accepted: boolean,
    settled: HostCloseOutcome | undefined,
  ): WorkerSessionControlOutcome {
    if (selfRequester) {
      if (!accepted) {
        return { result: workerJson({
          sessionPath: entry.sessionPath,
          closed: false,
          closeRequested: false,
          unknown: true,
          deletionRequested: entry.delete,
        }) };
      }
      // Never claim the session has already closed: the host retains shutdown
      // and failure handling after this acknowledgement.
      return { result: workerJson({
        sessionPath: entry.sessionPath,
        closed: false,
        closeRequested: true,
        deletionRequested: entry.delete,
      }) };
    }
    const outcome = settled ?? { phase: 'unknown' as const };
    if (outcome.phase === 'failed') {
      throw new BackendError(
        'SESSION_CLOSE_FAILED',
        outcome.error ?? 'The host-reported session close failed.',
      );
    }
    return { result: workerJson({
      sessionPath: entry.sessionPath,
      closed: outcome.phase === 'completed',
      ...(outcome.phase === 'completed' ? {} : { unknown: true }),
      deletionRequested: entry.delete,
    }) };
  }

  private async closeOutcomeForCaller(
    entry: HostCloseRequestEntry,
    selfRequester: boolean,
  ): Promise<WorkerSessionControlOutcome> {
    const accepted = await entry.acceptPromise;
    if (selfRequester) {
      entry.handoffRequired = true;
      const outcome = this.closeRequestWorkerResult(entry, true, accepted, undefined);
      if (!entry.settled && !entry.handoffReleased && this.hostCloseHandoffTimeoutMs > 0 && !entry.handoffTimer) {
        entry.handoffTimer = setTimeout(
          () => this.releaseHostCloseHandoff(entry),
          this.hostCloseHandoffTimeoutMs,
        );
      }
      return {
        ...outcome,
        afterResponse: () => this.releaseHostCloseHandoff(entry),
      };
    }
    const settled = await entry.settlePromise;
    return this.closeRequestWorkerResult(entry, false, accepted, settled);
  }

  /** Runs only after the coordinator has handed a self-close result back to
   *  the worker, or after the bounded source-loss fallback expires. */
  private releaseHostCloseHandoff(entry: HostCloseRequestEntry): void {
    if (entry.handoffReleased) return;
    if (entry.handoffTimer) {
      clearTimeout(entry.handoffTimer);
      entry.handoffTimer = undefined;
    }
    try {
      this.emit('session.close.responseDelivered', {
        sessionPath: entry.sessionPath,
        requestId: entry.requestId,
      } satisfies SessionCloseResponseDeliveredPayload);
      entry.handoffReleased = true;
    } catch (error) {
      backendWarn('backend-session', 'close.responseHandoff.failed', {
        requestId: entry.requestId,
        error: toErrorMessage(error),
      });
    }
  }

  /** Resolve exactly one close entry and release its admission fence. Late
   *  joiners still holding the resolved promises observe the same outcome. */
  private settleHostCloseRequest(entry: HostCloseRequestEntry, outcome: HostCloseOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    for (const timer of entry.timers ?? []) clearTimeout(timer);
    entry.timers = [];
    if (entry.handoffTimer && (entry.handoffReleased || outcome.phase !== 'unknown')) {
      clearTimeout(entry.handoffTimer);
      entry.handoffTimer = undefined;
    }
    const fencingKey = backendSessionPathKey(entry.sessionPath);
    if (this.closingSessionRequests.get(fencingKey) === entry) {
      this.closingSessionRequests.delete(fencingKey);
    }
    if (this.hostCloseRequests.get(entry.requestId) === entry) {
      this.hostCloseRequests.delete(entry.requestId);
    }
    entry.settle?.(outcome);
  }

  /** Typed host close bridge acknowledgement RPC. Unknown or late request
   *  identities are tolerated (`acknowledged: false`), never treated as
   *  success for a different request. */
  private acknowledgeHostCloseRequest(
    params: SessionCloseAcknowledgementParams,
  ): Promise<{ ok: boolean; acknowledged: boolean }> {
    const entry = this.hostCloseRequests.get(params.requestId);
    if (!entry || backendSessionPathKey(entry.sessionPath) !== backendSessionPathKey(params.sessionPath)) {
      return Promise.resolve({ ok: true, acknowledged: false });
    }
    if (params.phase === 'accepted') {
      entry.accepted = true;
      entry.accept?.(true);
    } else {
      this.settleHostCloseRequest(entry, params.phase === 'unknown'
        ? { phase: 'unknown' }
        : { phase: params.phase, ...(params.error ? { error: params.error } : {}) });
    }
    return Promise.resolve({ ok: true, acknowledged: true });
  }

  /** Closing-session admission fence: a racing send/continue cannot promote,
   *  start, or restart a session with an outstanding host-owned close command
   *  (coordinator-requested or host-membership reported). */
  private assertSessionNotClosing(sessionPath: string): void {
    const key = backendSessionPathKey(sessionPath);
    if (this.closingSessionRequests.has(key) || this.hostMembershipClosing.has(key)) {
      throw new BackendError(
        'SESSION_CLOSING',
        'The target session is closing; new execution cannot be admitted for it.',
      );
    }
  }

  /** Session-control sends need a fresh live-membership check after their
   *  asynchronous settings/configuration work. Reuse the same live-create
   *  publication-gap authority as target resolution; ordinary UI sends keep
   *  their existing route admission contract. */
  private assertSessionControlSendAdmissionOpen(sessionPath: string): void {
    this.assertSessionNotClosing(sessionPath);
    this.resolveLiveSessionPath(sessionPath, sessionPath, 'message');
  }

  /** Ingest one ordered host live-membership snapshot. Application is
   *  synchronous so the coordinator observes snapshots in the host's dispatch
   *  order; stale revisions are dropped. Membership is authoritative live
   *  state once seen and is never persisted. */
  private applyHostLiveMembership(snapshot: HostLiveMembershipSnapshotParams): void {
    if (this.hostMembershipRevision >= snapshot.revision) return;
    const sessions = new Map<string, { entry: LiveSessionMembershipEntry }>();
    for (const entry of snapshot.sessions) {
      const key = backendSessionPathKey(entry.path);
      if (sessions.has(key)) continue;
      sessions.set(key, { entry });
    }
    const closing = new Map<string, LiveSessionClosingEntry>();
    for (const entry of snapshot.closing) {
      closing.set(backendSessionPathKey(entry.path), entry);
    }
    const previousSessions = this.hostMembershipSessions.sessions;
    const previousClosing = this.hostMembershipClosing;
    // Host-originated closes may not have an outgoing coordinator close
    // request to invalidate old asynchronous sends. Fence live paths as they
    // leave membership, and newly reported close reservations before replacing
    // the authoritative projection. Repeated snapshots do not keep bumping a
    // path that is already absent/closing.
    for (const [key, { entry }] of previousSessions) {
      if (!sessions.has(key) && !closing.has(key)) {
        this.workerRuntimeRouter?.invalidatePendingRuntimeOperations?.(entry.path);
      }
    }
    for (const [key, entry] of closing) {
      if (!previousClosing.has(key)) {
        this.workerRuntimeRouter?.invalidatePendingRuntimeOperations?.(entry.path);
      }
    }
    this.hostMembershipSessions = { revision: snapshot.revision, sessions };
    this.hostMembershipClosing = closing;
    this.hostMembershipRevision = snapshot.revision;
    this.hostMembershipSeen = true;
    for (const key of sessions.keys()) this.newCreatePublicationPaths.delete(key);
    if (!this.liveSessionTitles.ready && !this.titleNamespaceHydration) {
      // A new authoritative snapshot starts a fresh finite retry budget, even
      // if the prior snapshot exhausted all of its transient-failure attempts.
      this.clearLiveTitleNamespaceRetry();
    }
    this.syncLiveSessionTitles();
  }

  /** Cancel the process-local bootstrap retry timer and discard its backoff. */
  private clearLiveTitleNamespaceRetry(): void {
    if (this.titleNamespaceRetryTimer) clearTimeout(this.titleNamespaceRetryTimer);
    this.titleNamespaceRetryTimer = undefined;
    this.titleNamespaceRetryAttempt = 0;
  }

  /** Retry only the initial namespace bootstrap: never queue a waiter or make
   *  unrelated naming/admission work depend on this timer. An unchanged
   *  membership gets a finite exponential-backoff budget; a later snapshot
   *  starts a fresh bootstrap attempt in the same backend generation. */
  private scheduleLiveTitleNamespaceRetry(generation: number): void {
    if (this.disposed || generation !== this.backendGeneration || !this.hostMembershipSeen
      || this.liveSessionTitles.ready || this.titleNamespaceRetryTimer
      || this.titleNamespaceRetryAttempt >= LIVE_TITLE_NAMESPACE_RETRY_LIMIT) return;
    const delay = Math.min(
      LIVE_TITLE_NAMESPACE_RETRY_BASE_DELAY_MS * (2 ** this.titleNamespaceRetryAttempt),
      LIVE_TITLE_NAMESPACE_RETRY_MAX_DELAY_MS,
    );
    this.titleNamespaceRetryAttempt += 1;
    const timer = setTimeout(() => {
      if (this.titleNamespaceRetryTimer !== timer) return;
      this.titleNamespaceRetryTimer = undefined;
      if (this.disposed || generation !== this.backendGeneration || this.liveSessionTitles.ready) return;
      this.syncLiveSessionTitles();
    }, delay);
    timer.unref?.();
    this.titleNamespaceRetryTimer = timer;
  }

  /** Establish or refresh the unique live-title namespace from the latest
   *  applied membership snapshot. Initialization reads the resolved durable
   *  identity (sessionId, durable header timestamp, existing assigned title)
   *  directly from each live member's own transcript — never the archive
   *  catalog — and fails closed until the full reconciliation settles. A
   *  failed close restores membership instead of releasing; only a path
   *  present in the previous snapshot yet absent from both live and closing
   *  maps confirms its close and frees its assignment. */
  private syncLiveSessionTitles(): void {
    if (this.disposed) return;
    if (!this.liveSessionTitles.ready) {
      // A newer complete membership is a fresh chance to hydrate and must not
      // wait out a retry scheduled for the prior snapshot.
      if (this.titleNamespaceRetryTimer) this.clearLiveTitleNamespaceRetry();
      if (this.titleNamespaceHydration) return;
      const revision = this.hostMembershipRevision;
      const generation = this.backendGeneration;
      const hydration = this.initializeLiveTitleNamespace(generation)
        .catch((error) => {
          backendWarn('backend-live-titles', 'live title namespace hydration failed', {
            error: toErrorMessage(error),
          });
        })
        .finally(() => {
          if (this.titleNamespaceHydration !== hydration) return;
          this.titleNamespaceHydration = undefined;
          if (this.disposed || generation !== this.backendGeneration) return;
          if (this.liveSessionTitles.ready) {
            this.clearLiveTitleNamespaceRetry();
            return;
          }
          // A newer snapshot may have landed during header reads or a fenced
          // write. Retry immediately from that complete latest membership.
          if (this.hostMembershipRevision !== revision) {
            this.titleNamespaceRetryAttempt = 0;
            this.syncLiveSessionTitles();
            return;
          }
          this.scheduleLiveTitleNamespaceRetry(generation);
        });
      this.titleNamespaceHydration = hydration;
      return;
    }
    this.clearLiveTitleNamespaceRetry();
    this.freeRetiredLiveSessionTitles();
    for (const [key, { entry }] of this.hostMembershipSessions.sessions) {
      if (!this.liveSessionTitles.assigned(entry.path)) this.pendingLiveTitlePaths.add(key);
    }
    if (this.titleAdmission) return;
    const admission = this.admitNewLiveSessionTitles().catch((error) => {
      backendWarn('backend-live-titles', 'live title admission refresh failed', {
        error: toErrorMessage(error),
      });
    }).finally(() => {
      if (this.titleAdmission === admission) this.titleAdmission = undefined;
    });
    this.titleAdmission = admission;
  }

  /** Read the resolved durable title facts for one live member from its own
   *  transcript header and session_info entries: never the archive catalog nor
   *  the tool-list page. Bounded re-reads tolerate an concurrently appending
   *  hot worker; a persistently unstable read fails the whole hydration so the
   *  namespace stays closed rather than partially claimed. */
  private async readLiveSessionTitleEntry(
    sessionPath: string,
  ): Promise<LiveSessionTitleEntry> {
    let fingerprint = await statBackendSessionFile(sessionPath);
    if (!fingerprint) {
      throw new BackendError('SESSION_NOT_FOUND', `A live session's transcript is unreadable: ${sessionPath}`);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const read = await readIndexedSessionMetadata(fingerprint);
      if (read.status === 'ok') {
        const identity = resolveSessionIdentity(sessionPath);
        return {
          sessionPath,
          sessionId: identity.sessionId,
          ...(read.metadata.summary.headerTimestamp ? { headerTimestamp: read.metadata.summary.headerTimestamp } : {}),
          ...(read.metadata.summary.isAssignedTitle === true && read.metadata.summary.name
            ? { title: read.metadata.summary.name }
            : {}),
        };
      }
      if (read.status === 'invalid') {
        throw new Error(`A live session's transcript is invalid: ${sessionPath}`);
      }
      const refreshed = await statBackendSessionFile(sessionPath);
      if (!refreshed) {
        throw new BackendError('SESSION_NOT_FOUND', `A live session's transcript is unreadable: ${sessionPath}`);
      }
      fingerprint = refreshed;
    }
    throw new Error(`A live session's transcript kept changing while its title facts were read: ${sessionPath}`);
  }

  /** Persist one assigned title through the owning writer: the hot worker
   *  where its lease is live, otherwise the lease-fenced cold store. The
   *  coordinator never writes session JSONL under a worker lease. */
  private async persistAssignedSessionTitle(sessionPath: string, title: string, requestId: string, replaceExpectedTitle?: string): Promise<void> {
    const router = this.workerRuntimeRouter;
    if (router?.hasHotOwner(sessionPath)) {
      const outcome = await router.assignSessionTitle(sessionPath, title, requestId, replaceExpectedTitle);
      if (outcome.skipped === 'explicit-name' || outcome.assigned !== true) {
        throw new BackendError(
          'SESSION_OWNERSHIP_CONFLICT',
          `The session already carries an explicit assigned title while live: ${sessionPath}`,
        );
      }
      return;
    }
    await this.persistAssignedColdSessionTitle(sessionPath, title, replaceExpectedTitle);
  }

  /** Lease-fenced cold-store title persistence for sessions without a hot
   *  runtime owner (newly created or restored cold members). */
  private async persistAssignedColdSessionTitle(sessionPath: string, title: string, replaceExpectedTitle?: string): Promise<void> {
    const store = this.initializeColdSessionStore();
    await this.runColdSessionMutation(sessionPath, async () => {
      const retained = this.coldSessionManagerHandles.get(this.coldManagerKey(sessionPath));
      const durableName = retained
        ? retained.handle.manager.getSessionName()
        : this.sdk.SessionManager.open(sessionPath).getSessionName();
      if (replaceExpectedTitle !== undefined
        ? durableName?.trim() !== replaceExpectedTitle
        : Boolean(durableName?.trim())) {
        throw new BackendError('SESSION_OWNERSHIP_CONFLICT', 'An intervening assigned title must not be overwritten.');
      }
      if (retained) store.setHandleSessionTitle(retained.handle, title);
      else store.setSessionTitle(sessionPath, title);
    });
  }

  /** Reserve, durably persist on the owning owner, then confirm one unique
   *  assigned title. Reservation conflicts with a meanwhile-restored durable
   *  name release and retry under the resolved namespace; persisted titles are
   *  appended by the owner and a later append re-records the retry, so no name
   *  is ever claimed twice. Failures leave the session provisional and keep
   *  the authority's namespace intact. */
  private async assignCreatedSessionTitle(
    sessionPath: string,
    baseTitle: string,
    _requestId: string,
  ): Promise<{ assigned: boolean; title?: string; error?: string }> {
    if (!this.liveSessionTitles.ready) {
      throw new BackendError(
        'LIVE_TITLE_NAMESPACE_UNAVAILABLE',
        'The live session title namespace is not ready; creation with a title fails closed.',
      );
    }
    let normalized: string;
    try {
      normalized = normalizeSessionControlBaseTitle(baseTitle);
    } catch (error) {
      return { assigned: false, error: `LIVE_TITLE_BASE_INVALID: ${toErrorMessage(error)}` };
    }
    const identity = resolveSessionIdentity(sessionPath);
    const existing = this.liveSessionTitles.assigned(sessionPath);
    if (existing) return { assigned: true, title: existing };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let reservation: LiveSessionTitleReservation;
      try {
        reservation = this.liveSessionTitles.reserve(normalized, {
          sessionPath,
          sessionId: identity.sessionId,
        });
      } catch (error) {
        if (error instanceof LiveTitleNamespaceUnavailableError) {
          throw new BackendError(
            'LIVE_TITLE_NAMESPACE_UNAVAILABLE',
            'The live session title namespace is not ready; creation with a title fails closed.',
          );
        }
        return { assigned: false, error: `LIVE_TITLE_RESERVATION_FAILED: ${toErrorMessage(error)}` };
      }
      try {
        await this.persistAssignedColdSessionTitle(sessionPath, reservation.title);
        this.liveSessionTitles.confirm(reservation);
        return { assigned: true, title: reservation.title };
      } catch (error) {
        try { this.liveSessionTitles.release(reservation); } catch { /* stale reservation already freed */ }
        const conflict = /conflicts/.test(toErrorMessage(error));
        if (!conflict || attempt === 2) {
          return { assigned: false, error: `LIVE_TITLE_ASSIGNMENT_FAILED: ${toErrorMessage(error)}` };
        }
      }
    }
    return { assigned: false, error: 'LIVE_TITLE_ASSIGNMENT_FAILED: retries exhausted.' };
  }

  /** Admit a duplicated or reopened durable title before its opened event
   *  reaches the host. Unlike background refresh, failures block publication. */
  private async admitOpenedSessionTitle(sessionPath: string, allowStartupRestore = false): Promise<void> {
    const key = this.coldManagerKey(sessionPath);
    if (!this.liveSessionTitles.ready) {
      // Startup restoration may open its existing tab while the complete
      // snapshot is still hydrating. This is not a new admission; the
      // namespace remains unavailable until that hydration succeeds.
      if (allowStartupRestore && this.hostMembershipSessions.sessions.has(key)) return;
      throw new LiveTitleNamespaceUnavailableError();
    }
    let admission = this.pendingOpenedTitleAdmissions.get(key);
    if (!admission) {
      admission = (async () => {
        if (!this.liveSessionTitles.assigned(sessionPath)) {
          const entry = await this.readLiveSessionTitleEntry(sessionPath);
          await this.liveSessionTitles.admit([entry],
            (path, title, expected) => this.persistAssignedSessionTitle(path, title, 'live-title-open', expected));
        }
      })();
      this.pendingOpenedTitleAdmissions.set(key, admission);
      void admission.finally(() => {
        if (this.pendingOpenedTitleAdmissions.get(key) === admission) this.pendingOpenedTitleAdmissions.delete(key);
      }).catch(() => undefined);
    }
    await admission;
  }

  /** Initial namespace establishment from the first complete restored
   *  membership snapshot. */
  private async initializeLiveTitleNamespace(generation: number): Promise<void> {
    const snapshot = this.hostMembershipSessions;
    const entries: LiveSessionTitleEntry[] = [];
    for (const { entry } of snapshot.sessions.values()) {
      if (this.disposed || generation !== this.backendGeneration) return;
      entries.push(await this.readLiveSessionTitleEntry(entry.path));
    }
    if (this.disposed || generation !== this.backendGeneration || this.hostMembershipSessions !== snapshot) return;
    await this.liveSessionTitles.reconcile(
      entries,
      (sessionPath, title, expected) => this.persistAssignedSessionTitle(sessionPath, title, 'live-title-hydration', expected),
      () => !this.disposed && generation === this.backendGeneration && this.hostMembershipSessions === snapshot,
    );
    if (this.disposed || generation !== this.backendGeneration || this.hostMembershipSessions !== snapshot) return;
    // Seed the removal basis exactly once per namespace generation.
    this.authoritativeLiveTitlePaths = new Map([
      ...[...snapshot.sessions.entries()].map(([key, { entry }]) => [key, entry.path] as [string, string]),
      ...[...this.hostMembershipClosing.entries()].map(([key, entry]) => [key, entry.path] as [string, string]),
    ]);
  }

  /** Confirmed-close release: previous live members that disappeared from both
   *  live and closing maps freed their assigned names (identity is not
   *  preserved; a reopen reclaims or re-suffixes below). Paths retained by an
   *  in-flight creation (publication gap) are never present here. */
  private freeRetiredLiveSessionTitles(): void {
    for (const [key, publicPath] of this.authoritativeLiveTitlePaths) {
      if (this.hostMembershipSessions.sessions.has(key)) continue;
      if (this.hostMembershipClosing.has(key)) continue;
      this.liveSessionTitles.retireLive(publicPath);
      this.newCreatePublicationPaths.delete(key);
      this.pendingLiveTitlePaths.delete(key);
      this.authoritativeLiveTitlePaths.delete(key);
    }
    for (const [key, { entry }] of this.hostMembershipSessions.sessions) this.authoritativeLiveTitlePaths.set(key, entry.path);
    for (const [key, entry] of this.hostMembershipClosing) this.authoritativeLiveTitlePaths.set(key, entry.path);
  }

  /** Publish durable assigned titles for newly admitted live members (a
   *  reopened history session, a duplicate tab, or a just-created session
   *  whose host snapshot was in flight during its assignment). Only entries
   *  without a current assignment are admitted. */
  private async admitNewLiveSessionTitles(): Promise<void> {
    // Refresh each path through the same per-path admission gate as an open
    // operation. A host snapshot that overtakes duplicate/reopen publication
    // joins its in-flight persistence rather than allocating a second suffix.
    let changed: boolean;
    do {
      const snapshot = this.hostMembershipSessions;
      for (const [key, { entry }] of snapshot.sessions) {
        if (snapshot !== this.hostMembershipSessions) break;
        if (!this.liveSessionTitles.assigned(entry.path)) {
          await this.admitOpenedSessionTitle(entry.path);
        }
        if (!this.hostMembershipSessions.sessions.has(key)
          && !this.hostMembershipClosing.has(key)) {
          this.liveSessionTitles.retireLive(entry.path);
        }
        this.pendingLiveTitlePaths.delete(key);
      }
      changed = snapshot !== this.hostMembershipSessions;
      if (changed) this.freeRetiredLiveSessionTitles();
    } while (changed);
  }

  /** Finalize one generated candidate through the title authority before it
   *  is visible: gate on the namespace and any already-assigned title, reserve
   *  the candidate, persist it on the owning hot worker, then confirm. A
   *  fallback finalization applies the bounded first-prompt snippet when the
   *  generation itself failed, so both endings finalize ownership-safe before
   *  the response (or list) exposes a name. */
  private async finalizeGeneratedLiveSessionTitle(
    sessionPath: string,
    prompt: string,
    generation: { generated?: unknown; name?: unknown; reason?: unknown },
    requestId: string,
  ): Promise<unknown> {
    const generated = generation.generated === true && typeof generation.name === 'string' && generation.name.trim();
    // Startup's one-time namespace hydration is required for allocation;
    // this does not wait for any unrelated naming model or archive scan.
    if (!this.liveSessionTitles.ready) await this.titleNamespaceHydration;
    try {
      const result = generated
        ? await this.finalizeCandidateSessionTitle(sessionPath, generation.name as string, requestId)
        : await this.finalizeFallbackSessionTitle(sessionPath, prompt, requestId);
      const base = generation && typeof generation === 'object' ? { ...generation } : {};
      const assignedTitle = result.assigned && typeof result.title === 'string' ? result.title : undefined;
      return assignedTitle ? { ...base, generated: true, name: assignedTitle } : base;
    } catch (error) {
      // Namespace/owner failures fail closed to the provisional snippet; the
      // attempt is consumed rather than retried implicitly.
      backendWarn('backend-live-titles', 'live title finalization failed', {
        sessionPath,
        error: toErrorMessage(error),
      });
      return generated
        ? { generated: false, reason: 'assignment-failed' }
        : { ...generation };
    }
  }

  private async finalizeCandidateSessionTitle(
    sessionPath: string,
    candidate: string,
    requestId: string,
  ): Promise<{ assigned: boolean; title?: string }> {
    if (!this.liveSessionTitles.ready) return { assigned: false };
    // A durably assigned title always wins and must never be replaced by
    // generation: the candidate is dropped when the session is already named.
    if (this.liveSessionTitles.assigned(sessionPath)) return { assigned: false };
    const identity = resolveSessionIdentity(sessionPath);
    const reservation = this.liveSessionTitles.reserve(candidate, {
      sessionPath,
      sessionId: identity.sessionId,
    });
    try {
      await this.persistAssignedSessionTitle(sessionPath, reservation.title, `${requestId}:title`);
      const key = this.coldManagerKey(sessionPath);
      if (this.hostMembershipSeen
        && (!this.hostMembershipSessions.sessions.has(key) || this.hostMembershipClosing.has(key))) {
        throw new BackendError('SESSION_CLOSING', 'Title assignment finished after the session stopped being live.');
      }
      this.liveSessionTitles.confirm(reservation);
      return { assigned: true, title: reservation.title };
    } catch (error) {
      try { this.liveSessionTitles.release(reservation); } catch { /* already freed */ }
      throw error;
    }
  }

  private async finalizeFallbackSessionTitle(
    sessionPath: string,
    prompt: string,
    requestId: string,
  ): Promise<{ assigned: boolean; title?: string }> {
    if (!this.liveSessionTitles.ready) return { assigned: false };
    if (this.liveSessionTitles.assigned(sessionPath)) return { assigned: false };
    const fallback = deriveSessionNameFromText(prompt).name;
    if (!fallback || fallback === NEW_SESSION_NAME) return { assigned: false };
    try {
      return await this.finalizeCandidateSessionTitle(sessionPath, fallback, requestId);
    } catch (error) {
      backendWarn('backend-live-titles', 'fallback title finalization failed', {
        sessionPath,
        error: toErrorMessage(error),
      });
      return { assigned: false };
    }
  }

  /** Host-owned live list projection, including emitted newly created tabs
   *  during the interval before the next host membership snapshot. Closed
   *  sessions and the durable catalog are never the source. */
  private listLiveSessions(): WorkerJsonValue {
    const now = Date.now();
    const assignedTitles = this.liveSessionTitles;
    const projection = (entries: Iterable<LiveSessionMembershipEntry>) => {
      const allEntries = [...entries];
      const rows = allEntries.slice(0, AGENT_SESSION_CONTROL_MAX_LIST_ITEMS).map((entry) => {
        const route = this.workerRuntimeRouter?.getRoute(entry.path);
        const busy = route !== undefined && route.state !== 'cold'
          && (route.state !== 'hot' || route.checkpoint.requestId !== undefined);
        // Only the coordinator's confirmed authority supplies addressable
        // titles; a host-projected label cannot bypass pending hydration or
        // an in-flight owner persistence acknowledgement.
        const assignedTitle = assignedTitles.ready
          ? assignedTitles.assigned(entry.path)
          : undefined;
        const projected = {
          path: entry.path,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          ...(assignedTitle !== undefined ? { title: assignedTitle } : {}),
          ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
          cwd: entry.cwd ?? '',
          activity: entry.activity,
          busy,
          runtimeState: route?.state ?? 'cold',
          ...(entry.hidden === true ? { hidden: true } : {}),
          ...(entry.agentCreated === true ? { agentCreated: true } : {}),
          ...(entry.runningTools !== undefined && entry.runningTools > 0
            ? { runningTools: entry.runningTools } : {}),
          ...(entry.runningSubagents !== undefined && entry.runningSubagents > 0
            ? { runningSubagents: entry.runningSubagents } : {}),
          ...(entry.requestStartedAt !== undefined ? {
            requestStartedAt: entry.requestStartedAt,
            elapsedMs: Math.max(0, now - entry.requestStartedAt),
          } : {}),
          ...((entry.usage?.workingTimeMs !== undefined
            || entry.usage?.costUsd !== undefined
            || entry.usage?.unpricedInvocations !== undefined
            || entry.usage?.incompleteInvocations !== undefined
            || entry.usage?.freshness !== undefined)
            ? {
              workingTime: {
                ...(entry.usage.workingTimeMs !== undefined
                  ? { workingTimeMs: entry.usage.workingTimeMs } : {}),
                ...(entry.usage.costUsd !== undefined ? { costUsd: entry.usage.costUsd } : {}),
                ...(entry.usage.costProvenance !== undefined
                  ? { costProvenance: entry.usage.costProvenance } : {}),
                ...(entry.usage.unpricedInvocations !== undefined
                  ? { unpricedInvocations: entry.usage.unpricedInvocations } : {}),
                ...(entry.usage.incompleteInvocations !== undefined
                  ? { incompleteInvocations: entry.usage.incompleteInvocations } : {}),
                ...(entry.usage.freshness !== undefined ? { freshness: entry.usage.freshness } : {}),
              },
            } : {}),
          ...(entry.modelId ? { modelId: entry.modelId } : {}),
          ...(entry.provider ? { provider: entry.provider } : {}),
          ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
        } satisfies WorkerJsonObject;
        return projected;
      });
      const allClosingEntries = [...this.hostMembershipClosing.values()];
      const closingRows = allClosingEntries.slice(0, AGENT_SESSION_CONTROL_MAX_LIST_ITEMS)
        .map((entry) => ({
          path: entry.path,
          operationId: entry.operationId,
          ...(entry.privacyMode === true ? { deleteRequested: true } : {}),
          ...(entry.source !== undefined ? { closedBy: entry.source } : {}),
        } satisfies WorkerJsonObject));
      const listEnvelope = (sessionRows: readonly WorkerJsonObject[], closingRows: readonly WorkerJsonObject[]) => {
        const sessionsTruncated = allEntries.length > sessionRows.length;
        const closingTruncated = allClosingEntries.length > closingRows.length;
        return {
          scope: 'current-extension-host',
          membershipHydrated: this.hostMembershipSeen,
          // This reports whether the unique assigned-title namespace has been
          // initialized. Per-session provisional title reads are admission
          // state, not namespace readiness; assigned titles remain addressable.
          titleNamespaceReady: this.liveSessionTitles.ready,
          sessions: sessionRows,
          ...(closingRows.length > 0 ? { closing: closingRows } : {}),
          totalCount: allEntries.length,
          sessionsTruncated,
          closingTotalCount: allClosingEntries.length,
          closingTruncated,
          truncated: sessionsTruncated || closingTruncated,
        };
      };
      while ((rows.length > 0 || closingRows.length > 0)
          && Buffer.byteLength(JSON.stringify(listEnvelope(rows, closingRows)), 'utf8')
            > AGENT_SESSION_CONTROL_MAX_RESULT_BYTES) {
        if (rows.length > 0) rows.pop();
        else closingRows.pop();
      }
      return workerJson(listEnvelope(rows, closingRows));
    };
    const liveEntries = [...this.hostMembershipSessions.sessions.values()].map(({ entry }) => entry);
    const assignedGapRecords = new Map(this.liveSessionTitles.list()
      .filter((record) => record.state === 'assigned')
      .map((record) => [this.coldManagerKey(record.sessionPath), record]));
    for (const key of this.newCreatePublicationPaths) {
      if (this.hostMembershipSessions.sessions.has(key) || this.hostMembershipClosing.has(key)) continue;
      const retained = this.coldSessionManagerHandles.get(key);
      const assignment = assignedGapRecords.get(key);
      if (!assignment) continue;
      liveEntries.push({
        path: assignment.sessionPath,
        name: assignment.title,
        cwd: retained?.handle.manager.getCwd?.() ?? '',
        activity: 'idle',
      });
    }
    return projection(liveEntries);
  }

  /** Resolve an explicitly addressed session against the host live membership.
   *  Live sessions are admitted targets; closing sessions are reservations and
   *  remain fenced; anything the host has already closed (or never published)
   *  is not addressable. While indexing catches up for a just-created session,
   *  the coordinator's emitted-create marker and retained handle supply its
   *  identity; retained historical managers are never admitted. */
  /** Resolve one explicitly targeted session-control request against the
   *  assigned-title authority and the host live membership. Existing-session
   *  actions require exactly one target: an assigned `title` (resolved
   *  exactly after trimming) or an explicit `self` selector (the caller's own
   *  session, valid even while the caller is unnamed). There is no implicit
   *  current-session or path default: an omitted or conflicting target is an
   *  error, and an assigned title is never authority over retained closed
   *  history. While the namespace is not ready, title targeting fails closed. */
  private resolveSessionControlTarget(
    action: 'read' | 'message' | 'settings.get' | 'settings.set' | 'close',
    payload: Record<string, unknown>,
    sourceSessionPath: string,
  ): { status: 'live' | 'closing'; sessionPath: string; entry?: LiveSessionMembershipEntry } {
    const rawTitle = payload['title'];
    const hasSelf = payload['self'] === true;
    const hasTitle = typeof rawTitle === 'string' && rawTitle.trim().length > 0;
    if (hasTitle && hasSelf) {
      throw new BackendError('INVALID_PARAMS', 'Targeting accepts exactly one of title or self.');
    }
    if (hasSelf) return this.resolveLiveSessionPath(sourceSessionPath, sourceSessionPath, action);
    if (hasTitle) {
      if (!boundedAgentString(rawTitle, 512)) {
        throw new BackendError('INVALID_PARAMS', 'title must be a bounded string.');
      }
      const resolved = this.liveSessionTitles.resolve(rawTitle);
      if (!resolved) {
        throw new BackendError(
          'SESSION_NOT_FOUND',
          'No live session carries that assigned title; provisional labels never resolve as titles.',
        );
      }
      return this.resolveLiveSessionPath(resolved.sessionPath, sourceSessionPath, action);
    }
    throw new BackendError(
      'INVALID_PARAMS',
      `${action} requires an explicit target: an assigned title or the self selector.`,
    );
  }

  /** Resolve a reply address by stable identity, then re-check current host
   * membership. The reference is never a title or an addressable session path. */
  private resolveSessionControlReplyTarget(
    payload: Record<string, unknown>,
    sourceSessionPath: string,
  ): { status: 'live'; sessionPath: string; entry?: LiveSessionMembershipEntry } {
    if (payload.title !== undefined || payload.self !== undefined) {
      throw new BackendError('INVALID_PARAMS', 'message.replyTo cannot be combined with title or self.');
    }
    const identity = parseSessionReplyReference(payload.replyTo);
    if (!identity) throw new BackendError('INVALID_PARAMS', 'message.replyTo is not a valid bounded session reply reference.');

    const candidates = new Map<string, LiveSessionMembershipEntry>();
    if (this.hostMembershipSeen) {
      for (const { entry } of this.hostMembershipSessions.sessions.values()) {
        const key = backendSessionPathKey(entry.path);
        if (this.hostMembershipClosing.has(key) || this.pendingLiveTitlePaths.has(key)) continue;
        candidates.set(key, entry);
      }
    } else {
      // Before the first host snapshot only the calling worker itself is
      // authoritative; other identities cannot be guessed from catalog state.
      const sourceIdentity = resolveSessionIdentity(sourceSessionPath);
      if (sourceIdentity.sessionId === identity.sessionId
        && sourceIdentity.identityFallback === identity.identityFallback) {
        return { status: 'live', sessionPath: sourceSessionPath };
      }
    }
    for (const entry of candidates.values()) {
      const candidateIdentity = resolveSessionIdentity(entry.path);
      if (candidateIdentity.sessionId === identity.sessionId
        && candidateIdentity.identityFallback === identity.identityFallback) {
        return { status: 'live', sessionPath: entry.path, entry };
      }
    }
    throw new BackendError('SESSION_NOT_FOUND', 'The reply reference does not resolve to a live session.');
  }

  private resolveLiveSessionPath(
    sessionPath: string,
    _fallbackSourcePath: string,
    action: 'read' | 'message' | 'settings.get' | 'settings.set' | 'close',
  ): { status: 'live' | 'closing'; sessionPath: string; entry?: LiveSessionMembershipEntry } {
    if (!boundedAgentString(sessionPath, 16 * 1024)) {
      throw new BackendError('INVALID_PARAMS', 'sessionPath must be a bounded string.');
    }
    const key = backendSessionPathKey(sessionPath);
    if (!this.hostMembershipSeen) {
      return { status: 'live', sessionPath };
    }
    const live = this.hostMembershipSessions.sessions.get(key);
    if (live) {
      if (this.pendingLiveTitlePaths.has(key) && action !== 'close') {
        throw new BackendError('LIVE_TITLE_NAMESPACE_UNAVAILABLE', 'This live session title is still being assigned.');
      }
      return { status: 'live', sessionPath: live.entry.path, entry: live.entry };
    }
    const closing = this.hostMembershipClosing.get(key);
    if (closing && action === 'close') {
      // The host-owned close operation already owns this path; a tool close
      // either joins a coordinator-owned request (requestHostSessionClose) or
      // reports the reservation without starting a second lifecycle.
      return { status: 'closing', sessionPath: closing.path };
    }
    if (closing) {
      throw new BackendError(
        'SESSION_CLOSING',
        'The target session is closing; new requests cannot be admitted for it.',
      );
    }
    // Publication gap for a newly created session: the durable manager handle
    // is already authoritative while the host snapshot for its new tab is in
    // flight. This never applies to retained/revivable history.
    const retainedCold = this.coldSessionManagerHandles.get(key);
    if (this.newCreatePublicationPaths.has(key) && this.liveSessionTitles.assigned(sessionPath)
      && (retainedCold?.creationReason === 'new' || this.workerRuntimeRouter?.hasHotOwner(sessionPath))) {
      if (this.closingSessionRequests.has(key)) {
        if (action === 'close') return { status: 'closing', sessionPath };
        throw new BackendError('SESSION_CLOSING', 'The target session is closing.');
      }
      return { status: 'live', sessionPath: retainedCold?.handle.sessionPath ?? sessionPath };
    }
    throw new BackendError(
      'SESSION_NOT_FOUND',
      'The target session is not a live session of the current extension host; closed history is not addressable.',
    );
  }

  private async setSessionLifecyclePrivacy(sessionPath: string, enabled: boolean): Promise<void> {
    const { store, barrier } = this.initializeFilesystemLifecycle();
    const { sessionId } = resolveSessionIdentity(sessionPath);
    const canonicalPath = await this.canonicalSessionArtifactPath(sessionPath);
    await barrier.runAdministrativeAsync(sessionId, 'coordinator-privacy', async () => {
      const nowMs = Date.now();
      this.registerLifecycleArtifacts(store, sessionId, sessionPath, nowMs, canonicalPath);
      store.setPrivacyMode(sessionId, enabled ? 'on' : 'off', nowMs);
    });
  }

  private async closeSessionLifecycle(
    sessionPath: string,
    operationId: string,
    privacyMode: boolean,
  ): Promise<{ rootSessionId: string; pendingCreateOperationId?: string }> {
    const { store, barrier } = this.initializeFilesystemLifecycle();
    const { sessionId } = resolveSessionIdentity(sessionPath);
    const canonicalPath = await this.canonicalSessionArtifactPath(sessionPath);
    await barrier.runAdministrativeAsync(sessionId, 'coordinator-close', async () => {
      const nowMs = Date.now();
      const existing = store.get(sessionId);
      this.registerLifecycleArtifacts(store, sessionId, sessionPath, nowMs, canonicalPath);
      if (!existing) store.setPrivacyMode(sessionId, privacyMode ? 'on' : 'off', nowMs);
      else if ((existing.privacyMode === 'on') !== privacyMode) {
        throw new BackendError('SESSION_OWNERSHIP_CONFLICT', 'Close privacy setting is stale; retry from authoritative state.');
      }
      store.resolveClose(sessionId, operationId, nowMs, privacyMode ? 'private_close' : 'user_close');
    });
    this.lifecycleScheduler?.notifyDeadlineChanged();
    const persistedPendingCreateOperationId = store.get(sessionId)?.pendingCreateOperationId;
    return persistedPendingCreateOperationId
      ? { rootSessionId: sessionId, pendingCreateOperationId: persistedPendingCreateOperationId }
      : { rootSessionId: sessionId };
  }

  /** Retire a private session runtime and remove every durable session-side
   *  artifact. Called only after the host has chosen privacy mode; ordinary
   *  tab closes intentionally keep sessions reopenable. */
  private async forgetSession(sessionPath: string, operationId?: string): Promise<void> {
    await this.withAnalyticsWriterAdmission(async () => {
      // Close coordinator-side admission before waiting for a worker lifecycle
      // barrier. The router holds its own tombstone across manifest cleanup, so
      // no promotion or transition can create a later output manifest.
      this.forgottenSessionPaths.add(sessionPath);
      try {
        const forget = async () => await this.forgetSessionAdmitted(sessionPath, operationId);
        const router = this.workerRuntimeRouter;
        if (router) await router.withSessionForgetBarrier(sessionPath, forget);
        else await forget();
      } catch (error) {
        this.forgottenSessionPaths.delete(sessionPath);
        throw error;
      }
    });
  }

  private async forgetSessionAdmitted(sessionPath: string, operationId?: string): Promise<void> {
    // The isolated worker has already been retired by the request router.
    // Validate and retry only its durable exact-path manifests before any
    // transcript/session artifact deletion can commit.
    await cleanupSessionTempOutputManifests(resolveSessionIdentity(sessionPath).sessionId);
    let lifecycle: { store: SessionLifecycleStore; sessionId: string; cleanupOperationId: string } | undefined;
    if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] === STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
      const requestedOperationId = operationId?.trim() || `private-close:${resolveSessionIdentity(sessionPath).sessionId}`;
      await this.closeSessionLifecycle(sessionPath, requestedOperationId, true);
      const store = this.initializeFilesystemLifecycle().store;
      const sessionId = resolveSessionIdentity(sessionPath).sessionId;
      const cleanupOperationId = store.get(sessionId)?.cleanupOperationId ?? requestedOperationId;
      store.claimCleanup(sessionId, cleanupOperationId, Date.now());
      for (const artifact of store.listArtifacts(sessionId)) {
        if (artifact.state !== 'deleted') {
          store.markArtifactDeleting(sessionId, artifact.artifactId, cleanupOperationId, Date.now());
        }
      }
      lifecycle = { store, sessionId, cleanupOperationId };
    }
    this.forgottenSessionPaths.add(sessionPath);
    this.browsePreviousSessionFiles.delete(sessionPath);
    // A session-scoped MCP override artifact must not outlive its session.
    try {
      if (lifecycle) await fs.rm(sessionMcpOverridePath(sessionPath), { force: true });
      else await fs.rm(sessionMcpOverridePath(sessionPath), { force: true }).catch(() => undefined);
    } catch (error) {
      this.forgottenSessionPaths.delete(sessionPath);
      lifecycle?.store.markCleanupBlocked(
        lifecycle.sessionId, lifecycle.cleanupOperationId, toErrorMessage(error), Date.now(),
      );
      throw error;
    }
    const store = this.initializeColdSessionStore();
    try {
      // Registered managed trees are fallible and must be removed before
      // ColdSessionStore.forget commits transcript deletion as the final
      // filesystem boundary. A retry can therefore still recover the stable
      // transcript identity after any earlier artifact failure.
      for (const artifact of lifecycle?.store.listArtifacts(lifecycle.sessionId) ?? []) {
        if (artifact.kind !== 'managed_cache' || artifact.locationKind !== 'fixed_absolute') continue;
        if (!fsSync.existsSync(artifact.location)) continue;
        verifyFilesystemArtifactIdentity(artifact, artifact.location);
        fsSync.rmSync(artifact.location, { recursive: true, force: false });
      }
      if (!lifecycle) {
        const sessionId = resolveSessionIdentity(sessionPath).sessionId;
        const canonicalPath = await this.canonicalSessionArtifactPath(sessionPath);
        const managed = this.managedSessionArtifactDirectories(canonicalPath);
        await this.assertComputerArtifactDirectoryIsSessionScoped(canonicalPath, managed.baseName);
        for (const { artifactId, path: artifactPath } of managed.directories) {
          if (!fsSync.existsSync(artifactPath)) continue;
          if (!fsSync.lstatSync(artifactPath).isDirectory()) {
            throw new Error(`Private session artifact is not a directory: ${artifactId}`);
          }
          const artifact: LifecycleArtifactRecord = {
            sessionId,
            artifactId,
            kind: 'managed_cache',
            locationKind: 'fixed_absolute',
            location: artifactPath,
            identityJson: filesystemArtifactIdentity(artifactPath),
            state: 'present',
            updatedAtMs: String(Date.now()),
          };
          verifyFilesystemArtifactIdentity(artifact, artifactPath);
          fsSync.rmSync(artifactPath, { recursive: true, force: false });
        }
      }
      await this.runColdSessionMutation(sessionPath, async () => {
        store.leases.invalidate(sessionPath);
        this.coldSessionManagerHandles.delete(this.coldManagerKey(sessionPath));
        await store.forget(sessionPath);
      }, true);
      if (this.viewedSessionPath === sessionPath) this.setViewedSessionPath(undefined);
    } catch (error) {
      this.forgottenSessionPaths.delete(sessionPath);
      if (lifecycle) lifecycle.store.markCleanupBlocked(
        lifecycle.sessionId, lifecycle.cleanupOperationId, toErrorMessage(error), Date.now(),
      );
      throw error;
    }
    if (lifecycle) {
      for (const artifact of lifecycle.store.listArtifacts(lifecycle.sessionId)) {
        if (artifact.state !== 'deleted') {
          lifecycle.store.markArtifactResult(
            lifecycle.sessionId, artifact.artifactId, lifecycle.cleanupOperationId, 'deleted', Date.now(),
          );
        }
      }
      lifecycle.store.markDeleted(lifecycle.sessionId, Date.now(), lifecycle.cleanupOperationId);
    }
    // Keep the successful tombstone for the life of this backend process so a
    // queued session.open cannot recreate the deleted file after this RPC.
  }

  private async handleMessageEdit(
    router: WorkerRuntimeRouter,
    request: RequestEnvelope,
    params: MessageEditParams,
  ): Promise<SendOperationAcceptance & { operationAttempt: number; committed: true }> {
    const existingStatus = this.editOperationLedger.status(params.operationId);
    if (!existingStatus && router.hasMessageOperationOwner(params.operationId)) {
      throw new BackendError(
        'OPERATION_INTENT_MISMATCH',
        `Operation ${params.operationId} was already used for a different message mutation intent.`,
      );
    }
    const previousSession = this.editOperationSessions.get(params.operationId);
    if (previousSession === undefined) this.editOperationSessions.set(params.operationId, params.sessionPath);

    const result = await this.editOperationLedger.run(
      params.operationId,
      canonicalEditIntentFingerprint(params),
      async () => await this.executeMessageEdit(router, request, params),
    );
    return { ...result, operationAttempt: params.operationAttempt, committed: true };
  }

  private async executeMessageEdit(
    router: WorkerRuntimeRouter,
    request: RequestEnvelope,
    params: MessageEditParams,
  ): Promise<SendOperationAcceptance> {
    const cancellationGeneration = router.operationCancellationGeneration(params.sessionPath);
    const assertNotCancelled = () => {
      if (router.operationCancellationGeneration(params.sessionPath) !== cancellationGeneration) {
        throw new BackendError('SESSION_OPERATION_CANCELLED', 'The edit was interrupted before its compound transition committed.');
      }
    };
    let route = router.getRoute(params.sessionPath);
    if (route.state === 'promoting') {
      await route.promotion;
      route = router.getRoute(params.sessionPath);
    } else if (route.state === 'retiring') {
      await route.retirement;
      route = router.getRoute(params.sessionPath);
    }
    if (route.state === 'transitioning') {
      throw new BackendError('SESSION_TRANSITION_IN_PROGRESS', `Session transition is already in progress for ${params.sessionPath}.`);
    }

    const truncate = async () => {
      const store = this.initializeColdSessionStore();
      return await this.runColdSessionMutation(params.sessionPath, async () => {
        store.leases.invalidate(params.sessionPath);
        this.coldSessionManagerHandles.delete(this.coldManagerKey(params.sessionPath));
        const truncated = await store.truncateAfter(params.sessionPath, params.entryId, {
          requireCurrentBranchTarget: true,
          onCommit: () => this.editOperationLedger.markCommitted(params.operationId),
        });
        this.retainColdSessionManager(truncated, 'resume');
        return truncated;
      });
    };
    const replacementRequest: RequestEnvelope = {
      ...request,
      id: `${request.id}:replacement`,
      method: 'message.send',
      params: {
        sessionPath: params.sessionPath,
        text: params.text,
        inputs: params.inputs,
        ...(params.localId !== undefined ? { localId: params.localId } : {}),
        operationId: params.operationId,
        operationAttempt: params.operationAttempt,
      },
    };

    // Promote a cold source before installing the compound transition. This
    // makes cold and hot edits share the same backend serialization fence;
    // priority Stop can cancel promotion before any destructive commit.
    if (!router.hasHotOwner(params.sessionPath)) await router.promote(params.sessionPath);
    assertNotCancelled();
    const result: WorkerJsonValue = await router.runHotTransition(
      params.sessionPath,
      `message-edit:${params.operationId}`,
      async (transition) => {
        await transition.interrupt(`message edit ${request.id}`);
        await transition.retire('message edit source quiesced');
        const truncated = await truncate();
        transition.assertActive();
        await transition.promote(truncated.sessionPath);
        transition.assertActive();
        return await transition.routePromoted(replacementRequest);
      },
    );
    void this.emitSessionListChanged();

    const response = result && typeof result === 'object' && !Array.isArray(result)
      ? result as WorkerJsonObject
      : {};
    return {
      operationId: params.operationId,
      ...(typeof response.requestId === 'string' ? { requestId: response.requestId } : {}),
      ...(response.queued === true ? { queued: true } : {}),
    };
  }

  private editOperationStatus(sessionPath: string, operationId: string): ReturnType<SendOperationLedger['status']> {
    const owner = this.editOperationSessions.get(operationId);
    if (owner === undefined) return undefined;
    if (this.coldManagerKey(owner) !== this.coldManagerKey(sessionPath)) {
      throw new BackendError('OPERATION_INTENT_MISMATCH', `Operation ${operationId} belongs to a different edit session.`);
    }
    return this.editOperationLedger.status(operationId);
  }

  private async reconcileAcceptedEditStatus(
    router: WorkerRuntimeRouter,
    request: RequestEnvelope,
    sessionPath: string,
    operationId: string,
  ): Promise<void> {
    const status = this.editOperationLedger.status(operationId);
    if (status?.state !== 'accepted' || !status.committed) return;
    if (!router.hasHotOwner(sessionPath)) {
      if (router.hasMessageOperationOwner(operationId)) {
        this.editOperationLedger.markFailedAfterCommit(
          operationId,
          'SESSION_GENERATION_ENDED',
          'The worker generation that owned the replacement send is no longer available.',
        );
      }
      return;
    }
    try {
      const downstream = await router.routeExisting({
        ...request,
        id: `${request.id}:edit-send-status`,
        method: 'operation.status',
        params: { sessionPath, operationId, backendGeneration: this.backendGeneration },
      });
      if (downstream && typeof downstream === 'object' && !Array.isArray(downstream)
        && downstream.state === 'failed') {
        this.editOperationLedger.markFailedAfterCommit(
          operationId,
          typeof downstream.code === 'string' ? downstream.code : 'MESSAGE_OPERATION_REJECTED',
          typeof downstream.message === 'string' ? downstream.message : 'The replacement send failed after edit commit.',
        );
      }
    } catch (error) {
      if (error instanceof BackendError && error.code === 'SESSION_GENERATION_ENDED') {
        this.editOperationLedger.markFailedAfterCommit(operationId, error.code, error.message);
      } else {
        throw error;
      }
    }
  }

  private interruptOperationStatus(sessionPath: string, operationId: string) {
    const owner = this.interruptOperationSessions.get(operationId);
    if (owner === undefined) return undefined;
    if (this.coldManagerKey(owner) !== this.coldManagerKey(sessionPath)) {
      throw new BackendError('OPERATION_INTENT_MISMATCH', `Operation ${operationId} belongs to a different interrupt session.`);
    }
    return this.interruptOperationLedger.status(operationId);
  }

  private async executeCoordinatorInterrupt(
    router: WorkerRuntimeRouter,
    requestId: string,
    sessionPath: string,
  ): Promise<InterruptOperationResult> {
    let routeState = router.getRoute(sessionPath);
    if (routeState.state === 'promoting' && router.cancelPendingRuntimeOperations(sessionPath)) {
      return { interrupted: true, settled: true };
    }
    if (routeState.state === 'retiring') {
      router.cancelPendingRuntimeOperations(sessionPath);
      await routeState.retirement;
      return { interrupted: false, alreadyStopped: true, settled: true };
    }
    if (routeState.state === 'transitioning') {
      router.cancelPendingRuntimeOperations(sessionPath);
      const transitionOutcome = await waitForSessionTransition({
        resolveCurrent: async () => {
          const current = router.getRoute(sessionPath);
          if (current.state === 'transitioning') await current.completion.catch(() => undefined);
          return router.getRoute(sessionPath);
        },
        isPending: () => router.getRoute(sessionPath).state === 'transitioning',
        timeoutMs: INTERRUPT_TRANSITION_WAIT_MS,
      });
      if (transitionOutcome.status === 'timed-out') {
        const recovered = await router.forceRecoverTransition(
          sessionPath,
          `interrupt ${requestId} transition settlement timeout`,
        );
        if (!recovered) routeState = router.getRoute(sessionPath);
        else {
          return {
            interrupted: true,
            settled: true,
            forcedRecovery: true,
            teardownTimedOut: true,
          };
        }
      } else {
        routeState = transitionOutcome.value;
      }
    }
    if (router.hasHotOwner(sessionPath)) {
      const result = await router.interrupt(sessionPath, `public request ${requestId}`);
      return result.soft
        ? { interrupted: true, settled: true }
        : {
            interrupted: true,
            settled: true,
            forcedRecovery: true,
            teardownTimedOut: true,
          };
    }
    return { interrupted: false, alreadyStopped: true, settled: true };
  }

  private validateAgentSessionSettingsPatch(raw: unknown): AgentSessionSettingsPatch {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BackendError('INVALID_PARAMS', 'settings must be an object.');
    }
    const value = raw as Record<string, unknown>;
    const supported = new Set([
      'model', 'reasoning', 'autonomousMode', 'subagentProviderChoices', 'disabledSystemPromptEntries',
    ]);
    const unexpected = Object.keys(value).find((key) => !supported.has(key));
    if (unexpected) throw new BackendError('INVALID_PARAMS', `Unsupported settings field: ${unexpected}.`);
    const patch: AgentSessionSettingsPatch = {};

    if (value.model !== undefined) {
      if (!value.model || typeof value.model !== 'object' || Array.isArray(value.model)) {
        throw new BackendError('INVALID_PARAMS', 'settings.model must contain provider and id.');
      }
      const model = value.model as Record<string, unknown>;
      if (Object.keys(model).some((key) => key !== 'provider' && key !== 'id')
        || !boundedAgentString(model.provider, 256)
        || !boundedAgentString(model.id, 512)) {
        throw new BackendError('INVALID_PARAMS', 'settings.model requires bounded non-empty provider and id strings.');
      }
      patch.model = { provider: model.provider.trim(), id: model.id.trim() };
    }
    if (value.reasoning !== undefined) {
      if (!isThinkingLevel(value.reasoning)) {
        throw new BackendError('INVALID_PARAMS', 'settings.reasoning must be a supported reasoning level.');
      }
      patch.reasoning = value.reasoning;
    }
    if (value.autonomousMode !== undefined) {
      if (typeof value.autonomousMode !== 'boolean') {
        throw new BackendError('INVALID_PARAMS', 'settings.autonomousMode must be a boolean.');
      }
      patch.autonomousMode = value.autonomousMode;
    }
    if (value.subagentProviderChoices !== undefined) {
      try {
        const validated = validateSessionControlSettingsRequest({
          requestId: 'settings-patch-validation',
          sessionPath: 'settings-patch-validation',
          action: 'apply',
          settings: { subagentProviderChoices: value.subagentProviderChoices },
        });
        patch.subagentProviderChoices = validated.settings?.subagentProviderChoices;
      } catch (error) {
        throw new BackendError('INVALID_PARAMS', toErrorMessage(error));
      }
    }
    if (value.disabledSystemPromptEntries !== undefined) {
      if (!Array.isArray(value.disabledSystemPromptEntries)
        || value.disabledSystemPromptEntries.length > AGENT_SESSION_SETTINGS_MAX_DISABLED_PROMPTS
        || value.disabledSystemPromptEntries.some((entry) => !boundedAgentString(entry, 512))) {
        throw new BackendError(
          'INVALID_PARAMS',
          `settings.disabledSystemPromptEntries must contain at most ${AGENT_SESSION_SETTINGS_MAX_DISABLED_PROMPTS} bounded non-empty entry ids.`,
        );
      }
      patch.disabledSystemPromptEntries = [...new Set(value.disabledSystemPromptEntries as string[])];
    }
    try {
      if (patch.model || patch.reasoning !== undefined) {
        validateSettingsSet({
          sessionPath: 'settings-patch-validation',
          persistenceScope: 'session',
          ...(patch.model ? { defaultModel: patch.model.id, defaultProvider: patch.model.provider } : {}),
          ...(patch.reasoning !== undefined ? { defaultThinkingLevel: patch.reasoning } : {}),
        });
      }
      if (patch.disabledSystemPromptEntries !== undefined) {
        validateSystemPromptTogglesSet({
          sessionPath: 'settings-patch-validation',
          disabledEntries: patch.disabledSystemPromptEntries,
        });
      }
      const executionPatch: SessionControlExecutionSettingsPatch = {
        ...(patch.autonomousMode !== undefined ? { autonomousMode: patch.autonomousMode } : {}),
        ...(patch.subagentProviderChoices !== undefined
          ? { subagentProviderChoices: patch.subagentProviderChoices }
          : {}),
      };
      if (Object.keys(executionPatch).length > 0) {
        validateSessionControlSettingsRequest({
          requestId: 'settings-patch-validation',
          sessionPath: 'settings-patch-validation',
          action: 'apply',
          settings: executionPatch,
        });
      }
    } catch (error) {
      throw new BackendError('INVALID_PARAMS', toErrorMessage(error));
    }
    return patch;
  }

  private async assertSessionControlModelAvailable(model: AgentSessionModelChoice): Promise<void> {
    const catalog = await loadConfiguredModels(this.agentDir, this.modelRegistry);
    if (!catalog.ok) {
      throw new BackendError('MODEL_CATALOG_UNAVAILABLE', `Unable to validate session model: ${catalog.error}`);
    }
    if (!catalog.models.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      throw new BackendError('MODEL_UNAVAILABLE', `Model not available for this session: ${model.provider}/${model.id}`);
    }
  }

  private async captureSessionControlSettings(sessionPath: string): Promise<{
    settings: AgentSessionSettingsSnapshot;
    cwd: string;
  }> {
    // A hot opened payload projects the applied worker state. Inheritance
    // instead reads the durable transcript under the cold-store hot-read lease
    // and a fresh saved-default snapshot.
    const modelSettings = await this.readModelSettings();
    const durable = await this.initializeColdSessionStore().readDurableSessionMetadata(sessionPath, modelSettings);
    const modelId = durable.modelId ?? modelSettings.defaultModel;
    const provider = durable.provider ?? modelSettings.defaultProvider;
    const reasoning = durable.thinkingLevel ?? modelSettings.defaultThinkingLevel;
    if (!modelId || !provider || !isThinkingLevel(reasoning)) {
      throw new BackendError(
        'SESSION_SETTINGS_UNAVAILABLE',
        'The source session has no complete durable model/reasoning configuration to inherit.',
      );
    }

    const hostAcknowledgement = await this.requestHostSessionControlSettings(sessionPath, 'capture');
    if (!hostAcknowledgement) {
      throw new BackendError('SESSION_SETTINGS_UNKNOWN', 'The host execution-settings capture acknowledgement was not received.');
    }
    if (hostAcknowledgement.outcome !== 'succeeded' || !hostAcknowledgement.settings) {
      throw new BackendError(
        hostAcknowledgement.outcome === 'unknown' ? 'SESSION_SETTINGS_UNKNOWN' : 'SESSION_SETTINGS_CAPTURE_FAILED',
        hostAcknowledgement.error ?? 'The host could not capture saved execution settings.',
      );
    }
    const disabledSystemPromptEntries = await readSystemPromptTogglesForSession(sessionPath);
    return {
      settings: {
        model: { provider, id: modelId },
        reasoning,
        autonomousMode: hostAcknowledgement.settings.autonomousMode,
        subagentProviderChoices: { ...hostAcknowledgement.settings.subagentProviderChoices },
        disabledSystemPromptEntries: [...new Set(disabledSystemPromptEntries)],
      },
      cwd: durable.cwd,
    };
  }

  private async captureSessionControlProviderSurface(sessionPath: string): Promise<Record<string, boolean>> {
    const acknowledgement = await this.requestHostSessionControlSettings(sessionPath, 'capture');
    if (acknowledgement?.outcome !== 'succeeded' || !acknowledgement.settings) {
      throw new BackendError('SESSION_SETTINGS_UNKNOWN',
        acknowledgement?.error ?? 'The configured provider surface could not be confirmed.');
    }
    return acknowledgement.settings.subagentProviderChoices;
  }

  private static assertConfiguredProviderChoices(
    choices: Record<string, boolean> | undefined,
    surface: Record<string, boolean>,
  ): void {
    if (!choices) return;
    for (const provider of Object.keys(choices)) {
      if (!provider.trim() || !Object.hasOwn(surface, provider)) {
        throw new BackendError('INVALID_PARAMS', `Provider is not in the configured subagent surface: ${provider}`);
      }
    }
  }

  private async configureSessionControlSettings(
    sessionPath: string,
    patch: AgentSessionSettingsPatch,
    requestId: string,
  ): Promise<WorkerJsonObject> {
    const applied: string[] = [];
    const fail = (setting: string, error: unknown, outcome: 'failed' | 'unknown' = 'failed'): WorkerJsonObject => ({
      status: outcome,
      applied,
      failedSetting: setting,
      error: toErrorMessage(error).slice(0, HOST_SESSION_SETTINGS_ERROR_MAX_CHARS),
    });

    if (patch.model || patch.reasoning !== undefined) {
      try {
        const settingsParams = validateSettingsSet({
          sessionPath,
          persistenceScope: 'session',
          ...(patch.model ? { defaultModel: patch.model.id, defaultProvider: patch.model.provider } : {}),
          ...(patch.reasoning !== undefined ? { defaultThinkingLevel: patch.reasoning } : {}),
        });
        const settingsResult = await this.handleRequest({
          id: `${requestId}:model-settings`,
          method: 'settings.set',
          params: settingsParams as unknown as Record<string, unknown>,
        }) as { defaultThinkingLevel?: unknown };
        if (patch.reasoning !== undefined && !isThinkingLevel(settingsResult?.defaultThinkingLevel)) {
          return fail('reasoning', new Error('The effective reasoning level was not confirmed.'), 'unknown');
        }
        if (patch.model) applied.push('model');
        if (patch.reasoning !== undefined) {
          applied.push('reasoning');
          patch = { ...patch, reasoning: settingsResult.defaultThinkingLevel as AgentSessionSettingsPatch['reasoning'] };
        }
      } catch (error) {
        const code = error instanceof BackendError ? error.code : '';
        return fail(patch.model ? 'model' : 'reasoning', error,
          error instanceof WorkerRequestTimeoutError || /TIMEOUT|GENERATION_ENDED|UNKNOWN/u.test(code) ? 'unknown' : 'failed');
      }
    }

    if (patch.disabledSystemPromptEntries !== undefined) {
      try {
        const promptParams = validateSystemPromptTogglesSet({
          sessionPath,
          disabledEntries: patch.disabledSystemPromptEntries,
        });
        await this.handleRequest({
          id: `${requestId}:system-prompts`,
          method: 'systemPromptToggles.set',
          params: promptParams as unknown as Record<string, unknown>,
        });
        applied.push('disabledSystemPromptEntries');
      } catch (error) {
        const code = error instanceof BackendError ? error.code : '';
        return fail('disabledSystemPromptEntries', error,
          error instanceof WorkerRequestTimeoutError || /TIMEOUT|GENERATION_ENDED|UNKNOWN/u.test(code) ? 'unknown' : 'failed');
      }
    }

    const hostSettings: SessionControlExecutionSettingsPatch = {
      ...(patch.autonomousMode !== undefined ? { autonomousMode: patch.autonomousMode } : {}),
      ...(patch.subagentProviderChoices !== undefined
        ? { subagentProviderChoices: patch.subagentProviderChoices }
        : {}),
    };
    if (Object.keys(hostSettings).length > 0) {
      let acknowledgement: SessionControlSettingsAcknowledgement | undefined;
      try {
        acknowledgement = await this.requestHostSessionControlSettings(sessionPath, 'apply', hostSettings);
      } catch (error) {
        return fail('hostExecutionSettings', error, 'unknown');
      }
      if (!acknowledgement) {
        return fail('hostExecutionSettings', new Error('The host settings acknowledgement was not received.'), 'unknown');
      }
      if (acknowledgement.outcome !== 'succeeded') {
        return fail(
          'hostExecutionSettings',
          new Error(acknowledgement.error ?? 'The host did not confirm execution-settings persistence.'),
          acknowledgement.outcome === 'unknown' ? 'unknown' : 'failed',
        );
      }
      applied.push('hostExecutionSettings');
      if (acknowledgement.application === 'unknown') {
        return fail(
          'hostRuntimeApplication',
          new Error('Execution settings were persisted, but runtime application is unknown.'),
          'unknown',
        );
      }
      if (acknowledgement.application === 'pending') applied.push('hostApplicationPending');
    }
    return {
      status: 'succeeded',
      applied,
      ...(patch.model ? { model: { provider: patch.model.provider, id: patch.model.id } } : {}),
      ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
      ...(patch.autonomousMode !== undefined ? { autonomousMode: patch.autonomousMode } : {}),
      ...(patch.subagentProviderChoices !== undefined
        ? { subagentProviderChoices: patch.subagentProviderChoices }
        : {}),
      ...(patch.disabledSystemPromptEntries !== undefined
        ? { disabledSystemPromptEntries: patch.disabledSystemPromptEntries }
        : {}),
    };
  }

  private async sendSessionControlPrompt(
    frame: WorkerSessionControlFrame,
    sourceSessionPath: string,
    targetSessionPath: string,
    prompt: string,
    operationId: string,
    expectedCancellationGeneration?: number,
  ): Promise<WorkerJsonObject> {
    try {
      if (expectedCancellationGeneration !== undefined
        && this.workerRuntimeRouter?.operationCancellationGeneration?.(targetSessionPath)
          !== expectedCancellationGeneration) {
        throw new BackendError(
          'SESSION_OPERATION_CANCELLED',
          'The pending session-control send was invalidated by a close before admission.',
        );
      }
      this.assertSessionControlSendAdmissionOpen(targetSessionPath);
    } catch (error) {
      // Settings and creation are durable operations: a later close rejects
      // only delivery and never rolls either completed result back.
      return {
        status: 'rejected',
        error: toErrorMessage(error).slice(0, HOST_SESSION_SETTINGS_ERROR_MAX_CHARS),
      };
    }
    const sourceIdentity: SessionControlSenderIdentity = resolveSessionIdentity(sourceSessionPath);
    const sender: SessionControlSender = createSessionControlSender(
      sourceIdentity,
      this.liveSessionTitles.assigned(sourceSessionPath),
    );
    if (!isSessionControlSender(sender)) throw new BackendError('INVALID_PARAMS', 'Unable to authenticate the source session.');
    const localId = `${AGENT_SESSION_MESSAGE_LOCAL_ID_PREFIX}${frame.requestId}`;
    const agentMessage: AgentMessagePayload = {
      sessionPath: targetSessionPath,
      localId,
      text: prompt,
      sender,
      timestamp: Date.now(),
      status: 'queued',
    };
    this.emit('message.agent', agentMessage);
    try {
      const result = await this.handleRequest({
        id: `${frame.requestId}:message`,
        method: 'message.send',
        params: {
          sessionPath: targetSessionPath,
          text: prompt,
          inputs: [],
          operationId,
          operationAttempt: 1,
          localId,
          coordinatorAttribution: sender,
        },
      }, undefined, undefined, undefined, true, expectedCancellationGeneration);
      const queued = result !== null && typeof result === 'object' && !Array.isArray(result)
        && (result as { queued?: unknown }).queued === true;
      if (!queued) this.emit('message.agent', { ...agentMessage, status: 'completed' });
      return {
        status: 'accepted',
        ...(queued ? { queued: true } : {}),
        result: workerJson(result),
      };
    } catch (error) {
      const code = error instanceof BackendError ? error.code : '';
      const unknown = error instanceof WorkerRequestTimeoutError
        || /TIMEOUT|GENERATION_ENDED|UNKNOWN|PROVENANCE_UNAVAILABLE/u.test(code);
      if (!unknown) this.emit('message.agent', { ...agentMessage, status: 'rejected' });
      return {
        status: unknown ? 'unknown' : 'rejected',
        error: toErrorMessage(error).slice(0, HOST_SESSION_SETTINGS_ERROR_MAX_CHARS),
      };
    }
  }

  private async sessionControlSettingsResult(sessionPath: string): Promise<WorkerJsonObject> {
    const { settings } = await this.captureSessionControlSettings(sessionPath);
    return workerJson(settings) as WorkerJsonObject;
  }

  /** Durable agent-created create through the ordinary create operation; the
   *  required title is assigned inside that flow (reserve → owning-owner
   *  persistence → confirm) before the created session is published. */
  private async createAgentControlledSession(
    requestId: string,
    payload: Record<string, unknown>,
    resolvedCwd: string,
  ): Promise<WorkerSessionControlOutcome> {
    const result = await this.handleRequest({
      id: `${requestId}:create`,
      method: 'session.create',
      params: {
        cwd: resolvedCwd,
        title: payload['title'] as string,
        agentCreated: true,
        operationId: `agent-session:${requestId}`,
        operationAttempt: 1,
      },
    });
    return { result: workerJson(result) };
  }

  private async handleWorkerSessionControl(
    frame: WorkerSessionControlFrame,
    sourceSessionPath: string,
  ): Promise<WorkerSessionControlOutcome> {
    const payload = frame.payload as Record<string, unknown>;
    const allowedPayloadKeys: Readonly<Record<WorkerSessionControlAction, readonly string[]>> = {
      list: [],
      create: ['cwd', 'title', 'prompt', 'settings'],
      read: ['title', 'self', 'direction', 'cursor', 'limit'],
      message: ['title', 'self', 'replyTo', 'prompt', 'settings'],
      'settings.get': ['title', 'self'],
      'settings.set': ['title', 'self', 'settings'],
      close: ['title', 'self', 'delete'],
    };
    const unexpectedPayloadKey = Object.keys(payload).find((key) => !allowedPayloadKeys[frame.action].includes(key));
    if (unexpectedPayloadKey) {
      throw new BackendError('INVALID_PARAMS', `Unexpected session_control payload key: ${unexpectedPayloadKey}`);
    }
    const operationId = `agent-session:${frame.requestId}`;

    if (frame.action === 'list') return { result: this.listLiveSessions() };

    if (frame.action === 'create') {
      if (typeof payload.title !== 'string' || !boundedAgentString(payload.title, 512)) {
        throw new BackendError('INVALID_PARAMS', 'create requires a bounded title of 1-25 characters after trimming.');
      }
      let title: string;
      try {
        title = normalizeSessionControlBaseTitle(payload.title);
      } catch (error) {
        throw new BackendError('INVALID_PARAMS', toErrorMessage(error));
      }
      if (payload.prompt !== undefined
        && (!boundedAgentString(payload.prompt, AGENT_SESSION_CONTROL_MAX_MESSAGE_BYTES) || !payload.prompt.trim())) {
        throw new BackendError('INVALID_PARAMS', 'create.prompt must be non-empty and bounded when supplied.');
      }
      const explicitSettings = payload.settings === undefined
        ? {}
        : this.validateAgentSessionSettingsPatch(payload.settings);
      if (payload.cwd !== undefined
        && (!boundedAgentString(payload.cwd, 16 * 1024) || !payload.cwd.trim())) {
        throw new BackendError('INVALID_PARAMS', 'create.cwd must be a bounded non-empty path when supplied.');
      }
      if (!this.liveSessionTitles.ready) {
        throw new BackendError(
          'LIVE_TITLE_NAMESPACE_UNAVAILABLE',
          'The live session title namespace is not ready; creation fails closed until live membership hydration completes.',
        );
      }
      // Capture the creator's saved settings once, before the durable create.
      // Explicit settings override those captured values field-by-field.
      let captured: { settings: AgentSessionSettingsSnapshot; cwd: string };
      try {
        captured = await this.captureSessionControlSettings(sourceSessionPath);
      } catch (error) {
        // No durable-create call was admitted. Distinguish this known absence
        // from an unknown create acknowledgement so agents cannot assume a tab
        // exists or retry an uncertain creation based on a generic error.
        return { result: workerJson({
          creation: {
            status: 'not_created',
            error: toErrorMessage(error).slice(0, HOST_SESSION_SETTINGS_ERROR_MAX_CHARS),
          },
          configuration: { status: 'not_started' },
          message: { status: payload.prompt === undefined ? 'not_requested' : 'not_sent' },
        } satisfies WorkerJsonObject) };
      }
      const inheritedSettings = captured.settings;
      const settings = this.validateAgentSessionSettingsPatch({
        ...inheritedSettings,
        ...explicitSettings,
        model: explicitSettings.model ?? inheritedSettings.model,
        disabledSystemPromptEntries: explicitSettings.disabledSystemPromptEntries
          ?? inheritedSettings.disabledSystemPromptEntries,
      });
      if (!settings.model) {
        throw new BackendError('SESSION_SETTINGS_UNAVAILABLE', 'The complete inherited model settings are unavailable.');
      }
      await this.assertSessionControlModelAvailable(settings.model);
      BackendServer.assertConfiguredProviderChoices(settings.subagentProviderChoices, inheritedSettings.subagentProviderChoices);

      const explicitCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : undefined;
      const resolvedCwd = explicitCwd || captured.cwd;
      if (!resolvedCwd) {
        throw new BackendError('SESSION_CWD_UNAVAILABLE', 'The source session has no durable working directory.');
      }

      let rawCreated: unknown;
      try {
        const created = await this.createAgentControlledSession(
          frame.requestId,
          { ...payload, title },
          resolvedCwd,
        );
        rawCreated = created.result;
      } catch (error) {
        return { result: workerJson({
          creation: {
            status: error instanceof BackendError && /INVALID|TITLE/u.test(error.code) ? 'failed' : 'unknown',
            error: toErrorMessage(error).slice(0, HOST_SESSION_SETTINGS_ERROR_MAX_CHARS),
          },
          configuration: { status: 'not_started' },
          message: { status: payload.prompt === undefined ? 'not_requested' : 'not_sent' },
        } satisfies WorkerJsonObject) };
      }
      if (!rawCreated || typeof rawCreated !== 'object' || Array.isArray(rawCreated)
        || typeof (rawCreated as Record<string, unknown>).sessionPath !== 'string') {
        return { result: workerJson({
          creation: { status: 'unknown', error: 'The create acknowledgement did not include a session path.' },
          configuration: { status: 'not_started' },
          message: { status: payload.prompt === undefined ? 'not_requested' : 'not_sent' },
        } satisfies WorkerJsonObject) };
      }
      const createdRecord = rawCreated as Record<string, unknown>;
      const sessionPath = createdRecord.sessionPath as string;
      // A create target does not exist until the durable create returns. Capture
      // its path generation now, before any asynchronous configuration can
      // yield to a close and same-path reopen.
      const sendCancellationGeneration = this.workerRuntimeRouter
        ?.operationCancellationGeneration?.(sessionPath);
      const identity = resolveSessionIdentity(sessionPath);
      const creation: WorkerJsonObject = {
        status: 'created',
        sessionPath,
        titleAssigned: createdRecord.titleAssigned !== false,
        ...(typeof createdRecord.title === 'string' ? { title: createdRecord.title } : { title }),
        ...(typeof createdRecord.titleError === 'string'
          ? { titleError: createdRecord.titleError.slice(0, HOST_SESSION_SETTINGS_ERROR_MAX_CHARS) }
          : {}),
        sessionId: identity.sessionId,
        identityFallback: identity.identityFallback,
      };
      if (createdRecord.titleAssigned === false) {
        return { result: workerJson({
          creation,
          configuration: { status: 'not_started', reason: 'title_assignment_failed' },
          message: { status: payload.prompt === undefined ? 'not_requested' : 'not_sent' },
        } satisfies WorkerJsonObject) };
      }
      const configuration = await this.configureSessionControlSettings(sessionPath, settings, frame.requestId);
      const configurationSucceeded = configuration.status === 'succeeded';
      const message = payload.prompt === undefined
        ? { status: 'not_requested' }
        : !configurationSucceeded
          ? { status: 'not_sent', reason: configuration.status }
          : await this.sendSessionControlPrompt(
            frame,
            sourceSessionPath,
            sessionPath,
            payload.prompt as string,
            `${operationId}:send`,
            sendCancellationGeneration,
          );
      return { result: workerJson({ creation, configuration, message } satisfies WorkerJsonObject) };
    }

    if (frame.action === 'read') {
      const resolved = this.resolveSessionControlTarget('read', payload, sourceSessionPath);
      return await this.executeSessionControlRead(frame, resolved.sessionPath);
    }

    if (frame.action === 'settings.get') {
      const resolved = this.resolveSessionControlTarget('settings.get', payload, sourceSessionPath);
      const settings = await this.sessionControlSettingsResult(resolved.sessionPath);
      return { result: workerJson({ sessionPath: resolved.sessionPath, settings }) };
    }

    if (frame.action === 'settings.set') {
      const patch = this.validateAgentSessionSettingsPatch(payload.settings);
      if (Object.keys(patch).length === 0) {
        throw new BackendError('INVALID_PARAMS', 'settings.set requires at least one supported setting.');
      }
      if (patch.model) await this.assertSessionControlModelAvailable(patch.model);
      const resolved = this.resolveSessionControlTarget('settings.set', payload, sourceSessionPath);
      this.assertSessionNotClosing(resolved.sessionPath);
      if (patch.subagentProviderChoices) {
        const surface = await this.captureSessionControlProviderSurface(resolved.sessionPath);
        BackendServer.assertConfiguredProviderChoices(patch.subagentProviderChoices, surface);
      }
      const configuration = await this.configureSessionControlSettings(resolved.sessionPath, patch, frame.requestId);
      return { result: workerJson({ sessionPath: resolved.sessionPath, configuration }) };
    }

    if (frame.action === 'message') {
      if (!boundedAgentString(payload.prompt, AGENT_SESSION_CONTROL_MAX_MESSAGE_BYTES) || !payload.prompt.trim()) {
        throw new BackendError('INVALID_PARAMS', 'message.prompt must be non-empty and bounded.');
      }
      const patch = payload.settings === undefined ? undefined : this.validateAgentSessionSettingsPatch(payload.settings);
      if (patch && Object.keys(patch).length === 0) {
        throw new BackendError('INVALID_PARAMS', 'message.settings must contain at least one supported setting.');
      }
      if (patch?.model) await this.assertSessionControlModelAvailable(patch.model);
      const resolved = payload.replyTo !== undefined
        ? this.resolveSessionControlReplyTarget(payload, sourceSessionPath)
        : this.resolveSessionControlTarget('message', payload, sourceSessionPath);
      const sendCancellationGeneration = this.workerRuntimeRouter
        ?.operationCancellationGeneration?.(resolved.sessionPath);
      this.assertSessionNotClosing(resolved.sessionPath);
      if (patch?.subagentProviderChoices) {
        const surface = await this.captureSessionControlProviderSurface(resolved.sessionPath);
        BackendServer.assertConfiguredProviderChoices(patch.subagentProviderChoices, surface);
      }
      const configuration = patch
        ? await this.configureSessionControlSettings(resolved.sessionPath, patch, frame.requestId)
        : { status: 'not_requested' };
      const message = configuration.status === 'succeeded' || configuration.status === 'not_requested'
        ? await this.sendSessionControlPrompt(
          frame,
          sourceSessionPath,
          resolved.sessionPath,
          payload.prompt,
          operationId,
          sendCancellationGeneration,
        )
        : { status: 'not_sent', reason: configuration.status };
      return { result: workerJson({ sessionPath: resolved.sessionPath, configuration, message }) };
    }

    const deletePayload = payload.delete;
    if (deletePayload !== undefined && typeof deletePayload !== 'boolean') {
      throw new BackendError('INVALID_PARAMS', 'close.delete must be boolean.');
    }
    const deleteRequested = deletePayload === true;
    const resolvedClose = this.resolveSessionControlTarget('close', payload, sourceSessionPath);
    const selfRequester = backendSessionPathKey(sourceSessionPath) === backendSessionPathKey(resolvedClose.sessionPath);
    if (resolvedClose.status === 'closing') {
      const owningClose = this.closingSessionRequests.get(backendSessionPathKey(resolvedClose.sessionPath));
      if (owningClose) {
        return await this.requestHostSessionClose(
          resolvedClose.sessionPath,
          `${frame.requestId}:close`,
          deleteRequested,
          selfRequester,
        );
      }
      return { result: workerJson({
        sessionPath: resolvedClose.sessionPath,
        closed: false,
        closeRequested: false,
        unknown: true,
        alreadyClosing: true,
        deletionRequested: deleteRequested,
      } satisfies WorkerJsonObject) };
    }
    return await this.requestHostSessionClose(
      resolvedClose.sessionPath,
      `${frame.requestId}:close`,
      deleteRequested,
      selfRequester,
    );
  }

  /** Bounded transcript read for one addressable live session (shared by
   *  the pre-bridge legacy path and membership resolution). */
  private async executeSessionControlRead(
    frame: WorkerSessionControlFrame,
    sessionPath: string,
  ): Promise<WorkerSessionControlOutcome> {
    const payload = frame.payload as Record<string, unknown>;
    const direction = payload.direction ?? 'latest';
    if (direction !== 'older' && direction !== 'newer' && direction !== 'latest') {
      throw new BackendError('INVALID_PARAMS', 'read.direction must be older, newer, or latest.');
    }
    const limit = payload.limit === undefined ? 32 : payload.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 64) {
      throw new BackendError('INVALID_PARAMS', 'read.limit must be an integer from 1 through 64.');
    }
    const cursor = payload.cursor;
    let loadedStart: number | undefined;
    let loadedEnd: number | undefined;
    if (cursor !== undefined) {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
        throw new BackendError('INVALID_PARAMS', 'read.cursor must be an object.');
      }
      const cursorRecord = cursor as Record<string, unknown>;
      const unexpectedCursorKey = Object.keys(cursorRecord).find((key) => key !== 'start' && key !== 'end');
      if (unexpectedCursorKey) {
        throw new BackendError('INVALID_PARAMS', `Unexpected read.cursor key: ${unexpectedCursorKey}`);
      }
      if (!Number.isSafeInteger(cursorRecord.start) || (cursorRecord.start as number) < 0
          || !Number.isSafeInteger(cursorRecord.end) || (cursorRecord.end as number) < 0
          || (cursorRecord.start as number) > (cursorRecord.end as number)) {
        throw new BackendError('INVALID_PARAMS', 'read.cursor must contain a non-inverted non-negative range.');
      }
      loadedStart = cursorRecord.start as number;
      loadedEnd = cursorRecord.end as number;
    } else if (direction !== 'latest') {
      throw new BackendError('INVALID_PARAMS', `${direction} read requires a cursor.`);
    }
    const page = await this.handleRequest({
      id: `${frame.requestId}:read`,
      method: 'session.loadTranscriptPage',
      params: {
        sessionPath,
        direction,
        ...(loadedStart !== undefined ? { loadedStart } : {}),
        ...(loadedEnd !== undefined ? { loadedEnd } : {}),
      },
    }) as TranscriptPagePayload;
    const agentPage: TranscriptPagePayload = {
      sessionPath: page.sessionPath,
      transcript: projectSessionControlTranscript(page.transcript),
      transcriptWindow: page.transcriptWindow,
      busy: page.busy,
    };
    const bounded = boundTranscriptSnapshot(agentPage, {
      transport: { kind: 'response', requestId: `${frame.requestId}:read` },
      // The control page is the edge adjacent to the caller cursor: newer
      // rows for an older request, and older rows for a newer request. Keep
      // that edge when the expanded backend window must be bounded.
      requestedEdge: direction === 'newer' ? 'older' : 'newer',
      maxLineBytes: AGENT_SESSION_CONTROL_MAX_RESULT_BYTES,
    });
    const sourceStart = bounded.transcriptWindow.loadedStart;
    const sourceEnd = bounded.transcriptWindow.loadedEnd;
    const pageEdge = direction === 'older'
      ? loadedStart ?? sourceEnd
      : direction === 'newer'
        ? loadedEnd ?? sourceStart
        : sourceEnd;
    const boundedEdge = Math.max(sourceStart, Math.min(sourceEnd, pageEdge));
    const pageStart = direction === 'older'
      ? Math.max(sourceStart, boundedEdge - (limit as number))
      : direction === 'latest'
        ? Math.max(sourceStart, sourceEnd - (limit as number))
        : boundedEdge;
    const pageEnd = direction === 'older'
      ? boundedEdge
      : Math.min(sourceEnd, pageStart + (limit as number));
    const transcriptStart = pageStart - sourceStart;
    const transcriptEnd = pageEnd - sourceStart;
    const transcript = bounded.transcript.slice(transcriptStart, transcriptEnd);
    const nextEnd = pageStart + transcript.length;
    const nextWindow = {
      ...bounded.transcriptWindow,
      loadedStart: pageStart,
      loadedEnd: nextEnd,
      hasOlder: pageStart > 0,
      hasNewer: nextEnd < bounded.transcriptWindow.totalCount,
      isPartial: pageStart > 0 || nextEnd < bounded.transcriptWindow.totalCount,
    };
    return {
      result: workerJson({
        sessionPath: bounded.sessionPath,
        transcript,
        transcriptWindow: nextWindow,
        busy: bounded.busy,
        cursor: { start: pageStart, end: nextEnd },
      }),
    };
  }

  private async handleRequest(
    request: RequestEnvelope,
    onRequestValidated?: () => void,
    livePipelineTraceToggleGeneration?: number,
    onSessionOpenTiming?: (sample: SessionOpenTimingSample) => void,
    trustedSessionControlMessage = false,
    expectedCancellationGeneration?: number,
  ): Promise<unknown> {
    // This is the actual coordinator ingress, before either hot-worker routing
    // or the standalone handler can inspect the raw envelope. Only the
    // authenticated worker session_control send above may carry attribution.
    if (request.method === 'message.send' && !trustedSessionControlMessage
      && request.params && typeof request.params === 'object' && !Array.isArray(request.params)) {
      const { coordinatorAttribution: _untrusted, ...params } = request.params as Record<string, unknown>;
      request = { ...request, params };
    }
    const router = this.workerRuntimeRouter;
    if (request.method === 'message.edit') {
      const params = validateMessageEdit(request.params);
      onRequestValidated?.();
      if (!router) {
        throw new BackendError(
          'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
          'Operation message.edit requires Phase 4 isolated-runtime routing; Phase 4 isolated-runtime routing is unavailable.',
        );
      }
      if (this.interruptOperationLedger.status(params.operationId)) {
        throw new BackendError('OPERATION_INTENT_MISMATCH', `Operation ${params.operationId} was already used for an interrupt intent.`);
      }
      return await this.handleMessageEdit(router, request, params);
    }
    if (request.method === 'message.interrupt' && router) {
      const params = validateMessageInterrupt(request.params);
      onRequestValidated?.();
      if (!params.operationId) {
        return await this.executeCoordinatorInterrupt(router, request.id, params.sessionPath);
      }
      if (this.editOperationLedger.status(params.operationId)
        || router.hasMessageOperationOwner(params.operationId)) {
        throw new BackendError('OPERATION_INTENT_MISMATCH', `Operation ${params.operationId} was already used for a different message mutation intent.`);
      }
      if (!this.interruptOperationSessions.has(params.operationId)) {
        this.interruptOperationSessions.set(params.operationId, params.sessionPath);
      }
      const result = await this.interruptOperationLedger.run(
        params.operationId,
        canonicalInterruptIntentFingerprint(params.sessionPath),
        async () => await this.executeCoordinatorInterrupt(router, request.id, params.sessionPath),
      );
      return { ...result, operationId: params.operationId, operationAttempt: params.operationAttempt };
    }
    if (request.method === 'analytics.writerFence') {
      onRequestValidated?.();
      if (!router) {
        throw new BackendError(
          'WRITER_FENCE_ROUTING_UNAVAILABLE',
          'Authenticated writer fencing requires isolated-runtime routing.',
        );
      }
      const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
        ? request.params as { timeoutMs?: unknown }
        : {};
      const timeoutMs = params.timeoutMs === undefined
        ? 2_000
        : typeof params.timeoutMs === 'number' ? params.timeoutMs : Number.NaN;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000) {
        throw new BackendError('WRITER_FENCE_INVALID', 'Authenticated writer-fence timeout is invalid.');
      }
      await router.fenceSessionManagers(timeoutMs);
      const activeWriterCount = await this.waitForAnalyticsWriterLeases(timeoutMs);
      if (activeWriterCount !== 0) {
        throw new BackendError(
          'WRITER_FENCE_INCOMPLETE',
          `Durable analytics writer leases did not drain (${activeWriterCount} remain).`,
        );
      }
      return { admissionRevoked: true, writersDrained: true, activeWriterCount: 0 };
    }
    if (request.method === 'operation.status') {
      const params = validateOperationStatus(request.params);
      const interruptStatus = this.interruptOperationStatus(params.sessionPath, params.operationId);
      if (interruptStatus) {
        onRequestValidated?.();
        if (params.backendGeneration !== undefined && params.backendGeneration !== this.backendGeneration) {
          throw new BackendError('SESSION_GENERATION_ENDED', 'The session mutation generation is no longer available.');
        }
        return interruptStatus;
      }
      const editStatus = this.editOperationStatus(params.sessionPath, params.operationId);
      if (editStatus) {
        onRequestValidated?.();
        if (params.backendGeneration !== undefined && params.backendGeneration !== this.backendGeneration) {
          throw new BackendError('SESSION_GENERATION_ENDED', 'The session mutation generation is no longer available.');
        }
        if (router) {
          await this.reconcileAcceptedEditStatus(router, request, params.sessionPath, params.operationId);
        }
        return this.editOperationLedger.status(params.operationId)!;
      }
    }
    if (router) {
        const sessionPath = requestSessionPath(request.params);
        const messageOperationId = request.params && typeof request.params === 'object'
          && !Array.isArray(request.params)
          && typeof (request.params as { operationId?: unknown }).operationId === 'string'
          ? (request.params as { operationId: string }).operationId
          : undefined;
        if (request.method !== 'operation.status' && messageOperationId
          && this.interruptOperationLedger.status(messageOperationId)) {
          throw new BackendError(
            'OPERATION_INTENT_MISMATCH',
            `Operation ${messageOperationId} was already used for an interrupt intent.`,
          );
        }
        let routeState = sessionPath ? router.getRoute(sessionPath) : undefined;
        const operationCancellationGeneration = expectedCancellationGeneration
          ?? (sessionPath && ISOLATED_PROMOTION_METHODS.has(request.method)
            ? router.operationCancellationGeneration(sessionPath)
            : undefined);
        // Read/config commands do not initiate promotion, but once another
        // command has claimed the cold lease they must wait and reselect the
        // winning authority. Falling through to the coordinator while the
        // route is promoting/retiring only guarantees a stale cold read.
        if (sessionPath
          && !ISOLATED_PROMOTION_METHODS.has(request.method)
          && isCoordinatorOperationAllowed(request.method, request.params)
          && (WorkerRuntimeRouter.isHotOperation(request.method) || request.method === 'session.duplicate')
          && (routeState?.state === 'promoting' || routeState?.state === 'retiring')) {
          await this.waitForSessionBrowseAuthority(sessionPath);
          routeState = router.getRoute(sessionPath);
        }
        const waitsForRuntimeTransition = request.method === 'message.send'
          || request.method === 'message.continue'
          || request.method === 'message.compact'
          || request.method === 'session.title.generate';
        if (routeState?.state === 'transitioning' && waitsForRuntimeTransition && sessionPath) {
          const outcome = await waitForSessionTransition({
            resolveCurrent: async () => {
              const current = router.getRoute(sessionPath);
              if (current.state === 'transitioning') await current.completion.catch(() => undefined);
              return router.getRoute(sessionPath);
            },
            isPending: () => router.getRoute(sessionPath).state === 'transitioning',
          });
          if (outcome.status === 'timed-out') {
            throw new BackendError(
              'SESSION_TRANSITION_TIMEOUT',
              `The session runtime transition did not settle within ${formatInterruptWatchdogDuration(outcome.timeoutMs)}.`,
            );
          }
          routeState = outcome.value;
        }
        if (routeState?.state === 'transitioning'
            && request.method !== 'session.truncateAfter'
            && request.method !== 'session.viewed'
            && request.method !== 'message.interrupt') {
          throw new BackendError(
            'SESSION_TRANSITION_IN_PROGRESS',
            `Session transition is already in progress for ${sessionPath}.`,
          );
        }
        // Demand-driven subagent detail. These are router/store-level
        // operations, not worker runtime commands: subscribe/unsubscribe/fetch
        // settle as correlated control responses while stream content crosses
        // only through the six `detail.stream` events. Hot live sources are
        // answered by the owning worker; terminal/cold sources are answered by
        // the coordinator's durable paged authority directly from the durable
        // JSONL (never one >30 MiB response).
        if (request.method === 'detail.subscribe' || request.method === 'detail.unsubscribe' || request.method === 'detail.fetch') {
          onRequestValidated?.();
          if (request.method === 'detail.subscribe') {
            const params = validateDetailSubscribe(request.params);
            await this.routeDetailSubscribe(request.id, params);
          } else if (request.method === 'detail.unsubscribe') {
            const params = validateDetailUnsubscribe(request.params);
            await this.routeDetailUnsubscribe(request.id, params);
          } else {
            const params = validateDetailFetch(request.params);
            await this.routeDetailFetch(request.id, params);
          }
          return { accepted: true };
        }
        if (request.method === 'session.truncateAfter' && sessionPath) {
          const transition = router.getRoute(sessionPath);
          if (transition.state === 'promoting') await transition.promotion;
          else if (transition.state === 'retiring') await transition.retirement;
        }
        if (request.method === 'session.truncateAfter' && sessionPath
            && (router.hasHotOwner(sessionPath) || router.getRoute(sessionPath).state === 'transitioning')) {
          const params = validateTruncateAfter(request.params);
          onRequestValidated?.();
          // Install the transition synchronously before the first interrupt
          // await. Same-entry retries join this exact transaction; every other
          // path-scoped command is fenced by SESSION_TRANSITION_IN_PROGRESS.
          return await router.runHotTransition(
            sessionPath,
            `hot-truncate:${params.entryId}`,
            async (transition) => {
              await transition.interrupt(`hot truncate ${request.id}`);
              await transition.retire('hot truncate quiesced');
              const store = this.initializeColdSessionStore();
              const handle = await this.runColdSessionMutation(sessionPath, async () => {
                const truncated = await store.truncateAfter(sessionPath, params.entryId);
                this.retainColdSessionManager(truncated, 'resume');
                return truncated;
              });
              transition.assertActive();
              await transition.promote(handle.sessionPath);
              void this.emitSessionListChanged();
              return { ok: true, sessionPath: handle.sessionPath };
            },
          );
        }
        if (sessionPath && WorkerRuntimeRouter.isHotOperation(request.method)) {
          if (request.method === 'extension_ui.response' && !router.hasHotOwner(sessionPath)) {
            // A response for a session whose worker is gone (crashed, retired,
            // or replaced) is correlated typed-stale: never promote a fresh
            // worker just to reject it, and never invoke any worker callback.
            throw new BackendError('UI_REQUEST_NOT_PENDING', 'The extension UI request is no longer pending.');
          }
          const shouldPromote = ISOLATED_PROMOTION_METHODS.has(request.method);
          if (shouldPromote) return await router.route(request, operationCancellationGeneration);
          if (router.hasHotOwner(sessionPath)) {
            if (request.method === 'session.title.generate') {
              const titleParams = validateSessionTitleGenerate(request.params);
              if (titleParams.enabled === false) {
                return await this.finalizeGeneratedLiveSessionTitle(
                  sessionPath, titleParams.prompt, { generated: false, reason: 'disabled' }, request.id,
                );
              }
            }
            let routed: unknown;
            try {
              routed = await router.routeExisting(request);
            } catch (error) {
              if (request.method !== 'session.title.generate') throw error;
              const titleParams = validateSessionTitleGenerate(request.params);
              backendWarn('backend-live-titles', 'title model failed; finalizing snippet', {
                sessionPath, error: toErrorMessage(error),
              });
              return await this.finalizeGeneratedLiveSessionTitle(
                sessionPath, titleParams.prompt, { generated: false, reason: 'model-failed' }, request.id,
              );
            }
            if (request.method !== 'session.title.generate') return routed;
            // The worker returned a candidate-only generation result. The
            // coordinator now owns unique allocation and ownership-safe
            // persistence before the assigned name is exposed to the host.
            const generation = routed && typeof routed === 'object'
              ? (routed as { generated?: unknown; name?: unknown; reason?: unknown })
              : { generated: false };
            let generationPrompt = '';
            try {
              const titleParams = validateSessionTitleGenerate(request.params);
              generationPrompt = titleParams.prompt;
            } catch {
              // A malformed request already failed at the worker; keep the
              // wrapper transparent for the routed outcome instead of masking it.
              return routed;
            }
            return await this.finalizeGeneratedLiveSessionTitle(
              sessionPath,
              generationPrompt,
              generation,
              request.id,
            );
          }
          if (request.method === 'operation.status') {
            const operationId = request.params && typeof request.params === 'object'
              && !Array.isArray(request.params)
              && typeof (request.params as { operationId?: unknown }).operationId === 'string'
              ? (request.params as { operationId: string }).operationId
              : undefined;
            if (operationId && router.hasMessageOperationOwner(operationId)) {
              throw new BackendError(
                'SESSION_GENERATION_ENDED',
                'The worker generation that owned this message operation is no longer available.',
              );
            }
          }
          if (!isCoordinatorOperationAllowed(request.method, request.params)) {
            throw new BackendError('SESSION_NOT_FOUND', `No hot worker owns ${sessionPath}.`);
          }
        }
      }
      if (!isCoordinatorOperationAllowed(request.method, request.params)) {
        throw new BackendError(
          'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
          router
            ? `Operation ${request.method} requires an isolated runtime owner and cannot use the coordinator runtime.`
            : `Operation ${request.method} requires Phase 4 isolated-runtime routing; Phase 4 isolated-runtime routing is unavailable.`,
        );
      }
    const sessionDir = this.getSessionDir();
    const result = await handleBackendRequest({
      sdkPath: this.sdkPath,
      backendGeneration: this.backendGeneration,
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
      sessionDir,
      sdk: this.sdk,
      getSessionContext: () => undefined,
      createSessionContext: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'The coordinator does not create in-process session runtimes.');
      },
      ensureSessionContext: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'The coordinator does not own in-process session runtimes.');
      },
      recycleSessionRuntime: async (sessionPath, reason) => {
        const runtimeRouter = this.workerRuntimeRouter;
        if (!runtimeRouter || !runtimeRouter.hasHotOwner(sessionPath)) return false;
        // Never retire a worker with a request in flight (owner of a turn whose
        // tool calls / message stream still reference its process).
        const route = runtimeRouter.getRoute(sessionPath);
        if (route.state !== 'hot' || route.checkpoint.requestId !== undefined) return false;
        await runtimeRouter.retire(sessionPath, reason);
        return true;
      },
      createColdSession: async (cwd, pendingCreateOperationId, agentCreated) => {
        const replayPath = this.resolvePendingCreateReplay(pendingCreateOperationId);
        if (replayPath) return { sessionPath: replayPath };
        const handle = this.initializeColdSessionStore().create({ cwd, agentCreated });
        this.retainColdSessionManager(handle, 'new');
        await this.registerNewSessionLifecycle(handle.sessionPath, pendingCreateOperationId);
        return { sessionPath: handle.sessionPath };
      },
      duplicateColdSession: async (sessionPath, publicRequestId, pendingCreateOperationId) => {
        return await this.duplicateSessionFromCurrentOwner(
          sessionPath,
          publicRequestId,
          pendingCreateOperationId,
        );
      },
      truncateColdSessionAfter: async (sessionPath, entryId) => {
        const store = this.initializeColdSessionStore();
        const handle = await this.runColdSessionMutation(sessionPath, async () => {
          store.leases.invalidate(sessionPath);
          this.coldSessionManagerHandles.delete(this.coldManagerKey(sessionPath));
          const truncated = await store.truncateAfter(sessionPath, entryId);
          // Retention is part of the mutation owner. A promotion waiting on the
          // mutation cannot resume between durable commit and handle install.
          this.retainColdSessionManager(truncated, 'resume');
          return truncated;
        });
        return { sessionPath: handle.sessionPath };
      },
      applyColdSessionModelSettings: async (sessionPath, updates) => {
        const store = this.initializeColdSessionStore();
        await this.runColdSessionMutation(sessionPath, async () => {
          const retained = this.coldSessionManagerHandles.get(this.coldManagerKey(sessionPath));
          if (retained) store.setHandleModelSettings(retained.handle, updates);
          else store.setModelSettings(sessionPath, updates);
        });
      },
      applyColdSystemPromptToggles: async (sessionPath, disabledEntries) => {
        await this.runColdSessionMutation(sessionPath, async () => {
          if (this.forgottenSessionPaths.has(sessionPath) || !fsSync.existsSync(sessionPath)) {
            throw new BackendError('SESSION_NOT_FOUND', `Unknown session: ${sessionPath}`);
          }
          if (!isSystemPromptTogglePersistenceAvailable()) {
            throw new BackendError(
              'COLD_SESSION_SETTINGS_UNAVAILABLE',
              'System-prompt toggle persistence directory is unavailable.',
            );
          }
          // A cold coordinator has no in-memory prompt state to fall back to,
          // so this write is strict: success means the choice will survive a
          // backend restart and be consumed when the worker is promoted.
          if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] === STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
            await this.initializeFilesystemLifecycle().barrier.runAdministrativeAsync(
              '__aggregate_session_prompt_settings__',
              'coordinator-prompt-toggles.aggregate',
              () => writeSystemPromptTogglesForSession(sessionPath, disabledEntries, true),
            );
          } else {
            await this.withAnalyticsWriterAdmission(
              () => writeSystemPromptTogglesForSession(sessionPath, disabledEntries, true),
            );
          }
        });
      },
      isSessionTransitionPending: () => false,
      transitionSessionContext: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'The coordinator does not transition in-process session runtimes.');
      },
      prepareViewedSessionPath: (sessionPath) => this.prepareViewedSessionPath(sessionPath),
      discardPreparedViewedSessionPath: (sessionPath, token) => this.discardPreparedViewedSessionPath(
        sessionPath,
        token as PreparedViewedSessionTransition | undefined,
      ),
      commitPreparedViewedSessionPath: (sessionPath, token) => this.commitPreparedViewedSessionPath(
        sessionPath,
        token as PreparedViewedSessionTransition | undefined,
      ),
      recordViewedSessionTransition: (sessionPath, previousSessionPath) => (
        this.recordViewedSessionTransition(sessionPath, previousSessionPath)
      ),
      captureViewedSessionRevision: () => this.viewedSessionRevision,
      setViewedSessionPathIfCurrent: (sessionPath, revision) => (
        this.setViewedSessionPathIfCurrent(sessionPath, revision)
      ),
      setViewedSessionPath: (sessionPath) => this.setViewedSessionPath(sessionPath),
      buildSessionOpenedPayload: (sessionPath, selectionToken, transcript, transport, operationId, operationAttempt, systemPromptDisabledEntries, publicRequestId, includeInitialContextInventory = true) => (
        this.buildSessionOpenedPayload(
          sessionPath,
          selectionToken,
          transcript,
          transport,
          operationId,
          operationAttempt,
          systemPromptDisabledEntries,
          includeInitialContextInventory,
          publicRequestId,
        )
      ),
      createOperationLedger: this.createOperationLedger,
      buildTransitionSessionOpenedPayload: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'The coordinator does not build in-process transition snapshots.');
      },
      applySystemPromptToggles: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'System prompt toggles require a hot worker owner.');
      },
      setAutonomousMode: () => undefined,
      runSessionFilesystemMutation: (sessionPath, seam, operation) => (
        this.runSessionFilesystemMutation(sessionPath, seam, operation)
      ),
      setSessionLifecyclePrivacy: (sessionPath, enabled) => this.setSessionLifecyclePrivacy(sessionPath, enabled),
      closeSessionLifecycle: (sessionPath, operationId, privacyMode) => (
        this.closeSessionLifecycle(sessionPath, operationId, privacyMode)
      ),
      handleSessionCloseAcknowledgement: (params) => this.acknowledgeHostCloseRequest(params),
      handleSessionControlSettingsAcknowledgement: (params) => (
        this.acknowledgeHostSessionControlSettings(params)
      ),
      assertSessionNotClosing: (sessionPath) => this.assertSessionNotClosing(sessionPath),
      applyHostLiveMembership: (snapshot) => this.applyHostLiveMembership(snapshot),
      assignCreatedSessionTitle: (sessionPath, baseTitle, requestId) => (
        this.assignCreatedSessionTitle(sessionPath, baseTitle, requestId)
      ),
      noteNewSessionPublished: (sessionPath) => {
        this.newCreatePublicationPaths.add(this.coldManagerKey(sessionPath));
      },
      admitOpenedSessionTitle: (sessionPath, allowStartupRestore) => this.admitOpenedSessionTitle(sessionPath, allowStartupRestore),
      forgetSession: (sessionPath, operationId) => this.forgetSession(sessionPath, operationId),
      loadTranscriptPage: (sessionPath, direction, loadedStart, loadedEnd, options) => (
        this.loadTranscriptPage(sessionPath, direction, loadedStart, loadedEnd, options)
      ),
      loadDetail: (sessionPath, ref) => this.loadDetail(sessionPath, ref),
      transferBrowseResponseOwnership: (source, target) => {
        const owner = this.browseResponseOwners.get(source);
        if (owner) this.browseResponseOwners.set(target, owner);
        this.coldSessionStore?.transferOwnershipStamp(source, target);
      },
      emit: (event, payload) => this.emit(event, payload),
      emitBusyChanged: () => undefined,
      emitContextUsageChanged: () => undefined,
      emitSessionListChanged: (liveSummaries) => this.emitSessionListChanged(liveSummaries),
      listSessions: () => this.listSessionSummaries(),
      listAvailableModels: async (context) => {
        const catalog = context
          ? loadAvailableModels(context, this.agentDir)
          : await loadConfiguredModels(this.agentDir, this.modelRegistry);
        if (!catalog.ok) {
          throw new BackendError('MODEL_CATALOG_UNAVAILABLE', `Unable to load the model catalog: ${catalog.error}`);
        }
        return catalog.models;
      },
      readModelSettings: () => this.readModelSettings(),
      writeModelSettings: (updates) => this.writeModelSettings(updates),
      writeModelSettingsIfCurrent: (expected, updates, unset) => (
        this.writeModelSettingsIfCurrent(expected, updates, unset)
      ),
      retireSessionRuntime: async (sessionPath, reason) => {
        const runtimeRouter = this.workerRuntimeRouter;
        if (!runtimeRouter || !runtimeRouter.hasHotOwner(sessionPath)) return false;
        const route = runtimeRouter.getRoute(sessionPath);
        if (route.state !== 'hot') return false;
        // This path is fail-closed recovery after an SDK model rollback has
        // failed. Unlike an ordinary recycle, it must retire even when a turn
        // raced the settings check: the runtime cannot remain billable through
        // an unverified provider identity.
        await runtimeRouter.retire(sessionPath, reason);
        return true;
      },
      getProviderGateMetrics: () => this.workerRuntimeRouter?.getProviderGateMetrics(),
      getSubagentConcurrencyStatus: () => this.workerRuntimeRouter?.getSubagentConcurrencyStatus(),
      acknowledgeAnalytics: (route, acknowledgement) => (
        this.workerRuntimeRouter?.acknowledgeAnalytics(route, acknowledgement) === true
      ),
      onRequestValidated,
      onSessionOpenTiming,
      suppressRequestTrace: true,
      livePipelineTraceToggleGeneration,
      deferLivePipelineTraceDisable: (requestId, generation, onApplied) => (
        this.deferLivePipelineTraceDisable(requestId, generation, onApplied)
      ),
      onLivePipelineTraceEnabledChange: (enabled) => {
        if (enabled) this.markLivePipelineTraceEnabled();
        else this.stopEventLoopMonitor();
      },
    }, request);
    if (request.method === 'runtimePrefs.set'
      && result && typeof result === 'object' && !Array.isArray(result)) {
      this.runtimePrefs = JSON.parse(JSON.stringify(result)) as WorkerJsonObject;
      await this.workerRuntimeRouter?.syncRuntimePrefs(this.runtimePrefs);
      await this.workerRuntimeRouter?.syncProviderPolicy(
        mergeProviderPolicies(this.providerBasePolicies, this.runtimePrefs.providerConcurrency),
      );
    }
    if (request.method === 'settings.set'
      && result && typeof result === 'object' && !Array.isArray(result)) {
      // A settings write that the coordinator handled (a global write, or a
      // session-scoped write for a cold session with no live runtime) must be
      // re-broadcast so hot workers never serve the pre-write snapshot.
      // Session-scoped writes for hot sessions are routed to the owning worker
      // above and never reach this block.
      await this.workerRuntimeRouter?.syncSettings();
    }
    return result;
  }


  /** Wait for every process sharing this host's durable lifecycle authority to
   * release its writer lease. Delegated to the analytics authority owner: the
   * durable census includes coordinator, recorder, and worker leases. A live
   * lease never expires here: timeout is an explicit fail-closed result, not
   * permission to assume the writer stopped. */
  private async waitForAnalyticsWriterLeases(timeoutMs: number): Promise<number> {
    return await this.analyticsAuthority?.waitForWriterLeases(timeoutMs) ?? 0;
  }

  /**
   * Locally terminalize a stuck runtime immediately, then replace it without
   * waiting for provider teardown. The old runtime is fenced before any async
   * work so late SDK events cannot revive or terminalize the request twice.
   */

  async dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeOnce();
    await this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    // Idempotent ownership is provided by disposePromise. The flag suppresses
    // stale events from in-flight async paths via the `disposed` guard on
    // `emit`/`emitSessionListChanged`.
    recordBackendLivePipelineTrace({
      stage: 'process.lifecycle',
      kind: 'success',
      phase: 'backend_mapping',
      readiness: 'not_ready',
      processRole: 'coordinator',
      pid: process.pid,
    });
    this.disposed = true;
    this.clearLiveTitleNamespaceRetry();
    for (const [requestId, entry] of this.hostSessionSettingsRequests) {
      clearTimeout(entry.timer);
      this.hostSessionSettingsRequests.delete(requestId);
      entry.resolve(undefined);
    }
    this.coldSessionManagerHandles.clear();
    this.pendingLivePipelineTraceDisables.clear();
    this.stopHostWatchdog();
    this.stopHostLifetimeWatch();
    this.stopEventLoopMonitor();
    let workerSupervisorDisposeError: unknown;
    if (this.initialContextEstimateClient) {
      try {
        await this.initialContextEstimateClient.dispose();
        this.initialContextEstimateClient = undefined;
      } catch (error) {
        workerSupervisorDisposeError ??= error;
        log(`initial context inventory disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    if (this.coldBrowseHelper) {
      try {
        await this.coldBrowseHelper.dispose();
        this.coldBrowseHelper = undefined;
      } catch (error) {
        workerSupervisorDisposeError ??= error;
        log(`cold browse helper disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    if (this.workerRuntimeRouter) {
      try {
        await this.workerRuntimeRouter.dispose();
        this.workerRuntimeRouter = undefined;
      } catch (error) {
        workerSupervisorDisposeError ??= error;
        log(`worker runtime router disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    if (this.workerSupervisor) {
      try {
        await this.workerSupervisor.dispose();
        this.workerSupervisor = undefined;
      } catch (error) {
        workerSupervisorDisposeError ??= error;
        log(`worker supervisor disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    await this.lifecycleScheduler?.stop();
    this.lifecycleScheduler = undefined;
    this.lifecycleStore?.close();
    this.lifecycleStore = undefined;
    this.lifecycleBarrier = undefined;
    this.analyticsAuthority?.close();
    this.analyticsAuthority = undefined;
    if (this.coldSessionStore) {
      // Keep coordinator-local reservations intact until every hot worker has
      // confirmed exit and runtime ownership reconciliation has released its
      // exact fence. Advancing sooner clears those reservations underneath the
      // normal worker-exit callbacks, turning graceful teardown into a false
      // stale-reservation failure. The generation advance remains the final
      // fail-closed barrier for any in-flight cold work from this process.
      this.coldSessionStore.leases.advanceCoordinatorGeneration(this.backendGeneration + 1);
    }
    // Reject provider waiters and clear referenced queue/afterburn timers even
    // when an SDK runtime ignores abort during shutdown. The global fetch
    // wrapper is process-owned, so server disposal is its production teardown.
    ProviderGate.uninstall();

    this.sessionCatalogPollingActive = false;
    if (this.sessionCatalogPollTimer) clearInterval(this.sessionCatalogPollTimer);
    this.sessionCatalogPollTimer = undefined;
    this.browsePreviousSessionFiles.clear();

    await flushBackendLivePipelineTrace();
    if (workerSupervisorDisposeError) throw workerSupervisorDisposeError;
  }
}

function backendTraceEventKind(event: string) {
  if (event === 'message.delta') return 'text' as const;
  if (event === 'message.thinking') return 'reasoning' as const;
  if (event === 'message.toolCallDelta') return 'tool_draft' as const;
  if (event === 'tool.started') return 'tool_start' as const;
  if (event === 'tool.progress') return 'tool_progress' as const;
  if (event === 'tool.finished') return 'tool_terminal' as const;
  if (event === 'message.started') return 'turn_start' as const;
  if (event === 'message.finished' || event === 'message.aborted') return 'turn_terminal' as const;
  return 'control' as const;
}
