import type { CustomMessagePayload } from '../shared/protocol';
import { createOperationalIncident } from '../shared/incidents.js';
import type { TurnSemanticEnvelope } from '../shared/live-pipeline-protocol';
import type { SdkSessionEvent } from './sdk';
import type { BackendSemanticCandidate } from './live-turn-accumulator';
import type { SessionContext } from './server-types';
import type { SubagentDetailAddressRoot } from './tool-progress-normalizer';
import { mapCustomMessage, type SessionEntryLike } from './transcript';
import { backendLog, type BackendLogLevel } from './log';
import { isBackendLivePipelineTraceEnabled, recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';

/** Emit a structured `backend-session` diagnostic line via the shared backend
 *  logger (explicit `level` field → host reads severity from the structured
 *  field instead of guessing from line text). */
export function logBackendDiagnostic(level: BackendLogLevel, event: string, data: Record<string, unknown>): void {
  backendLog(level, 'backend-session', event, data);
}
export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Coerce an untrusted SDK token metric to a non-negative integer. */
export function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

const DEFAULT_UNEXPECTED_INTERRUPT_REASON =
  'The session stopped unexpectedly before the assistant finished responding.';

export function resolveUnexpectedInterruptReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_UNEXPECTED_INTERRUPT_REASON;
}

export function clearSettledProviderIncident(context: SessionContext): void {
  const active = context.activeRequest;
  if (!active) return;
  active.latestProviderIncident = undefined;
}
export interface BackendSessionEventHandlerDeps {
  emit(event: string, payload?: unknown): void;
  /** Process fences attached to full-agent settlement by isolated workers. */
  backendGeneration?: number;
  workerGeneration?: number;
  emitBusyChanged(
    context: SessionContext,
    busy: boolean,
    capabilities?: import('../shared/protocol').SessionCapabilities,
  ): void;
  emitContextUsageChanged(context: SessionContext, postCompactionEstimatedTokens?: number): void;
  emitSessionOpened(sessionPath: string, selectionToken?: string): Promise<void>;
  emitSessionListChanged(): Promise<void>;
  observeSubagentDetail?(root: SubagentDetailAddressRoot, details: unknown): void;
  terminalizeSubagentDetail?(root: SubagentDetailAddressRoot, durableEntryId: string): void;
}
export function emitLatestPruningResult(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  finalAttempt = false,
): void {
  const active = context.activeRequest;
  if (!active || active.pruningResultLookupComplete || active.emittedPruningResultEntryId) return;
  const branch = (context.session.sessionManager?.getBranch?.() ?? []) as SessionEntryLike[];
  let entry: SessionEntryLike | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const candidate = branch[index];
    if (candidate.type === 'custom_message' && candidate.customType === 'pruning-result') {
      entry = candidate;
      break;
    }
  }
  if (!entry) {
    if (finalAttempt) active.pruningResultLookupComplete = true;
    return;
  }
  // Do not replay the previous turn's summary while the current prepass is
  // still running and its custom entry has not been appended yet.
  const entryTimestamp = Date.parse(entry.timestamp);
  if (active.turnBoundaryAt !== undefined && Number.isFinite(entryTimestamp) && entryTimestamp < active.turnBoundaryAt) {
    if (finalAttempt) active.pruningResultLookupComplete = true;
    return;
  }
  const message = mapCustomMessage(entry.id, {
    content: entry.content,
    timestamp: entry.timestamp,
    customType: entry.customType,
    display: entry.display,
    details: entry.details,
  });
  if (!message) {
    if (finalAttempt) active.pruningResultLookupComplete = true;
    return;
  }
  active.emittedPruningResultEntryId = entry.id;
  active.pruningResultLookupComplete = true;
  deps.emit('message.custom', {
    requestId: active.id,
    ...(active.operationId ? { operationId: active.operationId } : {}),
    sessionPath: context.sessionPath,
    message,
  } satisfies CustomMessagePayload);
}

