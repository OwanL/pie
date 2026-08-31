import type {
  ModelSettings,
  SessionAnalyticsFactors,
  SessionSkillFactor,
  ThinkingLevel,
} from '../../shared/protocol';
import {
  appendUnique,
  areStringArraysEqual,
  toActiveRunSummary,
  toPersistedSessionState,
} from './helpers';
import {
  createEmptyFileExtensionRollup,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
  normalizeExperimentAssignment,
  type PersistedSessionRunState,
  type RunFinalizationReason,
  type RunSnapshot,
  type TreatmentChangeKind,
  type FunctionalSettingsSnapshot,
  CURRENT_HARNESS_REVISION,
  deriveHarnessFingerprint,
} from '../run-analytics';
import {
  emptySessionRunState,
  type GetArchState,
  type DispatchArchEvent,
  type SessionRunState,
} from './types';

/**
 * Stable signature of the skills array EXCLUDING `lastModifiedAt`, so a skill
 * file's mtime changing without a content/source change does not flip the
 * `skills` treatment. Mirrors the redaction used for `skillSetHash`/
 * `promptHash` in `backend/session-analytics.ts`.
 */
function skillsKeyExcludingMtime(skills: SessionSkillFactor[]): string {
  return JSON.stringify(
    [...skills]
      .map((skill) => ({
        name: skill.name,
        contentHash: skill.contentHash,
        sourceHash: skill.sourceHash,
        disableModelInvocation: skill.disableModelInvocation,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

interface SessionRunStateManagerOptions {
  getArchState: GetArchState;
  dispatchArchEvent: DispatchArchEvent;
  schedulePersist: (snapshotToAppend?: RunSnapshot) => void;
  now: () => Date;
  createId: () => string;
  getExperimentAssignment: () => string | null;
}

export class SessionRunStateManager {
  readonly sessions = new Map<string, SessionRunState>();
  private readonly getArchState: GetArchState;
  private readonly dispatchArchEvent: DispatchArchEvent;
  private readonly schedulePersistCallback: SessionRunStateManagerOptions['schedulePersist'];
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly getExperimentAssignment: () => string | null;

  constructor(options: SessionRunStateManagerOptions) {
    this.getArchState = options.getArchState;
    this.dispatchArchEvent = options.dispatchArchEvent;
    this.schedulePersistCallback = options.schedulePersist;
    this.now = options.now;
    this.createId = options.createId;
    this.getExperimentAssignment = options.getExperimentAssignment;
  }

  restore(checkpointSessions: Record<string, PersistedSessionRunState>): void {
    this.sessions.clear();
    for (const [sessionPath, sessionState] of Object.entries(checkpointSessions)) {
      this.sessions.set(sessionPath, {
        currentRun: sessionState.currentRun,
        lastRun: sessionState.lastRun,
        nextTaskIntent: sessionState.nextTaskIntent,
        queuedUnsupportedInputCount: sessionState.queuedUnsupportedInputCount,
        turnIdsSeenInCurrentRun: new Set<string>(),
        endedTurnIdsInCurrentRun: new Set<string>(),
        startedToolCallIdsInCurrentRun: new Set<string>(),
        finishedToolCallIdsInCurrentRun: new Set<string>(),
        toolNamesByCallIdInCurrentRun: new Map<string, string>(),
        toolExecutionIntervalsInCurrentRun: [],
        busyStartedAt: sessionState.busyStartedAt,
      });
      this.syncSessionSummary(sessionPath);
    }
  }

  serializeSessions(): Record<string, PersistedSessionRunState> {
    const sessions: Record<string, PersistedSessionRunState> = {};
    for (const [sessionPath, state] of this.sessions) {
      sessions[sessionPath] = toPersistedSessionState(state);
    }
    return sessions;
  }

  getOrCreateSessionState(sessionPath: string): SessionRunState {
    let state = this.sessions.get(sessionPath);
    if (!state) {
      state = emptySessionRunState();
      this.sessions.set(sessionPath, state);
    }
    return state;
  }

  getMostRelevantRun(sessionPath: string): RunSnapshot | null {
    const state = this.sessions.get(sessionPath);
    if (!state) {
      return null;
    }
    return state.currentRun ?? state.lastRun;
  }

  createRunSnapshot(sessionPath: string, state: SessionRunState): RunSnapshot {
    const nowIso = this.isoNow();
    const currentConfig = this.getCurrentModelConfig(sessionPath);
    const shouldStartNewTaskGroup = state.nextTaskIntent === 'new_task' || !state.lastRun?.taskGroupId;
    const sessionSummary = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath);
    const stableSessionId = sessionSummary?.identityFallback === true
      ? undefined
      : sessionSummary?.sessionId?.trim() || undefined;
    const analyticsFactors = this.getCurrentAnalyticsFactors(sessionPath);
    const functionalSettings = this.getCurrentFunctionalSettings();

    return {
      sessionPath,
      ...(stableSessionId ? { sessionId: stableSessionId } : {}),
      runId: this.createId(),
      taskGroupId: shouldStartNewTaskGroup ? this.createId() : (state.lastRun?.taskGroupId ?? this.createId()),
      status: 'open',
      startedAt: nowIso,
      updatedAt: nowIso,
      modelId: currentConfig.modelId,
      provider: currentConfig.provider,
      thinkingLevel: currentConfig.thinkingLevel,
      mixedModelConfig: false,
      mixedTreatmentConfig: false,
      treatmentChangeKinds: [],
      experimentAssignment: normalizeExperimentAssignment(this.getExperimentAssignment()),
      analyticsFactors,
      functionalSettings,
      harnessRevision: CURRENT_HARNESS_REVISION,
      harnessFingerprint: deriveHarnessFingerprint(CURRENT_HARNESS_REVISION, analyticsFactors, functionalSettings),
      userInputCharSamples: [],
      sendCount: 0,
      // Presence (zeros included) marks this run as ask_user-outcome-tracked;
      // legacy snapshots without the fields stay untracked rather than zero.
      askUserAnsweredCount: 0,
      askUserCancelledCount: 0,
      assistantTurnCount: 0,
      assistantTurnDurationMs: 0,
      busyDurationMs: 0,
      busyPeriodCount: 0,
      interruptedCount: 0,
      messageEditCount: 0,
      truncatedAfterCount: 0,
      compactionCount: 0,
      autoRetryCount: 0,
      retryTimingSamples: [],
      subagentAttemptSamples: [],
      unknownSubagentAttemptRecordSourceIds: [],
      backendErrorCodes: [],
      contextTokens: null,
      contextLimit: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      auxiliaryLlmUsage: [],
      tokenReportedTurnCount: 0,
      lastTurnUsage: null,
      turnThroughputSamples: [],
      filesystemPathRefCount: 0,
      imageInputCount: 0,
      imageInputBytes: 0,
      unsupportedInputCount: 0,
      inputKindsUsed: [],
      toolUsage: createEmptyToolUsageRollup(),
      fileMutation: createEmptyFileMutationRollup(),
      fileExtensions: createEmptyFileExtensionRollup(),
      verification: createEmptyVerificationRollup(),
    };
  }

  finalizeCurrentRun(
    sessionPath: string,
    reason: RunFinalizationReason,
  ): RunSnapshot | null {
    const state = this.sessions.get(sessionPath);
    const currentRun = state?.currentRun;
    if (!state || !currentRun) {
      return null;
    }

    this.closeBusyInterval(state);

    const finalizedAt = this.isoNow();
    const finalizedRun: RunSnapshot = {
      ...currentRun,
      status: 'closed',
      finalizationReason: reason,
      finalizedAt,
      updatedAt: finalizedAt,
    };

    state.currentRun = null;
    state.lastRun = finalizedRun;
    state.turnIdsSeenInCurrentRun.clear();
    state.endedTurnIdsInCurrentRun.clear();
    state.startedToolCallIdsInCurrentRun.clear();
    state.finishedToolCallIdsInCurrentRun.clear();
    state.toolNamesByCallIdInCurrentRun.clear();
    state.toolExecutionIntervalsInCurrentRun = [];
    state.busyStartedAt = null;

    this.syncSessionSummary(sessionPath);
    this.persist(finalizedRun);
    return finalizedRun;
  }

  markTreatmentChanges(run: RunSnapshot, kinds: TreatmentChangeKind[]): void {
    if (kinds.length === 0) {
      return;
    }

    run.mixedTreatmentConfig = true;
    run.treatmentChangeKinds = appendUnique(run.treatmentChangeKinds, kinds);
  }

  diffAnalyticsFactors(
    current: SessionAnalyticsFactors,
    next: SessionAnalyticsFactors,
  ): TreatmentChangeKind[] {
    const changedKinds: TreatmentChangeKind[] = [];

    const promptChanged =
      current.harnessPromptHash !== next.harnessPromptHash
      || current.customPromptHash !== next.customPromptHash
      || current.appendSystemPromptHash !== next.appendSystemPromptHash
      || !areStringArraysEqual(current.promptGuidelineHashes, next.promptGuidelineHashes)
      || JSON.stringify(current.contextFiles) !== JSON.stringify(next.contextFiles);
    if (promptChanged) {
      changedKinds.push('prompt');
    }

    const toolsChanged =
      current.toolSetHash !== next.toolSetHash
      || !areStringArraysEqual(current.selectedToolIds, next.selectedToolIds)
      || JSON.stringify(current.toolSnippetHashes) !== JSON.stringify(next.toolSnippetHashes);
    if (toolsChanged) {
      changedKinds.push('toolSelection');
    }

    // Compare skills excluding `lastModifiedAt`: a skill file's mtime can change
    // (git checkout, touch, no-op save) without altering model-visible content,
    // and `skillSetHash`/`promptHash` already exclude it (see session-analytics).
    // Including mtime here would spuriously flag the `skills` treatment as changed.
    const skillsChanged =
      current.skillSetHash !== next.skillSetHash
      || skillsKeyExcludingMtime(current.skills) !== skillsKeyExcludingMtime(next.skills);
    if (skillsChanged) {
      changedKinds.push('skills');
    }

    const extensionsChanged =
      !areStringArraysEqual(current.activeExtensions, next.activeExtensions);
    if (extensionsChanged) {
      changedKinds.push('extensions');
    }

    return changedKinds;
  }

  closeBusyInterval(state: SessionRunState): boolean {
    const run = state.currentRun;
    if (!run || !state.busyStartedAt) {
      state.busyStartedAt = null;
      return false;
    }

    const startedAtMs = Date.parse(state.busyStartedAt);
    const endMs = this.now().getTime();
    if (Number.isFinite(startedAtMs)) {
      run.busyDurationMs += Math.max(0, endMs - startedAtMs);
    }
    state.busyStartedAt = null;
    return true;
  }

  private getCurrentModelConfig(sessionPath: string): {
    modelId: string | undefined;
    provider: string | undefined;
    thinkingLevel: ThinkingLevel | undefined;
  } {
    const archState = this.getArchState();
    const session = archState.sessions.sessions.find((s) => s.path === sessionPath);
    const modelSettings: ModelSettings | null = archState.settings.modelSettings;
    return {
      modelId: session?.modelId ?? modelSettings?.defaultModel,
      // Session summaries retain the provider selected for their model. This
      // must win over the global default for IDs served by both Codex/Copilot.
      provider: session?.provider ?? modelSettings?.defaultProvider,
      thinkingLevel: session?.thinkingLevel ?? modelSettings?.defaultThinkingLevel,
    };
  }

  private getCurrentAnalyticsFactors(sessionPath: string): SessionAnalyticsFactors | null {
    return this.getArchState().sessions.analyticsFactorsBySession[sessionPath] ?? null;
  }

  /**
  * Snapshot the functional (behavioral) settings in effect when the run started.
  * `pruningSettings` and `prefs` are always present on `SettingsState` (they
  * default via `DEFAULT_PRUNING_SETTINGS` / `resolveChatPrefs`), so this always
  * returns a value for freshly-captured runs; `null` only appears for records
  * loaded from disk that predate the field (handled by coercion).
  */
  private getCurrentFunctionalSettings(): FunctionalSettingsSnapshot {
    const settings = this.getArchState().settings;
    const trp = settings.toolResultPruningSettings;
    return {
      subagentAlwaysParentModel: settings.prefs.subagentAlwaysParentModel === true,
      pruningMode: settings.pruningSettings.mode,
      extensionToggles: { ...(settings.prefs.extensionToggles ?? {}) },
      toolResultPruningEnabled: trp.enabled,
      toolResultPruningProfile: trp.profile,
    };
  }

  syncSessionSummary(sessionPath: string): void {
    const state = this.sessions.get(sessionPath);
    const summary = toActiveRunSummary(
      state?.currentRun ?? state?.lastRun ?? null,
      state?.nextTaskIntent === 'new_task',
    );
    this.dispatchArchEvent({
      kind: 'ActiveRunSummaryChanged',
      sessionPath,
      summary,
    });
  }

  persist(snapshotToAppend?: RunSnapshot): void {
    this.schedulePersistCallback(snapshotToAppend);
  }

  isoNow(): string {
    return this.now().toISOString();
  }
}
