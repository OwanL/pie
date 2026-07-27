# Session review and scoped human verification plan

**Status:** Implemented — V2-only production workflow; calibration is ongoing
**Date:** 2026-07-28

## 1. Decision summary

pie uses an explicitly launched, session-oriented review workflow. It is not an
automatic consequence of run finalization and does not require a task queue.

Each selected, previously unreviewed session receives one canonical production
review. The implemented flow is:

1. two independent criterion-definition proposals;
2. a profile-matched coordinator freezes one ledger;
3. one optional, criterion-scoped human question;
4. two independent classifications of the same frozen ledger and evidence;
5. optional profile-matched adjudication of material disagreement; and
6. canonical record persistence followed by explicit closure.

The normal reviewer profile is small + medium. small + small is available only
when the user explicitly constrains both reviewers to small. The coordinator and
any adjudicator match that profile: medium for small + medium, small for
small + small. A normal review uses five model calls; adjudication is the
optional sixth call.

The canonical outcome is a frozen criterion-definition ledger, classified
criterion ledger, deterministic attainment/index, process vector, evidence
vector, confidence, disagreement resolution, and provenance. Defects are
represented directly by a criterion's status, reason, and evidence references;
there is no separate defect list.

## 2. Goals and boundaries

The workflow:

- evaluates explicit and necessarily implied requirements;
- preserves independent reviewer judgments, evidence, disagreement, and
  provenance;
- asks at most one neutral, session-specific human question only when material
  evidence is unavailable to agents;
- keeps review persistence separate from explicit tab closure;
- keeps author model identity and treatment telemetry blind during review; and
- supports versioned, calibrated analytics without treating observational
  associations as causal effects.

It does not change working-agent behavior, require review-oriented questions
from working agents, create an automatic queue, treat a human response as a
whole-session score, or block best-effort completion when human evidence is
unavailable.

## 3. Identity, profiles, and evidence

### Stable identity and once-only review

The stable review key is the non-empty `id` in the first non-empty JSONL line
whose object has `type: 'session'`. The path is mutable display/location
metadata only. If the header is missing or malformed, the workflow uses the
normalized session-path hash and records `identityFallback: true`; that fallback
is not eligible for the normal once-only guarantee until reconciled.

The reviewer session is excluded. A selected session with an existing canonical
production review is never rated again in this workflow, including after it is
reopened. It is queued only for `closeReviewed` using the existing `reviewId`.
Calibration or audit work is a separate, explicit override.

### Reviewer profiles

`small` and `medium` are requested bucket hints, not fixed model tiers. Bucket
lists are user-configured in `subagentBuckets` and are mirrored into the
subagent extension through `PIE_SUBAGENT_BUCKETS_JSON`. Capacity, provider,
thinking support, toggles, and exclusions may change the effective selection. A
requested medium bucket may downgrade to small; an empty small bucket falls back
to the caller's active model.

Each reviewer call records its requested bucket and runtime-captured effective
bucket, model, provider, family, thinking level, downgrade state, and prompt
hash. Both final component assessments participate in analytics and ranking.
Reviewer diversity is a diagnostic computed from their effective provider/family
pair; it never changes eligibility or ranking inclusion.

### Blinded evidence

`getEvidence` supplies one target-specific blinded evidence bundle and evidence
manifest per unreviewed session. Reviewers receive the rendered transcript
excerpt, artifact/diff manifest, frozen ledger when available, and human response
when available. They do not receive author `modelId`, `provider`, `family`,
`thinkingLevel`, `model_change` entries, host/settings versions, model
reputation, or treatment telemetry. Raw JSONL is hashed but is not handed to
reviewers.

The manifest retains raw-JSONL hash, bytes and mtime; rendered-excerpt hash;
artifact hashes, sizes, and kinds; limitations; and blinding details. Runtime
records the fields removed from reviewer bundles rather than trusting reviewer
claims about blinding.

## 4. Rubric and criterion ledger

Every record uses `schemaVersion: 2` and the strict
`rubricVersion: 'session-review-v2.1'`. `indexVersion: 'v1'` identifies the
current derived index formula.

A criterion definition contains only:

