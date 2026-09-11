import { createHash } from 'node:crypto';

import type {
  AnalyticsCaptureSubject,
  AnalyticsDetailCapture,
  AnalyticsObservation,
  Int64Value,
} from './contracts.js';
import { assertValidAnalyticsObservation, parseInt64 } from './contracts.js';

export const ANALYTICS_TRANSPORT_VERSION = 1 as const;
export const ANALYTICS_TRANSPORT_MAX_FACT_BYTES = 192 * 1024;
export const ANALYTICS_TRANSPORT_MAX_DETAIL_START_BYTES = 192 * 1024;
export const ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES = 96 * 1024;
export const ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES = 16 * 1024 * 1024;
export const ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS = Math.ceil(
  ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES / ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES,
);

const MAX_ID_BYTES = 1_024;
const MAX_PATH_BYTES = 32 * 1_024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;
const MAX_PRODUCER_RECONCILIATION_GAPS = 4_096;

export interface AnalyticsTransportRoute {
  coordinatorGeneration: number;
  workerId: string;
  workerGeneration: number;
  workerPid: number;
  rootSessionPath: string;
  leasePath: string;
  leaseRevision: number;
}

export interface AnalyticsTransportFactPacket {
  version: typeof ANALYTICS_TRANSPORT_VERSION;
  kind: 'fact';
  deliveryId: string;
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  observation: AnalyticsObservation<object>;
}

export interface AnalyticsTransportDetailStartPacket {
  version: typeof ANALYTICS_TRANSPORT_VERSION;
  kind: 'detail.start';
  deliveryId: string;
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  payloadId: string;
  sourceKey: string;
  byteLength: number;
  chunkCount: number;
  sha256: string;
  detail: Omit<AnalyticsDetailCapture, 'bytes'>;
}

export interface AnalyticsTransportDetailChunkPacket {
  version: typeof ANALYTICS_TRANSPORT_VERSION;
  kind: 'detail.chunk';
  deliveryId: string;
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  payloadId: string;
  index: number;
  data: string;
}

export interface AnalyticsTransportDetailEndPacket {
  version: typeof ANALYTICS_TRANSPORT_VERSION;
  kind: 'detail.end';
  deliveryId: string;
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  payloadId: string;
  chunkCount: number;
  sha256: string;
}

export interface AnalyticsTransportDetailAbortPacket {
  version: typeof ANALYTICS_TRANSPORT_VERSION;
  kind: 'detail.abort';
  deliveryId: string;
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  payloadId: string;
  code: string;
  message: string;
}

export type AnalyticsTransportPacket =
  | AnalyticsTransportFactPacket
  | AnalyticsTransportDetailStartPacket
  | AnalyticsTransportDetailChunkPacket
  | AnalyticsTransportDetailEndPacket
  | AnalyticsTransportDetailAbortPacket;

export interface AnalyticsTransportIngressEnvelope {
  route: AnalyticsTransportRoute;
  packet: AnalyticsTransportPacket;
}

export interface AnalyticsTransportProducerReconciliation {
  producerIdentity: string;
  contiguousWatermark: number | string;
  highestObservedSequence: number | string;
  visibleGaps: Array<{ from: number | string; to: number | string }>;
  pendingReceiptCount: number;
}

export interface AnalyticsTransportAcknowledgement {
  version: typeof ANALYTICS_TRANSPORT_VERSION;
  deliveryId: string;
  generationId: string;
  status: 'durable' | 'rejected';
  producerReconciliation?: AnalyticsTransportProducerReconciliation[];
  completeDetailPayloadId?: string;
  code?: string;
  message?: string;
}

export interface InstalledAnalyticsRuntimeBridge {
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  workspaceId?: string;
  producer: {
    buildId: string;
    processId: number;
    processGeneration: string;
  };
  submitObservation(observation: AnalyticsObservation<object>): void;
  submitDetail(capture: AnalyticsDetailCapture): void;
  readFactAcknowledgement(generationId: string, stableOriginId: string): Int64Value | undefined;
  isDetailComplete(payloadId: string): boolean;
  releaseAcknowledgementInterest(generationId: string, stableOriginId: string, payloadId: string): void;
}

export const ANALYTICS_RUNTIME_BRIDGE_KEY = Symbol.for('pie.analytics.runtime-bridge.v1');

