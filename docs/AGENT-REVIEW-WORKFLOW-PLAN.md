# Session review and scoped human verification plan

**Status:** Implemented (provisional v1); production calibration pending
**Date:** 2026-07-24

## 1. Decision summary

pie will replace routine user-authored session ratings with an explicitly launched, agent-driven session review workflow.

The normal workflow is initiated by a user request such as:

> Review and close each pinned session.

The review is:

- **Session-oriented:** no task queue or canonical task-group entity is required.
- **Explicitly launched:** reviewing is not an automatic consequence of run finalization.
- **Once-only:** each selected session receives one canonical production review.
- **Multi-reviewer:** every selected session receives independent small- and medium-bucket assessments. A normal session costs ~5 model calls (two ledger proposals, one consolidation, two final classifications); a sixth medium adjudicator runs only on material disagreement.
- **Evidence-grounded:** reviews use the transcript, artifacts, diffs, checks, and scoped human observations.
- **Human-assisted only where needed:** after inspecting all sessions, the reviewer asks at most one focused `ask_user` question per affected session for material evidence agents cannot obtain reliably.
- **Cleanup-oriented:** every unrated target is rated and closed to the best of the reviewer’s ability, even if a human question is unanswered; already-reviewed targets are closed without re-rating (§10 Pass 0).

The canonical outcome will be a **criterion ledger plus a compact process and evidence vector**, not a directly chosen holistic 1–5 rating. Analytics may derive a versioned quality index afterward.

Legacy ratings remain readable but are not coerced into the new schema. A new review cohort may invalidate direct comparison with historical ratings; that is acceptable.

## 2. Goals

1. Evaluate whether each session satisfied the user’s explicit and necessarily implied requirements.
2. Produce classifications agents can apply consistently and analytics can aggregate quantitatively.
3. Reveal reusable agent characteristics such as requirement discipline, verification discipline, scope control, recovery, and final-claim accuracy.
4. Support analysis of model, tool, skill, pruning, and harness configurations without conflating outcomes with process telemetry.
5. Ask users neutral, session-specific questions only for material human-observable uncertainty.
6. Preserve independent reviewer judgements, disagreements, adjudication, evidence, rubric version, and provenance.
7. Rate each production session once and close each selected target reliably.
8. Remove routine user rating/resolution UI after the replacement workflow is validated.
9. Blind reviewers to author model/provider/thinking level and model reputation.
10. Calibrate the review system before treating its derived index as authoritative ranking evidence.

## 3. Non-goals

- Do not change how working agents complete tasks.
- Do not require working agents to ask review-oriented verification questions.
- Do not create an automatic task-review queue.
- Do not turn human verification into an indirect model score.
- Do not ask the user to review every session manually.
- Do not block rating or closure indefinitely when subjective evidence is unavailable.
- Do not treat observed tool or skill usage as causal without a controlled assignment.
- Do not preserve the old 1–5 methodology merely for historical comparability.
- Do not rate a session more than once in normal production flow.

## 4. Canonical review concepts

### 4.1 Session

The session is the production review and analytics unit. Its stable identity is the `id` field of the session JSONL **header line** — the first line of the file, whose JSON object has `type: 'session'` and an `id` (UUID). The session **path** is retained as mutable location/display metadata only; a path rename or move must not change identity.

Stable session-header ID extraction:

- Read the first non-empty line of the session JSONL.
- Parse it as JSON; if `type === 'session'` and `id` is a non-empty string, use `id` as the stable session ID.
- If the first line is not a `session` header or has no `id` (legacy/malformed), fall back to the normalized session-path hash (see §14.5) and flag the review `identityFallback: true`; such records are not eligible for once-only guarantees until reconciled.
- The header also carries `cwd`, `timestamp`, and `version`; only `id` is used as the join/identity key.

A review invocation snapshots the selected target sessions—normally the pinned sessions named by the user’s instruction. The reviewer session itself is excluded.

### 4.2 Criterion ledger

A criterion is one material proposition that the session was expected to satisfy.

Criteria include:

- Explicit user requirements
- Requirements necessarily implied for the requested result to be valid

Generic quality concerns are not repeated automatically as ledger criteria. They remain in the process vector unless a concrete defect makes them necessary to the requested result.

Requirements changed or retracted during the session are retained in the immutable `frozenLedger` (their definitions, §5.1) and classified `status: 'superseded'` in the final `ledger`; they are excluded from every attainment view and do not count toward final attainment (§6.1).

### 4.3 Process vector

The process vector records reusable behavioural characteristics that criterion attainment alone cannot explain:

- Requirement discipline
- Verification discipline
- Scope control
- Recovery effectiveness
- Final-claim accuracy

Cost, latency, token use, tool calls, skill use, pruning, retries, and failures remain objective runtime telemetry. Reviewers do not score those facts subjectively.

### 4.4 Evidence vector

Evidence coverage is separate from outcome quality. It records what the review could observe about:

- Requirements
- Artifacts/diffs
- Execution checks
- Human-only observations

A session can be successful but evidence-limited. Missing evidence must not be silently interpreted as either success or failure.

### 4.5 Component assessment and canonical review

Each selected session receives:

1. An independent small-bucket assessment
2. An independent medium-bucket assessment
3. A single canonical review derived from their agreement or a third medium-bucket adjudication

`small`, `medium`, and `frontier` are **bucket selection hints**, not fixed model tiers. Each bucket’s model list is user-configured in `subagentBuckets` (`ChatPrefs`, settings UI) and mirrored into the subagent extension at runtime via the `PIE_SUBAGENT_BUCKETS_JSON` environment variable (see `extensions/subagent`). A bucket may be empty, or have all of its models filtered out by thinking support, provider toggles, exclusions, or live capacity; in that case the selector **downgrades** the request to the next cheaper non-empty bucket (`medium` → `small`; `small` with no remaining candidate falls back to the caller’s active model). The review pipeline therefore requests `small` and `medium` for the two routine reviewers and `medium` for the consolidator/adjudicator, but the **effective** bucket/model that actually runs may differ from the request.

Every reviewer call record persists **both** the requested bucket and the runtime-captured effective bucket/model (`requestedBucket`, effective `bucket`, `modelId`, `provider`, `family`, `thinkingLevel`, `bucketDowngraded`; §12.1), and reviewer diversity is computed from the **actual effective resolution** (§10 Pass 1) — never from the requested labels alone. The `frontier` bucket is a valid key but is excluded from routine review as too expensive; it remains available for explicit calibration/audit runs. Both component assessments and any adjudication are retained. Only the canonical review counts as the session’s official production rating.

## 5. Criterion ledger design

### 5.1 Proposed criterion contract

```ts
type CriterionOrigin = 'explicit' | 'necessary_implied';
type CriterionImportance = 'core' | 'supporting' | 'optional';
type CriterionStatus =
  | 'met'
  | 'partly_met'
  | 'unmet'
  | 'blocked'
  | 'not_assessable'
  | 'superseded';

type CriterionReason =
  | 'none'
  | 'omitted'
  | 'attempt_failed'
  | 'incorrect_result'
  | 'regression'
  | 'external_blocker'
  | 'user_dependency'
  | 'human_evidence_missing'
  | 'insufficient_artifact_evidence'
  | 'unknown';

type CriterionActivity =
  | 'implement'
  | 'debug'
  | 'investigate'
  | 'explain'
  | 'design'
  | 'operate'
  | 'verify'
  | 'other';
type CriterionSurface =
  | 'ui'
  | 'application_logic'
  | 'api_integration'
  | 'data'
  | 'tests'
  | 'documentation'
  | 'configuration'
  | 'infrastructure'
  | 'developer_tooling'
  | 'agent_harness'
  | 'external_system'
  | 'communication'
  | 'other';
type CriterionEvidenceMode =
  | 'static_inspection'
  | 'automated_check'
  | 'runtime_observation'
  | 'human_observation'
  | 'external_confirmation'
  | 'reasoning_or_sources'
  | 'other';

// Immutable criterion definition — *what* the session was expected to satisfy.
// Proposed in Pass 1 and frozen in Pass 2 (the `frozenLedger`). Carries no
// classification: no status, reason, evidence, or finding references.
interface CriterionDefinition {
  criterionId: string;
  statement: string;
  origin: CriterionOrigin;
  importance: CriterionImportance;
  taxonomy: {
    activity: CriterionActivity;
    surface: CriterionSurface[];
    evidenceMode: CriterionEvidenceMode[];
  };
}

// A criterion definition plus its classification. Produced in Pass 5/6 over the
// frozen ledger (and over accepted post-freeze amendments). This is what the
// canonical classified `ledger` stores.
interface ClassifiedCriterion extends CriterionDefinition {
  status: CriterionStatus;
  reason: CriterionReason;
  evidenceRefs: string[];
  findingRefs: string[];
}
```

Taxonomy values are versioned fixed enums with an `other` escape hatch. Activity, surface, and required evidence mode are separate axes rather than one expanding combined enum. The enum values above are the initial v1 sets.

The definition/classification split is structural: Pass 1 proposes and Pass 2 freezes `CriterionDefinition[]` (the immutable `frozenLedger`, hashed as `frozenLedgerSha256`); Pass 5/6 classify those definitions into `ClassifiedCriterion[]` (the final `ledger`). A definition never carries status, reason, evidence, or finding references — those belong only to a classified criterion.

### 5.2 Importance anchors

- **Core:** failing this criterion defeats the primary value of the session.
- **Supporting:** materially affects quality or completeness but does not erase all primary value.
- **Optional:** explicitly requested or useful polish whose absence leaves the core result intact.

Importance reflects user value, not implementation difficulty or technical severity.

### 5.3 Status anchors

- **Met:** available evidence supports full satisfaction of the criterion.
- **Partly met:** useful material progress exists, but a bounded gap remains.
- **Unmet:** the criterion was feasible but omitted, failed, incorrect, or regressed.
- **Blocked:** an identified dependency prevented satisfaction; `reason` distinguishes a genuinely external blocker (`external_blocker`) from a user/dependency blocker (`user_dependency`) or an undiagnosed one (`unknown`).
- **Not assessable:** the review cannot determine attainment from available evidence.
- **Superseded:** later user intent replaced or removed the criterion.

The reason code provides diagnosis and auditability. Analytics primarily quantify the stable status and importance fields.

#### Status/reason invariants

`recordReview` validates the `status`/`reason` pair of every classified criterion in the canonical `ledger`. The allowed reasons per status are:

| status | allowed `reason` values |
|---|---|
| `met` | `none` |
| `partly_met` | `omitted`, `attempt_failed`, `incorrect_result`, `regression`, `unknown` |
| `unmet` | `omitted`, `attempt_failed`, `incorrect_result`, `regression`, `unknown` |
| `blocked` | `external_blocker`, `user_dependency`, `unknown` |
| `not_assessable` | `human_evidence_missing`, `insufficient_artifact_evidence`, `unknown` |
| `superseded` | `none` |

Headline invariants (validated; a violation rejects the review):

- **`reason: external_blocker` is valid only with `status: blocked`.** No other status may carry `external_blocker`. The converse is not required: a `blocked` criterion may instead carry `user_dependency` or `unknown`.
- `met` and `superseded` carry `reason: none` (they are not defects).
- A gap/blocker/evidence diagnosis reason (`omitted`, `attempt_failed`, `incorrect_result`, `regression`, `external_blocker`, `user_dependency`, `human_evidence_missing`, `insufficient_artifact_evidence`) is never valid with `met` or `superseded`; `unknown` is the escape hatch for the remaining non-`met`/non-`superseded` states.

