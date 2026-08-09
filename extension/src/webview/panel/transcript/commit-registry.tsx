/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ChatMessage, ToolCall, TranscriptWindow, WebviewToHostMessage } from '../../../shared/protocol';
import { boundedTextIdentity, equalBoundedTextIdentity } from '../../../shared/transcript-commit-identity';
import { assistantPartsFromMessage, getRenderableUserParts } from './parts';
import { reasoningSummary } from '../markdown';
import { recordRenderSurface } from '../render-error';

const MAX_COMMIT_ROWS = 256;

export interface TranscriptCommitTarget {
  revision: number;
  viewGeneration: number;
  expectedTranscriptIdentity: string;
  acceptedAt: number;
  state: {
    transcript: ChatMessage[];
    transcriptWindow: TranscriptWindow;
    activeSessionPath: string | null;
    openTabPaths: string[];
  };
}

type AppCommitSurface = 'app' | 'loading' | 'empty' | 'transcript-suspense' | 'transcript';

export type CommitLeaf =
  | { kind: 'message'; messageId: string; role: ChatMessage['role']; status: ChatMessage['status'] }
  | { kind: 'text'; messageId: string; partIndex: number; text: string }
  | { kind: 'reasoning'; messageId: string; partIndex: number; text: string; policy: 'displayed' | 'collapsed' }
  | { kind: 'tool'; messageId: string; toolCallId: string; status: ToolCall['status']; executionId: string; attempt: number; seq: number; phase: string; revision: number };

type ReportCommitLeaf = (key: string, leaf: CommitLeaf | null) => void;

interface CommitRegistryValue {
  target: TranscriptCommitTarget | null;
  reportLeaf: ReportCommitLeaf;
  leaves: ReadonlyMap<string, CommitLeaf>;
  version: number;
  mountHost: () => number;
  unmountHost: (generation: number) => void;
  commitAppSurface: (surface: AppCommitSurface) => void;
}

// Leaf writers need only this stable callback. Keeping them on the dynamic
// registry context made every version increment rerender every mounted leaf;
// one streamed update therefore traversed all historical tools in the active
// assistant turn a second time.
const CommitReporterContext = createContext<ReportCommitLeaf>(() => undefined);

const EMPTY_LEAVES = new Map<string, CommitLeaf>();
const CommitRegistryContext = createContext<CommitRegistryValue>({
  target: null,
  reportLeaf: () => undefined,
  leaves: EMPTY_LEAVES,
  version: 0,
  mountHost: () => 0,
  unmountHost: () => undefined,
  commitAppSurface: () => undefined,
});

interface TranscriptCommitProviderProps {
  target: TranscriptCommitTarget | null;
  postMessage: (message: WebviewToHostMessage) => void;
  appSurface: AppCommitSurface;
  children: ComponentChildren;
}

/**
 * Stores renderer-owned metadata for mounted transcript leaves. Evidence stays
 * attached to the mounted DOM across target revisions; the target comparator
 * prevents stale values from satisfying changed authoritative content. The
 * expected opaque identity is posted only after TranscriptHost independently
 * proves that these leaves represent the authoritative snapshot.
 */
