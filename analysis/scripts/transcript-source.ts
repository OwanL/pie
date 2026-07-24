import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  AgentReviewCompletion,
  HistoricalSessionAttribution,
  HistoricalSessionReview,
  HistoricalSessionSourceSummary,
  LegacySessionReviewSource,
  SessionReviewV2Source,
  ThinkingLevel,
  TranscriptSourceProvenance,
} from './contracts.ts';
import { sessionPathHash } from './hash.ts';
import { coerceSessionReviewV2 } from './review-analytics.ts';

interface JsonRecord { [key: string]: unknown }

interface TranscriptNode {
  id: string;
  parentId: string | null;
  order: number;
  value: JsonRecord;
}

export interface TranscriptDiscoveryOptions {
  legacySessionsDir: string;
  configuredSessionsDir?: string;
  reviewSidecarPath?: string;
}

const THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const SUCCESS_STOP_REASONS = new Set(['stop', 'toolUse']);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeThinking(value: unknown): ThinkingLevel | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase() === 'max' ? 'xhigh' : value.trim().toLowerCase();
  return THINKING_LEVELS.has(normalized as ThinkingLevel) ? normalized as ThinkingLevel : null;
}

/** Stable join key: Windows paths compare case- and slash-insensitively. */
export function normalizeSessionPath(value: string): string {
  const replaced = value.trim().replace(/\\/g, '/');
  const isUnc = replaced.startsWith('//');
  const slashed = isUnc
    ? `//${replaced.slice(2).replace(/\/+/g, '/')}`
    : replaced.replace(/\/+/g, '/');
  if (/^[a-zA-Z]:\//.test(slashed) || isUnc) {
    return slashed.toLowerCase();
  }
  return slashed;
}

function textCharCount(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => {
    if (!isRecord(part)) return sum;
    return sum + (typeof part.text === 'string' ? part.text.length : 0);
  }, 0);
}

function usageFromMessage(message: JsonRecord): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  attributionTokens: number;
  costUsd: number | null;
} {
  const usage = isRecord(message.usage) ? message.usage : {};
  const inputTokens = finiteNonNegative(usage.input ?? usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.output ?? usage.outputTokens);
  const cacheReadTokens = finiteNonNegative(usage.cacheRead ?? usage.cacheReadTokens);
  const cacheWriteTokens = finiteNonNegative(usage.cacheWrite ?? usage.cacheWriteTokens);
  const reportedTotal = finiteNonNegative(usage.totalTokens);
  const cost = isRecord(usage.cost) ? usage.cost : {};
  const reportedCost = finiteNonNegative(cost.total);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    attributionTokens: reportedTotal > 0
      ? reportedTotal
      : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: typeof cost.total === 'number' && Number.isFinite(cost.total) && cost.total >= 0
      ? reportedCost
      : null,
  };
}