**Controllable exclusion is derived from the pair, not the reason alone.** A criterion is removed from the agent-controllable active set iff `status: blocked` **and** `reason: external_blocker` (§6.1). The invariant above guarantees `external_blocker` ⇒ `blocked`, so the reason check alone would be equivalent today, but the controllable derivation checks **both** fields so it stays correct if a future reason is added and so a `blocked` criterion with a non-external reason (`user_dependency`/`unknown`) stays in the controllable set (counts as 0, controllable but not delivered) rather than being normalized out.

### 5.4 Findings and criterion consistency

Every critical or major correctness finding must:

- Downgrade an existing criterion (worsen its classification — status/reason), or
- Add a necessary-implied criterion that the defect violates

The two paths respect the freeze boundary:

- **Before the ledger is frozen (Pass 2):** an “add” is folded into the `frozenLedger` by the consolidator, which assigns the stable criterion ID.
- **After the ledger is frozen (Pass 5+):** an “add” cannot mutate the immutable `frozenLedger`. The reviewer proposes an explicit **criterion-amendment proposal** (`CriterionAmendmentProposal`, §12.1) carrying the proposed `CriterionDefinition` and motivating finding. Every proposal always triggers medium adjudication (§10 Pass 6), which records one of four **dispositions** (`CriterionAmendment`, §12.1):
  1. **`accepted`** — the proposed criterion is classified and added to the canonical `ledger`; the motivating finding keeps its severity and `ledgerEffect: 'add'` (now linked to the new criterion).
  2. **`mapped_to_existing`** — the adjudicator determines the defect actually maps to an existing frozen criterion, re-points the finding to that criterion (`criterionId` → existing id, `ledgerEffect: 'downgrade'`), and downgrades that criterion’s classification in the canonical `ledger`. No new criterion is added.
  3. **`finding_downgraded`** — the evidence supports only a `minor`/`nit` defect, so the adjudicator downgrades the finding severity to `minor`/`nit` and sets `ledgerEffect: 'none'`. No ledger change.
  4. **`rejected`** — the finding is not substantiated; it is dropped from the canonical findings and no criterion is added or downgraded.

  A critical/major finding that motivates a post-freeze add may **not** survive canonically without ledger effect. The adjudicator must choose one of the four dispositions above; “reject the amendment but keep the critical/major finding with `ledgerEffect: 'none'`” is not permitted. If the defect is real and material, it flows into the ledger (disposition 1 or 2); if the evidence is thin, the finding is downgraded (3) or rejected (4). Only an `accepted` amendment’s classified criterion, and only a `mapped_to_existing` disposition’s `downgradedClassification`, modify the canonical `ledger`.

This prevents a session from retaining full attainment despite a material defect and avoids double-penalizing the same issue through both ledger score and finding count.

Findings remain useful for severity, category, explanation, and evidence citations.

### 5.5 Finding contract

```ts
type FindingSeverity = 'critical' | 'major' | 'minor' | 'nit';
type FindingCategory =
  | 'correctness'
  | 'regression'
  | 'omission'
  | 'scope_drift'
  | 'verification_gap'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'attribution_error'
  | 'other';

interface ReviewFinding {
  findingId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  statement: string;
  evidenceRefs: string[];
  /** Required for critical/major: the criterion this finding downgrades, or —
   *  for an 'add' — the criterion the amendment proposes (see §5.4). Pre-freeze
   *  adds are folded into the frozenLedger by the consolidator; post-freeze adds
   *  go through an adjudicated criterion amendment (§12.1). Optional for minor/nit. */
  criterionId?: string;
  /** 'downgrade' = existing criterion worsened; 'add' = new necessary-implied
   *  criterion created (pre-freeze via the consolidator, post-freeze via an
   *  adjudicated amendment); 'none' = minor/nit with no ledger effect. */
  ledgerEffect: 'downgrade' | 'add' | 'none';
  remediation: string;
}
```

Severity anchors:

- **Critical:** the result is wrong, harmful, or unusable as delivered. Must add or downgrade a **core** criterion.
- **Major:** a material correctness or completeness defect that defeats part of the session’s value. Must add or downgrade a **core or supporting** criterion.
- **Minor:** a bounded gap that does not defeat the core result; may attach to a supporting/optional criterion but does not by itself change overall attainment.
- **Nit:** style/clarity polish with no outcome effect; `ledgerEffect: 'none'`.

`ledgerEffect: 'none'` is valid only for `minor`/`nit`. A canonical `critical`/`major` finding must carry a `criterionId` and a non-`none` `ledgerEffect` (`downgrade` or `add`) — material defects must flow into the ledger (as a downgrade of an existing criterion, a pre-freeze consolidator add, or a post-freeze adjudicated amendment / `mapped_to_existing` mapping, §5.4) so the quality index reflects them without a separate finding penalty (see §6.3). A post-freeze `critical`/`major` finding that cannot be sustained as material is resolved by adjudication: the adjudicator accepts the amendment, maps/downgrades an existing criterion, **downgrades the finding severity to `minor`/`nit`** (after which `ledgerEffect: 'none'` becomes valid), or **rejects the finding**. It may not leave a `critical`/`major` finding canonically with `ledgerEffect: 'none'`. Validation rejects any record that violates this.

## 6. Derived attainment

### 6.1 Active sets and class-specific rates

Attainment is derived over **explicit active sets per view**, never over the raw ledger. The orchestrator computes two active sets before any rate or overall category is derived:

- **Delivered active set** = all criteria **except `superseded`**. A blocked criterion remains undelivered (counted as `blocked`, not met).
- **Controllable active set** = delivered active set **except criteria with `status: blocked` and `reason: external_blocker`** (the externally-blocked pair, §5.3). The status/reason invariant guarantees `external_blocker` ⇒ `blocked`, so checking the reason alone is equivalent today, but the derivation checks **both** fields so a `blocked` criterion with a non-external reason (`user_dependency`/`unknown`) stays in the controllable set. Externally blocked criteria are removed from the controllable numerator **and** denominator; the external-blocker rate is reported separately.

Normalization rules:

- **`superseded` is excluded from every view** (both active sets). Superseded criteria are reported as a count but never enter attainment.
- **The externally-blocked pair is additionally excluded only from the controllable view.** Only criteria with `status: blocked` **and** `reason: external_blocker` are normalized out; omissions, failed attempts, `user_dependency`-blocked criteria, and blockers the agent could reasonably have resolved are **not** normalized out (they remain in the controllable set and count as 0).
- **`not_assessable` criteria stay in both active sets** (they remain in coverage/assessability) but are excluded from attainment numerators/denominators and reported via an explicit assessability/coverage rate.

For each class `c ∈ {core, supporting, optional}` and each view, analytics derive counts and rates over the view’s active set (`CriterionAttainmentSummary`, §12.1): `total` (active-set size; `superseded` reported separately), `assessable` (active set minus `not_assessable`), `controllableDenominator` (controllable active set minus `not_assessable` = assessable minus the externally-blocked pair), `met`/`partlyMet`/`unmet`/`blocked`/`externalBlocked`/`notAssessable` counts, `deliveredRate = (met + 0.5·partlyMet) / assessable` (delivered view), and `controllableRate = (met + 0.5·partlyMet) / controllableDenominator` (controllable view). `blocked` includes every `status: 'blocked'` criterion, so `externalBlocked` is its subset in the delivered view; in the controllable view, external blockers are removed from the active set and therefore from `blocked`, while `externalBlocked` remains a separately reported diagnostic count.

Provisional numeric mapping: `met = 1`, `partly_met = 0.5`, `unmet = 0`, `blocked = 0` (delivered view); `external_blocker` blocked criteria are normalized out of the controllable view (above) while other `blocked` criteria count as 0 (controllable but not delivered); `superseded` excluded; `not_assessable` excluded from attainment but kept in coverage. Both views must be shown together where blocker handling could change interpretation. The mapping and not-assessable handling must be versioned and calibrated before leaderboard use.

### 6.2 Overall attainment

The deterministic first-match rule is applied **only to the normalized outcome sets** derived from each view’s active set (§6.1), never to the raw ledger. Within each view the outcome sets additionally ignore `not_assessable` **supporting/optional** criteria for outcome determination (they remain in coverage, §6.1); `not_assessable` **core** criteria are not ignored — they affect the outcome.

Per view:

- **Outcome core set** = core criteria in the view’s active set (`superseded` excluded everywhere; `external_blocker` excluded for the controllable view).
- **Outcome supporting set** = supporting criteria in the view’s active set, minus `not_assessable` (ignored for outcome, kept in coverage).
- **Optional** criteria never determine the outcome (reported separately).

Rules (first match, per view, evaluated over the outcome core set then the outcome supporting set):

1. `not_assessable` — every core in the outcome core set is `not_assessable` (no assessable core remains). For the controllable view, if excluding `external_blocker` leaves no controllable core criterion, the controllable overall is `not_assessable`.
2. `achieved` — at least one core is `met`/`partly_met`, every core is `met`, and every supporting criterion in the outcome supporting set is `met`.
3. `mostly_achieved` — every core is `met`, but one or more supporting criteria in the outcome supporting set has a gap (`partly_met`/`unmet`/`blocked`).
4. `partly_achieved` — at least one core is `met` or `partly_met` (some core value delivered), but at least one core is not fully met (`partly_met`/`unmet`/`blocked`/`not_assessable`).
5. `not_achieved` — no core is `met` or `partly_met`, and at least one core is assessable (`unmet`/`blocked`).

Optional criteria are reported separately and do not change the overall category. Several optional successes cannot outweigh an unmet core requirement.

**`not_assessable` supporting/optional handling.** A `not_assessable` supporting/optional criterion never determines the overall state and never blocks `achieved`/`mostly_achieved`; it only lowers evidence coverage and confidence (§8). A `not_assessable` core criterion is not ignored: a single one amid otherwise-met cores leaves the session `partly_achieved` (rule 4), and the overall `not_assessable` state (rule 1) requires every core criterion to be non-assessable.

**All-core-blocked divergence.** When every core criterion is `blocked` with `reason: external_blocker` (the externally-blocked pair, §5.3):

- Delivered-result view: `not_achieved` (no core value was delivered — rule 5).
- Agent-controllable view: `not_assessable` (no controllable core criterion remains to assess — rule 1).

This divergence is intentional and must be reported as both views side by side. It captures the user’s “report both” decision: the session delivered nothing, but the agent was not at fault for the miss. The quality index (§6.3) is `null` for such a session because there is no agent-controllable attainment to rank.

The delivered-result view includes blocked criteria as undelivered. The agent-controllable view excludes only criteria with `status: blocked` and `reason: external_blocker` (genuinely outside the agent’s practical control); it does not exclude omissions, failed attempts, `user_dependency`-blocked criteria, or blockers the agent could reasonably have resolved.

### 6.3 Quality index

Analytics may expose one versioned, derived quality index for model/harness summaries. It is not supplied by the reviewer and is not canonical source data.

The primary model/harness quality index uses **agent-controllable criterion attainment**. Delivered-result attainment remains visible beside it as a user-value measure. Process-vector classifications remain separate optimization dimensions so analysts can tell whether a harness changed outcomes, behaviour, cost, or latency.

#### Provisional index v1

