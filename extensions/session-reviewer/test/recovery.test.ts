import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import registerSessionReviewer from '../index.js';
import { compileRecoveredReview, getReviewRecoveryStatus, reviewEvidenceKey, reviewWorkflowRef } from '../src/recovery.js';
import { validateRuntimeProvenance } from '../src/runtime-provenance.js';
import type { EvidenceManifest, ReviewWorkflowRole } from '../src/types.js';
import { legacyReviewWorkflowRef } from '../src/workflow.js';
import { evidenceVector, frozenCriterion, processVector } from './fixtures.js';

function appendEntry(file: string, entry: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function appendRole(
  file: string,
  sessionId: string,
  role: ReviewWorkflowRole,
  requestedBucket: 'small' | 'medium',
  payload: unknown,
  evidenceKey: string,
  options: {
    agent?: string;
    callBucket?: 'small' | 'medium';
    runtimeRequestedBucket?: 'small' | 'medium';
    runtimeBucket?: 'small' | 'medium' | 'frontier';
    runtimeBucketDowngraded?: boolean;
    idSuffix?: string;
    finalOutput?: string;
    workflowRef?: string;
  } = {},
): void {
  const id = `call-${role}${options.idSuffix ? `-${options.idSuffix}` : ''}`;
  const promptHash = `hash-${role}`;
  appendEntry(file, {
    type: 'message', id: `assistant-${role}`,
    message: {
      role: 'assistant',
      content: [{
        type: 'toolCall', id, name: 'subagent',
        arguments: { agent: options.agent ?? 'session-evaluator', task: `review ${role}`, bucket: options.callBucket ?? requestedBucket, workflowRef: options.workflowRef ?? reviewWorkflowRef(sessionId, role, evidenceKey) },
      }],
    },
  });
  appendEntry(file, {
    type: 'message', id: `result-${role}`,
    message: {
      role: 'toolResult', toolCallId: id, toolName: 'subagent',
      content: [{ type: 'text', text: options.finalOutput ?? JSON.stringify(payload) }],
      details: { results: [{
        parentToolCallId: id,
        exitCode: 0,
        finalOutput: options.finalOutput ?? JSON.stringify(payload),
        requestedBucket: options.runtimeRequestedBucket ?? requestedBucket,
        bucket: options.runtimeBucket ?? options.runtimeRequestedBucket ?? requestedBucket,
        bucketDowngraded: options.runtimeBucketDowngraded ?? false,
        model: `model-${role}`,
        provider: requestedBucket === 'small' ? 'provider-small' : 'provider-medium',
        family: requestedBucket === 'small' ? 'family-small' : 'family-medium',
        thinkingLevel: role.startsWith('classification') ? 'medium' : 'high',
        promptHash,
      }] },
    },
  });
}

function appendCompletePipeline(
  file: string,
  sessionId: string,
  evidenceKey: string,
  selectedHumanQuestion?: { criterionId: string; domain: string; expectedObservation: string; proposedQuestion: string; options: string[] },
): void {
  appendRole(file, sessionId, 'proposal-small', 'small', { criteria: [frozenCriterion] }, evidenceKey);
  appendRole(file, sessionId, 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, evidenceKey);
  // The cursor deliberately points after the proposal calls. Recovery must use
  // the append-only JSONL, not the model's post-compaction context branch.
  appendEntry(file, {
    type: 'compaction', id: 'compact-mid-review', parentId: 'result-proposal-medium',
    firstKeptEntryId: 'after-proposals', tokensBefore: 255_000,
    summary: 'Review work is in progress, but exact reviewer details were summarized.',
  });
  appendRole(file, sessionId, 'consolidation', 'medium', {
    frozenLedger: [frozenCriterion], dedupNotes: ['identical proposals'],
    ...(selectedHumanQuestion ? { selectedHumanQuestion } : {}),
  }, evidenceKey);
  const classification = {
    criteria: [{ criterionId: frozenCriterion.criterionId, status: 'met', reason: 'none', evidenceRefs: ['transcript:1'] }],
    process: processVector,
    evidence: evidenceVector,
    confidence: 'high',
  };
  appendRole(file, sessionId, 'classification-small', 'small', classification, evidenceKey);
  appendRole(file, sessionId, 'classification-medium', 'medium', classification, evidenceKey);
}

function registerTool(): any {
  let tool: any;
  registerSessionReviewer({ registerTool(value: unknown) { tool = value; } } as any);
  return tool;
}

test('tagged review pipeline survives history compaction and backend restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-recovery-'));
  const targetPath = path.join(dir, 'target.jsonl');
  const laterTargetPath = path.join(dir, 'later-target.jsonl');
  const selfPath = path.join(dir, 'self.jsonl');
  appendEntry(targetPath, { type: 'session', id: 'target-id' });
  appendEntry(targetPath, { type: 'message', id: 'target-user', message: { role: 'user', content: 'implement it' } });
  appendEntry(laterTargetPath, { type: 'session', id: 'later-target-id' });
  appendEntry(selfPath, { type: 'session', id: 'self-id' });
  const savedDir = process.env.PIE_REVIEWS_DIR;
  const savedTabs = process.env.PIE_OPEN_TABS;
  process.env.PIE_REVIEWS_DIR = dir;
  process.env.PIE_OPEN_TABS = JSON.stringify([
    { path: targetPath, name: 'target', pinned: true, isRunning: false },
    { path: laterTargetPath, name: 'later target', pinned: true, isRunning: false },
    { path: selfPath, name: 'reviewer', pinned: false, isRunning: false },
  ]);
  const ctx = { sessionManager: { getSessionFile: () => selfPath } };
  try {
    const firstTool = registerTool();
    await firstTool.execute('list-1', { action: 'listSelected' }, undefined, undefined, ctx);
    const evidence = await firstTool.execute('evidence-1', { action: 'getEvidence', sessionPath: targetPath }, undefined, undefined, ctx);
    assert.equal(evidence.isError, false);
    // The real SDK persists this tool result automatically. The focused harness
    // writes the same durable shape explicitly before simulating a restart.
    appendEntry(selfPath, {
      type: 'message', id: 'evidence-result',
      message: {
        role: 'toolResult', toolCallId: 'evidence-1', toolName: 'session_review',
        content: evidence.content,
        details: evidence.details,
      },
    });
    appendCompletePipeline(selfPath, 'target-id', reviewEvidenceKey(evidence.details.manifest));

    // New registration means all extension-local orchestratorSnapshots state is
    // gone. listSelected must rehydrate the issued manifest from JSONL.
    const restartedTool = registerTool();
    await restartedTool.execute('list-2', { action: 'listSelected' }, undefined, undefined, ctx);
    appendEntry(selfPath, {
      type: 'message', id: 'follow-up-user',
      message: { role: 'user', content: 'keep closing reviewed sessions as you go' },
    });
    const status = await restartedTool.execute('status', { action: 'getReviewStatus', sessionId: 'target-id' }, undefined, undefined, ctx);
    assert.equal(status.isError, false, status.content[0].text);
    assert.equal(status.details.next, 'ready-to-record');
    assert.ok(status.details.completedRoles.includes('proposal-small'));
    assert.ok(status.details.completedRoles.includes('classification-medium'));

    const recorded = await restartedTool.execute('record', { action: 'recordRecoveredReview', sessionId: 'target-id' }, undefined, undefined, ctx);
    assert.equal(recorded.isError, false, recorded.content[0].text);
    assert.match(recorded.content[0].text, /Recovered and recorded production review/);
    const duplicateRecord = await restartedTool.execute('record-retry', { action: 'recordRecoveredReview', sessionId: 'target-id' }, undefined, undefined, ctx);
    assert.equal(duplicateRecord.isError, false, duplicateRecord.content[0].text);
    assert.match(duplicateRecord.content[0].text, /already has canonical production review/);

    const persisted = fs.readFileSync(path.join(dir, 'reviews.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))[0];
    assert.equal(persisted.sessionId, 'target-id');
    assert.equal(persisted.proposals[0].toolCallId, 'call-proposal-small');
    assert.equal(persisted.components[1].modelId, 'model-classification-medium');
    assert.equal(persisted.provenance.orchestratorSessionId, 'self-id');

    const closed = await restartedTool.execute('close-target', {
      action: 'closeReviewed', sessionId: 'target-id', reviewId: recorded.details.review.reviewId, sessionPath: targetPath,
    }, undefined, undefined, ctx);
    assert.equal(closed.isError, false, closed.content[0].text);

    const laterEvidence = await restartedTool.execute('later-evidence', { action: 'getEvidence', sessionPath: laterTargetPath }, undefined, undefined, ctx);
    assert.equal(laterEvidence.isError, false);
    const laterStatus = await restartedTool.execute('later-status', { action: 'getReviewStatus', sessionId: 'later-target-id' }, undefined, undefined, ctx);
    assert.equal(laterStatus.details.next, 'proposal-small');
    assert.equal(fs.readFileSync(path.join(dir, 'reviews.jsonl'), 'utf8').trim().split('\n').length, 1,
      'a later target failure cannot roll back the already persisted target');
  } finally {
    if (savedDir === undefined) delete process.env.PIE_REVIEWS_DIR; else process.env.PIE_REVIEWS_DIR = savedDir;
    if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS; else process.env.PIE_OPEN_TABS = savedTabs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow refs are evidence-bound and stale roles are not reused for a changed bundle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-evidence-bound-'));
  const selfPath = path.join(dir, 'self.jsonl');
  appendEntry(selfPath, { type: 'session', id: 'self-id' });
  const first: EvidenceManifest = {
    rawJsonlSha256: 'a'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: 'b'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: ['modelId', 'provider', 'thinkingLevel', 'family'], redactedTurnFields: [], notes: [] },
  };
  const changed = { ...first, rawJsonlSha256: 'c'.repeat(64), rawJsonlMtime: '2026-08-09T00:01:00.000Z' };
  try {
    appendRole(selfPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, reviewEvidenceKey(first));
    appendRole(selfPath, 'target-id', 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, reviewEvidenceKey(first));
    const boundStatus = getReviewRecoveryStatus(selfPath, 'target-id', first);
    assert.equal(boundStatus.next, 'consolidation');
    assert.doesNotMatch(JSON.stringify(boundStatus.handoff), /model-|provider-|toolCallId|promptHash/,
      'coordinator handoff must remain authorship-blind');

    const status = getReviewRecoveryStatus(selfPath, 'target-id', changed);
    assert.equal(status.next, 'proposal-small');
    assert.equal(status.completedRoles.includes('proposal-small'), false);
    assert.notEqual(status.workflowRefs['proposal-small'], reviewWorkflowRef('target-id', 'proposal-small', reviewEvidenceKey(first)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status emits a deterministic parallel launch checkpoint with a one-retry budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-checkpoint-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: '7'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: '8'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    const initial = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(initial.checkpoint.state, 'run-roles');
    assert.deepEqual(initial.checkpoint.nextRoles, ['proposal-small', 'proposal-medium']);
    assert.deepEqual(initial.checkpoint.launch.map(({ role, agent, bucket, attempt }) => ({ role, agent, bucket, attempt })), [
      { role: 'proposal-small', agent: 'session-evaluator', bucket: 'small', attempt: 1 },
      { role: 'proposal-medium', agent: 'session-evaluator', bucket: 'medium', attempt: 1 },
    ]);
    assert.match(initial.checkpoint.launch[0]!.taskInstructions, /exactly one raw JSON object/i);
    assert.match(initial.checkpoint.launch[0]!.taskInstructions, /surface values: ui, application_logic/);
    assert.match(initial.checkpoint.launch[0]!.taskInstructions, /Never place an evidenceMode value such as human_observation in surface/);
    assert.doesNotMatch(initial.checkpoint.launch[0]!.taskInstructions, /"surface":\["ui\|/);
    assert.match(initial.checkpoint.launch[0]!.workflowRef, /^session-review-v2\//);

    appendRole(selfPath, 'target-id', 'proposal-small', 'small', {}, key, { finalOutput: 'not json' });
    const retry = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    const smallRetry = retry.checkpoint.launch.find((item) => item.role === 'proposal-small');
    assert.equal(retry.checkpoint.state, 'run-roles');
    assert.equal(smallRetry?.attempt, 2);
    assert.equal(smallRetry?.retriesRemainingAfterLaunch, 0);
    assert.match(smallRetry!.taskInstructions, /prior attempt was rejected by schema validation/i);
    assert.match(smallRetry!.taskInstructions, /not valid JSON/i);

    appendRole(selfPath, 'target-id', 'proposal-small', 'small', {}, key, { finalOutput: 'still not json' });
    const blocked = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(blocked.checkpoint.state, 'blocked');
    assert.equal(blocked.checkpoint.nextAction, 'report-blocker');
    assert.equal(blocked.checkpoint.launch.length, 0);
    assert.deepEqual(blocked.checkpoint.blockedRoles.map(({ role, attempts }) => ({ role, attempts })), [
      { role: 'proposal-small', attempts: 2 },
    ]);

    appendRole(selfPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, key);
    const overBudget = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(overBudget.checkpoint.state, 'run-roles');
    assert.equal(overBudget.next, 'proposal-medium');
    assert.equal(overBudget.checkpoint.attemptsByRole['proposal-small'], 3);
    assert.ok(overBudget.completedRoles.includes('proposal-small'));
    assert.equal(overBudget.checkpoint.launch.some((item) => item.role === 'proposal-small'), false,
      'a durable valid latest result is accepted, but the exhausted role is never launched again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery unwraps one intact JSON object from reviewer prose but rejects ambiguous objects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-json-unwrapper-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: '9'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: '0'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  const proposal = { criteria: [{ ...frozenCriterion, statement: 'Preserves braces such as {value} in strings' }] };
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    appendRole(selfPath, 'target-id', 'proposal-small', 'small', proposal, key, {
      finalOutput: `Analysis complete.\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\`\nDone.`,
    });
    appendRole(selfPath, 'target-id', 'proposal-medium', 'medium', proposal, key);
    const recovered = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(recovered.next, 'consolidation');
    assert.equal(recovered.invalidRoles.length, 0);

    const ambiguousPath = path.join(dir, 'ambiguous.jsonl');
    appendEntry(ambiguousPath, { type: 'session', id: 'self-id' });
    appendRole(ambiguousPath, 'target-id', 'proposal-small', 'small', proposal, key, {
      finalOutput: `${JSON.stringify(proposal)}\n${JSON.stringify({ criteria: [] })}`,
    });
    const ambiguous = getReviewRecoveryStatus(ambiguousPath, 'target-id', manifest);
    assert.equal(ambiguous.next, 'proposal-small');
    assert.match(ambiguous.invalidRoles[0]!.error, /multiple JSON objects/);

    const duplicatePath = path.join(dir, 'duplicate.jsonl');
    appendEntry(duplicatePath, { type: 'session', id: 'self-id' });
    appendRole(duplicatePath, 'target-id', 'proposal-small', 'small', proposal, key, {
      finalOutput: `${JSON.stringify(proposal)}\n${JSON.stringify(proposal)}`,
    });
    const duplicate = getReviewRecoveryStatus(duplicatePath, 'target-id', manifest);
    assert.equal(duplicate.next, 'proposal-small');
    assert.match(duplicate.invalidRoles[0]!.error, /multiple JSON objects/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classification instructions encode dependent pairs and recovery hoists an unambiguously nested evidence vector', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-classification-shape-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: 'a'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: 'b'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  const classification = {
    criteria: [{ criterionId: frozenCriterion.criterionId, status: 'met', reason: 'none', evidenceRefs: ['transcript:1'] }],
    process: processVector,
    evidence: evidenceVector,
    confidence: 'high',
  };
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    appendRole(selfPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, key);
    appendRole(selfPath, 'target-id', 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, key);
    const consolidation = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.match(consolidation.checkpoint.launch[0]!.taskInstructions, /surface values: ui, application_logic/);
    assert.doesNotMatch(consolidation.checkpoint.launch[0]!.taskInstructions, /surface.*valid enum/);

    appendRole(selfPath, 'target-id', 'consolidation', 'medium', { frozenLedger: [frozenCriterion], dedupNotes: [] }, key);
    const classifiers = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    for (const launch of classifiers.checkpoint.launch) {
      assert.match(launch.taskInstructions, /insufficient_artifact_evidence is never valid with partly_met/);
      assert.match(launch.taskInstructions, /process and evidence must be separate top-level sibling objects/);
    }

    appendRole(selfPath, 'target-id', 'classification-small', 'small', classification, key);
    appendRole(selfPath, 'target-id', 'classification-medium', 'medium', {}, key, {
      finalOutput: JSON.stringify({
        criteria: classification.criteria,
        process: { ...processVector, evidence: evidenceVector },
        confidence: 'high',
      }),
    });
    const recovered = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(recovered.next, 'ready-to-record');
    assert.equal(recovered.invalidRoles.length, 0);

    const conflictPath = path.join(dir, 'conflict.jsonl');
    appendEntry(conflictPath, { type: 'session', id: 'self-id' });
    appendRole(conflictPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, key);
    appendRole(conflictPath, 'target-id', 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, key);
    appendRole(conflictPath, 'target-id', 'consolidation', 'medium', { frozenLedger: [frozenCriterion], dedupNotes: [] }, key);
    appendRole(conflictPath, 'target-id', 'classification-small', 'small', classification, key);
    appendRole(conflictPath, 'target-id', 'classification-medium', 'medium', {}, key, {
      finalOutput: JSON.stringify({
        ...classification,
        process: { ...processVector, evidence: { ...evidenceVector, execution: 'none' } },
      }),
    });
    const conflict = getReviewRecoveryStatus(conflictPath, 'target-id', manifest);
    assert.equal(conflict.next, 'classification-medium');
    assert.match(conflict.invalidRoles.find((item) => item.role === 'classification-medium')!.error, /evidence conflicts/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery repairs only unambiguous criterion taxonomy namespace shapes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-taxonomy-shape-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: 'c'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: 'd'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    appendRole(selfPath, 'target-id', 'proposal-small', 'small', {
      criteria: [{
        ...frozenCriterion,
        taxonomy: {
          activity: ['verify'],
          surface: ['tests', 'human_observation'],
          evidenceMode: ['automated_check', 'documentation'],
        },
      }],
    }, key);
    const status = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(status.next, 'proposal-medium');
    assert.equal(status.invalidRoles.length, 0);
    assert.ok(status.completedRoles.includes('proposal-small'));
    // Supply the sibling and inspect the validated proposal handoff.
    appendRole(selfPath, 'target-id', 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, key);
    const paired = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    const repaired = (paired.handoff as any).proposals[0].criteria[0];
    assert.equal(repaired.taxonomy.activity, 'verify');
    assert.deepEqual(repaired.taxonomy.surface, ['tests', 'documentation']);
    assert.deepEqual(repaired.taxonomy.evidenceMode, ['automated_check', 'human_observation']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery canonicalizes bounded adjudication wire-shape mistakes before validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-adjudication-shape-'));
  const manifest: EvidenceManifest = {
    rawJsonlSha256: 'e'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: 'f'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  const seedDisagreement = (file: string): void => {
    appendEntry(file, { type: 'session', id: 'self-id' });
    appendRole(file, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, key);
    appendRole(file, 'target-id', 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, key);
    appendRole(file, 'target-id', 'consolidation', 'medium', { frozenLedger: [frozenCriterion], dedupNotes: [] }, key);
    const common = { process: processVector, evidence: evidenceVector, confidence: 'high' };
    appendRole(file, 'target-id', 'classification-small', 'small', {
      ...common, criteria: [{ criterionId: 'c1', status: 'met', reason: 'none', evidenceRefs: ['small'] }],
    }, key);
    appendRole(file, 'target-id', 'classification-medium', 'medium', {
      ...common, criteria: [{ criterionId: 'c1', status: 'unmet', reason: 'omitted', evidenceRefs: ['medium'] }],
    }, key);
  };
  try {
    const combinedPath = path.join(dir, 'combined.jsonl');
    seedDisagreement(combinedPath);
    appendRole(combinedPath, 'target-id', 'adjudication', 'medium', { resolvedFields: [{
      field: 'criterion:c1.status', value: 'partly_met/omitted', rationale: 'mixed outcome', evidenceRefs: ['small', 'medium'],
    }] }, key);
    assert.equal(getReviewRecoveryStatus(combinedPath, 'target-id', manifest).next, 'ready-to-record');

    const objectPath = path.join(dir, 'object.jsonl');
    seedDisagreement(objectPath);
    appendRole(objectPath, 'target-id', 'adjudication', 'medium', { resolvedFields: {
      'criterion:c1.status': { adjudication: 'partly_met', rationale: 'mixed outcome', evidenceRefs: ['small', 'medium'] },
      'criterion:c1.reason': { adjudication: 'omitted', rationale: 'delivery incomplete', evidenceRefs: ['medium'] },
    } }, key);
    assert.equal(getReviewRecoveryStatus(objectPath, 'target-id', manifest).next, 'ready-to-record');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status validates consolidation runtime metadata before advancing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-consolidation-runtime-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: 'c'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: 'd'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    appendRole(selfPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, key);
    appendRole(selfPath, 'target-id', 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, key);
    appendRole(selfPath, 'target-id', 'consolidation', 'medium', { frozenLedger: [frozenCriterion], dedupNotes: [] }, key, {
      runtimeBucket: 'frontier',
      runtimeBucketDowngraded: true,
    });
    const status = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(status.next, 'consolidation');
    assert.match(status.invalidRoles.find((item) => item.role === 'consolidation')!.error, /effective bucket frontier is not a valid downgrade/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('current checkpoints reuse valid legacy reviewer roles while issuing v2 evaluator refs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-legacy-agent-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: '1'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: '2'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    appendRole(selfPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, key, {
      agent: 'reviewer',
      workflowRef: legacyReviewWorkflowRef('target-id', 'proposal-small', key),
    });
    const status = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.ok(status.completedRoles.includes('proposal-small'));
    assert.equal(status.invalidRoles.length, 0);
    assert.match(status.workflowRefs['proposal-small'], /^session-review-v2\//);
    assert.equal(status.checkpoint.launch.find((item) => item.role === 'proposal-medium')?.agent, 'session-evaluator');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status requests exact material fields and accepts only matching adjudication', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-adjudication-'));
  const selfPath = path.join(dir, 'self.jsonl');
  appendEntry(selfPath, { type: 'session', id: 'self-id' });
  const manifest: EvidenceManifest = {
    rawJsonlSha256: 'd'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: 'e'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: ['modelId', 'provider', 'thinkingLevel', 'family'], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  try {
    appendRole(selfPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, key);
    appendRole(selfPath, 'target-id', 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, key);
    appendRole(selfPath, 'target-id', 'consolidation', 'medium', { frozenLedger: [frozenCriterion], dedupNotes: [] }, key);
    const common = { process: processVector, evidence: evidenceVector, confidence: 'high' };
    appendRole(selfPath, 'target-id', 'classification-small', 'small', {
      ...common, criteria: [{ criterionId: 'c1', status: 'met', reason: 'none', evidenceRefs: ['small'] }],
    }, key);
    appendRole(selfPath, 'target-id', 'classification-medium', 'medium', {
      ...common, criteria: [{ criterionId: 'c1', status: 'unmet', reason: 'omitted', evidenceRefs: ['medium'] }],
    }, key);
    const pending = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(pending.next, 'adjudication');
    assert.deepEqual((pending.handoff as any).materialFields, ['criterion:c1.status', 'criterion:c1.reason']);
    assert.doesNotMatch(JSON.stringify(pending.handoff), /model-|provider-|toolCallId|promptHash/,
      'adjudicator handoff must remain authorship-blind');

    appendRole(selfPath, 'target-id', 'adjudication', 'medium', { resolvedFields: [
      { field: 'criterion:c1.status', value: 'partly_met', rationale: 'mixed direct evidence', evidenceRefs: ['small', 'medium'] },
      { field: 'criterion:c1.reason', value: 'omitted', rationale: 'delivery was incomplete', evidenceRefs: ['medium'] },
    ] }, key);
    assert.equal(getReviewRecoveryStatus(selfPath, 'target-id', manifest).next, 'ready-to-record');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status rejects an invalid latest role at the phase boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-invalid-role-'));
  const targetPath = path.join(dir, 'target.jsonl');
  const selfPath = path.join(dir, 'self.jsonl');
  appendEntry(targetPath, { type: 'session', id: 'target-id' });
  appendEntry(selfPath, { type: 'session', id: 'self-id' });
  const invalidManifest: EvidenceManifest = {
    rawJsonlSha256: 'a'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: 'b'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: ['modelId', 'provider', 'thinkingLevel', 'family'], redactedTurnFields: [], notes: [] },
  };
  appendEntry(selfPath, {
    type: 'message', id: 'evidence-result', message: {
      role: 'toolResult', toolCallId: 'evidence', toolName: 'session_review', content: [],
      details: { sessionId: 'target-id', manifest: invalidManifest },
    },
  });
  appendRole(selfPath, 'target-id', 'proposal-small', 'small', {
    criteria: [{ ...frozenCriterion, taxonomy: { activity: 'invented', surface: ['application_logic'], evidenceMode: ['static_inspection'] } }],
  }, reviewEvidenceKey(invalidManifest));
  const savedDir = process.env.PIE_REVIEWS_DIR;
  const savedTabs = process.env.PIE_OPEN_TABS;
  process.env.PIE_REVIEWS_DIR = dir;
  process.env.PIE_OPEN_TABS = JSON.stringify([
    { path: targetPath, name: 'target', pinned: true, isRunning: false },
    { path: selfPath, name: 'reviewer', pinned: false, isRunning: false },
  ]);
  const ctx = { sessionManager: { getSessionFile: () => selfPath } };
  try {
    const tool = registerTool();
    await tool.execute('list', { action: 'listSelected' }, undefined, undefined, ctx);
    const status = await tool.execute('status', { action: 'getReviewStatus', sessionId: 'target-id' }, undefined, undefined, ctx);
    assert.equal(status.isError, false, status.content[0].text);
    assert.equal(status.details.next, 'proposal-small');
    assert.match(status.details.invalidRoles[0].error, /unsupported value/i);
  } finally {
    if (savedDir === undefined) delete process.env.PIE_REVIEWS_DIR; else process.env.PIE_REVIEWS_DIR = savedDir;
    if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS; else process.env.PIE_OPEN_TABS = savedTabs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery ignores tagged work from an abandoned session branch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-branch-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: 'f'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: 'a'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: ['modelId'], redactedTurnFields: [], notes: [] },
  };
  const ref = reviewWorkflowRef('target-id', 'proposal-small', reviewEvidenceKey(manifest));
  const roleEntry = (entryId: string, parentId: string | null, callId: string, agent: string, criteria: unknown[]) => [
    {
      type: 'message', id: entryId, parentId,
      message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { agent, task: 'review', bucket: 'small', workflowRef: ref } }] },
    },
    {
      type: 'message', id: `${entryId}-result`, parentId: entryId,
      message: {
        role: 'toolResult', toolCallId: callId, toolName: 'subagent', content: [],
        details: { results: [{ parentToolCallId: callId, exitCode: 0, finalOutput: JSON.stringify({ criteria }), requestedBucket: 'small', bucket: 'small', bucketDowngraded: false, model: 'm', provider: 'p', family: 'f', thinkingLevel: 'high', promptHash: 'h' }] },
      },
    },
  ];
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    for (const entry of roleEntry('abandoned', null, 'abandoned-call', 'worker', [])) appendEntry(selfPath, entry);
    for (const entry of roleEntry('active', null, 'active-call', 'session-evaluator', [frozenCriterion])) appendEntry(selfPath, entry);
    const status = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(status.next, 'proposal-medium');
    assert.equal(status.invalidRoles.length, 0);
    assert.ok(status.completedRoles.includes('proposal-small'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery rejects non-evaluator agents and role-inappropriate requested buckets', () => {
  const manifest: EvidenceManifest = {
    rawJsonlSha256: '1'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: '2'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  for (const [label, options, expected] of [
    ['agent', { agent: 'worker' }, /session-evaluator agent/],
    ['bucket', { callBucket: 'medium' as const }, /must request the small bucket/],
  ] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `session-review-${label}-`));
    const selfPath = path.join(dir, 'self.jsonl');
    try {
      appendEntry(selfPath, { type: 'session', id: 'self-id' });
      appendRole(selfPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, reviewEvidenceKey(manifest), options);
      const status = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
      assert.equal(status.next, 'proposal-small');
      assert.match(status.invalidRoles[0]!.error, expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('selected human verification is evidence-current and optional during recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-human-recovery-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: '5'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: '6'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: ['modelId', 'provider', 'thinkingLevel', 'family'], redactedTurnFields: [], notes: [] },
  };
  const selected = {
    criterionId: 'c1', domain: 'UI', expectedObservation: 'Spinner rotates',
    proposedQuestion: 'Does the spinner rotate?', options: ['Yes', 'No'],
  };
  const appendAnswer = (id: string, question: string): void => {
    appendEntry(selfPath, {
      type: 'message', id: `assistant-${id}`, message: {
        role: 'assistant', content: [{
          type: 'toolCall', id, name: 'ask_user', arguments: {
            question, options: selected.options, allowCustom: true, context: 'Observe the running UI without changing state.',
            reviewMeta: { purpose: 'review_human_verification', targetSessionId: 'target-id', targetSessionPath: 'target.jsonl', criterionId: selected.criterionId, domain: selected.domain, expectedObservation: selected.expectedObservation },
          },
        }],
      },
    });
    appendEntry(selfPath, {
      type: 'message', id: `result-${id}`, message: {
        role: 'toolResult', toolCallId: id, toolName: 'ask_user',
        details: { answer: 'Yes', source: 'option', cancelled: false, targetSessionId: 'target-id' },
      },
    });
  };
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    appendAnswer('stale-answer', selected.proposedQuestion);
    appendCompletePipeline(selfPath, 'target-id', reviewEvidenceKey(manifest), selected);
    appendAnswer('mismatched-answer', 'Is some unrelated behavior correct?');

    assert.equal(getReviewRecoveryStatus(selfPath, 'target-id', manifest).next, 'ready-to-record');
    assert.equal(compileRecoveredReview({
      orchestratorPath: selfPath, orchestratorSessionId: 'self-id', sessionId: 'target-id',
      sessionPathAtReview: 'target.jsonl', evidenceManifest: manifest,
    }).humanCheck, undefined);

    appendAnswer('current-answer', selected.proposedQuestion);
    assert.equal(getReviewRecoveryStatus(selfPath, 'target-id', manifest).next, 'ready-to-record');
    const recovered = compileRecoveredReview({
      orchestratorPath: selfPath, orchestratorSessionId: 'self-id', sessionId: 'target-id',
      sessionPathAtReview: 'target.jsonl', evidenceManifest: manifest,
    });
    assert.equal(recovered.humanCheck?.toolCallId, 'current-answer');
    assert.equal(recovered.humanCheck?.input.allowCustom, true);
    assert.equal(recovered.humanCheck?.input.context, 'Observe the running UI without changing state.');
    assert.doesNotThrow(() => validateRuntimeProvenance(recovered, selfPath),
      'recovered human input must remain byte-for-byte equivalent to the durable ask_user arguments');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery rejects field-incompatible adjudication values before ready-to-record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-adjudication-value-'));
  const selfPath = path.join(dir, 'self.jsonl');
  const manifest: EvidenceManifest = {
    rawJsonlSha256: '3'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: '4'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  const key = reviewEvidenceKey(manifest);
  try {
    appendEntry(selfPath, { type: 'session', id: 'self-id' });
    appendRole(selfPath, 'target-id', 'proposal-small', 'small', { criteria: [frozenCriterion] }, key);
    appendRole(selfPath, 'target-id', 'proposal-medium', 'medium', { criteria: [frozenCriterion] }, key);
    appendRole(selfPath, 'target-id', 'consolidation', 'medium', { frozenLedger: [frozenCriterion], dedupNotes: [] }, key);
    const common = { process: processVector, evidence: evidenceVector, confidence: 'high' };
    appendRole(selfPath, 'target-id', 'classification-small', 'small', {
      ...common, criteria: [{ criterionId: 'c1', status: 'met', reason: 'none', evidenceRefs: ['small'] }],
    }, key);
    appendRole(selfPath, 'target-id', 'classification-medium', 'medium', {
      ...common, criteria: [{ criterionId: 'c1', status: 'unmet', reason: 'omitted', evidenceRefs: ['medium'] }],
    }, key);
    appendRole(selfPath, 'target-id', 'adjudication', 'medium', { resolvedFields: [
      { field: 'criterion:c1.status', value: 'definitely_done', rationale: 'invalid enum', evidenceRefs: ['small'] },
      { field: 'criterion:c1.reason', value: 'none', rationale: 'valid enum', evidenceRefs: ['small'] },
    ] }, key);
    const status = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(status.next, 'adjudication');
    assert.match(status.invalidRoles.find((item) => item.role === 'adjudication')!.error, /invalid for criterion:c1\.status/);
    assert.match(status.checkpoint.launch[0]!.taskInstructions, /Valid status\/reason pairs only/);

    appendRole(selfPath, 'target-id', 'adjudication', 'medium', { resolvedFields: [
      { field: 'criterion:c1.status', value: 'met', rationale: 'valid enum', evidenceRefs: ['small'] },
      { field: 'criterion:c1.reason', value: 'omitted', rationale: 'incompatible with met', evidenceRefs: ['medium'] },
    ] }, key, { idSuffix: 'invalid-pair' });
    const invalidPair = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(invalidPair.checkpoint.state, 'blocked');
    assert.match(invalidPair.invalidRoles.find((item) => item.role === 'adjudication')!.error, /invalid status\/reason pair met\/omitted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
