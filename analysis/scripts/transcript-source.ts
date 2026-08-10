import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  HistoricalSessionAttribution,
  HistoricalSessionSourceSummary,
  SessionReviewV2IngestionDiagnostics,
  SessionReviewV2Source,
  ThinkingLevel,
  TranscriptSourceProvenance,
} from './contracts.ts';
import { inspectSessionReviewV2 } from './review-analytics.ts';

interface JsonRecord { [key: string]: unknown }

interface TranscriptNode {
  id: string;
  parentId: string | null;
  order: number;
  value: JsonRecord;
}

export interface TranscriptDiscoveryOptions {
  /** Canonical configured session root. When absent, no local transcripts are
   *  discovered — the installer's verified migration is the authority for any
   *  legacy content, and `npm run doctor` detects newly stranded legacy
   *  sessions instead of perpetually scanning legacy roots. */
  configuredSessionsDir?: string;
}

const THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
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
  const normalized = value.trim().toLowerCase();
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

function emptyReviewDiagnostics(): SessionReviewV2IngestionDiagnostics {
  return {
    rawProductionCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    rejectedByReason: {
      unsupported_schema: 0,
      unsupported_rubric: 0,
      unsupported_index: 0,
      invalid_identity: 0,
      invalid_payload: 0,
    },
  };
}

export interface SessionReviewV2Sidecar {
  reviews: SessionReviewV2Source[];
  diagnostics: SessionReviewV2IngestionDiagnostics;
}

/** Read only canonical V2 production reviews. Non-production lines are ignored. */
export async function readSessionReviewsV2(sidecarPath?: string): Promise<SessionReviewV2Sidecar> {
  const production = new Map<string, SessionReviewV2Source>();
  const diagnostics = emptyReviewDiagnostics();
  if (!sidecarPath) return { reviews: [], diagnostics };
  let raw: string;
  try {
    raw = await fs.readFile(sidecarPath, 'utf8');
  } catch {
    return { reviews: [], diagnostics };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || parsed.kind !== 'production') continue;
      diagnostics.rawProductionCount += 1;
      const result = inspectSessionReviewV2(parsed);
      if (!result.review) {
        diagnostics.rejectedCount += 1;
        diagnostics.rejectedByReason[result.rejectionReason] += 1;
        continue;
      }
      diagnostics.acceptedCount += 1;
      const review = result.review;
      // Append-only canonical policy is consistent across the writer, host, and
      // analytics: the first valid production review for a session wins.
      if (!production.has(review.sessionId)) production.set(review.sessionId, review);
    } catch {
      // The review sidecar is V2-only, so every malformed non-empty line is a
      // rejected production-record candidate rather than invisible data loss.
      diagnostics.rawProductionCount += 1;
      diagnostics.rejectedCount += 1;
      diagnostics.rejectedByReason.invalid_payload += 1;
    }
  }
  return { reviews: [...production.values()], diagnostics };
}

/** Discover local transcripts from the canonical configured root only.
 *
 *  Legacy roots are no longer scanned at runtime: the installer's verified
 *  copy/merge moved historical transcripts into the canonical store, so a
 *  perpetual legacy scan would only re-surface stale or stranded copies.
 *  `npm run doctor` detects sessions stranded in a legacy root without a
 *  canonical counterpart. */
export async function discoverHistoricalSessions(options: TranscriptDiscoveryOptions): Promise<HistoricalSessionSourceSummary[]> {
  if (!options.configuredSessionsDir) return [];

  const discovered = new Map<string, { filePath: string; provenance: Set<TranscriptSourceProvenance> }>();
  for (const filePath of await listJsonlFiles(options.configuredSessionsDir)) {
    const normalized = normalizeSessionPath(path.resolve(filePath));
    discovered.set(normalized, {
      filePath: path.resolve(filePath),
      provenance: new Set<TranscriptSourceProvenance>(['configured']),
    });
  }

  const summaries: HistoricalSessionSourceSummary[] = [];
  for (const { filePath, provenance } of discovered.values()) {
    try {
      const summary = summarizeTranscriptJsonl(await fs.readFile(filePath, 'utf8'), filePath, [...provenance]);
      if (summary) summaries.push(summary);
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
    });
  }
  return summaries;
}
