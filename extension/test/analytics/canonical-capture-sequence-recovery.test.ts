import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import { processObservationBatch, type ObservationCapture } from '../../src/analytics/capture-batch-processing.js';
import type { SqliteLockRetryBudget } from '../../src/analytics/sqlite-lock-retry.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';
import {
  CanonicalAnalyticsCapture,
  type CanonicalAnalyticsCaptureDisposition,
  type CanonicalAnalyticsSink,
} from '../../src/analytics/canonical-capture.js';

function lockBudget(): SqliteLockRetryBudget {
  return { deadlineMs: performance.now() + 30_000 };
}

function batchSubject(observation: AnalyticsObservation<object>): string {
  const subject = observation.captureSubject;
  assert.equal(subject.kind, 'session');
  if (subject.kind !== 'session') throw new Error('unreachable');
  return `session:${subject.rootSessionId}`;
}

const settlementSourceKey = (invocationId: string): string => `provider-settlement:${invocationId}`;

function settlementRecord(invocationId: string, sessionId = 'session-recovery') {
  return {
    schemaVersion: 1 as const,
    sessionId,
    sessionPath: '/recovery/session.jsonl',
    branchId: null,
    parentOperationId: null,
    parentRunId: null,
    parentToolId: null,
    kind: 'conversation' as const,
    provider: 'provider-recovery',
    model: 'model-recovery',
    provenance: 'exact' as const,
    startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z',
    outcome: 'succeeded' as const,
    instrumentationGap: false as const,
    invocationId,
    sourceId: invocationId,
    inputTokens: 10,
    outputTokens: 2,
  };
}

interface QueuedDelivery {
  readonly observation: AnalyticsObservation<object>;
  readonly onDisposition: (disposition: CanonicalAnalyticsCaptureDisposition) => void;
}

/** Test-only tracked sink with the real supervisor's ack contract: every
 * capture flows through the real SQLite recorder via the record-level batch
 * processor, and exactly one definitive disposition returns per capture.
 * Records the producer adapter cannot observe (the recorder's own rejection
 * codes and reconciliation state) for explicit assertions. */
class RecorderBatchSink {
  readonly submitted: AnalyticsObservation<object>[] = [];
  readonly rejected: Array<{ sourceKey: string; code: string }> = [];
  private readonly queue: QueuedDelivery[] = [];
  private readonly invalidOnce = new Set<string>();
  private readonly conflictOnSecond = new Set<string>();
  private readonly deliveryIndex = new Map<string, number>();

  constructor(private readonly recorder: SqliteAnalyticsRecorder) {}

  get sink(): CanonicalAnalyticsSink {
    return {
      submit: () => {
        throw new Error('the recovery proof only exercises tracked ingress');
      },
      submitTracked: (observation, onDisposition) => {
        this.submitted.push(observation);
        this.queue.push({ observation, onDisposition });
      },
    };
  }

  /** Force a real recorder validation rejection on the source key's first
   * delivery. The producer sees a definitive async rejection while later
   * sequences already exist. */
  invalidateFirstDelivery(sourceKey: string): void {
    this.invalidOnce.add(sourceKey);
  }

  /** Mutate a second delivery of an already accepted source key so the real
   * recorder answers with a definitive source conflict. */
  conflictSecondDelivery(sourceKey: string): void {
    this.conflictOnSecond.add(sourceKey);
  }

  private mutate(observation: AnalyticsObservation<object>): AnalyticsObservation<object> {
    const count = (this.deliveryIndex.get(observation.sourceKey) ?? 0) + 1;
    this.deliveryIndex.set(observation.sourceKey, count);
    if (count === 1 && this.invalidOnce.has(observation.sourceKey)) {
      return { ...observation, idempotencyKey: `${observation.idempotencyKey}:invalid` };
    }
    if (count === 2 && this.conflictOnSecond.has(observation.sourceKey)) {
      return { ...observation, fields: { ...observation.fields, purpose: 'conflict-probe' } };
    }
    return observation;
  }

  /** Deliver the whole queue (or a selected slice) exactly like the real
   * supervisor: process the bounded batch, then settle one disposition per
   * record in queue order. */
  async deliverQueued(select?: (observation: AnalyticsObservation<object>) => boolean): Promise<void> {
    const selected: QueuedDelivery[] = [];
    const retained: QueuedDelivery[] = [];
    for (const delivery of this.queue) {
      (select?.(delivery.observation) ?? true ? selected : retained).push(delivery);
    }
    this.queue.length = 0;
    this.queue.push(...retained);
    if (selected.length === 0) return;
    const captures: ObservationCapture[] = selected.map((delivery) => ({
      subject: batchSubject(delivery.observation),
      // The tracked sink hands AnalyticsObservation<object>; the batch
      // processor's default field record is the same runtime shape.
      value: this.mutate(delivery.observation) as unknown as AnalyticsObservation,
    }));
    const rejections = await processObservationBatch(
      captures, this.recorder, { deadlineMs: performance.now() + 30_000 },
    );
    const rejectionByIndex = new Map(rejections.map((rejection) => [rejection.index, rejection]));
    selected.forEach((delivery, index) => {
      const rejection = rejectionByIndex.get(index);
      if (rejection) {
        this.rejected.push({ sourceKey: delivery.observation.sourceKey, code: rejection.code });
        delivery.onDisposition({
          status: 'rejected', code: rejection.code, message: rejection.error,
        });
      } else {
        delivery.onDisposition({ status: 'durable' });
      }
    });
  }
}

