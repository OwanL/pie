import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { rewritePieHarnessPrompt } from '../../../shared/pie-harness-prompt.js';
import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES } from '../shared/jsonl';
import { toErrorMessage, parseJsonOrThrow } from '../shared/error-message';
import { updateSettingsJsonObject } from '../shared/settings-json-update';
import {
  PROTOCOL_VERSION,
  type BusyChangedPayload,
  type ContextUsageChangedPayload,
  type ContextWindowUsage,
  type MessageAbortedPayload,
  type ModelSettings,
  type RequestEnvelope,
  type SessionListChangedPayload,
  type SessionOpenedPayload,
  type SystemPromptEntry,
  type ThinkingLevel,
  type TranscriptPageDirection,
  type TranscriptPagePayload,
} from '../shared/protocol';
import { getDefaultAuthDir, ensureDir, isInsideGitWorkTree, migrateAuthFile } from './auth.js';
import { deriveContextUsageFromBranch } from './context-usage';
import { ExtensionUIBridge } from './extension-ui-bridge';
import { handleBackendRequest } from './request-handler';
import { handleSdkSessionEvent } from './session-event-handler';
import {
  listAvailableModels,
  listSessions as listSessionSummaries,
  resolveActiveModel,
} from './session-metadata';
import { ensureReviewsDir, startReviewWatcher } from './session-review-store';
import {
  readSystemPromptTogglesForSession,
  writeSystemPromptTogglesForSession,
} from './system-prompt-toggle-store';
import {
  loadSdk,
  loadSdkInternalModule,
  type SdkModule,
  type SdkSession,
  type SdkSessionEvent,
  type SdkSessionManager,
  type SdkSystemPromptModule,
} from './sdk';
import { ProviderGate } from './provider-gate.js';
import { observeProviderTransport } from './provider-progress-bus.js';
import { BackendError, extractRequestError, log, responseError, responseOk, writeStdout } from './server-io';
import { isBackendLivePipelineTraceEnabled, recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';
import {
  type SessionContext,
  type SessionContextCreationReason,
  type SessionPromptState,
} from './server-types';
import {
  buildSessionSystemPrompts,
  buildToggledSystemPrompt,
  captureOriginalSystemPromptOptions,
  installSystemPromptToggleRebuildGuard,
  installSystemPromptToolToggleGuard,
  normalizePromptText,
  TOOLS_ENTRY_ID,
} from './system-prompts';
import {
  buildDisplayTranscriptCache,
  buildPagedTranscriptWindow,
  isDisplayTranscriptCacheStale,
} from './transcript-window';
import type { SessionEntryLike } from './transcript';
import { createRuntimeFactory } from './runtime-factory.js';
import { backendTrace, backendError, backendInfo, backendWarn } from './log';
import { buildSessionOpenedPayload as buildSessionOpenedPayloadHelper, normalizeDanglingTranscript } from './session-opened.js';

export function extractPreviewRequestId(preview: string): string | undefined {
  const match = /"id"\s*:\s*"([^"\\]{1,200})"/.exec(preview);
  return match?.[1];
}

/** Simple stopwatch for backend timing probes. */
function timed<T>(label: string, op: () => T): T;
function timed<T>(label: string, op: () => Promise<T>): Promise<T>;
function timed<T>(label: string, op: () => T | Promise<T>): T | Promise<T> {
  const start = Date.now();
  const finish = (result: T | Promise<T>): T | Promise<T> => {
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          backendTrace('timing', 'op.completed', { label, durationMs: Date.now() - start });
          return value;
        },
        (error) => {
          backendTrace('timing', 'op.failed', { level: 'warn', label, durationMs: Date.now() - start, error: toErrorMessage(error) });
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
    backendTrace('timing', 'op.failed', { level: 'warn', label, durationMs: Date.now() - start, error: toErrorMessage(error) });
    throw error;
  }
}

/** Module-level guard: install the fatal handlers at most once even if
 *  `start()` is invoked more than once. */