```text
criterionId, statement, origin: explicit|necessary_implied,
importance: core|supporting|optional,
taxonomy: { activity, surface[], evidenceMode[] }
```

The fixed taxonomy enums are:

```ts
type CriterionActivity =
  | 'implement' | 'debug' | 'investigate' | 'explain' | 'design'
  | 'operate' | 'verify' | 'other';
type CriterionSurface =
  | 'ui' | 'application_logic' | 'api_integration' | 'data' | 'tests'
  | 'documentation' | 'configuration' | 'infrastructure'
  | 'developer_tooling' | 'agent_harness' | 'external_system'
  | 'communication' | 'other';
type CriterionEvidenceMode =
  | 'static_inspection' | 'automated_check' | 'runtime_observation'
  | 'human_observation' | 'external_confirmation'
  | 'reasoning_or_sources' | 'other';
```

The coordinator assigns stable criterion IDs and freezes the definition-only
`frozenLedger` before any classification. It hashes that immutable ledger as
`frozenLedgerSha256`. Requirements that changed or were retracted remain in the
frozen ledger and are later classified `superseded`. Every necessary-implied
criterion must be introduced during proposal or coordination, before this freeze.
Classifiers classify every and only frozen definition; they do not add criteria
later.

A classified criterion adds `status`, `reason`, and `evidenceRefs` to its frozen
definition. The allowed values are:

| Status | Allowed reason |
| --- | --- |
| `met`, `superseded` | `none` |
| `partly_met`, `unmet` | `omitted`, `attempt_failed`, `incorrect_result`, `regression`, `unknown` |
| `blocked` | `external_blocker`, `user_dependency`, `unknown` |
| `not_assessable` | `human_evidence_missing`, `insufficient_artifact_evidence`, `unknown` |

`external_blocker` is valid only for `blocked`. Importance represents user
value: a missed core criterion defeats primary value; supporting criteria
materially affect completeness or quality; optional criteria are requested
polish or useful non-core work.

## 5. Process, evidence, and confidence

The process vector records reusable behavior independently of criterion
attainment:

```ts
interface ReviewProcessVector {
  requirementDiscipline:
    | 'proportionate' | 'underclarified' | 'overclarified' | 'not_assessable';
  verificationDiscipline:
    | 'proportionate' | 'underverified' | 'oververified'
    | 'not_applicable' | 'not_assessable';
  scopeControl:
    | 'controlled' | 'minor_avoidable_drift' | 'material_scope_drift'
    | 'not_assessable';
  recovery:
    | 'effective' | 'partly_effective' | 'ineffective' | 'not_needed'
    | 'not_assessable';
  finalClaimAccuracy:
    | 'accurate' | 'overclaimed' | 'underclaimed' | 'unclear' | 'no_final_claim';
}
```

The evidence vector records requirements, artifacts, execution, human evidence,
and concrete limitations. Confidence is `high`, `medium`, or `low` and describes
confidence in the review classifications, not the original agent's confidence.
Missing evidence is neither success nor failure. Limitations identify conditions
such as transcript truncation, workspace drift, missing artifacts, unavailable
execution state, ambiguous attribution, or unanswered human evidence.

## 6. Human verification

A human response is criterion-scoped evidence, never a whole-session score. It
is appropriate only for material, human-observable uncertainty that the evidence
bundle cannot resolve reliably, such as visual or interaction quality, tone,
accessibility experience, or behavior behind an external account, device, or
permission boundary.

After every unreviewed target has been coordinated, the reviewer asks at most
one focused question for each affected session, sequentially. The question names
the session and criterion, gives minimum observation or reproduction steps,
offers neutral success/failure/unavailable paths where appropriate, and does not
reveal author identity or a preferred answer. If several uncertainties exist,
the coordinator selects the highest-importance unresolved one.

`ask_user.reviewMeta` labels the reviewed session for display, audit, and
attribution only. Routing remains in the reviewer session. The complete tool
input and result are stored as `humanCheck` in the canonical record. A cancelled,
unanswered, unavailable, or inconclusive response is recorded truthfully; only
affected criteria become `not_assessable` when necessary. It lowers evidence
coverage or confidence as appropriate, but never prevents record persistence or
closure.

