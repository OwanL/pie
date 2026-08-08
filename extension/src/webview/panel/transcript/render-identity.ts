import type { ChatMessage } from '../../../shared/protocol';

/** UI-only identity for keyed rendering and scroll anchoring. */
export function messageRenderIdentity(message: ChatMessage): string {
  return message.renderIdentity ?? message.id;
}
