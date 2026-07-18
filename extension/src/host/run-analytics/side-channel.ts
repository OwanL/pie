/**
 * Portable side-channel log parsers for run-analytics exports.
 *
 * These logs are global to the pie data root (`<configRoot>/data/*.jsonl`) and
 * are not part of any single workspace's run store. They are parsed into the
 * same shape consumed by the analysis tree so that portable exports are self-
 * contained and can be analyzed on another machine without relying on the
 * analyzer's local logs.
 */

import * as path from 'node:path';

import { readOptionalText } from '../shared/checkpoint-io';
import { parseJsonOrThrow } from '../../shared/error-message';
import { isObjectRecord, toNonNegativeInteger } from './coercion-utils';

export interface PruningDecision {
  timestamp: string;
  sessionId: string;
  sessionPath: string;
  mode: string;
  query: string;
  llmModel: string;
  llmThinkingLevel: string;
  llmLatencyMs: number;
  included: string[];
  excluded: string[];
  skillBlockTokens: number;
  originalBlockTokens: number;
  toolIncluded?: string[];
  toolExcluded?: string[];
  toolBlockTokens?: number;
  originalToolBlockTokens?: number;
  prepassInputTokens?: number;
  prepassOutputTokens?: number;
  prepassCacheReadTokens?: number;
  prepassCacheWriteTokens?: number;
  prepassInputEstimateTokens?: number;
  codeVersion?: string;
}

export type PruningEventKind = 'skill_read' | 'skill_miss' | 'shadow_miss_candidate' | 'skill_recovered' | 'tool_recovered';

export interface PruningEvent {
  event: PruningEventKind;
  skillName?: string;
  toolName?: string;
  sessionId: string;
  timestamp: string;
}

export interface ToolResultPruningEvent {
  event: 'tool_result_pruned';
  sessionId: string;
  toolName: string;
  rules: string[];
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  timestamp: string;
}

export interface WarmBashRewrite {
  event: 'auto_prune_rewrite';
  sessionId: string;
  timestamp: string;
  before: string;
  after: string;
}

export interface WarmBashSessionSummary {
  event: 'session_summary';
  sessionId: string;
  timestamp: string;
  fastPath: number;
  warm: number;
  fallback: number;
  poolSize: number;
  warmupFailures: number;
  autoPruneEnabled: boolean;
  fastPathEnabled: boolean;
  gnuGrep: boolean;
}

export interface GlobalSideChannels {
  pruningDecisions: PruningDecision[];
  pruningEvents: PruningEvent[];
  toolResultPruningEvents: ToolResultPruningEvent[];
  warmBashRewrites: WarmBashRewrite[];
  warmBashSummaries: WarmBashSessionSummary[];
}

/**
 * Derive the global log root from a workspace-specific run store directory.
 * Run stores live at `<configRoot>/data/outcomes/<hash>`, so walking up two
 * levels yields the data root. If the path does not follow that convention,
 * fall back to the supplied directory.
 */
export function inferGlobalLogRoot(storageDir: string): string {
  const normalized = path.normalize(storageDir);
  const parent = path.dirname(normalized);            // outcomes
  const grandparent = path.dirname(parent);          // data
  const configRoot = path.dirname(grandparent);       // repository / global config root
  if (path.basename(parent) === 'outcomes' && path.basename(grandparent) === 'data') {
    return configRoot;
  }
  return normalized;
}

function parseJsonlLines(raw: string): unknown[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return parseJsonOrThrow<unknown>(line, 'side-channel line');
      } catch {
        return null;
      }
    })
    .filter((value): value is unknown => value !== null);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

const PRUNING_EVENT_KINDS = new Set<PruningEventKind>([
  'skill_read',
  'skill_miss',
  'shadow_miss_candidate',
  'skill_recovered',
  'tool_recovered',
]);

