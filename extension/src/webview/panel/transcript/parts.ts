import type { ChatMessage, ComposerInput, UserContentPart } from '../../../shared/protocol';

export {
  appendAssistantTextPart,
  assistantPartsFromMessage,
  mergeAssistantParts,
  reasoningFromMessageParts,
  textFromMessageParts,
  toolCallsFromMessageParts,
  upsertAssistantToolPart,
} from '../../../shared/chat-message-parts';

export function getRenderableUserParts(
  message: Pick<ChatMessage, 'role' | 'markdown' | 'userParts'>,
): UserContentPart[] | undefined {
  if (message.role !== 'user') {
    return undefined;
  }

  if (message.userParts && message.userParts.length > 0) {
    return message.userParts;
  }

  if (!message.markdown) {
    return undefined;
  }

  return [{ kind: 'text', text: message.markdown }];
}

export function messageHasUserImages(message: Pick<ChatMessage, 'role' | 'userParts'>): boolean {
  if (message.role !== 'user') {
    return false;
  }

  return message.userParts?.some((part) => part.kind === 'image') ?? false;
}

export function userImageSrc(part: Extract<UserContentPart, { kind: 'image' }>): string {
  return `data:${part.mimeType};base64,${part.dataBase64}`;
}

/** Seeds the inline editor with a user message's existing image parts as
 *  `ComposerInput[]` (one entry per image). Text parts are intentionally
 *  excluded — the inline editor seeds its text field from `message.markdown`. */
export function userImagePartsToInputs(message: Pick<ChatMessage, 'userParts'>): ComposerInput[] {
  return (message.userParts ?? [])
    .filter((part): part is Extract<UserContentPart, { kind: 'image' }> => part.kind === 'image')
    .map((part) => ({
      id: crypto.randomUUID(),
      kind: 'imageBlob' as const,
      mimeType: part.mimeType,
      name: part.name || 'image',
      sizeBytes: Math.floor((part.dataBase64.length * 3) / 4),
      dataBase64: part.dataBase64,
      width: part.width,
      height: part.height,
      source: 'drop' as const,
    }));
}
