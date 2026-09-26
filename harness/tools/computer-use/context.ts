import type { ContextEvent } from '@earendil-works/pi-coding-agent';

export const COMPUTER_CONTEXT_IMAGE_LIMIT = 3;

type ContextMessage = ContextEvent['messages'][number];
type ContentPart = { type: string };
type ComputerToolResult = {
  role: 'toolResult';
  toolName: 'computer';
  content: readonly ContentPart[];
};

function isComputerToolResult(message: ContextMessage): message is ContextMessage & ComputerToolResult {
  return typeof message === 'object'
    && message !== null
    && 'role' in message
    && message.role === 'toolResult'
    && 'toolName' in message
    && message.toolName === 'computer'
    && 'content' in message
    && Array.isArray(message.content);
}

/**
 * Produces outgoing LLM context with only the newest computer screenshot parts.
 * Session messages are never modified.
 */
export function projectComputerImageContext(messages: readonly ContextMessage[]): ContextMessage[] {
  const projected = [...messages];
  let remainingImages = COMPUTER_CONTEXT_IMAGE_LIMIT;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!isComputerToolResult(message)) continue;

    const removedParts = new Set<number>();
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      if (message.content[partIndex].type !== 'image') continue;
      if (remainingImages > 0) remainingImages -= 1;
      else removedParts.add(partIndex);
    }

    if (removedParts.size > 0) {
      projected[messageIndex] = {
        ...message,
        content: message.content.filter((_part, partIndex) => !removedParts.has(partIndex)),
      } as ContextMessage;
    }
  }

  return projected;
}
