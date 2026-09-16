import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

import { isAnalyticsRestartNonce } from '../../../shared/analytics/activation.js';
import { ANALYTICS_HANDOFF_NONCE_WINDOW_MS } from '../../../shared/analytics/handoff.js';

/** Task-specific terminal-handoff ingress: a signed, one-shot request that
 * makes one fenced VS Code extension host perform a supported quiet restart
 * (`workbench.action.restartExtensionHost`, falling back to a window reload;
 * both preserve unsaved editor work). The host records the helper-issued
 * nonce and terminal-receipt destination durably before acknowledging, so the
 * restarted boot can produce nonce-bound terminal evidence without inheriting
 * the helper's process environment. This owner stays one-shot and finite: it
 * never supervises hosts or changes ordinary automatic-restart policy. */
export const ANALYTICS_CONTROLLED_RESTART_PROTOCOL = 'pie-analytics-controlled-restart-v1' as const;
export const ANALYTICS_CONTROLLED_RESTART_SCHEMA = 1 as const;
export const PENDING_CONTROLLED_RESTART_FILENAME = 'analytics-pending-controlled-restart-v1.json';
export const CONTROLLED_RESTART_MAX_RECEIPT_PATH_BYTES = 4_096;
export const CONTROLLED_RESTART_MAX_OPERATION_ID_BYTES = 256;
/** The quiet restart fires shortly after the signed acknowledgement, so the
 * endpoint's response has flushed before the extension host stops. */
export const CONTROLLED_RESTART_DELAY_MS = 500;

export type ControlledRestartPurpose = 'analytics-activation' | 'storage-cutoff';

export interface ControlledRestartRequest {
  readonly protocol: typeof ANALYTICS_CONTROLLED_RESTART_PROTOCOL;
  readonly schema: typeof ANALYTICS_CONTROLLED_RESTART_SCHEMA;
  readonly operation: 'restart';
  readonly requestId: string;
  readonly nonce: string;
  readonly workspaceId: string;
  readonly purpose: ControlledRestartPurpose;
  readonly operationId: string;
  readonly restartNonce: string;
  readonly terminalRestartReceiptPath: string;
  /** Identity of the pre-restart host whose endpoint accepted this request.
   * Successor boots are deliberately not required to reuse this identity. */
  readonly targetHostInstanceId: string;
  /** Fresh per-boot key supplied through the authenticated pending protocol. */
  readonly successorHandoffKey: string;
  /** Exact loaded-generation evidence destination for the successor boot. */
  readonly loadedGenerationPath: string;
  /** Root/storage capabilities that must be carried by the successor boot. */
  readonly successorCapabilities: readonly string[];
  /** True only for the designated host whose terminal evidence uses the helper's
   * common receipt path. Other hosts receive owner-derived evidence paths. */
  readonly evidenceOwner: boolean;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly mac: string;
}

export interface ControlledRestartHostIdentity {
  readonly hostInstanceId: string;
  readonly workspaceId: string;
  readonly generationId: string;
  readonly buildId: string;
  readonly processId: number;
}

export interface ControlledRestartAcknowledgement {
  readonly protocol: typeof ANALYTICS_CONTROLLED_RESTART_PROTOCOL;
  readonly schema: typeof ANALYTICS_CONTROLLED_RESTART_SCHEMA;
  readonly operation: 'restart-ack';
  readonly requestId: string;
  readonly nonce: string;
  readonly workspaceId: string;
  readonly purpose: ControlledRestartPurpose;
  readonly operationId: string;
  readonly host: ControlledRestartHostIdentity;
  readonly pendingRestartRecorded: true;
  readonly restartScheduled: true;
  readonly ok: true;
  readonly mac: string;
}

export interface ControlledRestartError {
  readonly protocol: typeof ANALYTICS_CONTROLLED_RESTART_PROTOCOL;
  readonly schema: typeof ANALYTICS_CONTROLLED_RESTART_SCHEMA;
  readonly operation: 'error';
  readonly requestId: string;
  readonly ok: false;
  readonly error: string;
  readonly mac: string;
}

export type ControlledRestartResponse = ControlledRestartAcknowledgement | ControlledRestartError;

