import type { ChatMessage, TranscriptWindow } from '../../shared/protocol';
import { restoreToolCallResultsFromParts } from '../../shared/chat-message-parts';
import { normalizeTranscriptWindow } from './transcript-window';
import { reconcileDurableMessageRenderMetadata } from './live-pipeline/terminal-reconciliation';

export interface SessionOpenedTranscriptResolution {
  preserveLocal: boolean;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  /**
   * Aliases discovered while merging the local transcript into the incoming
   * snapshot. Each entry means "incoming message id aliasId refers to the same
   * logical message as local canonicalId". The reducer should store these in
   * `state.pending.messageIdAlias` so later backend events carrying the SDK ids
   * resolve to the streaming rows the host kept.
   */
  aliases: Array<{ aliasId: string; canonicalId: string }>;
}

function isEphemeralMessage(message: ChatMessage): boolean {
  return message.status === 'streaming'
    || message.status === 'queued'
    || (message.durableEntryId === undefined && message.id.startsWith('local:'))
    || (message.toolCalls?.some((tc) => tc.status === 'running') ?? false);
}

/** Compare transcript rows without treating a changed transport id as a new
 * logical entry when the SDK's durable identity survived the boundary. */
function hasSameTranscriptIdentity(left: ChatMessage, right: ChatMessage): boolean {
  if (left.role !== right.role) {
    return false;
  }
  if (left.durableEntryId !== undefined && right.durableEntryId !== undefined) {
    return left.durableEntryId === right.durableEntryId;
  }
  return left.id === right.id;
}

function hasEphemeralLocalTranscript(localTranscript: ChatMessage[]): boolean {
  return localTranscript.some((message) => isEphemeralMessage(message));
}

