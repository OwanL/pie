import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { atomicWriteText } from '../shared/atomic-write.js';
import type {
  AnalyticsLifecycleDeletionAdapter,
  SessionLifecycleCleaner,
} from './session-filesystem-lifecycle.js';
import type { SessionLifecycleRecord, SessionLifecycleStore } from './session-lifecycle-store.js';

/** Authorization value that must be present for a cutoff to run.
 *
 * The cutoff closes every Pie-managed session and starts their expiry deadlines,
 * which is irreversible for those sessions, so it is gated on an explicit
 * authorization rather than on a boolean someone could pass by accident. */
export const STORAGE_CUTOFF_AUTHORIZATION_ENV = 'PIE_STORAGE_CUTOFF_AUTHORIZATION' as const;
export const STORAGE_CUTOFF_AUTHORIZATION_VALUE = 'p7b-authorized-v1' as const;

const MAX_OPERATION_ID_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_DURABLE_RECORD_BYTES = 8 * 1024 * 1024;
const STORAGE_CUTOFF_LOCK_FILENAME = '.storage-cutoff-operation-v1.lock';
const STORAGE_CUTOFF_LOCK_TIMEOUT_MS = 5_000;
const STORAGE_CUTOFF_LOCK_RETRY_MS = 25;

interface StorageCutoffOperationLockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly token: string;
  readonly operationId: string;
  readonly acquiredAtMs: number;
}

interface StorageCutoffOperationLock {
  release(): void;
}

export type StorageCutoffOutcome =
  | { readonly status: 'closed' }
  | { readonly status: 'deleted' }
  | { readonly status: 'already-closed' }
  | { readonly status: 'failed'; readonly error: string };

type CutoffJournalStatus = 'in-progress' | 'partial' | 'complete';

/** The write-ahead record is owned by the lifecycle state directory. It is
 * deliberately one operation journal, rather than a second session registry. */
export interface StorageCutoffJournal {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly authorization: typeof STORAGE_CUTOFF_AUTHORIZATION_VALUE;
  readonly inventory: readonly string[];
  readonly inventorySha256: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: CutoffJournalStatus;
  readonly outcomes: Readonly<Record<string, StorageCutoffOutcome>>;
  readonly receiptSha256?: string;
}

/** Durable record of one storage cutoff, so the outcome is inspectable and the
 * operation is idempotent rather than repeatable. */
export interface StorageCutoffReceipt {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly inventorySha256: string;
  readonly completedAt: string;
  readonly closedSessionIds: readonly string[];
  readonly alreadyClosedSessionIds: readonly string[];
  /** Sessions whose private close deleted their data immediately. */
  readonly deletedSessionIds: readonly string[];
  readonly failures: ReadonlyArray<{ sessionId: string; error: string }>;
}

export interface StorageCutoffOptions {
  store: SessionLifecycleStore;
  cleaner: SessionLifecycleCleaner;
  /** Resolved state directory that owns the journal and receipt. */
  stateDir: string;
  /** Sessions to close. Discovered by the caller from explicitly configured
   * source roots; this module never searches for sessions itself, because
   * guessing ownership is exactly the ambiguity the plan forbids. */
  inventory: readonly string[];
  /** A caller must explicitly prove that inventory discovery was validated.
   * An empty validated inventory is a real, successful no-session inventory. */
  inventoryValidated: boolean;
  operationId: string;
  /** The canonical analytics deletion adapter. Without it, private sessions
   * are rejected before any session is closed. */
  analytics?: AnalyticsLifecycleDeletionAdapter;
  now?: () => number;
  /** Test/recovery seam: called after each durable per-session outcome. */
  afterSession?: (sessionId: string, outcome: StorageCutoffOutcome) => void | Promise<void>;
}

export interface StorageCutoffInspectionOptions {
  stateDir: string;
  inventory: readonly string[];
  inventoryValidated: boolean;
  operationId: string;
}

export interface StorageCutoffInspection {
  readonly journal: StorageCutoffJournal;
  readonly receipt: StorageCutoffReceipt;
}

export const STORAGE_CUTOFF_RECEIPT_FILENAME = 'storage-cutoff-receipt-v1.json';
export const STORAGE_CUTOFF_JOURNAL_FILENAME = 'storage-cutoff-operation-v1.json';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function storageCutoffProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

