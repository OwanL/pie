import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSourceConflictError,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import type { ToolCall } from '../../src/shared/protocol.js';
import { canonicalAnalyticsToolEntityId } from '../../../shared/analytics/transport.js';
import { analyzeToolCall } from '../../src/shared/tool-call-analysis/index.js';
import { CanonicalAnalyticsCapture } from '../../src/analytics/canonical-capture.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';
import {
  buildToolFacetFields,
  deriveToolFacetEvidence,
  MAX_TOOL_FACET_PATHS,
  toolFacetId,
} from '../../src/analytics/tool-facet.js';
import { createInitialArchState } from '../../src/host/core/arch-state.js';
import { StatsService } from '../../src/host/stats-service/index.js';

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (location: string) => { close(): void; exec(sql: string): void };
};

type TestSink = NonNullable<ConstructorParameters<typeof CanonicalAnalyticsCapture>[0]['sink']>;

function tempDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-tool-facet-'));
  return { root, databasePath: path.join(root, 'analytics.sqlite') };
}

function canonicalCapture(
  sink: TestSink,
  options: {
    generationId?: string;
    observations?: AnalyticsObservation[];
    onCaptureError?: (error: Error) => void;
  } = {},
): CanonicalAnalyticsCapture {
  const collector = options.observations;
  return new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: options.generationId ?? 'generation-facet',
    workspaceId: 'workspace-facet',
    buildId: 'build-facet',
    processGeneration: 'process-facet',
    sink: collector
      ? { submit: (observation) => { collector.push(observation as AnalyticsObservation); } }
      : sink,
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    onCaptureError: options.onCaptureError,
  });
}

function captureOver(
  recorder: SqliteAnalyticsRecorder,
  options: {
    processGeneration?: string;
    onCaptureError?: (error: Error) => void;
  } = {},
): CanonicalAnalyticsCapture {
  return new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-facet',
    workspaceId: 'workspace-facet',
    buildId: 'build-facet',
    processGeneration: options.processGeneration ?? 'process-facet',
    sink: recorder,
    detailSink: recorder,
    lifecycleSink: {
      bindPendingCreate: async (
        pendingOperationId: string, rootSessionId: string, sourceKey: string, timestampMs: number,
      ) => recorder.bindPendingCreate(pendingOperationId, rootSessionId, sourceKey, timestampMs),
      deleteSession: async (
        rootSessionId: string, sourceKey: string, timestampMs: number, pendingOperationId?: string,
      ) => recorder.deleteSession(rootSessionId, sourceKey, timestampMs, pendingOperationId),
    },
    onCaptureError: options.onCaptureError,
  });
}

function facetObservation(rootSessionId: string, scopedToolCallId: string): AnalyticsObservation {
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-facet',
    producerKind: 'test',
    sourceKey: `tool-facet:${scopedToolCallId}`,
    entityKind: 'toolFacet' as const,
    entityKey: toolFacetId(scopedToolCallId),
    observationKind: 'observation' as const,
    observedAtMs: 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known' as const,
      workspaceId: 'workspace-facet',
      rootSessionId,
    },
    captureSubject: { kind: 'session' as const, rootSessionId },
    producer: { buildId: 'build-facet', processGeneration: 'process-facet' },
    fields: {
      toolCallId: scopedToolCallId,
      facetId: toolFacetId(scopedToolCallId),
      verification: 'not_applicable',
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function detail(payloadId: string): AnalyticsDetailCapture {
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-facet',
    payloadId,
    sourceKey: payloadId,
    observedAtMs: 1_750_000_000_000,
    captureSubject: { kind: 'session', rootSessionId: 'root-detail' },
    mediaType: 'application/x-pie-subagent-result',
    encoding: 'node-v8',
    complete: true,
    bytes: serialize({ retained: true }),
    metadata: {},
  };
}

function tool(overrides: Partial<ToolCall> & Pick<ToolCall, 'id' | 'name' | 'input'>): ToolCall {
  return {
    status: 'completed',
    startedAt: 1_000,
    endedAt: 1_100,
    ...overrides,
  };
}