function normalizeUserText(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function userContentSignature(message: ChatMessage): string | null {
  if (message.role !== 'user') {
    return null;
  }

  return JSON.stringify({
    markdown: normalizeUserText(message.markdown),
    // Optimistic image rows can carry local-only metadata (name/width/height)
    // that the authoritative transcript does not always round-trip. Deduplicate
    // on the stable image payload instead of every transient display field.
    images: message.userParts
      ?.filter((part) => part.kind === 'image')
      .map((part) => ({
        mimeType: part.mimeType.trim().toLowerCase(),
        dataBase64: part.dataBase64,
      }))
      ?? [],
  });
}

function hasEquivalentIncomingUserAfterLocalPrefix(options: {
  incomingTranscript: ChatMessage[];
  incomingTranscriptWindow: TranscriptWindow;
  localTranscript: ChatMessage[];
  localTranscriptWindow: TranscriptWindow | undefined;
  localIndex: number;
  signature: string;
  matchedIncomingIndices: ReadonlySet<number>;
  nextIncomingIndexByPrefix: Map<number, number | null>;
}): { equivalent: true; incomingIndex: number } | { equivalent: false } {
  const incomingStartIndex = findIncomingStartIndexForLocalPrefix({
    incomingTranscript: options.incomingTranscript,
    incomingTranscriptWindow: options.incomingTranscriptWindow,
    localTranscript: options.localTranscript,
    localTranscriptWindow: options.localTranscriptWindow,
    localIndex: options.localIndex,
  });
  // Content alone cannot establish which earlier turn a repeated prompt
  // belongs to. Require either an identity anchor or explicit knowledge that
  // both windows begin at the branch origin before using it as a transport
  // echo fallback.
  if (incomingStartIndex === undefined) {
    return { equivalent: false };
  }

  // Local optimistic rows after the same durable prefix are matched in order.
  // Once one row has no matching echo, later rows stay local rather than
  // allowing a later echo to be assigned to the wrong prompt.
  const nextIncomingIndex = options.nextIncomingIndexByPrefix.get(incomingStartIndex);
  if (nextIncomingIndex === null) {
    return { equivalent: false };
  }
  const searchStartIndex = nextIncomingIndex ?? incomingStartIndex;
  for (let index = searchStartIndex; index < options.incomingTranscript.length; index += 1) {
    if (options.matchedIncomingIndices.has(index)) {
      continue;
    }
    if (userContentSignature(options.incomingTranscript[index]) === options.signature) {
      options.nextIncomingIndexByPrefix.set(incomingStartIndex, index + 1);
      return { equivalent: true, incomingIndex: index };
    }
  }
  options.nextIncomingIndexByPrefix.set(incomingStartIndex, null);
  return { equivalent: false };
}

/**
 * Stable identifiers on an assistant message that survive the local↔incoming
 * boundary. The local host uses synthetic ids like `req-uuid:N` while the
 * incoming snapshot uses SDK-assigned ids, so the message id is NOT a reliable
 * dedup key. Tool call ids ARE stable — the SDK assigns one id per tool call
 * and reuses it across the streaming and persisted views.
 */
function assistantToolCallIds(message: ChatMessage): readonly string[] {
  if (message.role !== 'assistant') {
    return [];
  }
  const fromParts = message.parts
    ?.filter((part): part is Extract<typeof part, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => part.toolCall.id);
  if (fromParts && fromParts.length > 0) {
    return fromParts;
  }
  return (message.toolCalls ?? []).map((tc) => tc.id);
}

function hasEquivalentIncomingAssistantByToolCallIds(options: {
  incomingTranscript: ChatMessage[];
  incomingStartIndex: number;
  localToolCallIds: readonly string[];
}): { equivalent: true; incomingIndex: number } | { equivalent: false } {
  if (options.localToolCallIds.length === 0) {
    return { equivalent: false };
  }
  const incomingToolCallIdSet = new Set(options.localToolCallIds);
  for (let index = options.incomingStartIndex; index < options.incomingTranscript.length; index += 1) {
    const incomingMessage = options.incomingTranscript[index];
    if (!incomingMessage || incomingMessage.role !== 'assistant') {
      continue;
    }
    const incomingToolCallIds = assistantToolCallIds(incomingMessage);
    if (incomingToolCallIds.length !== options.localToolCallIds.length) {
      continue;
    }
    const allMatch = incomingToolCallIds.every((id) => incomingToolCallIdSet.has(id));
    if (allMatch) {
      return { equivalent: true, incomingIndex: index };
    }
  }
  return { equivalent: false };
}

function reconcileIncomingDurableRenderMetadata(
  incomingTranscript: ChatMessage[],
  localTranscript: ChatMessage[],
): ChatMessage[] {
  return incomingTranscript.map((incoming) => {
    if (incoming.role !== 'assistant' || incoming.status === 'streaming') return incoming;
    const durableEntryMatch = incoming.durableEntryId
      ? localTranscript.find((message) => message.role === 'assistant'
        && message.status !== 'streaming'
        && message.durableEntryId === incoming.durableEntryId)
      : undefined;
    const previous = durableEntryMatch ?? localTranscript.find((message) => message.role === 'assistant'
      && message.status !== 'streaming'
      && message.id === incoming.id
      && (incoming.durableEntryId === undefined || message.durableEntryId === undefined));
    return previous ? reconcileDurableMessageRenderMetadata(incoming, previous) : incoming;
  });
}

function mergeIncomingWithEphemeralLocal(
  incomingTranscript: ChatMessage[],
  incomingTranscriptWindow: TranscriptWindow,
  localTranscript: ChatMessage[],
  localTranscriptWindow: TranscriptWindow | undefined,
): { transcript: ChatMessage[]; appendedCount: number; aliases: Array<{ aliasId: string; canonicalId: string }> } {
  const merged = [...incomingTranscript];
  const indexById = new Map<string, number>();
  for (let index = 0; index < merged.length; index += 1) {
    indexById.set(merged[index].id, index);
  }

  const aliases: Array<{ aliasId: string; canonicalId: string }> = [];
  const matchedIncomingUserIndices = new Set<number>();
  const nextIncomingUserIndexByPrefix = new Map<number, number | null>();
  let appendedCount = 0;
  for (let localIndex = 0; localIndex < localTranscript.length; localIndex += 1) {
    const localMessage = localTranscript[localIndex];
    if (!localMessage || !isEphemeralMessage(localMessage)) {
      continue;
    }

    const existingIndex = indexById.get(localMessage.id);
    if (existingIndex !== undefined) {
      // Same id already exists in the incoming snapshot. Keep the richer local
      // streaming/optimistic state until authoritative data lands. The ids are
      // identical, so no alias is needed. Claim the row so a later repeated
      // optimistic user cannot consume the same incoming echo again.
      merged[existingIndex] = localMessage;
      matchedIncomingUserIndices.add(existingIndex);
      continue;
    }

    // No id match — for user messages, use content-signature dedup only
    // after an identity-anchored prefix. For assistant messages, fall back to
    // tool-call-id dedup because the
    // message id is not stable across the local↔incoming boundary but
    // tool-call ids assigned by the SDK ARE stable. Without this check, a
    // streaming assistant message in the local transcript and its persisted
    // equivalent in the incoming transcript (with a different id) both end
    // up in the merged transcript, producing a visible duplicate.
    if (localMessage.role === 'user') {
      const signature = userContentSignature(localMessage);
      if (signature) {
        const equivalent = hasEquivalentIncomingUserAfterLocalPrefix({
          incomingTranscript,
          incomingTranscriptWindow,
          localTranscript,
          localTranscriptWindow,
          localIndex,
          signature,
          matchedIncomingIndices: matchedIncomingUserIndices,
          nextIncomingIndexByPrefix: nextIncomingUserIndexByPrefix,
        });
        if (equivalent.equivalent) {
          matchedIncomingUserIndices.add(equivalent.incomingIndex);
          continue;
        }
      }
    } else if (localMessage.role === 'assistant') {
      const incomingStartIndex = findIncomingStartIndexForLocalPrefix({
        incomingTranscript,
        incomingTranscriptWindow,
        localTranscript,
        localTranscriptWindow,
        localIndex,
      }) ?? 0;
      const localToolCallIds = assistantToolCallIds(localMessage);
      const equivalent = hasEquivalentIncomingAssistantByToolCallIds({
        incomingTranscript,
        incomingStartIndex,
        localToolCallIds,
      });
      if (equivalent.equivalent) {
        // Same assistant message under a different id — keep the local
        // (which has live streaming state) at the incoming's position. Record
        // the alias so later backend events carrying the incoming SDK id
        // resolve to the local canonical id we kept.
        const incomingId = incomingTranscript[equivalent.incomingIndex]?.id;
        if (incomingId && incomingId !== localMessage.id) {
          aliases.push({ aliasId: incomingId, canonicalId: localMessage.id });
        }
        merged[equivalent.incomingIndex] = localMessage;
        indexById.set(localMessage.id, equivalent.incomingIndex);
        continue;
      }
    }

    indexById.set(localMessage.id, merged.length);
    merged.push(localMessage);
    appendedCount += 1;
  }

  return { transcript: merged, appendedCount, aliases };
}

/** A loaded window at index zero is the only safe way to know that its
 * first row is the branch origin. A partial window can begin in the middle of
 * a repeated prompt sequence, so its first row must not be treated as index
 * zero for content-only matching. */
function isBranchOriginWindow(window: TranscriptWindow | undefined): boolean {
  return window !== undefined && window.loadedStart === 0 && !window.hasOlder;
}

/**
 * Find the position after the nearest preceding non-ephemeral local row that
 * is also present in the incoming snapshot. Durable entry ids are preferred
 * over transport ids because local assistant rows may use synthetic ids. If
 * there is no completed prefix, use index zero only when both transcript
 * windows explicitly include the branch origin; otherwise leave repeated
 * content ambiguous.
 */
function findIncomingStartIndexForLocalPrefix(options: {
  incomingTranscript: ChatMessage[];
  incomingTranscriptWindow: TranscriptWindow;
  localTranscript: ChatMessage[];
  localTranscriptWindow: TranscriptWindow | undefined;
  localIndex: number;
}): number | undefined {
  for (let index = options.localIndex - 1; index >= 0; index -= 1) {
    const previousLocalMessage = options.localTranscript[index];
    if (!previousLocalMessage || isEphemeralMessage(previousLocalMessage)) {
      continue;
    }
    const matchingIncomingIndex = options.incomingTranscript.findIndex(
      (message) => hasSameTranscriptIdentity(message, previousLocalMessage),
    );
    return matchingIncomingIndex === -1 ? undefined : matchingIncomingIndex + 1;
  }

  return isBranchOriginWindow(options.localTranscriptWindow)
    && isBranchOriginWindow(options.incomingTranscriptWindow)
    ? 0
    : undefined;
}

export function resolveSessionOpenedTranscript({
  busy,
  incomingTranscript,
  incomingTranscriptWindow,
  localTranscript,
  localTranscriptWindow,
}: {
  busy: boolean;
  incomingTranscript: ChatMessage[];
  incomingTranscriptWindow: TranscriptWindow;
  localTranscript: ChatMessage[];
  localTranscriptWindow?: TranscriptWindow;
}): SessionOpenedTranscriptResolution {
  // Backend transcript snapshots carry complete tool results once in ordered
  // `parts`; restore the legacy flat mirror only after the JSON transport has
  // been crossed so host consumers keep their existing full-detail view.
  const hydratedIncomingTranscript = incomingTranscript.map(restoreToolCallResultsFromParts);
  const reconciledIncomingTranscript = reconcileIncomingDurableRenderMetadata(
    hydratedIncomingTranscript,
    localTranscript,
  );
  const preserveLocal = busy && hasEphemeralLocalTranscript(localTranscript);

  if (!preserveLocal) {
    return {
      preserveLocal,
      transcript: reconciledIncomingTranscript,
      transcriptWindow: normalizeTranscriptWindow(reconciledIncomingTranscript, incomingTranscriptWindow),
      aliases: [],
    };
  }

  const merged = mergeIncomingWithEphemeralLocal(
    reconciledIncomingTranscript,
    incomingTranscriptWindow,
    localTranscript,
    localTranscriptWindow,
  );
  const mergedWindow: TranscriptWindow = {
    ...incomingTranscriptWindow,
    totalCount: incomingTranscriptWindow.totalCount + merged.appendedCount,
    loadedEnd: Math.min(
      incomingTranscriptWindow.totalCount + merged.appendedCount,
      incomingTranscriptWindow.loadedEnd + merged.appendedCount,
    ),
    hasNewer: incomingTranscriptWindow.hasNewer,
    isPartial:
      incomingTranscriptWindow.isPartial
      || incomingTranscriptWindow.hasOlder
      || incomingTranscriptWindow.hasNewer,
    hasUserMessages: incomingTranscriptWindow.hasUserMessages
      || merged.transcript.some((message) => message.role === 'user'),
  };

  return {
    preserveLocal,
    transcript: merged.transcript,
    transcriptWindow: normalizeTranscriptWindow(merged.transcript, mergedWindow),
    aliases: merged.aliases,
  };
}
