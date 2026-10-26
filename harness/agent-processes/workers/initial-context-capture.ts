import { createHash } from 'node:crypto';
import { ANALYTICS_SCHEMA_VERSION, deriveAnalyticsIdempotencyKey } from '../../../analytics/contracts/contracts.js';
import { ANALYTICS_RUNTIME_BRIDGE_KEY, type InstalledAnalyticsRuntimeBridge } from '../../../analytics/contracts/transport.js';
import { estimateRequestPrefixTokens } from '../../../lib/request-token-estimate.js';
import { INITIAL_CONTEXT_COHORT_VERSION } from '../context-inventory/initial-context-cohort.js';

interface RequestContext {
  systemPrompt?: string;
  messages?: Array<{ role: string }>;
  tools?: Parameters<typeof estimateRequestPrefixTokens>[1];
}
interface CaptureAgent {
  streamFn: (model: object, context: RequestContext, ...args: unknown[]) => unknown;
  prepareModelRequest?: (context: RequestContext, ...args: unknown[]) => RequestContext | Promise<RequestContext>;
}
const installed = new WeakSet<object>();

export function hasConversation(messages: readonly unknown[]): boolean {
  return messages.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    const message = record.type === 'message' ? record.message : entry;
    return message !== null && typeof message === 'object'
      && ((message as Record<string, unknown>).role === 'user'
        || (message as Record<string, unknown>).role === 'assistant');
  });
}

/** The pinned agent loop calls prepareModelRequest only for real main-agent
 * requests, after transform/convert and before streamFn. Compaction and branch
 * summaries reuse streamFn directly, without this seam. Brand the exact final
 * context rather than guessing from prompt text or lifecycle events. */
export function installInitialContextCapture(options: {
  agent: CaptureAgent;
  messages: readonly unknown[];
  branch: readonly unknown[];
  delegated: boolean;
  resolveCohortKey: (model: { provider: string; id: string }) => string | undefined;
}): void {
  const { agent } = options;
  if (installed.has(agent) || options.delegated || hasConversation(options.messages) || hasConversation(options.branch)) return;
  installed.add(agent);
  const originalPrepare = agent.prepareModelRequest;
  const originalStream = agent.streamFn;
  let first = true;
  let target: RequestContext | undefined;
  agent.prepareModelRequest = async function (context: RequestContext, ...args: unknown[]) {
    const capture = first;
    first = false;
    const result = originalPrepare
      ? await Reflect.apply(originalPrepare, this, [context, ...args]) as RequestContext
      : context;
    if (capture) target = result;
    return result;
  };
  agent.streamFn = function (model: object, context: RequestContext, ...args: unknown[]) {
    if (target && context === target) {
      target = undefined;
      try {
        if (context.messages?.filter((message: { role: string }) => message.role === 'user').length === 1
          && !context.messages.some((message: { role: string }) => message.role === 'assistant')) {
          const identity = model as { provider?: unknown; id?: unknown };
          if (typeof identity.provider === 'string' && identity.provider.trim()
            && typeof identity.id === 'string' && identity.id.trim()) {
            const cohortKey = options.resolveCohortKey({ provider: identity.provider, id: identity.id });
            if (cohortKey) {
              const tokens = estimateRequestPrefixTokens(context.systemPrompt ?? '', context.tools ?? [], model);
              if (Number.isSafeInteger(tokens) && tokens >= 0) submitInitialContext(cohortKey, tokens);
            }
          }
        }
      } catch { /* Analytics must never affect provider execution. */ }
    }
    return Reflect.apply(originalStream, this, [model, context, ...args]);
  };
}

function submitInitialContext(cohortKey: string, tokens: number): void {
  const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge | undefined;
  if (!bridge || bridge.captureSubject.kind !== 'session') return;
  const rootSessionId = bridge.captureSubject.rootSessionId;
  const identity = createHash('sha256').update(JSON.stringify([
    bridge.generationId, bridge.producer, rootSessionId,
  ])).digest('hex');
  const stableOriginId = `initial-context:${identity}`;
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: bridge.generationId,
    producerKind: 'backend' as const,
    stableOriginId,
    sourceSequence: 1,
    sourceKey: stableOriginId,
    entityKind: 'featureObservation' as const,
    entityKey: `initial-context:${rootSessionId}`,
    observationKind: 'observation' as const,
    observedAtMs: Date.now(),
    scope: { rootSessionId, sessionId: rootSessionId,
      workspaceCoverage: bridge.workspaceId ? 'known' as const : 'unknown' as const,
      ...(bridge.workspaceId ? { workspaceId: bridge.workspaceId } : {}) },
    captureSubject: bridge.captureSubject,
    producer: bridge.producer,
    fields: { feature: 'initialContext', decision: 'post-pruning', ruleVersion: INITIAL_CONTEXT_COHORT_VERSION,
      initialContext: { cohortKey, tokens } },
  };
  try {
    bridge.submitObservation({ ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) });
  } finally {
    bridge.releaseAcknowledgementInterest(bridge.generationId, stableOriginId, '', 'backend');
  }
}
