import { EXTENSION_TOGGLES_ENV, HISTORY_COMPACTION_ENV, NESTED_ALLOWED_BUCKETS_ENV, PROVIDER_TOGGLES_ENV, PROTOCOL_VERSION, SUBAGENT_BUCKET_CAN_SPAWN_ENV, SUBAGENT_BUCKETS_ENV, SUBAGENT_PROVIDER_DEFAULTS_ENV, SUBAGENT_PROVIDER_TOGGLES_ENV, SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV, SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV, type ModelSettings, type RequestEnvelope } from '../shared/protocol';
import { AUTONOMOUS_MODE_ENV } from '../../../shared/autonomous-mode.js';
import { LIVE_PIPELINE_LIMITS } from '../shared/live-pipeline-protocol';
import {
  validateLiveTurnCheckpoint,
  validateRuntimePrefsSet,
  validateSessionPath,
  validateSettingsSet,
  validateSystemPromptTogglesSet,
  validateExtensionUiResponse,
  validateOpenTabsSet,
  validateMcpSetServerEnabled,
  validateMcpSetSessionServerEnabled,
} from './rpc';
import { ProviderGate } from './provider-gate';
import { listMcpServers, setMcpServerEnabled } from './mcp-config';
import { readSessionMcpOverrides, writeSessionMcpOverrides, type SessionMcpOverrides } from './mcp-session-config';
import { hasBillableSessionActivity } from './session-activity';
import { BackendLiveTurnAccumulator } from './live-turn-accumulator';
import { BackendError } from './server-io';
import {
  getBackendLivePipelineTraceHealth,
  recordBackendLivePipelineTrace,
  setBackendLivePipelineTraceEnabled,
} from './live-pipeline-trace-runtime';
import {
  type BackendRequestHandlerDeps,
  type RequestHandler,
  getCreateOperationLedger,
  markRequestValidated,
} from './request-handler-shared';
import { SESSION_REQUEST_HANDLERS } from './request-handler-session';
import { MESSAGE_REQUEST_HANDLERS } from './request-handler-message';

export {
  type BackendRequestHandlerDeps,
  type PromptSafetyTimerDecision,
  type SessionTransitionWaitOptions,
  type SessionTransitionWaitOutcome,
  type TranscriptPageLoadOptions,
  decidePromptSafetyTimerAction,
  formatInterruptWatchdogDuration,
  waitForSessionTransition,
} from './request-handler-shared';

function unknownMethodResponse(method: string): never {
  throw new BackendError('UNKNOWN_METHOD', `Unknown method: ${method}`);
}

async function handleAppPing(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  markRequestValidated(deps);
  return {
    sdkPath: deps.sdkPath,
    agentDir: deps.agentDir,
    sdkVersion: deps.sdk.VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };
}

async function handleMcpList(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  markRequestValidated(deps);
  const result: { servers: ReturnType<typeof listMcpServers>['servers']; overridePath: ReturnType<typeof listMcpServers>['overridePath']; sessionOverrides?: SessionMcpOverrides } = listMcpServers(deps.startupCwd);
  // Optional `sessionPath` hydration: reply with the session's persisted
  // override set so the webview can render a session-scoped effective list
  // (the toolbar's per-session surface) without a separate round trip.
  const rawSessionPath = (request.params as Record<string, unknown> | undefined)?.['sessionPath'];
  if (typeof rawSessionPath === 'string' && rawSessionPath.trim().length > 0) {
    result.sessionOverrides = await readSessionMcpOverrides(rawSessionPath.trim()) ?? {};
  }
  return result;
}

/** Persist a per-server `disabled` override into `.pi/mcp.json` via the
 *  adapter's own writer, then return the fresh effective list. The override
 *  applies on the next session reload / backend restart (the adapter re-reads
 *  config on every session start). */
async function handleMcpSetServerEnabled(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMcpSetServerEnabled(request.params);
  markRequestValidated(deps);
  return setMcpServerEnabled(deps.startupCwd, params.name, params.enabled);
}

