import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { attachJsonlLineReader } from '../shared/jsonl';
import { toErrorMessage, parseJsonOrThrow } from '../shared/error-message';
import {
  PROTOCOL_VERSION,
  type BusyChangedPayload,
  type ContextUsageChangedPayload,
  type ContextWindowUsage,
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
import {
  loadSdk,
  loadSdkInternalModule,
  type SdkModule,
  type SdkSession,
  type SdkSessionEvent,
  type SdkSessionManager,
  type SdkSystemPromptModule,
} from './sdk';
import { extractRequestError, responseError, responseOk, writeStdout } from './server-io';
import {
  type SessionContext,
  type SessionContextCreationReason,
  type SessionPromptState,
} from './server-types';
import {
  buildSessionSystemPrompts,
  normalizePromptText,
} from './system-prompts';
import {
  buildDisplayTranscriptCache,
  buildPagedTranscriptWindow,
  isDisplayTranscriptCacheStale,
} from './transcript-window';
import type { SessionEntryLike } from './transcript';
import { createRuntimeFactory } from './runtime-factory.js';
import { buildSessionOpenedPayload as buildSessionOpenedPayloadHelper } from './session-opened.js';

function backendTrace(scope: string, event: string, payload: Record<string, unknown> = {}): void {
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: `backend-${scope}`,
    event,
    ...payload,
  };
  console.warn(`[pie:backend] ${JSON.stringify(record)}`);
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
          backendTrace('timing', 'op.failed', { label, durationMs: Date.now() - start, error: toErrorMessage(error) });
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
    backendTrace('timing', 'op.failed', { label, durationMs: Date.now() - start, error: toErrorMessage(error) });
    throw error;
  }
}

export class BackendServer {
  private sdk!: SdkModule;
  private readonly sdkPath: string;
  private readonly startupCwd: string;
  private agentDir = '';
  private authStorage: unknown;
  private viewedSessionPath?: string;
  private readonly sessionContexts = new Map<string, SessionContext>();
  private systemPromptModulePromise?: Promise<SdkSystemPromptModule>;

  constructor(options: { sdkPath: string; cwd: string }) {
    this.sdkPath = options.sdkPath;
    this.startupCwd = options.cwd;
  }

  async start(): Promise<void> {
    await timed('start.loadSdk', async () => {
      this.sdk = await loadSdk(this.sdkPath);
      this.agentDir = this.sdk.getAgentDir();
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
      existing.unsubscribe();
      await existing.runtime.dispose();
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

      return context;
    });
  }

  private async ensureSessionContext(sessionPath: string): Promise<SessionContext> {
    const existing = this.sessionContexts.get(sessionPath);
    if (existing) {
      return existing;
    }

    return await this.createSessionContext(this.sdk.SessionManager.open(sessionPath), 'resume');
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

    return {
      sessionPath: context.sessionPath,
      transcript: page.transcript,
      transcriptWindow: page.transcriptWindow,
      busy: context.session.isStreaming || !!context.activeRequest,
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
    } catch {
      // Ignore model registry issues and fall back to undefined.
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
      return normalizePromptText(promptState._baseSystemPrompt);
    }

    try {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      return normalizePromptText(buildSystemPrompt({
        cwd: options.cwd,
        selectedTools: options.selectedTools,
        toolSnippets: options.toolSnippets,
        promptGuidelines: options.promptGuidelines,
      }));
    } catch {
      return normalizePromptText(promptState._baseSystemPrompt);
    }
  }

  private async buildSystemPrompts(
    context: SessionContext,
    harnessPromptOverride?: string,
  ): Promise<SystemPromptEntry[]> {
    const promptState = this.getSessionPromptState(context);
    const harnessPrompt = harnessPromptOverride ?? await this.readHarnessSystemPrompt(context);
    const tools = typeof context.session.getAllTools === 'function'
      ? context.session.getAllTools()
      : [];

    return buildSessionSystemPrompts({
      harnessPrompt,
      promptOptions: promptState._baseSystemPromptOptions,
      formatSkillsForPrompt: this.sdk.formatSkillsForPrompt,
      tools,
      activeProvider: resolveActiveModel(context),
    });
  }

  private async readModelSettings(): Promise<ModelSettings> {
    const defaults: ModelSettings = { defaultModel: '', defaultThinkingLevel: 'medium' };
    try {
      const raw = await fs.readFile(path.join(this.agentDir, 'settings.json'), 'utf8');
      const parsed = parseJsonOrThrow<Partial<ModelSettings>>(raw, 'settings.json');
      return {
        defaultModel: parsed.defaultModel ?? defaults.defaultModel,
        defaultThinkingLevel: (parsed.defaultThinkingLevel as ThinkingLevel) ?? defaults.defaultThinkingLevel,
      };
    } catch {
      return defaults;
    }
  }

  private async writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings> {
    const settingsPath = path.join(this.agentDir, 'settings.json');
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      existing = parseJsonOrThrow<Record<string, unknown>>(raw, settingsPath);
    } catch {
      // may not exist yet
    }
    const merged = { ...existing, ...updates };
    await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
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
      backendTrace('request', 'error', { id: request.id, method: request.method, code: details.code, message: details.message });
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
    handleSdkSessionEvent({
      emit: (name, payload) => this.emit(name, payload),
      emitBusyChanged: (sessionContext, busy) => this.emitBusyChanged(sessionContext, busy),
      emitContextUsageChanged: (sessionContext) => this.emitContextUsageChanged(sessionContext),
      emitSessionOpened: (sessionPath, selectionToken) => this.emitSessionOpened(sessionPath, selectionToken),
      emitSessionListChanged: () => this.emitSessionListChanged(),
    }, context, event);
  }

  async dispose(): Promise<void> {
    const contexts = [...this.sessionContexts.values()];
    this.sessionContexts.clear();

    for (const context of contexts) {
      context.unsubscribe();
      await context.runtime.dispose();
    }
  }
}
