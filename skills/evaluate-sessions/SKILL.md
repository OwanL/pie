---
name: evaluate-sessions
description: Run the V2 once-only, blinded session-review workflow for selected sessions: inspect all, ask scoped human questions, classify, persist, explicitly close targets, then close the reviewer.
---

# Evaluate Sessions — V2

Use only when the user explicitly asks to review/evaluate and usually close selected,
pinned, or open sessions. This is a **session-oriented, once-only production review**,
not ordinary code review.

## Outcome and non-negotiable rules

Produce one canonical schema-version-2 production record per previously unreviewed stable session ID:

- a frozen criterion-definition ledger and classified ledger;
- delivered and controllable attainment, process/evidence vectors, confidence,
  evidence/provenance, proposals, consolidation, components, and disagreement resolution;
- no directly chosen holistic score, implicit close, or self-review.

Follow this exact batch order: **snapshot/partition → inspect/propose all →
consolidate all → ask all → fresh classify all → adjudicate/merge → record →
explicit close → close self**. Never classify a target
before the batch human-evidence pass is complete or marked unavailable.

1. Review only the user-selected target set. Exclude this reviewer session.
2. A stable session-header ID is the identity key, never its path. Read the first
   non-empty JSONL line: use non-empty `id` from a `type: "session"` header;
   otherwise use the normalized-path hash and set `identityFallback: true`.
3. Do not re-rate an already canonical production-reviewed session, including one
   reopened after its first review. Queue it only for `closeReviewed` with its
   existing `reviewId`. Re-review needs an explicit calibration/audit override,
   never this ordinary flow.
4. Keep author identity blind. Reviewer bundles must exclude author `modelId`,
   `provider`, `family`, `thinkingLevel`, `model_change` entries, host/settings
   versions, reputation, and treatment telemetry. Hash raw JSONL but never give it
   to reviewers. Runtime, not reviewer prose, records effective reviewer model and
   blinding provenance.
5. Reviewers are isolated from each other and from unrelated sessions. The accepted
   reviewer profiles are `small` + `medium`, or user-constrained `small` + `small`.
   The coordinator and adjudicator request `medium` for small + medium, or `small`
   for small + small. A mixed-profile `medium` request may effectively downgrade to
   `small` with `bucketDowngraded: true`; a small-only role requests and effectively
   uses `small`. Persist requested and actual effective bucket/model. Both component
   assessments participate in analytics and ranking. Diversity is diagnostic only; compute it from
   effective provider/family, never requested labels.
6. A human response is criterion-scoped evidence, not a session score. Ask at most
   one neutral question per affected session, sequentially, only after every target
   has reached consolidation. An unanswered question never blocks best-effort
   record/closure.
7. `recordReview` persists; it does not close. Close only with `closeReviewed` or
   `closeSelf`, which use the separate closure-action outbox. `closeSelf` is the
   final tool action.

## Required V2 tool contract

Use the V2 `session_review` actions:

- `listOpen` / `listSelected` — obtain the selected/open target snapshot, stable
  IDs/paths, reviewer-session marker, review state, and existing review IDs.
- `getEvidence` — obtain one blinded bundle and `EvidenceManifest` for an
  unreviewed target. It supplies the rendered blinded excerpt, diff/changed-file manifest,
  hashes, and limitations; do not substitute raw JSONL for the bundle.
- `recordReview` — validate and atomically persist one complete canonical V2
  production record keyed by `sessionId`; duplicate writes return/reject with the
  existing `reviewId`.
- `closeReviewed` — enqueue/idempotently resume closure for a target using its
  persisted or existing `reviewId`.
- `closeSelf` — enqueue reviewer-session closure only; it never writes a review.

