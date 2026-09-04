import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BILLABLE_INVOCATION_KINDS,
  type BillableInvocationAggregateProjection,
  type BillableInvocationAggregateRow,
  type BillableInvocationKind,
  type BillableInvocationMetricProjection,
  type BillableInvocationOutcome,
  type BillableInvocationProjection,
  type BillableInvocationProvenance,
  type BillableInvocationRecord,
  type BillableInvocationSessionSelector,
  type BillableInvocationSummary,
} from '../../shared/billable-invocation';

interface LedgerEntry {
  readonly record: BillableInvocationRecord;
  readonly private: boolean;
}

export interface BillableInvocationAppendOptions {
  /** Privacy is mandatory at the call site so an omitted classification cannot leak a private invocation. */
  readonly visibility: 'ordinary' | 'private';
}

export type BillableInvocationAppendResult = 'appended' | 'duplicate';

export interface BillableInvocationProjectionOptions {
  /** Live host projections include process-local private usage by default. */
  readonly includePrivate?: boolean;
}

/**
 * Host-owned finalized invocation ledger.
 *
 * Writer/append contract: exactly one live service instance owns a ledger file.
 * There is deliberately no cross-process lock. The owner opens in append mode,
 * writes one complete JSON object plus newline, fsyncs it, and only then updates
 * its projection. A caller retries with the same invocationId after ambiguity.
 * Equal retries are no-ops; conflicting reuse is rejected. Replay accepts the
 * first valid identity and skips malformed, torn, duplicate, or later-conflict
 * lines, so a crash cannot duplicate a projection.
 *
 * The file is append-only during ordinary operation. Privacy and forget are the
 * sole exceptions: they atomically replace it with a filtered file because
 * deletion is stronger than append-only history. Private entries never enter
 * the file or export projection and exist only in this process.
 */
