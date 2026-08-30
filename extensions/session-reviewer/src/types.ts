/** Contracts for the `session_review` tool. */

export type ReviewAction = 'listOpen' | 'listSelected' | 'getEvidence' | 'getReviewStatus' | 'recordRecoveredReview' | 'recordReview' | 'recordReviews' | 'closeReviewed' | 'closeReviewedBatch' | 'closeSelf';

/** Durable role identity written into `subagent.workflowRef`. The session-review
 * tool recovers these calls from the orchestrator JSONL, so history compaction
 * never becomes a workflow-state boundary. */
export type ReviewWorkflowRole =
  | 'proposal-small'
  | 'proposal-medium'
  | 'consolidation'
  | 'classification-small'
  | 'classification-medium'
  | 'adjudication';

export interface OpenTabSummary {
  path: string;
  name: string;
  cwd?: string;
  modifiedAt?: string;
  messageCount?: number;
  modelId?: string;
  thinkingLevel?: string;
  pinned: boolean;
  isRunning: boolean;
}

export type CriterionOrigin = 'explicit' | 'necessary_implied';
export type CriterionImportance = 'core' | 'supporting' | 'optional';
export type CriterionStatus = 'met' | 'partly_met' | 'unmet' | 'blocked' | 'not_assessable' | 'superseded';
export type CriterionReason = 'none' | 'omitted' | 'attempt_failed' | 'incorrect_result' | 'regression' | 'external_blocker' | 'user_dependency' | 'human_evidence_missing' | 'insufficient_artifact_evidence' | 'unknown';
export type CriterionActivity = 'implement' | 'debug' | 'investigate' | 'explain' | 'design' | 'operate' | 'verify' | 'other';
export type CriterionSurface = 'ui' | 'application_logic' | 'api_integration' | 'data' | 'tests' | 'documentation' | 'configuration' | 'infrastructure' | 'developer_tooling' | 'agent_harness' | 'external_system' | 'communication' | 'other';
export type CriterionEvidenceMode = 'static_inspection' | 'automated_check' | 'runtime_observation' | 'human_observation' | 'external_confirmation' | 'reasoning_or_sources' | 'other';

export interface CriterionDefinition {
  criterionId: string;
  statement: string;
  origin: CriterionOrigin;
  importance: CriterionImportance;
  taxonomy: { activity: CriterionActivity; surface: CriterionSurface[]; evidenceMode: CriterionEvidenceMode[] };
}
export interface ClassifiedCriterion extends CriterionDefinition {
  status: CriterionStatus;
  reason: CriterionReason;
  evidenceRefs: string[];
}

export interface ReviewProcessVector {
  requirementDiscipline: 'proportionate' | 'underclarified' | 'overclarified' | 'not_assessable';
  verificationDiscipline: 'proportionate' | 'underverified' | 'oververified' | 'not_applicable' | 'not_assessable';
  scopeControl: 'controlled' | 'minor_avoidable_drift' | 'material_scope_drift' | 'not_assessable';
  recovery: 'effective' | 'partly_effective' | 'ineffective' | 'not_needed' | 'not_assessable';
  finalClaimAccuracy: 'accurate' | 'overclaimed' | 'underclaimed' | 'unclear' | 'no_final_claim';
}
export interface ReviewEvidenceVector {
  requirements: 'clear' | 'partly_clear' | 'unclear';
  artifacts: 'direct' | 'partial' | 'none' | 'not_applicable';
  execution: 'direct' | 'partial' | 'reported_only' | 'none' | 'not_applicable';
  human: 'not_needed' | 'supports' | 'contradicts' | 'inconclusive' | 'unanswered' | 'unavailable';
  limitations: string[];
}
export type ReviewConfidence = 'high' | 'medium' | 'low';
export type OverallAttainment = 'achieved' | 'mostly_achieved' | 'partly_achieved' | 'not_achieved' | 'not_assessable';
export type ReviewKind = 'production' | 'calibration';
export type BucketTier = 'small' | 'medium' | 'frontier';
export type ReviewerBucket = 'small' | 'medium';

export interface ReviewHumanQuestionCandidate {
  criterionId: string;
  domain: string;
  expectedObservation: string;
  proposedQuestion: string;
  options: string[];
}

