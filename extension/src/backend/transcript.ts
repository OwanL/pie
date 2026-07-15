import type {
  ChatMessage,
  SessionSummary,
  ThinkingLevel,
} from '../shared/protocol';
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
import type { ContentPart, MessageLike } from './transcript/types';

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
  message?: MessageLike;
  customType?: string;
  display?: boolean;
  content?: unknown;
  details?: unknown;
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
    thinkingLevel?: ThinkingLevel;
    turnLatencyMs?: number;
    overheadMs?: number;
    providerLatencyMs?: number;
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
    thinkingLevel: metadata?.thinkingLevel,
    status: assistantStatus(message),
    errorDetail: message.errorMessage,
    toolCalls: toolCallsFromMessageParts(messageParts),
    durationMs,
    turnLatencyMs: metadata?.turnLatencyMs,
    overheadMs: metadata?.overheadMs,
    providerLatencyMs: metadata?.providerLatencyMs,
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
  currentThinkingLevel: ThinkingLevel | undefined;
}

type MapResult =
  | { kind: 'push'; message: ChatMessage; resetAssistant: boolean }
  | { kind: 'skip' };

/** Prefix that marks a deferred-trigger wake-up user message (see
 *  `DeferredTriggerRegistry.dispatchWakeUp`). The SDK persists the wake-up as
 *  a plain user message without custom metadata, so on reload we re-derive the
 *  `deferred-trigger` tag from this stable prefix. */
const DEFERRED_TRIGGER_PREFIX = '[deferred trigger fired: ';

/** Append a user-role message and return a `push` directive. */
function mapUserMessage(entry: SessionEntryLike, message: MessageLike): MapResult {
  const userParts = userPartsFromContent(message.content);
  const hasImageParts = userParts?.some((part) => part.kind === 'image') ?? false;
  const markdown =
    typeof message.content === 'string'
      ? message.content
      : textFromParts(message.content);
  // Re-derive the deferred-trigger tag from the wake-up text prefix so the
  // webview differentiation survives transcript reload (the SDK writes user
  // messages without customType). Parse the reason up to the closing bracket.
  let customType: string | undefined;
  let customDetails: unknown;
  if (markdown.startsWith(DEFERRED_TRIGGER_PREFIX)) {
    const end = markdown.indexOf(']', DEFERRED_TRIGGER_PREFIX.length);
    const reason = end === -1
      ? markdown.slice(DEFERRED_TRIGGER_PREFIX.length).trim()
      : markdown.slice(DEFERRED_TRIGGER_PREFIX.length, end).trim();
    customType = 'deferred-trigger';
    customDetails = { reason };
  }
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
      ...(customType !== undefined ? { customType } : {}),
      ...(customDetails !== undefined ? { customDetails } : {}),
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
  const assistantThinkingLevel = state.currentThinkingLevel;
  const turnUsage = usageFromMessage(message);
  if (message.model) {
    state.currentModelId = message.model;
  }

  const currentAssistant = state.currentAssistant;
  if (currentAssistant) {
    mergeAssistantTurn(currentAssistant, parts, messageParts, {
      modelId: assistantModelId,
      thinkingLevel: assistantThinkingLevel,
      durationMs,
      turnUsage,
      errorMessage: message.errorMessage,
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
    thinkingLevel: assistantThinkingLevel,
    status: assistantStatus(message),
    errorDetail: message.errorMessage,
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
    thinkingLevel: ThinkingLevel | undefined;
    durationMs: number | undefined;
    turnUsage: ReturnType<typeof usageFromMessage>;
    errorMessage: string | undefined;
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
  if (update.errorMessage) {
    current.errorDetail = update.errorMessage;
  }
  if (update.modelId) {
    current.modelId = update.modelId;
  }
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

function dispatchSummaryEntry(
  entry: SessionEntryLike,
  heading: string,
  state: MapLoopState,
): MapResult {
  if (!entry.summary) {
    return { kind: 'skip' };
  }
  state.currentAssistant = undefined;
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
    },
  };
}

export function mapTranscript(entries: SessionEntryLike[]): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  const state: MapLoopState = {
    currentAssistant: undefined,
    currentModelId: undefined,
    currentThinkingLevel: undefined,
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
      return { kind: 'skip' };
    case 'thinking_level_change':
      state.currentThinkingLevel = normalizeThinkingLevel(entry.thinkingLevel);
      return { kind: 'skip' };
    case 'message':
      return entry.message ? dispatchMessageEntry(entry, entry.message, state) : { kind: 'skip' };
    case 'custom_message':
    case 'custom':
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