export function analyticsCaptureSubjectKey(subject: AnalyticsCaptureSubject): string {
  switch (subject.kind) {
    case 'session': return `session:${subject.rootSessionId}`;
    case 'pendingCreate': return `pendingCreate:${subject.operationId}`;
    case 'host': return `host:${subject.hostId}`;
  }
}

export function sameAnalyticsCaptureSubject(
  left: AnalyticsCaptureSubject,
  right: AnalyticsCaptureSubject,
): boolean {
  return analyticsCaptureSubjectKey(left) === analyticsCaptureSubjectKey(right);
}

/** Exact identity used by the recorder reconciliation table and producer ACKs. */
export function analyticsProducerIdentity(
  generationId: string,
  producerKind: string,
  stableOriginId: string,
): string {
  return JSON.stringify([
    requireId(generationId, 'producer generationId'),
    requireId(producerKind, 'producer kind'),
    requireId(stableOriginId, 'producer stable origin'),
  ]);
}

/** One canonical mapping for host tool facts and nested-child parent links. */
export function canonicalAnalyticsToolEntityId(sessionIdentity: string, rawToolCallId: string): string {
  const session = requireId(sessionIdentity, 'session identity');
  const tool = requireId(rawToolCallId, 'tool-call identity');
  return `tool:${createHash('sha256').update(JSON.stringify([session, tool])).digest('hex')}`;
}

export function analyticsTransportDeliveryId(
  generationId: string,
  kind: 'fact' | 'detail',
  sourceKey: string,
): string {
  return `analytics-delivery:${createHash('sha256').update(JSON.stringify([
    requireId(generationId, 'generationId'),
    kind,
    requireId(sourceKey, 'sourceKey'),
  ])).digest('hex')}`;
}

export function createAnalyticsFactPacket(
  observation: AnalyticsObservation<object>,
): AnalyticsTransportFactPacket {
  const normalized = normalizeJsonValue(observation, 'observation');
  assertValidAnalyticsObservation(normalized);
  const encodedBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  if (encodedBytes > ANALYTICS_TRANSPORT_MAX_FACT_BYTES) {
    throw new Error(`Analytics fact exceeds the ${ANALYTICS_TRANSPORT_MAX_FACT_BYTES}-byte transport bound.`);
  }
  return {
    version: ANALYTICS_TRANSPORT_VERSION,
    kind: 'fact',
    deliveryId: analyticsTransportDeliveryId(observation.generationId, 'fact', observation.sourceKey),
    generationId: observation.generationId,
    captureSubject: observation.captureSubject,
    observation: normalized,
  };
}

export function createAnalyticsDetailPackets(
  capture: AnalyticsDetailCapture,
): AnalyticsTransportPacket[] {
  const bytes = Buffer.from(capture.bytes);
  if (bytes.byteLength > ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES) {
    throw new Error(`Analytics detail exceeds the ${ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES}-byte transport bound.`);
  }
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES));
  if (chunkCount > ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS) throw new Error('Analytics detail chunk count exceeds the transport bound.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const deliveryId = analyticsTransportDeliveryId(capture.generationId, 'detail', capture.sourceKey);
  const detail = parseAnalyticsDetailMetadata(normalizeJsonValue(
    Object.fromEntries(Object.entries(capture).filter(([key]) => key !== 'bytes')),
    'detail',
  ));
  const start: AnalyticsTransportDetailStartPacket = {
    version: ANALYTICS_TRANSPORT_VERSION,
    kind: 'detail.start',
    deliveryId,
    generationId: capture.generationId,
    captureSubject: capture.captureSubject,
    payloadId: capture.payloadId,
    sourceKey: capture.sourceKey,
    byteLength: bytes.byteLength,
    chunkCount,
    sha256,
    detail,
  };
  requireJsonByteBound(start, ANALYTICS_TRANSPORT_MAX_DETAIL_START_BYTES, 'Analytics detail start');
  const packets: AnalyticsTransportPacket[] = [start];
  for (let index = 0; index < chunkCount; index += 1) {
    packets.push({
      version: ANALYTICS_TRANSPORT_VERSION,
      kind: 'detail.chunk',
      deliveryId,
      generationId: capture.generationId,
      captureSubject: capture.captureSubject,
      payloadId: capture.payloadId,
      index,
      data: bytes.subarray(
        index * ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES,
        Math.min(bytes.byteLength, (index + 1) * ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES),
      ).toString('base64'),
    });
  }
  packets.push({
    version: ANALYTICS_TRANSPORT_VERSION,
    kind: 'detail.end',
    deliveryId,
    generationId: capture.generationId,
    captureSubject: capture.captureSubject,
    payloadId: capture.payloadId,
    chunkCount,
    sha256,
  });
  return packets;
}