`qualityIndexV1` is a 0–100 score computed only from agent-controllable, assessable criterion attainment — **no separate finding penalty** and **no coverage/confidence multiplier**. Critical/major defects already downgrade existing criteria or add necessary-implied unmet criteria (§5.4/§5.5), so penalizing findings again would double-count the same defect.

**Core primacy by deterministic bands.** The index is anchored first by `controllableOverall` (§6.2), which is core-driven; the band can never be escaped by supporting/optional success. Within a band, criterion attainment refines the exact value only:

```
qualityIndexV1 = null                                        # controllableOverall = not_assessable
               = clamp(round(bandFloor + bandWidth · A_band, 1),
                       bandFloor, bandCeiling)               # otherwise

bands by controllableOverall (core primacy):
  not_achieved      → [0,  24]    floor=0,   ceiling=24,  width=24
  partly_achieved   → [25, 59]    floor=25,  ceiling=59,  width=34
  mostly_achieved   → [60, 84]    floor=60,  ceiling=84,  width=24
  achieved          → [85, 100]   floor=85,  ceiling=100, width=15

A_band = weightedAgentControllableAttainment            # within-band refinement, 0..1
       = Σ_c w_c · (n_met_c + 0.5·n_partlyMet_c)  /  Σ_c w_c · n_controllable_c
       (0 when the denominator is 0)

class weights:  w_core = 1.0   w_supporting = 0.5   w_optional = 0.25
```

Where for each class `c ∈ {core, supporting, optional}`:

- `n_met_c`, `n_partlyMet_c` count criteria with that status.
- `n_controllable_c` = criteria in the controllable active set (§6.1) minus `not_assessable` — i.e. not `superseded`, not `not_assessable`, and not externally blocked (`status: blocked` ∧ `reason: external_blocker` normalized out). Non-external `blocked` criteria (e.g. `user_dependency`/`unknown`) stay in this set and contribute 0 (not delivered, but controllable).

Design notes:

- **Purely outcome-based:** the index reflects only criterion attainment. Coverage, review confidence, and blocker rates are reported **separately** (§6.1, §8, §14.1) and are never folded into the index, so an evidence-thin session cannot be masked by a high band — it scores high only if its assessable controllable criteria are genuinely met.
- **Core primacy is structural:** the band is fixed by `controllableOverall` (core-driven), so a session with an unmet core cannot land in the `achieved`/`mostly_achieved` bands no matter how many supporting/optional criteria are met.
- **Within-band refinement only:** `A_band` selects the precise value inside the band; clamping keeps it from leaking into an adjacent band.
- `null` (not 0) when `controllableOverall = not_assessable`, so un-assessable sessions are excluded from rankings rather than ranked last.
- Optional criteria contribute only marginally and cannot rescue a weak core.
- The bands, the `partly_met = 0.5` mapping, the weights, and the `null` rule are versioned (`indexVersion: 'v1'`) and recalibrated against the corpus before leaderboard use.

Any dashboard index must be accompanied by:

- Component attainment rates
- Criterion coverage
- Sample size and uncertainty
- Task/criterion mix
- Review rubric/index version
- Reviewer mix

## 7. Compact process vector

```ts
interface ReviewProcessVector {
  requirementDiscipline:
    | 'proportionate'
    | 'underclarified'
    | 'overclarified'
    | 'not_assessable';
  verificationDiscipline:
    | 'proportionate'
    | 'underverified'
    | 'oververified'
    | 'not_applicable'
    | 'not_assessable';
  scopeControl:
    | 'controlled'
    | 'minor_avoidable_drift'
    | 'material_scope_drift'
    | 'not_assessable';
  recovery:
    | 'effective'
    | 'partly_effective'
    | 'ineffective'
    | 'not_needed'
    | 'not_assessable';
  finalClaimAccuracy:
    | 'accurate'
    | 'overclaimed'
    | 'underclaimed'
    | 'unclear'
    | 'no_final_claim';
}
```

Rubric anchors must distinguish process quality from outcome quality. For example, a session may attain its requirements despite underverification, or fail despite proportionate recovery from an external blocker.

## 8. Evidence vector and confidence

```ts
interface ReviewEvidenceVector {
  requirements: 'clear' | 'partly_clear' | 'unclear';
  artifacts: 'direct' | 'partial' | 'none' | 'not_applicable';
  execution: 'direct' | 'partial' | 'reported_only' | 'none' | 'not_applicable';
  human:
    | 'not_needed'
    | 'supports'
    | 'contradicts'
    | 'inconclusive'
    | 'unanswered'
    | 'unavailable';
  limitations: string[];
}

type ReviewConfidence = 'high' | 'medium' | 'low';
```

Confidence describes confidence in the classifications, not confidence displayed by the original agent.

Evidence limitations should explicitly identify transcript truncation, missing artifacts, workspace drift, ambiguous attribution, unavailable execution state, and unanswered human checks.

## 9. Human verification

### 9.1 Scope

Human verification is initiated by the review workflow—not prescribed for the original working agent.

It is appropriate only for a material criterion that reviewers cannot verify reliably, such as:

- Visual appearance or perceptual polish
- Interaction feel or workflow intuitiveness
- Copy tone or product semantics
- Behaviour in an external account, device, permission boundary, or environment
- Accessibility experience unavailable to automated checks

A human response is scoped criterion evidence. It is never a whole-session score.

### 9.2 Collection policy

The reviewer must first inspect **all selected sessions** and collect all candidate human-only uncertainties.

After the inspection/consolidation pass:

- Ask at most one focused `ask_user` question per affected session.
- Ask questions sequentially.
- Name the target session and exact criterion/surface.
- State the intended observation and minimum reproduction steps.
- Offer neutral options including failure/custom/unavailable paths where appropriate.
- Do not reveal the author model or preferred answer.

If several human-only uncertainties exist in one session, choose the highest-importance unresolved criterion and design one high-information question. Other gaps remain explicit evidence limitations.

### 9.3 Structured targeting

Because `ask_user` runs in the reviewer session, its request/response routing stays owned by the reviewer session: the question is asked and answered in the reviewer session’s own interaction context, never relocated to the reviewed session’s tab. The `reviewMeta` metadata labels the reviewed session explicitly for display, audit, and attribution only — it does not change where the interaction is routed. The existing `ask_user` tool is extended with an optional `reviewMeta` field (no new interaction tool is added):

```ts
interface ReviewHumanVerificationMetadata {
  purpose: 'review_human_verification';
  targetSessionId: string;      // stable session-header ID (§4.1) of the REVIEWED session (display/audit/attribution; not a routing key)
  targetSessionPath: string;    // mutable display/location metadata
  criterionId: string;
  domain: string;
  expectedObservation: string;
}

interface AskUserReviewInput {
  question: string;
  options: string[];
  allowCustom?: boolean;
  context?: string;
  reviewMeta?: ReviewHumanVerificationMetadata;   // present only for review questions
}
```

When `reviewMeta` is present, the host keeps request/response routing in the reviewer session and tags the resulting tool call/result with `targetSessionId` for display, audit, and attribution only — it does **not** route the prompt to the reviewed session’s tab context. The reviewer embeds the **entire** `ask_user` tool call (input, including `reviewMeta`) and its result (`answer`, `source`, `cancelled`, status) directly in the canonical review record as `humanCheck` (see §12). No separate human-check writer tool exists: the single `recordReview` write persists the question, answer or cancellation, response status, and interpretation as review evidence keyed by `targetSessionId`.

### 9.4 Unanswered questions

If the user cannot answer, cancels, or does not provide decisive evidence:

- Record `unanswered`, `unavailable`, or `inconclusive` truthfully.
- Rate every assessable criterion to the best of the reviewers’ ability.
- Mark affected criteria `not_assessable` where necessary.
- Lower confidence or evidence coverage proportionately.
- Still persist the review and close the session unless closure itself fails.

## 10. Multi-reviewer workflow

### Pass 0 — Target snapshot

1. Parse the user’s review instruction and resolve the selected/open/pinned target set.
2. Snapshot stable session IDs and current paths.
3. Exclude the reviewer session.
4. **Partition by review state (once-only, §13.1).** Look up each selected session’s stable ID against existing canonical production reviews:
   - **Unrated** — not yet canonically reviewed. These run the full pipeline (Pass 1–7): rated then closed.
   - **Already canonically reviewed** — a prior production review with the same `sessionId` exists. These are **skipped for rating** (no Pass 1–6, no second review attempted) but are still **queued as closure targets**: the orchestrator enqueues a `closeReviewed` closure action (§13.5) carrying the **existing** `reviewId`, so “review and close each pinned session” closes them without re-rating. If the existing review’s closure is already settled (`succeeded`), the enqueue is an idempotent no-op.
5. Fetch evidence once per **unrated** session and record the evidence manifest (raw JSONL SHA-256, artifact hashes, limitations) per §14.6. Already-reviewed sessions need no fresh evidence fetch for rating; closure uses the existing `reviewId`.

**Blinding bundle contract.** Every reviewer and adjudicator receives the same blinded evidence bundle for a session. The bundle contains: the frozen ledger (`frozenLedger`, `CriterionDefinition[]`, and `frozenLedgerSha256`; from Pass 2 onward), a rendered transcript excerpt, the diff/changed-file manifest, the immutable shared reviewer-check results and their hash (from Pass 3 onward), and (from Pass 5) the human-response evidence. The bundle **must not** contain: author `modelId`/`provider`/`thinkingLevel`/family, `model_change` entries, host/settings versions, model reputation, or any reviewer-identifying labels. Author-identity-bearing fields are stripped or redacted at bundle-build time; the raw session JSONL is hashed but **not** handed to reviewers (it contains `model_change` lines). Runtime/tooling records `blindingApplied` and the list of stripped fields in provenance (§12) rather than trusting caller-supplied claims.

### Pass 1 — Independent ledger proposals

For every target session, launch two isolated reviewer calls in parallel where concurrency permits:

- One requested from the `small` bucket
- One requested from the `medium` bucket

The selector uses a balanced shuffled cycle for each bucket’s eligible model list (`subagentBuckets` → `PIE_SUBAGENT_BUCKETS_JSON`, §4.5): it shuffles the eligible models, consumes each model once, then reshuffles for the next cycle rather than drawing independently with replacement. Eligibility is filtered by thinking support, provider toggles, exclusions, and live capacity before each cycle/request. A requested bucket with an empty eligible pool **downgrades** to the next cheaper non-empty bucket (`medium` → `small`), or falls back to the active model only if every bucket at or below the request is empty. Each reviewer record persists the **requested** bucket alongside the runtime-captured **effective** bucket/model (§12.1).

**Reviewer diversity.** The two routine reviewer roles are requested from `small` and `medium`. `diversityAchieved` (recorded in provenance, §12.1) is computed from the **actual effective resolution** of the two final component assessments (Pass 5) — `true` iff their effective models differ in family and/or provider (read from runtime-captured `modelId`/`provider`/`family`), never from the requested labels. Where a bucket’s configured list offers more than one family/provider, the orchestrator may bias a selection away from the other role’s family (e.g. via exclusions) to improve diversity; where the configured buckets only contain same-family models, diversity may be impossible and the run proceeds with `diversityAchieved: false`. Reviewers are blinded to author identity/treatment and to each other’s work.

Each reviewer independently proposes:

- Criterion **definitions** — statement, origin, importance, and taxonomy (`CriterionDefinition`, §5.1); no status/reason/evidence classification yet (classification is Pass 5)
- Material findings (each carrying its own evidence references)
- Candidate human-only uncertainty
- Candidate reviewer-generated checks (proposed specs only; selection and execution are shared in Pass 3, not run per reviewer)