export interface PendingControlledRestartRecord {
  readonly schemaVersion: 1;
  readonly purpose: ControlledRestartPurpose;
  readonly workspaceId: string;
  readonly operationId: string;
  /** Pre-restart identity used to scope the durable request. The successor
   * boot is correlated by this record's evidence paths, not by identity reuse. */
  readonly predecessorHostInstanceId: string;
  readonly successorHandoffKey: string;
  readonly loadedGenerationPath: string;
  readonly successorCapabilities: readonly string[];
  readonly evidenceOwner: boolean;
  readonly restartNonce: string;
  readonly terminalRestartReceiptPath: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface AnalyticsHostControlledRestartOptions {
  stateDir: string;
  identity: ControlledRestartHostIdentity;
  /** Executes the supported quiet restart for this host's window. Called once,
   * after the signed acknowledgement has been produced and flushed. */
  performRestart: () => void;
  /** Injectable delay scheduler for tests. Returns a cancel function for the
   * pending restart. Defaults to a re-armed unref'd setTimeout. */
  schedule?: (perform: () => void, delayMs: number) => () => void;
}

export interface AnalyticsHostRestartHandler {
  restart(request: ControlledRestartRequest): Promise<{
    pendingRestartRecorded: true;
    restartScheduled: true;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function boundedInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function boundedIdentity(value: unknown, name: string): ControlledRestartHostIdentity {
  if (!isRecord(value)) throw new Error(`${name} is invalid.`);
  return {
    hostInstanceId: boundedString(value.hostInstanceId, `${name}.hostInstanceId`, 512),
    workspaceId: boundedString(value.workspaceId, `${name}.workspaceId`, 512),
    generationId: boundedString(value.generationId, `${name}.generationId`, 512),
    buildId: boundedString(value.buildId, `${name}.buildId`, 512),
    processId: boundedInteger(value.processId, `${name}.processId`, 1),
  };
}

function validateReceiptPath(value: unknown): string {
  const receiptPath = boundedString(value, 'terminal restart receipt path', CONTROLLED_RESTART_MAX_RECEIPT_PATH_BYTES);
  if (!path.isAbsolute(receiptPath)) {
    throw new Error('terminal restart receipt path must be absolute.');
  }
  return receiptPath;
}

function validateLoadedGenerationPath(value: unknown): string {
  const loadedGenerationPath = boundedString(
    value,
    'loaded-generation evidence path',
    CONTROLLED_RESTART_MAX_RECEIPT_PATH_BYTES,
  );
  if (!path.isAbsolute(loadedGenerationPath)) {
    throw new Error('loaded-generation evidence path must be absolute.');
  }
  return loadedGenerationPath;
}

function validateSuccessorCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('successor capabilities are invalid.');
  }
  const capabilities = value.map((capability, index) => boundedString(
    capability,
    `successor capability ${index}`,
    1_024,
  ));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error('successor capabilities must be unique.');
  }
  return capabilities;
}

function validatePurpose(value: unknown): ControlledRestartPurpose {
  if (value !== 'analytics-activation' && value !== 'storage-cutoff') {
    throw new Error('controlled restart purpose is invalid.');
  }
  return value;
}