export function createAnalyticsDetailAbortPacket(
  start: AnalyticsTransportDetailStartPacket,
  code: string,
  message: string,
): AnalyticsTransportDetailAbortPacket {
  const boundedMessage = requireBoundedMessage(message, 'detail abort message');
  return {
    version: ANALYTICS_TRANSPORT_VERSION,
    kind: 'detail.abort',
    deliveryId: start.deliveryId,
    generationId: start.generationId,
    captureSubject: start.captureSubject,
    payloadId: start.payloadId,
    code: requireId(code, 'detail abort code'),
    message: boundedMessage,
  };
}

export function parseAnalyticsTransportPacket(value: unknown): AnalyticsTransportPacket {
  const packet = requireRecord(value, 'analytics transport packet');
  if (packet.version !== ANALYTICS_TRANSPORT_VERSION) throw new Error('Analytics transport version is unsupported.');
  const kind = packet.kind;
  if (kind !== 'fact' && kind !== 'detail.start' && kind !== 'detail.chunk' && kind !== 'detail.end' && kind !== 'detail.abort') {
    throw new Error('Analytics transport packet kind is invalid.');
  }
  const deliveryId = requireId(packet.deliveryId, 'deliveryId');
  const generationId = requireId(packet.generationId, 'generationId');
  const captureSubject = parseAnalyticsCaptureSubject(packet.captureSubject);
  if (kind === 'fact') {
    requireExactKeys(packet, ['version', 'kind', 'deliveryId', 'generationId', 'captureSubject', 'observation'], 'analytics fact packet');
    const observation = normalizeJsonValue(packet.observation, 'observation');
    const bytes = Buffer.byteLength(JSON.stringify(observation), 'utf8');
    if (bytes > ANALYTICS_TRANSPORT_MAX_FACT_BYTES) throw new Error('Analytics fact transport bound exceeded.');
    if (observation.generationId !== packet.generationId) throw new Error('Analytics fact generation does not match its envelope.');
    if (!sameAnalyticsCaptureSubject(parseAnalyticsCaptureSubject(observation.captureSubject), captureSubject)) {
      throw new Error('Analytics fact subject does not match its envelope.');
    }
    assertValidAnalyticsObservation(observation);
    if (deliveryId !== analyticsTransportDeliveryId(generationId, 'fact', observation.sourceKey)) {
      throw new Error('Analytics fact delivery identity does not match its source identity.');
    }
    return {
      version: ANALYTICS_TRANSPORT_VERSION,
      kind,
      deliveryId,
      generationId,
      captureSubject,
      observation,
    };
  }
  const payloadId = requireId(packet.payloadId, 'payloadId');
  if (kind === 'detail.start') {
    requireExactKeys(packet, [
      'version', 'kind', 'deliveryId', 'generationId', 'captureSubject', 'payloadId',
      'sourceKey', 'byteLength', 'chunkCount', 'sha256', 'detail',
    ], 'analytics detail-start packet');
    requireJsonByteBound(packet, ANALYTICS_TRANSPORT_MAX_DETAIL_START_BYTES, 'Analytics detail start');
    const sourceKey = requireId(packet.sourceKey, 'sourceKey');
    const byteLength = requireBoundedInteger(packet.byteLength, 0, ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES, 'byteLength');
    const chunkCount = requireBoundedInteger(packet.chunkCount, 1, ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS, 'chunkCount');
    const expectedChunks = Math.max(1, Math.ceil(byteLength / ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES));
    if (chunkCount !== expectedChunks) throw new Error('Analytics detail chunk count does not match its byte length.');
    const sha256 = requireSha256(packet.sha256);
    const detail = parseAnalyticsDetailMetadata(packet.detail);
    if (detail.generationId !== packet.generationId || detail.payloadId !== packet.payloadId || detail.sourceKey !== packet.sourceKey) {
      throw new Error('Analytics detail metadata does not match its envelope.');
    }
    if (!sameAnalyticsCaptureSubject(parseAnalyticsCaptureSubject(detail.captureSubject), captureSubject)) {
      throw new Error('Analytics detail subject does not match its envelope.');
    }
    if (deliveryId !== analyticsTransportDeliveryId(generationId, 'detail', sourceKey)) {
      throw new Error('Analytics detail delivery identity does not match its source identity.');
    }
    return {
      version: ANALYTICS_TRANSPORT_VERSION,
      kind,
      deliveryId,
      generationId,
      captureSubject,
      payloadId,
      sourceKey,
      byteLength,
      chunkCount,
      sha256,
      detail,
    };
  }
  if (kind === 'detail.chunk') {
    requireExactKeys(packet, [
      'version', 'kind', 'deliveryId', 'generationId', 'captureSubject', 'payloadId', 'index', 'data',
    ], 'analytics detail-chunk packet');
    const index = requireBoundedInteger(packet.index, 0, ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS - 1, 'chunk index');
    if (typeof packet.data !== 'string' || packet.data.length > Math.ceil(ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES / 3) * 4 + 4) {
      throw new Error('Analytics detail chunk data is invalid or oversized.');
    }
    const decoded = Buffer.from(packet.data, 'base64');
    if (decoded.toString('base64') !== packet.data || decoded.byteLength > ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES) {
      throw new Error('Analytics detail chunk is not canonical bounded base64.');
    }
    return {
      version: ANALYTICS_TRANSPORT_VERSION,
      kind,
      deliveryId,
      generationId,
      captureSubject,
      payloadId,
      index,
      data: packet.data,
    };
  }
  if (kind === 'detail.abort') {
    requireExactKeys(packet, [
      'version', 'kind', 'deliveryId', 'generationId', 'captureSubject', 'payloadId', 'code', 'message',
    ], 'analytics detail-abort packet');
    return {
      version: ANALYTICS_TRANSPORT_VERSION,
      kind,
      deliveryId,
      generationId,
      captureSubject,
      payloadId,
      code: requireId(packet.code, 'detail abort code'),
      message: requireBoundedMessage(packet.message, 'detail abort message'),
    };
  }
  requireExactKeys(packet, [
    'version', 'kind', 'deliveryId', 'generationId', 'captureSubject', 'payloadId', 'chunkCount', 'sha256',
  ], 'analytics detail-end packet');
  const chunkCount = requireBoundedInteger(packet.chunkCount, 1, ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS, 'chunkCount');
  const sha256 = requireSha256(packet.sha256);
  return {
    version: ANALYTICS_TRANSPORT_VERSION,
    kind,
    deliveryId,
    generationId,
    captureSubject,
    payloadId,
    chunkCount,
    sha256,
  };
}