export function TranscriptCommitProvider({ target, postMessage, appSurface, children }: TranscriptCommitProviderProps) {
  // Leaf evidence describes the currently mounted DOM, not one transport
  // revision. Preserve it while snapshot revisions advance: structured-cloned
  // host state commonly changes only the active tail, and clearing this map on
  // every ~150ms streaming snapshot forced every mounted message/tool leaf in a
  // long assistant turn to unregister and re-register. Tool-heavy turns can
  // contain hundreds of mounted leaves, turning each token batch into a full
  // commit-registry rebuild and making unrelated controls, scrolling, and tab
  // switching contend with that work.
  //
  // A preserved stale leaf cannot acknowledge newer content:
  // decideTranscriptCommit compares every relevant value (text, role/status,
  // tool lifecycle) with the new target. Changed components update their leaf
  // in layout effects; unmounted components remove it. Keeping evidence across
  // revision-only targets therefore retains the same safety while making the
  // common unchanged-DOM path O(changed leaves), not O(all mounted leaves).
  const leavesRef = useRef<Map<string, CommitLeaf>>(new Map());
  const [registryVersion, setRegistryVersion] = useState(0);
  const mountGenerationRef = useRef(0);
  const lastAppCommitRef = useRef('');
  const reportLeaf = useCallback((key: string, leaf: CommitLeaf | null) => {
    const registry = leavesRef.current;
    const previous = registry.get(key);
    if (leaf === null) {
      if (!previous) return;
      registry.delete(key);
    } else {
      if (sameLeaf(previous, leaf)) return;
      registry.set(key, leaf);
    }
    setRegistryVersion((version) => version + 1);
  }, []);
  const mountHost = useCallback(() => {
    mountGenerationRef.current += 1;
    return mountGenerationRef.current;
  }, []);
  const unmountHost = useCallback((_generation: number) => undefined, []);
  const commitAppSurface = useCallback((surface: AppCommitSurface) => {
    if (!target) return;
    const evidenceKey = `${target.viewGeneration}:${target.revision}:${surface}`;
    if (lastAppCommitRef.current === evidenceKey) return;
    lastAppCommitRef.current = evidenceKey;
    recordRenderSurface(surface === 'transcript-suspense' ? 'transcript-suspense' : surface === 'transcript' ? 'transcript' : 'app');
    postMessage({
      type: 'appCommitted',
      payload: { revision: target.revision, viewGeneration: target.viewGeneration, surface },
    });
  }, [target, postMessage]);

  const value = useMemo<CommitRegistryValue>(() => ({
    target,
    leaves: leavesRef.current,
    version: registryVersion,
    reportLeaf,
    mountHost,
    unmountHost,
    commitAppSurface,
  }), [target, registryVersion, reportLeaf, mountHost, unmountHost, commitAppSurface]);

  // This effect belongs to the provider surrounding the complete application
  // tree, so it runs only after the outer layout for this target has committed.
  useLayoutEffect(() => {
    if (!target) return;
    // The outer boundary owns app commit evidence. Presence is used only to
    // classify the surface; transcript identity still comes exclusively from
    // committed leaf metadata below this boundary.
    const committedSurface = appSurface === 'transcript-suspense'
      && document.querySelector('.transcript-host')
      ? 'transcript'
      : appSurface;
    commitAppSurface(committedSurface);
  }, [target, appSurface, commitAppSurface]);

  return (
    <CommitReporterContext.Provider value={reportLeaf}>
      <CommitRegistryContext.Provider value={value}>{children}</CommitRegistryContext.Provider>
    </CommitReporterContext.Provider>
  );
}

export function useTranscriptCommitRegistry(): CommitRegistryValue {
  return useContext(CommitRegistryContext);
}

export function useCommittedAppSurface(surface: AppCommitSurface): void {
  const registry = useTranscriptCommitRegistry();
  useLayoutEffect(() => registry.commitAppSurface(surface), [registry.commitAppSurface, surface]);
}

export interface MessageCommitOwner {
  messageId: string;
  toolStateRevision: number;
}

export const MessageCommitContext = createContext<MessageCommitOwner | null>(null);

export function useCommittedMessageLeaf(message: ChatMessage): void {
  const reportLeaf = useContext(CommitReporterContext);
  useLayoutEffect(() => {
    const key = `message:${message.id}`;
    reportLeaf(key, { kind: 'message', messageId: message.id, role: message.role, status: message.status });
    return () => reportLeaf(key, null);
  }, [reportLeaf, message.id, message.role, message.status]);
}

export function useCommittedTextLeaf(messageId: string, partIndex: number, text: string): void {
  const reportLeaf = useContext(CommitReporterContext);
  useLayoutEffect(() => {
    const key = `text:${messageId}:${partIndex}`;
    reportLeaf(key, { kind: 'text', messageId, partIndex, text });
    return () => reportLeaf(key, null);
  }, [reportLeaf, messageId, partIndex, text]);
}

export function useCommittedReasoningLeaf(
  messageId: string,
  partIndex: number,
  text: string,
  policy: 'displayed' | 'collapsed',
): void {
  const reportLeaf = useContext(CommitReporterContext);
  useLayoutEffect(() => {
    const key = `reasoning:${messageId}:${partIndex}`;
    reportLeaf(key, { kind: 'reasoning', messageId, partIndex, text, policy });
    return () => reportLeaf(key, null);
  }, [reportLeaf, messageId, partIndex, text, policy]);
}

export function useCommittedToolLeaf(toolCall: ToolCall): void {
  const reportLeaf = useContext(CommitReporterContext);
  const owner = useContext(MessageCommitContext);
  const lifecycle = toolLifecycle(toolCall, owner?.toolStateRevision ?? 0);
  useLayoutEffect(() => {
    if (!owner) return;
    const key = `tool:${owner.messageId}:${toolCall.id}`;
    reportLeaf(key, {
      kind: 'tool',
      messageId: owner.messageId,
      toolCallId: toolCall.id,
      status: toolCall.status,
      ...lifecycle,
    });
    return () => reportLeaf(key, null);
  }, [reportLeaf, owner?.messageId, toolCall.id, toolCall.status, lifecycle.executionId, lifecycle.attempt, lifecycle.seq, lifecycle.phase, lifecycle.revision]);
}

