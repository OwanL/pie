import type { ChatMessage } from '../../../shared/protocol';
import { AGENT_ACTIVITY_LABELS, type TurnActivityState } from './activity';
import { estimateActivityTailHeight } from './activity-tail';
import { isPruningResultMessage, pruningDetailsFromMessage, type PruningHeaderState } from './pruning';

export type TranscriptRow =
  | { kind: 'systemPrompts'; key: string }
  | { kind: 'topGap'; key: string }
  | { kind: 'message'; key: string; message: ChatMessage; pruningHeaderState?: PruningHeaderState; activityState?: TurnActivityState | null; transcriptIndex?: number }
  | { kind: 'typingIndicator'; key: string; activityState?: TurnActivityState | null }
  | { kind: 'bottomGap'; key: string };

interface BuildTranscriptRowsOptions {
  transcript: readonly ChatMessage[];
  systemPromptCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
  busy: boolean;
  /** Deprecated: retained for older call sites; pruning now renders per assistant turn. */
  hasPruningResult?: boolean;
  /** Controls whether pruning-result custom messages are attached to assistant headers. */
  showPruningMessages?: boolean;
  /** Structured in-flight activity state for the current busy phase. */
  activityState?: TurnActivityState | null;
  /** Selected assistant model known before message_start. */
  pendingAssistantModelId?: string;
  /** Selected assistant thinking level known before message_start. */
  pendingAssistantThinkingLevel?: ChatMessage['thinkingLevel'];
}

type ResultPruningHeaderState = Extract<PruningHeaderState, { kind: 'result' }>;

interface TranscriptAccumulator {
  rows: TranscriptRow[];
  pendingPruning: { state: ResultPruningHeaderState; message: ChatMessage } | null;
  lastAssistantRowIndexSinceUser: number | null;
  latestUserMessage: ChatMessage | null;
}

function handlePruningMessage(
  acc: TranscriptAccumulator,
  message: ChatMessage,
  index: number,
  showPruningMessages: boolean,
): void {
  const details = showPruningMessages ? pruningDetailsFromMessage(message) : null;
  if (!details) {
    acc.pendingPruning = null;
    if (showPruningMessages) {
      acc.rows.push({ kind: 'message', key: `message:${message.id}`, message, transcriptIndex: index });
    }
    return;
  }

  const pruningHeaderState: ResultPruningHeaderState = {
    kind: 'result',
    details,
    fallbackText: message.markdown,
  };

  if (acc.lastAssistantRowIndexSinceUser !== null) {
    const row = acc.rows[acc.lastAssistantRowIndexSinceUser];
    if (row?.kind === 'message' && row.message.role === 'assistant') {
      acc.rows[acc.lastAssistantRowIndexSinceUser] = {
        ...row,
        pruningHeaderState,
      };
    }
    acc.pendingPruning = null;
  } else {
    acc.pendingPruning = { state: pruningHeaderState, message };
  }
}

function pushAssistantRow(
  acc: TranscriptAccumulator,
  message: ChatMessage,
  index: number,
): void {
  const row: TranscriptRow = acc.pendingPruning
    ? {
        kind: 'message',
        key: `message:${message.id}`,
        message,
        pruningHeaderState: acc.pendingPruning.state,
        transcriptIndex: index,
      }
    : { kind: 'message', key: `message:${message.id}`, message, transcriptIndex: index };
  acc.rows.push(row);
  acc.lastAssistantRowIndexSinceUser = acc.rows.length - 1;
  acc.pendingPruning = null;
}

function processSingleMessage(
  acc: TranscriptAccumulator,
  message: ChatMessage,
  index: number,
  showPruningMessages: boolean,
): void {
  if (isPruningResultMessage(message)) {
    handlePruningMessage(acc, message, index, showPruningMessages);
    return;
  }
  if (message.role === 'user') {
    // Queued follow-ups sit after the active assistant turn in projection, but
    // they do not begin a new visible turn until delivery. Keep the active
    // turn's pruning/assistant ownership intact while still rendering the
    // queued bubble at the boundary.
    if (message.status !== 'queued') {
      acc.pendingPruning = null;
      acc.lastAssistantRowIndexSinceUser = null;
      acc.latestUserMessage = message;
    }
  } else if (message.role === 'assistant') {
    pushAssistantRow(acc, message, index);
    return;
  }
  acc.rows.push({ kind: 'message', key: `message:${message.id}`, message, transcriptIndex: index });
}

function processTranscriptMessages(
  transcript: readonly ChatMessage[],
  showPruningMessages: boolean,
): TranscriptAccumulator {
  const acc: TranscriptAccumulator = {
    rows: [],
    pendingPruning: null,
    lastAssistantRowIndexSinceUser: null,
    latestUserMessage: null,
  };

  for (let i = 0; i < transcript.length; i++) {
    processSingleMessage(acc, transcript[i], i, showPruningMessages);
  }

  return acc;
}