export function parseAnalyticsTransportIngressEnvelope(value: unknown): AnalyticsTransportIngressEnvelope {
  const envelope = requireRecord(value, 'analytics ingress envelope');
  requireExactKeys(envelope, ['route', 'packet'], 'analytics ingress envelope');
  return {
    route: parseAnalyticsTransportRoute(envelope.route),
    packet: parseAnalyticsTransportPacket(envelope.packet),
  };
}

export function parseAnalyticsTransportRoute(value: unknown): AnalyticsTransportRoute {
  const route = requireRecord(value, 'analytics transport route');
  requireExactKeys(route, [
    'coordinatorGeneration', 'workerId', 'workerGeneration', 'workerPid',
    'rootSessionPath', 'leasePath', 'leaseRevision',
  ], 'analytics transport route');
  return {
    coordinatorGeneration: requireBoundedInteger(route.coordinatorGeneration, 1, Number.MAX_SAFE_INTEGER, 'coordinatorGeneration'),
    workerId: requireId(route.workerId, 'workerId'),
    workerGeneration: requireBoundedInteger(route.workerGeneration, 1, Number.MAX_SAFE_INTEGER, 'workerGeneration'),
    workerPid: requireBoundedInteger(route.workerPid, 1, Number.MAX_SAFE_INTEGER, 'workerPid'),
    rootSessionPath: requirePath(route.rootSessionPath, 'rootSessionPath'),
    leasePath: requirePath(route.leasePath, 'leasePath'),
    leaseRevision: requireBoundedInteger(route.leaseRevision, 1, Number.MAX_SAFE_INTEGER, 'leaseRevision'),
  };
}