function validateRequestTimestamps(issuedAtMs: number, expiresAtMs: number): void {
  if (expiresAtMs < issuedAtMs || expiresAtMs - issuedAtMs > ANALYTICS_HANDOFF_NONCE_WINDOW_MS) {
    throw new Error('controlled restart request expiry is invalid.');
  }
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(',')}}`;
}

function macFor(value: string, key: string): string {
  return createHmac('sha256', boundedString(key, 'controlled restart key', 4_096)).update(value, 'utf8').digest('base64url');
}

function macEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requestSigningBytes(request: Omit<ControlledRestartRequest, 'mac'>): string {
  return sortedJson({
    protocol: request.protocol,
    schema: request.schema,
    operation: request.operation,
    requestId: request.requestId,
    nonce: request.nonce,
    workspaceId: request.workspaceId,
    purpose: request.purpose,
    operationId: request.operationId,
    restartNonce: request.restartNonce,
    terminalRestartReceiptPath: request.terminalRestartReceiptPath,
    targetHostInstanceId: request.targetHostInstanceId,
    successorHandoffKey: request.successorHandoffKey,
    loadedGenerationPath: request.loadedGenerationPath,
    successorCapabilities: request.successorCapabilities,
    evidenceOwner: request.evidenceOwner,
    issuedAtMs: request.issuedAtMs,
    expiresAtMs: request.expiresAtMs,
  });
}

function acknowledgementSigningBytes(response: Omit<ControlledRestartAcknowledgement, 'mac'>): string {
  return sortedJson({
    protocol: response.protocol,
    schema: response.schema,
    operation: response.operation,
    requestId: response.requestId,
    nonce: response.nonce,
    workspaceId: response.workspaceId,
    purpose: response.purpose,
    operationId: response.operationId,
    host: response.host,
    pendingRestartRecorded: response.pendingRestartRecorded,
    restartScheduled: response.restartScheduled,
    ok: response.ok,
  });
}

function errorSigningBytes(response: Omit<ControlledRestartError, 'mac'>): string {
  return sortedJson({
    protocol: response.protocol,
    schema: response.schema,
    operation: response.operation,
    requestId: response.requestId,
    ok: response.ok,
    error: response.error,
  });
}

export function isControlledRestartRequest(value: unknown): boolean {
  return isRecord(value) && value.protocol === ANALYTICS_CONTROLLED_RESTART_PROTOCOL;
}

export function createControlledRestartRequest(
  input: Pick<
    ControlledRestartRequest,
    'workspaceId' | 'purpose' | 'operationId' | 'restartNonce' | 'terminalRestartReceiptPath'
    | 'targetHostInstanceId' | 'successorHandoffKey' | 'loadedGenerationPath'
    | 'successorCapabilities' | 'evidenceOwner'
  >,
  key: string,
  ids: { requestId?: string; nonce?: string; issuedAtMs?: number; expiresAtMs?: number } = {},
): ControlledRestartRequest {
  const issuedAtMs = ids.issuedAtMs ?? Date.now();
  const expiresAtMs = ids.expiresAtMs ?? issuedAtMs + ANALYTICS_HANDOFF_NONCE_WINDOW_MS;
  boundedInteger(issuedAtMs, 'issuedAtMs');
  boundedInteger(expiresAtMs, 'expiresAtMs');
  if (expiresAtMs < issuedAtMs || expiresAtMs - issuedAtMs > ANALYTICS_HANDOFF_NONCE_WINDOW_MS) {
    throw new Error('controlled restart request expiry is invalid.');
  }
  const restartNonce = boundedString(input.restartNonce, 'restartNonce', 256);
  if (!isAnalyticsRestartNonce(restartNonce)) {
    throw new Error('restartNonce has an invalid format or exceeds 128 bytes.');
  }
  const request: Omit<ControlledRestartRequest, 'mac'> = {
    protocol: ANALYTICS_CONTROLLED_RESTART_PROTOCOL,
    schema: ANALYTICS_CONTROLLED_RESTART_SCHEMA,
    operation: 'restart',
    requestId: boundedString(ids.requestId ?? randomUUID(), 'requestId', 128),
    nonce: boundedString(ids.nonce ?? randomUUID(), 'nonce', 128),
    workspaceId: boundedString(input.workspaceId, 'workspaceId', 512),
    purpose: validatePurpose(input.purpose),
    operationId: boundedString(input.operationId, 'operationId', CONTROLLED_RESTART_MAX_OPERATION_ID_BYTES),
    restartNonce,
    terminalRestartReceiptPath: validateReceiptPath(input.terminalRestartReceiptPath),
    targetHostInstanceId: boundedString(input.targetHostInstanceId, 'targetHostInstanceId', 512),
    successorHandoffKey: boundedString(input.successorHandoffKey, 'successor handoff key', 4_096),
    loadedGenerationPath: validateLoadedGenerationPath(input.loadedGenerationPath),
    successorCapabilities: validateSuccessorCapabilities(input.successorCapabilities),
    evidenceOwner: input.evidenceOwner === true,
    issuedAtMs,
    expiresAtMs,
  };
  return { ...request, mac: macFor(requestSigningBytes(request), key) };
}

export function verifyControlledRestartRequest(value: unknown, key: string): ControlledRestartRequest {
  if (!isRecord(value) || !exactKeys(value, [
    'evidenceOwner', 'expiresAtMs', 'issuedAtMs', 'loadedGenerationPath', 'mac', 'nonce',
    'operation', 'operationId', 'protocol', 'purpose', 'requestId', 'restartNonce', 'schema',
    'successorCapabilities', 'successorHandoffKey', 'targetHostInstanceId',
    'terminalRestartReceiptPath', 'workspaceId',
  ])) throw new Error('controlled restart request fields are invalid.');
  if (value.protocol !== ANALYTICS_CONTROLLED_RESTART_PROTOCOL
    || value.schema !== ANALYTICS_CONTROLLED_RESTART_SCHEMA
    || value.operation !== 'restart') throw new Error('controlled restart request is unsupported.');
  const requestId = boundedString(value.requestId, 'requestId', 128);
  const nonce = boundedString(value.nonce, 'nonce', 128);
  const workspaceId = boundedString(value.workspaceId, 'workspaceId', 512);
  const purpose = validatePurpose(value.purpose);
  const operationId = boundedString(value.operationId, 'operationId', CONTROLLED_RESTART_MAX_OPERATION_ID_BYTES);
  const restartNonce = boundedString(value.restartNonce, 'restartNonce', 256);
  if (!isAnalyticsRestartNonce(restartNonce)) {
    throw new Error('restartNonce has an invalid format or exceeds 128 bytes.');
  }
  const terminalRestartReceiptPath = validateReceiptPath(value.terminalRestartReceiptPath);
  const targetHostInstanceId = boundedString(value.targetHostInstanceId, 'targetHostInstanceId', 512);
  const successorHandoffKey = boundedString(value.successorHandoffKey, 'successor handoff key', 4_096);
  const loadedGenerationPath = validateLoadedGenerationPath(value.loadedGenerationPath);
  const successorCapabilities = validateSuccessorCapabilities(value.successorCapabilities);
  if (typeof value.evidenceOwner !== 'boolean') {
    throw new Error('evidenceOwner is invalid.');
  }
  const issuedAtMs = boundedInteger(value.issuedAtMs, 'issuedAtMs');
  const expiresAtMs = boundedInteger(value.expiresAtMs, 'expiresAtMs');
  if (expiresAtMs < issuedAtMs || expiresAtMs - issuedAtMs > ANALYTICS_HANDOFF_NONCE_WINDOW_MS) {
    throw new Error('controlled restart request expiry is invalid.');
  }
  const mac = boundedString(value.mac, 'controlled restart mac', 256);
  const unsigned: Omit<ControlledRestartRequest, 'mac'> = {
    protocol: ANALYTICS_CONTROLLED_RESTART_PROTOCOL,
    schema: ANALYTICS_CONTROLLED_RESTART_SCHEMA,
    operation: 'restart',
    requestId,
    nonce,
    workspaceId,
    purpose,
    operationId,
    restartNonce,
    terminalRestartReceiptPath,
    targetHostInstanceId,
    successorHandoffKey,
    loadedGenerationPath,
    successorCapabilities,
    evidenceOwner: value.evidenceOwner,
    issuedAtMs,
    expiresAtMs,
  };
  if (!macEqual(mac, macFor(requestSigningBytes(unsigned), key))) {
    throw new Error('controlled restart request authentication failed.');
  }
  return { ...unsigned, mac };
}

export function createControlledRestartAcknowledgement(
  request: ControlledRestartRequest,
  identity: ControlledRestartHostIdentity,
  key: string,
): ControlledRestartAcknowledgement {
  const host = boundedIdentity(identity, 'controlled restart host identity');
  const unsigned: Omit<ControlledRestartAcknowledgement, 'mac'> = {
    protocol: ANALYTICS_CONTROLLED_RESTART_PROTOCOL,
    schema: ANALYTICS_CONTROLLED_RESTART_SCHEMA,
    operation: 'restart-ack',
    requestId: request.requestId,
    nonce: request.nonce,
    workspaceId: request.workspaceId,
    purpose: request.purpose,
    operationId: request.operationId,
    host,
    pendingRestartRecorded: true,
    restartScheduled: true,
    ok: true,
  };
  return { ...unsigned, mac: macFor(acknowledgementSigningBytes(unsigned), key) };
}

export function createControlledRestartError(
  requestId: string,
  error: string,
  key: string,
): ControlledRestartError {
  const unsigned: Omit<ControlledRestartError, 'mac'> = {
    protocol: ANALYTICS_CONTROLLED_RESTART_PROTOCOL,
    schema: ANALYTICS_CONTROLLED_RESTART_SCHEMA,
    operation: 'error',
    requestId: boundedString(requestId, 'requestId', 128),
    ok: false,
    error: boundedString(error.replaceAll('\u0000', '').slice(0, 1_024) || 'controlled restart failed', 'controlled restart error', 1_024),
  };
  return { ...unsigned, mac: macFor(errorSigningBytes(unsigned), key) };
}

export function verifyControlledRestartResponse(value: unknown, key: string): ControlledRestartResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('controlled restart response is invalid.');
  if (value.ok === false) {
    if (!exactKeys(value, ['error', 'mac', 'ok', 'operation', 'protocol', 'requestId', 'schema'])) {
      throw new Error('controlled restart error fields are invalid.');
    }
    if (value.protocol !== ANALYTICS_CONTROLLED_RESTART_PROTOCOL
      || value.schema !== ANALYTICS_CONTROLLED_RESTART_SCHEMA
      || value.operation !== 'error') throw new Error('controlled restart response is unsupported.');
    const unsigned: Omit<ControlledRestartError, 'mac'> = {
      protocol: ANALYTICS_CONTROLLED_RESTART_PROTOCOL,
      schema: ANALYTICS_CONTROLLED_RESTART_SCHEMA,
      operation: 'error',
      requestId: boundedString(value.requestId, 'requestId', 128),
      ok: false,
      error: boundedString(value.error, 'controlled restart error', 1_024),
    };
    const mac = boundedString(value.mac, 'controlled restart mac', 256);
    if (!macEqual(mac, macFor(errorSigningBytes(unsigned), key))) {
      throw new Error('controlled restart response authentication failed.');
    }
    return { ...unsigned, mac };
  }
  if (!exactKeys(value, [
    'host', 'mac', 'nonce', 'ok', 'operation', 'operationId', 'pendingRestartRecorded',
    'protocol', 'purpose', 'requestId', 'restartScheduled', 'schema', 'workspaceId',
  ])) throw new Error('controlled restart acknowledgement fields are invalid.');
  if (value.protocol !== ANALYTICS_CONTROLLED_RESTART_PROTOCOL
    || value.schema !== ANALYTICS_CONTROLLED_RESTART_SCHEMA
    || value.operation !== 'restart-ack'
    || value.ok !== true) throw new Error('controlled restart acknowledgement is unsupported.');
  const requestId = boundedString(value.requestId, 'requestId', 128);
  const nonce = boundedString(value.nonce, 'nonce', 128);
  const workspaceId = boundedString(value.workspaceId, 'workspaceId', 512);
  const purpose = validatePurpose(value.purpose);
  const operationId = boundedString(value.operationId, 'operationId', CONTROLLED_RESTART_MAX_OPERATION_ID_BYTES);
  const host = boundedIdentity(value.host, 'controlled restart host');
  if (value.pendingRestartRecorded !== true || value.restartScheduled !== true) {
    throw new Error('controlled restart acknowledgement did not record and schedule the restart.');
  }
  const unsigned: Omit<ControlledRestartAcknowledgement, 'mac'> = {
    protocol: ANALYTICS_CONTROLLED_RESTART_PROTOCOL,
    schema: ANALYTICS_CONTROLLED_RESTART_SCHEMA,
    operation: 'restart-ack',
    requestId,
    nonce,
    workspaceId,
    purpose,
    operationId,
    host,
    pendingRestartRecorded: true,
    restartScheduled: true,
    ok: true,
  };
  const mac = boundedString(value.mac, 'controlled restart mac', 256);
  if (!macEqual(mac, macFor(acknowledgementSigningBytes(unsigned), key))) {
    throw new Error('controlled restart response authentication failed.');
  }
  return { ...unsigned, mac };
}

function pendingRestartRecordFromRequest(request: ControlledRestartRequest): PendingControlledRestartRecord {
  return {
    schemaVersion: 1,
    purpose: request.purpose,
    workspaceId: request.workspaceId,
    operationId: request.operationId,
    predecessorHostInstanceId: request.targetHostInstanceId,
    successorHandoffKey: request.successorHandoffKey,
    loadedGenerationPath: request.loadedGenerationPath,
    successorCapabilities: [...request.successorCapabilities],
    evidenceOwner: request.evidenceOwner,
    restartNonce: request.restartNonce,
    terminalRestartReceiptPath: request.terminalRestartReceiptPath,
    issuedAtMs: request.issuedAtMs,
    expiresAtMs: request.expiresAtMs,
  };
}

const PENDING_CONTROLLED_RESTART_MAX_BYTES = 8 * 1024;
const PENDING_CONTROLLED_RESTART_PREFIX = `${PENDING_CONTROLLED_RESTART_FILENAME}.`;

function scopedPendingControlledRestartFilename(predecessorHostInstanceId: string): string {
  const digest = createHash('sha256').update(predecessorHostInstanceId, 'utf8').digest('hex');
  return `${PENDING_CONTROLLED_RESTART_PREFIX}${digest}.json`;
}

/** Return the host-scoped pending path. The no-identity form remains the
 * legacy filename solely so malformed legacy files are not mistaken for a new
 * authenticated request. */
export function pendingControlledRestartPath(
  stateDir: string,
  predecessorHostInstanceId?: string,
): string {
  return predecessorHostInstanceId === undefined
    ? path.join(stateDir, PENDING_CONTROLLED_RESTART_FILENAME)
    : path.join(stateDir, scopedPendingControlledRestartFilename(predecessorHostInstanceId));
}

/** Write one host-scoped durable pending restart. A restart of several hosts
 * therefore creates several independently claimable records; a successor boot
 * atomically claims one record and carries its own key/capabilities forward. */
export function writePendingControlledRestartAtomically(
  stateDir: string,
  record: PendingControlledRestartRecord,
): void {
  const destination = pendingControlledRestartPath(stateDir, record.predecessorHostInstanceId);
  const temporary = path.join(stateDir, `.${path.basename(destination)}.${process.pid}-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(bytes, 'utf8') > PENDING_CONTROLLED_RESTART_MAX_BYTES) {
    throw new Error('pending controlled restart record is too large.');
  }
  mkdirSync(stateDir, { recursive: true });
  let descriptor: number | undefined;
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
    descriptor = openSync(temporary, 'r+');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function readPendingControlledRestartAtPath(
  destination: string,
): PendingControlledRestartRecord | undefined {
  let size: number;
  try {
    size = statSync(destination).size;
  } catch {
    return undefined;
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > PENDING_CONTROLLED_RESTART_MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(destination, 'utf8'));
  } catch {
    return undefined;
  }
  return validatePendingControlledRestart(parsed);
}

