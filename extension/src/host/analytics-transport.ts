import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { AnalyticsDetailCapture, AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import {
  ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES,
  ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES,
  ANALYTICS_TRANSPORT_VERSION,
  analyticsProducerIdentity,
  parseAnalyticsTransportAcknowledgement,
  parseAnalyticsTransportIngressEnvelope,
  sameAnalyticsCaptureSubject,
  type AnalyticsTransportAcknowledgement,
  type AnalyticsTransportDetailStartPacket,
  type AnalyticsTransportIngressEnvelope,
  type AnalyticsTransportProducerReconciliation,
} from '../../../shared/analytics/transport.js';
import {
  AnalyticsCaptureCapacityError,
  type AnalyticsRecorderCaptureDisposition,
} from '../analytics/recorder-supervisor.js';
import type { EventEnvelope } from '../shared/protocol.js';

export interface AnalyticsTransportBackend {
  getGeneration(): number;
  onEvent(listener: (event: EventEnvelope) => void): { dispose(): void };
  onExit(listener: () => void): { dispose(): void };
  request<Result = unknown>(method: string, params?: unknown): Promise<Result>;
}

export interface HostAnalyticsTransportOptions {
  generationId: string;
  /** Expected producer identity for this host/backend authority. Optional for
   * compatibility with protocol-only tests; production always supplies both. */
  buildId?: string;
  workspaceId?: string;
  backend: AnalyticsTransportBackend;
  recorder: HostAnalyticsRecorder;
  maxPendingDetails?: number;
  maxPendingDetailBytes?: number;
  onError?: (error: Error) => void;
}

export interface HostAnalyticsRecorder {
  submitTracked(
    observation: AnalyticsObservation<object>,
    onDisposition: (disposition: AnalyticsRecorderCaptureDisposition) => void,
  ): void;
  submitTrackedDetail(
    capture: AnalyticsDetailCapture,
    onDisposition: (disposition: AnalyticsRecorderCaptureDisposition) => void,
  ): void;
}

interface PendingDetail {
  start: AnalyticsTransportDetailStartPacket;
  route: AnalyticsTransportIngressEnvelope['route'];
  chunks: Map<number, Buffer>;
  receivedBytes: number;
}

interface AnalyticsAcknowledgementTarget {
  route: AnalyticsTransportIngressEnvelope['route'];
  deliveryId: string;
  generationId: string;
  producerIdentity?: string;
  payloadId?: string;
}

interface PendingRecorderOwnership {
  target: AnalyticsAcknowledgementTarget;
  settled: boolean;
  ignoreLate: boolean;
  settlement: Promise<void>;
  resolve: () => void;
}

/** Host-owned bounded ingress. It takes synchronous recorder ownership before
 * returning from an event callback and sends only recorder-durable per-record
 * dispositions back to the exact worker route. */
export class HostAnalyticsTransport implements Disposable {
  private readonly pendingDetails = new Map<string, PendingDetail>();
  private readonly subscriptions: Array<{ dispose(): void }>;
  private pendingDetailBytes = 0;
  private disposed = false;
  private shuttingDown = false;
  private backendAvailable = true;
  private readonly pendingAcknowledgements = new Set<Promise<unknown>>();
  private readonly pendingRecorderOwnership = new Set<PendingRecorderOwnership>();
  private shutdownPromise?: Promise<void>;
  private shutdownDeadline?: number;
  private readonly maxPendingDetails: number;
  private readonly maxPendingDetailBytes: number;

  constructor(private readonly options: HostAnalyticsTransportOptions) {
    this.maxPendingDetails = options.maxPendingDetails ?? 64;
    this.maxPendingDetailBytes = options.maxPendingDetailBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxPendingDetails) || this.maxPendingDetails < 1
        || !Number.isSafeInteger(this.maxPendingDetailBytes) || this.maxPendingDetailBytes < 1
        || this.maxPendingDetailBytes > ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES * this.maxPendingDetails) {
      throw new Error('Analytics detail assembly limits are invalid.');
    }
    this.subscriptions = [
      options.backend.onEvent((event) => {
        // BackendClient retains this transport across coordinator restarts.
        // Re-arm ingress only at the replacement generation's ready boundary;
        // captures from a dead generation remain dropped and cannot receive a
        // late ACK.
        if (event.event === 'backend.ready') {
          this.backendAvailable = true;
          return;
        }
        if (event.event !== 'analytics.capture') return;
        this.receive(event.payload);
      }),
      options.backend.onExit(() => {
        this.backendAvailable = false;
        this.clearPendingDetails();
        this.invalidateRecorderOwnership();
      }),
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shuttingDown = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.clearPendingDetails();
    this.invalidateRecorderOwnership();
  }

  /** Stop admitting backend ingress and give every partially assembled detail
   * an explicit terminal result while the backend channel is still available.
   * The bounded wait covers a wedged request channel; disposal then releases all
   * subscriptions and late recorder dispositions cannot send acknowledgements. */
  async shutdown(timeoutMs = 2_000): Promise<void> {
    if (this.disposed) return;
    if (!this.shutdownPromise) {
      const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 2_000;
      const operation = this.shutdownOnce(boundedTimeout);
      const tracked = operation.finally(() => {
        if (this.shutdownPromise === tracked) this.shutdownPromise = undefined;
      });
      this.shutdownPromise = tracked;
    }
    await this.shutdownPromise;
  }

  private async shutdownOnce(timeoutMs: number): Promise<void> {
    this.shuttingDown = true;
    const deadline = Date.now() + timeoutMs;
    this.shutdownDeadline = deadline;
    for (const [deliveryId, pending] of [...this.pendingDetails]) {
      const envelope: AnalyticsTransportIngressEnvelope = {
        route: pending.route,
        packet: pending.start,
      };
      this.dropPendingDetail(deliveryId);
      this.reject(envelope, 'transport_shutdown', new Error('Analytics transport closed before detail assembly completed.'));
    }

    await this.waitForRecorderOwnership(deadline);
    // A recorder that did not return a disposition by the bounded shutdown
    // deadline cannot be allowed to create a late ACK against a stopped
    // backend. Give its producer an explicit terminal rejection while the
    // backend channel is still available, then make later callbacks no-ops.
    for (const ownership of [...this.pendingRecorderOwnership]) {
      this.terminalizeRecorderOwnership(ownership);
    }
    await this.waitForAcknowledgements(deadline);
    this.shutdownDeadline = undefined;
  }

  private async waitForRecorderOwnership(deadline: number): Promise<void> {
    while (this.pendingRecorderOwnership.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      await Promise.race([
        Promise.allSettled([...this.pendingRecorderOwnership].map((ownership) => ownership.settlement)),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
      ]);
    }
  }

  private async waitForAcknowledgements(deadline: number): Promise<void> {
    while (this.pendingAcknowledgements.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      await Promise.race([
        Promise.allSettled([...this.pendingAcknowledgements]),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
      ]);
    }
  }

  get assemblyBacklog(): Readonly<{ records: number; bytes: number }> {
    return { records: this.pendingDetails.size, bytes: this.pendingDetailBytes };
  }

  /** Fence unfinished rich payloads before the recorder's private deletion
   * marker is committed. Late chunks cannot cross this subject boundary. */
  fenceCaptureSubject(subject: AnalyticsDetailCapture['captureSubject']): void {
    for (const [deliveryId, pending] of this.pendingDetails) {
      if (!sameAnalyticsCaptureSubject(pending.start.captureSubject, subject)) continue;
      const envelope: AnalyticsTransportIngressEnvelope = {
        route: pending.route,
        packet: pending.start,
      };
      this.dropPendingDetail(deliveryId);
      this.reject(envelope, 'subject_deleted', new Error('Analytics detail capture subject was deleted.'));
    }
  }

  /** Public for focused protocol tests; production enters through onEvent. */
  receive(value: unknown): void {
    if (this.disposed || this.shuttingDown) return;
    let envelope: AnalyticsTransportIngressEnvelope;
    try {
      envelope = parseAnalyticsTransportIngressEnvelope(value);
      if (envelope.route.coordinatorGeneration !== this.options.backend.getGeneration()) {
        throw new Error('Analytics ingress belongs to a stale backend generation.');
      }
      if (envelope.packet.generationId !== this.options.generationId) {
        throw new Error('Analytics ingress belongs to a stale analytics generation.');
      }
      switch (envelope.packet.kind) {
        case 'fact': this.receiveFact(envelope); break;
        case 'detail.start': this.receiveDetailStart(envelope); break;
        case 'detail.chunk': this.receiveDetailChunk(envelope); break;
        case 'detail.end': this.receiveDetailEnd(envelope); break;
        case 'detail.abort': this.receiveDetailAbort(envelope); break;
      }
    } catch (error) {
      this.report(error);
    }
  }

  private receiveFact(envelope: AnalyticsTransportIngressEnvelope): void {
    if (envelope.packet.kind !== 'fact') return;
    const observation: AnalyticsObservation<object> = envelope.packet.observation;
    const target = this.acknowledgementTarget(envelope, observation.stableOriginId
      ? analyticsProducerIdentity(observation.generationId, observation.producerKind, observation.stableOriginId)
      : undefined);
    const ownership = this.trackRecorderOwnership(target);
    try {
      this.assertProducerIdentity(observation.producer.buildId, observation.scope.workspaceCoverage === 'known'
        ? observation.scope.workspaceId : undefined, true);
      this.options.recorder.submitTracked(observation, (disposition) => {
        this.settleRecorderOwnership(ownership, this.factAcknowledgement(target, disposition));
      });
    } catch (error) {
      if (!ownership.settled) {
        this.cancelRecorderOwnership(ownership);
        this.reject(envelope, this.captureRejectionCode(error), error);
      }
    }
  }

  private receiveDetailStart(envelope: AnalyticsTransportIngressEnvelope): void {
    if (envelope.packet.kind !== 'detail.start') return;
    const packet = envelope.packet;
    try {
      this.assertProducerIdentity(packet.detail.producer?.buildId, undefined, false);
    } catch (error) {
      this.reject(envelope, 'producer_identity', error);
      return;
    }
    const existing = this.pendingDetails.get(packet.deliveryId);
    if (existing) {
      if (!this.sameRoute(existing.route, envelope.route)) {
        this.reject(envelope, 'detail_route', new Error('Analytics detail start belongs to a stale worker route.'));
        return;
      }
      if (isDeepStrictEqual(existing.start, packet)
          && this.sameDetailEnvelope(existing, envelope)) return;
      this.reject(envelope, 'detail_conflict', new Error('Analytics detail start changed during redelivery.'));
      return;
    }
    if (this.pendingDetails.size >= this.maxPendingDetails
        || this.pendingDetailBytes + packet.byteLength > this.maxPendingDetailBytes) {
      this.reject(envelope, 'detail_capacity', new Error('Analytics detail assembly capacity exceeded.'));
      return;
    }
    this.pendingDetails.set(packet.deliveryId, {
      start: packet,
      route: envelope.route,
      chunks: new Map(),
      receivedBytes: 0,
    });
    this.pendingDetailBytes += packet.byteLength;
  }

  private receiveDetailChunk(envelope: AnalyticsTransportIngressEnvelope): void {
    if (envelope.packet.kind !== 'detail.chunk') return;
    const packet = envelope.packet;
    const pending = this.pendingDetails.get(packet.deliveryId);
    if (!pending || !this.sameDetailEnvelope(pending, envelope) || packet.index >= pending.start.chunkCount) {
      this.reject(envelope, 'detail_sequence', new Error('Analytics detail chunk has no matching bounded start.'));
      return;
    }
    const decoded = Buffer.from(packet.data, 'base64');
    const existing = pending.chunks.get(packet.index);
    if (existing) {
      if (existing.equals(decoded)) return;
      this.reject(envelope, 'detail_conflict', new Error('Analytics detail chunk changed during redelivery.'));
      return;
    }
    const expectedBytes = packet.index === pending.start.chunkCount - 1
      ? pending.start.byteLength - packet.index * ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES
      : ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES;
    if (decoded.byteLength !== expectedBytes) {
      this.reject(envelope, 'detail_length', new Error('Analytics detail chunk length does not match its start.'));
      return;
    }
    pending.chunks.set(packet.index, decoded);
    pending.receivedBytes += decoded.byteLength;
    if (pending.receivedBytes > pending.start.byteLength) {
      this.dropPendingDetail(packet.deliveryId);
      this.reject(envelope, 'detail_length', new Error('Analytics detail chunks exceed their declared byte length.'));
    }
  }

  private receiveDetailEnd(envelope: AnalyticsTransportIngressEnvelope): void {
    if (envelope.packet.kind !== 'detail.end') return;
    const packet = envelope.packet;
    const pending = this.pendingDetails.get(packet.deliveryId);
    if (pending && !this.sameRoute(pending.route, envelope.route)) {
      this.reject(envelope, 'detail_route', new Error('Analytics detail end belongs to a stale worker route.'));
      return;
    }
    if (!pending) {
      this.reject(envelope, 'detail_incomplete', new Error('Analytics detail end has no matching bounded assembly.'));
      return;
    }
    if (!this.sameDetailEnvelope(pending, envelope)
        || packet.chunkCount !== pending.start.chunkCount || packet.sha256 !== pending.start.sha256) {
      this.reject(envelope, 'detail_conflict', new Error('Analytics detail end changed during redelivery.'));
      return;
    }
    if (pending.chunks.size !== pending.start.chunkCount || pending.receivedBytes !== pending.start.byteLength) {
      this.dropPendingDetail(packet.deliveryId);
      this.reject(envelope, 'detail_incomplete', new Error('Analytics detail end does not match a complete bounded assembly.'));
      return;
    }
    const bytes = Buffer.concat(Array.from(
      { length: pending.start.chunkCount },
      (_unused, index) => pending.chunks.get(index)!,
    ));
    if (createHash('sha256').update(bytes).digest('hex') !== pending.start.sha256) {
      this.dropPendingDetail(packet.deliveryId);
      this.reject(envelope, 'detail_hash', new Error('Analytics detail content hash does not match its start.'));
      return;
    }
    this.dropPendingDetail(packet.deliveryId);
    const capture: AnalyticsDetailCapture = { ...pending.start.detail, bytes };
    const target = this.acknowledgementTarget(envelope, undefined, pending.start.payloadId);
    const ownership = this.trackRecorderOwnership(target);
    try {
      this.options.recorder.submitTrackedDetail(capture, (disposition) => {
        this.settleRecorderOwnership(ownership, this.detailAcknowledgement(target, disposition));
      });
    } catch (error) {
      if (!ownership.settled) {
        this.cancelRecorderOwnership(ownership);
        this.reject(envelope, this.captureRejectionCode(error), error);
      }
    }
  }

  private receiveDetailAbort(envelope: AnalyticsTransportIngressEnvelope): void {
    if (envelope.packet.kind !== 'detail.abort') return;
    const pending = this.pendingDetails.get(envelope.packet.deliveryId);
    if (pending) {
      if (!this.sameDetailEnvelope(pending, envelope)) {
        this.reject(envelope, 'detail_conflict', new Error('Analytics detail abort changed during delivery.'));
        return;
      }
      this.dropPendingDetail(envelope.packet.deliveryId);
    }
    this.reject(envelope, envelope.packet.code, new Error(envelope.packet.message));
  }

  private sameDetailEnvelope(pending: PendingDetail, envelope: AnalyticsTransportIngressEnvelope): boolean {
    const { start, route } = pending;
    const packet = envelope.packet;
    return packet.deliveryId === start.deliveryId
      && packet.generationId === start.generationId
      && 'payloadId' in packet && packet.payloadId === start.payloadId
      && sameAnalyticsCaptureSubject(packet.captureSubject, start.captureSubject)
      && this.sameRoute(route, envelope.route);
  }

  private sameRoute(
    left: AnalyticsTransportIngressEnvelope['route'],
    right: AnalyticsTransportIngressEnvelope['route'],
  ): boolean {
    return left.coordinatorGeneration === right.coordinatorGeneration
      && left.workerId === right.workerId
      && left.workerGeneration === right.workerGeneration
      && left.workerPid === right.workerPid
      && left.rootSessionPath === right.rootSessionPath
      && left.leasePath === right.leasePath
      && left.leaseRevision === right.leaseRevision;
  }

  private factAcknowledgement(
    target: AnalyticsAcknowledgementTarget,
    disposition: AnalyticsRecorderCaptureDisposition,
  ): AnalyticsTransportAcknowledgement {
    if (disposition.status !== 'durable') {
      return this.rejectedAcknowledgement(target, disposition.code, disposition.message);
    }
    const exact = target.producerIdentity
      ? disposition.producerReconciliation.find((entry) => entry.producerIdentity === target.producerIdentity)
      : undefined;
    return this.durableAcknowledgement(target, exact ? [exact] : []);
  }

  private detailAcknowledgement(
    target: AnalyticsAcknowledgementTarget,
    disposition: AnalyticsRecorderCaptureDisposition,
  ): AnalyticsTransportAcknowledgement {
    if (disposition.status !== 'durable') {
      return this.rejectedAcknowledgement(target, disposition.code, disposition.message);
    }
    if (!target.payloadId) throw new Error('Analytics detail acknowledgement is missing its payload identity.');
    return { ...this.durableAcknowledgement(target), completeDetailPayloadId: target.payloadId };
  }

  private durableAcknowledgement(
    target: AnalyticsAcknowledgementTarget,
    producerReconciliation?: AnalyticsTransportProducerReconciliation[],
  ): AnalyticsTransportAcknowledgement {
    return {
      version: ANALYTICS_TRANSPORT_VERSION,
      deliveryId: target.deliveryId,
      generationId: target.generationId,
      status: 'durable',
      ...(producerReconciliation ? { producerReconciliation } : {}),
    };
  }

  private rejectedAcknowledgement(
    target: AnalyticsAcknowledgementTarget,
    code: string,
    message: string,
  ): AnalyticsTransportAcknowledgement {
    return {
      version: ANALYTICS_TRANSPORT_VERSION,
      deliveryId: target.deliveryId,
      generationId: target.generationId,
      status: 'rejected',
      code,
      message: truncateUtf8(message, 2_048),
    };
  }

  private reject(envelope: AnalyticsTransportIngressEnvelope, code: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const target = this.acknowledgementTarget(envelope);
    this.acknowledge(target, this.rejectedAcknowledgement(target, code, message));
    this.report(error);
  }

  private acknowledge(target: AnalyticsAcknowledgementTarget, acknowledgement: AnalyticsTransportAcknowledgement): void {
    if (this.disposed || !this.backendAvailable
        || target.route.coordinatorGeneration !== this.options.backend.getGeneration()) return;
    let boundedAcknowledgement: AnalyticsTransportAcknowledgement;
    try {
      boundedAcknowledgement = parseAnalyticsTransportAcknowledgement(acknowledgement);
    } catch (error) {
      this.report(error);
      return;
    }
    let request: Promise<unknown>;
    try {
      request = this.options.backend.request('analytics.ack', { route: target.route, acknowledgement: boundedAcknowledgement });
    } catch (error) {
      this.report(error);
      return;
    }
    this.pendingAcknowledgements.add(request);
    void request.catch((error) => {
      this.report(error);
    }).finally(() => {
      this.pendingAcknowledgements.delete(request);
    });
  }

  private acknowledgementTarget(
    envelope: AnalyticsTransportIngressEnvelope,
    producerIdentity?: string,
    payloadId?: string,
  ): AnalyticsAcknowledgementTarget {
    return {
      route: { ...envelope.route },
      deliveryId: envelope.packet.deliveryId,
      generationId: envelope.packet.generationId,
      ...(producerIdentity ? { producerIdentity } : {}),
      ...(payloadId ? { payloadId } : {}),
    };
  }

  private dropPendingDetail(deliveryId: string): void {
    const pending = this.pendingDetails.get(deliveryId);
    if (!pending) return;
    this.pendingDetails.delete(deliveryId);
    this.pendingDetailBytes = Math.max(0, this.pendingDetailBytes - pending.start.byteLength);
  }

  private trackRecorderOwnership(target: AnalyticsAcknowledgementTarget): PendingRecorderOwnership {
    let resolve!: () => void;
    const ownership: PendingRecorderOwnership = {
      target,
      settled: false,
      ignoreLate: false,
      settlement: new Promise<void>((resolveSettlement) => { resolve = resolveSettlement; }),
      resolve: () => resolve(),
    };
    this.pendingRecorderOwnership.add(ownership);
    return ownership;
  }

  private settleRecorderOwnership(ownership: PendingRecorderOwnership, acknowledgement: AnalyticsTransportAcknowledgement): void {
    if (ownership.settled) return;
    if (this.shutdownDeadline !== undefined && Date.now() >= this.shutdownDeadline) {
      this.terminalizeRecorderOwnership(ownership);
      return;
    }
    ownership.settled = true;
    this.pendingRecorderOwnership.delete(ownership);
    ownership.resolve();
    if (!ownership.ignoreLate) this.acknowledge(ownership.target, acknowledgement);
  }

  private cancelRecorderOwnership(ownership: PendingRecorderOwnership): void {
    if (ownership.settled) return;
    ownership.settled = true;
    ownership.ignoreLate = true;
    this.pendingRecorderOwnership.delete(ownership);
    ownership.resolve();
  }

  private terminalizeRecorderOwnership(ownership: PendingRecorderOwnership): void {
    if (ownership.settled) return;
    ownership.ignoreLate = true;
    ownership.settled = true;
    this.pendingRecorderOwnership.delete(ownership);
    ownership.resolve();
    this.acknowledge(
      ownership.target,
      this.rejectedAcknowledgement(
        ownership.target,
        'transport_shutdown',
        'Analytics transport closed before recorder disposition completed.',
      ),
    );
  }

  private invalidateRecorderOwnership(): void {
    for (const ownership of [...this.pendingRecorderOwnership]) this.cancelRecorderOwnership(ownership);
  }

  private clearPendingDetails(): void {
    this.pendingDetails.clear();
    this.pendingDetailBytes = 0;
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private captureRejectionCode(error: unknown): string {
    if (error instanceof AnalyticsProducerIdentityError) return 'producer_identity';
    return error instanceof AnalyticsCaptureCapacityError ? 'capture_capacity' : 'capture_submission';
  }

  private assertProducerIdentity(buildId: string | undefined, workspaceId: string | undefined, requireWorkspace: boolean): void {
    if (this.options.buildId !== undefined && buildId !== this.options.buildId) {
      throw new AnalyticsProducerIdentityError('Analytics producer build does not match the active host build.');
    }
    if (requireWorkspace && this.options.workspaceId !== undefined && workspaceId !== this.options.workspaceId) {
      throw new AnalyticsProducerIdentityError('Analytics producer workspace does not match the active host workspace.');
    }
  }
}

class AnalyticsProducerIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsProducerIdentityError';
  }
}

interface Disposable {
  dispose(): void;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
