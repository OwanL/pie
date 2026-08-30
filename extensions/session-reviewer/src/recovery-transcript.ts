import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EvidenceManifest } from './types.js';

export interface RecoveryToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  line: number;
}

export interface RecoveryToolResult {
  toolCallId: string;
  toolName: string;
  details?: unknown;
  contentText: string;
  timestamp?: unknown;
  line: number;
}

export interface RecoveryTranscriptIndex {
  /** Latest call by tool-call ID, used for provenance lookups. */
  calls: Map<string, RecoveryToolCall>;
  /** Every physical call on the active branch, including duplicate IDs. */
  callOccurrences: RecoveryToolCall[];
  results: Map<string, RecoveryToolResult>;
  evidenceBySessionId: Map<string, EvidenceManifest[]>;
}

interface CompactEntry {
  line: number;
  isSession: boolean;
  id?: string;
  parentId?: string | null;
  validParent: boolean;
  calls: RecoveryToolCall[];
  result?: RecoveryToolResult;
}

interface CachedTranscript {
  sourceBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  dev: number;
  ino: number;
  completeEntries: CompactEntry[];
  trailingBytes: Buffer;
  nextLine: number;
  headProbe: Buffer;
  tailProbe: Buffer;
}

export interface RecoveryTranscriptCacheMetrics {
  fullReads: number;
  incrementalReads: number;
  unchangedHits: number;
  rebuilds: number;
  bytesRead: number;
  appendedBytesRead: number;
  probeBytesRead: number;
  cachedFiles: number;
  cachedSourceBytes: number;
}

const MAX_CACHED_FILES = 4;
const MAX_CACHED_SOURCE_BYTES = 64 * 1024 * 1024;
const PREFIX_PROBE_BYTES = 4 * 1024;
// Keep one character beyond the recovery parser's limit so an oversized result
// remains observably oversized without retaining an unbounded child transcript.
const MAX_STRUCTURED_OUTPUT_CHARS = (256 * 1024) + 1;
const MAX_STABLE_READ_ATTEMPTS = 2;
const UNSTABLE_APPEND = Symbol('unstable-append');

const transcriptCache = new Map<string, CachedTranscript>();
const counters = {
  fullReads: 0,
  incrementalReads: 0,
  unchangedHits: 0,
  rebuilds: 0,
  bytesRead: 0,
  appendedBytesRead: 0,
  probeBytesRead: 0,
};

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= MAX_STRUCTURED_OUTPUT_CHARS
    ? value
    : value.slice(0, MAX_STRUCTURED_OUTPUT_CHARS);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function selected(objectValue: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) if (objectValue[key] !== undefined) result[key] = objectValue[key];
  return result;
}

function compactArguments(name: string, value: unknown): Record<string, unknown> {
  const args = object(value) ?? {};
  if (name === 'subagent') return selected(args, ['agent', 'bucket', 'workflowRef']);
  if (name === 'ask_user') return selected(args, ['question', 'options', 'allowCustom', 'context', 'reviewMeta']);
  return {};
}

function compactDetails(toolName: string, value: unknown): Record<string, unknown> | undefined {
  const details = object(value);
  if (!details) return undefined;
  if (toolName === 'subagent') {
    const results = Array.isArray(details.results)
      ? details.results.flatMap((candidate) => {
        const runtime = object(candidate);
        if (!runtime) return [];
        const compact = selected(runtime, [
          'parentToolCallId', 'exitCode', 'requestedBucket', 'bucket', 'bucketDowngraded',
          'model', 'selectedModel', 'provider', 'family', 'thinkingLevel', 'promptHash',
        ]);
        const finalOutput = boundedString(runtime.finalOutput);
        if (finalOutput !== undefined) compact.finalOutput = finalOutput;
        return [compact];
      })
      : [];
    return { results };
  }
  if (toolName === 'ask_user') {
    return selected(details, ['answer', 'source', 'cancelled', 'targetSessionId']);
  }
  if (toolName === 'session_review') {
    return selected(details, ['sessionId', 'manifest']);
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const value of content) {
    const part = object(value);
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const remaining = MAX_STRUCTURED_OUTPUT_CHARS - text.length;
    if (remaining <= 0) break;
    text += part.text.slice(0, remaining);
  }
  return text;
}