function activeBranch(nodes: TranscriptNode[]): TranscriptNode[] {
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const branch: TranscriptNode[] = [];
  const seen = new Set<string>();
  let cursor: TranscriptNode | undefined = nodes[nodes.length - 1];
  while (cursor && !seen.has(cursor.id)) {
    branch.push(cursor);
    seen.add(cursor.id);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return branch.reverse();
}

function attributionKey(modelId: string, thinkingLevel: ThinkingLevel | null): string {
  return `${modelId}\u0000${thinkingLevel ?? ''}`;
}

/** Parse one pi session JSONL into a content-free active-branch summary. */
export function summarizeTranscriptJsonl(
  raw: string,
  sessionPath: string,
  provenance: TranscriptSourceProvenance[] = ['legacy'],
): HistoricalSessionSourceSummary | null {
  let header: JsonRecord | null = null;
  const nodes: TranscriptNode[] = [];
  let firstNonEmptySeen = false;
  for (const [order, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (!firstNonEmptySeen) return null;
      continue;
    }
    if (!firstNonEmptySeen) {
      firstNonEmptySeen = true;
      if (!isRecord(value) || value.type !== 'session' || typeof value.id !== 'string' || !value.id.trim()) return null;
      header = value;
      continue;
    }
    if (!isRecord(value)) continue;
    if (typeof value.id === 'string' && (typeof value.parentId === 'string' || value.parentId === null)) {
      nodes.push({ id: value.id, parentId: value.parentId as string | null, order, value });
    }
  }
  if (!header) return null;

  const branch = activeBranch(nodes);
  let thinkingLevel: ThinkingLevel | null = null;
  let currentModel: string | null = null;
  let firstUserMessageChars: number | null = null;
  let successfulAssistantTurns = 0;
  let errorAssistantTurns = 0;
  let abortedAssistantTurns = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let terminalStatus: HistoricalSessionSourceSummary['terminalStatus'] = 'none';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd: number | null = null;
  const attribution = new Map<string, Omit<HistoricalSessionAttribution, 'share'>>();

  for (const node of branch) {
    const entry = node.value;
    if (entry.type === 'thinking_level_change') {
      thinkingLevel = normalizeThinking(entry.thinkingLevel);
      continue;
    }
    if (entry.type === 'model_change') {
      currentModel = typeof entry.modelId === 'string' && entry.modelId.trim() ? entry.modelId.trim() : null;
      continue;
    }
    if (entry.type !== 'message' || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role === 'user' && firstUserMessageChars === null) {
      firstUserMessageChars = textCharCount(message.content);
      continue;
    }
    if (message.role === 'toolResult') {
      if (message.isError === true) toolErrorCount += 1;
      continue;
    }
    if (message.role !== 'assistant') continue;

    const content = Array.isArray(message.content) ? message.content : [];
    toolCallCount += content.filter((part) => isRecord(part) && part.type === 'toolCall').length;
    const usage = usageFromMessage(message);
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    if (usage.costUsd !== null) costUsd = (costUsd ?? 0) + usage.costUsd;

    const stopReason = typeof message.stopReason === 'string' ? message.stopReason : '';
    if (SUCCESS_STOP_REASONS.has(stopReason)) {
      successfulAssistantTurns += 1;
      terminalStatus = 'success';
      const modelId = typeof message.model === 'string' && message.model.trim()
        ? message.model.trim()
        : currentModel ?? '(unknown)';
      const key = attributionKey(modelId, thinkingLevel);
      const previous = attribution.get(key);
      attribution.set(key, {
        modelId,
        thinkingLevel,
        successfulAssistantTurns: (previous?.successfulAssistantTurns ?? 0) + 1,
        attributedTokens: (previous?.attributedTokens ?? 0) + usage.attributionTokens,
      });
    } else if (stopReason === 'aborted' || stopReason === 'interrupted') {
      abortedAssistantTurns += 1;
      terminalStatus = 'aborted';
    } else {
      errorAssistantTurns += 1;
      terminalStatus = 'error';
    }
  }

  const attributionRows = [...attribution.values()];
  const attributedTokenTotal = attributionRows.reduce((sum, row) => sum + row.attributedTokens, 0);
  const turnTotal = attributionRows.reduce((sum, row) => sum + row.successfulAssistantTurns, 0);
  const attributions: HistoricalSessionAttribution[] = attributionRows.map((row) => ({
    ...row,
    share: attributedTokenTotal > 0
      ? row.attributedTokens / attributedTokenTotal
      : turnTotal > 0 ? row.successfulAssistantTurns / turnTotal : 0,
  }));

  return {
    sessionId: header.id as string,
    normalizedSessionPath: normalizeSessionPath(sessionPath),
    startedAt: optionalTimestamp(header.timestamp),
    endedAt: optionalTimestamp(branch.at(-1)?.value.timestamp) ?? optionalTimestamp(header.timestamp),
    firstUserMessageChars,
    attributions,
    successfulAssistantTurns,
    errorAssistantTurns,
    abortedAssistantTurns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reportedCostUsd: costUsd,
    toolCallCount,
    toolErrorCount,
    terminalStatus,
    mixedModel: new Set(attributions.map((row) => row.modelId)).size > 1,
    sourceProvenance: [...new Set(provenance)].sort(),
    review: null,
  };
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) files.push(fullPath);
    }
  }
  await visit(root);
  return files.sort();
}