/** Write the session's per-server override artifact (host state is the
 *  source of truth — the params carry the full desired set) and optionally
 *  recycle the session's worker so the adapter re-reads config at the next
 *  session start. A busy session is never retired; the response reports that
 *  so the host can keep a pending hint until the next idle recycle. */
async function handleMcpSetSessionServerEnabled(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMcpSetSessionServerEnabled(request.params);
  markRequestValidated(deps);
  await writeSessionMcpOverrides({
    sessionPath: params.sessionPath,
    agentDir: deps.agentDir,
    overrides: params.overrides,
  });
  let recycled = false;
  if (params.recycle) {
    try {
      recycled = await deps.recycleSessionRuntime?.(params.sessionPath, 'mcp session server override changed') ?? false;
    } catch {
      // A refusal (busy/transitioning worker) leaves application to the next
      // session reload / idle recycle; the host keeps its pending hint.
      recycled = false;
    }
  }
  return { recycled, overrides: params.overrides };
}

async function handleRuntimePrefsSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateRuntimePrefsSet(request.params);
  markRequestValidated(deps);
  process.env[PROVIDER_TOGGLES_ENV] = JSON.stringify(params.providerToggles);
  if (params.subagentProviderDefaults !== undefined) {
    process.env[SUBAGENT_PROVIDER_DEFAULTS_ENV] = JSON.stringify(params.subagentProviderDefaults);
  }
  if (params.subagentProviderTogglesBySession !== undefined) {
    process.env[SUBAGENT_PROVIDER_TOGGLES_ENV] = JSON.stringify(params.subagentProviderTogglesBySession);
  }
  process.env[EXTENSION_TOGGLES_ENV] = JSON.stringify(params.extensionToggles);
  if (params.autonomousMode !== undefined) {
    process.env[AUTONOMOUS_MODE_ENV] = params.autonomousMode ? '1' : '0';
    deps.setAutonomousMode(params.autonomousMode);
  }
  if (params.mcpEnabled !== undefined) {
    process.env['PIE_MCP_ENABLED'] = params.mcpEnabled ? '1' : '0';
  }
  if (params.historyCompaction !== undefined) {
    process.env[HISTORY_COMPACTION_ENV] = JSON.stringify(params.historyCompaction);
  }
  if (params.subagentAlwaysParentModel !== undefined) {
    process.env['PIE_SUBAGENT_ALWAYS_PARENT_MODEL'] = params.subagentAlwaysParentModel ? '1' : '0';
  }
  if (params.subagentRouteAroundSaturatedProviders !== undefined) {
    process.env[SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV] = params.subagentRouteAroundSaturatedProviders ? '1' : '0';
  }
  if (params.subagentFallbackOnProviderFailure !== undefined) {
    process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV] = params.subagentFallbackOnProviderFailure ? '1' : '0';
  }
  if (params.subagentMaxDepth !== undefined) {
    process.env['PIE_SUBAGENT_MAX_DEPTH'] = String(params.subagentMaxDepth);
  }
  if (params.subagentMaxTreeSessions !== undefined) {
    process.env['PIE_SUBAGENT_MAX_TREE_SESSIONS'] = String(params.subagentMaxTreeSessions);
  }
  if (params.subagentMaxInflight !== undefined) {
    process.env['PIE_SUBAGENT_MAX_INFLIGHT'] = String(params.subagentMaxInflight);
  }
  if (params.bashWarmPoolSize !== undefined) {
    process.env['PIE_BASH_WARM_POOL'] = String(params.bashWarmPoolSize);
  }
  if (params.bashFastPath !== undefined) {
    process.env['PIE_BASH_FAST_PATH'] = params.bashFastPath ? '1' : '0';
  }
  if (params.bashShellPath !== undefined) {
    process.env['PIE_SHELL'] = params.bashShellPath;
  }
  if (params.bashWarmupTimeoutMs !== undefined) {
    process.env['PIE_BASH_WARMUP_TIMEOUT_MS'] = String(params.bashWarmupTimeoutMs);
  }
  if (params.bashDefaultTimeout !== undefined) {
    process.env['PIE_BASH_DEFAULT_TIMEOUT'] = String(params.bashDefaultTimeout);
  }
  if (params.subagentBuckets !== undefined) {
    process.env[SUBAGENT_BUCKETS_ENV] = JSON.stringify(params.subagentBuckets);
  }
  if (params.subagentNestedAllowedBuckets !== undefined) {
    process.env[NESTED_ALLOWED_BUCKETS_ENV] = JSON.stringify(params.subagentNestedAllowedBuckets);
  }
  if (params.subagentBucketCanSpawn !== undefined) {
    process.env[SUBAGENT_BUCKET_CAN_SPAWN_ENV] = JSON.stringify(params.subagentBucketCanSpawn);
  }
  if (params.subagentDropTools !== undefined) {
    process.env['PIE_SUBAGENT_DROP_TOOLS_JSON'] = JSON.stringify(params.subagentDropTools);
  }
  // Reconfigure the live ProviderGate with user overrides. The gate merges
  // the overrides onto the models.json base configs and rebuilds the pools
  // in-place — no restart needed. Skipped when no overrides are provided.
  if (params.providerConcurrency !== undefined) {
    const gate = ProviderGate.getInstance();
    if (gate) {
      gate.applyUserOverrides(params.providerConcurrency);
    }
  }
  return params;
}

