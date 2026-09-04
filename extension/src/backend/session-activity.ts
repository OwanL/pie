import type { SessionCapabilities } from '../shared/protocol';
import { classifyInterruptedContinuationTail } from './sdk';
import type { SessionContext } from './server-types';

export interface SessionActivityOverrides {
  /** SDK emits compaction_end before clearing its controller. */
  compacting?: boolean;
}

/**
 * One backend authority for session-attributed activity that can still spend
 * provider/tool time or automatically continue work. A definitive retirement
 * boundary wins over stale SDK getters from the retired runtime.
 */
export function hasBillableSessionActivity(
  context: Pick<SessionContext, 'activeRequest' | 'manualCompactionRequest' | 'pendingExtensionCommand' | 'retired' | 'session'>,
  overrides: SessionActivityOverrides = {},
): boolean {
  if (context.retired) return false;
  const { session } = context;
  return context.activeRequest !== undefined
    || context.manualCompactionRequest !== undefined
    || context.pendingExtensionCommand !== undefined
    || session.isStreaming === true
    || (overrides.compacting ?? session.isCompacting === true)
    || session.isRetrying === true
    || session.isBashRunning === true
    || session.hasPendingBashMessages === true
    || (session.pendingMessageCount ?? 0) > 0;
}

export function buildSessionCapabilities(
  context: Pick<SessionContext, 'activeRequest' | 'manualCompactionRequest' | 'pendingExtensionCommand' | 'retired' | 'session'>,
  overrides: SessionActivityOverrides = {},
): SessionCapabilities {
  const billableActivity = hasBillableSessionActivity(context, overrides);
  return {
    billableActivity,
    canInterrupt: billableActivity,
    canCompact: !billableActivity,
    canContinue: !billableActivity && classifyInterruptedContinuationTail(
      context.session.messages,
      context.session.model?.contextWindow,
    ) !== undefined,
  };
}

/** Cold durable opens classify the complete SDK context, never the transported window. */
export function buildIdleSessionCapabilities(
  messages: unknown,
  contextWindow?: number,
): SessionCapabilities {
  return {
    billableActivity: false,
    canInterrupt: false,
    canCompact: true,
    canContinue: classifyInterruptedContinuationTail(messages, contextWindow) !== undefined,
  };
}

export const SETTLED_SESSION_CAPABILITIES: SessionCapabilities = Object.freeze({
  billableActivity: false,
  canInterrupt: false,
  canCompact: true,
  canContinue: false,
});