/** Bounded read of one host-scoped pending restart. Structural or size
 * problems are treated as absent rather than as an authorization. */
export function readPendingControlledRestart(
  stateDir: string,
  predecessorHostInstanceId?: string,
): PendingControlledRestartRecord | undefined {
  const record = readPendingControlledRestartAtPath(pendingControlledRestartPath(stateDir, predecessorHostInstanceId));
  if (record && predecessorHostInstanceId !== undefined
    && record.predecessorHostInstanceId !== predecessorHostInstanceId) {
    return undefined;
  }
  return record;
}

export function validatePendingControlledRestart(value: unknown): PendingControlledRestartRecord | undefined {
  if (!isRecord(value) || !exactKeys(value, [
    'evidenceOwner', 'expiresAtMs', 'issuedAtMs', 'loadedGenerationPath', 'operationId',
    'predecessorHostInstanceId', 'purpose', 'restartNonce', 'schemaVersion',
    'successorCapabilities', 'successorHandoffKey', 'terminalRestartReceiptPath', 'workspaceId',
  ])) return undefined;
  try {
    if (value.schemaVersion !== 1) return undefined;
    const purpose = validatePurpose(value.purpose);
    const workspaceId = boundedString(value.workspaceId, 'workspaceId', 512);
    const operationId = boundedString(value.operationId, 'operationId', CONTROLLED_RESTART_MAX_OPERATION_ID_BYTES);
    const predecessorHostInstanceId = boundedString(value.predecessorHostInstanceId, 'predecessorHostInstanceId', 512);
    const successorHandoffKey = boundedString(value.successorHandoffKey, 'successor handoff key', 4_096);
    const loadedGenerationPath = validateLoadedGenerationPath(value.loadedGenerationPath);
    const successorCapabilities = validateSuccessorCapabilities(value.successorCapabilities);
    if (typeof value.evidenceOwner !== 'boolean') return undefined;
    const restartNonce = boundedString(value.restartNonce, 'restartNonce', 256);
    if (!isAnalyticsRestartNonce(restartNonce)) return undefined;
    const terminalRestartReceiptPath = validateReceiptPath(value.terminalRestartReceiptPath);
    const issuedAtMs = boundedInteger(value.issuedAtMs, 'issuedAtMs');
    const expiresAtMs = boundedInteger(value.expiresAtMs, 'expiresAtMs');
    if (expiresAtMs < issuedAtMs || expiresAtMs - issuedAtMs > ANALYTICS_HANDOFF_NONCE_WINDOW_MS) return undefined;
    return {
      schemaVersion: 1,
      purpose,
      workspaceId,
      operationId,
      predecessorHostInstanceId,
      successorHandoffKey,
      loadedGenerationPath,
      successorCapabilities,
      evidenceOwner: value.evidenceOwner,
      restartNonce,
      terminalRestartReceiptPath,
      issuedAtMs,
      expiresAtMs,
    };
  } catch {
    return undefined;
  }
}