function coerceReview(value: unknown): { path: string; review: HistoricalSessionReview; orderAt: number } | null {
  if (!isRecord(value) || value.selfClose === true || typeof value.sessionPath !== 'string') return null;
  if (typeof value.done !== 'boolean' || typeof value.rating !== 'number' || !Number.isFinite(value.rating)) return null;
  if (value.completion !== 'fully' && value.completion !== 'partial' && value.completion !== 'setback') return null;
  const evaluatedAt = optionalTimestamp(value.evaluatedAt);
  const recordedAt = optionalTimestamp(value.recordedAt);
  if (!evaluatedAt && !recordedAt) return null;
  const reviewerBuckets = Array.isArray(value.reviewerBuckets)
    ? value.reviewerBuckets.filter((item): item is string => typeof item === 'string')
    : [];
  const reviewerCount = typeof value.reviewerCount === 'number' && Number.isFinite(value.reviewerCount)
    ? Math.max(0, Math.trunc(value.reviewerCount))
    : reviewerBuckets.length;
  return {
    path: normalizeSessionPath(value.sessionPath),
    orderAt: Math.max(Date.parse(evaluatedAt ?? '') || 0, Date.parse(recordedAt ?? '') || 0),
    review: {
      rating: value.rating,
      completion: value.completion as AgentReviewCompletion,
      done: value.done,
      evaluatedAt: evaluatedAt ?? recordedAt!,
      reviewerBuckets,
      reviewerCount,
    },
  };
}

export interface MixedSessionReviewSidecar {
  legacy: LegacySessionReviewSource[];
  productionV2: SessionReviewV2Source[];
}

/** Read mixed V1/V2 storage without coercing either cohort into the other. */
export async function readMixedSessionReviews(sidecarPath?: string): Promise<MixedSessionReviewSidecar> {
  const latest = new Map<string, { review: HistoricalSessionReview; orderAt: number; line: number }>();
  const production = new Map<string, SessionReviewV2Source>();
  if (!sidecarPath) return { legacy: [], productionV2: [] };
  let raw: string;
  try {
    raw = await fs.readFile(sidecarPath, 'utf8');
  } catch {
    return { legacy: [], productionV2: [] };
  }
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed: unknown = JSON.parse(line);
      const v2 = coerceSessionReviewV2(parsed);
      if (v2) {
        const previous = production.get(v2.sessionId);
        if (!previous || v2.reviewedAt > previous.reviewedAt
          || (v2.reviewedAt === previous.reviewedAt && v2.reviewId > previous.reviewId)) production.set(v2.sessionId, v2);
        return;
      }
      const coerced = coerceReview(parsed);
      if (!coerced) return;
      const previous = latest.get(coerced.path);
      if (!previous || coerced.orderAt > previous.orderAt || (coerced.orderAt === previous.orderAt && index > previous.line)) {
        latest.set(coerced.path, { review: coerced.review, orderAt: coerced.orderAt, line: index });
      }
    } catch {
      // Malformed sidecar lines do not invalidate other reviews.
    }
  });
  return {
    legacy: [...latest].map(([normalizedSessionPath, value]) => ({
      ...value.review,
      cohort: 'legacy_v1',
      sessionId: sessionPathHash(normalizedSessionPath),
      normalizedSessionPath,
      identityFallback: true,
    })),
    productionV2: [...production.values()],
  };
}

export async function readLatestSessionReviews(sidecarPath?: string): Promise<Map<string, HistoricalSessionReview>> {
  const mixed = await readMixedSessionReviews(sidecarPath);
  return new Map(mixed.legacy.map((review) => [review.normalizedSessionPath, {
    rating: review.rating,
    completion: review.completion,
    done: review.done,
    evaluatedAt: review.evaluatedAt,
    reviewerBuckets: review.reviewerBuckets,
    reviewerCount: review.reviewerCount,
  }]));
}