export function parseAnalyticsTransportAcknowledgement(value: unknown): AnalyticsTransportAcknowledgement {
  const acknowledgement = requireRecord(value, 'analytics acknowledgement');
  requireExactKeys(acknowledgement, [
    'version', 'deliveryId', 'generationId', 'status', 'producerReconciliation',
    'completeDetailPayloadId', 'code', 'message',
  ], 'analytics acknowledgement');
  if (acknowledgement.version !== ANALYTICS_TRANSPORT_VERSION) throw new Error('Analytics acknowledgement version is unsupported.');
  const deliveryId = requireId(acknowledgement.deliveryId, 'deliveryId');
  const generationId = requireId(acknowledgement.generationId, 'generationId');
  const status = acknowledgement.status;
  if (status !== 'durable' && status !== 'rejected') {
    throw new Error('Analytics acknowledgement status is invalid.');
  }
  const completeDetailPayloadId = acknowledgement.completeDetailPayloadId === undefined
    ? undefined : requireId(acknowledgement.completeDetailPayloadId, 'completeDetailPayloadId');
  const code = acknowledgement.code === undefined ? undefined : requireId(acknowledgement.code, 'code');
  const rawMessage = acknowledgement.message;
  let message: string | undefined;
  if (rawMessage !== undefined) {
    if (typeof rawMessage !== 'string' || Buffer.byteLength(rawMessage) > 2_048) {
      throw new Error('Analytics acknowledgement message is invalid.');
    }
    message = rawMessage;
  }
  const rawReconciliation = acknowledgement.producerReconciliation;
  let reconciliation: AnalyticsTransportProducerReconciliation[] | undefined;
  if (rawReconciliation !== undefined) {
    if (!Array.isArray(rawReconciliation) || rawReconciliation.length > 256) throw new Error('Analytics acknowledgement reconciliation is invalid.');
    reconciliation = rawReconciliation.map(validateProducerReconciliation);
    if (new Set(reconciliation.map((entry) => entry.producerIdentity)).size !== reconciliation.length) {
      throw new Error('Analytics acknowledgement reconciliation contains duplicate producer identities.');
    }
  }
  if (status === 'durable') {
    if (code !== undefined || message !== undefined) {
      throw new Error('Durable analytics acknowledgement must not contain rejection fields.');
    }
    if (reconciliation !== undefined && completeDetailPayloadId !== undefined) {
      throw new Error('Durable analytics acknowledgement cannot combine fact and detail dispositions.');
    }
  } else if (code === undefined || message === undefined
      || reconciliation !== undefined || completeDetailPayloadId !== undefined) {
    throw new Error('Rejected analytics acknowledgement must contain only rejection fields.');
  }
  return {
    version: ANALYTICS_TRANSPORT_VERSION,
    deliveryId,
    generationId,
    status,
    ...(reconciliation === undefined ? {} : { producerReconciliation: reconciliation }),
    ...(completeDetailPayloadId === undefined ? {} : { completeDetailPayloadId }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

function parseAnalyticsDetailMetadata(value: unknown): Omit<AnalyticsDetailCapture, 'bytes'> {
  const detail = requireRecord(value, 'detail');
  requireExactKeys(detail, [
    'schemaVersion', 'generationId', 'stableOriginId', 'producerKind', 'producer',
    'payloadId', 'sourceKey', 'observedAtMs', 'captureSubject', 'mediaType',
    'encoding', 'complete', 'metadata',
  ], 'analytics detail metadata');
  if ('bytes' in detail) throw new Error('Analytics detail start must not contain bytes.');
  const schemaVersion = requireBoundedInteger(detail.schemaVersion, 1, Number.MAX_SAFE_INTEGER, 'detail.schemaVersion');
  const generationId = requireId(detail.generationId, 'detail.generationId');
  const payloadId = requireId(detail.payloadId, 'detail.payloadId');
  const sourceKey = requireId(detail.sourceKey, 'detail.sourceKey');
  const observedAtMs = requireInt64(detail.observedAtMs, 'detail.observedAtMs');
  if (detail.mediaType !== 'application/x-pie-subagent-result' && detail.mediaType !== 'application/x-pie-tool-observation') {
    throw new Error('Analytics detail mediaType is unsupported.');
  }
  if (detail.encoding !== 'node-v8' || detail.complete !== true) throw new Error('Analytics detail capture is incomplete or unsupported.');
  const metadata = requireRecord(detail.metadata, 'detail.metadata');
  requireExactKeys(metadata, [
    'childId', 'attemptId', 'parentToolCallId', 'outcome', 'captureStage', 'sourceVersion',
  ], 'analytics detail metadata fields');
  for (const key of Object.keys(metadata)) requireId(metadata[key], `detail.metadata.${key}`);
  const parsedMetadata: AnalyticsDetailCapture['metadata'] = {
    ...(metadata.childId === undefined ? {} : { childId: requireId(metadata.childId, 'detail.metadata.childId') }),
    ...(metadata.attemptId === undefined ? {} : { attemptId: requireId(metadata.attemptId, 'detail.metadata.attemptId') }),
    ...(metadata.parentToolCallId === undefined ? {} : { parentToolCallId: requireId(metadata.parentToolCallId, 'detail.metadata.parentToolCallId') }),
    ...(metadata.outcome === undefined ? {} : { outcome: requireId(metadata.outcome, 'detail.metadata.outcome') }),
    ...(metadata.captureStage === undefined ? {} : { captureStage: requireId(metadata.captureStage, 'detail.metadata.captureStage') }),
    ...(metadata.sourceVersion === undefined ? {} : { sourceVersion: requireId(metadata.sourceVersion, 'detail.metadata.sourceVersion') }),
  };
  let producer: AnalyticsDetailCapture['producer'];
  if (detail.producer !== undefined) {
    const rawProducer = requireRecord(detail.producer, 'detail.producer');
    requireExactKeys(rawProducer, ['buildId', 'processId', 'processGeneration'], 'detail.producer');
    const buildId = requireId(rawProducer.buildId, 'detail.producer.buildId');
    const rawProcessId = rawProducer.processId;
    let processId: string | number | undefined;
    if (typeof rawProcessId === 'string') processId = requireId(rawProcessId, 'detail.producer.processId');
    else if (typeof rawProcessId === 'number' && Number.isSafeInteger(rawProcessId)) processId = rawProcessId;
    else if (rawProcessId !== undefined) throw new Error('detail.producer.processId is invalid.');
    const processGeneration = rawProducer.processGeneration === undefined
      ? undefined : requireId(rawProducer.processGeneration, 'detail.producer.processGeneration');
    producer = { buildId, ...(processId === undefined ? {} : { processId }), ...(processGeneration ? { processGeneration } : {}) };
  }
  const stableOriginId = detail.stableOriginId === undefined ? undefined : requireId(detail.stableOriginId, 'detail.stableOriginId');
  const producerKind = detail.producerKind === undefined ? undefined : requireId(detail.producerKind, 'detail.producerKind');
  return {
    schemaVersion,
    generationId,
    ...(stableOriginId ? { stableOriginId } : {}),
    ...(producerKind ? { producerKind } : {}),
    ...(producer ? { producer } : {}),
    payloadId,
    sourceKey,
    observedAtMs,
    captureSubject: parseAnalyticsCaptureSubject(detail.captureSubject),
    mediaType: detail.mediaType,
    encoding: detail.encoding,
    complete: true,
    metadata: parsedMetadata,
  };
}

function requireJsonByteBound(value: unknown, limit: number, name: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${name} is not serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > limit) throw new Error(`${name} exceeds the ${limit}-byte transport bound.`);
}

function requireBoundedMessage(value: unknown, name: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 2_048) {
    throw new Error(`${name} must be a bounded string.`);
  }
  return value;
}

function normalizeJsonValue(value: unknown, name: string): Record<string, unknown> {
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error(`${name} is structurally too complex.`);
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`${name} contains a non-finite number.`);
      return current;
    }
    if (typeof current === 'bigint') return current.toString();
    if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));
    if (typeof current !== 'object' || ArrayBuffer.isView(current) || current instanceof ArrayBuffer) {
      throw new Error(`${name} contains a non-JSON value.`);
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(current)) {
      if (key === '__proto__') throw new Error(`${name} contains an unsafe object key.`);
      result[key] = visit(entry, depth + 1);
    }
    return result;
  };
  return requireRecord(visit(value, 0), name);
}