Reviewer calls are isolated per target session to prevent evidence leakage between unrelated sessions. This is calls 1–2 of the ~5-call budget (§1).

### Pass 2 — Ledger consolidation

A separate medium-bucket consolidator receives both proposals and the blinded evidence bundle. It produces one frozen ledger of criterion **definitions** (`frozenLedger`, `CriterionDefinition[]`; no classification) per session before final classification. This is call 3 of the ~5-call budget.

The consolidator:

- Deduplicates semantically equivalent criteria
- Resolves requirement-boundary disagreements
- Retains superseded requirements
- Enforces explicit/necessary-implied scope
- Assigns stable criterion IDs
- Selects at most one material human-verification question candidate
- Computes `frozenLedgerSha256` over the immutable `frozenLedger` (definitions only) and records consolidation provenance (source proposal IDs, dedup/merge notes) so the definitions are immutable and auditable from this point onward (§12)

The `frozenLedger` is immutable from here on: Pass 5 classifies its definitions into the separate classified `ledger` (`ClassifiedCriterion[]`), and any criterion a reviewer needs to *add* after this point goes through an adjudicated amendment (§5.4, §10 Pass 6) rather than mutating `frozenLedger`. After every selected session reaches this point, the orchestrator has the complete batch question set and the `frozenLedger` that Pass 3 draws reviewer-check candidates from.

### Pass 3 — Shared reviewer-check selection and execution

After consolidation, the orchestrator runs **one** shared, deterministic reviewer-check pass per session. This replaces per-reviewer check execution so both final reviewers (Pass 5) and the adjudicator (Pass 6) see identical, immutable check evidence.

The orchestrator:

- Collects candidate check specs from both Pass-1 proposals (§10 Pass 1)
- Deduplicates semantically equivalent checks, drops any that violate the §11 safety policy, and caps the set at ~5 per session
- Executes each selected check exactly once, read-only, under the §11 safety/budget policy
- Check specs use the executable discriminated union (§12.1): `command`/`automated_check` require `command`+`cwd`; `static_inspection` requires `target`+`query`. `reasoning` is not an executable check kind and is never run in Pass 3.
- Freezes the executed results as `ReviewerCheck[]` and computes `reviewerChecksSha256` over them

The frozen `ReviewerCheck[]` and `reviewerChecksSha256` are appended to the blinded evidence bundle (§10 blinding contract) and delivered unchanged to both Pass-5 final reviewers and the Pass-6 adjudicator. No reviewer or adjudicator may add, drop, or re-execute checks; they only cite the shared results as evidence. This consumes no additional model call — selection is orchestrator-driven and execution is deterministic tooling.

### Pass 4 — Human questions

Ask the collected questions sequentially, one per affected session, through `ask_user` with `reviewMeta` labelling the reviewed session for display/audit/attribution (§9.3). Store each response against the target session and criterion; the tool call and result are embedded in the canonical review’s `humanCheck` at record time (no separate writer).

Do not finalize any component classifications before the batch’s human evidence is collected or marked unavailable.

### Pass 5 — Independent final classifications

Send the same `frozenLedger` (`CriterionDefinition[]`), final evidence bundle (including the immutable shared reviewer-check results from Pass 3), and human response to fresh small- and medium-bucket reviewer calls. These are calls 4–5 of the ~5-call budget.

Each reviewer classifies the frozen definitions and returns:

- A `ClassifiedCriterion` (definition + status/reason/evidenceRefs/findingRefs) for every frozen criterion
- Process vector
- Evidence vector
- Findings
- Confidence
- Proposed overall attainment (for comparison only; canonical derivation remains deterministic)
- Proposed **criterion amendments** for any critical/major defect that requires *adding* a criterion not in the `frozenLedger` (§5.4); these always trigger adjudication (Pass 6)

Both component assessments are persisted in the canonical review record.

### Pass 6 — Disagreement and adjudication

**Material disagreement** (any one) invokes a third, fresh medium-bucket adjudicator (the optional 6th call). Material triggers are complete with respect to off-scale and incomparable values — a conservative merge is never applied where it would be contradictory:

- **Criterion status (core):** any disagreement on a core criterion’s status, including any pair involving `blocked`, `not_assessable`, or `superseded`.
- **Criterion status (supporting/optional):** a two-or-more-step gap on the graded scale (`met` ↔ `unmet`), **or** any disagreement involving `blocked`, `not_assessable`, or `superseded`. These three statuses are off the `met`→`partly_met`→`unmet` graded scale; a “more conservative” pick among them is not defined, so they always escalate to adjudication.
- **Findings:** a `critical` or `major` finding, or a regression finding, reported by only one reviewer.
- **Evidence `human` field:** any unequal `evidence.human` value between the two reviewers is material. The field is categorical (`not_needed`/`supports`/`contradicts`/`inconclusive`/`unanswered`/`unavailable`), not a graded scale, so no conservative pick is defined for any unequal pair.
- **Criterion amendments:** any proposed amendment (a post-freeze `add` of a necessary-implied criterion, §5.4) is always material and always adjudicated. The adjudicator records one of four dispositions (`CriterionAmendment`, §12.1): `accepted` (classify and add the new criterion to the `ledger`), `mapped_to_existing` (re-point the finding to an existing frozen criterion and downgrade that criterion’s classification in the `ledger`), `finding_downgraded` (evidence supports only `minor`/`nit`, so downgrade the finding severity and set `ledgerEffect: 'none'`), or `rejected` (drop the finding). A `critical`/`major` finding may not survive canonically without ledger effect — the adjudicator must accept, map/downgrade, downgrade severity, or reject; “reject the amendment but keep the critical/major finding with no ledger effect” is invalid.
- **Process vector:** any opposite or incomparable pair. Opposite pairs span the field’s two error poles — `proportionate` vs `oververified`/`overclarified`, `underverified` vs `oververified`, `underclarified` vs `overclarified`, `effective` vs `ineffective`, `controlled` vs `material_scope_drift`, `accurate` vs `overclaimed`, `accurate` vs `underclaimed`, `overclaimed` vs `underclaimed`. Incomparable pairs are any substantive value vs `not_assessable`/`not_applicable`/`not_needed`/`no_final_claim`. (This deliberately removes the earlier contradiction in which `accurate` vs `overclaimed` was listed as both an opposed/material trigger and a conservative merge rule.)

The adjudicator receives both assessments, the shared blinded evidence bundle (including the immutable reviewer-check results from Pass 3), and the human-response evidence, resolves each disputed field with evidence citations, and produces the canonical result. Both component assessments and the adjudication are retained.

**Non-material disagreement** is resolved by deterministic, conservative merge rules — applied **only** to adjacent ordered pairs on a single graded axis, never by averaging categorical judgements and never to an off-scale or incomparable pair:

- **Criterion status:** only when both reviewers select from `{met, partly_met, unmet}` and differ by exactly one step (`met`↔`partly_met`, `partly_met`↔`unmet`) → adopt the **lower** status. Any pair involving `blocked`/`not_assessable`/`superseded` is never merged; it escalates (above).
- **Reason code:** adopt the reason belonging to the chosen status; if both map to the same status, prefer the more specific reason.
- **Process vector (graded adjacent pairs only):** `proportionate`↔`underverified` → `underverified`; `proportionate`↔`underclarified` → `underclarified`; `controlled`↔`minor_avoidable_drift` → `minor_avoidable_drift`; `minor_avoidable_drift`↔`material_scope_drift` → `material_scope_drift`; `effective`↔`partly_effective` → `partly_effective`; `partly_effective`↔`ineffective` → `ineffective`. Two-step graded gaps (e.g. `controlled`↔`material_scope_drift`, `effective`↔`ineffective`) and all `finalClaimAccuracy` disagreements are material (no conservative pick is defined for the claim-accuracy directions).
- **Evidence vector:** take the union of `limitations`; for the graded coverage fields (`requirements`, `artifacts`, `execution`) adopt the weaker coverage (`partial` over `direct`, `unclear` over `partly_clear`, `reported_only` over `partial`); the `human` field is never conservatively merged — any unequal `human` value is material (above); `none`/`not_applicable` vs a graded value is material (incomparable).
- **Findings:** union both sets; a minor/nit reported by only one reviewer is kept.
- **Confidence:** adopt the lower of the two.
- **proposedOverall:** discarded; the canonical overall attainment is derived deterministically from the merged ledger (§6.2).

Every merged field records `resolution: 'deterministic_merge'`; adjudicated fields record `resolution: 'adjudicator'`; agreed fields record `resolution: 'small' | 'medium'`.

The canonical `findings` array reflects the adjudicated amendment dispositions: a `rejected` amendment’s motivating finding is dropped, a `finding_downgraded` amendment’s finding is reduced to its `downgradedSeverity` with `ledgerEffect: 'none'`, a `mapped_to_existing` amendment’s finding is re-pointed to `targetCriterionId` with `ledgerEffect: 'downgrade'`, and an `accepted` amendment’s finding keeps its severity with `ledgerEffect: 'add'` linked to the new criterion. Component assessments retain the original (pre-adjudication) findings unchanged.

### Pass 7 — Record and close

1. Persist one immutable canonical production review keyed by stable session ID (§13.1).
2. Reject or idempotently return the existing record on an ordinary duplicate write (once-only).
3. After review persistence succeeds, enqueue a `closeReviewed` closure action in the closure-action outbox (§13.5); closure is attempted and retried independently of review persistence.
4. If closure fails, retry it through the outbox control record without writing a second review.
5. Continue until every selected target has a settled closure action — unrated sessions closed after their new review persists, already-reviewed sessions closed via their existing `reviewId` (Pass 0).
6. Enqueue a `closeSelf` closure action for the reviewer session after presenting the batch summary.

Review persistence and tab closure remain conceptually separate and now live in separate stores: `reviews.jsonl` holds only review/calibration records; the closure-action outbox (§13.5) holds `closeReviewed`/`closeSelf` actions and their retry state. Closure is a pure explicit action: `recordReview` no longer implicitly closes a tab via `done: true`; only `closeReviewed`/`closeSelf` close (§13.2).

## 11. Reviewer-generated checks

The orchestrator selects and executes a **single shared set** of non-source-mutating checks against the final artifacts, once per session, in Pass 3 (§10). Candidate check specs are contributed by both Pass-1 proposals; the orchestrator deduplicates, safety-filters, caps at ~5, and executes them so both final reviewers (Pass 5) and the adjudicator (Pass 6) see identical, immutable check evidence. No reviewer executes its own checks separately.

Reviewer-generated checks must be stored separately from original-agent checks (as shared `ReviewerCheck` entries on the canonical review record with a `reviewerChecksSha256`, §12) so analytics can distinguish:

- Whether the result was actually correct
- Whether the original agent verified it adequately
- Whether a defect was discovered only by review

The review must not credit reviewer work to the original agent.

**Safety policy.** Reviewer checks are read-only and must not alter source state, the working tree, or any external system:

- **Allowed:** read, grep, typecheck, build, test (in no-write/dry-run mode), `git status`/`git diff`, `session_changes` diff inspection, and reading generated/untracked files.
- **Prohibited:** edits/writes, network mutations, deployments, credential use beyond read, anything that changes source or external state, and any command requiring confirmation.
- A check that would mutate is declined and logged as `status: 'declined: mutating'`; it is never executed.
- **Budget:** at most ~5 reviewer checks per session; each check’s output is capped (reuse the transcript `MAX_TOTAL_CHARS` budget) so reviewer cost stays bounded. Executed commands, static targets/queries, and their verbatim outputs are recorded.
- A non-zero exit / failing check is recorded with `status: 'fail'` and may seed a finding, but executing it must not change any state.

