import type { SessionOpenedPayload } from '../../agent-processes/lib/rpc/session-events.js';

/** Interrupt dangling tool calls and streaming rows left by a prior process
 *  end, preserving durable terminals. Used when reopening an inactive session
 *  and when bounding transport snapshots. */
export function normalizeDanglingTranscript(
  transcript: SessionOpenedPayload['transcript'],
): SessionOpenedPayload['transcript'] {
  return transcript.map((message) => {
    const hasDanglingTool = message.toolCalls?.some((tool) => tool.status === 'running') ?? false;
    if (!hasDanglingTool && message.status !== 'streaming') return message;
    const toolCalls = message.toolCalls?.map((tool) => tool.status === 'running'
      ? { ...tool, status: 'failed' as const }
      : tool);
    const parts = message.parts?.map((part) => part.kind === 'toolCall'
      ? { kind: 'toolCall' as const, toolCall: toolCalls?.find((tool) => tool.id === part.toolCall.id) ?? part.toolCall }
      : part);
    return {
      ...message,
      status: 'interrupted' as const,
      errorDetail: message.errorDetail ?? 'The prior process ended before this turn completed.',
      toolCalls,
      parts,
    };
  });
}