export interface TranscriptModelEvidence {
  renderedTranscript: readonly ChatMessage[];
  window: TranscriptWindow;
  mountedVirtualRowIndexes: readonly number[];
  rowIndexByMessageId: ReadonlyMap<string, number>;
  /** Source rows deliberately omitted by the current transcript display policy. */
  intentionallyHiddenMessageIds: ReadonlySet<string>;
}

export type TranscriptCommitBlockedReason = 'window_mismatch' | 'structure_mismatch' | 'leaf_missing' | 'leaf_mismatch';
export interface TranscriptCommitDecision {
  matches: boolean;
  evidence: 'displayed' | 'offscreen' | 'no-transcript';
  reason?: TranscriptCommitBlockedReason;
}

/** Pure bounded comparison used by TranscriptHost and focused tests. */
export function decideTranscriptCommit(
  target: TranscriptCommitTarget,
  leaves: ReadonlyMap<string, CommitLeaf>,
  model: TranscriptModelEvidence,
): TranscriptCommitDecision {
  const expected = target.state.transcript;
  if (expected.length > MAX_COMMIT_ROWS || model.renderedTranscript.length > MAX_COMMIT_ROWS) {
    return { matches: false, evidence: 'displayed', reason: 'structure_mismatch' };
  }
  if (!equalWindow(target.state.transcriptWindow, model.window)) {
    return { matches: false, evidence: 'displayed', reason: 'window_mismatch' };
  }
  if (!sameTranscriptStructure(expected, model.renderedTranscript)) {
    return { matches: false, evidence: 'displayed', reason: 'structure_mismatch' };
  }
  if (expected.length === 0) {
    return { matches: true, evidence: 'no-transcript' };
  }

  const relevantIds = relevantMessageIds(expected);
  let usedOffscreenEvidence = false;
  for (const messageId of relevantIds) {
    const message = expected.find((candidate) => candidate.id === messageId);
    if (!message) return { matches: false, evidence: 'displayed', reason: 'structure_mismatch' };
    // A pruning source row deliberately omitted by the row model (hidden by
    // policy or folded into an assistant header) is not a virtualizer miss.
    // Only this precise source row may use that evidence;
    // arbitrary active or stale rows must still prove a mounted leaf/offscreen
    // position before they can acknowledge the host snapshot.
    if (isIntentionallyHiddenPruningMessage(message, model)) continue;
    const row = leaves.get(`message:${message.id}`);
    if (!row) {
      if (!isProvenOffscreen(message.id, model)) return { matches: false, evidence: 'displayed', reason: 'leaf_missing' };
      usedOffscreenEvidence = true;
      continue;
    }
    if (row.kind !== 'message' || row.role !== message.role || row.status !== message.status) {
      return { matches: false, evidence: 'displayed', reason: 'leaf_mismatch' };
    }
    if (!messageContentMatches(message, leaves) || !messageToolsMatch(message, leaves)) {
      return { matches: false, evidence: 'displayed', reason: 'leaf_mismatch' };
    }
  }

  return { matches: true, evidence: usedOffscreenEvidence ? 'offscreen' : 'displayed' };
}

function messageContentMatches(message: ChatMessage, leaves: ReadonlyMap<string, CommitLeaf>): boolean {
  if (message.role === 'assistant') {
    const parts = assistantPartsFromMessage(message) ?? [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (part.kind === 'text') {
        const leaf = leaves.get(`text:${message.id}:${index}`);
        if (leaf?.kind !== 'text' || !sameText(leaf.text, part.text)) return false;
      } else if (part.kind === 'reasoning') {
        const leaf = leaves.get(`reasoning:${message.id}:${index}`);
        if (leaf?.kind !== 'reasoning') return false;
        const expectedText = leaf.policy === 'collapsed' ? reasoningSummary(part.text) : part.text;
        if (!sameText(leaf.text, expectedText)) return false;
      }
    }
    return true;
  }

  const userParts = getRenderableUserParts(message);
  if (message.role === 'user' && userParts) {
    for (let index = 0; index < userParts.length; index += 1) {
      const part = userParts[index]!;
      if (part.kind !== 'text') continue;
      const leaf = leaves.get(`text:${message.id}:${index}`);
      if (leaf?.kind !== 'text' || !sameText(leaf.text, part.text)) return false;
    }
  }
  return true;
}