async function handleOpenTabsSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateOpenTabsSet(request.params);
  markRequestValidated(deps);
  if (deps.syncOpenTabsRegistry) {
    await deps.syncOpenTabsRegistry(params.tabs, params.revision);
  } else {
    // Compatibility path for standalone handler consumers. Production always
    // wires the coordinator sync callback above.
    const current = Number(process.env['PIE_OPEN_TABS_REVISION'] ?? 0);
    const currentRevision = Number.isSafeInteger(current) && current >= 0 ? current : 0;
    const nextRevision = params.revision ?? currentRevision + 1;
    if (nextRevision > currentRevision) {
      process.env['PIE_OPEN_TABS'] = JSON.stringify(params.tabs);
      process.env['PIE_OPEN_TABS_REVISION'] = String(nextRevision);
    }
  }
  return { ok: true, count: params.tabs.length };
}

/** `systemPromptToggles.set` — apply the complete disabled-entry set for a
 *  session: persist to the sidecar, rewrite the SDK base prompt, and re-emit
 *  `session.opened` so the webview's display entries + toggle menu reflect the
 *  new state. Returns `{ ok: true }`. */
async function handleSystemPromptTogglesSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSystemPromptTogglesSet(request.params);
  markRequestValidated(deps);
  const context = deps.getSessionContext(params.sessionPath);
  const cold = !context;
  if (context) {
    await deps.ensureSessionContext(params.sessionPath);
    await deps.applySystemPromptToggles(params.sessionPath, params.disabledEntries);
  } else if (deps.applyColdSystemPromptToggles) {
    await deps.applyColdSystemPromptToggles(params.sessionPath, params.disabledEntries);
  } else {
    throw new BackendError(
      'COLD_SESSION_SETTINGS_UNAVAILABLE',
      `Cold-session system-prompt persistence is unavailable for: ${params.sessionPath}`,
    );
  }
  const payload = await deps.buildSessionOpenedPayload(
    params.sessionPath,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    cold ? [...new Set(params.disabledEntries)] : undefined,
  );
  deps.emit('session.opened', payload);
  return { ok: true };
}

async function handleExtensionUiResponse(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateExtensionUiResponse(request.params);
  markRequestValidated(deps);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context?.uiBridge) {
    throw new BackendError('NO_UI_BRIDGE', `No UI bridge for session: ${params.sessionPath}`);
  }
  if (!context.uiBridge.resolveRequest(params.response)) {
    throw new BackendError('UI_REQUEST_NOT_PENDING', 'The extension UI request is no longer pending.');
  }
  const accumulator = context.activeRequest?.liveTurnAccumulator;
  if (accumulator) {
    deps.emit('live.semantic', accumulator.observe({
      kind: 'turn.extensionUi', uiRequestId: params.response.id, action: 'closed',
    }, Date.now()));
  }
  return { ok: true };
}