const BASH_TOOL = tool({
  id: 'tool-bash-1',
  name: 'bash',
  input: { command: 'rg pattern src/' },
});

const WRITE_TOOL = tool({
  id: 'tool-write-1',
  name: 'write',
  input: { filePath: 'src/report.md', content: 'alpha\nbeta\ngamma' },
});

const PATCH_TOOL = tool({
  id: 'tool-patch-1',
  name: 'apply_patch',
  input: { input: [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '-const a = 1;',
    '+const a = 2;',
    '*** Add File: src/b.ts',
    '+const b = 3;',
    '*** End Patch',
  ].join('\n') },
});

test('terminal tool facet flows producer to recorder and reads back through the versioned view', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const capture = captureOver(recorder);
    const context = { sessionId: 'session-facet', sessionPath: '/sensitive/session.jsonl' };
    assert.equal(capture.captureTool(context, BASH_TOOL, 'end', `tool:${BASH_TOOL.id}:end`, 1_100), 'submitted');
    assert.equal(
      capture.captureToolFacet(context, BASH_TOOL, analyzeToolCall(BASH_TOOL), '/workspace', 1_100),
      'submitted',
    );

    // The facet links to the tool-call fact through the same scoped identity.
    const toolEntityKey = String(recorder.executeReadOnlyQuery(
      "SELECT entity_key FROM analytics_observations WHERE entity_kind = 'toolCall'",
    ).rows[0]!.entity_key);

    const read = recorder.readToolFacetProjection();
    assert.equal(read.facets.length, 1);
    const facet = read.facets[0]!;
    assert.equal(facet.facetId, toolFacetId(toolEntityKey));
    assert.equal(facet.toolCallId, toolEntityKey);
    assert.equal(facet.rootSessionId, 'session-facet');
    assert.deepEqual(facet.commands, ['rg pattern src/']);
    assert.equal(facet.cwd, '/workspace');
    assert.equal(facet.observedPaths, null, 'shell text is never interpreted as observed paths');
    assert.equal(facet.attemptedAddedLines, null, 'no line-activity evidence stays absent, not zero');
    assert.equal(facet.attemptedRemovedLines, null);
    assert.equal(facet.verification, 'not_applicable');
    assert.equal(recorder.getStats().accepted, 2, 'the tool fact and its facet are both accepted');

    // The versioned view exposes the same maintained state.
    const viewRow = recorder.executeReadOnlyQuery('SELECT * FROM analytics_tool_facet_v1').rows[0]!;
    assert.equal(String(viewRow.facet_id), facet.facetId);
    assert.equal(String(viewRow.tool_call_id), facet.toolCallId);
    assert.equal(String(viewRow.cwd), '/workspace');
    assert.equal(String(viewRow.verification), 'not_applicable');
    assert.equal(viewRow.attempted_added_lines === null, true);
    assert.equal(String(JSON.parse(String(viewRow.commands_json))[0]), 'rg pattern src/');

    // Session-scoped reads isolate by root and validate their bounds.
    assert.equal(recorder.readToolFacetProjection({ rootSessionId: 'session-facet' }).facets.length, 1);
    assert.equal(recorder.readToolFacetProjection({ rootSessionId: 'other-root' }).facets.length, 0);
    assert.throws(
      () => recorder.readToolFacetProjection({ rootSessionId: 'bad\0root' }),
      /non-empty string without NUL/,
    );
    assert.throws(() => recorder.readToolFacetProjection({ limit: 0 }), /positive safe integer/);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('exact redelivery of a terminal facet stays idempotent at the recorder', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const capture = captureOver(recorder);
    const context = { sessionId: 'session-facet', sessionPath: '/session.jsonl' };
    const analysis = analyzeToolCall(PATCH_TOOL);
    assert.equal(capture.captureToolFacet(context, PATCH_TOOL, analysis, null, 1_100), 'submitted');
    const revisionAfterFirst = recorder.readToolFacetProjection().projectionRevision;

    // A duplicate terminal event redelivers the identical evidence envelope:
    // the stable scoped source key and identity make the redelivery a
    // duplicate that neither adds rows nor advances the projection.
    assert.equal(capture.captureToolFacet(context, PATCH_TOOL, analysis, null, 1_100), 'submitted');

    assert.equal(recorder.countTypedEntityObservations('toolFacet'), 1);
    assert.equal(recorder.getStats().duplicates, 1);
    const read = recorder.readToolFacetProjection();
    assert.equal(read.facets.length, 1);
    assert.equal(read.projectionRevision, revisionAfterFirst,
      'a duplicate observation must not advance the facet projection');

    // Conflicting content under the same stable identity is rejected visibly.
    const scopedToolCallId = canonicalAnalyticsToolEntityId('session-facet', PATCH_TOOL.id);
    const conflicting = facetObservation('session-facet', scopedToolCallId);
    conflicting.fields = { ...conflicting.fields, verification: 'verified' };
    assert.throws(() => recorder.submitBatch([conflicting]), AnalyticsSourceConflictError);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('facet evidence keeps unknown, zero, failed and capped terminal evidence distinct', () => {
  const cwd = '/workspace';

  // A shell command carries command evidence and is never a process census.
  const bash = deriveToolFacetEvidence(BASH_TOOL, analyzeToolCall(BASH_TOOL), cwd);
  assert.deepEqual(bash.commands, ['rg pattern src/']);
  assert.deepEqual(bash.observedPaths, []);
  assert.equal(bash.attemptedAddedLines, null);
  assert.equal(bash.attemptedRemovedLines, null);
  assert.equal(bash.verification, 'not_applicable');

  // A create tool carries attempted line counts including an explicit zero for
  // deletions: zero evidence and unavailable evidence must remain distinct.
  const write = deriveToolFacetEvidence(WRITE_TOOL, analyzeToolCall(WRITE_TOOL), cwd);
  assert.deepEqual(write.commands, []);
  assert.deepEqual(write.observedPaths, ['src/report.md']);
  assert.equal(write.attemptedAddedLines, 3);
  assert.equal(write.attemptedRemovedLines, 0);
  assert.equal(write.verification, 'unverified',
    'input-derived counts are an explicitly unverified proxy, never a worktree diff');

  // A patch tool contributes every observed patch path plus patch-derived
  // counts: one modification and one addition, zero deletions.
  const patch = deriveToolFacetEvidence(PATCH_TOOL, analyzeToolCall(PATCH_TOOL), cwd);
  assert.deepEqual(patch.observedPaths, ['src/a.ts', 'src/b.ts']);
  assert.equal(patch.attemptedAddedLines, 1);
  assert.equal(patch.attemptedRemovedLines, 0);
  assert.equal(patch.verification, 'unverified');

  // A failed terminal preserves its attempted mutation evidence instead of
  // erasing it: the attempt happened even though the tool did not succeed.
  const failedWrite = tool({ ...WRITE_TOOL, status: 'failed' });
  const failedEvidence = deriveToolFacetEvidence(failedWrite, analyzeToolCall(failedWrite), cwd);
  assert.equal(failedEvidence.attemptedAddedLines, 3);
  assert.equal(failedEvidence.verification, 'unverified');

  // An empty create keeps its explicit zero line count.
  const emptyWrite = tool({ id: 'tool-empty-1', name: 'write', input: { filePath: 'src/empty.md', content: '' } });
  const emptyEvidence = deriveToolFacetEvidence(emptyWrite, analyzeToolCall(emptyWrite), cwd);
  assert.equal(emptyEvidence.attemptedAddedLines, 0);
  assert.equal(emptyEvidence.verification, 'unverified');

  // A read is not a mutation: path evidence survives without line counts.
  const readTool = tool({ id: 'tool-read-1', name: 'read', input: { filePath: 'src/read.ts' } });
  const readEvidence = deriveToolFacetEvidence(readTool, analyzeToolCall(readTool), cwd);
  assert.deepEqual(readEvidence.observedPaths, ['src/read.ts']);
  assert.equal(readEvidence.attemptedAddedLines, null);
  assert.equal(readEvidence.verification, 'not_applicable');

  // A completely unknown tool yields an identity plus the not-applicable
  // classification only; no invented evidence.
  const unknownTool = tool({ id: 'tool-unknown-1', name: 'mystery_tool', input: {} });
  assert.deepEqual(buildToolFacetFields(unknownTool, analyzeToolCall(unknownTool), 'tool-unknown-1', cwd), {
    toolCallId: 'tool-unknown-1',
    facetId: toolFacetId('tool-unknown-1'),
    cwd,
    verification: 'not_applicable',
  });

  // Observed paths stay a bounded projection of the input/patch.
  const manyAdds = Array.from({ length: 80 }, (_entry, index) => `*** Add File: src/f${index}.ts\n+content`);
  const cappedTool = tool({ id: 'tool-capped-1', name: 'apply_patch', input: { input: manyAdds.join('\n') } });
  const capped = deriveToolFacetEvidence(cappedTool, analyzeToolCall(cappedTool), cwd);
  assert.equal(capped.observedPaths.length, MAX_TOOL_FACET_PATHS);
  assert.equal(capped.attemptedAddedLines, 80, 'counts are not truncated, only the path projection is');
  assert.equal(capped.verification, 'unverified');

  // An absent cwd stays absent instead of becoming an empty string.
  assert.equal(deriveToolFacetEvidence(WRITE_TOOL, analyzeToolCall(WRITE_TOOL), undefined).cwd, null);
  assert.equal(deriveToolFacetEvidence(WRITE_TOOL, analyzeToolCall(WRITE_TOOL), '   ').cwd, null);
  assert.equal(deriveToolFacetEvidence(WRITE_TOOL, analyzeToolCall(WRITE_TOOL), cwd).cwd, cwd);
});

test('private close deletes facet evidence without leaking across roots and rejects late facets', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const capture = captureOver(recorder);
    const rootA = { sessionId: 'session-a', sessionPath: '/session-a.jsonl' };
    const rootB = { sessionId: 'session-b', sessionPath: '/session-b.jsonl' };
    assert.equal(capture.captureToolFacet(rootA, WRITE_TOOL, analyzeToolCall(WRITE_TOOL), null, 1_100), 'submitted');
    assert.equal(capture.captureToolFacet(rootB, BASH_TOOL, analyzeToolCall(BASH_TOOL), null, 1_100), 'submitted');

    // Trusted-subject close removes both the observation and the state rows
    // for the deleted root only.
    assert.ok(recorder.deleteSession('session-a', 'close:session-a', 2_000));

    const read = recorder.readToolFacetProjection();
    assert.equal(read.facets.length, 1);
    assert.equal(read.facets[0]!.rootSessionId, 'session-b');
    assert.equal(recorder.countTypedEntityObservations('toolFacet', 'session-a'), 0);
    assert.equal(recorder.countTypedEntityObservations('toolFacet', 'session-b'), 1);

    // A late facet for the deleted root is rejected visibly, not absorbed.
    assert.throws(
      () => recorder.submitBatch([facetObservation('session-a', 'tool:late')]),
      /Analytics capture subject is deleted/,
    );
    assert.equal(recorder.countTypedEntityObservations('toolFacet', 'session-a'), 0);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('pending-create facets rebind to the trusted session identity without cross-root leakage', async () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const capture = captureOver(recorder);
    // No stable session id yet: the facet is bound to the pending operation.
    const pendingContext = { sessionId: null, operationId: 'operation-facet', sessionPath: '/pending/session.jsonl' };
    assert.equal(
      capture.captureToolFacet(pendingContext, WRITE_TOOL, analyzeToolCall(WRITE_TOOL), null, 1_100),
      'submitted',
    );

    let read = recorder.readToolFacetProjection();
    assert.equal(read.facets.length, 1);
    assert.equal(read.facets[0]!.rootSessionId, null,
      'a pending-create facet has no root session identity before binding');

    // The capture-level bind derives the same hashed pending identity the
    // observations carry, so the trusted bind reaches every facet row.
    await capture.bindPendingCreate('/pending/session.jsonl', 'session-bound', 2_000, 'operation-facet');
    read = recorder.readToolFacetProjection();
    assert.equal(read.facets.length, 1);
    assert.equal(read.facets[0]!.rootSessionId, 'session-bound');
    assert.equal(recorder.countTypedEntityObservations('toolFacet', 'session-bound'), 1);
    const observationRow = recorder.executeReadOnlyQuery(
      'SELECT root_session_id, capture_subject_kind, capture_subject_key FROM analytics_tool_facet_observations',
    ).rows[0]!;
    assert.equal(String(observationRow.root_session_id), 'session-bound');
    assert.equal(String(observationRow.capture_subject_kind), 'session');
    assert.equal(String(observationRow.capture_subject_key), 'session-bound');
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('v12 to v13 migration preserves schema12 data and never backfills facet history', () => {
  const temp = tempDatabase();
  let recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  let captureErrors: Error[] = [];
  let observationsBeforeDowngrade: number;
  try {
    const capture = captureOver(recorder, { onCaptureError: (error) => captureErrors.push(error) });
    const context = { sessionId: 'session-migrated', sessionPath: '/session.jsonl' };
    capture.captureTool(context, WRITE_TOOL, 'end', `tool:${WRITE_TOOL.id}:end`, 1_100);
    capture.captureToolFacet(context, WRITE_TOOL, analyzeToolCall(WRITE_TOOL), '/workspace', 1_100);
    capture.captureToolFacet(
      { sessionId: 'session-late', sessionPath: '/late.jsonl' },
      WRITE_TOOL,
      analyzeToolCall(WRITE_TOOL),
      null,
      1_100,
    );
    recorder.submitDetail(detail('legacy-detail'));
    recorder.deleteSession('session-deleted', 'close:deleted', 1_200);
    observationsBeforeDowngrade = recorder.countObservations();
    assert.equal(recorder.countTypedEntityObservations('toolFacet'), 2);
  } finally {
    recorder.close();
  }

  // Rewind to schema12 and drop the facet storage entirely, exactly as a
  // database from before the facet schema would look.
  const raw = new DatabaseSync(temp.databasePath);
  try {
    raw.exec(`
      DROP VIEW analytics_tool_facet_v1;
      DROP INDEX analytics_tool_facet_observation_subject_idx;
      DROP INDEX analytics_tool_facet_observation_root_idx;
      DROP INDEX analytics_tool_facet_observation_identity_idx;
      DROP INDEX analytics_tool_facet_state_subject_idx;
      DROP INDEX analytics_tool_facet_state_root_idx;
      DROP INDEX analytics_tool_facet_state_order_idx;
      DROP TABLE analytics_tool_facet_observations;
      DROP TABLE analytics_tool_facet_states;
      PRAGMA user_version = 12;
    `);
  } finally {
    raw.close();
  }

  recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    assert.equal(recorder.getDatabaseSchemaVersion(), 13);

    // Schema12 data is untouched: the registry, the detail payload and the
    // deletion marker all survive, and facet history is not reconstructed
    // from tool observations or transcripts.
    assert.equal(recorder.countObservations(), observationsBeforeDowngrade,
      'schema12 registry rows are preserved untouched by the facet migration');
    assert.deepEqual(recorder.reconstructDetail('legacy-detail'), { retained: true });

    captureErrors = [];
    // The post-upgrade capture models a restarted producer: a fresh process
    // generation owns a fresh delivery sequence under the same generation.
    const postMigrationCapture = captureOver(recorder, {
      processGeneration: 'process-facet-2',
      onCaptureError: (error) => captureErrors.push(error),
    });
    assert.equal(
      postMigrationCapture.captureToolFacet(
        { sessionId: 'session-deleted', sessionPath: '/deleted.jsonl' },
        WRITE_TOOL,
        analyzeToolCall(WRITE_TOOL),
        null,
        1_300,
      ),
      'rejected',
      'the preserved deletion marker still rejects post-upgrade capture',
    );
    assert.equal(captureErrors.length, 1);
    assert.equal(captureErrors[0]!.message.includes('Analytics capture subject is deleted'), true);
    assert.equal(recorder.countTypedEntityObservations('toolFacet'), 0,
      'facet history is not reconstructed from tool observations or transcripts');

    // New facet evidence accumulates only from post-upgrade capture. The
    // pre-upgrade facet identity is still conflict-protected in the preserved
    // registry, so fresh capture uses a fresh scoped tool identity.
    const postUpgradeTool = tool({ id: 'tool-write-2', name: 'write', input: { filePath: 'src/new.md', content: 'x\ny\nz' } });
    assert.equal(
      postMigrationCapture.captureToolFacet(
        { sessionId: 'session-migrated', sessionPath: '/session.jsonl' },
        postUpgradeTool,
        analyzeToolCall(postUpgradeTool),
        '/workspace',
        1_400,
      ),
      'submitted',
    );
    const read = recorder.readToolFacetProjection({ rootSessionId: 'session-migrated' });
    assert.equal(read.facets.length, 1);
    assert.equal(read.facets[0]!.attemptedAddedLines, 3);
    assert.equal(read.facets[0]!.cwd, '/workspace');

    // Reopening again must not duplicate or re-seed anything.
    recorder.close();
    recorder = new SqliteAnalyticsRecorder(temp.databasePath);
    assert.equal(recorder.countTypedEntityObservations('toolFacet'), 1);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('facet capture never awaits or is gated by the recorder sink', () => {
  const context = { sessionId: 'session-facet', sessionPath: '/session.jsonl' };
  const analysis = analyzeToolCall(WRITE_TOOL);

  // A sink that never resolves its submission cannot gate the producer: the
  // observation is handed off synchronously and the call returns immediately.
  let sinkCalled = 0;
  const unresolvedCapture = canonicalCapture({
    submit: () => {
      sinkCalled += 1;
      return new Promise<void>(() => undefined);
    },
  });
  assert.equal(unresolvedCapture.captureToolFacet(context, WRITE_TOOL, analysis, null, 1_100), 'submitted');
  assert.equal(sinkCalled, 1);

  // A throwing sink is reported through the capture error channel instead of
  // breaking the calling execution path.
  const errors: Error[] = [];
  const throwingCapture = canonicalCapture({
    submit: () => {
      throw new Error('sink exploded');
    },
  }, { onCaptureError: (error) => errors.push(error) });
  assert.equal(throwingCapture.captureToolFacet(context, WRITE_TOOL, analysis, null, 1_100), 'rejected');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.message, 'sink exploded');
});

test('StatsService emits the terminal facet from the shared analysis without gating execution', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-tool-facet-seam-'));
  try {
    const sessionPath = '/workspace/seam-session.jsonl';
    const state = createInitialArchState();
    state.sessions.sessions = [{
      path: sessionPath,
      sessionId: 'session-seam',
      name: 'Seam',
      cwd: '/workspace-seam',
      modifiedAt: '2026-09-13T00:00:00.000Z',
      messageCount: 0,
      modelId: 'fixture-model',
      provider: 'fixture-provider',
    }];
    const observations: AnalyticsObservation[] = [];
    const capture = canonicalCapture({ submit: () => undefined }, { observations });
    const stats = new StatsService({
      dataOutcomesRootPath: path.join(root, 'outcomes'),
      legacyUsageDataRootPath: root,
      workspaceId: 'workspace-seam',
      getArchState: () => state,
      now: () => new Date('2026-09-13T00:00:10.000Z'),
      createId: () => 'seam-id',
      analyticsCapture: capture,
    });
    try {
      stats.prepareForSend(sessionPath, []);
      stats.onToolStarted(sessionPath, {
        id: 'tool-write-1', name: 'write', input: WRITE_TOOL.input, status: 'running', startedAt: 1_000,
      });
      stats.onToolFinished(sessionPath, { ...WRITE_TOOL, id: 'tool-write-1' });

      const toolFact = observations.find((entry) => entry.entityKind === 'toolCall');
      const facets = observations.filter((entry) => entry.entityKind === 'toolFacet');
      assert.ok(toolFact, 'the terminal tool fact is still captured');
      assert.equal(facets.length, 1);
      const facet = facets[0]!;
      const fields = facet.fields as unknown as AnalyticsToolFacetFieldShape;
      assert.equal(fields.toolCallId, toolFact!.entityKey,
        'facet and tool fact share one scoped tool identity');
      assert.equal(fields.cwd, '/workspace-seam', 'the session cwd is resolved at the seam');
      assert.deepEqual(fields.observedPaths, ['src/report.md']);
      assert.equal(fields.attemptedAddedLines, 3);
      assert.equal(fields.attemptedRemovedLines, 0);
      assert.equal(fields.verification, 'unverified');
      assert.equal(fields.commands, undefined, 'a write tool carries no command evidence');
      assert.equal(JSON.stringify(facet).includes('/workspace/seam-session.jsonl'), false,
        'session paths are never persisted into facet fields');
      assert.equal(facet.captureSubject.kind, 'session');
      assert.equal((facet.captureSubject as { rootSessionId: string }).rootSessionId, 'session-seam');

      // A duplicate terminal event redelivers an identical facet envelope:
      // same source key, so the recorder-side dedupe absorbs it exactly once.
      stats.onToolFinished(sessionPath, { ...WRITE_TOOL, id: 'tool-write-1' });
      const facetsAfterDuplicate = observations.filter((entry) => entry.entityKind === 'toolFacet');
      assert.equal(facetsAfterDuplicate.length, 2);
      assert.equal(facetsAfterDuplicate[1]!.sourceKey, facetsAfterDuplicate[0]!.sourceKey);
      assert.deepEqual(facetsAfterDuplicate[1]!.idempotencyKey, facetsAfterDuplicate[0]!.idempotencyKey);

      // The shared analysis also reached the run tracker: file-mutation run
      // accounting stays intact and is not double-counted by the duplicate.
      const run = stats.getOpenRuns().find((entry) => entry.sessionPath === sessionPath);
      assert.ok(run);
      assert.equal(run.fileMutation?.writeCount, 1);

      // Legacy authority: no canonical capture, no facet work, no crash.
      const legacyStats = new StatsService({
        dataOutcomesRootPath: path.join(root, 'outcomes'),
        legacyUsageDataRootPath: root,
        workspaceId: 'workspace-seam',
        getArchState: () => state,
        now: () => new Date('2026-09-13T00:00:11.000Z'),
        createId: () => 'legacy-id',
      });
      try {
        legacyStats.onToolStarted(sessionPath, {
          id: 'tool-legacy-1', name: 'write', input: WRITE_TOOL.input, status: 'running', startedAt: 1_000,
        });
        legacyStats.onToolFinished(sessionPath, { ...WRITE_TOOL, id: 'tool-legacy-1' });
        assert.equal(observations.filter((entry) => entry.entityKind === 'toolFacet').length, 2,
          'legacy authority must not add facet observations');
      } finally {
        await legacyStats.shutdown();
      }
    } finally {
      await stats.shutdown();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface AnalyticsToolFacetFieldShape {
  toolCallId: string;
  facetId: string;
  commands?: string[];
  cwd?: string;
  observedPaths?: string[];
  attemptedAddedLines?: number;
  attemptedRemovedLines?: number;
  verification: string;
}