export class BillableInvocationLedger {
  private readonly entriesById: Record<string, LedgerEntry> = {};
  private readonly order: string[] = [];
  private readonly privateSessionSelectors: BillableInvocationSessionSelector[] = [];

  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error('Billable invocation ledger file path is required.');
    this.replay();
  }

  hasInvocation(invocationId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.entriesById, invocationId);
  }

  append(
    record: BillableInvocationRecord,
    options: BillableInvocationAppendOptions,
  ): BillableInvocationAppendResult {
    const normalized = normalizeRecord(record);
    const existing = this.entriesById[normalized.invocationId];
    if (existing) {
      if (canonical(existing.record) !== canonical(normalized)) {
        throw new Error(`Billable invocation ${normalized.invocationId} was finalized with conflicting data.`);
      }
      return 'duplicate';
    }

    const isPrivate = options.visibility === 'private'
      || this.privateSessionSelectors.some((selector) => matchesSession(normalized, selector));
    if (!isPrivate) this.appendDurable(normalized);
    this.addEntry(normalized, isPrivate);
    return 'appended';
  }

  projectSession(
    selector: BillableInvocationSessionSelector,
    options: BillableInvocationProjectionOptions = {},
  ): BillableInvocationProjection {
    assertSelector(selector);
    return makeProjection(this.records(options).filter((record) => matchesSession(record, selector)));
  }

  projectAll(options: BillableInvocationProjectionOptions = {}): BillableInvocationProjection {
    return makeProjection(this.records(options));
  }

  projectAggregate(
    options: BillableInvocationProjectionOptions = {},
  ): BillableInvocationAggregateProjection {
    const records = this.records(options);
    const grouped: Record<string, BillableInvocationRecord[]> = {};
    for (const record of records) {
      const key = JSON.stringify([record.provider, record.model, record.kind]);
      (grouped[key] ??= []).push(record);
    }
    const groups: BillableInvocationAggregateRow[] = Object.values(grouped).map((group) => Object.freeze({
      provider: group[0].provider,
      model: group[0].model,
      kind: group[0].kind,
      summary: summarize(group),
    }));
    return Object.freeze({ summary: summarize(records), groups: Object.freeze(groups) });
  }

  /** Export authority: process-local private entries are excluded unconditionally. */
  exportRecords(): readonly BillableInvocationRecord[] {
    return Object.freeze(this.records({ includePrivate: false }));
  }

  exportJsonl(): string {
    const records = this.exportRecords();
    return records.length === 0 ? '' : `${records.map(canonical).join('\n')}\n`;
  }

  /**
   * Transition matching durable records to process-local private state. The
   * durable rewrite commits before memory is reclassified. Existing records
   * remain available for the live private UI until scrubPrivateRecords runs.
   */
  markSessionPrivate(selector: BillableInvocationSessionSelector): number {
    assertSelector(selector);
    const matchingIds = this.order.filter((id) => matchesSession(this.entriesById[id].record, selector));
    const durableIds = matchingIds.filter((id) => !this.entriesById[id].private);
    if (durableIds.length > 0) {
      const excluded: Record<string, true> = {};
      for (const id of durableIds) excluded[id] = true;
      this.rewriteDurable((entry) => !excluded[entry.record.invocationId]);
      for (const id of durableIds) {
        this.entriesById[id] = Object.freeze({ record: this.entriesById[id].record, private: true });
      }
    }
    this.privateSessionSelectors.push(Object.freeze({ ...selector }));
    return matchingIds.length;
  }

  /** Stop classifying future rows as private. Existing private rows remain
   * process-local until their normal scrub/close boundary. */
  markSessionOrdinary(selector: BillableInvocationSessionSelector): void {
    assertSelector(selector);
    for (let index = this.privateSessionSelectors.length - 1; index >= 0; index -= 1) {
      const current = this.privateSessionSelectors[index];
      const sameSession = !!selector.sessionId && selector.sessionId === current.sessionId;
      const samePath = !!selector.sessionPath && selector.sessionPath === current.sessionPath;
      if (sameSession || samePath) this.privateSessionSelectors.splice(index, 1);
    }
  }

  /** Remove process-local private usage when the private session is closed or scrubbed. */
  scrubPrivateRecords(selector?: BillableInvocationSessionSelector): number {
    if (selector) assertSelector(selector);
    return this.removeEntries((entry) => entry.private && (!selector || matchesSession(entry.record, selector)));
  }

  /** Forget removes both ordinary durable data and private process-local data. */
  forgetSession(selector: BillableInvocationSessionSelector): number {
    assertSelector(selector);
    const matchingIds = this.order.filter((id) => matchesSession(this.entriesById[id].record, selector));
    if (matchingIds.some((id) => !this.entriesById[id].private)) {
      this.rewriteDurable((entry) => !matchesSession(entry.record, selector));
    }
    const matching: Record<string, true> = {};
    for (const id of matchingIds) matching[id] = true;
    return this.removeEntries((_entry, id) => Boolean(matching[id]));
  }

  private records(options: BillableInvocationProjectionOptions): BillableInvocationRecord[] {
    const includePrivate = options.includePrivate !== false;
    return this.order
      .map((id) => this.entriesById[id])
      .filter((entry) => includePrivate || !entry.private)
      .map((entry) => entry.record);
  }

  private addEntry(record: BillableInvocationRecord, isPrivate: boolean): void {
    this.entriesById[record.invocationId] = Object.freeze({ record, private: isPrivate });
    this.order.push(record.invocationId);
  }

  private removeEntries(predicate: (entry: LedgerEntry, id: string) => boolean): number {
    let removed = 0;
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const id = this.order[index];
      if (!predicate(this.entriesById[id], id)) continue;
      delete this.entriesById[id];
      this.order.splice(index, 1);
      removed += 1;
    }
    return removed;
  }

  private replay(): void {
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = normalizeRecord(JSON.parse(line) as unknown);
        if (this.entriesById[record.invocationId]) continue;
        this.addEntry(record, false);
      } catch {
        // Each line is an independent commit. Malformed/torn lines do not
        // prevent replay of valid records before or after them.
      }
    }
  }

  private appendDurable(record: BillableInvocationRecord): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const fd = fs.openSync(this.filePath, 'a+');
    try {
      const size = fs.fstatSync(fd).size;
      let prefix = '';
      if (size > 0) {
        const tail = Buffer.allocUnsafe(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) prefix = '\n';
      }
      writeAll(fd, Buffer.from(`${prefix}${canonical(record)}\n`, 'utf8'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private rewriteDurable(include: (entry: LedgerEntry) => boolean): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    const records = this.order
      .map((id) => this.entriesById[id])
      .filter((entry) => !entry.private && include(entry))
      .map((entry) => canonical(entry.record));
    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, 'wx');
      if (records.length > 0) writeAll(fd, Buffer.from(`${records.join('\n')}\n`, 'utf8'));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, this.filePath);
      fsyncDirectory(path.dirname(this.filePath));
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tempPath); } catch { /* Best-effort cleanup of an unpublished rewrite. */ }
      throw error;
    }
  }
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Some Windows/filesystem combinations cannot fsync directories. The
    // fully-fsynced temp and atomic rename still provide the strongest local primitive.
  }
}