function readOperationLockOwner(lockPath: string): StorageCutoffOperationLockOwner | undefined {
  if (!existsSync(lockPath)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Storage cutoff operation lock is corrupt; refusing stale-owner recovery: ${errorMessage(error)}`);
  }
  const pid = isRecord(value) && typeof value.pid === 'number' ? value.pid : Number.NaN;
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || typeof value.token !== 'string'
    || value.token.length === 0
    || typeof value.operationId !== 'string'
    || !Number.isSafeInteger(value.acquiredAtMs)) {
    throw new Error('Storage cutoff operation lock owner is malformed; refusing stale-owner recovery.');
  }
  const owner = value as {
    readonly pid: number;
    readonly token: string;
    readonly operationId: string;
    readonly acquiredAtMs: number;
  };
  return {
    schemaVersion: 1,
    pid: owner.pid,
    token: owner.token,
    operationId: owner.operationId,
    acquiredAtMs: owner.acquiredAtMs,
  };
}

function tryPublishOperationLock(
  lockPath: string,
  owner: StorageCutoffOperationLockOwner,
): boolean {
  const candidatePath = `${lockPath}.candidate-${owner.token}`;
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
    writeFileSync(path.join(candidatePath, 'owner.json'), `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(candidatePath, lockPath);
    return true;
  } catch (error) {
    rmSync(candidatePath, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') return false;
    throw error;
  }
}

async function acquireStorageCutoffOperationLock(
  stateDir: string,
  operationId: string,
): Promise<StorageCutoffOperationLock> {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, STORAGE_CUTOFF_LOCK_FILENAME);
  const owner: StorageCutoffOperationLockOwner = {
    schemaVersion: 1,
    pid: process.pid,
    token: randomUUID(),
    operationId,
    acquiredAtMs: Date.now(),
  };
  const deadline = Date.now() + STORAGE_CUTOFF_LOCK_TIMEOUT_MS;
  for (;;) {
    if (tryPublishOperationLock(lockPath, owner)) {
      return {
        release: () => {
          const current = readOperationLockOwner(lockPath);
          if (!current) return;
          if (current.token !== owner.token || current.pid !== owner.pid) {
            throw new Error('Storage cutoff operation lock ownership changed before release.');
          }
          rmSync(lockPath, { recursive: true, force: false });
        },
      };
    }
    const current = readOperationLockOwner(lockPath);
    if (current && !storageCutoffProcessIsAlive(current.pid)) {
      rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out acquiring the storage cutoff operation lock.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, STORAGE_CUTOFF_LOCK_RETRY_MS));
  }
}