async function handleModelsList(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('models.list', request.params);
  markRequestValidated(deps);
  return await deps.listAvailableModels(deps.getSessionContext(params.sessionPath));
}

async function handleSettingsGet(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  markRequestValidated(deps);
  return await deps.readModelSettings();
}

async function handleSettingsSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSettingsSet(request.params);
  markRequestValidated(deps);
  const { sessionPath, ...rawUpdates } = params;
  const previousSettings = await deps.readModelSettings();
  // A hot session resolves its existing runtime and uses the SDK's live
  // setters. A cold session has no runtime, but still receives the exact same
  // durable Pi model/thinking entries through the coordinator-owned cold store.
  // This keeps the optimistic picker selection authoritative after hydration,
  // tab switches, worker promotion, and backend/VS Code restarts.
  const targetContext = sessionPath ? deps.getSessionContext(sessionPath) : undefined;
  // The picker sends `defaultModel` (bare id) + `defaultProvider` as separate
  // fields so models that exist under multiple providers (e.g. gpt-5.5 under
  // both github-copilot and openai-codex) can be routed unambiguously, and so
  // the SDK can restore the model on new sessions via
  // `modelRegistry.find(defaultProvider, defaultModel)`. When `defaultProvider`
  // is omitted (e.g. a thinking-level-only change), keep the current provider.
  const currentSessionModel = targetContext?.session.model;
  const currentProvider = currentSessionModel?.provider ?? previousSettings.defaultProvider;
  const currentId = currentSessionModel?.id ?? previousSettings.defaultModel;
  const requestedId = params.defaultModel ?? currentId;
  const requestedProvider = params.defaultProvider ?? currentProvider;
  const currentThinkingLevel = targetContext?.session.thinkingLevel ?? previousSettings.defaultThinkingLevel;
  const requestedThinkingLevel = params.defaultThinkingLevel ?? previousSettings.defaultThinkingLevel;
  // A model switch is any change to the id OR the provider (so switching
  // github-copilot/gpt-5.5 -> openai-codex/gpt-5.5 is detected even though the
  // id is identical).
  const isChangingModel = requestedId !== currentId || requestedProvider !== currentProvider;
  const isChangingThinkingLevel = params.defaultThinkingLevel !== undefined
    && requestedThinkingLevel !== currentThinkingLevel;
  let hasPersistedChanges = (params.defaultModel !== undefined
      && requestedId !== previousSettings.defaultModel)
    || (params.defaultProvider !== undefined
      && requestedProvider !== previousSettings.defaultProvider)
    || (params.defaultThinkingLevel !== undefined && requestedThinkingLevel !== previousSettings.defaultThinkingLevel);

  let coldModel: { provider: string; modelId: string } | undefined;
  const hasRequestedModelIdentity = params.defaultModel !== undefined
    || params.defaultProvider !== undefined;
  if (sessionPath && !targetContext && hasRequestedModelIdentity) {
    const available = await deps.listAvailableModels();
    const info = requestedProvider
      ? available.find((model) => model.provider === requestedProvider && model.id === requestedId)
      : available.find((model) => model.id === requestedId);
    if (!info) {
      throw new BackendError(
        'MODEL_UNAVAILABLE',
        `Model not available for this session: ${params.defaultModel ?? requestedId}`,
      );
    }
    coldModel = { provider: info.provider, modelId: info.id };
    // Older settings files may carry only the bare model id. Once the cold
    // catalog resolves an unambiguous provider, persist that identity too so a
    // future process never guesses among duplicate ids.
    if (params.defaultModel !== undefined
      && previousSettings.defaultProvider !== coldModel.provider) {
      hasPersistedChanges = true;
    }
  }

  // Persist the bare id + explicit provider (never a `provider/id` compound)
  // so the SDK's restore path resolves correctly on new sessions.
  const settingsUpdates: Partial<ModelSettings> = { ...rawUpdates };
  if (params.defaultModel !== undefined) {
    settingsUpdates.defaultModel = requestedId;
    const persistedProvider = coldModel?.provider ?? requestedProvider;
    if (persistedProvider) {
      settingsUpdates.defaultProvider = persistedProvider;
    } else {
      delete settingsUpdates.defaultProvider;
    }
  }

  if ((isChangingModel || isChangingThinkingLevel) && targetContext && hasBillableSessionActivity(targetContext)) {
    throw new BackendError('REQUEST_IN_PROGRESS', 'Cannot switch model or thinking level while this session has billable activity.');
  }

  const result = hasPersistedChanges
    ? await deps.writeModelSettings(settingsUpdates)
    : previousSettings;

  try {
    if (targetContext && (params.defaultModel !== undefined
      || params.defaultProvider !== undefined
      || params.defaultThinkingLevel !== undefined)) {
      if (isChangingModel) {
        const available = targetContext.runtime.services?.modelRegistry?.getAvailable() ?? [];
        const info = available.find((model) => model.provider === requestedProvider && model.id === requestedId)
          ?? available.find((model) => model.id === requestedId);
        if (!info) {
          throw new BackendError('MODEL_UNAVAILABLE', `Model not available in this session: ${params.defaultModel}`);
        }

        const resolvedModel = targetContext.runtime.services.modelRegistry.find(info.provider, info.id);
        if (!resolvedModel) {
          throw new BackendError('MODEL_UNAVAILABLE', `Could not resolve model in registry: ${params.defaultModel}`);
        }

        if (typeof targetContext.session.setModel !== 'function') {
          throw new BackendError('MODEL_SWITCH_UNSUPPORTED', 'This PI session does not support live model switching.');
        }

        await targetContext.session.setModel(resolvedModel);
        if (targetContext.session.model?.id !== requestedId || targetContext.session.model?.provider !== requestedProvider) {
          throw new BackendError('MODEL_SWITCH_FAILED', `Live model switch did not take effect: ${params.defaultModel}`);
        }
      }

      if (params.defaultThinkingLevel !== undefined && isChangingThinkingLevel) {
        targetContext.session.setThinkingLevel?.(params.defaultThinkingLevel);
      }

      // Re-emit a fresh context-usage reading immediately so the indicator
      // reflects the new model's context window with the same conversation,
      // instead of blanking to null (which previously made the indicator flip
      // to a tokenizer-based transcript estimate until the next turn).
      // emitContextUsageChanged resolves the new model's window and the last
      // assistant prompt footprint, and no-ops via change-detection when
      // nothing differs.
      if (isChangingModel || isChangingThinkingLevel) {
        deps.emitContextUsageChanged(targetContext);
      }
    } else if (sessionPath && (hasRequestedModelIdentity || params.defaultThinkingLevel !== undefined)) {
      if (!deps.applyColdSessionModelSettings) {
        throw new BackendError(
          'COLD_SESSION_SETTINGS_UNAVAILABLE',
          `Cold-session settings persistence is unavailable for: ${sessionPath}`,
        );
      }
      await deps.applyColdSessionModelSettings(sessionPath, {
        ...(coldModel ? { model: coldModel } : {}),
        ...(params.defaultThinkingLevel !== undefined
          ? { thinkingLevel: params.defaultThinkingLevel }
          : {}),
      });
    }

    return result;
  } catch (error) {
    // Roll back to the exact previous settings. defaultProvider must be
    // restored too (the merge-only writer can't otherwise drop a provider we
    // just added), and when it was previously absent we explicitly delete it
    // so the file returns to its prior shape rather than retaining `undefined`.
    const rollback: Partial<ModelSettings> = {
      defaultModel: previousSettings.defaultModel,
      defaultThinkingLevel: previousSettings.defaultThinkingLevel,
    };
    // Explicitly set defaultProvider (even to undefined) so the merge-only
    // writer drops a provider we just added when the previous state had none.
    rollback.defaultProvider = previousSettings.defaultProvider;
    if (hasPersistedChanges) await deps.writeModelSettings(rollback);
    throw error;
  }
}