function assertSelector(selector: BillableInvocationSessionSelector): void {
  if (!selector.sessionId && !selector.sessionPath && !selector.branchId) {
    throw new Error('A sessionId, sessionPath, or branchId selector is required.');
  }
}

function matchesSession(record: BillableInvocationRecord, selector: BillableInvocationSessionSelector): boolean {
  return (selector.sessionId === undefined || record.sessionId === selector.sessionId)
    && (selector.sessionPath === undefined || record.sessionPath === selector.sessionPath)
    && (selector.branchId === undefined || record.branchId === selector.branchId);
}

function metric(records: readonly BillableInvocationRecord[], value: (record: BillableInvocationRecord) => number | undefined): BillableInvocationMetricProjection {
  let total = 0;
  let knownInvocations = 0;
  for (const record of records) {
    const amount = value(record);
    if (amount === undefined) continue;
    total += amount;
    knownInvocations += 1;
  }
  const unknownInvocations = records.length - knownInvocations;
  return Object.freeze({
    ...(knownInvocations > 0 ? { value: total } : {}),
    knownInvocations,
    unknownInvocations,
    complete: unknownInvocations === 0,
  });
}

function summarize(records: readonly BillableInvocationRecord[]): BillableInvocationSummary {
  const provenanceCounts: Record<BillableInvocationProvenance, number> = {
    exact: 0, estimated: 0, unpriced: 0, unknown: 0,
  };
  const outcomeCounts: Record<BillableInvocationOutcome, number> = {
    succeeded: 0, failed: 0, cancelled: 0, unknown: 0,
  };
  let instrumentationGapInvocations = 0;
  for (const record of records) {
    provenanceCounts[record.provenance] += 1;
    outcomeCounts[record.outcome] += 1;
    if (record.instrumentationGap) instrumentationGapInvocations += 1;
  }
  Object.freeze(provenanceCounts);
  Object.freeze(outcomeCounts);
  return Object.freeze({
    invocationCount: records.length,
    inputTokens: metric(records, (record) => record.inputTokens),
    outputTokens: metric(records, (record) => record.outputTokens),
    cacheReadTokens: metric(records, (record) => record.cacheReadTokens),
    cacheWriteTokens: metric(records, (record) => record.cacheWriteTokens),
    reasoningTokens: metric(records, (record) => record.reasoningTokens),
    providerTotalTokens: metric(records, (record) => record.providerTotalTokens),
    effectiveCostUsd: metric(records, (record) => record.providerReportedCostUsd ?? record.pricing?.calculatedCostUsd),
    providerReportedCostUsd: metric(records, (record) => record.providerReportedCostUsd),
    calculatedCostUsd: metric(records, (record) => record.pricing?.calculatedCostUsd),
    provenanceCounts,
    outcomeCounts,
    instrumentationGapInvocations,
  });
}

function makeProjection(records: BillableInvocationRecord[]): BillableInvocationProjection {
  return Object.freeze({ records: Object.freeze(records), summary: summarize(records) });
}

function canonical(record: BillableInvocationRecord): string {
  return JSON.stringify(record);
}

