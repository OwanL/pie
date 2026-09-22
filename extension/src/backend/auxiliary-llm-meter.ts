import { providerReportedCostUsd } from '../../../shared/provider-cost.js';
import type { AuxiliaryLlmUsagePayload } from '../shared/protocol';

type StreamResult = { usage?: unknown };
type StreamLike = { result?: (...args: unknown[]) => Promise<StreamResult> };
type StreamFn = (model: unknown, ...args: unknown[]) => Promise<StreamLike>;

interface MeterableSession {
  agent?: { streamFn?: StreamFn };
  _compactionAbortController?: unknown;
  _autoCompactionAbortController?: unknown;
  _branchSummaryAbortController?: unknown;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function validTokenChannel(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readModel(model: unknown): { modelId?: string; provider?: string } {
  if (!model || typeof model !== 'object') return {};
  const candidate = model as { id?: unknown; provider?: unknown };
  return {
    ...(typeof candidate.id === 'string' && candidate.id ? { modelId: candidate.id } : {}),
    ...(typeof candidate.provider === 'string' && candidate.provider ? { provider: candidate.provider } : {}),
  };
}

function readUsage(usage: unknown, kind: AuxiliaryLlmUsagePayload['kind']): Pick<AuxiliaryLlmUsagePayload,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reportedCostUsd'
  | 'tokenChannelsKnown' | 'tokenChannelPresence' | 'instrumentationGap' | 'instrumentationGapReason'> {
  if (!usage || typeof usage !== 'object') {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokenChannelsKnown: false,
      tokenChannelPresence: { input: false, output: false, cacheRead: false, cacheWrite: false },
      instrumentationGap: true,
      instrumentationGapReason: kind === 'other'
        ? 'The unexpected auxiliary response exposed no provider usage.'
        : 'The summarization response exposed no provider usage.',
    };
  }
  const candidate = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    reportedCostUsd?: unknown;
    providerReportedCostUsd?: unknown;
    cost?: unknown;
  };
  // `cost.total` is the Pi SDK catalog estimate, not provider billing.
  const reported = providerReportedCostUsd(candidate);
  const hasChannels = ['input', 'output', 'cacheRead', 'cacheWrite']
    .every((key) => {
      const value = candidate[key as keyof typeof candidate];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    });
  return {
    inputTokens: nonNegativeInt(candidate.input),
    outputTokens: nonNegativeInt(candidate.output),
    cacheReadTokens: nonNegativeInt(candidate.cacheRead),
    cacheWriteTokens: nonNegativeInt(candidate.cacheWrite),
    tokenChannelsKnown: hasChannels,
    tokenChannelPresence: {
      input: validTokenChannel(candidate.input),
      output: validTokenChannel(candidate.output),
      cacheRead: validTokenChannel(candidate.cacheRead),
      cacheWrite: validTokenChannel(candidate.cacheWrite),
    },
    ...(typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
      ? { reportedCostUsd: reported }
      : {}),
    ...(!hasChannels ? {
      instrumentationGap: true,
      instrumentationGapReason: kind === 'other'
        ? 'The unexpected auxiliary response omitted one or more provider usage channels.'
        : 'The summarization response omitted one or more provider usage channels.',
    } : {}),
  };
}

/** Meter SDK summarization requests that bypass assistant message events.
 *
 * Pi routes history compaction (manual, plus automatic threshold/overflow
 * recovery) and /tree branch summaries through the session's stream function
 * while their dedicated abort controller is live. Automatic compaction runs
 * inside or beside an active turn, so the ordinary-conversation classifier
 * alone would silently leave those provider calls unmetered; checking the
 * `_autoCompactionAbortController` keeps them in the root scope exactly once.
 * Wrapping that one seam captures native and Pie-custom compaction (including
 * split-turn calls) without touching normal assistant turns. */
export function installAuxiliaryLlmMeter(
  session: unknown,
  sessionPath: string,
  emit: (event: string, payload: AuxiliaryLlmUsagePayload) => void,
  now: () => number = Date.now,
  isOrdinaryConversationCall: () => boolean = () => true,
): void {
  const meterable = session as MeterableSession;
  const agent = meterable.agent;
  const original = agent?.streamFn;
  if (!agent || typeof original !== 'function') return;

  let sequence = 0;
  agent.streamFn = async function meteredStreamFn(model: unknown, ...args: unknown[]): Promise<StreamLike> {
    // isCompacting also covers branch summaries and auto compaction in the
    // pinned SDK, so inspect the more specific controller first to keep the
    // usage class truthful.
    const kind = meterable._branchSummaryAbortController !== undefined
      ? 'branch_summary' as const
      : meterable._compactionAbortController !== undefined
        || meterable._autoCompactionAbortController !== undefined
        ? 'history_compaction' as const
        : isOrdinaryConversationCall() ? null : 'other' as const;
    const startedAt = now();
    const invocationSequence = kind ? ++sequence : 0;
    const sourceId = kind ? `${kind}:${startedAt}:${invocationSequence}` : '';
    let stream: StreamLike;
    try {
      stream = await original.call(this, model, ...args);
    } catch (error) {
      if (kind) {
        const endedAt = now();
        emit('auxiliary-llm.usage', {
          sessionPath,
          kind,
          sourceId,
          occurredAt: new Date(endedAt).toISOString(),
          startedAt: new Date(startedAt).toISOString(),
          ...readModel(model),
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: Math.max(0, endedAt - startedAt),
          outcome: 'failed',
          instrumentationGap: true,
          instrumentationGapReason: kind === 'other'
            ? 'The unexpected auxiliary provider request failed before exposing usage.'
            : 'The summarization provider request failed before exposing usage.',
        });
      }
      throw error;
    }
    if (!kind) return stream;
    if (!stream || typeof stream.result !== 'function') {
      const endedAt = now();
      emit('auxiliary-llm.usage', {
        sessionPath,
        kind,
        sourceId,
        occurredAt: new Date(endedAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        ...readModel(model),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: Math.max(0, endedAt - startedAt),
        outcome: 'unknown',
        instrumentationGap: true,
        instrumentationGapReason: kind === 'other'
          ? 'The unexpected auxiliary stream exposed no result settlement hook.'
          : 'The summarization stream exposed no result settlement hook.',
      });
      return stream;
    }

    const originalResult = stream.result.bind(stream);
    let reported = false;
    return new Proxy(stream, {
      get(target, property, receiver) {
        if (property !== 'result') return Reflect.get(target, property, receiver);
        return async (...resultArgs: unknown[]) => {
          try {
            const response = await originalResult(...resultArgs);
            if (!reported) {
              reported = true;
              const endedAt = now();
              emit('auxiliary-llm.usage', {
                sessionPath,
                kind,
                sourceId,
                occurredAt: new Date(endedAt).toISOString(),
                ...readModel(model),
                ...readUsage(response?.usage, kind),
                durationMs: Math.max(0, endedAt - startedAt),
              });
            }
            return response;
          } catch (error) {
            if (!reported) {
              reported = true;
              const endedAt = now();
              emit('auxiliary-llm.usage', {
                sessionPath,
                kind,
                sourceId,
                occurredAt: new Date(endedAt).toISOString(),
                startedAt: new Date(startedAt).toISOString(),
                ...readModel(model),
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                durationMs: Math.max(0, endedAt - startedAt),
                outcome: 'failed',
                instrumentationGap: true,
                instrumentationGapReason: kind === 'other'
                  ? 'The unexpected auxiliary result failed before exposing usage.'
                  : 'The summarization result failed before exposing usage.',
              });
            }
            throw error;
          }
        };
      },
    });
  };
}