/** Shared param parse for `diagnostics.livePipeline.setEnabled`. Returns the
 *  desired enablement for a well-formed request, or `undefined` when the
 *  params are not a valid boolean toggle. The handler rejects the undefined
 *  case with INVALID_PARAMS; the dispatch uses the same parse to place the
 *  toggle at the request boundary (see `handleBackendRequest`), and the
 *  server uses it to reserve the toggle generation at request receipt. */
export function parseLivePipelineToggleParams(params: unknown): { enabled: boolean } | undefined {
  const candidate = params && typeof params === 'object'
    ? params as Record<string, unknown>
    : undefined;
  return typeof candidate?.enabled === 'boolean' ? { enabled: candidate.enabled } : undefined;
}

async function handleLivePipelineTraceSetEnabled(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const toggle = parseLivePipelineToggleParams(request.params);
  if (!toggle) {
    throw new BackendError('INVALID_PARAMS', 'diagnostics.livePipeline.setEnabled requires boolean enabled.');
  }
  markRequestValidated(deps);
  // The toggle itself is applied by the dispatch at the request boundary —
  // before `route_selected` for an enable, after `handler_finished` for a
  // disable — so this request's own trace is recorded under the state it
  // establishes. Return only the desired enablement; the dispatch composes
  // the public `{ enabled, health }` response after the boundary application.
  return { enabled: toggle.enabled };
}