export interface ReviewerRuntime {
  reviewerId: string;
  /** Parent-session subagent tool call whose runtime metadata is authoritative. */
  toolCallId: string;
  requestedBucket: ReviewerBucket;
  bucket: BucketTier;
  bucketDowngraded: boolean;
  modelId: string;
  provider: string;
  family: string;
  thinkingLevel: string | null;
  promptHash: string;
  rubricVersion: string;
}
export interface ReviewerProposal extends ReviewerRuntime {
  proposalId: string;
  proposedAt: string;
  criteria: CriterionDefinition[];
  candidateHumanQuestion?: ReviewHumanQuestionCandidate;
}
export interface ConsolidationRecord extends Omit<ReviewerRuntime, 'requestedBucket'> {
  consolidationId: string;
  requestedBucket: ReviewerBucket;
  consolidatedAt: string;
  /** Optional in compact input; the compiler derives it from the root ledger. */
  frozenLedger?: CriterionDefinition[];
  /** Optional in compact input; the compiler derives it at record time. */
  frozenLedgerSha256?: string;
  selectedHumanQuestion?: ReviewHumanQuestionCandidate;
  provenance: { fromProposals: [string, string]; dedupNotes: string[] };
}

export interface CriterionAttainmentSummary {
  total: number;
  assessable: number;
  controllableDenominator: number;
  met: number;
  partlyMet: number;
  unmet: number;
  blocked: number;
  externalBlocked: number;
  notAssessable: number;
  superseded: number;
  deliveredRate: number;
  controllableRate: number;
}

export interface AskUserReviewInput {
  question: string;
  options: string[];
  allowCustom?: boolean;
  context?: string;
  reviewMeta?: {
    purpose: 'review_human_verification';
    targetSessionId: string;
    targetSessionPath: string;
    criterionId: string;
    domain: string;
    expectedObservation: string;
  };
}
export type ReviewHumanCheckResponse =
  | { answer: string; source: 'option' | 'custom'; cancelled: false; status: 'answered' | 'inconclusive' | 'unavailable'; recordedAt: string }
  | { answer?: undefined; source: 'cancelled'; cancelled: true; status: 'unanswered'; recordedAt: string }
  | { answer?: undefined; source: 'unanswered'; cancelled: false; status: 'unanswered' | 'unavailable'; recordedAt: string };
export interface ReviewHumanCheck {
  toolCallId: string;
  input: AskUserReviewInput;
  response: ReviewHumanCheckResponse;
  interpretation: string;
}

export interface ReviewerAssessment extends ReviewerRuntime {
  assessmentId: string;
  assessedAt: string;
  classifications: {
    criteria: ClassifiedCriterion[];
    process: ReviewProcessVector;
    evidence: ReviewEvidenceVector;
    confidence: ReviewConfidence;
    /** Comparison-only; canonical attainment is derived from classifications. */
    proposedOverall?: OverallAttainment;
  };
}
export interface DisputedField {
  field: string;
  firstValue: string;
  secondValue: string;
  resolvedValue: string;
  resolution: 'adjudicator' | 'deterministic_merge';
}
export interface ReviewDisagreementSummary { material: boolean; disputedFields: DisputedField[]; adjudicated: boolean }
export interface ReviewerAdjudication extends Omit<ReviewerRuntime, 'requestedBucket'> {
  adjudicationId: string;
  requestedBucket: ReviewerBucket;
  assessedAt: string;
  resolvedFields: { field: string; value: string; rationale: string; evidenceRefs: string[] }[];
  /** Optional comparison output; canonical attainment is derived from the ledger. */
  canonicalOverall?: { deliveredOverall: OverallAttainment; controllableOverall: OverallAttainment };
}

