import type { ChatMessage, ChatPrefs, PruningSettings, ToolCall } from '../../../shared/protocol';
import { assistantPartsFromMessage, toolCallsFromMessageParts } from '../../../shared/chat-message-parts';
import { isPruningResultMessage } from './pruning';
import {
  deriveMultiToolTail,
  deriveRunningToolTail,
  deriveStreamingTail,
  type TurnActivityTail,
} from './activity-tail';

export const AGENT_ACTIVITY_LABELS = {
  pruning: 'pruning skills/tools',
  preparing: 'preparing response',
  startingModel: 'starting model',
  responding: 'responding',
  runningTools: 'running tools',
  thinking: 'thinking',
} as const;

export type AgentActivityLabel = typeof AGENT_ACTIVITY_LABELS[keyof typeof AGENT_ACTIVITY_LABELS];

/**
 * Structured in-flight activity state for the current turn.
 * Represents active processing phases only (while busy=true).
 * Terminal states (interrupted, error) are owned by message status UI.
 */
export interface TurnActivityState {
  /** Primary phase identifier: 'preparing' | 'pruning' | 'startingModel' | 'thinking' | 'runningTool' | 'streaming' */
  phase: 'preparing' | 'pruning' | 'startingModel' | 'thinking' | 'runningTool' | 'streaming';
  /** Human-readable label for this phase */
  label: string;
  /** Additional detail text (e.g., specific tool name, tool count) */
  detail?: string;
  /** Visual tone hint: 'neutral' | 'active' | 'processing' */
  tone: 'neutral' | 'active' | 'processing';
  /** Accessible status text for screen readers */
  ariaLabel: string;
  /** Specific running tool name when phase='runningTool' and exactly one tool is running */
  runningToolName?: string;
  /** Summary of running tools when multiple tools are active */
  runningToolSummary?: string;
  /** Selected model label when known before message_start */
  pendingModelLabel?: string;
  /**
   * Compact "last few rows" live-activity tail: the tail of streaming
   * reasoning/reply text, a running tool's input + streaming output, or a
   * running subagent's live activity. Present only while busy and only when a
   * meaningful tail could be derived for the current phase.
   */
  tail?: TurnActivityTail;
}

interface PendingActivityOptions {
  busy: boolean;
  transcript: readonly ChatMessage[];
  prefs: Pick<ChatPrefs, 'extensionToggles' | 'activityTailLines'>;
  pruningSettings: Pick<PruningSettings, 'mode'>;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ChatMessage['thinkingLevel'];
}

function isSkillPrunerActive(
  prefs: Pick<ChatPrefs, 'extensionToggles'>,
  pruningSettings: Pick<PruningSettings, 'mode'>,
): boolean {
  return prefs.extensionToggles['skill-pruner'] !== false && pruningSettings.mode !== 'off';
}

function latestUserIndex(transcript: readonly ChatMessage[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
}

function lastAssistantMessage(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      return message;
    }
  }
  return null;
}

function toolCallsFromAssistant(message: ChatMessage): ToolCall[] {
  return toolCallsFromMessageParts(assistantPartsFromMessage(message)) ?? message.toolCalls ?? [];
}

function formatModelLabel(modelId?: string, thinkingLevel?: ChatMessage['thinkingLevel']): string | undefined {
  if (!modelId) return undefined;
  const model = modelId.split('/').pop() || modelId;
  if (thinkingLevel && thinkingLevel !== 'minimal') {
    return `${model} (${thinkingLevel})`;
  }
  return model;
}

/**
 * Derive structured in-flight activity state for the current turn.
 * Returns null when not busy.
 */