let backendFatalHandlersInstalled = false;

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
  private sdk!: SdkModule;
  private readonly sdkPath: string;
  private readonly startupCwd: string;
  private agentDir = '';
  private authStorage: unknown;
  private viewedSessionPath?: string;
  private readonly sessionContexts = new Map<string, SessionContext>();
  /** Deduplicates concurrent opens/preloads for the same cold session. */
  private readonly pendingSessionContexts = new Map<string, Promise<SessionContext>>();
  private systemPromptModulePromise?: Promise<SdkSystemPromptModule>;
  /** Disposer for the session-review sidecar watcher (see `startReviewWatcher`). */
  private stopReviewWatcher?: () => void;
  private stopProviderProgressObserver?: () => void;

  constructor(options: { sdkPath: string; cwd: string }) {
    this.sdkPath = options.sdkPath;
    this.startupCwd = options.cwd;
  }

  async start(): Promise<void> {
    // Install fatal handlers first so even an early spawn-time rejection is
    // surfaced. Idempotent (module-level guard).
    installBackendFatalHandlers();
    await timed('start.loadSdk', async () => {
      this.sdk = await loadSdk(this.sdkPath);
      this.agentDir = this.sdk.getAgentDir();
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

    this.stopProviderProgressObserver = observeProviderTransport((observation) => {
      const context = [...this.sessionContexts.values()].find((candidate) =>
        candidate.session.sessionManager.getSessionId?.() === observation.sessionId,
      );
      const accumulator = context?.activeRequest?.liveTurnAccumulator;
      const checkpointSeq = accumulator?.checkpoint().checkpointSeq ?? 0;
      if (context && accumulator && checkpointSeq > 0) {
        if (observation.kind === 'gate_queue') {
          this.emit('live.semantic', accumulator.observe({ kind: 'turn.phase', phase: 'queued', inactivityBudgetMs: 120_000 }, observation.occurredAt));
        } else if (observation.kind === 'headers_wait' || observation.kind === 'headers_received') {
          this.emit('live.semantic', accumulator.observe({ kind: 'turn.phase', phase: 'waiting_provider', inactivityBudgetMs: 120_000 }, observation.occurredAt));
        }
      }
      if (context && isBackendLivePipelineTraceEnabled()) {
        recordBackendLivePipelineTrace({
          stage: 'provider.phase.transition',
          kind: 'transition',
          identifiers: {
            session: context.sessionPath,
            ...(context.activeRequest?.id ? { request: context.activeRequest.id } : {}),
          },
          phase: observation.kind === 'gate_queue'
            ? 'provider_gate_queue'
            : observation.kind === 'headers_wait'
              ? 'headers'
              : observation.kind === 'headers_received'
                ? 'pre_first_semantic'
                : observation.kind === 'raw_chunk'
                  ? 'semantic_stream'
                  : 'terminal',
        });
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

      this.authStorage = this.sdk.AuthStorage.create(authPath);
    });

    // Attach the stdin reader BEFORE emitting backend.ready so that any
    // request the client sends immediately after receiving ready is captured,
    // rather than racing with reader attachment.
    const detachReader = attachJsonlLineReader(process.stdin, (line) => {
      void this.handleLine(line);
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
      void this.dispose();
    });

    this.emit('backend.ready', {
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      sdkVersion: this.sdk.VERSION,
      protocolVersion: PROTOCOL_VERSION,
      authPath,
    });

    // Ensure the session-review sidecar dir exists and watch it so a review
    // written by the `session_review` tool is reflected in the session list
    // (and thus the host UI) promptly. Best-effort: if watching fails, changes
    // are still picked up on the next any-cause `session.list.changed`.
    ensureReviewsDir();
    this.stopReviewWatcher = startReviewWatcher(() => {
      void this.emitSessionListChanged();
    });
  }

  private createRuntimeFactory() {
    return createRuntimeFactory(this.sdk, this.authStorage, this.startupCwd);
  }

  private resolveSessionPath(session: SdkSession): string | undefined {
    return session.sessionFile ?? session.sessionManager.getSessionFile();
  }

  private getSessionContext(sessionPath?: string): SessionContext | undefined {
    return sessionPath ? this.sessionContexts.get(sessionPath) : undefined;
  }

  private async createSessionContext(
    sessionManager: SdkSessionManager,
    reason: SessionContextCreationReason,
  ): Promise<SessionContext> {
    const context = await this.buildSessionContext({ sessionManager, reason });

    const existing = this.sessionContexts.get(context.sessionPath);
    if (existing) {
      context.busySeq = existing.busySeq;
      if (existing.terminalLiveTurn && existing.terminalLiveTurn.expiresAt > Date.now()) {
        context.terminalLiveTurn = existing.terminalLiveTurn;
      }
      const cleanup = (operation: string, action: () => void): void => {
        try {
          action();
        } catch (error) {
          backendWarn('backend-session', `replaced runtime ${operation} failed`, {
            sessionPath: context.sessionPath,
            error: toErrorMessage(error),
          });
        }
      };
      cleanup('watchdog cleanup', () => existing.willRetryWatchdogClear?.());
      cleanup('UI disposal', () => existing.uiBridge?.dispose());
      cleanup('unsubscribe', () => existing.unsubscribe());
      // A provider teardown can wedge the old runtime. The replacement becomes
      // authoritative immediately; old disposal is bounded best-effort and
      // must not block local recovery or the next send.
      let dispose: Promise<void>;
      try {
        dispose = Promise.resolve(existing.runtime.dispose());
      } catch (error) {
        backendWarn('backend-session', 'replaced runtime disposal failed', {
          sessionPath: context.sessionPath,
          error: toErrorMessage(error),
        });
        dispose = Promise.resolve();
      }
      let disposeGraceTimer: ReturnType<typeof setTimeout> | undefined;
      const disposeGrace = new Promise<void>((resolve) => {
        disposeGraceTimer = setTimeout(resolve, 5_000);
        disposeGraceTimer.unref?.();
      });
      void Promise.race([dispose, disposeGrace])
        .catch(() => undefined)
        .finally(() => {
          if (disposeGraceTimer) clearTimeout(disposeGraceTimer);
        });
    }

    this.sessionContexts.set(context.sessionPath, context);
    return context;
  }

  private async buildSessionContext(options: {
    sessionManager: SdkSessionManager;
    reason: SessionContextCreationReason;
  }): Promise<SessionContext> {
    return await timed('buildSessionContext', async () => {
      const { sessionManager, reason } = options;
      const previousSessionFile = this.viewedSessionPath;
      const runtime = await this.sdk.createAgentSessionRuntime(this.createRuntimeFactory(), {
        cwd: sessionManager.getCwd() || this.startupCwd,
        agentDir: this.agentDir,
        sessionManager,
        sessionStartEvent: previousSessionFile
          ? {
              type: 'session_start',
              reason,
              previousSessionFile,
            }
          : undefined,
      });

      const session = runtime.session;
      const sessionPath = this.resolveSessionPath(session);
      if (!sessionPath) {
        await runtime.dispose();
        throw new Error('The PI session did not expose a session path.');
      }

      const context: SessionContext = {
        runtime,
        session,
        sessionPath,
        unsubscribe: () => undefined,
        busySeq: 0,
        lastContextUsage: undefined,
      };

      // Wire the ExtensionUI bridge so extensions can ask questions through the webview.
      const uiBridge = new ExtensionUIBridge(context.sessionPath, (event, payload) => this.emit(event, payload));
      context.uiBridge = uiBridge;
      const extensionRunner = (session as unknown as { extensionRunner?: { setUIContext?: (ctx: unknown) => void } }).extensionRunner;
      if (extensionRunner?.setUIContext) {
        extensionRunner.setUIContext(uiBridge);
      }

      context.unsubscribe = session.subscribe((event: SdkSessionEvent) => {
        this.handleSessionEvent(context, event);
      });

      // Load persisted picker state before installing guards: both prompt
      // rebuilds and extension-driven tool changes consult this live set.
      const persistedDisabled = readSystemPromptTogglesForSession(sessionPath);
      context.systemPromptDisabledEntries = persistedDisabled;

      // The SDK rebuilds its base prompt whenever active tools or extension
      // resources change. Guard that synchronous rebuild so it cannot silently
      // restore entries the picker disabled.
      const promptState = this.getSessionPromptState(context);
      if (typeof promptState._rebuildSystemPrompt === 'function') {
        const { buildSystemPrompt } = await this.getSystemPromptModule();
        installSystemPromptToggleRebuildGuard(
          promptState,
          () => context.systemPromptDisabledEntries ?? [],
          buildSystemPrompt,
        );
      }
      installSystemPromptToolToggleGuard(
        session,
        () => context.systemPromptDisabledEntries ?? [],
      );

      // Disabling Tools controls both prompt prose and the provider's separate
      // tool-schema field. Capture the initial active set so a later re-enable
      // can restore it, including after reopening a persisted disabled session.
      if (persistedDisabled.includes(TOOLS_ENTRY_ID)) {
        context.systemPromptToolsBeforeDisable = session.getActiveToolNames?.()
          ?? session.getAllTools?.().map((tool) => tool.name)
          ?? [];
        session.setActiveToolsByName?.([]);
      }
      if (persistedDisabled.length > 0) {
        await this.applySystemPromptTogglesToBasePrompt(context, persistedDisabled);
      }

      return context;
    });
  }

  private async ensureSessionContext(sessionPath: string): Promise<SessionContext> {
    const existing = this.sessionContexts.get(sessionPath);
    if (existing) {
      if (existing.recoveryPromise) {
        try {
          return await existing.recoveryPromise;
        } catch (error) {
          throw new BackendError(
            'SESSION_RUNTIME_RECOVERY_FAILED',
            `The session runtime could not be replaced: ${toErrorMessage(error)}`,
          );
        }
      }
      if (existing.retired) {
        throw new BackendError(
          'SESSION_RUNTIME_RECOVERY_FAILED',
          `The session runtime for ${sessionPath} was retired without a replacement.`,
        );
      }
      return existing;
    }

    const pending = this.pendingSessionContexts.get(sessionPath);
    if (pending) {
      return await pending;
    }

    const creation = this.createSessionContext(this.sdk.SessionManager.open(sessionPath), 'resume');
    this.pendingSessionContexts.set(sessionPath, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingSessionContexts.get(sessionPath) === creation) {
        this.pendingSessionContexts.delete(sessionPath);
      }
    }
  }

  private ensureDisplayTranscriptCache(context: SessionContext) {
    const entries = (context.session.sessionManager.getBranch() ?? []) as SessionEntryLike[];
    if (isDisplayTranscriptCacheStale(context.displayTranscriptCache, entries)) {
      context.displayTranscriptCache = buildDisplayTranscriptCache(entries);
    }
    return context.displayTranscriptCache!;
  }

  private getPinnedStreamingMessageId(context: SessionContext): string | undefined {
    return context.activeRequest?.currentMessageId ?? context.activeRequest?.lastAssistantMessageId;
  }

  private async loadTranscriptPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
  ): Promise<TranscriptPagePayload> {
    const context = await this.ensureSessionContext(sessionPath);
    const cache = this.ensureDisplayTranscriptCache(context);
    const page = buildPagedTranscriptWindow(cache, {
      direction,
      loadedStart,
      loadedEnd,
      pinnedMessageId: this.getPinnedStreamingMessageId(context),
    });

    const busy = context.session.isStreaming || !!context.activeRequest;
    return {
      sessionPath: context.sessionPath,
      transcript: busy ? page.transcript : normalizeDanglingTranscript(page.transcript),
      transcriptWindow: page.transcriptWindow,
      busy,
    };
  }

  private resolveCurrentContextWindow(context: SessionContext): number | undefined {
    const sessionContextWindow = context.session.model?.contextWindow;
    if (
      typeof sessionContextWindow === 'number'
      && Number.isFinite(sessionContextWindow)
      && sessionContextWindow > 0
    ) {
      return Math.trunc(sessionContextWindow);
    }

    const currentModelId = context.session.model?.id;
    if (!currentModelId) {
      return undefined;
    }

    try {
      const models = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
      const model = models.find((candidate) => candidate.id === currentModelId);
      if (
        typeof model?.contextWindow === 'number'
        && Number.isFinite(model.contextWindow)
        && model.contextWindow > 0
      ) {
        return Math.trunc(model.contextWindow);
      }
    } catch (error) {
      // Ignore model registry issues and fall back to undefined.
      backendTrace('modelRegistry', 'contextWindowLookup.failed', { level: 'warn', error: toErrorMessage(error) });
    }

    return undefined;
  }

  private getContextUsage(context: SessionContext): ContextWindowUsage | undefined {
    // Derive `tokens` from the most recent assistant usage's prompt footprint
    // (input + cacheRead + cacheWrite) — the tokens that actually counted
    // against the context window on the last API call.
    //
    // We deliberately do NOT use the SDK's `getContextUsage().tokens`: that
    // value is `calculateContextTokens(lastUsage)` (= `totalTokens` = prompt
    // footprint + output) plus a chars/4 estimate of trailing in-progress
    // messages. Including output overstates window fill, and the trailing
    // estimate disagrees with the real usage that lands on completion, so the
    // indicator jumps ("doubling" / changing mid-turn and on completion).
    //
    // The prompt footprint is stable during a turn — it only steps forward
    // when a new assistant usage arrives — so the indicator reflects actual
    // window use consistently. `contextWindow` follows the active model.
    const contextWindow = this.resolveCurrentContextWindow(context);
    if (!contextWindow) {
      return undefined;
    }
    return deriveContextUsageFromBranch(
      context.session.sessionManager.getBranch(),
      contextWindow,
    );
  }

  private emitContextUsageChanged(context: SessionContext): void {
    const nextUsage = this.getContextUsage(context) ?? null;
    const previousUsage = context.lastContextUsage;
    const changed = previousUsage === undefined
      || (previousUsage === null
        ? nextUsage !== null
        : nextUsage === null
          || previousUsage.tokens !== nextUsage.tokens
          || previousUsage.contextWindow !== nextUsage.contextWindow
          || previousUsage.percent !== nextUsage.percent);

    if (!changed) {
      return;
    }

    context.lastContextUsage = nextUsage;
    this.emit('contextUsage.changed', {
      sessionPath: context.sessionPath,
      contextUsage: nextUsage,
    } satisfies ContextUsageChangedPayload);
  }

  private async getSystemPromptModule(): Promise<SdkSystemPromptModule> {
    this.systemPromptModulePromise ??= loadSdkInternalModule<SdkSystemPromptModule>(
      this.sdkPath,
      path.join('core', 'system-prompt.js'),
    );
    return await this.systemPromptModulePromise;
  }

  private getSessionPromptState(context: SessionContext): SessionPromptState {
    return context.session as SdkSession & SessionPromptState;
  }

  private async readHarnessSystemPrompt(context: SessionContext): Promise<string | undefined> {
    const promptState = this.getSessionPromptState(context);
    const options = promptState._baseSystemPromptOptions;
    if (!options) {
      const basePrompt = normalizePromptText(promptState._baseSystemPrompt);
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    }

    try {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      const basePrompt = normalizePromptText(buildSystemPrompt({
        cwd: options.cwd,
        selectedTools: options.selectedTools,
        toolSnippets: options.toolSnippets,
        promptGuidelines: options.promptGuidelines,
      }));
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    } catch (error) {
      backendTrace('systemPrompt', 'harnessRead.failed', { level: 'debug', error: toErrorMessage(error) });
      const basePrompt = normalizePromptText(promptState._baseSystemPrompt);
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    }
  }

  private async buildSystemPrompts(
    context: SessionContext,
    harnessPromptOverride?: string,
  ): Promise<SystemPromptEntry[]> {
    const promptState = this.getSessionPromptState(context);
    // Refresh the unfiltered-options snapshot from the SDK's live options
    // whenever they're at least as complete as what we cached (e.g. the SDK
    // rebuilt them after a tool/resource change). The display entry list is
    // then built from the snapshot so disabled option-driven entries (context
    // files, skills, append) stay present and re-toggleable instead of
    // vanishing once the live options are filtered for the model prompt.
    captureOriginalSystemPromptOptions(promptState);
    const promptOptions = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    const harnessPrompt = harnessPromptOverride ?? await this.readHarnessSystemPrompt(context);
    const tools = typeof context.session.getAllTools === 'function'
      ? context.session.getAllTools()
      : [];

    return buildSessionSystemPrompts({
      harnessPrompt,
      promptOptions,
      formatSkillsForPrompt: this.sdk.formatSkillsForPrompt,
      tools,
      activeProvider: resolveActiveModel(context),
      disabledEntries: context.systemPromptDisabledEntries,
    });
  }

  private async readModelSettings(): Promise<ModelSettings> {
    const defaults: ModelSettings = { defaultModel: '', defaultThinkingLevel: 'medium' };
    try {
      const raw = await fs.readFile(path.join(this.agentDir, 'settings.json'), 'utf8');
      const parsed = parseJsonOrThrow<Partial<ModelSettings>>(raw, 'settings.json');
      const result: ModelSettings = {
        defaultModel: parsed.defaultModel ?? defaults.defaultModel,
        defaultThinkingLevel: (parsed.defaultThinkingLevel as ThinkingLevel) ?? defaults.defaultThinkingLevel,
      };
      if (typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.length > 0) {
        result.defaultProvider = parsed.defaultProvider;
      }
      return result;
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
  private async applySystemPromptTogglesToBasePrompt(
    context: SessionContext,
    disabledEntries: readonly string[],
  ): Promise<void> {
    const promptState = this.getSessionPromptState(context);
    // Capture the unfiltered snapshot from the live options before we touch
    // them. On the first toggle the live options are still the SDK's unfiltered
    // set, so this is the moment the full entry set is recorded. On later
    // toggles the live options are already filtered; `capture...` only refreshes
    // the snapshot when the live set is a superset of the cached one, so a
    // filtered set never clobbers it.
    captureOriginalSystemPromptOptions(promptState);
    const source = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    if (!source) return;

    try {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      const toggled = buildToggledSystemPrompt(source, disabledEntries, buildSystemPrompt);
      // Empty is intentional and valid when every entry is disabled. Do not
      // use a truthiness check here or the prior full prompt survives.
      promptState._baseSystemPrompt = toggled.prompt;
      // Keep the structured options in sync so downstream extensions (e.g. the
      // skill-pruner `before_agent_start` hook) see the filtered skill/context
      // sets instead of re-adding stripped sections from the original options.
      promptState._baseSystemPromptOptions = toggled.options;
    } catch (error) {
      // Leave the existing base prompt untouched if the SDK builder is not
      // available; sending the previous known prompt is safer than a partial
      // regex-only rewrite.
      backendTrace('systemPrompt', 'harnessRebuild.failed', { level: 'debug', error: toErrorMessage(error) });
    }
  }

  /** Apply a new disabled-entry set for a session: update the SessionContext,
   *  persist to the sidecar, rewrite the base prompt. (Re-emitting
   *  `session.opened` is the caller's responsibility — the RPC handler does it
   *  after this resolves.) The `disabledEntries` array is the complete set. */
  async applySystemPromptToggles(
    sessionPath: string,
    disabledEntries: readonly string[],
  ): Promise<void> {
    const context = this.sessionContexts.get(sessionPath);
    if (!context) return;
    const next = [...new Set(disabledEntries)];
    const toolsWereDisabled = context.systemPromptDisabledEntries?.includes(TOOLS_ENTRY_ID) ?? false;
    const toolsWillBeDisabled = next.includes(TOOLS_ENTRY_ID);

    if (!toolsWereDisabled && toolsWillBeDisabled) {
      context.systemPromptToolsBeforeDisable = context.session.getActiveToolNames?.()
        ?? context.session.getAllTools?.().map((tool) => tool.name)
        ?? [];
    }

    // Update the live set before invoking setActiveToolsByName: the installed
    // guard consults it synchronously and prevents extensions from re-exposing
    // schemas while Tools is off.
    context.systemPromptDisabledEntries = next;
    if (!toolsWereDisabled && toolsWillBeDisabled) {
      context.session.setActiveToolsByName?.([]);
    } else if (toolsWereDisabled && !toolsWillBeDisabled) {
      const restore = context.systemPromptToolsBeforeDisable
        ?? context.session.getAllTools?.().map((tool) => tool.name)
        ?? [];
      context.session.setActiveToolsByName?.(restore);
      context.systemPromptToolsBeforeDisable = undefined;
    }

    writeSystemPromptTogglesForSession(sessionPath, next);
    await this.applySystemPromptTogglesToBasePrompt(context, next);
  }

  private async writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings> {
    const settingsPath = path.join(this.agentDir, 'settings.json');
    // Model updates run in the backend while pruning updates run in the
    // extension host. Share the same cross-process lock so their
    // read-modify-write cycles cannot silently overwrite each other.
    await updateSettingsJsonObject(settingsPath, (existing) => ({ ...existing, ...updates }));
    return await this.readModelSettings();
  }

  private async emitSessionOpened(sessionPath: string, selectionToken?: string): Promise<void> {
    if (!this.sessionContexts.has(sessionPath)) {
      return;
    }

    const payload = await this.buildSessionOpenedPayload(sessionPath, selectionToken);
    this.emit('session.opened', payload);
  }

  private async buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../shared/protocol').TranscriptMode,
  ): Promise<SessionOpenedPayload> {
    return await timed('buildSessionOpenedPayload', () => buildSessionOpenedPayloadHelper(sessionPath, {
      getContextUsage: (context) => this.getContextUsage(context),
      readHarnessSystemPrompt: (context) => this.readHarnessSystemPrompt(context),
      buildSystemPrompts: (context, override) => this.buildSystemPrompts(context, override),
      readModelSettings: () => this.readModelSettings(),
      getPinnedStreamingMessageId: (context) => this.getPinnedStreamingMessageId(context),
      getSessionContext: (path) => this.getSessionContext(path),
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
    }, selectionToken, transcript));
  }

  private async emitSessionListChanged(): Promise<void> {
    const payload: SessionListChangedPayload = {
      sessions: await listSessionSummaries(this.sdk),
      activeSessionPath: this.viewedSessionPath,
    };
    this.emit('session.list.changed', payload);
  }

  private emitBusyChanged(context: SessionContext, busy: boolean): void {
    context.busySeq += 1;
    const payload: BusyChangedPayload = {
      sessionPath: context.sessionPath,
      busy,
      seq: context.busySeq,
    };
    this.emit('busy.changed', payload);
  }

  private emit(event: string, payload?: unknown): void {
    if (event === 'extension_ui.request' && payload && typeof payload === 'object') {
      const request = payload as { sessionPath?: unknown; id?: unknown };
      if (typeof request.sessionPath === 'string' && typeof request.id === 'string') {
        const context = this.sessionContexts.get(request.sessionPath);
        const accumulator = context?.activeRequest?.liveTurnAccumulator;
        if (accumulator) {
          if (context?.activeRequest?.semanticLeaseTimer) {
            clearTimeout(context.activeRequest.semanticLeaseTimer);
            context.activeRequest.semanticLeaseTimer = undefined;
          }
          this.emit('live.semantic', accumulator.observe({
            kind: 'turn.extensionUi', uiRequestId: request.id, action: 'opened',
          }, Date.now()));
        }
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

  private async handleLine(line: string): Promise<void> {
    let request: RequestEnvelope;
    try {
      request = parseJsonOrThrow<RequestEnvelope>(line, 'request envelope');
    } catch (error) {
      writeStdout(responseError('parse-error', 'PARSE_ERROR', String(error)));
      return;
    }

    backendTrace('request', 'received', { id: request.id, method: request.method });
    try {
      const result = await timed(`request:${request.method}:${request.id}`, () => this.handleRequest(request));
      backendTrace('request', 'handled', { id: request.id, method: request.method });
      writeStdout(responseOk(request.id, result));
    } catch (error) {
      const details = extractRequestError(error);
      backendTrace('request', 'error', { level: 'warn', id: request.id, method: request.method, code: details.code, message: details.message });
      writeStdout(responseError(request.id, details.code, details.message, details.data));
      this.emit('error', details);
    }
  }

  private async handleRequest(request: RequestEnvelope): Promise<unknown> {
    return await handleBackendRequest({
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
      sdk: this.sdk,
      getSessionContext: (sessionPath) => this.getSessionContext(sessionPath),
      createSessionContext: (sessionManager, reason) => this.createSessionContext(sessionManager, reason),
      ensureSessionContext: (sessionPath) => this.ensureSessionContext(sessionPath),
      setViewedSessionPath: (sessionPath) => {
        this.viewedSessionPath = sessionPath;
      },
      buildSessionOpenedPayload: (sessionPath, selectionToken, transcript) => (
        this.buildSessionOpenedPayload(sessionPath, selectionToken, transcript)
      ),
      applySystemPromptToggles: (sessionPath, disabledEntries) => (
        this.applySystemPromptToggles(sessionPath, disabledEntries)
      ),
      loadTranscriptPage: (sessionPath, direction, loadedStart, loadedEnd) => (
        this.loadTranscriptPage(sessionPath, direction, loadedStart, loadedEnd)
      ),
      emit: (event, payload) => this.emit(event, payload),
      emitBusyChanged: (context, busy) => this.emitBusyChanged(context, busy),
      emitContextUsageChanged: (sessionContext) => this.emitContextUsageChanged(sessionContext),
      emitSessionListChanged: () => this.emitSessionListChanged(),
      listSessions: () => listSessionSummaries(this.sdk),
      listAvailableModels: (context) => listAvailableModels(context, this.agentDir),
      readModelSettings: () => this.readModelSettings(),
      writeModelSettings: (updates) => this.writeModelSettings(updates),
    }, request);
  }

  private handleSessionEvent(context: SessionContext, event: SdkSessionEvent): void {
    if (context.retired) return;
    handleSdkSessionEvent({
      emit: (name, payload) => this.emit(name, payload),
      emitBusyChanged: (sessionContext, busy) => this.emitBusyChanged(sessionContext, busy),
      emitContextUsageChanged: (sessionContext) => this.emitContextUsageChanged(sessionContext),
      emitSessionOpened: (sessionPath, selectionToken) => this.emitSessionOpened(sessionPath, selectionToken),
      emitSessionListChanged: () => this.emitSessionListChanged(),
      recoverStuckSession: (sessionContext, reason) => {
        void this.recoverStuckSession(sessionContext, reason);
      },
    }, context, event);
  }

  /**
   * Locally terminalize a stuck runtime immediately, then replace it without
   * waiting for provider teardown. The old runtime is fenced before any async
   * work so late SDK events cannot revive or terminalize the request twice.
   */
  private recoverStuckSession(context: SessionContext, reason: string): void {
    if (context.retired || context.recoveryPromise) return;
    const active = context.activeRequest;
    if (!active) {
      return;
    }

    const requestId = active.id;
    const messageId = active.lastAssistantMessageId ?? active.currentMessageId;
    context.retired = true;
    const bestEffort = (operation: string, action: () => void): void => {
      try {
        action();
      } catch (error) {
        backendWarn('backend-session', `stuck runtime ${operation} failed`, {
          sessionPath: context.sessionPath,
          requestId,
          error: toErrorMessage(error),
        });
      }
    };
    bestEffort('watchdog cleanup', () => context.willRetryWatchdogClear?.());
    context.willRetryWatchdogClear = undefined;
    if (active.promptSafetyTimer) clearTimeout(active.promptSafetyTimer);
    if (active.semanticLeaseTimer) clearTimeout(active.semanticLeaseTimer);
    active.promptSafetyTimer = undefined;
    active.semanticLeaseTimer = undefined;
    active.pendingDurableToolTerminals?.clear();
    active.aborted = true;
    if (active.liveTurnAccumulator) {
      context.terminalLiveTurn = {
        accumulator: active.liveTurnAccumulator,
        expiresAt: Date.now() + 10_000,
      };
    }
    context.activeRequest = undefined;
    bestEffort('UI disposal', () => context.uiBridge?.dispose());
    bestEffort('queue cleanup', () => { context.session.clearQueue(); });
    context.queuedLocalIds = [];
    bestEffort('retry abort', () => context.session.abortRetry?.());
    bestEffort('compaction abort', () => context.session.abortCompaction?.());
    bestEffort('branch-summary abort', () => context.session.abortBranchSummary?.());
    bestEffort('bash abort', () => context.session.abortBash?.());

    this.emit('message.aborted', {
      requestId,
      sessionPath: context.sessionPath,
      messageId,
      userInitiated: false,
      reason,
    } satisfies MessageAbortedPayload);

    let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = Promise.resolve()
      .then(() => context.session.abort())
      .then(
        () => 'settled' as const,
        (error) => {
          backendWarn('backend-session', 'stuck runtime abort failed', {
            sessionPath: context.sessionPath,
            requestId,
            error: toErrorMessage(error),
          });
          return 'failed' as const;
        },
      );
    const abortGrace = new Promise<'timeout'>((resolve) => {
      abortGraceTimer = setTimeout(() => resolve('timeout'), 5_000);
      abortGraceTimer.unref?.();
    });
    void Promise.race([abort, abortGrace]).then((outcome) => {
      if (abortGraceTimer) clearTimeout(abortGraceTimer);
      if (outcome === 'timeout') {
        backendWarn('backend-session', 'stuck runtime abort did not settle within grace', {
          sessionPath: context.sessionPath,
          requestId,
        });
      }
    });

    const replacementPromise = Promise.resolve()
      .then(() => this.createSessionContext(
        this.sdk.SessionManager.open(context.sessionPath),
        'resume',
      ))
      .then(async (replacement) => {
        this.emitBusyChanged(replacement, false);
        await Promise.allSettled([
          this.emitSessionOpened(replacement.sessionPath),
          this.emitSessionListChanged(),
        ]);
        return replacement;
      });
    context.recoveryPromise = replacementPromise;
    void replacementPromise.catch((error) => {
      this.emit('operational-error', {
        code: 'SESSION_RUNTIME_RECOVERY_FAILED',
        message: `Failed to replace the stuck session runtime: ${toErrorMessage(error)}`,
        sessionPath: context.sessionPath,
        requestId,
      });
    });
  }

  async dispose(): Promise<void> {
    const contexts = [...this.sessionContexts.values()];
    this.sessionContexts.clear();

    // Reject provider waiters and clear referenced queue/afterburn timers even
    // when an SDK runtime ignores abort during shutdown. The global fetch
    // wrapper is process-owned, so server disposal is its production teardown.
    ProviderGate.uninstall();

    this.stopReviewWatcher?.();
    this.stopReviewWatcher = undefined;
    this.stopProviderProgressObserver?.();
    this.stopProviderProgressObserver = undefined;

    for (const context of contexts) {
      context.willRetryWatchdogClear?.();
      context.uiBridge?.dispose();
      context.unsubscribe();
      await context.runtime.dispose();
    }
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
