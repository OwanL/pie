import { isJsonSafeValue, type JsonStructuralPatchOperation } from '../json-structural-patch.js';
import { utf8ByteLength } from '../utf8.js';
import type { LazyDetailRef } from './messages.js';

export const SUBAGENT_DETAIL_PROTOCOL_VERSION = 1 as const;
export const DETAIL_CHECKSUM_ALGORITHM = 'sha256' as const;

export interface SubagentChildIdentity {
  childId: string;
  spawningToolCallId: string;
  attemptId: string;
}

/** Immutable producer-owned address. Revisions and display indexes are never identity. */
export interface LiveSubagentDetailAddress {
  sessionPath: string;
  turnId: string;
  rootToolCallId: string;
  rootAttemptId: string;
  lineage: readonly SubagentChildIdentity[];
}

export interface DetailCursor {
  revision: number;
  pageIndex?: number;
}

export interface BackendDetailFence {
  backendGeneration: number;
  coordinatorGeneration: number;
  workerId?: string;
  workerGeneration?: number;
}

export interface DetailPageRef {
  baselineRevision: number;
  pageIndex: number;
  pageCount: number;
}

/**
 * A baseline is the exact UTF-8 JSON representation of one semantic detail.
 * Segments are split only between Unicode code points. Concatenating `text` in
 * page order and JSON-parsing it reconstructs the exact value.
 */
export interface DetailJsonSegmentPayload {
  kind: 'json-segment';
  encoding: 'utf8-json';
  segmentId: string;
  semanticPath: readonly (string | number)[];
  startByte: number;
  endByte: number;
  totalBytes: number;
  startCodePoint: number;
  endCodePoint: number;
  totalCodePoints: number;
  text: string;
}

export type DetailPagePayload = DetailJsonSegmentPayload;
export type DetailChecksum = string;
export type DetailRebaseReason = 'gap' | 'backpressure' | 'evicted' | 'generation-change';
export type DetailErrorCode =
  | 'INVALID_ADDRESS'
  | 'NOT_LIVE_ADDRESSABLE'
  | 'NOT_FOUND'
  | 'STALE_CURSOR'
  | 'CHECKSUM_MISMATCH'
  | 'SUBSCRIPTION_CONFLICT'
  | 'UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type HostToCoordinatorDetailMessage =
  | { kind: 'detail.subscribe'; requestId: string; subscriptionId: string; address: LiveSubagentDetailAddress; cursor?: DetailCursor; maxPageBytes: number }
  | { kind: 'detail.unsubscribe'; requestId: string; subscriptionId: string; reason: 'collapse' | 'rebase' | 'session-change' | 'host-dispose' }
  | { kind: 'detail.fetch'; requestId: string; subscriptionId: string; address: LiveSubagentDetailAddress; ref: DetailPageRef; maxPageBytes: number };

export type CoordinatorToHostDetailMessage =
  | { kind: 'detail.start'; subscriptionId: string; address: LiveSubagentDetailAddress; source: 'live' | 'durable'; baselineRevision: number; pageCount: number; totalBytes: number; totalCodePoints: number; fence: BackendDetailFence }
  | { kind: 'detail.page'; subscriptionId: string; ref: DetailPageRef; payload: DetailPagePayload; payloadBytes: number; checksum: DetailChecksum; fence: BackendDetailFence }
  | { kind: 'detail.delta'; subscriptionId: string; baseRevision: number; revision: number; operations: JsonStructuralPatchOperation[]; fence: BackendDetailFence }
  | { kind: 'detail.rebase'; subscriptionId: string; currentRevision: number; reason: DetailRebaseReason; fence: BackendDetailFence }
  | { kind: 'detail.terminal'; subscriptionId: string; revision: number; durableRef: LazyDetailRef; fence: BackendDetailFence }
  | { kind: 'detail.error'; subscriptionId: string; code: DetailErrorCode; message: string; retryable: boolean; fence: BackendDetailFence };

const ID_BYTES = 512;
const PATH_BYTES = 16 * 1024;
const MESSAGE_BYTES = 64 * 1024;
const MAX_LINEAGE = 64;
const MAX_OPERATIONS = 4_096;
const MAX_PATCH_PATH = 128;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ERROR_CODES = new Set<DetailErrorCode>([
  'INVALID_ADDRESS', 'NOT_LIVE_ADDRESSABLE', 'NOT_FOUND', 'STALE_CURSOR',
  'CHECKSUM_MISMATCH', 'SUBSCRIPTION_CONFLICT', 'UNAVAILABLE', 'INTERNAL_ERROR',
]);