function compactLine(raw: Buffer, line: number): CompactEntry | undefined {
  const source = raw.toString('utf8').replace(/\r$/, '');
  if (!source.trim()) return undefined;
  let entry: Record<string, unknown>;
  try { entry = JSON.parse(source) as Record<string, unknown>; }
  catch { return undefined; }

  const calls: RecoveryToolCall[] = [];
  let result: RecoveryToolResult | undefined;
  const message = object(entry.message);
  if (entry.type === 'message' && message?.role === 'assistant' && Array.isArray(message.content)) {
    for (const value of message.content) {
      const part = object(value);
      if (part?.type !== 'toolCall' || typeof part.id !== 'string' || (part.name !== 'subagent' && part.name !== 'ask_user')) continue;
      calls.push({ id: part.id, name: part.name, arguments: compactArguments(part.name, part.arguments), line });
    }
  } else if (
    entry.type === 'message'
    && message?.role === 'toolResult'
    && typeof message.toolCallId === 'string'
    && typeof message.toolName === 'string'
    && (message.toolName === 'subagent' || message.toolName === 'ask_user' || message.toolName === 'session_review')
  ) {
    result = {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      details: compactDetails(message.toolName, message.details),
      contentText: message.toolName === 'subagent' ? textFromContent(message.content) : '',
      timestamp: message.timestamp ?? entry.timestamp,
      line,
    };
  }

  return {
    line,
    isSession: entry.type === 'session',
    ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
    ...(entry.parentId === null || typeof entry.parentId === 'string' ? { parentId: entry.parentId } : {}),
    validParent: entry.parentId === null || typeof entry.parentId === 'string',
    calls,
    ...(result ? { result } : {}),
  };
}

function consumeCompleteLines(
  priorTrailing: Buffer,
  appended: Buffer,
  firstLine: number,
): { entries: CompactEntry[]; trailingBytes: Buffer; nextLine: number } {
  const combined = priorTrailing.length ? Buffer.concat([priorTrailing, appended]) : appended;
  const entries: CompactEntry[] = [];
  let offset = 0;
  let line = firstLine;
  while (offset < combined.length) {
    const newline = combined.indexOf(0x0a, offset);
    if (newline < 0) break;
    const parsed = compactLine(combined.subarray(offset, newline), line);
    if (parsed) entries.push(parsed);
    line += 1;
    offset = newline + 1;
  }
  return {
    entries,
    trailingBytes: Buffer.from(combined.subarray(offset)),
    nextLine: line,
  };
}

function readRange(file: string, position: number, length: number, kind: 'probe' | 'append'): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  try {
    while (total < length) {
      const read = fs.readSync(descriptor, buffer, total, length - total, position + total);
      if (read === 0) break;
      total += read;
    }
  } finally { fs.closeSync(descriptor); }
  counters.bytesRead += total;
  if (kind === 'probe') counters.probeBytesRead += total;
  else counters.appendedBytesRead += total;
  return total === length ? buffer : Buffer.from(buffer.subarray(0, total));
}

function sameFile(cache: CachedTranscript, stat: fs.Stats): boolean {
  return cache.dev === stat.dev
    && cache.ino === stat.ino
    && cache.birthtimeMs === stat.birthtimeMs;
}

function sameStatSnapshot(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.birthtimeMs === after.birthtimeMs
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function unstableReadError(file: string): Error {
  return new Error(`review orchestrator transcript changed during recovery read: ${file}`);
}

function prefixStillMatches(file: string, cache: CachedTranscript): boolean {
  if (cache.sourceBytes === 0) return true;
  const head = readRange(file, 0, cache.headProbe.length, 'probe');
  if (!head.equals(cache.headProbe)) return false;
  if (cache.sourceBytes <= PREFIX_PROBE_BYTES) return true;
  const tail = readRange(file, cache.sourceBytes - cache.tailProbe.length, cache.tailProbe.length, 'probe');
  return tail.equals(cache.tailProbe);
}

function probesFromBytes(bytes: Buffer): { headProbe: Buffer; tailProbe: Buffer } {
  return {
    headProbe: Buffer.from(bytes.subarray(0, Math.min(PREFIX_PROBE_BYTES, bytes.length))),
    tailProbe: Buffer.from(bytes.subarray(Math.max(0, bytes.length - PREFIX_PROBE_BYTES))),
  };
}

function fullRead(file: string, prior?: CachedTranscript): CachedTranscript {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const before = fs.statSync(file);
    const bytes = fs.readFileSync(file);
    const after = fs.statSync(file);
    counters.fullReads += 1;
    counters.bytesRead += bytes.length;
    if (!sameStatSnapshot(before, after) || bytes.length !== after.size) continue;
    if (prior) counters.rebuilds += 1;
    const consumed = consumeCompleteLines(Buffer.alloc(0), bytes, 1);
    return {
      sourceBytes: bytes.length,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      birthtimeMs: after.birthtimeMs,
      dev: after.dev,
      ino: after.ino,
      completeEntries: consumed.entries,
      trailingBytes: consumed.trailingBytes,
      nextLine: consumed.nextLine,
      ...probesFromBytes(bytes),
    };
  }
  throw unstableReadError(file);
}

