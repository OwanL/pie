import type { ChatMessage, ChatPrefs, PruningSettings, ToolCall } from '../../../shared/protocol';
import type { LiveTurnPhase } from '../../../shared/live-pipeline-protocol';
import { assistantPartsFromMessage, toolCallsFromMessageParts } from '../../../shared/chat-message-parts';
import { estimateTextTokens } from '../../../shared/tokenize';
import { isPruningResultMessage } from './pruning';
import type { TurnActivityTail } from './activity-tail';

export const AGENT_ACTIVITY_LABELS = {
  pruning: 'pruning skills/tools',
  preparing: 'preparing response',
  startingModel: 'starting model',
  responding: 'responding',
  draftingTool: 'drafting tool call',
  runningTools: 'running tools',
  thinking: 'thinking',
} as const;

/**
 * Structured in-flight activity state for the current turn.
 * Represents active processing phases only (while busy=true).
 * Terminal states (interrupted, error) are owned by message status UI.
 */
export interface TurnActivityState {
  /** Primary in-flight phase identifier. */
  phase: 'preparing' | 'pruning' | 'startingModel' | 'thinking' | 'draftingTool' | 'runningTool' | 'streaming' | 'providerStatus';
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
  liveTurnPhase?: LiveTurnPhase | null;
}

function livePhaseActivityState(phase: LiveTurnPhase | null | undefined): TurnActivityState | null {
  const labels: Partial<Record<LiveTurnPhase, string>> = {
    queued: 'queued for provider capacity',
    preparing: 'preparing the next provider request',
    waiting_provider: 'waiting for the provider',
    waiting_input: 'waiting for input',
    retry_wait: 'waiting to retry the provider',
    aborting: 'stopping provider work',
    reconciling_gap: 'recovering live response state',
  };
  const label = phase ? labels[phase] : undefined;
  return label ? {
    phase: 'providerStatus',
    label,
    tone: 'processing',
    ariaLabel: `Agent is ${label}`,
  } : null;
}

function isSkillPrunerActive(
  prefs: Pick<ChatPrefs, 'extensionToggles'>,
  pruningSettings: Pick<PruningSettings, 'mode'>,
): boolean {
  return prefs.extensionToggles['skill-pruner'] !== false && pruningSettings.mode !== 'off';
}

function latestUserIndex(transcript: readonly ChatMessage[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    // Queued follow-ups are projected after the live assistant turn. They are
    // not the owner of the activity currently on screen and must not make that
    // active tool/reply look like a fresh pruning prepass.
    if (message?.role === 'user' && message.status !== 'queued') {
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
  liveTurnPhase,
}: PendingActivityOptions): TurnActivityState | null {
  if (!busy) {
    return null;
  }

  // Provider lifecycle status used to render inside the composer. Surface it in
  // the transcript's subtle animated activity row instead. Streaming and
  // running-tool phases retain their richer transcript-derived status/tails.
  const livePhaseState = livePhaseActivityState(liveTurnPhase);
  if (livePhaseState) return livePhaseState;

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
    const pendingModelLabel = formatModelLabel(
      assistant.modelId || pendingAssistantModelId,
      assistant.thinkingLevel || pendingAssistantThinkingLevel,
    );
    const toolCalls = toolCallsFromAssistant(assistant);
    const provisionalTools = toolCalls.filter((tool) => tool.status === 'drafting' || tool.status === 'ready');
    const legacyDraft = provisionalTools.length === 0 ? assistant.draftingToolCall : undefined;

    if (provisionalTools.length > 0 || legacyDraft) {
      const active = provisionalTools.at(-1);
      const toolName = active?.name || legacyDraft?.name || 'tool';
      const argumentsText = active?.argumentsText ?? legacyDraft?.argumentsText ?? '';
      const tokens = estimateTextTokens(argumentsText);
      const tokenDetail = `${tokens} ${tokens === 1 ? 'token' : 'tokens'}`;
      const ready = active?.status === 'ready';
      return {
        phase: 'draftingTool',
        label: ready ? `${toolName} call ready` : `drafting ${toolName} call`,
        detail: tokenDetail,
        tone: 'active',
        ariaLabel: ready
          ? `${toolName} tool call is ready, ${tokenDetail}`
          : `Agent is drafting a ${toolName} tool call, ${tokenDetail}`,
        pendingModelLabel,
      };
    }

    const runningTools = toolCalls.filter((tool) => tool.status === 'running');
    if (runningTools.length > 0) {
      // Unified lifecycle: each tool card owns its inline live preview (and a
      // ReasoningBlock owns streamed reasoning). This footer state reports only
      // lifecycle/count metadata; restoring a tail here would duplicate the
      // same live content below the owning row.
      if (runningTools.length === 1) {
        const toolName = runningTools[0]!.name;
        return {
          phase: 'runningTool',
          label: `running ${toolName}`,
          tone: 'active',
          ariaLabel: `Agent is running ${toolName}`,
          runningToolName: toolName,
        };
      }
      const summary = `running ${runningTools.length} tools`;
      return {
        phase: 'runningTool',
        label: summary,
        detail: runningTools.map((tool) => tool.name).join(', '),
        tone: 'active',
        ariaLabel: `Agent is ${summary}`,
        runningToolSummary: summary,
      };
    }

    if (assistant.status === 'streaming') {
      const parts = assistantPartsFromMessage(assistant);
      const lastPart = parts?.at(-1);
      if (lastPart?.kind === 'reasoning') {
        return {
          phase: 'streaming',
          label: 'reasoning',
          tone: 'active',
          ariaLabel: 'Agent is reasoning',
          pendingModelLabel,
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

    return {
      phase: 'thinking',
      label: AGENT_ACTIVITY_LABELS.thinking,
      tone: 'processing',
      ariaLabel: 'Agent is thinking',
      pendingModelLabel,
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
