#!/usr/bin/env node

/**
 * Privacy-preserving offline analysis of real Pie compaction entries.
 *
 * Reads local session JSONL in the trusted process and emits aggregate numbers
 * only: no prompts, summaries, file paths, session ids, or tool output.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const sessionsRoot = path.resolve(process.argv[2] ?? 'data/outcomes/sessions');

async function collect(directory) {
  const result = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await collect(target));
      else if (entry.name.endsWith('.jsonl')) result.push(target);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return result;
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') chars += part.text.length;
    if (typeof part.thinking === 'string') chars += part.thinking.length;
    const name = typeof part.name === 'string' ? part.name : typeof part.toolName === 'string' ? part.toolName : '';
    if (name) chars += name.length;
    const args = part.arguments ?? part.input;
    if (args !== undefined) {
      try { chars += JSON.stringify(args).length; } catch { /* aggregate analysis only */ }
    }
  }
  return chars;
}

function entryEstimate(entry) {
  if (entry?.type === 'message' && entry.message) {
    return {
      tokens: Math.ceil(contentChars(entry.message.content) / 4),
      toolResultTokens: entry.message.role === 'toolResult'
        ? Math.ceil(contentChars(entry.message.content) / 4)
        : 0,
    };
  }
  if (entry?.type === 'custom_message') {
    const tokens = Math.ceil(contentChars(entry.content) / 4);
    return { tokens, toolResultTokens: 0 };
  }
  return { tokens: 0, toolResultTokens: 0 };
}

function sumEstimate(entries, start, end) {
  let tokens = 0;
  let toolResultTokens = 0;
  for (let index = Math.max(0, start); index < Math.min(end, entries.length); index += 1) {
    const estimate = entryEstimate(entries[index]);
    tokens += estimate.tokens;
    toolResultTokens += estimate.toolResultTokens;
  }
  return { tokens, toolResultTokens };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * quantile)));
  return sorted[index];
}

function summaryShape(summary) {
  const requiredHeadings = [
    '## Goal',
    '## Constraints & Preferences',
    '## Progress',
    '## Key Decisions',
    '## Next Steps',
    '## Critical Context',
  ];
  return {
    allRequiredHeadings: requiredHeadings.every((heading) => summary.includes(heading)),
    readFilesTag: summary.includes('<read-files>') && summary.includes('</read-files>'),
    modifiedFilesTag: summary.includes('<modified-files>') && summary.includes('</modified-files>'),
  };
}

function isSubset(previous, current) {
  const set = new Set(current);
  return previous.every((value) => set.has(value));
}

const files = await collect(sessionsRoot);
const metrics = [];
let malformedLines = 0;
let compactionSessions = 0;
let repeatedCompactionSessions = 0;
let cumulativeReadChecks = 0;
let cumulativeReadPasses = 0;
let cumulativeModifiedChecks = 0;
let cumulativeModifiedPasses = 0;
let cumulativeTrackedChecks = 0;
let cumulativeTrackedPasses = 0;