export function parseAnalyticsCaptureSubject(value: unknown): AnalyticsCaptureSubject {
  const subject = requireRecord(value, 'captureSubject');
  if (subject.kind === 'session') {
    requireExactKeys(subject, ['kind', 'rootSessionId'], 'session captureSubject');
    return { kind: 'session', rootSessionId: requireId(subject.rootSessionId, 'rootSessionId') };
  }
  if (subject.kind === 'pendingCreate') {
    requireExactKeys(subject, ['kind', 'operationId'], 'pending-create captureSubject');
    return { kind: 'pendingCreate', operationId: requireId(subject.operationId, 'operationId') };
  }
  if (subject.kind === 'host') {
    requireExactKeys(subject, ['kind', 'hostId'], 'host captureSubject');
    return { kind: 'host', hostId: requireId(subject.hostId, 'hostId') };
  }
  throw new Error('Analytics capture subject kind is invalid.');
}

function validateProducerReconciliation(value: unknown): AnalyticsTransportProducerReconciliation {
  const entry = requireRecord(value, 'producer reconciliation');
  requireExactKeys(entry, [
    'producerIdentity', 'contiguousWatermark', 'highestObservedSequence', 'visibleGaps', 'pendingReceiptCount',
  ], 'producer reconciliation');
  const producerIdentity = requireId(entry.producerIdentity, 'producerIdentity');
  const contiguousWatermark = requireInt64(entry.contiguousWatermark, 'contiguousWatermark');
  const highestObservedSequence = requireInt64(entry.highestObservedSequence, 'highestObservedSequence');
  const contiguous = parseInt64(contiguousWatermark, 'contiguousWatermark');
  const highest = parseInt64(highestObservedSequence, 'highestObservedSequence');
  if (contiguous < 0n || highest < contiguous) throw new Error('Producer reconciliation watermarks are inconsistent.');
  const pendingReceiptCount = requireBoundedInteger(
    entry.pendingReceiptCount,
    0,
    MAX_PRODUCER_RECONCILIATION_GAPS,
    'pendingReceiptCount',
  );
  if (!Array.isArray(entry.visibleGaps) || entry.visibleGaps.length > MAX_PRODUCER_RECONCILIATION_GAPS) {
    throw new Error('Producer reconciliation gaps are invalid.');
  }
  let previousGapEnd = contiguous;
  let missingSequenceCount = 0n;
  const visibleGaps = entry.visibleGaps.map((gap) => {
    const record = requireRecord(gap, 'producer reconciliation gap');
    requireExactKeys(record, ['from', 'to'], 'producer reconciliation gap');
    const from = requireInt64(record.from, 'gap.from');
    const to = requireInt64(record.to, 'gap.to');
    const parsedFrom = parseInt64(from, 'gap.from');
    const parsedTo = parseInt64(to, 'gap.to');
    if (parsedFrom <= previousGapEnd || parsedTo < parsedFrom || parsedTo > highest) {
      throw new Error('Producer reconciliation gaps are inconsistent or unordered.');
    }
    previousGapEnd = parsedTo;
    missingSequenceCount += parsedTo - parsedFrom + 1n;
    return { from, to };
  });
  if (highest - contiguous - missingSequenceCount !== BigInt(pendingReceiptCount)) {
    throw new Error('Producer reconciliation pending count is inconsistent with its watermarks and gaps.');
  }
  return { producerIdentity, contiguousWatermark, highestObservedSequence, visibleGaps, pendingReceiptCount };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !accepted.has(key));
  if (unexpected) throw new Error(`${name} contains unsupported field ${unexpected}.`);
}

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES) {
    throw new Error(`${name} must be a bounded non-empty string without NUL.`);
  }
  return value;
}

function requirePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new Error(`${name} must be a bounded non-empty path without NUL.`);
  }
  return value;
}

function requireBoundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be a bounded safe integer.`);
  }
  return Number(value);
}

function requireSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('Analytics sha256 is invalid.');
  return value;
}

function requireInt64(value: unknown, name: string): number | string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${name} must be a safe integer or canonical decimal string.`);
  }
  parseInt64(value, name);
  return value;
}
