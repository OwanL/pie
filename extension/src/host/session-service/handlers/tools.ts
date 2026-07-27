import type { RunObserver } from '../../stats-service';
import * as crypto from 'node:crypto';
import type { ArchState } from '../../core/arch-state';
import type { SessionServiceState } from '../state';
import type { Event } from '../../core/events';
import { deriveFileChangesFromToolCall, deriveFileChangesFromSubagentResult, mergeFileChangeKind, resolveSessionCwd } from '../../core/file-change-derivation';
import { canonicalFilePath } from '../../../shared/file-path';
import { isRecord } from '../../../shared/type-guards';
import type {
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
  FileChangeEntry,
} from '../../../shared/protocol';

/** Upsert a file-change entry into a session's file-changes list, accumulating
 *  stats and removing create-then-delete pairs. Path identity is canonicalized
 *  against the session cwd so the same file reached through different spellings
 *  (relative/absolute, `./`, separator/case variants, parent vs subagent)
 *  collapses to one entry — matching the batch/JSONL derivation. */
function upsertFileChange(list: FileChangeEntry[], change: FileChangeEntry, cwd?: string): void {
  const key = canonicalFilePath(change.path, cwd);
  const existingIdx = list.findIndex((entry) => canonicalFilePath(entry.path, cwd) === key);
  if (existingIdx !== -1) {
    const existing = list[existingIdx];
    if (change.kind === 'deleted' && existing.kind === 'created') {
      list.splice(existingIdx, 1);
      return;
    }
    const additions = (existing.additions ?? 0) + (change.additions ?? 0);
    const deletions = (existing.deletions ?? 0) + (change.deletions ?? 0);
    list[existingIdx] = {
      ...change,
      kind: mergeFileChangeKind(existing.kind, change.kind),
      // Preserve the first-seen path spelling for display stability.
      path: existing.path,
      ...(additions > 0 && { additions }),
      ...(deletions > 0 && { deletions }),
    };
  } else {
    list.push(change);
  }
}

interface HandlerDeps {
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  runObserver: RunObserver;
  state: SessionServiceState;
  scheduleRender: () => void;
  requireEventSessionPath: (eventName: string, sessionPath: string | undefined) => string | null;
}

interface ToolHandlerOptions {
  /** Canonical live semantic path already mutated LivePipelineState. */
  skipTranscriptMutation?: boolean;
}

