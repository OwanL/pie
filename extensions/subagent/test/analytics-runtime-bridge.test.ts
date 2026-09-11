import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYTICS_RUNTIME_BRIDGE_KEY,
  canonicalAnalyticsToolEntityId,
  type InstalledAnalyticsRuntimeBridge,
} from '../../../shared/analytics/transport.js';
import { resolveInstalledSubagentAnalyticsCapture } from '../src/analytics-runtime-bridge.js';

test('runtime bridge derives the same canonical parent tool for session and pending-create subjects', () => {
  const host = globalThis as unknown as Record<PropertyKey, unknown>;
  const subjects = [
    { kind: 'session' as const, rootSessionId: 'root-session-1', identity: 'root-session-1' },
    { kind: 'pendingCreate' as const, operationId: 'pending:canonical-operation-hash', identity: 'pending:canonical-operation-hash' },
  ];
  try {
    for (const entry of subjects) {
      const { identity, ...captureSubject } = entry;
      const bridge: InstalledAnalyticsRuntimeBridge = {
        generationId: 'generation-1',
        captureSubject,
        producer: { buildId: 'build-1', processId: 1234, processGeneration: 'process-1' },
        submitObservation: () => undefined,
        submitDetail: () => undefined,
        readFactAcknowledgement: () => undefined,
        isDetailComplete: () => false,
        releaseAcknowledgementInterest: () => undefined,
      };
      host[ANALYTICS_RUNTIME_BRIDGE_KEY] = bridge;
      const resolved = resolveInstalledSubagentAnalyticsCapture();
      assert.ok(resolved);
      assert.equal(
        resolved.resolveParentToolEntityId?.('tool-call-1'),
        canonicalAnalyticsToolEntityId(identity, 'tool-call-1'),
      );
    }
  } finally {
    delete host[ANALYTICS_RUNTIME_BRIDGE_KEY];
  }
});

test('runtime bridge rejects incomplete global bridge identities', () => {
  const host = globalThis as unknown as Record<PropertyKey, unknown>;
  try {
    host[ANALYTICS_RUNTIME_BRIDGE_KEY] = {
      generationId: 'generation-1',
      captureSubject: { kind: 'session', rootSessionId: 'root-session-1' },
      producer: { buildId: 'build-1', processId: '1234', processGeneration: '' },
      submitObservation: () => undefined,
      submitDetail: () => undefined,
      readFactAcknowledgement: () => undefined,
      isDetailComplete: () => false,
      releaseAcknowledgementInterest: () => undefined,
    };
    assert.equal(resolveInstalledSubagentAnalyticsCapture(), undefined);
  } finally {
    delete host[ANALYTICS_RUNTIME_BRIDGE_KEY];
  }
});
