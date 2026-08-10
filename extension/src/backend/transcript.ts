import type {
  ChatMessage,
  CompactionSummaryDetails,
  SessionSummary,
  ThinkingLevel,
} from '../shared/protocol';
import { COMPACTION_METRICS_CUSTOM_TYPE } from '../shared/protocol';
import { NEW_SESSION_NAME } from '../shared/session-name';
import { formatToolResult } from '../shared/tool-result-format';

import {
  addAssistantUsage,
  applyToolResultToParts,
  appendAssistantParts,
  assistantPartsFromContent,
  assistantStatus,
  isoDate,
  normalizeThinkingLevel,
  systemMessage,
  textFromParts,
  thinkingFromParts,
  toolCallsFromMessageParts,
  usageFromMessage,
  userPartsFromContent,
} from './transcript/content';
import type { AssistantMessageDiagnosticLike, ContentPart, MessageLike } from './transcript/types';

const PROVIDER_TRANSPORT_FAILURE_DIAGNOSTIC = 'provider_transport_failure';

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function formatRequestBytes(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${Math.trunc(value)} B`;
}

export function providerTransportFailureDiagnostic(
  message: Pick<MessageLike, 'diagnostics'>,
): AssistantMessageDiagnosticLike | undefined {
  return [...(message.diagnostics ?? [])]
    .reverse()
    .find((diagnostic) => diagnostic?.type === PROVIDER_TRANSPORT_FAILURE_DIAGNOSTIC);
}

/** Enrich terse provider errors with the phase/recovery data carried by pi-ai.
 * The structured diagnostic remains in the persisted SDK message; this compact
 * rendering makes it visible in Pie's existing per-message error surface. */
export function assistantErrorDetail(
  message: Pick<MessageLike, 'errorMessage' | 'diagnostics'>,
): string | undefined {
  const diagnostic = providerTransportFailureDiagnostic(message);
  const base = nonEmptyString(message.errorMessage) ?? nonEmptyString(diagnostic?.error?.message);
  if (!diagnostic) return base;

  const details = diagnostic.details ?? {};
  const phase = details.phase === 'after_message_stream_start'
    ? 'after output began'
    : details.phase === 'before_message_stream_start'
      ? 'before output began'
      : undefined;
  const configuredTransport = nonEmptyString(details.configuredTransport);
  const requestSize = formatRequestBytes(details.requestBytes);
  const closeCode = diagnostic.error?.code;
  const facts = [
    configuredTransport ? `configured: ${configuredTransport}` : undefined,
    requestSize ? `request: ${requestSize}` : undefined,
    typeof closeCode === 'string' || typeof closeCode === 'number' ? `close code: ${closeCode}` : undefined,
  ].filter((value): value is string => !!value);
  const factText = facts.length > 0 ? ` (${facts.join('; ')})` : '';
  const recovery = details.phase === 'after_message_stream_start'
    ? 'If this turn is retried, it and later requests for this session will use SSE.'
    : details.fallbackTransport === 'sse'
      ? 'SSE fallback was attempted.'
      : undefined;
  const transportDetail = `WebSocket transport failed${phase ? ` ${phase}` : ''}${factText}.`;
  const baseSentence = base ? (/[.!?]$/.test(base) ? base : `${base}.`) : undefined;
  return [baseSentence, transportDetail, recovery].filter(Boolean).join(' ');
}

interface SessionInfoLike {
  path: string;
  cwd: string;
  name?: string;
  modified: Date;
  messageCount: number;
}

export interface SessionEntryLike {
  id: string;
  timestamp: string;
  type: string;
  summary?: string;
  tokensBefore?: number;
  thinkingLevel?: string;
  modelId?: string;
  provider?: string;
  message?: MessageLike;
  customType?: string;
  display?: boolean;
  content?: unknown;
  details?: unknown;
  /** Opaque `data` payload on a `custom` sidecar entry (appended via the SDK's
   *  `appendCustomEntry`). Not rendered; scanned by `mapTranscript` to attach
   *  typed details to the matching compaction-summary message. */
  data?: unknown;
}

export function summarizeSession(info: SessionInfoLike, modelId?: string): SessionSummary {
  const hasName = !!info.name;
  return {
    path: info.path,
    cwd: info.cwd,
    name: hasName ? info.name! : NEW_SESSION_NAME,
    isPlaceholder: !hasName,
    modifiedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
    modelId,
  };
}

export function mapAssistantMessage(
  messageId: string,
  message: MessageLike,
  durationMs?: number,
  metadata?: {
    modelId?: string;
    provider?: string;
    thinkingLevel?: ThinkingLevel;
    turnLatencyMs?: number;
    overheadMs?: number;
    providerLatencyMs?: number;
    providerQueueMs?: number;
    providerQueueAttemptCount?: number;
  },
): ChatMessage {
  const parts = Array.isArray(message.content) ? message.content : undefined;
  const messageParts = assistantPartsFromContent(parts, 'completed');
  return {
    id: messageId,
    role: 'assistant',
    createdAt: new Date(message.timestamp ?? Date.now()).toISOString(),
    markdown: textFromParts(parts),
    parts: messageParts,
    thinking: thinkingFromParts(parts),
    modelId: message.model ?? metadata?.modelId,
    provider: message.provider ?? metadata?.provider,
    thinkingLevel: metadata?.thinkingLevel,
    status: assistantStatus(message),
    errorDetail: assistantErrorDetail(message),
    toolCalls: toolCallsFromMessageParts(messageParts),
    durationMs,
    turnLatencyMs: metadata?.turnLatencyMs,
    overheadMs: metadata?.overheadMs,
    providerLatencyMs: metadata?.providerLatencyMs,
    providerQueueMs: metadata?.providerQueueMs,
    providerQueueAttemptCount: metadata?.providerQueueAttemptCount,
    usage: usageFromMessage(message),
  };
}

function customMessageMarkdown(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return textFromParts(content);
  }
  return content == null ? '' : String(content);
}

export function mapCustomMessage(
  messageId: string,
  message: {
    content?: unknown;
    timestamp?: string | number;
    customType?: string;
    display?: boolean;
    details?: unknown;
  },
): ChatMessage | null {
  if (message.display === false) {
    return null;
  }

  const markdown = customMessageMarkdown(message.content);
  if (!markdown) {
    return null;
  }

  const mapped = systemMessage(
    messageId,
    new Date(message.timestamp ?? Date.now()).toISOString(),
    markdown,
  );
  if (message.customType) {
    mapped.customType = message.customType;
  }
  if (message.details !== undefined) {
    mapped.customDetails = message.details;
  }
  return mapped;
}

interface MapLoopState {
  currentAssistant: ChatMessage | undefined;
  currentModelId: string | undefined;
  currentProvider: string | undefined;
  currentThinkingLevel: ThinkingLevel | undefined;
  /** Compaction metrics scanned from `pie.compaction-metrics` sidecar entries,
   *  keyed by the compaction entry id they link to. Populated by a pre-scan
   *  in {@link mapTranscript}; consumed by {@link dispatchSummaryEntry} to
   *  attach typed {@link CompactionSummaryDetails} to the matching
   *  `compaction-summary` ChatMessage. Sidecars themselves never render. */
  compactionMetricsByEntryId: Map<string, CompactionSummaryDetails>;
}

type MapResult =
  | { kind: 'push'; message: ChatMessage; resetAssistant: boolean }
  | { kind: 'skip' };

/** Append a user-role message and return a `push` directive. */
function mapUserMessage(entry: SessionEntryLike, message: MessageLike): MapResult {
  const userParts = userPartsFromContent(message.content);
  const hasImageParts = userParts?.some((part) => part.kind === 'image') ?? false;
  const markdown =
    typeof message.content === 'string'
      ? message.content
      : textFromParts(message.content);
  return {
    kind: 'push',
    resetAssistant: true,
    message: {
      id: entry.id,
      role: 'user',
      createdAt: isoDate(entry.timestamp, message.timestamp),
      markdown,
      userParts: hasImageParts ? userParts : undefined,
      status: 'completed',
    },
  };
}

/** Append a bash-execution entry as a fenced powershell system message. */
function mapBashExecution(entry: SessionEntryLike, message: MessageLike): MapResult {
  return {
    kind: 'push',
    resetAssistant: true,
    message: systemMessage(
      entry.id,
      isoDate(entry.timestamp, message.timestamp),
      ['```powershell', message.command ?? '', message.output ?? '', '```'].join('\n'),
    ),
  };
}

/** Apply a toolResult entry to the current assistant bubble. */
function mapToolResultMessage(entry: SessionEntryLike, message: MessageLike, state: MapLoopState): MapResult {
  const currentAssistant = state.currentAssistant;
  if (currentAssistant) {
    applyToolResultToParts(
      currentAssistant.parts,
      message.toolCallId,
      formatToolResult(message),
      message.isError ? 'failed' : 'completed',
      entry.id,
    );
    currentAssistant.toolCalls = toolCallsFromMessageParts(currentAssistant.parts);
  }
  return { kind: 'skip' };
}

/** Merge a new assistant turn into the current bubble, or push a new one. */
function mapAssistantTurn(
  entry: SessionEntryLike,
  message: MessageLike,
  state: MapLoopState,
): MapResult {
  const parts = Array.isArray(message.content) ? message.content : undefined;
  const messageParts = assistantPartsFromContent(parts);
  const entryTs = new Date(entry.timestamp).getTime();
  const durationMs = typeof message.timestamp === 'number' && entryTs > message.timestamp
    ? entryTs - message.timestamp
    : undefined;
  const assistantModelId = message.model ?? state.currentModelId;
  const hasDistinctModel = !!message.model && message.model !== state.currentModelId;
  const assistantProvider = message.provider ?? (hasDistinctModel ? undefined : state.currentProvider);
  const assistantThinkingLevel = state.currentThinkingLevel;
  const turnUsage = usageFromMessage(message);
  if (message.model) {
    state.currentModelId = message.model;
    if (hasDistinctModel && !message.provider) state.currentProvider = undefined;
  }
  if (message.provider) state.currentProvider = message.provider;

  const currentAssistant = state.currentAssistant;
  if (currentAssistant) {
    mergeAssistantTurn(currentAssistant, parts, messageParts, {
      modelId: assistantModelId,
      provider: assistantProvider,
      thinkingLevel: assistantThinkingLevel,
      durationMs,
      turnUsage,
      errorDetail: assistantErrorDetail(message),
      status: assistantStatus(message),
      durableEntryId: entry.id,
    });
    return { kind: 'skip' };
  }

  const next: ChatMessage = {
    id: entry.id,
    role: 'assistant',
    createdAt: isoDate(entry.timestamp, message.timestamp),
    markdown: parts ? textFromParts(parts) : '',
    parts: messageParts,
    thinking: parts ? thinkingFromParts(parts) : undefined,
    modelId: assistantModelId,
    provider: assistantProvider,
    thinkingLevel: assistantThinkingLevel,
    status: assistantStatus(message),
    errorDetail: assistantErrorDetail(message),
    toolCalls: toolCallsFromMessageParts(messageParts),
    durationMs,
    usage: turnUsage,
    durableEntryId: entry.id,
  };
  state.currentAssistant = next;
  return { kind: 'push', resetAssistant: false, message: next };
}

function mergeAssistantTurn(
  current: ChatMessage,
  parts: ContentPart[] | undefined,
  messageParts: ChatMessage['parts'],
  update: {
    modelId: string | undefined;
    provider: string | undefined;
    thinkingLevel: ThinkingLevel | undefined;
    durationMs: number | undefined;
    turnUsage: ReturnType<typeof usageFromMessage>;
    errorDetail: string | undefined;
    status: ChatMessage['status'];
    durableEntryId: string;
  },
): void {
  const newText = parts ? textFromParts(parts) : '';
  const newThinking = parts ? thinkingFromParts(parts) : undefined;

  if (newThinking) {
    current.thinking = current.thinking
      ? `${current.thinking}\n\n${newThinking}`
      : newThinking;
  }
  if (newText) {
    current.markdown = current.markdown
      ? `${current.markdown}\n\n${newText}`
      : newText;
  }
  appendAssistantParts(current, messageParts, true);
  current.toolCalls = toolCallsFromMessageParts(current.parts);
  current.status = update.status;
  current.durableEntryId = update.durableEntryId;
  if (update.errorDetail) {
    current.errorDetail = update.errorDetail;
  }
  if (update.modelId) {
    current.modelId = update.modelId;
  }
  current.provider = update.provider;
  if (update.thinkingLevel) {
    current.thinkingLevel = update.thinkingLevel;
  }
  if (update.durationMs !== undefined) {
    current.durationMs = (current.durationMs ?? 0) + update.durationMs;
  }
  current.usage = addAssistantUsage(current.usage, update.turnUsage);
}

/** Dispatch a single message entry by its role. */
function dispatchMessageEntry(
  entry: SessionEntryLike,
  message: MessageLike,
  state: MapLoopState,
): MapResult {
  switch (message.role) {
    case 'user':
      return mapUserMessage(entry, message);
    case 'assistant':
      return mapAssistantTurn(entry, message, state);
    case 'toolResult':
      return mapToolResultMessage(entry, message, state);
    case 'bashExecution':
      return mapBashExecution(entry, message);
    case 'custom':
      return dispatchCustomFromMessage(entry, message, state);
    default:
      return { kind: 'skip' };
  }
}

function dispatchCustomFromMessage(
  entry: SessionEntryLike,
  message: MessageLike,
  state: MapLoopState,
): MapResult {
  return applyCustomMessage(
    mapCustomMessage(entry.id, {
      content: message.content,
      timestamp: message.timestamp,
      customType: message.customType,
      display: message.display,
      details: message.details,
    }),
    state,
  );
}

function dispatchCustomEntry(entry: SessionEntryLike, state: MapLoopState): MapResult {
  return applyCustomMessage(
    mapCustomMessage(entry.id, {
      content: entry.content,
      timestamp: entry.timestamp,
      customType: entry.customType,
      display: entry.display,
      details: (entry as { details?: unknown }).details,
    }),
    state,
  );
}

function applyCustomMessage(message: ChatMessage | null, state: MapLoopState): MapResult {
  if (!message) {
    return { kind: 'skip' };
  }
  state.currentAssistant = undefined;
  return { kind: 'push', resetAssistant: true, message };
}

/** Coerce a single sidecar `data` payload into a typed
 *  {@link CompactionSummaryDetails} linked to its compaction entry. Returns
 *  `undefined` for malformed/legacy payloads (missing `compactionEntryId`, or
 *  no usable token metric) so the compaction-summary row renders without
 *  metrics rather than with garbage. */
function parseCompactionMetricsSidecar(
  data: unknown,
): { compactionEntryId: string; details: CompactionSummaryDetails } | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const raw = data as Record<string, unknown>;
  const compactionEntryId =
    typeof raw.compactionEntryId === 'string' && raw.compactionEntryId.length > 0
      ? raw.compactionEntryId
      : undefined;
  if (!compactionEntryId) return undefined;

  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  const tokensBefore =
    typeof raw.tokensBefore === 'number' && Number.isFinite(raw.tokensBefore) && raw.tokensBefore >= 0
      ? raw.tokensBefore
      : undefined;
  const estimatedTokensAfter =
    typeof raw.estimatedTokensAfter === 'number' && Number.isFinite(raw.estimatedTokensAfter) && raw.estimatedTokensAfter >= 0
      ? raw.estimatedTokensAfter
      : undefined;
  // Need at least one token metric for the details to be useful; a sidecar
  // with neither is treated as malformed and dropped.
  if (tokensBefore === undefined && estimatedTokensAfter === undefined) return undefined;

  const details: CompactionSummaryDetails = { reason };
  if (tokensBefore !== undefined) details.tokensBefore = tokensBefore;
  if (estimatedTokensAfter !== undefined) details.estimatedTokensAfter = estimatedTokensAfter;
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0) {
    details.durationMs = raw.durationMs;
  }
  if (typeof raw.modelId === 'string' && raw.modelId.length > 0) details.modelId = raw.modelId;
  if (typeof raw.provider === 'string' && raw.provider.length > 0) details.provider = raw.provider;
  if (typeof raw.thinkingLevel === 'string' && raw.thinkingLevel.length > 0) {
    details.thinkingLevel = raw.thinkingLevel;
  }
  return { compactionEntryId, details };
}

/** Pre-scan the branch for `pie.compaction-metrics` sidecar entries and build
 *  a map keyed by the compaction entry id each sidecar links to. Later
 *  sidecars win (forward iteration overwrites), so a retry that appended a
 *  fresh sidecar for the same compaction entry supersedes the earlier one.
 *  Sidecars with no matching compaction entry are still collected (harmless if
 *  the entry was branched away) and silently ignored at attach time. */
function scanCompactionMetricsSidecars(
  entries: SessionEntryLike[],
): Map<string, CompactionSummaryDetails> {
  const map = new Map<string, CompactionSummaryDetails>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== COMPACTION_METRICS_CUSTOM_TYPE) continue;
    const parsed = parseCompactionMetricsSidecar(entry.data);
    if (!parsed) continue;
    map.set(parsed.compactionEntryId, parsed.details);
  }
  return map;
}

function dispatchSummaryEntry(
  entry: SessionEntryLike,
  heading: string,
  state: MapLoopState,
): MapResult {
  if (!entry.summary) {
    return { kind: 'skip' };
  }
  state.currentAssistant = undefined;
  const metrics = entry.type === 'compaction'
    ? state.compactionMetricsByEntryId.get(entry.id)
    : undefined;
  return {
    kind: 'push',
    resetAssistant: true,
    message: {
      ...systemMessage(
        entry.id,
        new Date(entry.timestamp).toISOString(),
        entry.type === 'compaction' ? entry.summary : `${heading}\n\n${entry.summary}`,
      ),
      // Compaction entries are replacement context, not a conversational
      // system instruction. Preserve that distinction so the webview can
      // render their potentially large summary as a collapsed transcript row.
      ...(entry.type === 'compaction' ? { customType: 'compaction-summary' } : {}),
      // Attach the durable compaction metrics scanned from the
      // `pie.compaction-metrics` sidecar (if present) so the webview can
      // render reason / before→after tokens / reduction / model / duration
      // without re-parsing the sidecar.
      ...(metrics ? { customDetails: metrics } : {}),
    },
  };
}

export function mapTranscript(entries: SessionEntryLike[]): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  const state: MapLoopState = {
    currentAssistant: undefined,
    currentModelId: undefined,
    currentProvider: undefined,
    currentThinkingLevel: undefined,
    compactionMetricsByEntryId: scanCompactionMetricsSidecars(entries),
  };

  for (const entry of entries) {
    const result = dispatchEntry(entry, state);
    applyResult(result, transcript, state);
  }

  return transcript;
}

function dispatchEntry(entry: SessionEntryLike, state: MapLoopState): MapResult {
  switch (entry.type) {
    case 'model_change':
      state.currentModelId = entry.modelId;
      state.currentProvider = entry.provider;
      return { kind: 'skip' };
    case 'thinking_level_change':
      state.currentThinkingLevel = normalizeThinkingLevel(entry.thinkingLevel);
      return { kind: 'skip' };
    case 'message':
      return entry.message ? dispatchMessageEntry(entry, entry.message, state) : { kind: 'skip' };
    case 'custom_message':
      return dispatchCustomEntry(entry, state);
    case 'custom':
      // The `pie.compaction-metrics` sidecar is a non-context `custom` entry
      // appended after a successful compaction. It carries no `content` (its
      // payload is in `data`), so it would already be skipped by
      // `mapCustomMessage`, but short-circuit here to make the intent explicit
      // and keep future data-only sidecar customTypes from accidentally
      // rendering. The metrics were already captured by the pre-scan in
      // `mapTranscript`.
      if (entry.customType === COMPACTION_METRICS_CUSTOM_TYPE) {
        return { kind: 'skip' };
      }
      return dispatchCustomEntry(entry, state);
    case 'branch_summary':
      return dispatchSummaryEntry(entry, 'Branch summary', state);
    case 'compaction':
      return dispatchSummaryEntry(entry, 'Compaction summary', state);
    default:
      return { kind: 'skip' };
  }
}

function applyResult(result: MapResult, transcript: ChatMessage[], state: MapLoopState): void {
  if (result.kind !== 'push') {
    return;
  }
  transcript.push(result.message);
  if (result.resetAssistant) {
    state.currentAssistant = undefined;
  }
}
