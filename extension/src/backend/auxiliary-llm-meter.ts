import type { AuxiliaryLlmUsagePayload } from '../shared/protocol';

type StreamResult = { usage?: unknown };
type StreamLike = { result?: (...args: unknown[]) => Promise<StreamResult> };
type StreamFn = (model: unknown, ...args: unknown[]) => Promise<StreamLike>;

interface MeterableSession {
  agent?: { streamFn?: StreamFn };
  _compactionAbortController?: unknown;
  _branchSummaryAbortController?: unknown;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function readModel(model: unknown): { modelId?: string; provider?: string } {
  if (!model || typeof model !== 'object') return {};
  const candidate = model as { id?: unknown; provider?: unknown };
  return {
    ...(typeof candidate.id === 'string' && candidate.id ? { modelId: candidate.id } : {}),
    ...(typeof candidate.provider === 'string' && candidate.provider ? { provider: candidate.provider } : {}),
  };
}

function readUsage(usage: unknown): Pick<AuxiliaryLlmUsagePayload,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reportedCostUsd'> {
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  const candidate = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown };
  };
  const reported = candidate.cost?.total;
  return {
    inputTokens: nonNegativeInt(candidate.input),
    outputTokens: nonNegativeInt(candidate.output),
    cacheReadTokens: nonNegativeInt(candidate.cacheRead),
    cacheWriteTokens: nonNegativeInt(candidate.cacheWrite),
    ...(typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
      ? { reportedCostUsd: reported }
      : {}),
  };
}

/** Meter SDK summarization requests that bypass assistant message events.
 *
 * Pi routes both history compaction and /tree branch summaries through the
 * session's stream function while their dedicated abort controller is live.
 * Wrapping that one seam captures native and Pie-custom compaction (including
 * split-turn calls) without touching normal assistant turns. */
export function installAuxiliaryLlmMeter(
  session: unknown,
  sessionPath: string,
  emit: (event: string, payload: AuxiliaryLlmUsagePayload) => void,
  now: () => number = Date.now,
): void {
  const meterable = session as MeterableSession;
  const agent = meterable.agent;
  const original = agent?.streamFn;
  if (!agent || typeof original !== 'function') return;

  let sequence = 0;
  agent.streamFn = async function meteredStreamFn(model: unknown, ...args: unknown[]): Promise<StreamLike> {
    // isCompacting also covers branch summaries in the pinned SDK, so inspect
    // the more specific controller first to keep the usage class truthful.
    const kind = meterable._branchSummaryAbortController !== undefined
      ? 'branch_summary' as const
      : meterable._compactionAbortController !== undefined
        ? 'history_compaction' as const
        : null;
    const startedAt = now();
    const stream = await original.call(this, model, ...args);
    if (!kind || !stream || typeof stream.result !== 'function') return stream;

    const originalResult = stream.result.bind(stream);
    let reported = false;
    return new Proxy(stream, {
      get(target, property, receiver) {
        if (property !== 'result') return Reflect.get(target, property, receiver);
        return async (...resultArgs: unknown[]) => {
          const response = await originalResult(...resultArgs);
          if (!reported) {
            reported = true;
            const endedAt = now();
            sequence += 1;
            emit('auxiliary-llm.usage', {
              sessionPath,
              kind,
              sourceId: `${kind}:${startedAt}:${sequence}`,
              occurredAt: new Date(endedAt).toISOString(),
              ...readModel(model),
              ...readUsage(response?.usage),
              durationMs: Math.max(0, endedAt - startedAt),
            });
          }
          return response;
        };
      },
    });
  };
}
