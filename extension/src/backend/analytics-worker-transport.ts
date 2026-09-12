import type {
  AnalyticsCaptureSubject,
  AnalyticsDetailCapture,
  AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import {
  ANALYTICS_RUNTIME_BRIDGE_KEY,
  analyticsProducerIdentity,
  createAnalyticsDetailPackets,
  createAnalyticsDetailAbortPacket,
  createAnalyticsFactPacket,
  parseAnalyticsTransportAcknowledgement,
  sameAnalyticsCaptureSubject,
  type AnalyticsTransportPacket,
  type AnalyticsTransportDetailStartPacket,
  type InstalledAnalyticsRuntimeBridge,
} from '../../../shared/analytics/transport.js';

export interface WorkerAnalyticsActivation {
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  workspaceId?: string;
  buildId: string;
}

export interface AnalyticsWorkerTransportSender {
  sendAnalyticsFrame(
    packet: AnalyticsTransportPacket,
    onSettled?: (settlement: AnalyticsTransportFrameSettlement) => void,
  ): boolean;
  requestAnalyticsSubjectRebind(captureSubject: AnalyticsCaptureSubject): Promise<AnalyticsCaptureSubject>;
}

export type AnalyticsTransportFrameSettlement =
  | { status: 'sent' }
  | { status: 'rejected'; reason: string; detail: string }
  | { status: 'failed'; error: Error };

interface PendingDetailSend {
  packets: AnalyticsTransportPacket[];
  start: AnalyticsTransportDetailStartPacket;
  nextIndex: number;
  finished: boolean;
}

const MAX_ACKNOWLEDGEMENT_STATE = 8_192;

function greaterInt64(left: number | string, right: number | string | undefined): boolean {
  return right === undefined || BigInt(left) > BigInt(right);
}

/** Worker-local adapter installed on the process global so independently
 * loaded jiti copies of the subagent extension share one exact transport. */
export class AnalyticsWorkerTransport {
  private readonly factWatermarks = new Map<string, number | string>();
  private readonly completeDetails = new Set<string>();
  private readonly pendingDeliveries = new Map<string, {
    kind: 'fact' | 'detail'; payloadId?: string; bytes?: number; producerIdentity?: string;
    retainAcknowledgement: boolean;
  }>();
  private readonly factDeliveriesByProducer = new Map<string, Set<string>>();
  private readonly detailDeliveriesByPayload = new Map<string, string>();
  private readonly detailSendQueue: PendingDetailSend[] = [];
  private pendingDetailBytes = 0;
  private pumpingDetail = false;
  private readonly bridge: InstalledAnalyticsRuntimeBridge;
  private installed = false;
  private captureSubject: AnalyticsCaptureSubject;
  private captureSubjectState: 'active' | 'pending' | 'disabled' = 'active';
  private captureSubjectRevision = 0;

  constructor(
    private readonly sender: AnalyticsWorkerTransportSender,
    readonly activation: WorkerAnalyticsActivation,
    processGeneration: string,
  ) {
    this.captureSubject = activation.captureSubject;
    this.bridge = {
      generationId: activation.generationId,
      captureSubject: this.captureSubject,
      ...(activation.workspaceId ? { workspaceId: activation.workspaceId } : {}),
      producer: {
        buildId: activation.buildId,
        processId: process.pid,
        processGeneration,
      },
      submitObservation: (observation) => this.submitObservation(observation),
      submitDetail: (capture) => this.submitDetail(capture),
      readFactAcknowledgement: (generationId, stableOriginId) => {
        const key = analyticsProducerIdentity(generationId, 'subagent', stableOriginId);
        const value = this.factWatermarks.get(key);
        this.factWatermarks.delete(key);
        return value;
      },
      isDetailComplete: (payloadId) => this.completeDetails.delete(payloadId),
      releaseAcknowledgementInterest: (generationId, stableOriginId, payloadId) => {
        const producerIdentity = analyticsProducerIdentity(generationId, 'subagent', stableOriginId);
        this.factWatermarks.delete(producerIdentity);
        this.completeDetails.delete(payloadId);
        const factDeliveryIds = this.factDeliveriesByProducer.get(producerIdentity);
        for (const deliveryId of factDeliveryIds ?? []) {
          const factDelivery = this.pendingDeliveries.get(deliveryId);
          if (factDelivery?.kind === 'fact') factDelivery.retainAcknowledgement = false;
        }
        this.factDeliveriesByProducer.delete(producerIdentity);
        const detailDeliveryId = this.detailDeliveriesByPayload.get(payloadId);
        const detailDelivery = detailDeliveryId ? this.pendingDeliveries.get(detailDeliveryId) : undefined;
        if (detailDelivery?.kind === 'detail') detailDelivery.retainAcknowledgement = false;
        this.detailDeliveriesByPayload.delete(payloadId);
      },
    };
  }

  /** Queue an ordered coordinator transition without making ordinary session
   * replacement wait for analytics transport. Captures for the new subject
   * remain visibly unavailable until the exact acknowledgement arrives. */
  rebindCaptureSubject(captureSubject: AnalyticsCaptureSubject): void {
    if (!this.installed) return;
    const revision = ++this.captureSubjectRevision;
    this.captureSubject = captureSubject;
    this.bridge.captureSubject = captureSubject;
    this.captureSubjectState = 'pending';
    let request: Promise<AnalyticsCaptureSubject>;
    try {
      request = this.sender.requestAnalyticsSubjectRebind(captureSubject);
    } catch {
      this.captureSubjectState = 'disabled';
      return;
    }
    void request.then((acknowledged) => {
      if (!this.installed || this.captureSubjectRevision !== revision) return;
      this.captureSubjectState = sameAnalyticsCaptureSubject(acknowledged, captureSubject) ? 'active' : 'disabled';
    }, () => {
      if (!this.installed || this.captureSubjectRevision !== revision) return;
      this.captureSubjectState = 'disabled';
    });
  }

  disableCaptureSubject(): void {
    this.captureSubjectRevision += 1;
    this.captureSubjectState = 'disabled';
  }

  install(): void {
    const host = globalThis as unknown as Record<PropertyKey, unknown>;
    const current = host[ANALYTICS_RUNTIME_BRIDGE_KEY];
    if (current !== undefined && current !== this.bridge) {
      throw new Error('Another analytics runtime bridge already owns this worker process.');
    }
    host[ANALYTICS_RUNTIME_BRIDGE_KEY] = this.bridge;
    this.installed = true;
  }

  dispose(): void {
    if (!this.installed) return;
    const host = globalThis as unknown as Record<PropertyKey, unknown>;
    if (host[ANALYTICS_RUNTIME_BRIDGE_KEY] === this.bridge) delete host[ANALYTICS_RUNTIME_BRIDGE_KEY];
    this.installed = false;
    this.factWatermarks.clear();
    this.completeDetails.clear();
    this.pendingDeliveries.clear();
    this.factDeliveriesByProducer.clear();
    this.detailDeliveriesByPayload.clear();
    this.detailSendQueue.length = 0;
    this.pendingDetailBytes = 0;
    this.pumpingDetail = false;
    this.captureSubjectRevision += 1;
    this.captureSubjectState = 'disabled';
  }

  acknowledge(value: unknown): void {
    const acknowledgement = parseAnalyticsTransportAcknowledgement(value);
    if (acknowledgement.generationId !== this.activation.generationId) return;
    const pending = this.pendingDeliveries.get(acknowledgement.deliveryId);
    if (!pending) return;
    if (acknowledgement.status !== 'durable') {
      this.releasePendingDelivery(acknowledgement.deliveryId);
      return;
    }
    if (pending.kind === 'fact' && acknowledgement.completeDetailPayloadId !== undefined) return;
    if (pending.kind === 'fact' && acknowledgement.producerReconciliation?.some(
      (entry) => entry.producerIdentity !== pending.producerIdentity,
    )) return;
    if (pending.kind === 'detail' && acknowledgement.completeDetailPayloadId !== pending.payloadId) return;
    this.releasePendingDelivery(acknowledgement.deliveryId);
    if (pending.kind === 'fact' && pending.producerIdentity) {
      const entry = acknowledgement.producerReconciliation?.find((candidate) => candidate.producerIdentity === pending.producerIdentity);
      if (entry && pending.retainAcknowledgement) {
          const previous = this.factWatermarks.get(entry.producerIdentity);
          if (greaterInt64(entry.contiguousWatermark, previous)) {
            this.factWatermarks.set(entry.producerIdentity, entry.contiguousWatermark);
          }
      }
    }
    if (acknowledgement.completeDetailPayloadId && pending.retainAcknowledgement) {
      this.completeDetails.add(acknowledgement.completeDetailPayloadId);
    }
  }

  private submitObservation(observation: AnalyticsObservation<object>): void {
    this.assertCaptureEnvelope(observation.generationId, observation.captureSubject);
    this.assertProducerIdentity(observation.producer.buildId, observation.scope.workspaceCoverage === 'known'
      ? observation.scope.workspaceId : undefined);
    this.assertAcknowledgementCapacity();
    const packet = createAnalyticsFactPacket(observation);
    this.send(packet);
    const producerIdentity = observation.stableOriginId
      ? analyticsProducerIdentity(observation.generationId, observation.producerKind, observation.stableOriginId)
      : undefined;
    this.pendingDeliveries.set(packet.deliveryId, {
      kind: 'fact', retainAcknowledgement: true,
      ...(producerIdentity ? { producerIdentity } : {}),
    });
    if (producerIdentity) {
      const deliveries = this.factDeliveriesByProducer.get(producerIdentity) ?? new Set<string>();
      deliveries.add(packet.deliveryId);
      this.factDeliveriesByProducer.set(producerIdentity, deliveries);
    }
  }

  private submitDetail(capture: AnalyticsDetailCapture): void {
    this.assertCaptureEnvelope(capture.generationId, capture.captureSubject);
    this.assertProducerIdentity(capture.producer?.buildId, undefined, false);
    this.assertAcknowledgementCapacity();
    const packets = createAnalyticsDetailPackets(capture);
    const retainedTransportBytes = packets.reduce(
      (total, packet) => total + Buffer.byteLength(JSON.stringify(packet), 'utf8'),
      0,
    );
    const start = packets[0];
    if (!start || start.kind !== 'detail.start') throw new Error('Analytics detail transport produced no start packet.');
    if (this.pendingDeliveries.has(start.deliveryId)) {
      throw new Error(`Analytics detail delivery ${start.deliveryId} is already pending.`);
    }
    if (this.pendingDeliveries.size >= 64 || this.pendingDetailBytes + retainedTransportBytes > 32 * 1024 * 1024) {
      throw new Error('Analytics worker detail transport capacity exceeded.');
    }
    this.pendingDeliveries.set(start.deliveryId, {
      kind: 'detail', payloadId: capture.payloadId, bytes: retainedTransportBytes, retainAcknowledgement: true,
    });
    this.detailDeliveriesByPayload.set(capture.payloadId, start.deliveryId);
    this.pendingDetailBytes += retainedTransportBytes;
    this.detailSendQueue.push({ packets, start, nextIndex: 0, finished: false });
    this.pumpDetailQueue();
  }

  private send(packet: AnalyticsTransportPacket): void {
    if (!this.installed) throw new Error('Analytics worker transport is not installed.');
    if (!this.sender.sendAnalyticsFrame(packet)) {
      throw new Error(`Analytics transport rejected ${packet.kind} for ${packet.deliveryId}.`);
    }
  }

  private pumpDetailQueue(): void {
    if (this.pumpingDetail || !this.installed) return;
    const job = this.detailSendQueue[0];
    if (!job) return;
    this.pumpingDetail = true;
    const packet = job.packets[job.nextIndex];
    if (!packet) {
      this.finishDetailSend(job);
      return;
    }
    const accepted = this.sender.sendAnalyticsFrame(packet, (settlement) => {
      queueMicrotask(() => {
        if (job.finished || this.detailSendQueue[0] !== job) return;
        if (settlement.status !== 'sent') {
          this.abortDetailSend(job, settlement.status === 'failed' ? settlement.error.message : settlement.detail);
          return;
        }
        job.nextIndex += 1;
        this.pumpingDetail = false;
        this.pumpDetailQueue();
      });
    });
    if (!accepted) {
      this.abortDetailSend(job, `Analytics transport rejected ${packet.kind}.`);
    }
  }

  private finishDetailSend(job: PendingDetailSend): void {
    job.finished = true;
    this.detailSendQueue.shift();
    this.pumpingDetail = false;
    this.pumpDetailQueue();
  }

  private abortDetailSend(job: PendingDetailSend, message: string): void {
    if (job.finished) return;
    job.finished = true;
    if (this.detailSendQueue[0] === job) this.detailSendQueue.shift();
    else {
      const index = this.detailSendQueue.indexOf(job);
      if (index >= 0) this.detailSendQueue.splice(index, 1);
    }
    this.pumpingDetail = false;
    const abort = createAnalyticsDetailAbortPacket(job.start, 'transport_incomplete', truncateMessage(message));
    this.sender.sendAnalyticsFrame(abort);
    this.pumpDetailQueue();
  }

  private releasePendingDelivery(deliveryId: string): void {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending) return;
    this.pendingDeliveries.delete(deliveryId);
    if (pending.kind === 'fact' && pending.producerIdentity) {
      const deliveries = this.factDeliveriesByProducer.get(pending.producerIdentity);
      deliveries?.delete(deliveryId);
      if (deliveries?.size === 0) this.factDeliveriesByProducer.delete(pending.producerIdentity);
    }
    if (pending.kind === 'detail') {
      this.pendingDetailBytes = Math.max(0, this.pendingDetailBytes - (pending.bytes ?? 0));
      if (pending.payloadId && this.detailDeliveriesByPayload.get(pending.payloadId) === deliveryId) {
        this.detailDeliveriesByPayload.delete(pending.payloadId);
      }
    }
  }

  private assertCaptureEnvelope(generationId: string, captureSubject: AnalyticsCaptureSubject): void {
    if (generationId !== this.activation.generationId) throw new Error('Analytics capture generation does not match worker activation.');
    if (!sameAnalyticsCaptureSubject(captureSubject, this.captureSubject)) {
      throw new Error('Analytics capture subject does not match the worker-owned session.');
    }
    if (this.captureSubjectState !== 'active') {
      throw new Error(`Analytics capture subject transition is ${this.captureSubjectState}.`);
    }
  }

  private assertProducerIdentity(buildId: string | undefined, workspaceId: string | undefined, requireWorkspace = true): void {
    if (buildId !== this.activation.buildId) {
      throw new Error('Analytics producer build does not match worker activation.');
    }
    if (requireWorkspace && this.activation.workspaceId !== undefined && workspaceId !== this.activation.workspaceId) {
      throw new Error('Analytics producer workspace does not match worker activation.');
    }
  }

  private assertAcknowledgementCapacity(): void {
    const retained = this.pendingDeliveries.size + this.factWatermarks.size + this.completeDetails.size;
    if (retained >= MAX_ACKNOWLEDGEMENT_STATE) {
      throw new Error('Analytics worker acknowledgement capacity exceeded.');
    }
  }
}

function truncateMessage(value: string): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, 'utf8');
    if (bytes + next > 2_048) break;
    result += character;
    bytes += next;
  }
  return result;
}
