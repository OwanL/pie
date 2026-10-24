import type { ChatMessage } from '../../lib/protocol/index.js';
import { AGENT_MESSAGE_CUSTOM_TYPE } from '../../lib/protocol/messages.js';

export type AgentMessageCue = 'Task' | 'Note' | 'Result';

export interface AgentMessageMetadata {
  senderLabel?: string;
  cue?: AgentMessageCue;
  taskRevision?: number;
}

export function isAgentMessage(message: Pick<ChatMessage, 'customType'>): boolean {
  return message.customType === AGENT_MESSAGE_CUSTOM_TYPE;
}

/** Shared sender/cue projection for the durable message header and sticky prompt context. */
export function agentMessageMetadata(
  message: Pick<ChatMessage, 'customType' | 'sender' | 'customDetails'>,
): AgentMessageMetadata | null {
  if (!isAgentMessage(message)) return null;

  const details = message.customDetails && typeof message.customDetails === 'object'
    ? message.customDetails as { kind?: unknown; taskRevision?: unknown }
    : undefined;
  const isTaskAssignment = message.sender?.message?.kind === 'assignment';
  const cue: AgentMessageCue | undefined = isTaskAssignment
    ? 'Task'
    : details?.kind === 'note'
      ? 'Note'
      : details?.kind === 'result' ? 'Result' : undefined;
  const taskRevision = isTaskAssignment
    ? message.sender?.message?.taskRevision
    : details?.taskRevision;

  return {
    ...(message.sender ? { senderLabel: message.sender.title ?? 'Unnamed session' } : {}),
    ...(cue ? { cue } : {}),
    ...(typeof taskRevision === 'number' ? { taskRevision } : {}),
  };
}