export interface BlindingSummary { stripped: string[]; redactedTurnFields: string[]; notes: string[] }
export interface EvidenceArtifactManifest {
  path: string;
  sha256: string;
  bytes: number;
  kind: 'diff' | 'file' | 'generated' | 'untracked';
  excerptSha256: string;
  excerptBytes: number;
  excerptTruncated: boolean;
}
export interface EvidenceArtifactExcerpt extends EvidenceArtifactManifest { excerpt: string }
export interface EvidenceManifest {
  rawJsonlSha256: string;
  rawJsonlBytes: number;
  rawJsonlMtime: string;
  transcriptExcerptSha256: string;
  artifacts: EvidenceArtifactManifest[];
  limitations: string[];
  blinding: BlindingSummary;
}
export interface EvidenceArtifactInput {
  path: string;
  kind: EvidenceArtifactManifest['kind'];
}
export interface BlindedEvidenceBundle {
  sessionId: string;
  sessionPath: string;
  identityFallback: boolean;
  transcriptExcerpt: string;
  artifacts: EvidenceArtifactExcerpt[];
  limitations: string[];
  manifest: EvidenceManifest;
}
export interface ReviewProvenance {
  orchestratorSessionId: string;
  rubricVersion: string;
  indexVersion: string;
  blindingApplied: boolean;
  diversityAchieved: boolean;
  evidenceManifest: EvidenceManifest;
  pipeline: {
    frozenLedgerSha256: string;
    proposalIds: [string, string];
    consolidationId: string;
    componentAssessmentIds: [string, string];
    adjudicationId?: string;
  };
  adjudicatorReviewerId?: string;
  hostVersion: string | null;
}

export type ReviewerProposalDraft = Omit<ReviewerProposal, 'rubricVersion' | 'proposalId' | 'proposedAt'> & Partial<Pick<ReviewerProposal, 'rubricVersion' | 'proposalId' | 'proposedAt'>>;
export type ReviewerAssessmentDraft = Omit<ReviewerAssessment, 'rubricVersion' | 'assessmentId' | 'assessedAt'> & Partial<Pick<ReviewerAssessment, 'rubricVersion' | 'assessmentId' | 'assessedAt'>>;
export type ConsolidationDraft = Omit<ConsolidationRecord, 'rubricVersion' | 'consolidationId' | 'consolidatedAt' | 'frozenLedger' | 'frozenLedgerSha256' | 'provenance'> & Partial<Pick<ConsolidationRecord, 'rubricVersion' | 'consolidationId' | 'consolidatedAt' | 'frozenLedger' | 'frozenLedgerSha256' | 'provenance'>>;
export type ReviewerAdjudicationDraft = Omit<ReviewerAdjudication, 'rubricVersion' | 'adjudicationId' | 'assessedAt' | 'canonicalOverall'> & Partial<Pick<ReviewerAdjudication, 'rubricVersion' | 'adjudicationId' | 'assessedAt' | 'canonicalOverall'>>;
export type ReviewProvenanceDraft = Omit<ReviewProvenance, 'orchestratorSessionId' | 'rubricVersion' | 'indexVersion' | 'blindingApplied' | 'diversityAchieved' | 'pipeline' | 'hostVersion' | 'evidenceManifest'> & Partial<Pick<ReviewProvenance, 'orchestratorSessionId' | 'rubricVersion' | 'indexVersion' | 'blindingApplied' | 'diversityAchieved' | 'pipeline' | 'hostVersion' | 'evidenceManifest'>>;

/** Compact evaluator input. Deterministic fields and transport metadata are filled by the extension. */
export interface SessionReviewDraft {
  schemaVersion?: number;
  kind?: ReviewKind;
  reviewId?: string;
  sessionId: string;
  sessionPathAtReview: string;
  identityFallback?: boolean;
  rubricVersion?: string;
  indexVersion?: string;
  reviewedAt?: string;
  frozenLedger: CriterionDefinition[];
  proposals: [ReviewerProposalDraft, ReviewerProposalDraft];
  consolidation: ConsolidationDraft;
  components: [ReviewerAssessmentDraft, ReviewerAssessmentDraft];
  humanCheck?: ReviewHumanCheck;
  adjudication?: ReviewerAdjudicationDraft;
  provenance: ReviewProvenanceDraft;
}

export interface SessionReviewV2 {
  schemaVersion: number;
  kind: ReviewKind;
  reviewId: string;
  sessionId: string;
  sessionPathAtReview: string;
  identityFallback?: boolean;
  rubricVersion: string;
  indexVersion: string;
  reviewedAt: string;
  frozenLedger: CriterionDefinition[];
  frozenLedgerSha256: string;
  ledger: ClassifiedCriterion[];
  attainment: {
    deliveredOverall: OverallAttainment;
    controllableOverall: OverallAttainment;
    core: CriterionAttainmentSummary;
    supporting: CriterionAttainmentSummary;
    optional: CriterionAttainmentSummary;
    qualityIndexV1: number | null;
  };
  process: ReviewProcessVector;
  evidence: ReviewEvidenceVector;
  humanCheck?: ReviewHumanCheck;
  confidence: ReviewConfidence;
  proposals: [ReviewerProposal, ReviewerProposal];
  consolidation: ConsolidationRecord;
  components: [ReviewerAssessment, ReviewerAssessment];
  disagreement: ReviewDisagreementSummary;
  adjudication?: ReviewerAdjudication;
  provenance: ReviewProvenance;
}