export function onToolStarted(
  payload: ToolStartedPayload,
  deps: HandlerDeps,
  options: ToolHandlerOptions = {},
): void {
  const sessionPath = deps.requireEventSessionPath('tool.started', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Assign a parallel batch id. When this call starts while a sibling tool call
  // on the same assistant message is still running, it joins that sibling's
  // batch; otherwise it starts a fresh batch. Every call is stamped forward
  // (no retroactive updates needed): a batch of size 1 is a solo/sequential
  // call and renders without the parallel indentation strip, while a batch of
  // size > 1 renders with the strip. See `parallelGroupId` on `ToolCall`.
  const archState = deps.getArchState();
  const transcript = archState.transcript.bySession[sessionPath];
  const cachedIdx = archState.pending.currentTurnBySession[sessionPath]?.firstMessageIndex;
  const ownerMessage =
    cachedIdx !== undefined && transcript?.[cachedIdx]?.id === payload.messageId
      ? transcript?.[cachedIdx]
      : transcript?.find((message) => message.id === payload.messageId);
  const runningSibling = ownerMessage?.toolCalls?.find(
    (toolCall) => toolCall.status === 'running' && toolCall.id !== payload.toolCallId,
  );
  const parallelGroupId = payload.parallelGroupId ?? runningSibling?.parallelGroupId ?? crypto.randomUUID();

  const toolCall = {
    id: payload.toolCallId,
    name: payload.name,
    input: payload.input,
    status: 'running' as const,
    startedAt: payload.startedAt,
    parallelGroupId,
  };

  if (!options.skipTranscriptMutation) {
    deps.dispatchArch({
      kind: 'ToolCall',
      sessionPath,
      messageId: payload.messageId,
      toolCall,
    });
  }
  deps.runObserver.onToolStarted(sessionPath, toolCall);

  // Track file changes from file-modifying tools
  const fileChanges = deriveFileChangesFromToolCall(
    { id: payload.toolCallId, name: payload.name, input: payload.input },
    payload.messageId,
    new Date().toISOString(),
  );
  if (fileChanges.length > 0) {
    const arch = deps.getArchState();
    const cwd = resolveSessionCwd(arch.sessions.sessions, arch.sessions.workspaceCwd, sessionPath);
    const existing = arch.fileChanges.bySession[sessionPath] ?? [];
    const next = [...existing];
    for (const change of fileChanges) {
      upsertFileChange(next, change, cwd);
    }
    deps.dispatchArch({ kind: 'FileChangesUpdated', sessionPath, fileChanges: next });
    deps.scheduleRender();
  }

  deps.state.touchSessionTranscript(sessionPath);
}

export function onToolFinished(
  payload: ToolFinishedPayload,
  deps: HandlerDeps,
  options: ToolHandlerOptions = {},
): void {
  const sessionPath = deps.requireEventSessionPath('tool.finished', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Look up the existing tool call to carry forward name/input. The owner
  // message is identified by payload.messageId, so locate that one message
  // (no array allocation across the whole transcript) and find the tool call
  // within its toolCalls. Use the cached streaming-turn index for O(1) when
  // it still points at this message; otherwise fall back to a find.
  const archState = deps.getArchState();
  const transcript = archState.transcript.bySession[sessionPath];
  const cachedIdx = archState.pending.currentTurnBySession[sessionPath]?.firstMessageIndex;
  const ownerMessage =
    cachedIdx !== undefined && transcript?.[cachedIdx]?.id === payload.messageId
      ? transcript?.[cachedIdx]
      : transcript?.find((message) => message.id === payload.messageId);
  const existing = ownerMessage?.toolCalls?.find((toolCall) => toolCall.id === payload.toolCallId);

  const payloadName = payload.name?.trim();
  const toolCall = {
    id: payload.toolCallId,
    name: payloadName || existing?.name || '',
    input: payload.input !== undefined ? payload.input : existing?.input,
    result: payload.result,
    status: payload.status,
    startedAt: payload.startedAt ?? existing?.startedAt,
    durationMs: payload.durationMs,
    parallelGroupId: payload.parallelGroupId ?? existing?.parallelGroupId,
    durableEntryId: payload.durableEntryId,
  };

  if (!options.skipTranscriptMutation) {
    deps.dispatchArch({
      kind: 'ToolCall',
      sessionPath,
      messageId: payload.messageId,
      toolCall,
    });
  }
  deps.runObserver.onToolFinished(sessionPath, toolCall);

  // Track file changes from subagent inner tool calls. A failed subagent is
  // skipped entirely (matching the reattach derivation, which skips
  // status==='failed' tools) — otherwise the live manifest would diverge from
  // the reattach manifest by leaking a failed subagent's inner changes.
  if (toolCall.name === 'subagent' && isRecord(payload.result) && payload.status !== 'failed') {
    const subagentChanges = deriveFileChangesFromSubagentResult(
      payload.result,
      payload.messageId,
      new Date().toISOString(),
      payload.toolCallId,
    );
    if (subagentChanges.length > 0) {
      const arch = deps.getArchState();
      const cwd = resolveSessionCwd(arch.sessions.sessions, arch.sessions.workspaceCwd, sessionPath);
      const existingChanges = arch.fileChanges.bySession[sessionPath] ?? [];
      const next = [...existingChanges];
      for (const change of subagentChanges) {
        upsertFileChange(next, change, cwd);
      }
      deps.dispatchArch({ kind: 'FileChangesUpdated', sessionPath, fileChanges: next });
      deps.scheduleRender();
    }
  }

  // Reconcile file changes on failure. onToolStarted derives file changes from
  // the INPUT before the result is known (optimistic, for live UI feedback). If
  // the tool later fails, those entries must be removed so the live manifest
  // matches the reattach derivation (which skips status==='failed' tools) —
  // eliminating the transient live-vs-reattach divergence. We filter by
  // toolCallId rather than re-deriving from the transcript because the
  // in-memory transcript may be windowed/compacted, and re-derivation could
  // drop changes that survive only in the incremental fileChanges store.
  if (payload.status === 'failed') {
    const existing = deps.getArchState().fileChanges.bySession[sessionPath] ?? [];
    const next = existing.filter((c) => c.toolCallId !== payload.toolCallId);
    if (next.length !== existing.length) {
      deps.dispatchArch({ kind: 'FileChangesUpdated', sessionPath, fileChanges: next });
      deps.scheduleRender();
    }
  }

  deps.state.touchSessionTranscript(sessionPath);
}

export function onToolProgress(payload: ToolProgressPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('tool.progress', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Look up the existing tool call to carry forward name/input. The owner
  // message is identified by payload.messageId, so locate that one message
  // (no array allocation across the whole transcript) and find the tool call
  // within its toolCalls. Use the cached streaming-turn index for O(1) when
  // it still points at this message; otherwise fall back to a find.
  const archState = deps.getArchState();
  const transcript = archState.transcript.bySession[sessionPath];
  const cachedIdx = archState.pending.currentTurnBySession[sessionPath]?.firstMessageIndex;
  const ownerMessage =
    cachedIdx !== undefined && transcript?.[cachedIdx]?.id === payload.messageId
      ? transcript?.[cachedIdx]
      : transcript?.find((message) => message.id === payload.messageId);
  const existing = ownerMessage?.toolCalls?.find((toolCall) => toolCall.id === payload.toolCallId);

  const toolCall = {
    id: payload.toolCallId,
    name: existing?.name ?? '',
    input: existing?.input,
    result: payload.preview,
    status: 'running' as const,
    startedAt: existing?.startedAt,
    parallelGroupId: existing?.parallelGroupId,
  };

  deps.dispatchArch({
    kind: 'ToolCall',
    sessionPath,
    messageId: payload.messageId,
    toolCall,
  });

  deps.state.touchSessionTranscript(sessionPath);
}
