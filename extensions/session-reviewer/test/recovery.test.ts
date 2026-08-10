import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import registerSessionReviewer from '../index.js';
import { compileRecoveredReview, getReviewRecoveryStatus, reviewEvidenceKey, reviewWorkflowRef } from '../src/recovery.js';
import type { EvidenceManifest, ReviewWorkflowRole } from '../src/types.js';
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
  options: { agent?: string; callBucket?: 'small' | 'medium'; runtimeRequestedBucket?: 'small' | 'medium' } = {},
): void {
  const id = `call-${role}`;
  const promptHash = `hash-${role}`;
  appendEntry(file, {
    type: 'message', id: `assistant-${role}`,
    message: {
      role: 'assistant',
      content: [{
        type: 'toolCall', id, name: 'subagent',
        arguments: { agent: options.agent ?? 'reviewer', task: `review ${role}`, bucket: options.callBucket ?? requestedBucket, workflowRef: reviewWorkflowRef(sessionId, role, evidenceKey) },
      }],
    },
  });
  appendEntry(file, {
    type: 'message', id: `result-${role}`,
    message: {
      role: 'toolResult', toolCallId: id, toolName: 'subagent',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      details: { results: [{
        parentToolCallId: id,
        exitCode: 0,
        finalOutput: JSON.stringify(payload),
        requestedBucket: options.runtimeRequestedBucket ?? requestedBucket,
        bucket: options.runtimeRequestedBucket ?? requestedBucket,
        bucketDowngraded: false,
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
    const status = await restartedTool.execute('status', { action: 'getReviewStatus', sessionId: 'target-id' }, undefined, undefined, ctx);
    assert.equal(status.isError, false, status.content[0].text);
    assert.equal(status.details.next, 'ready-to-record');
    assert.ok(status.details.completedRoles.includes('proposal-small'));
    assert.ok(status.details.completedRoles.includes('classification-medium'));

    const recorded = await restartedTool.execute('record', { action: 'recordRecoveredReview', sessionId: 'target-id' }, undefined, undefined, ctx);
    assert.equal(recorded.isError, false, recorded.content[0].text);
    assert.match(recorded.content[0].text, /Recovered and recorded production review/);
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
    for (const entry of roleEntry('active', null, 'active-call', 'reviewer', [frozenCriterion])) appendEntry(selfPath, entry);
    const status = getReviewRecoveryStatus(selfPath, 'target-id', manifest);
    assert.equal(status.next, 'proposal-medium');
    assert.equal(status.invalidRoles.length, 0);
    assert.ok(status.completedRoles.includes('proposal-small'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery rejects non-reviewer agents and role-inappropriate requested buckets', () => {
  const manifest: EvidenceManifest = {
    rawJsonlSha256: '1'.repeat(64), rawJsonlBytes: 1, rawJsonlMtime: '2026-08-09T00:00:00.000Z', transcriptExcerptSha256: '2'.repeat(64), artifacts: [], limitations: [],
    blinding: { stripped: [], redactedTurnFields: [], notes: [] },
  };
  for (const [label, options, expected] of [
    ['agent', { agent: 'worker' }, /reviewer agent/],
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
            question, options: selected.options,
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
    assert.equal(compileRecoveredReview({
      orchestratorPath: selfPath, orchestratorSessionId: 'self-id', sessionId: 'target-id',
      sessionPathAtReview: 'target.jsonl', evidenceManifest: manifest,
    }).humanCheck?.toolCallId, 'current-answer');
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