## 7. Implemented review workflow

### Pass 0 — Snapshot and partition

The workflow calls `listSelected` for explicitly selected/pinned targets, or
`listOpen` only when the user explicitly asks for all open sessions. It snapshots
stable IDs and paths, excludes itself, partitions targets once by production
review state, and fetches one blinded evidence bundle plus manifest for each
unreviewed target. No review, question, or close action is performed for a new
target in this pass.

### Pass 1 — Independent ledger proposals

Two isolated reviewers receive only each target's blinded evidence bundle. They
propose definition-only criteria and at most one relevant human-only uncertainty.
They do not classify criteria, contact the user, write records, or see each
other's work.

### Pass 2 — Profile-matched coordination and freeze

A profile-matched coordinator receives the two proposals and the same blinded
bundle. It deduplicates equivalent criteria, resolves requirement boundaries,
retains superseded requirements, excludes generic quality criteria unless they
are necessary to the requested result, assigns stable IDs, and produces the
immutable `frozenLedger` and `frozenLedgerSha256`. It selects zero or one
highest-importance material human-question candidate and retains proposal and
deduplication provenance.

This pass completes for every unreviewed target before any human question is
asked.

### Pass 3 — Human questions

The reviewer asks the selected questions sequentially and retains their complete
input, raw result, normalized response, and factual interpretation as evidence.
All questions must be answered or marked unavailable before classification
begins.

### Pass 4 — Independent classifications

Two fresh, isolated reviewers receive the identical final blinded bundle:
frozen ledger and hash, rendered transcript/diff evidence, and the target's
human response when present. Each classifies every frozen criterion exactly once
with a valid status/reason pair and returns process, evidence, confidence, and a
proposed overall for comparison only. The canonical outcome is always derived,
not selected by a reviewer.

### Pass 5 — Disagreement resolution

Material disagreement invokes one fresh profile-matched adjudicator. It receives
both component assessments and the same final blinded bundle, resolves disputed
fields with evidence references, and does not mutate frozen definitions.

Material disagreement includes any core status disagreement; supporting or
optional status disagreements two graded steps apart or involving `blocked`,
`not_assessable`, or `superseded`; unequal human-evidence values; and opposite or
incomparable process values. Every disagreement in final-claim accuracy is
material.

Otherwise, deterministic merge is permitted only for adjacent ordered values:
`met`/`partly_met` becomes `partly_met`; `partly_met`/`unmet` becomes `unmet`;
coverage selects weaker graded coverage; and process fields select the weaker
adjacent value. Limitations are unioned and confidence is lowered. Categorical,
off-scale, non-adjacent, and incomparable values are never averaged or forced
into a conservative merge. Every canonical field records whether it came from
the first component, second component, deterministic merge, or adjudicator.

### Pass 6 — Record and explicitly close

`recordReview` atomically persists one complete canonical V2 production record
keyed by stable session ID. A duplicate returns or rejects with the existing
`reviewId`; it never creates a second production record. The write is fsynced
before any `closeReviewed` action is enqueued.

After persistence, `closeReviewed` enqueues or resumes closure through the
separate closure-action outbox. Already-reviewed targets use their existing
`reviewId`. Closure failure is retried from the outbox, never by recording the
review again. After the batch summary, `closeSelf` is the reviewer's final tool
action.

## 8. Canonical record and storage

The V2 production record contains only the canonical criterion and review-pipeline
artifacts needed for this flow:

```ts
interface SessionReviewV2 {
  schemaVersion: 2;
  kind: 'production' | 'calibration';
  reviewId: string;
  sessionId: string;
  sessionPathAtReview: string;
  identityFallback?: boolean;
  rubricVersion: 'session-review-v2.1';
  indexVersion: 'v1';
  reviewedAt: string;

  frozenLedger: CriterionDefinition[];
  frozenLedgerSha256: string;
  ledger: ClassifiedCriterion[];
  attainment: Attainment;
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
```