export async function readPruningLog(configRoot: string): Promise<{ decisions: PruningDecision[]; events: PruningEvent[] }> {
  const logPath = path.join(configRoot, 'data', 'pruning.jsonl');
  const raw = await readOptionalText(logPath);
  if (!raw) {
    return { decisions: [], events: [] };
  }

  const decisions: PruningDecision[] = [];
  const events: PruningEvent[] = [];

  for (const parsed of parseJsonlLines(raw)) {
    if (!isObjectRecord(parsed)) {
      continue;
    }

    // Decision-shaped lines carry no `event` field and include included/excluded arrays.
    if (
      typeof parsed.timestamp === 'string'
      && typeof parsed.sessionId === 'string'
      && typeof parsed.mode === 'string'
      && Array.isArray(parsed.included)
      && Array.isArray(parsed.excluded)
    ) {
      decisions.push({
        timestamp: parsed.timestamp,
        sessionId: parsed.sessionId,
        sessionPath: typeof parsed.sessionPath === 'string' ? parsed.sessionPath : parsed.sessionId,
        mode: parsed.mode,
        // Pruning queries may contain user-authored prompt text. Portable
        // exports retain the decision metrics but never copy that content.
        query: '',
        llmModel: typeof parsed.llmModel === 'string' ? parsed.llmModel : '',
        llmThinkingLevel: typeof parsed.llmThinkingLevel === 'string' ? parsed.llmThinkingLevel : '',
        llmLatencyMs: typeof parsed.llmLatencyMs === 'number' ? Math.trunc(parsed.llmLatencyMs) : 0,
        included: coerceStringArray(parsed.included),
        excluded: coerceStringArray(parsed.excluded),
        skillBlockTokens: toNonNegativeInteger(parsed.skillBlockTokens),
        originalBlockTokens: toNonNegativeInteger(parsed.originalBlockTokens),
        toolIncluded: Array.isArray(parsed.toolIncluded) ? coerceStringArray(parsed.toolIncluded) : undefined,
        toolExcluded: Array.isArray(parsed.toolExcluded) ? coerceStringArray(parsed.toolExcluded) : undefined,
        toolBlockTokens: typeof parsed.toolBlockTokens === 'number' ? Math.trunc(parsed.toolBlockTokens) : undefined,
        originalToolBlockTokens: typeof parsed.originalToolBlockTokens === 'number'
          ? Math.trunc(parsed.originalToolBlockTokens)
          : undefined,
        prepassInputTokens: typeof parsed.prepassInputTokens === 'number'
          ? Math.trunc(parsed.prepassInputTokens)
          : undefined,
        prepassOutputTokens: typeof parsed.prepassOutputTokens === 'number'
          ? Math.trunc(parsed.prepassOutputTokens)
          : undefined,
        prepassCacheReadTokens: typeof parsed.prepassCacheReadTokens === 'number'
          ? Math.trunc(parsed.prepassCacheReadTokens)
          : undefined,
        prepassCacheWriteTokens: typeof parsed.prepassCacheWriteTokens === 'number'
          ? Math.trunc(parsed.prepassCacheWriteTokens)
          : undefined,
        prepassInputEstimateTokens: typeof parsed.prepassInputEstimateTokens === 'number'
          ? Math.trunc(parsed.prepassInputEstimateTokens)
          : undefined,
        codeVersion: typeof parsed.codeVersion === 'string' ? parsed.codeVersion : undefined,
      });
      continue;
    }

    // Event-shaped lines carry quality signals about the pruner's behavior.
    if (
      typeof parsed.event === 'string'
      && PRUNING_EVENT_KINDS.has(parsed.event as PruningEventKind)
      && typeof parsed.sessionId === 'string'
      && typeof parsed.timestamp === 'string'
    ) {
      const event: PruningEvent = {
        event: parsed.event as PruningEventKind,
        sessionId: parsed.sessionId,
        timestamp: parsed.timestamp,
      };
      if (typeof parsed.skillName === 'string') {
        event.skillName = parsed.skillName;
      }
      if (typeof parsed.toolName === 'string') {
        event.toolName = parsed.toolName;
      }
      events.push(event);
    }
  }

  return { decisions, events };
}