function normalizeRecord(value: unknown): BillableInvocationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invocation record must be an object.');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error('Unsupported invocation record schema.');
  const invocationId = requiredString(raw.invocationId, 'invocationId');
  const sourceId = requiredString(raw.sourceId, 'sourceId');
  const sessionId = nullableString(raw.sessionId, 'sessionId');
  const sessionPath = nullableString(raw.sessionPath, 'sessionPath');
  const branchId = nullableString(raw.branchId, 'branchId');
  if (sessionId === null && sessionPath === null) throw new Error('Invocation record requires sessionId or sessionPath.');
  const parentOperationId = nullableString(raw.parentOperationId, 'parentOperationId');
  const parentRunId = nullableString(raw.parentRunId, 'parentRunId');
  const parentToolId = nullableString(raw.parentToolId, 'parentToolId');
  if (!BILLABLE_INVOCATION_KINDS.includes(raw.kind as BillableInvocationKind)) throw new Error('Invalid invocation kind.');
  const provider = requiredString(raw.provider, 'provider');
  const model = requiredString(raw.model, 'model');
  const provenance = oneOf(raw.provenance, ['exact', 'estimated', 'unpriced', 'unknown'] as const, 'provenance');
  const evidenceOrigin = raw.evidenceOrigin === undefined
    ? undefined
    : oneOf(raw.evidenceOrigin, ['live', 'migration'] as const, 'evidenceOrigin');
  const outcome = oneOf(raw.outcome, ['succeeded', 'failed', 'cancelled', 'unknown'] as const, 'outcome');
  const startedAt = isoTimestamp(raw.startedAt, 'startedAt');
  const endedAt = isoTimestamp(raw.endedAt, 'endedAt');
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new Error('endedAt precedes startedAt.');
  if (typeof raw.instrumentationGap !== 'boolean') throw new Error('instrumentationGap must be boolean.');
  const instrumentationGapReason = raw.instrumentationGap
    ? requiredString(raw.instrumentationGapReason, 'instrumentationGapReason')
    : undefined;
  if (!raw.instrumentationGap && raw.instrumentationGapReason !== undefined) {
    throw new Error('instrumentationGapReason requires instrumentationGap.');
  }

  const pricing = normalizePricing(raw.pricing);
  const record = {
    schemaVersion: 1 as const,
    invocationId,
    sourceId,
    sessionId,
    sessionPath,
    branchId,
    parentOperationId,
    parentRunId,
    parentToolId,
    kind: raw.kind as BillableInvocationKind,
    provider,
    model,
    ...optionalNumber(raw, 'inputTokens', true),
    ...optionalNumber(raw, 'outputTokens', true),
    ...optionalNumber(raw, 'cacheReadTokens', true),
    ...optionalNumber(raw, 'cacheWriteTokens', true),
    ...optionalNumber(raw, 'reasoningTokens', true),
    ...optionalNumber(raw, 'providerTotalTokens', true),
    ...optionalNumber(raw, 'providerReportedCostUsd', false),
    ...(pricing ? { pricing } : {}),
    provenance,
    ...(evidenceOrigin ? { evidenceOrigin } : {}),
    startedAt,
    endedAt,
    outcome,
    instrumentationGap: raw.instrumentationGap,
    ...(instrumentationGapReason ? { instrumentationGapReason } : {}),
  };
  return freezeRecord(record as BillableInvocationRecord);
}

function normalizePricing(value: unknown): BillableInvocationRecord['pricing'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pricing must be an object.');
  const raw = value as Record<string, unknown>;
  const rateSnapshot = raw.rateSnapshot === undefined ? undefined : normalizeRates(raw.rateSnapshot);
  return Object.freeze({
    catalogVersion: requiredString(raw.catalogVersion, 'pricing.catalogVersion'),
    calculatedCostUsd: nonNegativeNumber(raw.calculatedCostUsd, 'pricing.calculatedCostUsd', false),
    ...(rateSnapshot ? { rateSnapshot } : {}),
  });
}

function normalizeRates(value: unknown): NonNullable<BillableInvocationRecord['pricing']>['rateSnapshot'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rateSnapshot must be an object.');
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    ...optionalNumber(raw, 'inputTokensUsdPerMillion', false),
    ...optionalNumber(raw, 'outputTokensUsdPerMillion', false),
    ...optionalNumber(raw, 'cacheReadTokensUsdPerMillion', false),
    ...optionalNumber(raw, 'cacheWriteTokensUsdPerMillion', false),
    ...optionalNumber(raw, 'reasoningTokensUsdPerMillion', false),
  });
}

function optionalNumber(raw: Record<string, unknown>, key: string, integer: boolean): Record<string, number> {
  if (raw[key] === undefined) return {};
  return { [key]: nonNegativeNumber(raw[key], key, integer) };
}

function nonNegativeNumber(value: unknown, name: string, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be a non-negative ${integer ? 'integer' : 'number'}.`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredString(value, name);
}

function isoTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${name} must be an ISO timestamp.`);
  return timestamp;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`Invalid ${name}.`);
  return value as T[number];
}

function freezeRecord(record: BillableInvocationRecord): BillableInvocationRecord {
  if (record.pricing?.rateSnapshot) Object.freeze(record.pricing.rateSnapshot);
  if (record.pricing) Object.freeze(record.pricing);
  return Object.freeze(record);
}
