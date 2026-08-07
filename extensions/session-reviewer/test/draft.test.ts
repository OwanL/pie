import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAttainment } from '../src/attainment.js';
import { compileReviewDraft } from '../src/draft.js';
import { validateSessionReviewV2 } from '../src/validation.js';
import type { SessionReviewDraft, SessionReviewV2 } from '../src/types.js';
import { validReview } from './fixtures.js';

function compactReview(review: SessionReviewV2): SessionReviewDraft {
  const proposals = review.proposals.map(({ proposalId: _proposalId, proposedAt: _proposedAt, rubricVersion: _rubricVersion, ...rest }) => rest) as SessionReviewDraft['proposals'];
  const { consolidationId: _consolidationId, consolidatedAt: _consolidatedAt, rubricVersion: _consolidationRubric, frozenLedger: _consolidationLedger, frozenLedgerSha256: _consolidationHash, provenance: consolidationProvenance, ...consolidation } = review.consolidation;
  const components = review.components.map(({ assessmentId: _assessmentId, assessedAt: _assessedAt, rubricVersion: _assessmentRubric, classifications, ...rest }) => {
    const { proposedOverall: _proposedOverall, ...classificationFields } = classifications;
    return { ...rest, classifications: classificationFields };
  }) as SessionReviewDraft['components'];
  return {
    sessionId: review.sessionId,
    sessionPathAtReview: review.sessionPathAtReview,
    frozenLedger: review.frozenLedger,
    proposals,
    consolidation: { ...consolidation, provenance: consolidationProvenance },
    components,
    provenance: { evidenceManifest: review.provenance.evidenceManifest },
  };
}

test('compileReviewDraft fills derived fields and removes comparison-only duplication', () => {
  const full = validReview();
  const draft = compactReview(full);
  const compiled = compileReviewDraft(draft, { orchestratorSessionId: 'reviewer-session', hostVersion: null });

  assert.equal(compiled.schemaVersion, 2);
  assert.equal(compiled.kind, 'production');
  assert.match(compiled.reviewId, /^review-/);
  assert.deepEqual(compiled.attainment, deriveAttainment(compiled.ledger));
  assert.deepEqual(compiled.consolidation.frozenLedger, undefined);
  assert.deepEqual(compiled.consolidation.frozenLedgerSha256, undefined);
  assert.equal('proposedOverall' in compiled.components[0]!.classifications, false);
  assert.equal(compiled.provenance.orchestratorSessionId, 'reviewer-session');
  assert.equal(compiled.provenance.hostVersion, null);
  assert.equal(compiled.provenance.pipeline.proposalIds.length, 2);
  assert.equal(validateSessionReviewV2(compiled), compiled);
});