export function deriveTurnActivityState({
  busy,
  transcript,
  prefs,
  pruningSettings,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
}: PendingActivityOptions): TurnActivityState | null {
  if (!busy) {
    return null;
  }

  const userIndex = latestUserIndex(transcript);
  if (userIndex === -1) {
    return {
      phase: 'preparing',
      label: AGENT_ACTIVITY_LABELS.preparing,
      tone: 'neutral',
      ariaLabel: 'Agent is preparing response',
      pendingModelLabel: formatModelLabel(pendingAssistantModelId, pendingAssistantThinkingLevel),
    };
  }

  const currentTurnMessages = transcript.slice(userIndex + 1);
  const assistant = lastAssistantMessage(currentTurnMessages);

  if (assistant) {
    if (assistant.status === 'streaming') {
      const pendingModelLabel = formatModelLabel(assistant.modelId || pendingAssistantModelId, assistant.thinkingLevel || pendingAssistantThinkingLevel);
      const streaming = deriveStreamingTail(assistantPartsFromMessage(assistant), prefs.activityTailLines);
      if (streaming) {
        // `deriveStreamingTail` only surfaces reasoning (reply text is shown in
        // the message body above, not duplicated here), so a present tail is
        // always a reasoning tail.
        return {
          phase: 'streaming',
          label: 'reasoning',
          tone: 'active',
          ariaLabel: 'Agent is reasoning',
          pendingModelLabel,
          tail: streaming.tail,
        };
      }
      return {
        phase: 'streaming',
        label: AGENT_ACTIVITY_LABELS.responding,
        tone: 'active',
        ariaLabel: 'Agent is responding',
        pendingModelLabel,
      };
    }

    const toolCalls = toolCallsFromAssistant(assistant);
    const runningTools = toolCalls.filter((tc) => tc.status === 'running');
    
    if (runningTools.length > 0) {
      const phase = 'runningTool';
      if (runningTools.length === 1) {
        const tool = runningTools[0]!;
        const toolName = tool.name;
        const derived = deriveRunningToolTail(tool, prefs.activityTailLines);
        if (derived) {
          return {
            phase,
            label: derived.label,
            detail: undefined,
            tone: 'active',
            ariaLabel: `Agent is running ${toolName}`,
            runningToolName: toolName,
            tail: derived.tail,
          };
        }
        return {
          phase,
          label: `running ${toolName}`,
          detail: undefined,
          tone: 'active',
          ariaLabel: `Agent is running ${toolName}`,
          runningToolName: toolName,
        };
      } else {
        const summary = `running ${runningTools.length} tools`;
        const derived = deriveMultiToolTail(runningTools, prefs.activityTailLines);
        return {
          phase,
          label: summary,
          detail: runningTools.map((tc) => tc.name).join(', '),
          tone: 'active',
          ariaLabel: `Agent is ${summary}`,
          runningToolSummary: summary,
          tail: derived.tail,
        };
      }
    }

    return {
      phase: 'thinking',
      label: AGENT_ACTIVITY_LABELS.thinking,
      tone: 'processing',
      ariaLabel: 'Agent is thinking',
      pendingModelLabel: formatModelLabel(assistant.modelId || pendingAssistantModelId, assistant.thinkingLevel || pendingAssistantThinkingLevel),
    };
  }

  if (currentTurnMessages.some(isPruningResultMessage)) {
    return {
      phase: 'startingModel',
      label: AGENT_ACTIVITY_LABELS.startingModel,
      tone: 'processing',
      ariaLabel: 'Agent is starting model',
      pendingModelLabel: formatModelLabel(pendingAssistantModelId, pendingAssistantThinkingLevel),
    };
  }

  if (isSkillPrunerActive(prefs, pruningSettings)) {
    return {
      phase: 'pruning',
      label: AGENT_ACTIVITY_LABELS.pruning,
      tone: 'processing',
      ariaLabel: 'Agent is pruning skills and tools',
    };
  }

  return {
    phase: 'preparing',
    label: AGENT_ACTIVITY_LABELS.preparing,
    tone: 'neutral',
    ariaLabel: 'Agent is preparing response',
    pendingModelLabel: formatModelLabel(pendingAssistantModelId, pendingAssistantThinkingLevel),
  };
}

/**
 * Legacy compatibility wrapper for deriveTurnActivityState.
 * Returns the label string for existing call sites that expect a simple string.
 * @deprecated Use deriveTurnActivityState for structured activity state.
 */
export function derivePendingActivityLabel({
  busy,
  transcript,
  prefs,
  pruningSettings,
}: Omit<PendingActivityOptions, 'pendingAssistantModelId' | 'pendingAssistantThinkingLevel'>): AgentActivityLabel | null {
  const state = deriveTurnActivityState({ busy, transcript, prefs, pruningSettings });
  return state?.label as AgentActivityLabel | null;
}