## 12. Proposed production record

```ts
type OverallAttainment =
  | 'achieved' | 'mostly_achieved' | 'partly_achieved'
  | 'not_achieved' | 'not_assessable';
type ReviewKind = 'production' | 'calibration';

interface SessionReviewV2 {
  schemaVersion: number;
  kind: ReviewKind;                    // production is once-only canonical; calibration is non-canonical
  reviewId: string;
  sessionId: string;                 // stable session-header ID (§4.1)
  sessionPathAtReview: string;       // mutable location metadata
  identityFallback?: boolean;        // true when sessionId fell back to path hash
  rubricVersion: string;
  indexVersion?: string;            // e.g. 'v1' when quality index computed
  reviewedAt: string;

  // Pass-2 definitions never change; the canonical ledger is their Pass-5/6
  // classifications plus any adjudicated post-freeze amendments.
  frozenLedger: CriterionDefinition[];
  frozenLedgerSha256: string;
  ledger: ClassifiedCriterion[];
  amendments: CriterionAmendment[];
  attainment: {
    deliveredOverall: OverallAttainment;
    controllableOverall: OverallAttainment;
    core: CriterionAttainmentSummary;
    supporting: CriterionAttainmentSummary;
    optional: CriterionAttainmentSummary;
    qualityIndexV1: number | null;   // §6.3; null when not assessable
  };

  process: ReviewProcessVector;
  evidence: ReviewEvidenceVector;
  findings: ReviewFinding[];
  humanCheck?: ReviewHumanCheck;     // embedded ask_user call+result (§9.3)
  confidence: ReviewConfidence;

  // Multi-reviewer pipeline artefacts (§10):
  proposals: [ReviewerProposal, ReviewerProposal];       // Pass 1: independent ledger proposals
  consolidation: ConsolidationRecord;                    // Pass 2: frozen ledger + consolidation provenance
  reviewerChecks: ReviewerCheck[];                       // Pass 3: shared, immutable executed checks
  reviewerChecksSha256: string;                          // SHA-256 over the frozen reviewerChecks (Pass 3)
  components: [ReviewerAssessment, ReviewerAssessment];  // Pass 5: final classifications only
  disagreement: ReviewDisagreementSummary;              // Pass 6
  adjudication?: ReviewerAdjudication;                  // Pass 6, only on material disagreement
  provenance: ReviewProvenance;
}
```

Record validation requires `SessionReviewV2.frozenLedger` and its hash to exactly match `consolidation.frozenLedger` and `consolidation.frozenLedgerSha256`; the canonical `ledger` to classify every frozen definition exactly once, plus the `classifiedCriterion` of each `accepted` amendment and the `downgradedClassification` of each `mapped_to_existing` amendment (applied to its `targetCriterionId`), and no contribution from `finding_downgraded`/`rejected` amendments; every classified criterion to satisfy the §5.3 status/reason invariants (notably `reason: external_blocker` ⇒ `status: blocked`); every canonical `critical`/`major` finding to carry a `criterionId` and a non-`none` `ledgerEffect` (a critical/major finding with `ledgerEffect: 'none'` is rejected — §5.4/§5.5); and the two proposal IDs, consolidation ID, shared-check hash, two component IDs, amendment IDs, and optional adjudication ID in `provenance.pipeline` to match their stored pipeline artefacts. The proposal and component tuples contain exactly one reviewer requested from `small` and one requested from `medium` (effective buckets may differ after downgrade, §4.5); each reviewer record captures requested vs effective bucket/model.

Runtime/tooling captures reviewer model, provider, requested and effective bucket, thinking level, prompt/rubric hash, evidence hash, and blinding status rather than trusting caller-supplied labels.

Calibration reviews and audits use separate records (`kind: 'calibration'`) and never create a second canonical production rating; only `kind: 'production'` is the once-only canonical review.

### 12.1 Referenced V2 types

Every type referenced by `SessionReviewV2` that is not already defined in §5–§8 is defined here so the contract is implementation-ready.

```ts
// The three bucket selection hints (§4.5). Model lists are user-configured in
// `subagentBuckets` and mirrored via `PIE_SUBAGENT_BUCKETS_JSON`; a requested
// bucket may downgrade to a cheaper non-empty bucket (`medium` → `small`).
type BucketTier = 'small' | 'medium' | 'frontier';

// Routine review requests only `small` or `medium`; `frontier` is reserved for
// explicit calibration/audit. This is the *requested* bucket type; the effective
// bucket actually used is recorded as `bucket: BucketTier` on each record.
type ReviewerBucket = 'small' | 'medium';

// --- Pass 1: independent ledger proposals (§10 Pass 1) ---
interface ReviewerProposal {
  proposalId: string;
  reviewerId: string;
  requestedBucket: ReviewerBucket;  // the hint the orchestrator asked for ('small' | 'medium')
  bucket: BucketTier;                // effective bucket actually resolved (may be lower after downgrade, §4.5)
  bucketDowngraded: boolean;         // true iff effective bucket != requestedBucket
  modelId: string;                  // runtime-captured effective model, not caller-supplied
  provider: string;                 // runtime-captured
  family: string;                   // runtime-captured
  thinkingLevel: string | null;     // runtime-captured effective thinking level
  promptHash: string;
  rubricVersion: string;
  proposedAt: string;
  criteria: CriterionDefinition[];              // proposed definitions only; never classified in Pass 1
  findings: ReviewFinding[];                    // material findings proposed
  candidateChecks: ReviewerCheckSpec[];         // proposed check specs (executed shared in Pass 3)
  candidateHumanQuestion?: ReviewHumanQuestionCandidate;
}

interface ReviewerCheckBase {
  checkId: string;
  criterionId?: string;
}

// Every proposed check is executable. There is no 'reasoning' check kind and
// no free-form rationale: a check is either a command in a declared cwd or a
// static query against a declared target.
type ReviewerCheckSpec = ReviewerCheckBase & (
  | {
      kind: 'command' | 'automated_check';
      command: string;
      cwd: string;
    }
  | {
      kind: 'static_inspection';
      target: string;
      query: string;
    }
);

interface ReviewHumanQuestionCandidate {
  criterionId: string;
  domain: string;
  expectedObservation: string;
  proposedQuestion: string;
  options: string[];
}

// --- Pass 2: ledger consolidation provenance (§10 Pass 2) ---
interface ConsolidationRecord {
  consolidationId: string;
  reviewerId: string;
  requestedBucket: 'medium';        // consolidator is always requested from medium
  bucket: BucketTier;                // effective bucket (may downgrade, §4.5)
  bucketDowngraded: boolean;
  modelId: string;                  // runtime-captured effective model, not caller-supplied
  provider: string;
  family: string;
  thinkingLevel: string | null;
  promptHash: string;
  rubricVersion: string;
  consolidatedAt: string;
  frozenLedger: CriterionDefinition[];         // exact immutable Pass-2 definitions
  frozenLedgerSha256: string;                   // SHA-256 over frozenLedger only
  selectedHumanQuestion?: ReviewHumanQuestionCandidate;
  provenance: { fromProposals: [string, string]; dedupNotes: string[] };
}

// --- Attainment summary (§6.1) ---
interface CriterionAttainmentSummary {
  total: number;                     // excludes superseded
  assessable: number;                // excludes not_assessable + superseded
  controllableDenominator: number;  // assessable minus externally blocked
  met: number;
  partlyMet: number;
  unmet: number;
  blocked: number;                   // all status:'blocked' criteria in this view; includes externalBlocked in delivered view
  externalBlocked: number;            // subset: status blocked ∧ reason external_blocker; diagnostic count even in controllable view
  notAssessable: number;
  superseded: number;
  deliveredRate: number;            // (met + 0.5·partlyMet) / assessable
  controllableRate: number;         // (met + 0.5·partlyMet) / controllableDenominator
}

// --- Human check (§9.3) ---
type ReviewHumanCheckResponse =
  | {
      answer: string;
      source: 'option' | 'custom';
      cancelled: false;
      status: 'answered' | 'inconclusive' | 'unavailable';
      recordedAt: string;
    }
  | {
      answer?: undefined;           // no answer exists when cancelled or unanswered
      source: 'cancelled';
      cancelled: true;
      status: 'unanswered';
      recordedAt: string;
    }
  | {
      answer?: undefined;
      source: 'unanswered';
      cancelled: false;
      status: 'unanswered' | 'unavailable';
      recordedAt: string;
    };

interface ReviewHumanCheck {
  toolCallId: string;               // ask_user tool-call id in the reviewer session
  input: AskUserReviewInput;        // question, options, reviewMeta, …
  response: ReviewHumanCheckResponse;
  interpretation: string;           // how the answer maps to criterion evidence
}

// --- Pass 5: final component assessments (§10 Pass 5) ---
interface ReviewerAssessment {
  assessmentId: string;
  reviewerId: string;
  requestedBucket: ReviewerBucket;  // 'small' | 'medium'
  bucket: BucketTier;                // effective bucket (may downgrade, §4.5)
  bucketDowngraded: boolean;
  modelId: string;                  // runtime-captured effective model, not caller-supplied
  provider: string;
  family: string;
  thinkingLevel: string | null;
  promptHash: string;
  rubricVersion: string;
  assessedAt: string;
  classifications: {                                // Pass 5
    criteria: ClassifiedCriterion[];                 // exactly one classification per frozen definition
    process: ReviewProcessVector;
    evidence: ReviewEvidenceVector;
    findings: ReviewFinding[];
    confidence: ReviewConfidence;
    proposedOverall: OverallAttainment;              // comparison only
    proposedAmendments: CriterionAmendmentProposal[];
  };
}

// A Pass-5 proposal cannot mutate frozenLedger. Its disposition is recorded
// only after the mandatory Pass-6 adjudication.
interface CriterionAmendmentProposal {
  amendmentId: string;
  definition: CriterionDefinition;
  motivatingFindingId: string;
  evidenceRefs: string[];
}

type CriterionAmendmentDisposition =
  | 'accepted'             // add the proposed criterion (classified) to the ledger
  | 'mapped_to_existing'   // re-point the finding to an existing frozen criterion and downgrade it
  | 'finding_downgraded'   // evidence supports only minor/nit; downgrade severity, ledgerEffect 'none'
  | 'rejected';            // finding not substantiated; drop it

interface CriterionAmendmentCommon extends CriterionAmendmentProposal {
  proposedByReviewerId: string;
  disposition: CriterionAmendmentDisposition;
  adjudicatedByReviewerId: string;
  adjudicatedAt: string;
  rationale: string;
}

type CriterionAmendment =
  | (CriterionAmendmentCommon & {
      disposition: 'accepted';
      classifiedCriterion: ClassifiedCriterion;   // added to the canonical ledger
    })
  | (CriterionAmendmentCommon & {
      disposition: 'mapped_to_existing';
      targetCriterionId: string;                  // existing frozen criterion the finding is re-pointed to
      downgradedClassification: ClassifiedCriterion;  // worsened classification for that criterion (criterionId === targetCriterionId)
    })
  | (CriterionAmendmentCommon & {
      disposition: 'finding_downgraded';
      downgradedSeverity: 'minor' | 'nit';        // evidence supports only this severity
    })
  | (CriterionAmendmentCommon & {
      disposition: 'rejected';
    });

// Pass-3 results retain the executable spec that was actually run. Therefore
// command/automated checks always carry command+cwd and static checks always
// carry target+query; no reasoning-only result can be persisted.
type ReviewerCheck = ReviewerCheckSpec & {
  result: string;
  status: 'pass' | 'fail' | 'inconclusive' | 'declined: mutating';
  evidenceRefs: string[];
};

// --- Disagreement + adjudication (§10 Pass 6) ---
interface ReviewDisagreementSummary {
  material: boolean;
  disputedFields: DisputedField[];
  adjudicated: boolean;
}

interface DisputedField {
  field: string;                    // e.g. "criterion:c1.status", "process.verificationDiscipline"
  smallValue: string;               // from the small-requested reviewer role (effective bucket may differ, §4.5)
  mediumValue: string;              // from the medium-requested reviewer role
  resolvedValue: string;
  resolution: 'small' | 'medium' | 'adjudicator' | 'deterministic_merge';
}

interface ReviewerAdjudication {
  adjudicationId: string;
  reviewerId: string;
  requestedBucket: 'medium';        // adjudicator is always requested from medium
  bucket: BucketTier;                // effective bucket (may downgrade, §4.5)
  bucketDowngraded: boolean;
  modelId: string;                  // runtime-captured effective model, not caller-supplied
  provider: string;
  family: string;
  thinkingLevel: string | null;
  promptHash: string;
  rubricVersion: string;
  assessedAt: string;
  resolvedFields: { field: string; value: string; rationale: string; evidenceRefs: string[] }[];
  amendmentIds: string[];           // all adjudicated Pass-6 amendment decisions (every disposition)
  canonicalOverall: { deliveredOverall: OverallAttainment; controllableOverall: OverallAttainment };
}

// --- Provenance + evidence manifest (§13.3, §14.6) ---
interface ReviewProvenance {
  orchestratorSessionId: string;
  rubricVersion: string;
  indexVersion?: string;
  blindingApplied: boolean;
  diversityAchieved: boolean;       // true iff the two final component assessments' effective models differ in family/provider (computed from actual resolution, §10 Pass 1)
  evidenceManifest: EvidenceManifest;
  pipeline: {
    frozenLedgerSha256: string;
    reviewerChecksSha256: string;
    proposalIds: [string, string];
    consolidationId: string;
    componentAssessmentIds: [string, string];
    amendmentIds: string[];
    adjudicationId?: string;
  };
  adjudicatorReviewerId?: string;
  hostVersion: string | null;
}

interface EvidenceManifest {
  rawJsonlSha256: string;           // full SHA-256 of raw session JSONL bytes (§14.6)
  rawJsonlBytes: number;
  rawJsonlMtime: string;
  transcriptExcerptSha256: string;  // hash of the rendered excerpt given to reviewers
  artifacts: { path: string; sha256: string; bytes: number; kind: 'diff' | 'file' | 'generated' | 'untracked' }[];
  limitations: string[];
  blinding: BlindingSummary;
}

interface BlindingSummary {
  stripped: string[];                // e.g. ['modelId','provider','thinkingLevel','family','reputation','settingsVersion']
  redactedTurnFields: string[];
  notes: string[];
}
```