export function emitSemanticCandidate(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  candidate: BackendSemanticCandidate,
  occurredAt = Date.now(),
): TurnSemanticEnvelope | undefined {
  const accumulator = context.activeRequest?.liveTurnAccumulator;
  if (!accumulator) return undefined;
  const mappingStartedAt = performance.now();
  const envelope = accumulator.observe(candidate, occurredAt);
  if (isBackendLivePipelineTraceEnabled()) {
    const canonical = envelope as (Record<string, unknown> & {
      kind?: string;
      turnId?: string;
      attemptId?: string;
      executionId?: string;
      seq?: number;
      progressRevision?: number;
      previewBytes?: number;
    }) | undefined;
    recordBackendLivePipelineTrace({
      stage: canonical?.kind === 'observation.rejected' ? 'backend.observation.rejected' : 'backend.mapped',
      kind: canonical ? (canonical.kind === 'observation.rejected' ? 'rejected' : 'success') : 'false',
      phase: 'backend_mapping',
      durationMs: Math.max(0, performance.now() - mappingStartedAt),
      identifiers: {
        session: context.sessionPath,
        ...(context.activeRequest?.id ? { request: context.activeRequest.id } : {}),
        ...(canonical?.turnId ? { turn: canonical.turnId } : {}),
        ...(canonical?.attemptId ? { attempt: canonical.attemptId } : {}),
        ...(canonical?.executionId ? { tool: canonical.executionId } : {}),
      },
      eventKind: canonicalTraceEventKind(candidate.kind),
      eventSeq: canonical?.seq,
      checkpointSeq: canonical?.seq,
      revision: canonical?.progressRevision,
      toolStateRevision: canonical?.progressRevision,
      snapshotBytes: canonical?.previewBytes,
      processRole: 'coordinator',
      pid: process.pid,
    });
  }
  if (!envelope) return undefined;
  deps.emit('live.semantic', envelope);
  if (envelope.kind === 'observation.rejected' && envelope.reason === 'payload_oversize') {
    logBackendDiagnostic('warn', 'semantic.payloadOversize', { candidateKind: candidate.kind });
    const active = context.activeRequest;
    deps.emit('operational-error', createOperationalIncident({
      incidentId: `turn-too-large:${active?.id ?? context.sessionPath}`,
      dedupeKey: `turn-too-large:${context.sessionPath}:${active?.id ?? 'session'}`,
      code: 'TURN_TOO_LARGE',
      message: 'The active response exceeded the bounded live-pipeline record limit and was interrupted.',
      detail: 'The bounded live-pipeline checkpoint rejected the response because its size limit was exceeded.',
      sessionPath: context.sessionPath,
      ...(active?.operationId ? { operationId: active.operationId } : {}),
      ...(active?.id ? { requestId: active.id } : {}),
      ...(active?.liveTurnAccumulator ? { turnId: active.liveTurnAccumulator.turnId } : {}),
      ...(active?.currentMessageId ?? active?.lastAssistantMessageId
        ? { messageId: active.currentMessageId ?? active.lastAssistantMessageId }
        : {}),
      severity: 'error',
      certainty: 'definitive',
      phase: 'runtime',
      recovery: { showLogs: true },
    }));
    void context.session.abort().catch(() => undefined);
  }
  return envelope;
}
export function emitRejectedObservation(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  reason: 'unsupported_observation' | 'malformed_observation' | 'malformed_payload' | 'owner_missing',
): void {
  const accumulator = context.activeRequest?.liveTurnAccumulator;
  if (accumulator) deps.emit('live.semantic', accumulator.reject(reason, Date.now()));
}
export function sdkTracePhase(eventType: string) {
  if (eventType.startsWith('tool_execution')) return 'tool_execution' as const;
  if (eventType.includes('retry')) return 'retry_backoff' as const;
  return 'semantic_stream' as const;
}

export function sdkTraceEventKind(eventType: string) {
  if (eventType === 'message_update') return 'text' as const;
  if (eventType === 'tool_execution_start') return 'tool_start' as const;
  if (eventType === 'tool_execution_update') return 'tool_progress' as const;
  if (eventType === 'tool_execution_end') return 'tool_terminal' as const;
  if (eventType === 'message_start') return 'turn_start' as const;
  if (eventType === 'message_end' || eventType === 'agent_settled') return 'turn_terminal' as const;
  return 'control' as const;
}

function canonicalTraceEventKind(candidate: BackendSemanticCandidate['kind']) {
  if (candidate === 'turn.text') return 'text' as const;
  if (candidate === 'turn.reasoning') return 'reasoning' as const;
  if (candidate === 'turn.toolDraft') return 'tool_draft' as const;
  if (candidate === 'tool.started') return 'tool_start' as const;
  if (candidate === 'tool.progress') return 'tool_progress' as const;
  if (candidate === 'tool.executionEnded' || candidate === 'tool.terminal') return 'tool_terminal' as const;
  if (candidate === 'turn.started') return 'turn_start' as const;
  if (candidate === 'turn.terminal') return 'turn_terminal' as const;
  return 'control' as const;
}

export type BackendSessionEventHandler = (
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  event: SdkSessionEvent,
) => void;