function reconciliationFor(
  recorder: SqliteAnalyticsRecorder,
  observation: AnalyticsObservation<object>,
) {
  const [row] = recorder.readProducerAcknowledgements([
    observation as unknown as AnalyticsObservation,
  ]);
  assert.ok(row, 'the producer epoch must have a reconciliation row');
  return {
    contiguousWatermark: String(row.contiguousWatermark),
    highestObservedSequence: String(row.highestObservedSequence),
    visibleGaps: row.visibleGaps.map((gap) => ({ from: String(gap.from), to: String(gap.to) })),
    pendingReceiptCount: row.pendingReceiptCount,
  };
}

test('async non-tail rejection rotates the producer origin so >4096 later settlements keep recording', { timeout: 300_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-capture-sequence-recovery-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  try {
    const sink = new RecorderBatchSink(recorder);
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-recovery',
      workspaceId: 'workspace-recovery',
      buildId: 'build-recovery',
      processGeneration: 'process-recovery',
      sink: sink.sink,
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: {
        bindPendingCreate: async () => undefined,
        deleteSession: async (rootSessionId, sourceKey, timestampMs) => {
          recorder.deleteSession(rootSessionId, sourceKey, timestampMs);
        },
      },
    });

    // Sequence 1 is rejected by the real recorder on its first delivery while
    // sequence 2 is already assigned; the later source is admitted first so
    // the producer learns the earlier rejection out of order.
    sink.invalidateFirstDelivery(settlementSourceKey('hole-a'));
    assert.equal(capture.captureProviderSettlement(settlementRecord('hole-a')), 'submitted');
    const holeAObservation = sink.submitted[0]!;
    assert.match(holeAObservation.stableOriginId!, /^host-origin:[0-9a-f]{64}$/);
    assert.equal(holeAObservation.sourceSequence, '1');
    assert.equal(capture.captureProviderSettlement(settlementRecord('later-b')), 'submitted');
    const laterBObservation = sink.submitted[1]!;
    assert.equal(laterBObservation.sourceSequence, '2');

    await sink.deliverQueued((observation) => observation.sourceKey === settlementSourceKey('later-b'));
    assert.deepEqual(sink.rejected, []);
    assert.deepEqual(reconciliationFor(recorder, holeAObservation), {
      contiguousWatermark: '0',
      highestObservedSequence: '2',
      visibleGaps: [{ from: '1', to: '1' }],
      pendingReceiptCount: 1,
    });

    await sink.deliverQueued((observation) => observation.sourceKey === settlementSourceKey('hole-a'));
    assert.deepEqual(sink.rejected, [{ sourceKey: settlementSourceKey('hole-a'), code: 'invalid_record' }]);

    // More than a full reconciliation window of new valid settlements must
    // keep recording after the stranded hole; the producer quarantines the
    // holed origin instead of leaving every later delivery capacity-blocked.
    for (let index = 0; index < 4_100; index += 1) {
      assert.equal(capture.captureProviderSettlement(settlementRecord(`wave-${index}`)), 'submitted');
      if ((index + 1) % 512 === 0 || index === 4_099) await sink.deliverQueued();
    }
    assert.deepEqual(sink.rejected, [{ sourceKey: settlementSourceKey('hole-a'), code: 'invalid_record' }],
      'later settlements must keep recording without any reconciliation-capacity rejection');
    assert.equal(recorder.getStats().accepted, 1 + 4_100);

    const waveObservation = sink.submitted.at(-1)!;
    assert.match(waveObservation.stableOriginId!, /^host-origin:[0-9a-f]{64}:epoch:1$/);
    assert.deepEqual(reconciliationFor(recorder, waveObservation), {
      contiguousWatermark: '4100',
      highestObservedSequence: '4100',
      visibleGaps: [],
      pendingReceiptCount: 0,
    });
    // The rejected hole is never fabricated as consumed: the original epoch
    // keeps its real gap as audit evidence and its watermark never moves.
    assert.deepEqual(reconciliationFor(recorder, holeAObservation), {
      contiguousWatermark: '0',
      highestObservedSequence: '2',
      visibleGaps: [{ from: '1', to: '1' }],
      pendingReceiptCount: 1,
    });

    // A later epoch can strand its own hole; recovery rotates again.
    sink.invalidateFirstDelivery(settlementSourceKey('hole-e'));
    assert.equal(capture.captureProviderSettlement(settlementRecord('hole-e')), 'submitted');
    const holeEObservation = sink.submitted.at(-1)!;
    assert.match(holeEObservation.stableOriginId!, /^host-origin:[0-9a-f]{64}:epoch:1$/);
    assert.equal(holeEObservation.sourceSequence, '4101');
    assert.equal(capture.captureProviderSettlement(settlementRecord('later-f')), 'submitted');
    assert.equal(sink.submitted.at(-1)!.sourceSequence, '4102');

    await sink.deliverQueued((observation) => observation.sourceKey === settlementSourceKey('later-f'));
    assert.deepEqual(reconciliationFor(recorder, holeEObservation), {
      contiguousWatermark: '4100',
      highestObservedSequence: '4102',
      visibleGaps: [{ from: '4101', to: '4101' }],
      pendingReceiptCount: 1,
    });
    await sink.deliverQueued((observation) => observation.sourceKey === settlementSourceKey('hole-e'));
    assert.deepEqual(sink.rejected.at(-1), { sourceKey: settlementSourceKey('hole-e'), code: 'invalid_record' });

    // Recovery rotates to a fresh origin epoch for every later fact.
    assert.equal(capture.captureProviderSettlement(settlementRecord('post-rotation-probe')), 'submitted');
    const postRotationObservation = sink.submitted.at(-1)!;
    assert.match(postRotationObservation.stableOriginId!, /^host-origin:[0-9a-f]{64}:epoch:2$/);
    assert.equal(postRotationObservation.sourceSequence, '1');

    // An exact retry of the holed source key across the rotation boundary
    // keeps its retained old-origin assignment, so the retry fills the real
    // hole on the original stream instead of duplicating the fact.
    assert.equal(capture.captureProviderSettlement(settlementRecord('hole-e')), 'submitted');
    const holeERetry = sink.submitted.at(-1)!;
    assert.equal(holeERetry.stableOriginId, holeEObservation.stableOriginId);
    assert.equal(holeERetry.sourceSequence, holeEObservation.sourceSequence);
    assert.equal(holeERetry.idempotencyKey, holeEObservation.idempotencyKey);
    await sink.deliverQueued();
    assert.deepEqual(sink.rejected.at(-1), { sourceKey: settlementSourceKey('hole-e'), code: 'invalid_record' },
      'the valid retry must be accepted without any new rejection');
    assert.deepEqual(reconciliationFor(recorder, holeEObservation), {
      contiguousWatermark: '4102',
      highestObservedSequence: '4102',
      visibleGaps: [],
      pendingReceiptCount: 0,
    });

    // Conflicting reuse of an admitted source key is rejected by the recorder
    // and consumed by the already-admitted receipt: no release, no rotation.
    sink.conflictSecondDelivery(settlementSourceKey('later-f'));
    assert.equal(capture.captureProviderSettlement(settlementRecord('later-f')), 'submitted');
    await sink.deliverQueued();
    assert.deepEqual(sink.rejected.at(-1), { sourceKey: settlementSourceKey('later-f'), code: 'source_conflict' });
    assert.equal(capture.captureProviderSettlement(settlementRecord('post-conflict-probe')), 'submitted');
    const probeObservation = sink.submitted.at(-1)!;
    assert.match(probeObservation.stableOriginId!, /^host-origin:[0-9a-f]{64}:epoch:2$/);
    assert.equal(probeObservation.sourceSequence, '2',
      'the conflict consumed nothing and the fresh epoch stream continues');
    await sink.deliverQueued();

    // Private close is sink-consumed, never a hole: the sequence receipt is
    // recorded by the deletion and the origin must not rotate.
    await capture.closeSession('session-close-probe', 'on', 900);
    assert.equal(
      capture.captureProviderSettlement(settlementRecord('after-close', 'session-close-probe')), 'submitted');
    await sink.deliverQueued();
    assert.deepEqual(sink.rejected.at(-1), { sourceKey: settlementSourceKey('after-close'), code: 'subject_deleted' });
    assert.equal(capture.captureProviderSettlement(settlementRecord('post-close-probe')), 'submitted');
    const postCloseObservation = sink.submitted.at(-1)!;
    assert.match(postCloseObservation.stableOriginId!, /^host-origin:[0-9a-f]{64}:epoch:2$/,
      'a consumed deleted-subject sequence must not rotate the producer origin');
    assert.equal(postCloseObservation.sourceSequence, '4');
    await sink.deliverQueued();

    assert.deepEqual(recorder.getStats(), {
      accepted: 4_106,
      duplicates: 0,
      detailsAccepted: 0,
      detailDuplicates: 0,
      rejectedAfterDelete: 1,
    });
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});