`CriterionDefinition`, `ClassifiedCriterion`, `CriterionStatus`, `CriterionReason`, `CriterionActivity`, `CriterionSurface`, `CriterionEvidenceMode` (§5.1); `ReviewFinding`, `FindingSeverity`, `FindingCategory` (§5.5); `ReviewProcessVector` (§7); and `ReviewEvidenceVector`, `ReviewConfidence` (§8) are defined in their respective sections.

## 13. Storage and tool changes

### 13.1 Review storage

Keep append-only local storage, but replace the V1 “latest record per path wins” semantics with once-only, session-ID-keyed recording:

- **Stable session-ID uniqueness** for V2 canonical production reviews (§4.1).
- **Atomic read-before-append idempotency:** before appending a V2 production review, read the sidecar, parse every prior record, and check whether a prior `kind: 'production'` review with the same `sessionId` and `schemaVersion >= 2` already exists (`kind: 'calibration'` records are excluded; closure markers no longer live in `reviews.jsonl` — see §13.5). If it does, reject the write as a duplicate and return the existing `reviewId`; otherwise append. V1 records lack `sessionId` and therefore never collide on it. The read+append is wrapped so that a concurrent duplicate cannot interleave — on platforms without an atomic file lock, fall back to a single-process write lock keyed by the reviews file and re-check after acquiring it.
- **Path retained as location metadata**, never as the identity key.
- **Flip-back removal/gating:** the V1 behaviour where a session “flips back” to not-done (user reopens it) and is re-reviewed on the next run is removed for V2. A reopened reviewed session keeps its canonical review; a re-review requires an explicit override action (`kind: 'calibration'` or an explicit `--force` audit path), never an ordinary `recordReview`. `listOpen`/`listSelected` shows reviewed sessions as already-rated and skips them **for rating**; however, a “review and close” run still queues them as closure targets using their existing `reviewId` (§10 Pass 0, §13.5) so they are closed without re-rating.
- **Legacy V1 handling:** existing `reviews.jsonl` V1 records (1–5 rating, `fully`/`partial`/`setback`, `reviewerBuckets`/`reviewerCount`, optional `selfClose`) remain readable and are never coerced into V2. V1 records are exposed as a separate legacy view and excluded from V2 analytics cohorts; they can be backfilled into V2 ledger form only via an explicit, manual calibration import that records `identityFallback`/`legacy: true`.
- **Self-close handling:** the V1 `closeSelf` action wrote a `selfClose: true`, `done: true` review with a placeholder `rating: 3` into `reviews.jsonl`. In V2, `closeSelf` writes **only** a closure action (`kind: 'closeSelf'`) in the separate closure-action outbox (§13.5) — it never writes to `reviews.jsonl` and never records a production rating for the reviewer session. The host continues to skip the reviewer session for scored analytics. Closure actions are not subject to the once-only production check.
- **Complete pipeline provenance** retained inside the canonical record: frozen definitions/hash, canonical classified ledger, the two proposals, consolidation, shared checks/hash, the two final components, and all adjudicated amendments (every disposition); cross-field equality and tuple cardinality are validated (§12).
- **Explicit audit/calibration records** (`kind: 'calibration'`) are separate from `kind: 'production'` reviews and cannot create a second canonical rating.
- **Backward-compatible V1 reads** preserved; V2 writes do not mutate V1 records.
- **Closure-action outbox (§13.5):** `closeReviewed`/`closeSelf` actions and their retry state live in a separate outbox store outside `reviews.jsonl`. `reviews.jsonl` holds only production reviews and calibration records; closure never appends to it, so closure retries cannot write a second review and review persistence cannot be blocked by closure state.
- **V2 cutover — reserve reviewed V1 paths:** at cutover, every V1-reviewed session path is resolved to a stable session-header ID (§4.1) by reading its JSONL header. Resolved sessions are reserved/skipped — `listOpen`/`listSelected` marks them already-rated and the once-only production check treats their resolved `sessionId` as covered, so they are never re-reviewed. Unresolved legacy records (path moved/deleted/header unreadable) are skipped pending reconciliation and flagged `identityFallback: true`/`legacy: true`; they neither block the V2 cohort nor get silently re-reviewed. Reconciliation later resolves and reserves them or drops them via explicit audit.

### 13.2 `session_review` tool

The review remains session-oriented, so a new task-review queue/tool is unnecessary. V2 actions:

- `listOpen` / `listSelected` — open/pinned sessions with review status; marks already-reviewed sessions as rated (excluded from the **rating** queue but still eligible as closure targets via their existing `reviewId`, §10 Pass 0); marks the reviewer session `(self)`.
- `getEvidence` — returns the blinded evidence bundle + `EvidenceManifest` (§14.6) for one session.
- `recordReview` — persists one canonical V2 review keyed by stable session ID. Does **not** accept a free-form 1–5 score. Validates: frozen `CriterionDefinition` ledger/hash and canonical `ClassifiedCriterion` ledger (including only adjudicated accepted/mapped amendments); the §5.3 status/reason invariants for every classified criterion (notably `reason: external_blocker` ⇒ `status: blocked`); finding consistency — every canonical `critical`/`major` finding must carry a `criterionId` and a non-`none` `ledgerEffect`, and a `critical`/`major` finding may not persist canonically without ledger effect (the adjudicator must accept the amendment, map/downgrade an existing criterion, downgrade the finding severity to `minor`/`nit`, or reject the finding; §5.4); requested vs effective bucket/model for every reviewer call (§4.5); process/evidence vectors; complete pipeline provenance (two proposals, consolidation, shared reviewer checks + hash, two final components, amendments), disagreement/adjudication rules, blinding status, and once-only identity (atomic read-before-append, §13.1). Never writes a closure marker.
- `closeReviewed` — enqueues a `closeReviewed` closure action for one reviewed target session in the closure-action outbox (§13.5) after its review persists, **or** for an already-canonical-reviewed session using its existing `reviewId` (§10 Pass 0) so “review and close” closes it without re-rating. Pure explicit action; it does not write a rating and does not touch `reviews.jsonl`. Retried independently of review persistence through the outbox control record. Idempotent: if the session is already closed (a settled `succeeded` action exists), it returns that action without re-enqueuing.
- `closeSelf` — enqueues a `closeSelf` closure action for the reviewer session in the outbox (§13.5); the final action of the run. No rating, no `reviews.jsonl` write.

`setReview` (V1: 1–5 + `done`-implies-close) is superseded: recording a review no longer closes a tab. Closure is reached only through `closeReviewed`/`closeSelf`, so close actions are pure and explicit (no implicit close on `done: true`, no flip-back re-open re-rate).

### 13.3 `ask_user`

Extend the existing interactive tool with the optional `reviewMeta` field (§9.3). The `ask_user` call is issued by and owned by the reviewer session: the prompt and response are routed in the reviewer session’s own interaction context, never relocated to the reviewed session’s tab. The `reviewMeta` `targetSessionId`/`targetSessionPath` is used only for display, audit, and attribution (labelling which session the question concerns); it does not change where the question is asked or answered. The reviewer embeds the full tool call + result in the canonical review’s `humanCheck`. Do not add a competing interaction or a separate human-check writer tool.

### 13.4 `evaluate-sessions` skill rewrite

The `skills/evaluate-sessions` skill is rewritten from its current V1 shape to the V2 workflow:

| Aspect | V1 (current) | V2 (target) |
|---|---|---|
| Interaction | Fully autonomous; **never** calls `ask_user` (no-ask). | Inspect **all** selected sessions first, then ask all collected human-verification questions (`ask_user`, one per affected session), then classify. |
| Re-review | Re-reviews a session that “flips back” to not-done after reopen. | Once-only: a reviewed session keeps its canonical record; re-review requires an explicit override (§13.1). A “review and close” run skips already-reviewed sessions for rating but still closes them via their existing `reviewId`. |
| Rating | Free 1–5 integer + `fully`/`partial`/`setback`. | Criterion ledger + attainment + process/evidence vectors; no free 1–5. |
| Close | `setReview` with `done: true` implicitly closes the tab. | Pure explicit `closeReviewed`/`closeSelf`; recording does not close. |
| Storage | Latest record per path wins; `closeSelf` writes a `rating: 3` self-review. | Once-only session-ID-keyed canonical record; `closeSelf`/`closeReviewed` write closure actions in a separate outbox (§13.5), not `reviews.jsonl`. |