export interface ReviewClosureTarget {
  sessionId: string;
  reviewId: string;
  sessionPath?: string;
}

export type ClosureActionKind = 'closeReviewed' | 'closeSelf';
export type ClosureActionStatus = 'pending' | 'succeeded' | 'failed' | 'retrying';
export interface ClosureAction {
  actionId: string;
  kind: ClosureActionKind;
  targetSessionId: string;
  targetSessionPath?: string;
  reviewId?: string;
  status: ClosureActionStatus;
  attempts: number;
  lastError?: string;
  requestedAt: string;
  settledAt?: string;
}

export interface SessionReviewParams {
  action: ReviewAction;
  sessionPath?: string;
  sessionId?: string;
  reviewId?: string;
  review?: SessionReviewV2 | SessionReviewDraft | string;
  reviewPath?: string;
  reviews?: Array<SessionReviewV2 | SessionReviewDraft | string>;
  reviewsPath?: string;
  closures?: ReviewClosureTarget[];
  /** Retained for callers that attach a human-readable closure reason; the outbox currently ignores it. */
  reason?: string;
  /** Required opt-in for closing the evaluator's own session. */
  confirmSelf?: boolean;
  maxTurns?: number;
  artifacts?: EvidenceArtifactInput[];
}

export const sessionReviewSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['listOpen', 'listSelected', 'getEvidence', 'getReviewStatus', 'recordRecoveredReview', 'recordReview', 'recordReviews', 'closeReviewed', 'closeReviewedBatch', 'closeSelf'],
      description: 'Session review action. getReviewStatus recovers tagged reviewer roles after history compaction; recordRecoveredReview compiles them from the durable orchestrator JSONL. Evidence and recording are single-target workflow steps. Recording and closure remain separate; closeSelf requires explicit confirmSelf:true after listSelected and only hides a running evaluator tab.'
    },
    sessionPath: { type: 'string', description: 'Absolute session JSONL path returned by listOpen/listSelected.' },
    sessionId: { type: 'string', description: 'Stable session-header ID (required for review status/recovery and closeReviewed; checked against sessionPath when supplied).' },
    reviewId: { type: 'string', description: 'Persisted review ID required by closeReviewed.' },
    review: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'string' },
      ],
      description: 'Canonical review or compact review draft for recordReview. Accepts an object or JSON string; the extension compiles compact drafts and derives deterministic fields.',
    },
    reviewPath: { type: 'string', description: 'Absolute, non-symlink path inside the OS temporary directory to one UTF-8 review object (max 1 MiB), as an alternative to inline review.' },
    reviews: {
      type: 'array',
      maxItems: 100,
      description: 'Compact review drafts or canonical review objects for recordReviews.',
      items: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }] },
    },
    reviewsPath: { type: 'string', description: 'Absolute, non-symlink path inside the OS temporary directory to one UTF-8 JSON array of review drafts or canonical review objects (max 8 MiB).' },
    reason: { type: 'string', description: 'Optional closure reason retained for compatibility; persistence does not interpret it.' },
    confirmSelf: { type: 'boolean', description: 'Required for closeSelf. Set true only when the user explicitly asked to hide/close this evaluator session, after listSelected confirms it is currently pinned; this does not interrupt a running evaluator.' },
    closures: {
      type: 'array',
      maxItems: 100,
      description: 'Independent reviewed-target closure requests for closeReviewedBatch.',
      items: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          reviewId: { type: 'string' },
          sessionPath: { type: 'string' },
        },
        required: ['sessionId', 'reviewId'],
        additionalProperties: false,
      },
    },
    maxTurns: { type: 'integer', minimum: 1, maximum: 200, description: 'getEvidence transcript turn cap (default 40).' },
    artifacts: {
      type: 'array',
      maxItems: 20,
      description: 'Optional changed/generated artifact paths to snapshot. getEvidence also derives changed files and a final git diff from the session transcript/cwd when available; all excerpts are blinded, bounded, and hashed.',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, kind: { type: 'string', enum: ['diff', 'file', 'generated', 'untracked'] } },
        required: ['path', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const;
