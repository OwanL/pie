import type { ChatMessage } from '../../lib/protocol/index.js';

/** UI-only identity for keyed rendering and scroll anchoring. */
export function messageRenderIdentity(message: ChatMessage): string {
  return message.renderIdentity ?? message.id;
}