export function isLiveSubagentDetailAddress(value: unknown): value is LiveSubagentDetailAddress {
  if (!recordWithKeys(value, ['sessionPath', 'turnId', 'rootToolCallId', 'rootAttemptId', 'lineage'])) return false;
  if (!boundedString(value.sessionPath, PATH_BYTES)
    || !boundedString(value.turnId, ID_BYTES)
    || !boundedString(value.rootToolCallId, ID_BYTES)
    || !boundedString(value.rootAttemptId, ID_BYTES)
    || !Array.isArray(value.lineage)
    || value.lineage.length === 0
    || value.lineage.length > MAX_LINEAGE) return false;
  const childIds = new Set<string>();
  return value.lineage.every((identity) => {
    if (!recordWithKeys(identity, ['childId', 'spawningToolCallId', 'attemptId'])
      || !boundedString(identity.childId, ID_BYTES)
      || !boundedString(identity.spawningToolCallId, ID_BYTES)
      || !boundedString(identity.attemptId, ID_BYTES)
      || childIds.has(identity.childId)) return false;
    childIds.add(identity.childId);
    return true;
  });
}

export function isDetailCursor(value: unknown): value is DetailCursor {
  return recordWithKeys(value, ['revision'], ['pageIndex'])
    && nonNegativeInteger(value.revision)
    && (value.pageIndex === undefined || nonNegativeInteger(value.pageIndex));
}

export function isBackendDetailFence(value: unknown): value is BackendDetailFence {
  if (!recordWithKeys(value, ['backendGeneration', 'coordinatorGeneration'], ['workerId', 'workerGeneration'])
    || !positiveInteger(value.backendGeneration)
    || !positiveInteger(value.coordinatorGeneration)) return false;
  const hasWorkerId = value.workerId !== undefined;
  const hasWorkerGeneration = value.workerGeneration !== undefined;
  return hasWorkerId === hasWorkerGeneration
    && (!hasWorkerId || (boundedString(value.workerId, ID_BYTES) && positiveInteger(value.workerGeneration)));
}

export function isDetailPageRef(value: unknown): value is DetailPageRef {
  return recordWithKeys(value, ['baselineRevision', 'pageIndex', 'pageCount'])
    && nonNegativeInteger(value.baselineRevision)
    && nonNegativeInteger(value.pageIndex)
    && positiveInteger(value.pageCount)
    && (value.pageIndex as number) < (value.pageCount as number);
}

export function isDetailPagePayload(value: unknown): value is DetailPagePayload {
  if (!recordWithKeys(value, [
    'kind', 'encoding', 'segmentId', 'semanticPath', 'startByte', 'endByte', 'totalBytes',
    'startCodePoint', 'endCodePoint', 'totalCodePoints', 'text',
  ])) return false;
  if (value.kind !== 'json-segment' || value.encoding !== 'utf8-json'
    || !boundedString(value.segmentId, ID_BYTES) || typeof value.text !== 'string'
    || !Array.isArray(value.semanticPath) || value.semanticPath.length > MAX_PATCH_PATH
    || !value.semanticPath.every(validPathSegment)
    || !nonNegativeInteger(value.startByte) || !nonNegativeInteger(value.endByte)
    || !nonNegativeInteger(value.totalBytes) || !nonNegativeInteger(value.startCodePoint)
    || !nonNegativeInteger(value.endCodePoint) || !nonNegativeInteger(value.totalCodePoints)) return false;
  return value.startByte <= value.endByte && value.endByte <= value.totalBytes
    && value.startCodePoint <= value.endCodePoint && value.endCodePoint <= value.totalCodePoints
    && utf8ByteLength(value.text) === value.endByte - value.startByte
    && [...value.text].length === value.endCodePoint - value.startCodePoint;
}

