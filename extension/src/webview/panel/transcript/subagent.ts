import type { ChatMessage, ChatMessagePart, ToolCall } from '../../../shared/protocol';
import { formatToolResult } from '../../../shared/tool-result-format';
import {
  appendAssistantTextPart,
  assistantPartsFromMessage,
  mergeAssistantParts,
  reasoningFromMessageParts,
  textFromMessageParts,
  toolCallsFromMessageParts,
  upsertAssistantToolPart,
} from './parts';
import {
  isSubagentSingleResultFailed,
  isSubagentSingleResultRunning,
  nonEmptyText,
  subagentSingleResultFallbackMarkdown,
  type RawContentPart,
  type RawMessage,
  type SubagentSingleResult,
} from '../../../shared/subagent-result';

// The subagent result extraction + types now live in shared/subagent-result.ts
// (reused by the host-side token-rate measurement). Re-export the public
// extraction API + types here so existing webview importers (activity-tail,
// transcript index, tool-call-item) keep their `from './subagent'` imports
// unchanged.
export {
  getRenderableSubagentResult,
  getRenderableSubagentResultFromToolCall,
  isSubagentSingleResultInterrupted,
  isSubagentSingleResultRunning,
} from '../../../shared/subagent-result';
export type { SubagentResult, SubagentSingleResult } from '../../../shared/subagent-result';

interface RawToolResultSnapshot {
  result: unknown;
  status: ToolCall['status'];
}

function rawMessageParts(message: RawMessage): RawContentPart[] {
  return Array.isArray(message.content) ? message.content : [];
}

function rawMessageText(message: RawMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return rawMessageParts(message)
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n');
}

function collectRawToolResults(rawMessages: RawMessage[]): Map<string, RawToolResultSnapshot> {
  const toolResultMap = new Map<string, RawToolResultSnapshot>();

  for (const msg of rawMessages) {
    if (msg.role === 'toolResult' && msg.toolCallId) {
      toolResultMap.set(String(msg.toolCallId), {
        result: formatToolResult(msg),
        status: msg.isError ? 'failed' : 'completed',
      });
      continue;
    }

    if (msg.role !== 'user') {
      continue;
    }

    for (const part of rawMessageParts(msg)) {
      if (part.type === 'toolResult' && part.id !== undefined) {
        toolResultMap.set(String(part.id), {
          result: part.result,
          status: 'completed',
        });
      }
    }
  }

  return toolResultMap;
}

function shouldSkipMessage(msg: RawMessage): boolean {
  if (msg.role === 'toolResult') {
    return true;
  }

  const contentParts = rawMessageParts(msg);
  if (msg.role === 'user' && contentParts.length > 0 && contentParts.every((part) => part.type === 'toolResult')) {
    return true;
  }

  return false;
}

function createUserChatMessage(msg: RawMessage, idPrefix: string, idx: number): ChatMessage {
  return {
    id: `${idPrefix}-${idx}`,
    role: 'user',
    createdAt: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
    markdown: rawMessageText(msg),
    status: 'completed',
  };
}

function appendRawContentPart(
  part: RawContentPart,
  orderedParts: ChatMessagePart[],
  toolResultMap: Map<string, RawToolResultSnapshot>,
): void {
  if (part.type === 'text') {
    appendAssistantTextPart(orderedParts, 'text', part.text ?? '');
    return;
  }

  if (part.type === 'thinking') {
    appendAssistantTextPart(orderedParts, 'reasoning', part.thinking ?? '');
    return;
  }

  if (part.type === 'toolCall' && part.id && part.name) {
    const toolResult = toolResultMap.get(String(part.id));
    // A partial result may be stamped directly on the toolCall part by the
    // subagent runner's `tool_execution_update` handler (the event that carries
    // nested depth-2 streaming). It surfaces while the tool is still running —
    // before its toolResult message lands — so the nested block renders its
    // live streaming text instead of a blank "(running…)" placeholder. A
    // completed toolResult (from the map) always takes precedence once present.
    upsertAssistantToolPart(orderedParts, {
      id: part.id,
      name: part.name,
      input: part.arguments ?? {},
      result: toolResult?.result ?? part.result,
      status: toolResult?.status ?? 'running',
    });
  }
}

