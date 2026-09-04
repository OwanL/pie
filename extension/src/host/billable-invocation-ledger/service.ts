import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { withFileUpdateLockSync } from '../../shared/settings-json-update';
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

export const ACCOUNTING_LOCK_BASENAME = '.accounting';
export const ACCOUNTING_PRIVACY_BASENAME = 'accounting-private-sessions.json';

export function accountingLockTarget(storageDir: string): string {
  return path.join(storageDir, ACCOUNTING_LOCK_BASENAME);
}

/** Read the durable privacy fence while the caller owns the accounting lock. */
export function readAccountingPrivacySelectors(storageDir: string): BillableInvocationSessionSelector[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(storageDir, ACCOUNTING_PRIVACY_BASENAME), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): BillableInvocationSessionSelector[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const raw = value as Record<string, unknown>;
      const selector = {
        ...(typeof raw.sessionId === 'string' && raw.sessionId ? { sessionId: raw.sessionId } : {}),
        ...(typeof raw.sessionPath === 'string' && raw.sessionPath ? { sessionPath: raw.sessionPath } : {}),
        ...(typeof raw.branchId === 'string' && raw.branchId ? { branchId: raw.branchId } : {}),
      };
      return selector.sessionId || selector.sessionPath || selector.branchId ? [selector] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Host-owned finalized invocation ledger. All durable reads, appends, privacy
 * fences, rewrites, and exports share one workspace lock. Each transaction
 * reloads canonical disk state, so stale host processes cannot overwrite a
 * sibling append or export an already-forgotten/private row.
 */
export class BillableInvocationLedger {
  private readonly entriesById: Record<string, LedgerEntry> = {};
  private readonly order: string[] = [];
  private readonly privateSessionSelectors: BillableInvocationSessionSelector[] = [];
  private readonly storageDir: string;
  private readonly lockTarget: string;
  private readonly privacyPath: string;

  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error('Billable invocation ledger file path is required.');
    this.storageDir = path.dirname(filePath);
    this.lockTarget = accountingLockTarget(this.storageDir);
    this.privacyPath = path.join(this.storageDir, ACCOUNTING_PRIVACY_BASENAME);
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.withLock(() => this.reloadDurable());
  }

  /** Coordinate a ledger row and its correlated activity interval as one
   * workspace transaction. Nested ledger/timeline mutations are reentrant. */
  transaction<T>(action: () => T): T {
    return this.withLock(action);
  }

  hasInvocation(invocationId: string): boolean {
    return this.withLock(() => {
      this.reloadDurable();
      return Object.prototype.hasOwnProperty.call(this.entriesById, invocationId);
    });
  }

  append(
    record: BillableInvocationRecord,
    options: BillableInvocationAppendOptions,
  ): BillableInvocationAppendResult {
    return this.withLock(() => {
      this.reloadDurable();
      const normalized = normalizeRecord(record);
      const existing = this.entriesById[normalized.invocationId];
      if (existing) {
        if (canonical(existing.record) !== canonical(normalized)) {
          throw new Error(`Billable invocation ${normalized.invocationId} was finalized with conflicting data.`);
        }
        return 'duplicate';
      }

      const durablePrivacy = readAccountingPrivacySelectors(this.storageDir);
      const isPrivate = options.visibility === 'private'
        || [...this.privateSessionSelectors, ...durablePrivacy]
          .some((selector) => matchesSession(normalized, selector));
      if (!isPrivate) this.appendDurable(normalized);
      this.addEntry(normalized, isPrivate);
      return 'appended';
    });
  }

  projectSession(
    selector: BillableInvocationSessionSelector,
    options: BillableInvocationProjectionOptions = {},
  ): BillableInvocationProjection {
    assertSelector(selector);
    return this.withLock(() => {
      this.reloadDurable();
      return makeProjection(this.records(options).filter((record) => matchesSession(record, selector)));
    });
  }

  projectAll(options: BillableInvocationProjectionOptions = {}): BillableInvocationProjection {
    return this.withLock(() => {
      this.reloadDurable();
      return makeProjection(this.records(options));
    });
  }

  projectAggregate(
    options: BillableInvocationProjectionOptions = {},
  ): BillableInvocationAggregateProjection {
    const records = this.withLock(() => {
      this.reloadDurable();
      return this.records(options);
    });
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
    return this.withLock(() => {
      this.reloadDurable();
      return Object.freeze(this.records({ includePrivate: false }));
    });
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
    return this.withLock(() => {
      this.reloadDurable();
      const selectors = readAccountingPrivacySelectors(this.storageDir);
      if (!selectors.some((current) => selectorsOverlap(current, selector))) {
        selectors.push(Object.freeze({ ...selector }));
        this.writePrivacySelectors(selectors);
      }
      if (!this.privateSessionSelectors.some((current) => selectorsOverlap(current, selector))) {
        this.privateSessionSelectors.push(Object.freeze({ ...selector }));
      }
      const matchingIds = this.order.filter((id) => matchesSession(this.entriesById[id].record, selector));
      const durableIds = matchingIds.filter((id) => !this.entriesById[id].private);
      if (durableIds.length > 0) {
        this.rewriteDurable((entry) => !matchesSession(entry.record, selector));
        for (const id of durableIds) {
          this.entriesById[id] = Object.freeze({ record: this.entriesById[id].record, private: true });
        }
      }
      return matchingIds.length;
    });
  }

  /** Stop classifying future rows as private. Existing private rows remain
   * process-local until their normal scrub/close boundary. */
  markSessionOrdinary(selector: BillableInvocationSessionSelector): void {
    assertSelector(selector);
    this.withLock(() => {
      const keep = readAccountingPrivacySelectors(this.storageDir)
        .filter((current) => !selectorsOverlap(current, selector));
      this.writePrivacySelectors(keep);
      for (let index = this.privateSessionSelectors.length - 1; index >= 0; index -= 1) {
        if (selectorsOverlap(this.privateSessionSelectors[index], selector)) this.privateSessionSelectors.splice(index, 1);
      }
      this.reloadDurable();
    });
  }

  /** Remove process-local private usage when the private session is closed or scrubbed. */
  scrubPrivateRecords(selector?: BillableInvocationSessionSelector): number {
    if (selector) assertSelector(selector);
    return this.removeEntries((entry) => entry.private && (!selector || matchesSession(entry.record, selector)));
  }

  /** Forget removes both ordinary durable data and private process-local data. */
  forgetSession(selector: BillableInvocationSessionSelector): number {
    assertSelector(selector);
    return this.withLock(() => {
      this.reloadDurable();
      const selectors = readAccountingPrivacySelectors(this.storageDir);
      if (!selectors.some((current) => selectorsOverlap(current, selector))) {
        selectors.push(Object.freeze({ ...selector }));
        this.writePrivacySelectors(selectors);
      }
      const matchingIds = this.order.filter((id) => matchesSession(this.entriesById[id].record, selector));
      if (matchingIds.some((id) => !this.entriesById[id].private)) {
        this.rewriteDurable((entry) => !matchesSession(entry.record, selector));
      }
      const matching: Record<string, true> = {};
      for (const id of matchingIds) matching[id] = true;
      return this.removeEntries((_entry, id) => Boolean(matching[id]));
    });
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

  private withLock<T>(action: () => T): T {
    return withFileUpdateLockSync(this.lockTarget, action);
  }

  /** Replace only durable entries from canonical disk state. Process-local
   * private rows remain available to the live private tab. */
  private reloadDurable(): void {
    this.removeEntries((entry) => !entry.private);
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
        const existing = this.entriesById[record.invocationId];
        if (existing) {
          if (canonical(existing.record) !== canonical(record)) continue;
          continue;
        }
        this.addEntry(record, false);
      } catch {
        // Each line is an independent commit. Malformed/torn lines do not
        // prevent replay of valid records before or after them.
      }
    }
  }

  private writePrivacySelectors(selectors: readonly BillableInvocationSessionSelector[]): void {
    if (selectors.length === 0) {
      try { fs.unlinkSync(this.privacyPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return;
    }
    fs.mkdirSync(this.storageDir, { recursive: true });
    const tempPath = `${this.privacyPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(selectors, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      const fd = fs.openSync(tempPath, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tempPath, this.privacyPath);
      fsyncDirectory(this.storageDir);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
      throw error;
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
    if (records.length === 0) {
      try { fs.unlinkSync(this.filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      fsyncDirectory(path.dirname(this.filePath));
      return;
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, 'wx');
      writeAll(fd, Buffer.from(`${records.join('\n')}\n`, 'utf8'));
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

function selectorsOverlap(left: BillableInvocationSessionSelector, right: BillableInvocationSessionSelector): boolean {
  return (!!left.sessionId && left.sessionId === right.sessionId)
    || (!!left.sessionPath && left.sessionPath === right.sessionPath)
    || (!!left.branchId && left.branchId === right.branchId);
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