/** A pending restart is consumable only inside its signed request window. */
export function isPendingControlledRestartConsumable(
  record: PendingControlledRestartRecord,
  nowMs: number,
): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0
    && record.issuedAtMs <= nowMs && nowMs <= record.expiresAtMs;
}

function pendingControlledRestartCandidates(stateDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(PENDING_CONTROLLED_RESTART_PREFIX) && name.endsWith('.json'))
    .sort()
    .slice(0, 128)
    .map((name) => path.join(stateDir, name));
}

/** Atomically claim one pending record for a successor boot. The successor's
 * new identity is intentionally not assumed in advance: the owner correlates
 * the claimed record's exact evidence path with the actual boot identity. */
export function claimPendingControlledRestart(
  stateDir: string,
  nowMs = Date.now(),
): PendingControlledRestartRecord | undefined {
  for (const source of pendingControlledRestartCandidates(stateDir)) {
    const claim = `${source}.claim-${process.pid}-${randomUUID()}`;
    try {
      renameSync(source, claim);
    } catch {
      continue;
    }
    try {
      const record = readPendingControlledRestartAtPath(claim);
      if (record && isPendingControlledRestartConsumable(record, nowMs)) return record;
    } finally {
      try { rmSync(claim, { force: true }); } catch { /* best-effort single-use cleanup */ }
    }
  }
  return undefined;
}