The V2 skill flow is the inspect-all → ask-all → classify sequence of §10: snapshot targets → parallel small/medium ledger proposals → medium consolidation → shared reviewer-check selection/execution → batch `ask_user` → fresh small/medium final classifications → optional medium adjudication → record + explicit close (via the outbox). The skill must not record a review until the batch’s human evidence is collected or marked unavailable, and must not re-rate an already-rated session.

### 13.5 Closure-action outbox

Closure actions (`closeReviewed`, `closeSelf`) and their retry state live in a **separate** control store — the closure-action outbox — outside `reviews.jsonl`. This keeps review persistence and tab closure fully decoupled: a closure retry never appends to `reviews.jsonl` and can never create a second review, and a review write never depends on closure state.

```ts
type ClosureActionKind = 'closeReviewed' | 'closeSelf';
type ClosureActionStatus = 'pending' | 'succeeded' | 'failed' | 'retrying';

interface ClosureAction {
  actionId: string;
  kind: ClosureActionKind;
  targetSessionId: string;   // reviewed session for closeReviewed; reviewer session for closeSelf
  targetSessionPath?: string; // mutable display/location metadata
  reviewId?: string;          // links closeReviewed to the persisted review (§13.1)
  status: ClosureActionStatus;
  attempts: number;
  lastError?: string;
  requestedAt: string;
  settledAt?: string;         // set when status becomes succeeded/failed (terminal)
}
```

- The outbox is append-only with terminal-state updates (`succeeded`/`failed`); `retrying`/`pending` records are retried idempotently by the host.
- `closeReviewed` requires a prior persisted review (`reviewId`) — either the one just recorded for an unrated session, or the existing canonical review for an already-reviewed session (§10 Pass 0). It is enqueued after `recordReview` succeeds (unrated) or directly for an already-reviewed closure target, and is retried independently if closure itself fails. Enqueue is idempotent: a session with a settled `succeeded` action is not re-enqueued.
- `closeSelf` is the final action of a run; it never carries a `reviewId` and never records a rating.
- Closure actions are never subject to the once-only production-review check (§13.1) and are excluded from scored analytics.
- Because closure state is out-of-band, a half-completed run (review persisted, closure pending) is recoverable: the host drains pending outbox actions without re-recording the review.

## 14. Analytics model

### 14.1 Canonical outcome metrics

- Overall attainment distribution
- Delivered-result and agent-controllable attainment
- Core/supporting/optional criterion attainment
- Unmet, blocked, and not-assessable rates
- Criterion attainment by activity, surface, and evidence mode
- Regression/incorrect-result/omission/failed-attempt reason rates
- Critical/major/minor finding rates
- Human-verification need, answer, contradiction, and unavailable rates
- Review confidence and evidence coverage

### 14.2 Process metrics

- Under/overclarification
- Under/oververification
- Scope drift
- Recovery effectiveness
- Overclaiming/underclaiming

These remain separate from the quality index.

### 14.3 Runtime joins

After blinded review persistence, join reviews to:

- Author model/provider/thinking level
- Available and used tools
- Available, retained, read, and used skills
- Skill-pruning and tool-result-pruning treatments
- Verification telemetry
- Cost, latency, tokens, retries, failures, and subagents
- Harness/prompt/settings versions

Distinguish assigned/available treatments from realized usage. “Tool X used” is usually selected by task difficulty and agent behaviour, so production comparisons are descriptive associations unless assignment was randomized or otherwise controlled.

### 14.4 Reporting rules

Every comparison should expose:

- Sample size
- Review and telemetry coverage
- Task/criterion taxonomy mix
- Time range
- Rubric/index/reviewer versions
- Confidence/evidence-limited rates
- Mixed-model/treatment exclusions
- Uncertainty intervals

Use language such as “associated with” for observational data. Reserve “caused” or “improved” for controlled experiments.

Do not infer stable agent characteristics from sparse samples; report repeated behavioural rates under stated contexts.

### 14.5 Session-ID join and backfill

The canonical join key between a V2 review and runtime telemetry is the **stable session-header ID** (§4.1), replacing the V1 `sessionPathHash` (the first 16 hex characters of the SHA-256 of the normalized path; algorithm below).

- V2 reviews carry `sessionId`; analytics join `review.sessionId ↔ run.sessionId` (and `runId` where a session has multiple runs), not path hash.
- Runtime telemetry rows that already carry `sessionId` (pruning, tool-result-pruning, warm-bash) join directly.
- **Backfill:** legacy V1 reviews and telemetry rows that lack `sessionId` continue to join via `sessionPathHash` as a fallback. A one-time backfill pass resolves `sessionId` for each historical session by reading its JSONL header; records that cannot be resolved are tagged `identityFallback: true` and excluded from V2-only cohorts but remain in legacy views. Backfill is idempotent: re-running it only fills missing `sessionId` fields and never overwrites an existing one.
- **Cutover reserve/skip:** at V2 cutover, V1-reviewed session paths are resolved to `sessionId` (above) and reserved/skipped by the once-only production check and `listOpen`/`listSelected` (§13.1), so the V2 cohort never re-reviews them. Unresolved legacy records are flagged `identityFallback: true`/`legacy: true` and skipped pending reconciliation.
- Mixed-key joins are flagged so analysts can exclude half-backfilled sessions from longitudinal comparisons.

**V1 normalized path-hash fallback algorithm.** Trim the path, replace `\\` with `/`, collapse repeated `/` while preserving the leading `//` of UNC paths, lowercase Windows drive-letter and UNC paths, encode the resulting string as UTF-8, compute SHA-256, and use the first 16 hexadecimal characters. This fallback is for legacy joins or malformed/missing session headers only; it is not the V2 identity when a valid header ID exists.

### 14.6 Evidence hashing

The `EvidenceManifest` (§12) anchors a review to exactly what the reviewers saw:

- **Raw JSONL SHA-256:** the full SHA-256 of the raw session JSONL **bytes** at snapshot time (`rawJsonlSha256`), plus byte count and mtime. This is the canonical evidence fingerprint; it changes whenever the transcript is appended to or rewritten (e.g. compaction).
- **Transcript-excerpt SHA-256:** SHA-256 of the exact rendered excerpt handed to reviewers (`transcriptExcerptSha256`), so a re-review can detect whether reviewers saw the same rendering.
- **Artifact hashes:** per-changed-file SHA-256 (`artifacts[].sha256`) for diffs/files/generated/untracked artifacts, with kind and byte size.
- The raw JSONL is hashed but **not** delivered to reviewers (it contains author `model_change` entries); reviewers receive only the blinded excerpt + artifact hashes.
- A single `evidenceHash` field may be retained as an alias for `rawJsonlSha256` for backward-compatible readers; the full `EvidenceManifest` is the source of truth.

## 15. UI direction

After V2 review collection and analytics are validated, remove routine user rating surfaces:

- `RunOutcomeDialog`
- User-selected 1–5 satisfaction
- User-selected resolved/partially resolved/unresolved
- “Rate completed run…”
- “Mark done” when it only opens the outcome dialog
- “Outcome saved” wording
- Associated host/webview protocol state, commands, effects, tests, and styles

Retain:

- Normal tab close
- Start-new-task and continue-task controls
- Pinned-session selection
- Contextual `ask_user` prompts issued by the reviewer
- Truthful review states such as reviewed, review failed, or needs closure retry where useful

The webview remains passive under `STATE_CONTRACT.md`; durable review state belongs to backend/host-owned data and reaches the UI through snapshots.

## 16. Calibration

Build a versioned calibration corpus with:

- Fully successful sessions
- Minor and major omissions
- Failed attempts and external blockers
- Regressions hidden behind confident final prose
- Scope drift and unnecessary churn
- Effective and ineffective recovery
- Underverification and oververification
- Accurate, overclaimed, and underclaimed final responses
- UI/perceptual cases with supporting, contradicting, and unavailable human evidence
- Seeded defects in final artifacts
- All-core-external-blocked sessions (to validate the §6.2 divergence)
- Disagreements spanning `blocked`/`not_assessable`/`superseded` and opposite/incomparable process pairs (to validate they escalate to adjudication, never conservative merge)
- Repeated blinded copies for stability measurement

Measure:

- Criterion extraction agreement
- Importance and taxonomy agreement
- Per-status agreement
- Process-vector agreement
- Material finding recall and false positives
- Human-question necessity and interpretation agreement
- Confidence calibration
- Small-versus-medium reviewer bias
- Adjudication frequency and direction
- `qualityIndexV1` band placement agreement (`controllableOverall` → band) and within-band refinement stability
- `qualityIndexV1` calibration against seeded defect severity
- Rubric drift over time
- Review cost and latency

Use the initial two-reviewer policy for every session to collect enough disagreement evidence. Reconsider a lighter policy only after calibration shows where one reviewer is sufficient.

## 17. Delivery phases

### Phase 0 — Finish rubric design

- Finalize taxonomy values and anchors (§5.1, §5.5).
- Finalize overall-attainment rules (§6.2) and the provisional quality-index v1 (§6.3).
- Ratify the material-disagreement thresholds (incl. blocked/not_assessable/superseded and incomparable/opposite process pairs) and deterministic non-material merge rules (§10 Pass 6).
- Ratify finding severity/category taxonomy and ledger-effect rules (§5.5), including the four-way post-freeze amendment adjudication (§5.4) and the §5.3 status/reason invariants.
- Ratify reviewer-diversity and reviewer-check safety policy (§10, §11).
- Define reviewer prompts and evidence references.
- Freeze V1 fixtures and a calibration corpus.

### Phase 1 — Structured review evidence

- Improve evidence retrieval beyond the current lossy transcript summary.
- Add stable session-header ID extraction (§4.1) and raw-JSONL/artifact SHA-256 evidence hashing (§14.6).
- Separate original-agent and reviewer-generated checks with the §11 safety policy; checks are selected and executed once in the shared Pass-3 pass.
- Extend `ask_user` with `reviewMeta` (§9.3) and embed the tool call/result in the canonical review.
- Rewrite the `evaluate-sessions` skill to inspect-all → ask-all → classify (§13.4); remove no-ask/re-review/1–5 behaviour.

### Phase 2 — V2 records and once-only persistence

- Add V2 contracts and validation (§12), including the full type registry (proposals, consolidation, components, shared reviewer checks, closure actions), the §5.3 status/reason invariants, the four-way amendment disposition, and requested-vs-effective bucket/model capture (§4.5).
- Add atomic read-before-append once-only persistence keyed by stable session ID (§13.1).
- Gate/remove flip-back re-review; pure explicit close actions (§13.2).
- Preserve component assessments, consolidation provenance, and adjudication.
- Keep V1 read compatibility without coercing V1 into V2 (§13.1); move `closeReviewed`/`closeSelf` and their retry state to the closure-action outbox outside `reviews.jsonl` (§13.5).
- Decouple review persistence retries from closure retries (closure state lives in the outbox).

### Phase 3 — Multi-reviewer orchestration