async function handleLiveTurnCheckpoint(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateLiveTurnCheckpoint(request.params);
  markRequestValidated(deps);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context) return { status: 'backend_restarted', checkpoint: null, watermark: null };
  const now = Date.now();
  if (context.terminalLiveTurn && context.terminalLiveTurn.expiresAt <= now) {
    context.terminalLiveTurn = undefined;
  }
  const activeAccumulator = context.activeRequest?.liveTurnAccumulator;
  const terminalAccumulator = context.terminalLiveTurn?.accumulator;
  const matchesRequestedAttempt = (accumulator: BackendLiveTurnAccumulator | undefined): accumulator is BackendLiveTurnAccumulator =>
    !!accumulator
      && (params.turnId === undefined
        || (accumulator.turnId === params.turnId && accumulator.attemptId === params.attemptId));
  const accumulator = params.turnId === undefined
    ? activeAccumulator ?? terminalAccumulator
    : matchesRequestedAttempt(activeAccumulator)
      ? activeAccumulator
      : matchesRequestedAttempt(terminalAccumulator)
        ? terminalAccumulator
        : undefined;
  if (!accumulator) return { status: 'inactive', checkpoint: null, watermark: null };
  const checkpoint = accumulator.checkpoint();
  let encodedBytes: number;
  try { encodedBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8'); }
  catch { return { status: 'oversize', checkpoint: null, watermark: accumulator.lifecycleWatermark() ?? null }; }
  const checkpointByteLimit = checkpoint.terminal
    ? LIVE_PIPELINE_LIMITS.terminalCheckpointBytes
    : LIVE_PIPELINE_LIMITS.checkpointBytes;
  if (encodedBytes > checkpointByteLimit
    || encodedBytes > checkpoint.checkpointBytes
    || checkpoint.turn.checkpointBytes !== checkpoint.checkpointBytes) {
    return { status: 'oversize', checkpoint: null, watermark: accumulator.lifecycleWatermark() ?? null };
  }
  if (getBackendLivePipelineTraceHealth().enabled) {
    recordBackendLivePipelineTrace({
      stage: 'backend.checkpoint.built', kind: 'success',
      identifiers: { session: params.sessionPath, request: checkpoint.turn.requestId, turn: checkpoint.turnId, attempt: checkpoint.attemptId },
      eventKind: 'checkpoint', eventSeq: checkpoint.checkpointSeq, snapshotBytes: encodedBytes,
    });
  }
  return {
    status: accumulator === activeAccumulator ? 'active' : 'terminal_grace',
    checkpoint,
    watermark: accumulator.lifecycleWatermark() ?? null,
  };
}

