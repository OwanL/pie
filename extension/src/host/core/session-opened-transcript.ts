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
    || message.id.startsWith('local:')
    || (message.toolCalls?.some((tc) => tc.status === 'running') ?? false);
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
  localTranscript: ChatMessage[];
  localIndex: number;
  signature: string;
}): boolean {
  let incomingStartIndex = 0;

  for (let index = options.localIndex - 1; index >= 0; index -= 1) {
    const previousLocalMessage = options.localTranscript[index];
    if (!previousLocalMessage || isEphemeralMessage(previousLocalMessage)) {
      continue;
    }

    const matchingIncomingIndex = options.incomingTranscript.findIndex(
      (message) => message.id === previousLocalMessage.id,
    );
    if (matchingIncomingIndex !== -1) {
      incomingStartIndex = matchingIncomingIndex + 1;
      break;
    }
  }

  return options.incomingTranscript
    .slice(incomingStartIndex)
    .some((message) => userContentSignature(message) === options.signature);
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
  localTranscript: ChatMessage[],
): { transcript: ChatMessage[]; appendedCount: number; aliases: Array<{ aliasId: string; canonicalId: string }> } {
  const merged = [...incomingTranscript];
  const indexById = new Map<string, number>();
  for (let index = 0; index < merged.length; index += 1) {
    indexById.set(merged[index].id, index);
  }

  const aliases: Array<{ aliasId: string; canonicalId: string }> = [];
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
      // identical, so no alias is needed.
      merged[existingIndex] = localMessage;
      continue;
    }

    // No id match — for user messages, fall back to content-signature dedup.
    // For assistant messages, fall back to tool-call-id dedup because the
    // message id is not stable across the local↔incoming boundary but
    // tool-call ids assigned by the SDK ARE stable. Without this check, a
    // streaming assistant message in the local transcript and its persisted
    // equivalent in the incoming transcript (with a different id) both end
    // up in the merged transcript, producing a visible duplicate.
    if (localMessage.role === 'user') {
      const signature = userContentSignature(localMessage);
      if (
        signature
        && hasEquivalentIncomingUserAfterLocalPrefix({
          incomingTranscript,
          localTranscript,
          localIndex,
          signature,
        })
      ) {
        continue;
      }
    } else if (localMessage.role === 'assistant') {
      const incomingStartIndex = findIncomingStartIndexForLocalPrefix({
        incomingTranscript,
        localTranscript,
        localIndex,
      });
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

/**
 * Mirror of `hasEquivalentIncomingUserAfterLocalPrefix`: find the earliest
 * non-ephemeral local message before `localIndex` whose id appears in the
 * incoming transcript, then start scanning the incoming from the position
 * after that match. Falls back to scanning from index 0 when no pivot is
 * found.
 */
function findIncomingStartIndexForLocalPrefix(options: {
  incomingTranscript: ChatMessage[];
  localTranscript: ChatMessage[];
  localIndex: number;
}): number {
  for (let index = options.localIndex - 1; index >= 0; index -= 1) {
    const previousLocalMessage = options.localTranscript[index];
    if (!previousLocalMessage || isEphemeralMessage(previousLocalMessage)) {
      continue;
    }
    const matchingIncomingIndex = options.incomingTranscript.findIndex(
      (message) => message.id === previousLocalMessage.id,
    );
    if (matchingIncomingIndex !== -1) {
      return matchingIncomingIndex + 1;
    }
  }
  return 0;
}

export function resolveSessionOpenedTranscript({
  busy,
  incomingTranscript,
  incomingTranscriptWindow,
  localTranscript,
}: {
  busy: boolean;
  incomingTranscript: ChatMessage[];
  incomingTranscriptWindow: TranscriptWindow;
  localTranscript: ChatMessage[];
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

  const merged = mergeIncomingWithEphemeralLocal(reconciledIncomingTranscript, localTranscript);
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
