import type { SessionEntryLike } from '../../../session-storage/transcripts/transcript';
import type { HistoryCompactionSettings } from '../../../session-storage/settings/history-compaction';
import { consumedOverflowMessageEntryIds, isEstimatedContextOverflowMessage } from '../../workers/history-compaction';
import type {
  AgentSession,
  CompactionHooks,
  ContinueAfterInterruptionDecision,
} from '../../../pi/packages/coding-agent/dist/core/agent-session.js';
import type { ContextMessageOmissionsResolver, SessionEntry } from '../../../pi/packages/coding-agent/dist/core/session-manager.js';
import {
  classifyInterruptedContinuationTail,
  shouldRunHistoryCompaction,
} from './sdk';

const UNSUPPORTED_CONTINUATION = 'The session does not end at a supported continuation point.';

/** Narrow callbacks exported by sdk.ts keep Pie's private settings and summary
 * customization policy in one place while this adapter only speaks source SDK
 * types and public APIs. */
export interface SourceSdkPolicyBridge {
  readHistoryCompactionSettings: () => HistoryCompactionSettings | undefined;
  beforeCompact: NonNullable<CompactionHooks['beforeCompact']>;
}

export interface SourceSdkPolicyFactoryOptions {
  contextMessageOmissions?: ContextMessageOmissionsResolver;
  compactionHooks?: CompactionHooks;
}

export type SourceSdkPolicySession<TSession extends AgentSession> =
  TSession & { continueAfterInterruption: () => Promise<void> };

export type SourceSdkPolicyFactoryResult<TResult extends { session: AgentSession }> =
  Omit<TResult, 'session'> & { session: SourceSdkPolicySession<TResult['session']> };

export interface SourceSdkPolicyAdapter {
  /** Combine Pie's durable consumed-overflow projection with caller omissions. */
  contextMessageOmissions: (existing?: ContextMessageOmissionsResolver) => ContextMessageOmissionsResolver;
  /** Preserve source hooks while installing Pie's threshold, estimate, and summary policies. */
  compactionHooks: (existing?: CompactionHooks) => CompactionHooks;
  /** Adapt only the session's continuation signature, leaving runtime-forwarded options untouched. */
  wrapContinuationFactory<TOptions, TResult extends { session: AgentSession }>(
    factory: (options: TOptions) => Promise<TResult>,
  ): (options: TOptions) => Promise<SourceSdkPolicyFactoryResult<TResult>>;
  /** Install policies before invoking a source factory that may build context immediately. */
  wrapFactory<TOptions extends SourceSdkPolicyFactoryOptions, TResult extends { session: AgentSession }>(
    factory: (options: TOptions) => Promise<TResult>,
  ): (options: TOptions) => Promise<SourceSdkPolicyFactoryResult<TResult>>;
}

function historyEntryForTail(session: AgentSession): SessionEntry | undefined {
  const tail = session.messages.at(-1);
  if (!tail || tail.role !== 'assistant') return undefined;

  const branch = session.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    if (entry.message === tail) return entry;

    // Context construction can normalize a legacy message by cloning it. Use
    // only stable provider-response identity fields as a fallback; do not
    // select a different assistant row based only on role or timestamp.
    const candidate = entry.message;
    if (candidate.timestamp === tail.timestamp
      && candidate.provider === tail.provider
      && candidate.model === tail.model
      && candidate.stopReason === tail.stopReason
      && candidate.errorMessage === tail.errorMessage) {
      return entry;
    }
  }
  return undefined;
}

function continuationDecision(session: AgentSession): ContinueAfterInterruptionDecision {
  const tail = classifyInterruptedContinuationTail(session.messages, session.model?.contextWindow);
  if (!tail) return { type: 'unsupported', reason: UNSUPPORTED_CONTINUATION };
  if (tail !== 'aborted-assistant' && tail !== 'overflow-assistant') return { type: 'continue' };

  const entry = historyEntryForTail(session);
  if (!entry) return { type: 'unsupported', reason: UNSUPPORTED_CONTINUATION };
  return { type: 'continue', omitEntryIds: [entry.id] };
}

/** Adapt the pinned source API to the legacy no-argument Pie call signature.
 * The source session still validates and applies the explicit omission decision. */
function adaptContinuation(session: AgentSession): void {
  const continueAfterInterruption = session.continueAfterInterruption;
  if (typeof continueAfterInterruption !== 'function') return;
  session.continueAfterInterruption = async function pieContinueAfterInterruption(
    decision?: ContinueAfterInterruptionDecision,
  ): Promise<void> {
    await continueAfterInterruption.call(session, decision ?? continuationDecision(session));
  };
}

function adaptSession<TSession extends AgentSession>(session: TSession): SourceSdkPolicySession<TSession> {
  adaptContinuation(session);
  return session as unknown as SourceSdkPolicySession<TSession>;
}

function mergeResolvers(
  existing: ContextMessageOmissionsResolver | undefined,
): ContextMessageOmissionsResolver {
  return (branchEntries) => {
    const omitted = consumedOverflowMessageEntryIds([...branchEntries] as unknown as SessionEntryLike[]);
    for (const id of existing?.(branchEntries) ?? []) omitted.add(id);
    return omitted;
  };
}

function mergeCompactionHooks(
  bridge: SourceSdkPolicyBridge,
  existing: CompactionHooks | undefined,
): CompactionHooks {
  return {
    shouldCompact: async (check) => {
      const settings = bridge.readHistoryCompactionSettings();
      if (settings) {
        return shouldRunHistoryCompaction(settings, check.contextUsage, check.trigger, check.model);
      }
      return await existing?.shouldCompact?.(check);
    },
    isEstimatedContextOverflow: async (check) => {
      const isPieOverflow = isEstimatedContextOverflowMessage(
        check.assistantMessage,
        check.model.contextWindow,
        check.contextUsage?.tokens,
      );
      return isPieOverflow || await existing?.isEstimatedContextOverflow?.(check) === true;
    },
    beforeCompact: async (event, session) => {
      // Source AgentSession emits extension handlers first and calls this hook
      // only when no extension cancel/result took precedence.
      const existingResult = await existing?.beforeCompact?.(event, session);
      if (existingResult?.cancel || existingResult?.compaction) return existingResult;
      return (await bridge.beforeCompact(event, session)) ?? existingResult;
    },
  };
}

/** Build the bounded policy adapter for the typed source SDK. */
export function createSourceSdkPolicyAdapter(bridge: SourceSdkPolicyBridge): SourceSdkPolicyAdapter {
  const contextMessageOmissions = (existing?: ContextMessageOmissionsResolver): ContextMessageOmissionsResolver =>
    mergeResolvers(existing);
  const compactionHooks = (existing?: CompactionHooks): CompactionHooks => mergeCompactionHooks(bridge, existing);
  const wrapContinuationFactory: SourceSdkPolicyAdapter['wrapContinuationFactory'] = (factory) => async (options) => {
    const result = await factory(options);
    return { ...result, session: adaptSession(result.session) };
  };
  const wrapFactory: SourceSdkPolicyAdapter['wrapFactory'] = (factory) => wrapContinuationFactory((options) =>
    factory({
      ...options,
      contextMessageOmissions: contextMessageOmissions(options.contextMessageOmissions),
      compactionHooks: compactionHooks(options.compactionHooks),
    }));

  return {
    contextMessageOmissions,
    compactionHooks,
    wrapContinuationFactory,
    wrapFactory,
  };
}
