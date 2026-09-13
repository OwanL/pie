import type {
  AnalyticsCaptureSubject,
  AnalyticsDetailCapture,
  AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import type {
  AnalyticsWriterIdentity,
  SessionLifecycleWriterAdmission,
} from './session-lifecycle-store.js';
import {
  ANALYTICS_RUNTIME_BRIDGE_KEY,
  analyticsProducerIdentity,
  createAnalyticsDetailPacketSequence,
  analyticsDetailTransportReservationBytes,
  analyticsTransportDeliveryId,
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
  /** Host-owned durable admission authority shared with the coordinator. */
  writerAdmission?: {
    stateDir: string;
    identity: AnalyticsWriterIdentity;
  };
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

export interface AnalyticsFactShutdownReport {
  /** The writer admitted these fact frames before the transport was fenced. */
  admitted: number;
  /** A stream write callback ran; this is not recorder durability. */
  writerSent: number;
  /** The writer synchronously rejected admission. */
  rejected: number;
  /** The writer failed after admission or the sender threw. */
  failed: number;
  /** Admitted frames whose writer callback did not settle before disposal. */
  unsettledTimeout: number;
  /** Durable ACKs observed before the transport was fenced. */
  durableAcksObserved: number;
}

export interface AnalyticsTransportDisposalReport {
  /** `timed-out` means at least one detail or fact writer remained unsettled. */
  status: 'drained' | 'timed-out';
  facts: AnalyticsFactShutdownReport;
}

interface PendingFactFrame {
  deliveryId: string;
  pendingDelivery: PendingDelivery;
  sendReturned: boolean;
  accepted: boolean;
  earlySettlement?: AnalyticsTransportFrameSettlement;
  ignored: boolean;
}

interface PendingDelivery {
  kind: 'fact' | 'detail';
  payloadId?: string;
  bytes?: number;
  producerIdentity?: string;
  retainAcknowledgement: boolean;
}

interface PendingDetailSend {
  packets: Generator<AnalyticsTransportPacket, void>;
  start: AnalyticsTransportDetailStartPacket;
  finished: boolean;
  disposeRequested?: boolean;
}

const MAX_ACKNOWLEDGEMENT_STATE = 8_192;
const DISPOSAL_SETTLEMENT_TIMEOUT_MS = 1_000;

function emptyFactShutdownReport(): AnalyticsFactShutdownReport {
  return {
    admitted: 0,
    writerSent: 0,
    rejected: 0,
    failed: 0,
    unsettledTimeout: 0,
    durableAcksObserved: 0,
  };
}

function greaterInt64(left: number | string, right: number | string | undefined): boolean {
  return right === undefined || BigInt(left) > BigInt(right);
}

/** Worker-local adapter installed on the process global so independently
 * loaded jiti copies of the subagent extension share one exact transport. */
export class AnalyticsWorkerTransport {
  private readonly factWatermarks = new Map<string, number | string>();
  private readonly completeDetails = new Set<string>();
  private readonly pendingDeliveries = new Map<string, PendingDelivery[]>();
  private pendingDeliveryCount = 0;
  private readonly factDeliveriesByProducer = new Map<string, Set<string>>();
  private readonly detailDeliveriesByPayload = new Map<string, string>();
  private readonly detailSendQueue: PendingDetailSend[] = [];
  private readonly pendingFactFrames = new Map<string, Set<PendingFactFrame>>();
  private readonly factShutdownReport = emptyFactShutdownReport();
  private pendingDetailBytes = 0;
  private pumpingDetail = false;
  private activeDetailFrame: { job: PendingDetailSend } | undefined;
  private pendingDetailAbort = false;
  private disposalPromise?: Promise<AnalyticsTransportDisposalReport>;
  private resolveDisposal?: (report: AnalyticsTransportDisposalReport) => void;
  private disposalTimer?: ReturnType<typeof setTimeout>;
  private disposalExpired = false;
  private disposalReport?: AnalyticsTransportDisposalReport;
  private readonly bridge: InstalledAnalyticsRuntimeBridge;
  private installed = false;
  private captureSubject: AnalyticsCaptureSubject;
  private captureSubjectState: 'active' | 'pending' | 'disabled' = 'active';
  private captureSubjectRevision = 0;

  constructor(
    private readonly sender: AnalyticsWorkerTransportSender,
    readonly activation: WorkerAnalyticsActivation,
    processGeneration: string,
    private readonly writerAdmission?: Pick<SessionLifecycleWriterAdmission, 'assertAdmitted'>,
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
          for (const factDelivery of this.pendingDeliveries.get(deliveryId) ?? []) {
            if (factDelivery.kind === 'fact') factDelivery.retainAcknowledgement = false;
          }
        }
        this.factDeliveriesByProducer.delete(producerIdentity);
        const detailDeliveryId = this.detailDeliveriesByPayload.get(payloadId);
        const detailDelivery = detailDeliveryId ? this.pendingDeliveries.get(detailDeliveryId)?.[0] : undefined;
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

  /**
   * Fence the bridge immediately, then give admitted fact frames and one
   * detail frame already accepted by the bounded IPC writer a finite chance
   * to settle. The report deliberately distinguishes a stream write from a
   * recorder-durable ACK; the latter can arrive only through a later host
   * acknowledgement and is never inferred during disposal.
   */
  dispose(): Promise<AnalyticsTransportDisposalReport> {
    if (this.disposalPromise) return this.disposalPromise;
    if (!this.installed) {
      return Promise.resolve(this.disposalReport ?? {
        status: 'drained',
        facts: { ...this.factShutdownReport },
      });
    }
    this.disposalPromise = new Promise<AnalyticsTransportDisposalReport>((resolve) => {
      this.resolveDisposal = resolve;
      this.disposalTimer = setTimeout(() => {
        this.disposalExpired = true;
        this.expirePendingFactFrames();
        this.finishDisposal('timed-out');
      }, DISPOSAL_SETTLEMENT_TIMEOUT_MS);
      this.disposalTimer.unref?.();
    });
    const host = globalThis as unknown as Record<PropertyKey, unknown>;
    if (host[ANALYTICS_RUNTIME_BRIDGE_KEY] === this.bridge) delete host[ANALYTICS_RUNTIME_BRIDGE_KEY];
    this.installed = false;
    const activeJob = this.activeDetailFrame?.job;
    if (activeJob) {
      activeJob.disposeRequested = true;
      if (!activeJob.finished) this.releasePendingDelivery(activeJob.start.deliveryId);
    }
    this.factWatermarks.clear();
    this.completeDetails.clear();
    this.pendingDeliveries.clear();
    this.pendingDeliveryCount = 0;
    this.factDeliveriesByProducer.clear();
    this.detailDeliveriesByPayload.clear();
    for (const job of this.detailSendQueue) {
      job.finished = true;
      job.packets.return();
    }
    this.detailSendQueue.length = 0;
    this.pendingDetailBytes = 0;
    this.pumpingDetail = false;
    this.captureSubjectRevision += 1;
    this.captureSubjectState = 'disabled';
    this.maybeFinishDisposal();
    return this.disposalPromise;
  }

  acknowledge(value: unknown): void {
    const acknowledgement = parseAnalyticsTransportAcknowledgement(value);
    if (acknowledgement.generationId !== this.activation.generationId) return;
    const pending = this.pendingDeliveries.get(acknowledgement.deliveryId)?.[0];
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
    if (pending.kind === 'fact' && acknowledgement.status === 'durable') {
      this.factShutdownReport.durableAcksObserved += 1;
    }
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
    this.writerAdmission?.assertAdmitted();
    this.assertCaptureEnvelope(observation.generationId, observation.captureSubject);
    this.assertProducerIdentity(observation.producer.buildId, observation.scope.workspaceCoverage === 'known'
      ? observation.scope.workspaceId : undefined);
    this.assertAcknowledgementCapacity();
    const packet = createAnalyticsFactPacket(observation);
    const producerIdentity = observation.stableOriginId
      ? analyticsProducerIdentity(observation.generationId, observation.producerKind, observation.stableOriginId)
      : undefined;
    const pendingDelivery: PendingDelivery = {
      kind: 'fact', retainAcknowledgement: true,
      ...(producerIdentity ? { producerIdentity } : {}),
    };
    const deliveriesForId = this.pendingDeliveries.get(packet.deliveryId) ?? [];
    deliveriesForId.push(pendingDelivery);
    this.pendingDeliveries.set(packet.deliveryId, deliveriesForId);
    this.pendingDeliveryCount += 1;
    if (producerIdentity) {
      const deliveries = this.factDeliveriesByProducer.get(producerIdentity) ?? new Set<string>();
      deliveries.add(packet.deliveryId);
      this.factDeliveriesByProducer.set(producerIdentity, deliveries);
    }
    // The sender may settle synchronously. Register ownership before sending
    // so an immediate durable ACK is not lost; rejected admission rolls it back.
    try { this.sendFactFrame(packet, pendingDelivery); } catch (error) {
      this.releasePendingDelivery(packet.deliveryId, pendingDelivery);
      throw error;
    }
  }

  private submitDetail(capture: AnalyticsDetailCapture): void {
    this.writerAdmission?.assertAdmitted();
    this.assertCaptureEnvelope(capture.generationId, capture.captureSubject);
    this.assertProducerIdentity(capture.producer?.buildId, undefined, false);
    this.assertAcknowledgementCapacity();
    const retainedTransportBytes = analyticsDetailTransportReservationBytes(capture.bytes.byteLength);
    const deliveryId = analyticsTransportDeliveryId(capture.generationId, 'detail', capture.sourceKey);
    if (this.pendingDeliveries.has(deliveryId)) {
      throw new Error(`Analytics detail delivery ${deliveryId} is already pending.`);
    }
    if (this.pendingDeliveries.size >= 64 || this.pendingDetailBytes + retainedTransportBytes > 32 * 1024 * 1024) {
      throw new Error('Analytics worker detail transport capacity exceeded.');
    }
    // Admission precedes byte copying, hashing and metadata normalization. The
    // accepted job retains detached bytes and generates only one frame at a time.
    const { start, packets } = createAnalyticsDetailPacketSequence(capture);
    this.pendingDeliveries.set(start.deliveryId, [{
      kind: 'detail', payloadId: capture.payloadId, bytes: retainedTransportBytes, retainAcknowledgement: true,
    }]);
    this.pendingDeliveryCount += 1;
    this.detailDeliveriesByPayload.set(capture.payloadId, start.deliveryId);
    this.pendingDetailBytes += retainedTransportBytes;
    this.detailSendQueue.push({ packets, start, finished: false });
    this.pumpDetailQueue();
  }

  private sendFactFrame(packet: AnalyticsTransportPacket, pendingDelivery: PendingDelivery): void {
    if (!this.installed) throw new Error('Analytics worker transport is not installed.');
    const frame: PendingFactFrame = {
      deliveryId: packet.deliveryId,
      pendingDelivery,
      sendReturned: false,
      accepted: false,
      ignored: false,
    };
    const framesForId = this.pendingFactFrames.get(packet.deliveryId) ?? new Set<PendingFactFrame>();
    framesForId.add(frame);
    this.pendingFactFrames.set(packet.deliveryId, framesForId);
    try {
      frame.accepted = this.sender.sendAnalyticsFrame(packet, (settlement) => {
        if (!frame.sendReturned) {
          frame.earlySettlement = settlement;
          return;
        }
        this.settleFactFrame(frame, settlement);
      });
    } catch (error) {
      frame.sendReturned = true;
      this.settleFactFrame(frame, {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
    frame.sendReturned = true;
    if (!frame.accepted) {
      this.settleFactFrame(frame, frame.earlySettlement ?? {
        status: 'rejected',
        reason: 'unavailable',
        detail: `Analytics transport rejected fact ${packet.deliveryId}.`,
      });
      throw new Error(`Analytics transport rejected fact for ${packet.deliveryId}.`);
    }
    this.factShutdownReport.admitted += 1;
    if (frame.earlySettlement) this.settleFactFrame(frame, frame.earlySettlement);
  }

  private settleFactFrame(frame: PendingFactFrame, settlement: AnalyticsTransportFrameSettlement): void {
    const framesForId = this.pendingFactFrames.get(frame.deliveryId);
    if (frame.ignored || !framesForId?.has(frame)) return;
    frame.ignored = true;
    framesForId.delete(frame);
    if (framesForId.size === 0) this.pendingFactFrames.delete(frame.deliveryId);
    if (settlement.status === 'sent') this.factShutdownReport.writerSent += 1;
    else if (settlement.status === 'rejected') {
      this.factShutdownReport.rejected += 1;
      this.releasePendingDelivery(frame.deliveryId, frame.pendingDelivery);
    } else {
      this.factShutdownReport.failed += 1;
      this.releasePendingDelivery(frame.deliveryId, frame.pendingDelivery);
    }
    this.maybeFinishDisposal();
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
    const next = job.packets.next();
    if (next.done) {
      this.finishDetailSend(job);
      return;
    }
    const packet = next.value;
    try {
      this.writerAdmission?.assertAdmitted();
    } catch (error) {
      this.activeDetailFrame = undefined;
      this.pumpingDetail = false;
      this.abortDetailSend(job, error instanceof Error ? error.message : String(error));
      return;
    }
    const activeFrame = { job };
    this.activeDetailFrame = activeFrame;
    let accepted: boolean;
    try {
      accepted = this.sender.sendAnalyticsFrame(packet, (settlement) => {
        // The writer calls settlement before pumping its next lane.  During
        // disposal this synchronous branch places the abort immediately after
        // the admitted detail frame, even when that frame was queued behind a
        // different lane.  Normal delivery keeps its microtask fence so an
        // early ACK cannot overlap the next detail frame.
        if (job.disposeRequested) {
          this.settleDisposedDetailFrame(activeFrame, settlement);
          return;
        }
        queueMicrotask(() => {
          if (this.activeDetailFrame !== activeFrame) return;
          if (job.disposeRequested) {
            this.settleDisposedDetailFrame(activeFrame, settlement);
            return;
          }
          this.activeDetailFrame = undefined;
          this.pumpingDetail = false;
          if (job.finished || this.detailSendQueue[0] !== job) {
            this.pumpDetailQueue();
            return;
          }
          if (settlement.status !== 'sent') {
            this.abortDetailSend(job, settlement.status === 'failed' ? settlement.error.message : settlement.detail);
            return;
          }
          this.pumpDetailQueue();
        });
      });
    } catch (error) {
      this.activeDetailFrame = undefined;
      this.pumpingDetail = false;
      this.abortDetailSend(job, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!accepted) {
      this.activeDetailFrame = undefined;
      this.pumpingDetail = false;
      this.abortDetailSend(job, `Analytics transport rejected ${packet.kind}.`);
    }
  }

  private settleDisposedDetailFrame(
    activeFrame: { job: PendingDetailSend },
    settlement: AnalyticsTransportFrameSettlement,
  ): void {
    if (this.activeDetailFrame !== activeFrame) return;
    this.activeDetailFrame = undefined;
    this.pumpingDetail = false;
    if (this.disposalExpired || settlement.status !== 'sent') {
      this.maybeFinishDisposal();
      return;
    }
    const abort = createAnalyticsDetailAbortPacket(
      activeFrame.job.start,
      'transport_shutdown',
      'Analytics worker transport closed before detail delivery completed.',
    );
    this.pendingDetailAbort = true;
    let abortSendReturned = false;
    let abortSettlementArrived = false;
    const settleAbort = (): void => {
      if (!abortSendReturned) {
        abortSettlementArrived = true;
        return;
      }
      this.pendingDetailAbort = false;
      this.maybeFinishDisposal();
    };
    let accepted = false;
    try {
      accepted = this.sender.sendAnalyticsFrame(abort, settleAbort);
    } catch {
      // A failed descriptor is covered by route-scoped host cleanup after the
      // worker exit; never keep shutdown waiting for an impossible ACK.
      this.pendingDetailAbort = false;
    }
    abortSendReturned = true;
    if (!accepted || abortSettlementArrived) this.pendingDetailAbort = false;
    this.maybeFinishDisposal();
  }

  private maybeFinishDisposal(): void {
    if (!this.disposalPromise || this.disposalReport || this.disposalExpired) return;
    if (this.activeDetailFrame || this.pendingDetailAbort || this.pendingFactFrameCount() > 0) return;
    this.finishDisposal('drained');
  }

  private expirePendingFactFrames(): void {
    if (this.pendingFactFrames.size === 0) return;
    for (const frames of this.pendingFactFrames.values()) {
      this.factShutdownReport.unsettledTimeout += frames.size;
      for (const frame of frames) {
        frame.ignored = true;
        this.releasePendingDelivery(frame.deliveryId, frame.pendingDelivery);
      }
    }
    this.pendingFactFrames.clear();
  }

  private pendingFactFrameCount(): number {
    let count = 0;
    for (const frames of this.pendingFactFrames.values()) count += frames.size;
    return count;
  }

  private finishDisposal(status: AnalyticsTransportDisposalReport['status']): void {
    if (this.disposalReport) return;
    if (this.disposalTimer) clearTimeout(this.disposalTimer);
    this.disposalTimer = undefined;
    this.disposalReport = {
      status,
      facts: { ...this.factShutdownReport },
    };
    const resolve = this.resolveDisposal;
    this.resolveDisposal = undefined;
    resolve?.(this.disposalReport);
  }

  private finishDetailSend(job: PendingDetailSend): void {
    job.finished = true;
    job.packets.return();
    this.detailSendQueue.shift();
    this.pumpingDetail = false;
    this.pumpDetailQueue();
  }

  private abortDetailSend(job: PendingDetailSend, message: string): void {
    if (job.finished) return;
    job.finished = true;
    job.packets.return();
    if (this.detailSendQueue[0] === job) this.detailSendQueue.shift();
    else {
      const index = this.detailSendQueue.indexOf(job);
      if (index >= 0) this.detailSendQueue.splice(index, 1);
    }
    this.pumpingDetail = false;
    this.releasePendingDelivery(job.start.deliveryId);
    const abort = createAnalyticsDetailAbortPacket(job.start, 'transport_incomplete', truncateMessage(message));
    try { this.sender.sendAnalyticsFrame(abort); } catch { /* The original send already failed. */ }
    this.pumpDetailQueue();
  }

  private releasePendingDelivery(deliveryId: string, expected?: PendingDelivery): void {
    const pendingForId = this.pendingDeliveries.get(deliveryId);
    if (!pendingForId || pendingForId.length === 0) return;
    const pendingIndex = expected ? pendingForId.indexOf(expected) : 0;
    if (pendingIndex < 0) return;
    const [pending] = pendingForId.splice(pendingIndex, 1);
    if (!pending) return;
    this.pendingDeliveryCount = Math.max(0, this.pendingDeliveryCount - 1);
    if (pendingForId.length === 0) this.pendingDeliveries.delete(deliveryId);
    if (pending.kind === 'fact' && pending.producerIdentity) {
      const deliveries = this.factDeliveriesByProducer.get(pending.producerIdentity);
      if (pendingForId.length === 0) deliveries?.delete(deliveryId);
      if (deliveries?.size === 0) this.factDeliveriesByProducer.delete(pending.producerIdentity);
    }
    if (pending.kind === 'detail') {
      const job = this.detailSendQueue.find((candidate) => candidate.start.deliveryId === deliveryId);
      if (job && !job.finished) {
        job.finished = true;
        job.packets.return();
        const index = this.detailSendQueue.indexOf(job);
        this.detailSendQueue.splice(index, 1);
        if (index === 0) {
          // The ACK does not settle a frame already accepted by the IPC writer.
          // Retain that independent in-flight fence until its callback arrives.
          if (this.activeDetailFrame?.job !== job) this.pumpingDetail = false;
          // An early host rejection must stop the remaining chunks, while an
          // unrelated queued delivery can still progress.
          queueMicrotask(() => this.pumpDetailQueue());
        }
      }
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
    const retained = this.pendingDeliveryCount + this.factWatermarks.size + this.completeDetails.size;
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