Use `subagent` for isolated reviewer roles, requesting the stated bucket. Consume
runtime provenance only from each returned `details.results[0]`: map
`parentToolCallId` → `toolCallId`, `requestedBucket` → `requestedBucket`, `bucket`
→ effective `bucket`, `bucketDowngraded` → `bucketDowngraded`, `model` →
`modelId`, and copy `provider`, `family`, `thinkingLevel`, and `promptHash`
verbatim. `promptHash` already hashes the exact delegated `task`; do not re-hash
rendered output or invent missing metadata. Evidence hashes remain those from the
evidence manifest. Use `ask_user` only for Pass 3 below. If the required tool/record capability is unavailable, report the blocker and do
not invent a record or close unreviewed targets.

## Canonical rubric quick reference

Every record has `schemaVersion: 2`; the canonical `rubricVersion` is `session-review-v2.1`. `indexVersion: 'v1'` identifies the current index formula only.

### Criterion definitions and classifications

A frozen `CriterionDefinition` contains only:

```text
criterionId, statement, origin: explicit|necessary_implied,
importance: core|supporting|optional,
taxonomy: { activity, surface[], evidenceMode[] }
```

Use the plan's fixed taxonomy enums and `other` only where needed. A classified
criterion additionally has `status`, `reason`, and `evidenceRefs`.
Definitions never carry classification.

Statuses: `met`, `partly_met`, `unmet`, `blocked`, `not_assessable`, `superseded`.
Allowed reasons are mandatory:

| Status | Allowed reason |
| --- | --- |
| `met`, `superseded` | `none` |
| `partly_met`, `unmet` | `omitted`, `attempt_failed`, `incorrect_result`, `regression`, `unknown` |
| `blocked` | `external_blocker`, `user_dependency`, `unknown` |
| `not_assessable` | `human_evidence_missing`, `insufficient_artifact_evidence`, `unknown` |

`external_blocker` is valid only with `blocked`. Retain changed/retracted
requirements in `frozenLedger` but classify them `superseded`; exclude them from
all attainment views.

Importance is user value: core defeats primary value if missed; supporting
materially affects quality/completeness; optional is requested polish/useful but
non-core.

### Process and evidence vectors

Return all five process fields, using the versioned values:

```text
requirementDiscipline: proportionate|underclarified|overclarified|not_assessable
verificationDiscipline: proportionate|underverified|oververified|not_applicable|not_assessable
scopeControl: controlled|minor_avoidable_drift|material_scope_drift|not_assessable
recovery: effective|partly_effective|ineffective|not_needed|not_assessable
finalClaimAccuracy: accurate|overclaimed|underclaimed|unclear|no_final_claim
```

Return evidence `{requirements, artifacts, execution, human, limitations}` and
confidence `high|medium|low`. Missing evidence is neither success nor failure:
make limitations concrete (for example transcript truncation, workspace drift,
missing artifact, unavailable execution state, ambiguous attribution, unanswered
human check).

## Execution workflow

### Pass 0 — snapshot once and partition once

1. Parse the instruction and call `listSelected` when selection/pins were named;
   otherwise call `listOpen` only when the user explicitly asked for all open
   sessions. Snapshot stable ID and current path, excluding self.
2. Partition exactly once by canonical production-review state:
   - **Unreviewed:** no canonical record. These are the full-pipeline batch.
   - **Already reviewed:** do not fetch evidence or run Passes 1–5. Queue
     `closeReviewed { targetSessionId, targetSessionPath, reviewId: existingReviewId }`.
     A settled-success action is an idempotent no-op.
3. For each unreviewed target call `getEvidence` once. Preserve its evidence manifest:
   raw JSONL SHA-256/bytes/mtime, rendered-excerpt SHA-256, artifact hashes/kinds,
   and limitations. Build the same blinded evidence bundle for every reviewer.
   Record `blindingApplied` and stripped/redacted fields.

Do not ask a question, record a review, or close a new target during this pass.

### Pass 1 — independent ledger proposals for every unreviewed target

For each target, launch two isolated subagents in parallel where capacity permits.
Use the small + medium profile unless the user explicitly constrains both reviewers
to small + small. They receive only that target's blinded evidence bundle and the
following output contract. Do not pass either reviewer's output to the other.

