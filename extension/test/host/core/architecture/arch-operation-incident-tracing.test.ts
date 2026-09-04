import assert from 'node:assert/strict';
import test from 'node:test';

import { operationAndIncidentTraceEvents } from '../../../../src/host/core/operation-incident-tracing.js';
import { initialArchState, reducer } from '../../../../src/host/core/reducer.js';
import { createLivePipelineTraceRecord } from '../../../../src/shared/live-pipeline-trace.js';
import { createOperationalIncident } from '../../../../src/shared/incidents.js';

const SESSION = '/private/session.jsonl';

test('operation transition tracing emits only semantic HMAC-ready metadata', () => {
  const before = {
    ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
  };
  const command = {
    kind: 'Command' as const,
    cmd: {
      kind: 'Send' as const,
      corrId: 'internal-corr',
      operationId: 'semantic-operation',
      operationAttempt: 1,
      operationSource: {
        kind: 'renderer' as const,
        rendererId: 'internal-renderer',
        rendererKind: 'vscode' as const,
        rendererGeneration: 9,
      },
      backendGeneration: 7,
      sessionPath: SESSION,
      text: 'authorization=credential-secret',
      inputs: [],
      composedText: 'authorization=credential-secret',
      localId: 'internal-local-message',
      previousSummary: null,
      timestamp: 1,
    },
  };
  const after = reducer(before, command).state;
  const events = operationAndIncidentTraceEvents(before, after, command);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    process: 'host',
    processRole: 'host',
    stage: 'host.operation.transition',
    kind: 'transition',
    identifiers: { operation: 'semantic-operation', session: SESSION },
    operationKind: 'message.send',
    operationPhase: 'awaiting-acceptance',
    operationAcceptance: 'pending',
    operationCommit: 'pending',
  });

  const record = createLivePipelineTraceRecord(events[0]!, {
    hmacKey: 'trace-key', wallTimestampMs: 1, monoMs: 1,
  });
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /semantic-operation|private|credential-secret|internal-corr|internal-renderer|internal-local/u);
});

test('incident tracing omits request IDs, details, codes, and credential-bearing messages', () => {
  const incident = createOperationalIncident({
    incidentId: 'incident-semantic-id',
    sessionPath: SESSION,
    operationId: 'operation-semantic-id',
    requestId: 'req-internal-99',
    severity: 'warning',
    certainty: 'ambiguous',
    phase: 'transport',
    code: 'AUTHORIZATION_SECRET_CODE',
    message: 'Bearer credential-secret',
    detail: 'password=detail-secret',
  });
  const event = { kind: 'IncidentReported' as const, incident };
  const after = reducer(initialArchState, event).state;
  const traces = operationAndIncidentTraceEvents(initialArchState, after, event);
  assert.equal(traces.length, 1);
  const record = createLivePipelineTraceRecord(traces[0]!, {
    hmacKey: 'trace-key', wallTimestampMs: 1, monoMs: 1,
  });
  assert.equal(record.incidentSeverity, 'warning');
  assert.equal(record.incidentCertainty, 'ambiguous');
  assert.equal(record.incidentPhase, 'transport');
  assert.ok(record.incidentHash);
  assert.ok(record.operationHash);
  assert.doesNotMatch(JSON.stringify(record), /req-internal|AUTHORIZATION|credential-secret|detail-secret|semantic-id|private/u);
});
