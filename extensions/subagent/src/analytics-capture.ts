import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  type AnalyticsCaptureSubject,
  type AnalyticsDetailCapture,
  type AnalyticsDetailSink,
  type AnalyticsProducerIdentity,
} from '../../../shared/analytics/contracts.js';
import { redactSensitiveText, sanitizeAnalyticsDetail } from '../../../shared/sensitive-redaction.js';
import type { SingleResult } from '../types.js';
import { recordRuntimeTrace } from './runtime-trace.js';

export interface SubagentAnalyticsCaptureContext {
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  producer?: AnalyticsProducerIdentity;
  sink: AnalyticsDetailSink;
}

function stableCaptureOrigin(
  generationId: string,
  subject: AnalyticsCaptureSubject,
  parentToolCallId: string | undefined,
  attemptId: string,
): string {
  const subjectIdentity = subject.kind === 'session'
    ? subject.rootSessionId
    : subject.kind === 'pendingCreate'
      ? subject.operationId
      : subject.hostId;
  const digest = createHash('sha256').update(JSON.stringify([
    generationId,
    subject.kind,
    subjectIdentity,
    parentToolCallId ?? null,
    attemptId,
  ])).digest('hex');
  return `subagent-origin:${digest}`;
}

export type SubagentCaptureStatus = 'disabled' | 'submitted' | 'rejected';

/**
 * Snapshot one terminal attempt into independently-owned bytes and hand those
 * bytes to the configured recorder transport. This is the only synchronous
 * rich-detail work on the child path: storage, hashing, leaf extraction and
 * deduplication remain recorder work. No acknowledgement is returned or
 * awaited. A rejected handoff is visible to callers and qualification traces;
 * it is never silently treated as captured.
 */
export function captureSubagentTerminalResult(
  result: SingleResult,
  context: SubagentAnalyticsCaptureContext | undefined,
  parentToolCallId: string | undefined,
): SubagentCaptureStatus {
  if (!context) return 'disabled';

  const startedAt = performance.now();
  let bytes: Uint8Array | undefined;
  try {
    context.sink.preflightDetail?.(result);
    bytes = serialize(sanitizeAnalyticsDetail(result));
    const attemptId = result.attemptId;
    const childId = result.childId;
    const identity = attemptId ?? childId;
    if (!identity) throw new Error('Subagent terminal capture requires an attempt or child identity.');
    const stableOriginId = stableCaptureOrigin(
      context.generationId,
      context.captureSubject,
      parentToolCallId,
      identity,
    );
    const capture: AnalyticsDetailCapture = {
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      generationId: context.generationId,
      stableOriginId,
      producerKind: 'subagent',
      producer: context.producer ?? {
        buildId: 'pie-subagent-capture-v1',
        processId: process.pid,
      },
      payloadId: `${stableOriginId}:terminal`,
      sourceKey: `${stableOriginId}:terminal`,
      observedAtMs: result.completedAt ?? Date.now(),
      captureSubject: context.captureSubject,
      mediaType: 'application/x-pie-subagent-result',
      encoding: 'node-v8',
      complete: true,
      bytes,
      metadata: {
        ...(childId ? { childId } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(result.stopReason ? { outcome: result.stopReason } : {}),
        captureStage: 'terminal',
        sourceVersion: 'subagent-terminal-v1',
      },
    };
    context.sink.submitDetail(capture);
    recordRuntimeTrace({
      phase: 'clone',
      durationMs: Math.max(0, performance.now() - startedAt),
      sourcePayloadBytes: bytes.byteLength,
      producedPayloadBytes: bytes.byteLength,
      childCount: 1,
      messageCount: result.messages.length,
      payloadClass: 'detail_terminal',
      detailDelivery: 'terminal',
      identifiers: {
        attempt: attemptId,
        tool: parentToolCallId,
      },
    });
    return 'submitted';
  } catch (error) {
    result.analyticsCaptureError = redactSensitiveText(
      error instanceof Error ? error.message : String(error),
    );
    recordRuntimeTrace({
      phase: 'clone',
      durationMs: Math.max(0, performance.now() - startedAt),
      producedPayloadBytes: bytes?.byteLength,
      childCount: 1,
      messageCount: result.messages.length,
      payloadClass: 'detail_terminal',
      detailDelivery: 'none',
      identifiers: {
        attempt: result.attemptId,
        tool: parentToolCallId,
      },
    });
    return 'rejected';
  }
}