`reviews.jsonl` is append-only and V2-only. Production records are once-only by
stable `sessionId`; calibration records use the same schema/rubric contract but
are non-canonical. The record retains the two proposals, coordinator provenance,
two final components, disagreement resolution, optional adjudication, blinded
evidence manifest, and requested/effective reviewer provenance.

`recordReview` validates the V2 schema and strict rubric, the exact frozen-ledger
and hash relationship, complete classification of the frozen definitions,
status/reason pairs, accepted profile cardinality and matching coordinator or
adjudicator, blinding, and once-only identity. Runtime captures reviewer model
metadata and host version; reviewer prose does not supply those values.

Closure actions live outside `reviews.jsonl` in the closure-action outbox. A
`closeReviewed` action requires a persisted review ID; `closeSelf` has no review
ID. Pending, retrying, failed, and succeeded closure state is independent of
review persistence, so a half-completed run is recoverable without another
production review.

## 9. Derived attainment and ranking

Attainment is derived from the canonical ledger, never chosen by reviewers.

- The delivered active set includes all criteria except `superseded`.
- The controllable active set additionally excludes only criteria with
  `status: blocked` and `reason: external_blocker`.
- `not_assessable` remains visible in coverage but is removed from rate
denominators. It remains relevant to core outcome logic; it is ignored for
overall outcome only on supporting and optional criteria.
- Optional criteria never determine the overall result.

For each view, the first matching overall is: `not_assessable` when every active
core is not assessable (or no controllable core remains); `achieved` when every
core and outcome-supporting criterion is met; `mostly_achieved` when every core
is met but a supporting criterion has a gap; `partly_achieved` when some core
value was delivered but a core is not fully met; otherwise `not_achieved` when
no core value was delivered and an assessable core is unmet or blocked.

Thus, all externally blocked cores yield delivered `not_achieved` and
controllable `not_assessable`. Summaries retain class totals, assessable and
controllable denominators, statuses, external-blocked diagnostics, superseded
counts, and delivered/controllable rates using `met = 1`, `partly_met = 0.5`,
and other delivered states = 0.

`qualityIndexV1` is derived only from controllable, assessable criterion
attainment. It is `null` for controllable `not_assessable`; otherwise it uses
class weights core `1`, supporting `.5`, optional `.25`, rounded and clamped in
the overall band: not achieved `0–24`, partly achieved `25–59`, mostly achieved
`60–84`, achieved `85–100`. Coverage, confidence, and blocker rates do not alter
the index. The formula and its calibration are versioned as `indexVersion: 'v1'`.

Analytics retain criterion attainment, process, evidence coverage, confidence,
disagreement, reviewer diagnostics, and stable-session-ID joins to runtime
telemetry. Both component assessments participate in analytics and ranking;
diversity remains diagnostic. Reports show sample size, review/telemetry
coverage, task and criterion mix, time range, rubric/index/reviewer versions,
evidence-limited rates, treatment exclusions, and uncertainty. Tool, skill,
model, and harness comparisons are descriptive associations unless treatment
assignment is controlled.

## 10. Implementation status and calibration

### Implemented

- V2-only append-only review storage, stable identity, once-only production
  persistence, strict `session-review-v2.1` rubric, and `v1` index are active.
- The complete Pass 0–6 workflow is active: independent proposals, matched
  coordination/freeze, optional human question, independent classification,
  optional matched adjudication, canonical record, and explicit outbox closure.
- Reviewer blinding, accepted profiles, requested/effective runtime provenance,
  deterministic attainment, and the separate closure outbox are active.
- Canonical analytics use stable identity and retain criterion, process,
  evidence, confidence, disagreement, and reviewer diagnostics.

### Ongoing calibration

Calibration uses repeated blinded copies and sessions with successful outcomes,
omissions, blocked work, regressions, scope drift, recovery, verification,
final-claim, and human-observation cases. It measures criterion extraction,
importance/taxonomy and status agreement, process agreement, human-question
necessity and interpretation, confidence calibration, reviewer bias,
adjudication frequency/direction, index stability, rubric drift, review cost,
and latency.

Ranking is treated as authoritative only after calibration establishes adequate
agreement, measurable profile/adjudicator effects, versioned index semantics and
uncertainty reporting, and suitable sample coverage.