function buildAssistantParts(
  msg: RawMessage,
  toolResultMap: Map<string, RawToolResultSnapshot>,
): ChatMessagePart[] {
  const orderedParts: ChatMessagePart[] = [];

  if (typeof msg.content === 'string') {
    appendAssistantTextPart(orderedParts, 'text', msg.content);
  }

  for (const part of rawMessageParts(msg)) {
    appendRawContentPart(part, orderedParts, toolResultMap);
  }

  return orderedParts;
}

function mergeIntoAssistant(currentAssistant: ChatMessage, orderedParts: ChatMessagePart[]): void {
  const mergedParts = mergeAssistantParts(assistantPartsFromMessage(currentAssistant), orderedParts);
  currentAssistant.parts = mergedParts;
  currentAssistant.markdown = textFromMessageParts(mergedParts);
  currentAssistant.thinking = reasoningFromMessageParts(mergedParts);
  currentAssistant.toolCalls = toolCallsFromMessageParts(mergedParts);
}

function createAssistantChatMessage(
  msg: RawMessage,
  orderedParts: ChatMessagePart[],
  idPrefix: string,
  idx: number,
): ChatMessage {
  const markdown = textFromMessageParts(orderedParts);
  const thinking = reasoningFromMessageParts(orderedParts);
  const toolCalls = toolCallsFromMessageParts(orderedParts);

  return {
    id: `${idPrefix}-${idx}`,
    role: 'assistant',
    createdAt: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
    markdown,
    parts: orderedParts.length > 0 ? orderedParts : undefined,
    thinking,
    status: 'completed',
    toolCalls,
  };
}

export function rawMessagesToChatMessages(rawMessages: RawMessage[], idPrefix: string): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  const toolResultMap = collectRawToolResults(rawMessages);

  let idx = 0;
  let currentAssistant: ChatMessage | undefined;

  for (const msg of rawMessages) {
    if (shouldSkipMessage(msg)) {
      continue;
    }

    if (msg.role === 'user') {
      currentAssistant = undefined;
      chatMessages.push(createUserChatMessage(msg, idPrefix, idx++));
      continue;
    }

    if (msg.role === 'assistant') {
      const orderedParts = buildAssistantParts(msg, toolResultMap);

      if (currentAssistant) {
        mergeIntoAssistant(currentAssistant, orderedParts);
      } else {
        currentAssistant = createAssistantChatMessage(msg, orderedParts, idPrefix, idx++);
        chatMessages.push(currentAssistant);
      }
    }
  }

  return chatMessages;
}

function subagentTaskMessage(result: SubagentSingleResult, idPrefix: string): ChatMessage | undefined {
  const task = nonEmptyText(result.task);
  if (!task) {
    return undefined;
  }

  return {
    id: `${idPrefix}-task`,
    role: 'user',
    createdAt: '',
    markdown: task,
    status: 'completed',
  };
}

export function subagentSingleResultToChatMessages(result: SubagentSingleResult, idPrefix: string): ChatMessage[] {
  const chatMessages = rawMessagesToChatMessages(Array.isArray(result.messages) ? result.messages : [], idPrefix);
  const finalOutput = nonEmptyText(result.finalOutput);
  if (!isSubagentSingleResultRunning(result) && finalOutput && !chatMessages.some((message) => message.role === 'assistant' && message.markdown?.trim() === finalOutput)) {
    chatMessages.push({
      id: `${idPrefix}-final-output`,
      role: 'assistant',
      createdAt: '',
      markdown: finalOutput,
      status: isSubagentSingleResultFailed(result) ? 'error' : 'completed',
    });
  }
  const hasExplicitUserTask = chatMessages.some((message) => message.role === 'user');
  const taskMessage = hasExplicitUserTask ? undefined : subagentTaskMessage(result, idPrefix);

  if (chatMessages.length > 0) {
    return taskMessage ? [taskMessage, ...chatMessages] : chatMessages;
  }

  if (isSubagentSingleResultRunning(result)) {
    const msgs = taskMessage ? [taskMessage] : [];
    const streamText = result.streamingText?.trim();
    if (streamText) {
      msgs.push({
        id: `${idPrefix}-streaming`,
        role: 'assistant',
        createdAt: '',
        markdown: streamText,
        status: 'streaming',
      });
    }
    return msgs;
  }

  return [
    ...(taskMessage ? [taskMessage] : []),
    {
      id: `${idPrefix}-fallback`,
      role: 'assistant',
      createdAt: '',
      markdown: subagentSingleResultFallbackMarkdown(result),
      status: isSubagentSingleResultFailed(result) ? 'error' : 'completed',
    },
  ];
}