for (const file of files) {
  const entries = [];
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { malformedLines += 1; }
  }
  const compactions = entries.filter((entry) => entry?.type === 'compaction');
  if (compactions.length === 0) continue;
  compactionSessions += 1;
  const byId = new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  let sessionHasRepeatedBranch = false;

  for (const compaction of compactions) {
    const reversedPath = [];
    const visited = new Set();
    let cursor = compaction;
    while (cursor && !visited.has(cursor.id)) {
      reversedPath.push(cursor);
      visited.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    const pathEntries = reversedPath.reverse();
    const compactionIndex = pathEntries.length - 1;
    const firstKeptIndex = pathEntries.findIndex((entry) => entry?.id === compaction.firstKeptEntryId);
    const previousIndex = pathEntries.slice(0, compactionIndex).findLastIndex((entry) => entry?.type === 'compaction');
    const previousCompaction = previousIndex >= 0 ? pathEntries[previousIndex] : null;
    if (previousCompaction) sessionHasRepeatedBranch = true;
    const previousKeptIndex = previousCompaction
      ? pathEntries.findIndex((entry) => entry?.id === previousCompaction.firstKeptEntryId)
      : 0;
    const boundaryStart = previousCompaction
      ? (previousKeptIndex >= 0 ? previousKeptIndex : previousIndex + 1)
      : 0;
    const summarized = sumEstimate(pathEntries, boundaryStart, firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex);
    const retained = sumEstimate(pathEntries, firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex, compactionIndex);
    const summary = typeof compaction.summary === 'string' ? compaction.summary : '';
    const summaryTokens = Math.ceil(summary.length / 4);
    const details = compaction.details && typeof compaction.details === 'object' ? compaction.details : {};
    const readFiles = Array.isArray(details.readFiles) ? details.readFiles.filter((item) => typeof item === 'string') : [];
    const modifiedFiles = Array.isArray(details.modifiedFiles) ? details.modifiedFiles.filter((item) => typeof item === 'string') : [];
    const shape = summaryShape(summary);

    if (previousCompaction) {
      const previousDetails = previousCompaction.details && typeof previousCompaction.details === 'object'
        ? previousCompaction.details
        : {};
      const previousRead = Array.isArray(previousDetails.readFiles) ? previousDetails.readFiles.filter((item) => typeof item === 'string') : [];
      const previousModified = Array.isArray(previousDetails.modifiedFiles) ? previousDetails.modifiedFiles.filter((item) => typeof item === 'string') : [];
      cumulativeReadChecks += 1;
      cumulativeModifiedChecks += 1;
      cumulativeTrackedChecks += 1;
      if (isSubset(previousRead, readFiles)) cumulativeReadPasses += 1;
      if (isSubset(previousModified, modifiedFiles)) cumulativeModifiedPasses += 1;
      if (isSubset([...new Set([...previousRead, ...previousModified])], [...new Set([...readFiles, ...modifiedFiles])])) {
        cumulativeTrackedPasses += 1;
      }
    }

    const tokensBefore = Number.isFinite(compaction.tokensBefore) ? compaction.tokensBefore : null;
    const estimatedAfter = summaryTokens + retained.tokens;
    metrics.push({
      tokensBefore,
      summaryTokens,
      retainedTokens: retained.tokens,
      estimatedAfter,
      estimatedCompressionRatio: tokensBefore && tokensBefore > 0 ? estimatedAfter / tokensBefore : null,
      summarizedToolResultShare: summarized.tokens > 0 ? summarized.toolResultTokens / summarized.tokens : null,
      readFileCount: readFiles.length,
      modifiedFileCount: modifiedFiles.length,
      hasStructuredDetails: Array.isArray(details.readFiles) && Array.isArray(details.modifiedFiles),
      ...shape,
    });
  }
  if (sessionHasRepeatedBranch) repeatedCompactionSessions += 1;
}

const finite = (key) => metrics.map((item) => item[key]).filter((value) => typeof value === 'number' && Number.isFinite(value));
const ratios = finite('estimatedCompressionRatio');
const toolShares = finite('summarizedToolResultShare');
const report = {
  privacy: 'aggregate-only; no session ids, prompts, summaries, file paths, or tool output',
  corpus: {
    root: path.relative(process.cwd(), sessionsRoot).replaceAll('\\', '/'),
    sessionFiles: files.length,
    malformedLines,
    sessionsWithCompaction: compactionSessions,
    sessionsWithRepeatedCompaction: repeatedCompactionSessions,
    compactionEntries: metrics.length,
  },
  tokenMetrics: {
    tokensBefore: {
      min: Math.min(...finite('tokensBefore')),
      median: percentile(finite('tokensBefore'), 0.5),
      max: Math.max(...finite('tokensBefore')),
    },
    summaryTokens: {
      min: Math.min(...finite('summaryTokens')),
      median: percentile(finite('summaryTokens'), 0.5),
      max: Math.max(...finite('summaryTokens')),
    },
    estimatedRetainedTokens: {
      min: Math.min(...finite('retainedTokens')),
      median: percentile(finite('retainedTokens'), 0.5),
      max: Math.max(...finite('retainedTokens')),
    },
    estimatedAfterToBeforeRatio: {
      median: percentile(ratios, 0.5),
      max: Math.max(...ratios),
      entriesAtOrAboveHalf: ratios.filter((value) => value >= 0.5).length,
    },
  },
  layeredCompactionSignals: {
    summarizedToolResultTokenShare: {
      median: percentile(toolShares, 0.5),
      max: Math.max(...toolShares),
      entriesAtOrAboveOneThird: toolShares.filter((value) => value >= 1 / 3).length,
    },
  },
  durableStructuredState: {
    entriesWithReadAndModifiedArrays: metrics.filter((item) => item.hasStructuredDetails).length,
    repeatedReadFileCumulativePasses: `${cumulativeReadPasses}/${cumulativeReadChecks}`,
    repeatedModifiedFileCumulativePasses: `${cumulativeModifiedPasses}/${cumulativeModifiedChecks}`,
    repeatedTrackedFileUnionCumulativePasses: `${cumulativeTrackedPasses}/${cumulativeTrackedChecks}`,
    summariesWithRequiredHeadings: metrics.filter((item) => item.allRequiredHeadings).length,
    summariesWithReadFileTags: metrics.filter((item) => item.readFilesTag).length,
    summariesWithModifiedFileTags: metrics.filter((item) => item.modifiedFilesTag).length,
    readFileCountMedian: percentile(finite('readFileCount'), 0.5),
    modifiedFileCountMedian: percentile(finite('modifiedFileCount'), 0.5),
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