```text
You are the [first|second] Pass-1 reviewer, requested from the selected profile's
assigned bucket. You are blind to author identity and other reviewers. From the supplied blinded evidence only, return:
1. proposed CriterionDefinition[] (definitions only; no status/reason);
2. at most one relevant candidate human-only uncertainty/question.
Do not classify the ledger, choose an overall result, expose
identity assumptions, write records, or contact the user. Keep criteria explicit
or necessary-implied and retain superseded intent for consolidation.
```

Persist both proposals, including proposal IDs and runtime-captured requested vs
effective resolution.

### Pass 2 — profile-matched coordination for every unreviewed target

After both Pass-1 proposals, call one isolated coordinator per target with the
same blinded bundle plus both proposals: request medium for small + medium (which
may effectively downgrade to small), or request/effectively use small for
user-constrained small + small. It must:

- deduplicate equivalent criteria, resolve requirement boundaries, retain
  superseded requirements, and reject generic quality criteria unless necessary;
- assign stable IDs and return one immutable definition-only `frozenLedger`;
- hash exactly that ledger as `frozenLedgerSha256`;
- select no more than one highest-importance material human-question candidate;
- record source proposal IDs and concise dedup/merge notes.

```text
Return a ConsolidationRecord only: definition-only frozenLedger, its SHA-256,
selectedHumanQuestion (0 or 1), and source/dedup provenance. Do not classify,
run tools, ask the user, or mutate the frozen ledger.
```

Complete this pass for **every** unreviewed target before asking any question.

### Pass 3 — ask all selected human questions, sequentially

Only now, after every target has been inspected/consolidated,
ask each affected target's single selected question sequentially. Ask only when
it resolves a material human-observable uncertainty unavailable from the bundle
(visual/interactions, semantics/tone, accessibility experience, external account,
device, permission boundary). Choose the highest-importance unresolved criterion.

Every call must be neutral, give minimum reproduction/observation steps, name the
target session and exact criterion/surface, offer success/failure/custom/
unavailable paths as appropriate, and not reveal author identity or a preferred
answer. Use:

```json
{
  "question": "For reviewed session <display name>, please check <surface>...",
  "options": ["Observed as expected", "Not observed / incorrect", "Unable to check"],
  "allowCustom": true,
  "context": "Minimum reproduction: ...",
  "reviewMeta": {
    "purpose": "review_human_verification",
    "targetSessionId": "<stable reviewed-session ID>",
    "targetSessionPath": "<current display path>",
    "criterionId": "<frozen criterion ID>",
    "domain": "<domain>",
    "expectedObservation": "<neutral expected observation>"
  }
}
```

`reviewMeta` labels display/audit/attribution only: routing remains in this
reviewer session. Store the complete input and retain the raw tool result as
review evidence. The runtime cancellation shape
`{ answer: "", source: "cancelled", cancelled: true }` is **not** an answered
empty string: normalize it for the V2 `humanCheck.response` by omitting `answer`
and setting `{ source: "cancelled", cancelled: true, status: "unanswered",
recordedAt: <time> }`, while preserving that original raw result in the evidence
bundle/transcript. Store a factual interpretation. For cancelled, unanswered,
unavailable, or inconclusive answers, set human evidence truthfully, mark only
affected criteria `not_assessable` when needed, lower coverage/confidence
appropriately, and continue. Do not start Pass 4 until the whole batch has
answered or been marked unavailable.

### Pass 4 — fresh independent final classifications

For every unreviewed target, launch **fresh** isolated reviewers in parallel using
the selected reviewer profile. Do not reuse Pass-1 reviewers as the classification
output. Give each exactly the same final blinded bundle:
frozen ledger/hash, rendered transcript/diff manifest, and the target's human
response (if any).