async function handleProviderGateMetrics(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  markRequestValidated(deps);
  // Isolated session workers perform provider I/O, so production injects the
  // coordinator lease authority's cross-worker metrics here. Standalone and
  // legacy consumers retain the in-process ProviderGate fallback.
  const authorityMetrics = deps.getProviderGateMetrics?.();
  if (authorityMetrics) {
    return { enabled: authorityMetrics.length > 0, providers: authorityMetrics };
  }
  const gate = ProviderGate.getInstance();
  if (!gate) return { enabled: false, providers: [] };
  return { enabled: true, providers: gate.getMetrics() };
}

const handlers: Record<string, RequestHandler> = {
  'app.ping': handleAppPing,
  'mcp.list': handleMcpList,
  'mcp.setServerEnabled': handleMcpSetServerEnabled,
  'mcp.setSessionServerEnabled': handleMcpSetSessionServerEnabled,
  'runtimePrefs.set': handleRuntimePrefsSet,
  ...SESSION_REQUEST_HANDLERS,
  ...MESSAGE_REQUEST_HANDLERS,
  'extension_ui.response': handleExtensionUiResponse,
  'openTabs.set': handleOpenTabsSet,
  'models.list': handleModelsList,
  'settings.get': handleSettingsGet,
  'settings.set': handleSettingsSet,
  'systemPromptToggles.set': handleSystemPromptTogglesSet,
  'provider_gate.metrics': handleProviderGateMetrics,
  'liveTurn.checkpoint': handleLiveTurnCheckpoint,
  'diagnostics.livePipeline.setEnabled': handleLivePipelineTraceSetEnabled,
};

/** Closed route catalog for settlement-coverage tests: every registered
 *  request method must record exactly one validation settlement and one
 *  completion (see the route-settlement test). */
export const BACKEND_REQUEST_METHODS: readonly string[] = Object.keys(handlers);