function maybeAddPlaceholderAssistant(
  rows: TranscriptRow[],
  pendingPruning: { state: ResultPruningHeaderState; message: ChatMessage } | null,
  lastAssistantRowIndexSinceUser: number | null,
  latestUserMessage: ChatMessage | null,
  busy: boolean,
  pendingAssistantModelId: string | undefined,
  pendingAssistantThinkingLevel: ChatMessage['thinkingLevel'] | undefined,
  activityState: TurnActivityState | null,
): void {
  const pendingPruningHeaderState: PruningHeaderState | null = pendingPruning?.state
    ?? (activityState?.phase === 'pruning'
      ? { kind: 'pending', label: AGENT_ACTIVITY_LABELS.pruning }
      : null);
  const placeholderAssistantId = latestUserMessage
    ? `assistant-placeholder:${latestUserMessage.id}`
    : pendingPruning
      ? `assistant-placeholder:${pendingPruning.message.id}`
      : null;
  const placeholderCreatedAt = latestUserMessage?.createdAt || pendingPruning?.message.createdAt || '';

  const shouldRenderPlaceholderAssistant = !!placeholderAssistantId
    && lastAssistantRowIndexSinceUser === null
    && (busy || pendingPruningHeaderState?.kind === 'result' || pendingPruningHeaderState?.kind === 'pending');
  if (!shouldRenderPlaceholderAssistant || !placeholderAssistantId) {
    return;
  }

  const baseMessage: ChatMessage = {
    id: placeholderAssistantId,
    role: 'assistant',
    createdAt: placeholderCreatedAt,
    markdown: '',
    modelId: pendingAssistantModelId,
    thinkingLevel: pendingAssistantThinkingLevel,
    status: 'completed',
    parts: [],
    toolCalls: [],
  };

  const placeholder: TranscriptRow = pendingPruningHeaderState
    ? {
        kind: 'message',
        key: `message:${placeholderAssistantId}`,
        message: baseMessage,
        pruningHeaderState: pendingPruningHeaderState,
      }
    : {
        kind: 'message',
        key: `message:${placeholderAssistantId}`,
        message: baseMessage,
      };
  const firstQueuedIndex = rows.findIndex(
    (row) => row.kind === 'message' && row.message.role === 'user' && row.message.status === 'queued',
  );
  if (firstQueuedIndex >= 0) rows.splice(firstQueuedIndex, 0, placeholder);
  else rows.push(placeholder);
}

function attachActivityState(rows: TranscriptRow[], activityState: TurnActivityState): void {
  // Queued follow-ups are displayed after the live turn. Attach activity to
  // that turn's assistant row rather than manufacturing a second reply below
  // the queue (which previously looked like a pruning-prepass response).
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === 'message' && row.message.role === 'assistant') {
      rows[index] = { ...row, activityState };
      return;
    }
  }
  const firstQueuedIndex = rows.findIndex(
    (row) => row.kind === 'message' && row.message.role === 'user' && row.message.status === 'queued',
  );
  const typing: TranscriptRow = { kind: 'typingIndicator', key: 'typing-indicator', activityState };
  if (firstQueuedIndex >= 0) rows.splice(firstQueuedIndex, 0, typing);
  else rows.push(typing);
}

export function buildTranscriptRows({
  transcript,
  systemPromptCount,
  hasOlder,
  hasNewer,
  busy,
  showPruningMessages = true,
  activityState = null,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
}: BuildTranscriptRowsOptions): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  if (systemPromptCount > 0) {
    rows.push({ kind: 'systemPrompts', key: 'system-prompts' });
  }
  if (hasOlder) {
    rows.push({ kind: 'topGap', key: 'gap:older' });
  }

  const acc = processTranscriptMessages(transcript, showPruningMessages);
  rows.push(...acc.rows);

  maybeAddPlaceholderAssistant(
    rows,
    acc.pendingPruning,
    acc.lastAssistantRowIndexSinceUser,
    acc.latestUserMessage,
    busy,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
    activityState,
  );

  if (busy && activityState) {
    attachActivityState(rows, activityState);
  }

  if (hasNewer) {
    rows.push({ kind: 'bottomGap', key: 'gap:newer' });
  }
  return rows;
}

export function estimateTranscriptRowSize(row: TranscriptRow): number {
  if (row.kind === 'systemPrompts') {
    return 140;
  }
  if (row.kind === 'topGap' || row.kind === 'bottomGap') {
    return 56;
  }
  if (row.kind === 'typingIndicator') {
    return 40 + estimateActivityTailHeight(row.activityState?.tail);
  }
  if (row.message.role === 'user') return 120;
  const tailHeight = estimateActivityTailHeight(row.activityState?.tail);
  return (row.pruningHeaderState?.kind === 'result' ? 220 : 180) + tailHeight;
}