```text
You are the [first|second] Pass-4 classifier, requested from the selected profile's
assigned bucket. Classify every and only frozen definition once as ClassifiedCriterion, using valid status/reason pairs
and evidence refs. Return process vector, evidence vector, confidence, and
proposed overall (comparison only). Do not derive canonical attainment, alter
frozenLedger, write records, or ask the user. You are blind to author identity
and other reviewers.
```

Persist both complete component assessments with actual runtime metadata. Compute
`diversityAchieved` only from their effective provider/family pair.

### Pass 5 — detect disagreement, then adjudicate or merge

First compare the two final assessments. Invoke exactly one fresh profile-matched adjudicator if **any** material condition
occurs: request medium for small + medium (which may effectively downgrade to
small), or request/effectively use small for user-constrained small + small.

- any core criterion-status disagreement, including any `blocked`,
  `not_assessable`, or `superseded` pair;
- supporting/optional statuses differing two graded steps (`met` ↔ `unmet`), or
  any pair involving `blocked`, `not_assessable`, or `superseded`;
- any unequal categorical `evidence.human` value;
- opposite/incomparable process values: `proportionate` vs `oververified` or
  `overclarified`; `underverified` vs `oververified`; `underclarified` vs
  `overclarified`; `effective` vs `ineffective`; `controlled` vs
  `material_scope_drift`; every disagreement in `finalClaimAccuracy`;
  or any substantive value vs `not_assessable`, `not_applicable`, `not_needed`,
  or `no_final_claim`.

The adjudicator sees both assessments and the same immutable final blinded bundle.
It resolves disputed fields with evidence refs. It may not mutate frozen definitions.
Mark every adjudicated field `resolution: adjudicator`.

If no material condition exists, apply these **only** deterministic rules; never
average categorical values or invent a conservative result for off-scale values:

| Field | Permitted adjacent pair | Canonical value |
| --- | --- | --- |
| criterion status | `met`/`partly_met` | `partly_met` |
| criterion status | `partly_met`/`unmet` | `unmet` |
| requirements coverage | `clear`/`partly_clear` | `partly_clear` |
| artifacts coverage | `direct`/`partial` | `partial` |
| execution coverage | `direct`/`partial` | `partial` |
| execution coverage | `partial`/`reported_only` | `reported_only` |
| requirement discipline | `proportionate`/`underclarified` | `underclarified` |
| verification discipline | `proportionate`/`underverified` | `underverified` |
| scope control | `controlled`/`minor_avoidable_drift` | `minor_avoidable_drift` |
| scope control | `minor_avoidable_drift`/`material_scope_drift` | `material_scope_drift` |
| recovery | `effective`/`partly_effective` | `partly_effective` |
| recovery | `partly_effective`/`ineffective` | `ineffective` |

For a chosen status, use its matching reason; same-status reasons choose the more
specific valid reason. Union limitations. Use lower confidence. `none`/`not_applicable` versus graded evidence
coverage is material, as are non-adjacent graded process pairs and every
final-claim-accuracy disagreement. For each disputed comparison, record `firstValue` and `secondValue` in component
order; resolution is only `adjudicator` or
`deterministic_merge`. Adjudication `resolvedFields` must exactly cover the computed
material fields, including a criterion reason paired with a material status. Discard
both proposed overalls.

### Derive attainment and index deterministically

Derive, never ask a reviewer to choose, both overall values and every
core/supporting/optional attainment summary.

1. **Delivered active set:** all except `superseded`.
2. **Controllable active set:** delivered set minus only
   `status: blocked` **and** `reason: external_blocker`.
3. In both views `not_assessable` stays in coverage but is removed from rate
   denominators. It is not normalized out for core outcome logic. Supporting and
   optional `not_assessable` are ignored only for overall outcome; optional never
   determines an overall.