export async function handleBackendRequest(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const handler: RequestHandler | undefined = Object.prototype.hasOwnProperty.call(handlers, request.method)
    ? handlers[request.method]
    : undefined;
  const requestStartedAt = performance.now();
  // The server owns the completion span when it may retry a browse operation
  // (`suppressRequestTrace`) or when it already wired its own validation
  // callback; standalone callers get a self-contained span. Dispatch-level
  // phases below are always recorded at their real moments.
  const ownsCompletion = !deps.suppressRequestTrace && !deps.onRequestValidated;
  // The diagnostics toggle is applied at the request boundary, not inside the
  // handler, so the toggle request's own trace is coherent under the state it
  // establishes: an enable is applied BEFORE the first trace record (the
  // prefix would otherwise be dropped while the store is still disabled), and
  // a disable is applied AFTER the completion record (the completion would
  // otherwise be dropped once the store turns off). Invalid toggles parse to
  // `undefined` and never touch enablement.
  const toggleRequest = request.method === 'diagnostics.livePipeline.setEnabled'
    ? parseLivePipelineToggleParams(request.params)
    : undefined;
  if (toggleRequest?.enabled) {
    setBackendLivePipelineTraceEnabled(true);
    deps.onLivePipelineTraceEnabledChange?.(true);
  }
  // Dispatch selection: the route is chosen here, before any handler work.
  if (handler) {
    recordBackendLivePipelineTrace({
      stage: 'backend.request',
      kind: 'transition',
      phase: 'route_selected',
      identifiers: { request: request.id },
      processRole: 'coordinator',
      pid: process.pid,
    });
  }
  // Validation settlement: `request_validated` is emitted only after the
  // selected handler has actually validated its params (see
  // `markRequestValidated`), and `handler_started` denotes execution AFTER
  // validation — the settlement hook runs synchronously between the handler's
  // validator and its first await, so both records land at their real
  // moments. There is no general request queue, so no `handler_queued` phase
  // is claimed. A known route that throws before settling validation gets an
  // explicit `request_validated:failure` in the catch below, so no route can
  // silently lack a validation settlement.
  let validationSettled = false;
  const traceRequestValidated = (): void => {
    validationSettled = true;
    // The server owns the request span (retry-aware browse operations) and
    // wires its own once-per-request `request_validated` settlement.
    deps.onRequestValidated?.();
    if (ownsCompletion) {
      recordBackendLivePipelineTrace({
        stage: 'backend.request',
        kind: 'success',
        phase: 'request_validated',
        identifiers: { request: request.id },
        processRole: 'coordinator',
        pid: process.pid,
      });
    }
    recordBackendLivePipelineTrace({
      stage: 'backend.request',
      kind: 'start',
      phase: 'handler_started',
      identifiers: { request: request.id },
      processRole: 'coordinator',
      pid: process.pid,
    });
  };
  const handlerDeps = {
    ...deps,
    onRequestValidated: traceRequestValidated,
    // Resolve the fallback ledger against the ORIGINAL deps object: the
    // spread below is a fresh object per call, so keying the WeakMap by
    // `handlerDeps` would give every concurrent/retried request its own
    // ledger and silently break `operationId` dedupe. Carrying the
    // original-deps ledger through the spread keeps one ledger per deps
    // configuration while the handler still sees a wired ledger.
    createOperationLedger: getCreateOperationLedger(deps),
  };
  // Exactly one finish/error completion per request: the success record is
  // emitted only after the handler settles, and a failure record is never
  // emitted once a success record was already written.
  let completionEmitted = false;
  try {
    if (!handler) return unknownMethodResponse(request.method);
    const result = await handler(handlerDeps, request);
    if (ownsCompletion) {
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
    }
    if (toggleRequest && !toggleRequest.enabled) {
      // A production server can reserve this exact request id and finish the
      // transition after it emits handler_finished. The reserved generation
      // (captured at request receipt, before any awaited handler work) gates
      // the application: an older off settling after a newer on must not
      // disable tracing. Standalone callers have no completion boundary to
      // defer across, so they apply the disable here.
      const deferred = deps.deferLivePipelineTraceDisable?.(
        request.id,
        deps.livePipelineTraceToggleGeneration ?? 0,
        () => deps.onLivePipelineTraceEnabledChange?.(false),
      ) === true;
      if (!deferred) {
        setBackendLivePipelineTraceEnabled(false);
        deps.onLivePipelineTraceEnabledChange?.(false);
      }
    }
    if (toggleRequest) {
      // The handler returns only the desired enablement; compose the public
      // response here so `health` reflects the state AFTER the boundary
      // application (post-enable for off→on, post-disable for on→off).
      return { enabled: toggleRequest.enabled, health: getBackendLivePipelineTraceHealth() };
    }
    return result;
  } catch (error) {
    if (handler && !validationSettled) {
      // The selected route threw before its validation settlement: the
      // failure is parameter validation, recorded explicitly ahead of the
      // request's failure completion so a validation stall or invalid request
      // is distinguishable from a handler failure.
      recordBackendLivePipelineTrace({
        stage: 'backend.request',
        kind: 'failure',
        phase: 'request_validated',
        identifiers: { request: request.id },
        reasonCode: 'malformed_payload',
        processRole: 'coordinator',
        pid: process.pid,
      });
    }
    if (ownsCompletion && !completionEmitted) {
      recordBackendLivePipelineTrace({
        stage: 'backend.request',
        kind: 'failure',
        phase: 'handler_finished',
        durationMs: Math.max(0, performance.now() - requestStartedAt),
        identifiers: { request: request.id },
        reasonCode: 'unknown_unattributable',
        processRole: 'coordinator',
        pid: process.pid,
      });
    }
    throw error;
  }
}