/** Discover legacy + configured local transcripts, deduplicating overlapping roots. */
export async function discoverHistoricalSessions(options: TranscriptDiscoveryOptions): Promise<HistoricalSessionSourceSummary[]> {
  const roots: Array<{ root: string; provenance: TranscriptSourceProvenance }> = [
    { root: options.legacySessionsDir, provenance: 'legacy' },
  ];
  if (options.configuredSessionsDir) roots.push({ root: options.configuredSessionsDir, provenance: 'configured' });

  const discovered = new Map<string, { filePath: string; provenance: Set<TranscriptSourceProvenance> }>();
  for (const { root, provenance } of roots) {
    for (const filePath of await listJsonlFiles(root)) {
      const normalized = normalizeSessionPath(path.resolve(filePath));
      const existing = discovered.get(normalized);
      if (existing) existing.provenance.add(provenance);
      else discovered.set(normalized, { filePath: path.resolve(filePath), provenance: new Set([provenance]) });
    }
  }

  const reviews = await readLatestSessionReviews(options.reviewSidecarPath);
  const summaries: HistoricalSessionSourceSummary[] = [];
  for (const { filePath, provenance } of discovered.values()) {
    try {
      const summary = summarizeTranscriptJsonl(await fs.readFile(filePath, 'utf8'), filePath, [...provenance]);
      if (summary) {
        summary.review = reviews.get(summary.normalizedSessionPath) ?? null;
        summaries.push(summary);
      }
    } catch {
      // A missing/unreadable transcript does not prevent loading the remaining history.
    }
  }
  return summaries.sort((left, right) => left.normalizedSessionPath.localeCompare(right.normalizedSessionPath));
}

/** Privacy-preserving coercion for optional summaries embedded in portable exports. */
export function coerceHistoricalSessionSummaries(value: unknown): HistoricalSessionSourceSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: HistoricalSessionSourceSummary[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.sessionId !== 'string' || typeof entry.normalizedSessionPath !== 'string') continue;
    const attributions: HistoricalSessionAttribution[] = Array.isArray(entry.attributions)
      ? entry.attributions.filter(isRecord).flatMap((row) => {
        if (typeof row.modelId !== 'string' || typeof row.share !== 'number' || !Number.isFinite(row.share)) return [];
        return [{
          modelId: row.modelId,
          thinkingLevel: normalizeThinking(row.thinkingLevel),
          share: Math.max(0, row.share),
          successfulAssistantTurns: Math.trunc(finiteNonNegative(row.successfulAssistantTurns)),
          attributedTokens: finiteNonNegative(row.attributedTokens),
        }];
      })
      : [];
    const attributedTokenTotal = attributions.reduce((sum, row) => sum + row.attributedTokens, 0);
    const attributedTurnTotal = attributions.reduce((sum, row) => sum + row.successfulAssistantTurns, 0);
    for (const row of attributions) {
      row.share = attributedTokenTotal > 0
        ? row.attributedTokens / attributedTokenTotal
        : attributedTurnTotal > 0 ? row.successfulAssistantTurns / attributedTurnTotal : 0;
    }
    const reviewValue = isRecord(entry.review) ? entry.review : null;
    const review = reviewValue ? coerceReview({ ...reviewValue, sessionPath: entry.normalizedSessionPath })?.review ?? null : null;
    const terminalStatus = entry.terminalStatus === 'success' || entry.terminalStatus === 'error' || entry.terminalStatus === 'aborted'
      ? entry.terminalStatus : 'none';
    summaries.push({
      sessionId: entry.sessionId,
      normalizedSessionPath: normalizeSessionPath(entry.normalizedSessionPath),
      startedAt: optionalTimestamp(entry.startedAt),
      endedAt: optionalTimestamp(entry.endedAt),
      firstUserMessageChars: entry.firstUserMessageChars === null ? null : Math.trunc(finiteNonNegative(entry.firstUserMessageChars)),
      attributions,
      successfulAssistantTurns: Math.trunc(finiteNonNegative(entry.successfulAssistantTurns)),
      errorAssistantTurns: Math.trunc(finiteNonNegative(entry.errorAssistantTurns)),
      abortedAssistantTurns: Math.trunc(finiteNonNegative(entry.abortedAssistantTurns)),
      inputTokens: finiteNonNegative(entry.inputTokens),
      outputTokens: finiteNonNegative(entry.outputTokens),
      cacheReadTokens: finiteNonNegative(entry.cacheReadTokens),
      cacheWriteTokens: finiteNonNegative(entry.cacheWriteTokens),
      reportedCostUsd: typeof entry.reportedCostUsd === 'number' && Number.isFinite(entry.reportedCostUsd) && entry.reportedCostUsd >= 0 ? entry.reportedCostUsd : null,
      toolCallCount: Math.trunc(finiteNonNegative(entry.toolCallCount)),
      toolErrorCount: Math.trunc(finiteNonNegative(entry.toolErrorCount)),
      terminalStatus,
      mixedModel: entry.mixedModel === true,
      sourceProvenance: ['portable-export'],
      review,
    });
  }
  return summaries;
}