4. For each view use the first matching rule:
   - `not_assessable`: every active core is `not_assessable`; also controllable
     `not_assessable` if no controllable core remains.
   - `achieved`: at least one core is met/partly met, every core is `met`, and
     every outcome supporting criterion is `met`.
   - `mostly_achieved`: every core is `met`, but an outcome supporting criterion
     is `partly_met`, `unmet`, or `blocked`.
   - `partly_achieved`: some core is `met`/`partly_met`, but a core is not fully
     met (`partly_met`, `unmet`, `blocked`, or `not_assessable`).
   - `not_achieved`: no core is `met`/`partly_met` and at least one core is
     assessable `unmet`/`blocked`.

Thus all externally blocked cores yield delivered `not_achieved` and controllable
`not_assessable`. Summaries report totals, assessable counts, controllable
denominators, status counts, external-blocked diagnostic counts, superseded,
and delivered/controllable rates using `met=1`, `partly_met=.5`, other delivered
states `0`.

Set `qualityIndexV1` to `null` if controllable overall is `not_assessable`.
Otherwise calculate class-weighted controllable assessable attainment with weights
core `1`, supporting `.5`, optional `.25`, then round/clamp within the fixed band:
`not_achieved [0,24]`, `partly_achieved [25,59]`, `mostly_achieved [60,84]`,
`achieved [85,100]`; `round(floor + width * attainment)`. Do not add coverage,
confidence, or blocker penalties.

### Pass 6 — persist, explicitly close, then self-close

For every unreviewed target, assemble and call `recordReview` with the complete
schema-version-2 record: exact frozen ledger/hash and classified ledger;
deterministic attainment/index; canonical vectors/human check/confidence; two
Pass-1 proposals, consolidation, two Pass-4 components,
disagreement/adjudication; evidence manifest; runtime pipeline IDs and requested/
effective reviewer provenance; and `provenance.hostVersion` copied verbatim from
the host's `PIE_EDITOR_VERSION` env var (or `null` when that var is unset — the
reviewer never guesses a host version; it is re-validated against the host at
record time). Verify status/reason, frozen-ledger/hash, tuple cardinality, and
blinding invariants before writing. The
canonical review record append is fsynced to disk before any `closeReviewed`
enqueue is allowed. If an ordinary duplicate is returned, use its existing
`reviewId`; never attempt a second production record.

Only after each review persistence succeeds, call `closeReviewed` with that
session's stable ID, path, and persisted `reviewId`. Also issue the queued
already-reviewed `closeReviewed` actions from Pass 0. Treat a pending/failed
closure as outbox state to retry/resume; never re-record a review to retry
closure. Continue until every selected target has a settled closure action or
report the outstanding outbox failure truthfully.

Present a compact batch summary (session ID/path, newly recorded or existing
review ID, delivered/controllable overall, confidence, closure status, and
limitations). Then call `closeSelf` with a batch reason as the **last tool call**
and end the turn; make no more tool calls.

## Pre-record checklist

- [ ] Pass-0 partition was made once; self excluded; already-reviewed targets did not enter the review pipeline.
- [ ] Every reviewer got the same target-specific blinded bundle; raw JSONL/model identity absent.
- [ ] Both Pass-1 proposals and profile-matched coordination exist; frozen ledger/hash match exactly.
- [ ] All human questions were asked sequentially after all consolidation; max one per affected target; inputs/results are embedded. Cancelled/unanswered responses omit the `answer` key (an explicit `answer: undefined` is rejected).
- [ ] Fresh Pass-4 assessments matching the accepted reviewer profile classify every frozen definition exactly once.
- [ ] Material disagreements were adjudicated; otherwise only permitted adjacent deterministic merges occurred; no spurious disputed fields are recorded.
- [ ] Attainment and index were derived from the canonical ledger, not reviewer overalls.
- [ ] `provenance.hostVersion` matches the host's `PIE_EDITOR_VERSION` (or `null` when unset).
- [ ] `recordReview` succeeded (canonical append fsynced) before each `closeReviewed`; closure retries use the outbox; `closeSelf` remains last.