/** Remove one host-scoped pending restart (or all scoped records when no
 * predecessor is supplied). Consumption is best-effort hygiene; the signed
 * nonce and exact evidence paths own the completion semantics. */
export function consumePendingControlledRestart(
  stateDir: string,
  predecessorHostInstanceId?: string,
): void {
  const destinations = predecessorHostInstanceId === undefined
    ? [pendingControlledRestartPath(stateDir), ...pendingControlledRestartCandidates(stateDir)]
    : [pendingControlledRestartPath(stateDir, predecessorHostInstanceId)];
  for (const destination of destinations) {
    try { rmSync(destination, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

/** Host-local signed restart handler. It records the pending restart before it
 * acknowledges, and schedules the supported quiet restart afterwards. */
export function createAnalyticsHostControlledRestart(
  options: AnalyticsHostControlledRestartOptions,
): AnalyticsHostRestartHandler {
  const identity = boundedIdentity(options.identity, 'controlled restart identity');
  let cancelScheduled: (() => void) | undefined;
  const defaultSchedule = (perform: () => void, delayMs: number): (() => void) => {
    const timer = setTimeout(perform, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  };
  return {
    async restart(request) {
      if (request.workspaceId !== identity.workspaceId) {
        throw new Error('controlled restart workspace identity does not match.');
      }
      if (request.targetHostInstanceId !== identity.hostInstanceId) {
        throw new Error('controlled restart target identity does not match.');
      }
      // A newer signed request for this predecessor supersedes its pending
      // record; requests for other hosts have independent durable slots.
      writePendingControlledRestartAtomically(options.stateDir, pendingRestartRecordFromRequest(request));
      cancelScheduled?.();
      cancelScheduled = undefined;
      cancelScheduled = (options.schedule ?? defaultSchedule)(options.performRestart, CONTROLLED_RESTART_DELAY_MS);
      const recorded = readPendingControlledRestart(options.stateDir, identity.hostInstanceId);
      if (!recorded || recorded.restartNonce !== request.restartNonce
        || recorded.terminalRestartReceiptPath !== request.terminalRestartReceiptPath
        || recorded.successorHandoffKey !== request.successorHandoffKey) {
        throw new Error('controlled restart pending record was not durable.');
      }
      return { pendingRestartRecorded: true, restartScheduled: true };
    },
  };
}

export function pendingControlledRestartExists(
  stateDir: string,
  predecessorHostInstanceId?: string,
): boolean {
  return existsSync(pendingControlledRestartPath(stateDir, predecessorHostInstanceId));
}