function readDurableJson(filePath: string): unknown | undefined {
  if (!existsSync(filePath)) return undefined;
  const size = statSync(filePath).size;
  if (size > MAX_DURABLE_RECORD_BYTES) {
    throw new Error(`Storage cutoff record is larger than the bounded ${MAX_DURABLE_RECORD_BYTES}-byte limit.`);
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Storage cutoff record ${filePath} is not valid JSON: ${errorMessage(error)}`);
  }
}

function assertSessionId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SESSION_ID_LENGTH || value.includes('\u0000')) {
    throw new Error(`${label} must be a bounded, non-empty session id without NUL bytes.`);
  }
}

function canonicalInventory(inventory: readonly string[]): string[] {
  if (!Array.isArray(inventory)) throw new Error('Storage cutoff inventory must be an array.');
  const result = [...inventory];
  result.forEach((sessionId, index) => assertSessionId(sessionId, `Storage cutoff inventory[${index}]`));
  const unique = new Set(result);
  if (unique.size !== result.length) throw new Error('Storage cutoff inventory contains duplicate session ids.');
  result.sort();
  return result;
}

function inventoryDigest(inventory: readonly string[]): string {
  return sha256(`${JSON.stringify(inventory)}\n`);
}

function validateOutcome(value: unknown): StorageCutoffOutcome {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('Storage cutoff journal contains an invalid session outcome.');
  }
  if (value.status === 'closed' || value.status === 'deleted' || value.status === 'already-closed') {
    return { status: value.status };
  }
  if (value.status === 'failed' && typeof value.error === 'string' && value.error.length <= MAX_DURABLE_RECORD_BYTES) {
    return { status: 'failed', error: value.error };
  }
  throw new Error('Storage cutoff journal contains an invalid failed outcome.');
}

function validateJournal(value: unknown): StorageCutoffJournal {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.operationId !== 'string'
    || value.authorization !== STORAGE_CUTOFF_AUTHORIZATION_VALUE
    || !Array.isArray(value.inventory)
    || typeof value.inventorySha256 !== 'string'
    || typeof value.startedAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || (value.status !== 'in-progress' && value.status !== 'partial' && value.status !== 'complete')
    || !isRecord(value.outcomes)) {
    throw new Error('Storage cutoff journal is malformed; refusing recovery.');
  }
  const inventory = canonicalInventory(value.inventory);
  if (inventoryDigest(inventory) !== value.inventorySha256) {
    throw new Error('Storage cutoff journal inventory digest is invalid; refusing recovery.');
  }
  const outcomes: Record<string, StorageCutoffOutcome> = {};
  for (const [sessionId, outcome] of Object.entries(value.outcomes)) {
    assertSessionId(sessionId, 'Storage cutoff journal outcome key');
    if (!inventory.includes(sessionId)) throw new Error('Storage cutoff journal contains an out-of-inventory outcome.');
    outcomes[sessionId] = validateOutcome(outcome);
  }
  if (value.receiptSha256 !== undefined && typeof value.receiptSha256 !== 'string') {
    throw new Error('Storage cutoff journal receipt digest is malformed.');
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    authorization: STORAGE_CUTOFF_AUTHORIZATION_VALUE,
    inventory,
    inventorySha256: value.inventorySha256,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    status: value.status,
    outcomes,
    ...(value.receiptSha256 === undefined ? {} : { receiptSha256: value.receiptSha256 }),
  };
}

function validateReceipt(value: unknown): StorageCutoffReceipt {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.operationId !== 'string'
    || typeof value.inventorySha256 !== 'string'
    || typeof value.completedAt !== 'string'
    || !Array.isArray(value.closedSessionIds)
    || !Array.isArray(value.alreadyClosedSessionIds)
    || !Array.isArray(value.deletedSessionIds)
    || !Array.isArray(value.failures)) {
    throw new Error('Storage cutoff receipt is malformed; refusing recovery.');
  }
  const validateIds = (values: unknown[], label: string): string[] => values.map((id, index) => {
    assertSessionId(id, `${label}[${index}]`);
    return id;
  });
  const failures = value.failures.map((failure, index) => {
    if (!isRecord(failure)) throw new Error(`Storage cutoff receipt failure ${index} is malformed.`);
    assertSessionId(failure.sessionId, `Storage cutoff receipt failure ${index} sessionId`);
    if (typeof failure.error !== 'string') throw new Error(`Storage cutoff receipt failure ${index} error is malformed.`);
    return { sessionId: failure.sessionId, error: failure.error };
  });
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    inventorySha256: value.inventorySha256,
    completedAt: value.completedAt,
    closedSessionIds: validateIds(value.closedSessionIds, 'Storage cutoff receipt closedSessionIds'),
    alreadyClosedSessionIds: validateIds(value.alreadyClosedSessionIds, 'Storage cutoff receipt alreadyClosedSessionIds'),
    deletedSessionIds: validateIds(value.deletedSessionIds, 'Storage cutoff receipt deletedSessionIds'),
    failures,
  };
}

function buildReceipt(journal: StorageCutoffJournal, completedAt: string): StorageCutoffReceipt {
  const closedSessionIds: string[] = [];
  const alreadyClosedSessionIds: string[] = [];
  const deletedSessionIds: string[] = [];
  const failures: Array<{ sessionId: string; error: string }> = [];
  for (const sessionId of journal.inventory) {
    const outcome = journal.outcomes[sessionId];
    if (!outcome) throw new Error(`Storage cutoff journal has no outcome for ${sessionId}.`);
    if (outcome.status === 'closed') closedSessionIds.push(sessionId);
    else if (outcome.status === 'deleted') {
      closedSessionIds.push(sessionId);
      deletedSessionIds.push(sessionId);
    } else if (outcome.status === 'already-closed') alreadyClosedSessionIds.push(sessionId);
    else failures.push({ sessionId, error: outcome.error });
  }
  return {
    schemaVersion: 1,
    operationId: journal.operationId,
    inventorySha256: journal.inventorySha256,
    completedAt,
    closedSessionIds,
    alreadyClosedSessionIds,
    deletedSessionIds,
    failures,
  };
}

async function writeJournal(stateDir: string, journal: StorageCutoffJournal): Promise<void> {
  await atomicWriteText(path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME), serialized(journal));
}

function assertJournalBinding(
  journal: StorageCutoffJournal,
  operationId: string,
  inventory: readonly string[],
): void {
  if (journal.operationId !== operationId) {
    throw new Error(`Storage cutoff operation id ${operationId} does not match the frozen journal operation ${journal.operationId}.`);
  }
  if (journal.inventorySha256 !== inventoryDigest(inventory)
    || JSON.stringify(journal.inventory) !== JSON.stringify(inventory)) {
    throw new Error('Storage cutoff inventory does not match the frozen write-ahead journal.');
  }
}

function readExistingReceipt(
  receiptPath: string,
  operationId: string,
  inventorySha256: string,
): StorageCutoffReceipt | undefined {
  const raw = readDurableJson(receiptPath);
  if (raw === undefined) return undefined;
  const receipt = validateReceipt(raw);
  if (receipt.operationId !== operationId || receipt.inventorySha256 !== inventorySha256) {
    throw new Error('Storage cutoff receipt does not match the requested operation and inventory.');
  }
  if (serialized(receipt) !== readFileSync(receiptPath, 'utf8')) {
    throw new Error('Storage cutoff receipt bytes are not canonical; refusing idempotent recovery.');
  }
  return receipt;
}

function isSuccessfulOutcome(outcome: StorageCutoffOutcome | undefined): boolean {
  return outcome?.status === 'closed' || outcome?.status === 'deleted' || outcome?.status === 'already-closed';
}

/** Validate the durable cutoff result without opening the lifecycle store or
 * performing any mutation. The helper uses this before allowing restart so a
 * phase record alone can never make a forged cutoff appear complete. */
export function inspectStorageCutoff(options: StorageCutoffInspectionOptions): StorageCutoffInspection {
  if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
    throw new Error(`Storage cutoff requires ${STORAGE_CUTOFF_AUTHORIZATION_ENV}=${STORAGE_CUTOFF_AUTHORIZATION_VALUE}.`);
  }
  if (options.inventoryValidated !== true) throw new Error('Storage cutoff inventory is missing explicit validation evidence.');
  const inventory = canonicalInventory(options.inventory);
  const inventorySha256 = inventoryDigest(inventory);
  const journalValue = readDurableJson(path.join(options.stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME));
  if (journalValue === undefined) throw new Error('Storage cutoff write-ahead journal is missing.');
  const journal = validateJournal(journalValue);
  assertJournalBinding(journal, options.operationId, inventory);
  if (journal.status !== 'complete') {
    throw new Error('Storage cutoff journal is not complete; refusing completion inspection.');
  }
  const receipt = readExistingReceipt(
    path.join(options.stateDir, STORAGE_CUTOFF_RECEIPT_FILENAME),
    options.operationId,
    inventorySha256,
  );
  if (!receipt) throw new Error('Storage cutoff receipt is missing.');
  const expected = buildReceipt(journal, receipt.completedAt);
  if (serialized(expected) !== serialized(receipt)) {
    throw new Error('Storage cutoff receipt outcomes do not match the durable journal.');
  }
  if (receipt.failures.length !== 0) {
    throw new Error('Storage cutoff receipt contains failures; refusing completion inspection.');
  }
  if (journal.receiptSha256 !== storageCutoffReceiptSha256(receipt)) {
    throw new Error('Storage cutoff journal receipt digest does not match the receipt.');
  }
  return { journal, receipt };
}

/** Close every inventoried session through its normal close barrier.
 *
 * The operation has three durable boundaries: an authorization and frozen
 * inventory journal before mutation, one outcome persisted after each session,
 * and a receipt whose zero-failure status is only complete after all outcomes
 * are present. A partial receipt is resumable; a complete receipt is returned
 * byte-for-byte on an exact retry.
 */
function validateStorageCutoffOptions(options: StorageCutoffOptions): string[] {
  if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
    throw new Error(`Storage cutoff requires ${STORAGE_CUTOFF_AUTHORIZATION_ENV}=${STORAGE_CUTOFF_AUTHORIZATION_VALUE}.`);
  }
  if (typeof options.operationId !== 'string'
    || options.operationId.length === 0
    || options.operationId.length > MAX_OPERATION_ID_LENGTH
    || options.operationId.includes('\u0000')) {
    throw new Error('Storage cutoff operationId must be a bounded, non-empty value without NUL bytes.');
  }
  if (options.inventoryValidated !== true) {
    throw new Error('Storage cutoff inventory is missing explicit validation evidence.');
  }
  return canonicalInventory(options.inventory);
}

async function performStorageCutoffUnlocked(
  options: StorageCutoffOptions,
  inventory: readonly string[],
): Promise<StorageCutoffReceipt> {
  if (options.analytics !== undefined && options.cleaner.analyticsDeletionAdapter !== options.analytics) {
    throw new Error('Storage cutoff analytics deletion adapter is not bound to the cleaner; refusing cutoff.');
  }
  const inventorySha256 = inventoryDigest(inventory);
  const journalPath = path.join(options.stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME);
  const receiptPath = path.join(options.stateDir, STORAGE_CUTOFF_RECEIPT_FILENAME);
  const existingJournalValue = readDurableJson(journalPath);
  const existingReceipt = readExistingReceipt(receiptPath, options.operationId, inventorySha256);
  if (existingJournalValue === undefined && existingReceipt !== undefined) {
    throw new Error('Storage cutoff receipt exists without its write-ahead journal; refusing to overwrite authority.');
  }

  let journal: StorageCutoffJournal;
  if (existingJournalValue !== undefined) {
    journal = validateJournal(existingJournalValue);
    assertJournalBinding(journal, options.operationId, inventory);
    if (journal.status === 'complete') {
      if (!existingReceipt) throw new Error('Completed storage cutoff journal has no matching receipt.');
      const expected = buildReceipt(journal, existingReceipt.completedAt);
      if (serialized(expected) !== serialized(existingReceipt) || existingReceipt.failures.length !== 0) {
        throw new Error('Completed storage cutoff journal outcomes do not match a zero-failure receipt.');
      }
      const expectedReceiptSha256 = storageCutoffReceiptSha256(existingReceipt);
      if (journal.receiptSha256 !== expectedReceiptSha256) {
        throw new Error('Completed storage cutoff journal receipt digest does not match the receipt bytes.');
      }
      return existingReceipt;
    }
    if (existingReceipt) {
      if (journal.receiptSha256 !== undefined) {
        if (journal.receiptSha256 !== storageCutoffReceiptSha256(existingReceipt)) {
          throw new Error('Partial storage cutoff journal and receipt are not bound to the same bytes.');
        }
      } else {
        // A crash can happen after the receipt replace but before the journal's
        // final status write. Reconstructing from the frozen outcomes proves
        // that receipt is the one produced by this journal; a same-id file with
        // invented counts is rejected before another close.
        const expected = buildReceipt(journal, existingReceipt.completedAt);
        if (serialized(expected) !== serialized(existingReceipt)) {
          throw new Error('Partial storage cutoff journal and receipt outcomes do not match.');
        }
      }
    }
  } else {
    const startedAt = new Date((options.now ?? Date.now)()).toISOString();
    journal = {
      schemaVersion: 1,
      operationId: options.operationId,
      authorization: STORAGE_CUTOFF_AUTHORIZATION_VALUE,
      inventory,
      inventorySha256,
      startedAt,
      updatedAt: startedAt,
      status: 'in-progress',
      outcomes: {},
    };
    // This is the write-ahead boundary. No cleaner call occurs before it.
    await writeJournal(options.stateDir, journal);
  }

  // Private cleanup is a coupled analytics deletion. Preflight all unprocessed
  // private sessions before the first close so an absent canonical adapter can
  // never leave ordinary sessions cut off while private data remains.
  if (!options.cleaner.hasAnalyticsDeletionAdapter) {
    for (const sessionId of inventory) {
      if (isSuccessfulOutcome(journal.outcomes[sessionId])) continue;
      const record = options.store.get(sessionId);
      if (record?.privacyMode === 'on') {
        throw new Error(`Private analytics deletion adapter is unavailable for ${sessionId}; refusing partial cutoff.`);
      }
    }
  }

  const now = options.now ?? Date.now;
  for (const sessionId of inventory) {
    const prior = journal.outcomes[sessionId];
    if (isSuccessfulOutcome(prior)) continue;

    let outcome: StorageCutoffOutcome;
    try {
      const existing: SessionLifecycleRecord | undefined = options.store.get(sessionId);
      if (!existing) {
        outcome = { status: 'failed', error: 'Inventory named a session the lifecycle store does not know.' };
      } else if (existing.closedAtMs !== null && existing.closedAtMs !== undefined) {
        const closeOperationId = `${options.operationId}:${sessionId}`;
        if (existing.closeOperationId === closeOperationId) {
          // A process can die after the lifecycle transaction commits but
          // before the journal outcome is replaced. Reconcile that exact close
          // identity instead of relabelling it as an unrelated prior close.
          if (existing.disposition === 'delete' && existing.cleanupState !== 'deleted') {
            const resolution = await options.cleaner.closeSession(sessionId, closeOperationId, 'user_close');
            outcome = resolution.disposition === 'delete' ? { status: 'deleted' } : { status: 'closed' };
          } else {
            outcome = existing.disposition === 'delete' ? { status: 'deleted' } : { status: 'closed' };
          }
        } else if (existing.disposition === 'delete' && existing.cleanupState !== 'deleted') {
          // A private close may have committed before its coupled analytics or
          // filesystem cleanup failed. Resume that durable cleanup identity;
          // a new cutoff operation must not relabel it as already complete or
          // replace the original closure/deadline owner.
          if (!existing.closeOperationId) {
            throw new Error(`Private cleanup identity is missing for ${sessionId}; refusing cutoff recovery.`);
          }
          const resolution = await options.cleaner.closeSession(
            sessionId,
            existing.closeOperationId,
            'user_close',
          );
          outcome = resolution.disposition === 'delete' ? { status: 'deleted' } : { status: 'closed' };
        } else {
          outcome = { status: 'already-closed' };
        }
      } else {
        // `user_close` deliberately: the lifecycle store owns deadlines and the
        // cleaner owns private analytics deletion and filesystem cleanup.
        const closeOperationId = `${options.operationId}:${sessionId}`;
        const resolution = await options.cleaner.closeSession(sessionId, closeOperationId, 'user_close');
        outcome = resolution.disposition === 'delete' ? { status: 'deleted' } : { status: 'closed' };
      }
    } catch (error) {
      outcome = { status: 'failed', error: errorMessage(error) };
    }

    const nextOutcomes: Record<string, StorageCutoffOutcome> = { ...journal.outcomes, [sessionId]: outcome };
    journal = {
      ...journal,
      outcomes: nextOutcomes,
      updatedAt: new Date(now()).toISOString(),
      status: 'in-progress',
      receiptSha256: undefined,
    };
    await writeJournal(options.stateDir, journal);
    await options.afterSession?.(sessionId, outcome);
  }

  const candidateCompletedAt = new Date(now()).toISOString();
  const candidateReceipt = buildReceipt(journal, candidateCompletedAt);
  // If the process died after atomically publishing a successful receipt but
  // before publishing the final journal status, replay those exact terminal
  // bytes. Replacing them with a new timestamp would break crash idempotence
  // and any manifest that already recorded the receipt digest.
  if (existingReceipt
    && existingReceipt.failures.length === 0
    && journal.receiptSha256 === undefined
    && candidateReceipt.failures.length === 0) {
    journal = {
      ...journal,
      status: 'complete',
      updatedAt: existingReceipt.completedAt,
      receiptSha256: storageCutoffReceiptSha256(existingReceipt),
    };
    await writeJournal(options.stateDir, journal);
    return existingReceipt;
  }
  // A partial receipt is also a durable retry record. Keep its timestamp stable
  // when the same failed outcomes remain, while a repaired operation receives a
  // fresh completion timestamp and transitions to the zero-failure state.
  const completedAt = candidateReceipt.failures.length > 0 && existingReceipt
    ? existingReceipt.completedAt
    : candidateCompletedAt;
  const receipt = completedAt === candidateCompletedAt
    ? candidateReceipt
    : buildReceipt(journal, completedAt);
  await atomicWriteText(receiptPath, serialized(receipt));
  journal = {
    ...journal,
    status: receipt.failures.length === 0 ? 'complete' : 'partial',
    updatedAt: completedAt,
    receiptSha256: storageCutoffReceiptSha256(receipt),
  };
  await writeJournal(options.stateDir, journal);
  return receipt;
}

/** Serialize all callers for one durable cutoff state directory. The lock is
 * transient and carries only PID/token ownership evidence; a dead owner may
 * be reclaimed, while malformed ownership evidence fails closed. */
export async function performStorageCutoff(options: StorageCutoffOptions): Promise<StorageCutoffReceipt> {
  const inventory = validateStorageCutoffOptions(options);
  const operationLock = await acquireStorageCutoffOperationLock(options.stateDir, options.operationId);
  try {
    return await performStorageCutoffUnlocked(options, inventory);
  } finally {
    operationLock.release();
  }
}

/** sha256 of a receipt's exact serialized bytes.
 *
 * The activation manifest records `cutoffReceiptSha256`, which is what ties an
 * active generation to the cutoff it was activated against. Hashing the same
 * serialization the receipt is written with is what makes that link verifiable
 * later rather than merely asserted. */
export function storageCutoffReceiptSha256(receipt: StorageCutoffReceipt): string {
  return sha256(serialized(receipt));
}