export function isDetailChecksum(value: unknown): value is DetailChecksum {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function isHostToCoordinatorDetailMessage(value: unknown): value is HostToCoordinatorDetailMessage {
  if (!isRecord(value) || !boundedString(value.kind, 64)) return false;
  if (value.kind === 'detail.subscribe') {
    return recordWithKeys(value, ['kind', 'requestId', 'subscriptionId', 'address', 'maxPageBytes'], ['cursor'])
      && boundedString(value.requestId, ID_BYTES) && boundedString(value.subscriptionId, ID_BYTES)
      && isLiveSubagentDetailAddress(value.address)
      && (value.cursor === undefined || isDetailCursor(value.cursor))
      && positiveInteger(value.maxPageBytes);
  }
  if (value.kind === 'detail.unsubscribe') {
    return recordWithKeys(value, ['kind', 'requestId', 'subscriptionId', 'reason'])
      && boundedString(value.requestId, ID_BYTES) && boundedString(value.subscriptionId, ID_BYTES)
      && (value.reason === 'collapse' || value.reason === 'rebase' || value.reason === 'session-change' || value.reason === 'host-dispose');
  }
  if (value.kind === 'detail.fetch') {
    return recordWithKeys(value, ['kind', 'requestId', 'subscriptionId', 'address', 'ref', 'maxPageBytes'])
      && boundedString(value.requestId, ID_BYTES) && boundedString(value.subscriptionId, ID_BYTES)
      && isLiveSubagentDetailAddress(value.address) && isDetailPageRef(value.ref)
      && positiveInteger(value.maxPageBytes);
  }
  return false;
}

export function isCoordinatorToHostDetailMessage(value: unknown): value is CoordinatorToHostDetailMessage {
  if (!isRecord(value) || !boundedString(value.kind, 64)) return false;
  const common = boundedString(value.subscriptionId, ID_BYTES) && isBackendDetailFence(value.fence);
  if (!common) return false;
  switch (value.kind) {
    case 'detail.start':
      return recordWithKeys(value, ['kind', 'subscriptionId', 'address', 'source', 'baselineRevision', 'pageCount', 'totalBytes', 'totalCodePoints', 'fence'])
        && isLiveSubagentDetailAddress(value.address) && (value.source === 'live' || value.source === 'durable')
        && nonNegativeInteger(value.baselineRevision) && positiveInteger(value.pageCount)
        && nonNegativeInteger(value.totalBytes) && nonNegativeInteger(value.totalCodePoints);
    case 'detail.page':
      return recordWithKeys(value, ['kind', 'subscriptionId', 'ref', 'payload', 'payloadBytes', 'checksum', 'fence'])
        && isDetailPageRef(value.ref) && isDetailPagePayload(value.payload)
        && nonNegativeInteger(value.payloadBytes)
        && value.payloadBytes === utf8ByteLength(JSON.stringify(value.payload))
        && isDetailChecksum(value.checksum);
    case 'detail.delta':
      return recordWithKeys(value, ['kind', 'subscriptionId', 'baseRevision', 'revision', 'operations', 'fence'])
        && nonNegativeInteger(value.baseRevision) && positiveInteger(value.revision)
        && value.revision > value.baseRevision && isPatchOperations(value.operations);
    case 'detail.rebase':
      return recordWithKeys(value, ['kind', 'subscriptionId', 'currentRevision', 'reason', 'fence'])
        && nonNegativeInteger(value.currentRevision)
        && (value.reason === 'gap' || value.reason === 'backpressure' || value.reason === 'evicted' || value.reason === 'generation-change');
    case 'detail.terminal':
      return recordWithKeys(value, ['kind', 'subscriptionId', 'revision', 'durableRef', 'fence'])
        && nonNegativeInteger(value.revision) && isLazyDetailRef(value.durableRef);
    case 'detail.error':
      return recordWithKeys(value, ['kind', 'subscriptionId', 'code', 'message', 'retryable', 'fence'])
        && typeof value.code === 'string' && ERROR_CODES.has(value.code as DetailErrorCode)
        && boundedString(value.message, MESSAGE_BYTES) && typeof value.retryable === 'boolean';
    default: return false;
  }
}

export function isPatchOperations(value: unknown): value is JsonStructuralPatchOperation[] {
  if (!Array.isArray(value) || value.length > MAX_OPERATIONS) return false;
  return value.every((operation) => {
    if (!isRecord(operation) || !Array.isArray(operation.path)
      || operation.path.length > MAX_PATCH_PATH || !operation.path.every(validPathSegment)) return false;
    if (operation.op === 'delete') return recordWithKeys(operation, ['op', 'path']);
    if (operation.op === 'appendString') return recordWithKeys(operation, ['op', 'path', 'value']) && typeof operation.value === 'string';
    if (operation.op === 'appendArray') return recordWithKeys(operation, ['op', 'path', 'value'])
      && Array.isArray(operation.value) && operation.value.every((entry) => isJsonSafeValue(entry));
    return operation.op === 'set' && recordWithKeys(operation, ['op', 'path', 'value']) && isJsonSafeValue(operation.value);
  });
}

function isLazyDetailRef(value: unknown): value is LazyDetailRef {
  if (!recordWithKeys(value,
    ['key', 'kind', 'source', 'sessionPath', 'messageId', 'sizeBytes', 'summary', 'available'],
    ['toolCallId', 'executionId', 'partIndex', 'sourceRevision', 'childCount', 'lineCount'])) return false;
  return boundedString(value.key, PATH_BYTES)
    && (value.kind === 'tool-result' || value.kind === 'reasoning')
    && (value.source === 'durable' || value.source === 'live')
    && boundedString(value.sessionPath, PATH_BYTES) && boundedString(value.messageId, ID_BYTES)
    && nonNegativeInteger(value.sizeBytes) && typeof value.summary === 'string' && typeof value.available === 'boolean'
    && optionalString(value.toolCallId) && optionalString(value.executionId)
    && optionalNonNegative(value.partIndex) && optionalNonNegative(value.sourceRevision)
    && optionalNonNegative(value.childCount) && optionalNonNegative(value.lineCount);
}

function validPathSegment(value: unknown): boolean {
  return typeof value === 'string' ? !FORBIDDEN_KEYS.has(value) && utf8ByteLength(value) <= ID_BYTES : nonNegativeInteger(value);
}

function optionalString(value: unknown): boolean { return value === undefined || boundedString(value, ID_BYTES); }
function optionalNonNegative(value: unknown): boolean { return value === undefined || nonNegativeInteger(value); }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function boundedString(value: unknown, bytes: number): value is string { return typeof value === 'string' && value.length > 0 && utf8ByteLength(value) <= bytes; }
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function recordWithKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.length <= allowed.size && keys.every((key) => allowed.has(key));
}