function appendRead(file: string, cache: CachedTranscript, before: fs.Stats): CachedTranscript | typeof UNSTABLE_APPEND | undefined {
  if (!sameFile(cache, before) || before.size <= cache.sourceBytes || !prefixStillMatches(file, cache)) return undefined;
  const delta = readRange(file, cache.sourceBytes, before.size - cache.sourceBytes, 'append');
  const after = fs.statSync(file);
  if (!sameStatSnapshot(before, after) || delta.length !== before.size - cache.sourceBytes) return UNSTABLE_APPEND;
  const consumed = consumeCompleteLines(cache.trailingBytes, delta, cache.nextLine);
  const headSource = cache.headProbe.length < PREFIX_PROBE_BYTES
    ? Buffer.concat([cache.headProbe, delta]).subarray(0, PREFIX_PROBE_BYTES)
    : cache.headProbe;
  const tailSource = Buffer.concat([cache.tailProbe, delta]);
  counters.incrementalReads += 1;
  return {
    ...cache,
    sourceBytes: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
    completeEntries: [...cache.completeEntries, ...consumed.entries],
    trailingBytes: consumed.trailingBytes,
    nextLine: consumed.nextLine,
    headProbe: Buffer.from(headSource),
    tailProbe: Buffer.from(tailSource.subarray(Math.max(0, tailSource.length - PREFIX_PROBE_BYTES))),
  };
}

function installCache(key: string, cache: CachedTranscript): void {
  transcriptCache.delete(key);
  transcriptCache.set(key, cache);
  const totalBytes = (): number => [...transcriptCache.values()].reduce((sum, value) => sum + value.sourceBytes, 0);
  while (transcriptCache.size > MAX_CACHED_FILES || (transcriptCache.size > 1 && totalBytes() > MAX_CACHED_SOURCE_BYTES)) {
    const victim = transcriptCache.keys().next().value as string | undefined;
    if (!victim || victim === key && transcriptCache.size === 1) break;
    transcriptCache.delete(victim);
  }
}

function cachedTranscript(file: string): CachedTranscript {
  const key = path.resolve(file);
  const prior = transcriptCache.get(key);
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const stat = fs.statSync(key);
    let cache: CachedTranscript;
    if (
      prior
      && sameFile(prior, stat)
      && prior.sourceBytes === stat.size
      && prior.mtimeMs === stat.mtimeMs
      && prior.ctimeMs === stat.ctimeMs
    ) {
      counters.unchangedHits += 1;
      cache = prior;
    } else if (prior) {
      const appended = appendRead(key, prior, stat);
      if (appended === UNSTABLE_APPEND) continue;
      cache = appended ?? fullRead(key, prior);
    } else {
      cache = fullRead(key);
    }
    installCache(key, cache);
    return cache;
  }
  throw unstableReadError(key);
}

function activeEntries(cache: CachedTranscript): CompactEntry[] {
  const provisional = cache.trailingBytes.length ? compactLine(cache.trailingBytes, cache.nextLine) : undefined;
  const parsed = provisional ? [...cache.completeEntries, provisional] : cache.completeEntries;
  const branchEntries = parsed.filter((entry) => !entry.isSession);
  if (branchEntries.length === 0 || !branchEntries.every((entry) => entry.id && entry.validParent)) {
    // Legacy v1 and focused fixtures are append-only without tree metadata.
    return parsed;
  }
  const byId = new Map(branchEntries.map((entry) => [entry.id!, entry]));
  const activeIds = new Set<string>();
  let current: CompactEntry | undefined = branchEntries[branchEntries.length - 1];
  while (current) {
    const id = current.id!;
    if (activeIds.has(id)) return parsed;
    activeIds.add(id);
    if (current.parentId === null) break;
    current = byId.get(current.parentId!);
    if (!current) return parsed;
  }
  return parsed.filter((entry) => entry.isSession || activeIds.has(entry.id!));
}

export function readRecoveryTranscriptIndex(file: string): RecoveryTranscriptIndex {
  const calls = new Map<string, RecoveryToolCall>();
  const callOccurrences: RecoveryToolCall[] = [];
  const results = new Map<string, RecoveryToolResult>();
  const evidenceBySessionId = new Map<string, EvidenceManifest[]>();
  for (const entry of activeEntries(cachedTranscript(file))) {
    for (const call of entry.calls) {
      calls.set(call.id, call);
      callOccurrences.push(call);
    }
    if (!entry.result) continue;
    const result = entry.result;
    results.set(result.toolCallId, result);
    if (result.toolName !== 'session_review') continue;
    const details = object(result.details);
    if (typeof details?.sessionId !== 'string' || !object(details.manifest)) continue;
    const prior = evidenceBySessionId.get(details.sessionId) ?? [];
    prior.push(details.manifest as unknown as EvidenceManifest);
    evidenceBySessionId.set(details.sessionId, prior.slice(-5));
  }
  return { calls, callOccurrences, results, evidenceBySessionId };
}

/** Diagnostics/test seam. Resetting simulates an extension/backend restart. */
export function resetRecoveryTranscriptCache(): void {
  transcriptCache.clear();
  counters.fullReads = 0;
  counters.incrementalReads = 0;
  counters.unchangedHits = 0;
  counters.rebuilds = 0;
  counters.bytesRead = 0;
  counters.appendedBytesRead = 0;
  counters.probeBytesRead = 0;
}

export function recoveryTranscriptCacheMetrics(): RecoveryTranscriptCacheMetrics {
  return {
    ...counters,
    cachedFiles: transcriptCache.size,
    cachedSourceBytes: [...transcriptCache.values()].reduce((sum, value) => sum + value.sourceBytes, 0),
  };
}