function messageToolsMatch(message: ChatMessage, leaves: ReadonlyMap<string, CommitLeaf>): boolean {
  const parts = assistantPartsFromMessage(message) ?? [];
  const tools = parts.filter((part): part is Extract<(typeof parts)[number], { kind: 'toolCall' }> => part.kind === 'toolCall');
  for (const part of tools) {
    const expected = part.toolCall;
    const leaf = leaves.get(`tool:${message.id}:${expected.id}`);
    const lifecycle = toolLifecycle(expected, message.toolStateRevision ?? 0);
    if (leaf?.kind !== 'tool'
      || leaf.status !== expected.status
      || leaf.executionId !== lifecycle.executionId
      || leaf.attempt !== lifecycle.attempt
      || leaf.seq !== lifecycle.seq
      || leaf.phase !== lifecycle.phase
      || leaf.revision !== lifecycle.revision) {
      return false;
    }
  }
  return true;
}

function relevantMessageIds(transcript: readonly ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const message of transcript) {
    // Historical terminal tools are already covered by the full transcript
    // structure comparison and cannot change between snapshots. Requiring
    // every one of their leaves made a tool-heavy loaded window exceed the
    // bounded registry and permanently report leaf_missing. Only live/queued
    // owners plus the signed tail need renderer-owned leaf evidence.
    if (message.status === 'streaming' || message.status === 'queued') {
      ids.push(message.id);
    }
  }
  // Keep this selection in lockstep with transcriptRenderSignature: every
  // member of its signed three-message tail needs renderer-owned evidence.
  for (const message of transcript.slice(-3)) {
    if (!ids.includes(message.id)) ids.push(message.id);
  }
  return ids;
}

function isIntentionallyHiddenPruningMessage(message: ChatMessage, model: TranscriptModelEvidence): boolean {
  return message.customType === 'pruning-result' && model.intentionallyHiddenMessageIds.has(message.id);
}

function isProvenOffscreen(messageId: string, model: TranscriptModelEvidence): boolean {
  const expectedIndex = model.rowIndexByMessageId.get(messageId);
  if (expectedIndex === undefined || model.mountedVirtualRowIndexes.length === 0) return false;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const index of model.mountedVirtualRowIndexes.slice(0, MAX_COMMIT_ROWS)) {
    minimum = Math.min(minimum, index);
    maximum = Math.max(maximum, index);
  }
  return expectedIndex < minimum || expectedIndex > maximum;
}

function sameTranscriptStructure(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.id !== b.id || a.role !== b.role || a.status !== b.status
      || (a.parts?.length ?? 0) !== (b.parts?.length ?? 0)
      || (a.toolCalls?.length ?? 0) !== (b.toolCalls?.length ?? 0)
      || !!a.thinking !== !!b.thinking || !!a.draftingToolCall !== !!b.draftingToolCall) return false;
  }
  return true;
}

function equalWindow(left: TranscriptWindow, right: TranscriptWindow): boolean {
  return left.totalCount === right.totalCount && left.loadedStart === right.loadedStart
    && left.loadedEnd === right.loadedEnd && left.hasOlder === right.hasOlder
    && left.hasNewer === right.hasNewer && left.isPartial === right.isPartial
    && left.hasUserMessages === right.hasUserMessages;
}

function sameText(left: string, right: string): boolean {
  return equalBoundedTextIdentity(boundedTextIdentity(left), boundedTextIdentity(right));
}

function toolLifecycle(toolCall: ToolCall, revision: number) {
  const value = toolCall as ToolCall & { executionId?: unknown; attempt?: unknown; seq?: unknown; lifecycleSeq?: unknown; phase?: unknown };
  return {
    executionId: typeof value.executionId === 'string' ? value.executionId : toolCall.id,
    attempt: safeInteger(value.attempt),
    seq: safeInteger(value.seq ?? value.lifecycleSeq ?? revision),
    phase: typeof value.phase === 'string' ? value.phase : toolCall.status,
    revision: safeInteger(revision),
  };
}

function safeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function sameLeaf(left: CommitLeaf | undefined, right: CommitLeaf): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === 'message' && right.kind === 'message') return left.messageId === right.messageId && left.role === right.role && left.status === right.status;
  if (left.kind === 'text' && right.kind === 'text') return left.messageId === right.messageId && left.partIndex === right.partIndex && sameText(left.text, right.text);
  if (left.kind === 'reasoning' && right.kind === 'reasoning') return left.messageId === right.messageId && left.partIndex === right.partIndex && left.policy === right.policy && sameText(left.text, right.text);
  if (left.kind === 'tool' && right.kind === 'tool') return left.messageId === right.messageId && left.toolCallId === right.toolCallId && left.status === right.status && left.executionId === right.executionId && left.attempt === right.attempt && left.seq === right.seq && left.phase === right.phase && left.revision === right.revision;
  return false;
}