export async function readToolResultPruningLog(configRoot: string): Promise<ToolResultPruningEvent[]> {
  const logPath = path.join(configRoot, 'data', 'tool-result-pruning.jsonl');
  const raw = await readOptionalText(logPath);
  if (!raw) {
    return [];
  }

  const events: ToolResultPruningEvent[] = [];
  for (const parsed of parseJsonlLines(raw)) {
    if (!isObjectRecord(parsed)) {
      continue;
    }
    if (
      parsed.event === 'tool_result_pruned'
      && typeof parsed.sessionId === 'string'
      && typeof parsed.toolName === 'string'
      && Array.isArray(parsed.rules)
      && parsed.rules.every((r: unknown) => typeof r === 'string')
      && typeof parsed.beforeTokens === 'number'
      && typeof parsed.afterTokens === 'number'
      && typeof parsed.tokensSaved === 'number'
      && typeof parsed.timestamp === 'string'
    ) {
      events.push({
        event: 'tool_result_pruned',
        sessionId: parsed.sessionId,
        toolName: parsed.toolName,
        rules: parsed.rules as string[],
        beforeTokens: Math.trunc(parsed.beforeTokens),
        afterTokens: Math.trunc(parsed.afterTokens),
        tokensSaved: Math.trunc(parsed.tokensSaved),
        timestamp: parsed.timestamp,
      });
    }
  }
  return events;
}

export async function readWarmBashLog(
  configRoot: string,
): Promise<{ rewrites: WarmBashRewrite[]; summaries: WarmBashSessionSummary[] }> {
  const logPath = path.join(configRoot, 'data', 'warm-bash.jsonl');
  const raw = await readOptionalText(logPath);
  if (!raw) {
    return { rewrites: [], summaries: [] };
  }

  const rewrites: WarmBashRewrite[] = [];
  const summaries: WarmBashSessionSummary[] = [];
  for (const parsed of parseJsonlLines(raw)) {
    if (!isObjectRecord(parsed)) {
      continue;
    }

    if (
      parsed.event === 'auto_prune_rewrite'
      && typeof parsed.sessionId === 'string'
      && typeof parsed.timestamp === 'string'
      && typeof parsed.before === 'string'
      && typeof parsed.after === 'string'
    ) {
      rewrites.push({
        event: 'auto_prune_rewrite',
        sessionId: parsed.sessionId,
        timestamp: parsed.timestamp,
        before: parsed.before,
        after: parsed.after,
      });
      continue;
    }

    if (
      parsed.event === 'session_summary'
      && typeof parsed.sessionId === 'string'
      && typeof parsed.timestamp === 'string'
      && typeof parsed.fastPath === 'number'
      && typeof parsed.warm === 'number'
      && typeof parsed.fallback === 'number'
      && typeof parsed.poolSize === 'number'
      && typeof parsed.warmupFailures === 'number'
      && typeof parsed.autoPruneEnabled === 'boolean'
      && typeof parsed.fastPathEnabled === 'boolean'
      && typeof parsed.gnuGrep === 'boolean'
    ) {
      summaries.push({
        event: 'session_summary',
        sessionId: parsed.sessionId,
        timestamp: parsed.timestamp,
        fastPath: Math.trunc(parsed.fastPath),
        warm: Math.trunc(parsed.warm),
        fallback: Math.trunc(parsed.fallback),
        poolSize: Math.trunc(parsed.poolSize),
        warmupFailures: Math.trunc(parsed.warmupFailures),
        autoPruneEnabled: parsed.autoPruneEnabled,
        fastPathEnabled: parsed.fastPathEnabled,
        gnuGrep: parsed.gnuGrep,
      });
    }
  }
  return { rewrites, summaries };
}

export async function readGlobalSideChannels(configRoot: string): Promise<GlobalSideChannels> {
  const [{ decisions, events }, toolResultPruningEvents, { summaries }] = await Promise.all([
    readPruningLog(configRoot),
    readToolResultPruningLog(configRoot),
    readWarmBashLog(configRoot),
  ]);

  return {
    pruningDecisions: decisions,
    pruningEvents: events,
    toolResultPruningEvents,
    // Rewrite records contain raw shell commands (`before`/`after`) and may
    // include paths or secrets. Keep portable exports content-free; local
    // analysis can still read the source-machine log directly.
    warmBashRewrites: [],
    warmBashSummaries: summaries,
  };
}