- Implement isolated small/medium ledger proposals per session (calls 1–2).
- Add medium ledger consolidation with `frozenLedger` + `frozenLedgerSha256` provenance (call 3).
- Add the shared post-consolidation reviewer-check selection/execution pass; freeze `ReviewerCheck[]` + `reviewerChecksSha256` for both final reviewers and adjudicator (§10 Pass 3, §11).
- Run final small/medium classifications over the same frozen evidence (calls 4–5).
- Add material-disagreement detection (incl. blocked/not_assessable/superseded and incomparable/opposite process pairs), deterministic non-material merge, and optional third-medium adjudication (call 6); adjudicate post-freeze amendments with the four-way disposition (§5.4) so a critical/major finding cannot survive canonically without ledger effect.
- Enforce reviewer diversity from actual effective resolution and record `diversityAchieved`; persist requested vs effective bucket/model per reviewer call (§4.5).
- Present one batch summary, explicitly close every reviewed target via the outbox, then self-close (§13.5).

### Phase 4 — Analytics cutover

- Start a clean V2 cohort.
- At cutover, resolve every V1-reviewed session path to a stable session ID and reserve/skip it; flag unresolved legacy records `identityFallback` pending reconciliation (§13.1).
- Switch the review↔runtime join to stable session ID; run the legacy backfill (§14.5).
- Add criterion, process, evidence, disagreement, and reviewer diagnostics.
- Derive `qualityIndexV1` (band-based, purely outcome-based) and its components (§6.3); surface delivered vs agent-controllable attainment, plus separate coverage/confidence/blocker rates.
- Join runtime treatments only after blinded review.
- Relabel legacy agent/user outcome metrics explicitly.

### Phase 5 — Rating UI removal

- Remove user rating/resolution surfaces and protocol flow.
- Preserve tab/task lifecycle controls.
- Update `STATE_CONTRACT.md`, architecture docs, tests, and generated site data together.
- Rebuild and sync the installed extension after `extension/src/` changes.

### Phase 6 — Calibration and refinement

- Run repeated and defect-seeded calibration.
- Tune anchors/index/disagreement policy under new rubric versions.
- Establish minimum sample and uncertainty rules for model/harness comparisons.
- Decide whether the two-reviewer-every-session policy should remain permanent.

## 18. Test strategy

### Identity and persistence

- Session-header IDs survive path rename/move.
- Session-header ID extraction falls back to path hash with `identityFallback` on a missing/malformed first line.
- A production session accepts one canonical V2 review.
- Atomic read-before-append rejects a concurrent duplicate for the same `sessionId` and returns the existing `reviewId`.
- Duplicate record attempts are idempotent or explicitly rejected.
- Closure retry cannot write a second review (closure state lives in the outbox, §13.5).
- A reopened reviewed session is not re-rated (flip-back gating); re-review requires an explicit override.
- A selected session that already has a canonical review is skipped for rating (no Pass 1–6, no second review) but is still queued as a closure target with its existing `reviewId`; “review and close” closes it without re-rating. Idempotent closure returns the settled action if already closed.
- `closeReviewed`/`closeSelf` write only closure actions in the outbox (no rating, no `reviews.jsonl` write) and are skipped by scored analytics.
- Closure actions and retry state never appear in `reviews.jsonl`.
- At V2 cutover, resolved V1 reviewed paths are reserved/skipped; unresolved legacy records are flagged `identityFallback` and skipped pending reconciliation.
- V1/V2 mixed storage remains readable; V1 records are not coerced into V2.
- Malformed lines cannot break listing/export.

### Review orchestration

- Only user-selected sessions are reviewed.
- Reviewer session is excluded.
- Every session receives isolated proposals and final assessments requested from `small` and `medium`; requested and effective bucket/model are persisted for each reviewer call.
- Pass-1 `CriterionDefinition` proposals, Pass-2 `frozenLedger` + `frozenLedgerSha256` consolidation provenance, Pass-3 shared checks/hash, Pass-5 `ClassifiedCriterion` components, and all adjudicated amendments are stored as distinct canonical-record fields.
- The shared Pass-3 reviewer-check results + `reviewerChecksSha256` are identical for both final reviewers and the adjudicator; no reviewer executes its own checks.
- Both final reviewers classify the same frozen ledger, shared reviewer-check evidence, and final human evidence.
- Material disagreement invokes exactly one medium adjudication (6th call).
- `blocked`/`not_assessable`/`superseded` status disagreements and incomparable/opposite process pairs escalate to adjudication (never conservative merge).
- Conservative merge applies only to adjacent ordered graded pairs and never produces a contradictory pick.
- Non-material disagreement is resolved by conservative merge with a recorded `resolution` source.
- Reviewer diversity is recorded from actual effective resolution (`diversityAchieved` true iff the two final component assessments' effective models differ in family/provider; false when the configured buckets offer no diverse pair).
- A requested `medium` reviewer that downgrades to `small` (empty medium pool) persists `requestedBucket: 'medium'`, effective `bucket: 'small'`, `bucketDowngraded: true`, and the effective `modelId`/`provider`/`family`.
- All component provenance is retained.

### Human verification

- All target sessions are inspected before the first question.
- At most one question is asked per affected session.
- Questions and responses target the correct stable session and criterion; routing stays in the reviewer session, with target metadata used for display/audit/attribution only.
- The `ask_user` tool call and result are embedded in `humanCheck`; no separate writer is used.
- Answered, custom, cancelled, unavailable, and inconclusive paths persist truthfully.
- Missing human evidence does not prevent rating and closure.
- Existing inline/fallback extension-UI request invariants survive tab switches, reload, and background sessions.

### Evidence

- Author identity/treatment is absent from reviewer bundles; blinding status is recorded.
- `rawJsonlSha256` changes on transcript append/compaction; `transcriptExcerptSha256` detects rendering changes.
- Transcript truncation and workspace drift are visible limitations.
- Reviewer checks are distinguishable from original-agent checks; mutating checks are declined.
- Critical/major findings downgrade or add a criterion; a canonical critical/major finding always carries a `criterionId` and a non-`none` `ledgerEffect`.
- A post-freeze amendment is adjudicated with one of the four dispositions (`accepted`, `mapped_to_existing`, `finding_downgraded`, `rejected`); only `accepted` adds a criterion and only `mapped_to_existing` downgrades an existing one.
- A critical/major motivating finding cannot survive canonically with `ledgerEffect: 'none'`: the adjudicator must accept, map/downgrade, downgrade severity to `minor`/`nit`, or reject; validation rejects a record that leaves a critical/major finding with no ledger effect.

### Attainment and index

- Overall attainment follows the first-match rule (§6.2).
- Externally-blocked criteria (`status: blocked` ∧ `reason: external_blocker`) are normalized out before deriving controllable overall and the index (§6.1); a `blocked` criterion with a non-external reason stays in the controllable set.
- `recordReview` rejects a classified criterion whose `status`/`reason` pair violates the §5.3 invariants (e.g. `reason: external_blocker` with a non-`blocked` status; a gap/blocker reason with `met`/`superseded`).
- All-core-external-blocked yields delivered `not_achieved` and controllable `not_assessable`.
- A single `not_assessable` core amid met cores yields `partly_achieved`, not `not_assessable`.
- `qualityIndexV1` is `null` when `controllableOverall` is `not_assessable`.
- `qualityIndexV1` band is fixed by `controllableOverall` (`not_achieved` 0–24, `partly_achieved` 25–59, `mostly_achieved` 60–84, `achieved` 85–100); within-band criterion attainment refines the value but cannot escape the band.
- An unmet core criterion keeps the index in a lower band; optional successes cannot rescue it.
- Coverage, confidence, and blocker rates are reported separately and do not affect the index.
- No separate finding penalty is applied (critical/major already downgrade/add criteria).

### Analytics

- Derived attainment follows anchored rules.
- Optional criterion count cannot hide failed core requirements.
- Process metrics are not silently blended into quality.
- Legacy records are not treated as missing V2 dimensions.
- `sessionId` backfill is idempotent and tags unresolved records `identityFallback`.
- Tool/skill comparisons expose assignment/usage distinction and observational caveats.

### UI removal

- Remove all rating-dialog references and stale styles.
- Update protocol and sync-contract fixtures together.
- Preserve pinned tabs, close, start-new-task, continue-task, deferred-trigger gating, and running-session behaviour.

## 19. Success criteria

Before V2 becomes canonical:

- Stable session identity and once-only review persistence work end to end.
- The full batch workflow works: snapshot → small/medium proposals → consolidation → shared reviewer checks → ask all → classify/adjudicate → record + close (via outbox).
- Already-canonical-reviewed selected sessions are skipped for rating but still closed via their existing `reviewId` (no re-rating).
- Frozen `CriterionDefinition` ledger/hash, canonical `ClassifiedCriterion` ledger, two Pass-1 proposals, Pass-2 consolidation, shared Pass-3 checks/hash, two Pass-5 components, and all amendments are stored as distinct fields and remain correctly session-attributed.
- Reviewer-generated checks and original-agent verification are separate; shared check results are identical for both final reviewers and the adjudicator.
- Closure actions persist in the outbox separately from `reviews.jsonl`.
- Legacy data remains readable; resolved V1 reviewed paths are reserved/skipped at cutover.

Before removing rating UI:

- V2 reviews cover the intended selected-session workflow reliably.
- No unanswered human question prevents best-effort rating and closure; `ask_user` routing stays in the reviewer session.
- Analytics expose ledger components, process vector, evidence coverage, and provenance.
- No agent score is labelled user satisfaction.

Before ranking models/harnesses authoritatively:

- Calibration establishes acceptable requirement-extraction and status agreement.
- Seeded critical defects are not missed.
- Material finding false positives are bounded.
- Small/medium reviewer and adjudicator effects are measurable.
- Quality-index semantics and uncertainty reporting are versioned.
- Review cost and latency are visible.

## 20. Remaining decisions

1. **Quality-index formula** — provisionally v1 (§6.3): band-based on `controllableOverall` (`not_assessable`→`null`; `not_achieved` 0–24; `partly_achieved` 25–59; `mostly_achieved` 60–84; `achieved` 85–100), with within-band refinement by class-weighted agent-controllable attainment (core 1.0 / supporting 0.5 / optional 0.25). Coverage, confidence, and blocker rates are reported separately. Open: calibration of bands/weights and the `partly_met = 0.5` mapping before leaderboard use.
2. **Non-material disagreement merge** — provisionally resolved (§10 Pass 6): conservative per-field selection on adjacent ordered graded pairs only, never averaging; `blocked`/`not_assessable`/`superseded` and incomparable/opposite process pairs are material (adjudicated). Open: confirm anchors against the calibration corpus.
3. **Finding taxonomy** — provisionally resolved (§5.5): severity critical/major/minor/nit, category enum + `other`, ledger-effect rule. Open: category pruning after the first cohort.
4. **Reviewer-check safety & evidence-bundle limits** — resolved (§11, §14.6): read-only, ≤5 checks/session selected and executed once in the shared Pass-3 pass, mutating checks declined; manifest capped by transcript budget. Open: per-check output cap tuning.
5. **Reviewer buckets & diversity** — resolved (§4.5, §10 Pass 1): `small`/`medium`/`frontier` are selection hints whose model lists are user-configured in `subagentBuckets` and mirrored via `PIE_SUBAGENT_BUCKETS_JSON`; a requested bucket may downgrade to a cheaper non-empty bucket; each reviewer record persists requested + effective bucket/model; `diversityAchieved` is computed from actual effective resolution. Open: bias policy when a bucket offers multiple families but random selection collides.
6. **Closure-action outbox** — resolved (§13.5): `closeReviewed`/`closeSelf` and retry state live outside `reviews.jsonl`. Open: outbox retention/pruning policy.
7. **Non-rating “Report a problem” UI action** — still open (post-UI-removal).
