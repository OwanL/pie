import type { AnalyticsCaptureSubject } from '../../../shared/analytics/contracts.js';
import {
  ANALYTICS_RUNTIME_BRIDGE_KEY,
  canonicalAnalyticsToolEntityId,
  parseAnalyticsCaptureSubject,
  type InstalledAnalyticsRuntimeBridge,
} from '../../../shared/analytics/transport.js';
import type { SubagentAnalyticsCaptureContext } from './analytics-capture.js';

function installedBridge(): InstalledAnalyticsRuntimeBridge | undefined {
  const host = globalThis as unknown as Record<PropertyKey, unknown>;
  const candidate = host[ANALYTICS_RUNTIME_BRIDGE_KEY];
  if (!candidate || typeof candidate !== 'object') return undefined;
  const value = candidate as Record<string, unknown>;
  if (typeof value.generationId !== 'string' || !value.generationId.trim()
      || typeof value.submitObservation !== 'function'
      || typeof value.submitDetail !== 'function'
      || typeof value.readFactAcknowledgement !== 'function'
      || typeof value.isDetailComplete !== 'function'
      || typeof value.releaseAcknowledgementInterest !== 'function') return undefined;
  let captureSubject: AnalyticsCaptureSubject;
  try { captureSubject = parseAnalyticsCaptureSubject(value.captureSubject); } catch { return undefined; }
  if (!value.producer || typeof value.producer !== 'object' || Array.isArray(value.producer)) return undefined;
  const rawProducer = value.producer as Record<string, unknown>;
  if (typeof rawProducer.buildId !== 'string' || !rawProducer.buildId.trim()
      || typeof rawProducer.processId !== 'number' || !Number.isSafeInteger(rawProducer.processId) || rawProducer.processId <= 0
      || typeof rawProducer.processGeneration !== 'string' || !rawProducer.processGeneration.trim()) return undefined;
  const submitObservation = value.submitObservation;
  const submitDetail = value.submitDetail;
  const readFactAcknowledgement = value.readFactAcknowledgement;
  const isDetailComplete = value.isDetailComplete;
  const releaseAcknowledgementInterest = value.releaseAcknowledgementInterest;
  return {
    generationId: value.generationId,
    captureSubject,
    ...(typeof value.workspaceId === 'string' && value.workspaceId.trim() ? { workspaceId: value.workspaceId } : {}),
    producer: {
      buildId: rawProducer.buildId,
      processId: rawProducer.processId,
      processGeneration: rawProducer.processGeneration,
    },
    submitObservation: (observation) => { submitObservation(observation); },
    submitDetail: (detail) => { submitDetail(detail); },
    readFactAcknowledgement: (generationId, stableOriginId) => readFactAcknowledgement(generationId, stableOriginId),
    isDetailComplete: (payloadId) => isDetailComplete(payloadId),
    releaseAcknowledgementInterest: (generationId, stableOriginId, payloadId) => {
      releaseAcknowledgementInterest(generationId, stableOriginId, payloadId);
    },
  };
}

function subjectIdentity(subject: AnalyticsCaptureSubject): string {
  switch (subject.kind) {
    case 'session': return subject.rootSessionId;
    case 'pendingCreate': return subject.operationId;
    case 'host': return `host:${subject.hostId}`;
  }
}

/** Resolve the worker-installed production bridge. Absence is the explicit
 * legacy/disabled state and therefore remains a strict no-op. */
export function resolveInstalledSubagentAnalyticsCapture(): SubagentAnalyticsCaptureContext | undefined {
  const bridge = installedBridge();
  if (!bridge) return undefined;
  return {
    generationId: bridge.generationId,
    captureSubject: bridge.captureSubject,
    ...(bridge.workspaceId ? { workspaceId: bridge.workspaceId } : {}),
    producer: bridge.producer,
    factSink: { submit: (observation) => bridge.submitObservation(observation) },
    sink: {
      preflightDetail: () => undefined,
      submitDetail: (capture) => bridge.submitDetail(capture),
    },
    readFactAcknowledgement: (generationId, stableOriginId) => (
      bridge.readFactAcknowledgement(generationId, stableOriginId)
    ),
    isDetailComplete: (payloadId) => bridge.isDetailComplete(payloadId),
    releaseAcknowledgementInterest: (generationId, stableOriginId, payloadId) => (
      bridge.releaseAcknowledgementInterest(generationId, stableOriginId, payloadId)
    ),
    resolveParentToolEntityId: (toolCallId) => canonicalAnalyticsToolEntityId(
      subjectIdentity(bridge.captureSubject),
      toolCallId,
    ),
  };
}
