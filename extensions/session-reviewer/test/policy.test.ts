import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSafety } from '../src/check-safety.js';
import { materialDisagreementFields, processDisagreementMaterial } from '../src/disagreement.js';
import { validReview } from './fixtures.js';

test('check safety allows only commands whose implementation is intrinsically read-only', () => {
  assert.deepEqual(checkSafety({ checkId: 'c1', kind: 'command', command: 'npm test -- --no-write', cwd: '/repo' }), { safe: false, reason: 'mutating' });
  assert.deepEqual(checkSafety({ checkId: 'c2', kind: 'static_inspection', target: 'src/a.ts', query: 'needle' }), { safe: true });
  assert.deepEqual(checkSafety({ checkId: 'c3', kind: 'command', command: 'git commit -am nope', cwd: '/repo' }), { safe: false, reason: 'mutating' });
  assert.deepEqual(checkSafety({ checkId: 'c4', kind: 'command', command: 'echo changed > file', cwd: '/repo' }), { safe: false, reason: 'mutating' });
  assert.deepEqual(checkSafety({ checkId: 'c5', kind: 'command', command: 'node --check src/a.js', cwd: '/repo' }), { safe: false, reason: 'mutating' });
  assert.deepEqual(checkSafety({ checkId: 'c6', kind: 'command', command: 'python -m compileall -q src', cwd: '/repo' }), { safe: false, reason: 'mutating' });
  assert.deepEqual(checkSafety({ checkId: 'c7', kind: 'command', command: 'pnpm run typecheck --noEmit', cwd: '/repo' }), { safe: false, reason: 'mutating' });
  assert.deepEqual(checkSafety({ checkId: 'c8', kind: 'command', command: 'tsc --noEmit', cwd: '/repo' }), { safe: false, reason: 'mutating' });
  assert.deepEqual(checkSafety({ checkId: 'c9', kind: 'command', command: 'git diff --no-ext-diff --no-textconv -- src/a.ts', cwd: '/repo' }), { safe: true });
  assert.deepEqual(checkSafety({ checkId: 'c10', kind: 'command', command: 'git diff -- src/a.ts', cwd: '/repo' }), { safe: false, reason: 'mutating' });
  assert.deepEqual(checkSafety({ checkId: 'c11', kind: 'command', command: 'git diff --no-ext-diff --no-textconv --out=report.patch -- src/a.ts', cwd: '/repo' }), { safe: false, reason: 'mutating' });
});

test('off-scale status and human evidence disagreements are material', () => {
  const review = validReview();
  const [small, medium] = review.components;
  medium.classifications.criteria[0] = { ...medium.classifications.criteria[0]!, status: 'blocked', reason: 'unknown' };
  medium.classifications.evidence.human = 'unavailable';
  assert.deepEqual(materialDisagreementFields(small, medium).sort(), ['criterion:c1.status', 'evidence.human']);
});

test('adjacent supporting status disagreement is non-material but two-step is material', () => {
  const review = validReview();
  const [small, medium] = review.components;
  small.classifications.criteria[0]!.importance = 'supporting';
  medium.classifications.criteria[0]!.importance = 'supporting';
  medium.classifications.criteria[0]!.status = 'partly_met';
  medium.classifications.criteria[0]!.reason = 'unknown';
  assert.deepEqual(materialDisagreementFields(small, medium), []);
  medium.classifications.criteria[0]!.status = 'unmet';
  assert.deepEqual(materialDisagreementFields(small, medium), ['criterion:c1.status']);
});

test('opposite and incomparable process values escalate while adjacent values do not', () => {
  assert.equal(processDisagreementMaterial('scopeControl', 'controlled', 'minor_avoidable_drift'), false);
  assert.equal(processDisagreementMaterial('scopeControl', 'controlled', 'material_scope_drift'), true);
  assert.equal(processDisagreementMaterial('verificationDiscipline', 'underverified', 'not_applicable'), true);
  assert.equal(processDisagreementMaterial('finalClaimAccuracy', 'accurate', 'overclaimed'), true);
});

test('evidence coverage escalates two-step and off-scale gaps and merges only adjacent values', () => {
  const review = validReview();
  const [small, medium] = review.components;
  medium.classifications.evidence.requirements = 'partly_clear';
  medium.classifications.evidence.execution = 'partial';
  medium.classifications.evidence.artifacts = 'partial';
  assert.deepEqual(materialDisagreementFields(small, medium), []);

  medium.classifications.evidence.requirements = 'unclear';
  medium.classifications.evidence.execution = 'reported_only';
  medium.classifications.evidence.artifacts = 'none';
  assert.deepEqual(materialDisagreementFields(small, medium).sort(), ['evidence.artifacts', 'evidence.execution', 'evidence.requirements']);

  small.classifications.evidence.artifacts = 'none';
  medium.classifications.evidence.artifacts = 'not_applicable';
  assert.ok(materialDisagreementFields(small, medium).includes('evidence.artifacts'));
});

test('material findings are matched semantically rather than by caller-local IDs', () => {
  const review = validReview();
  const finding = { severity: 'major' as const, category: 'correctness' as const, statement: 'The parser drops the final record.', evidenceRefs: ['e1'], criterionId: 'c1', ledgerEffect: 'downgrade' as const, remediation: 'Retain it.' };
  review.components[0].classifications.findings = [{ ...finding, findingId: 'small-id' }];
  review.components[1].classifications.findings = [{ ...finding, findingId: 'medium-id', statement: 'Final parser record is omitted.' }];
  assert.deepEqual(materialDisagreementFields(...review.components), []);
  review.components[1].classifications.findings[0]!.statement = 'The API returns unauthorized data.';
  assert.deepEqual(materialDisagreementFields(...review.components).sort(), ['finding:medium-id', 'finding:small-id']);
});

test('finding matching preserves distinct defects that share a criterion and category', () => {
  const review = validReview();
  const base = { severity: 'major' as const, category: 'correctness' as const, criterionId: 'c1', ledgerEffect: 'downgrade' as const, remediation: 'Fix it.' };
  review.components[0].classifications.findings = [
    { ...base, findingId: 'left-parser', statement: 'Parser drops the final record.', evidenceRefs: ['diff:parser'] },
    { ...base, findingId: 'left-auth', statement: 'Authorization permits another tenant.', evidenceRefs: ['diff:auth'] },
  ];
  review.components[1].classifications.findings = [
    { ...base, findingId: 'right-auth', statement: 'Another tenant can access protected data.', evidenceRefs: ['diff:auth'] },
    { ...base, findingId: 'right-parser', statement: 'Final parser record is omitted.', evidenceRefs: ['diff:parser'] },
  ];
  assert.deepEqual(materialDisagreementFields(...review.components), []);
  review.components[1].classifications.findings[1]!.evidenceRefs = ['diff:different-defect'];
  assert.deepEqual(materialDisagreementFields(...review.components).sort(), ['finding:left-parser', 'finding:right-parser']);
});
