---
name: evaluate-sessions
description: "Use when asked to assess, audit, grade, benchmark, or review one or more agent sessions or their delivered work—especially requirement attainment, outcome quality, process discipline, evidence, or the accuracy of final claims. Apply an evidence-based session-evaluation workflow with blinded review, scoped human verification, and explicit target closure; not ordinary code review, debugging, or implementation."
---

# Evaluate sessions

Use this skill only when the user wants **agent sessions evaluated**. A target may be
completed, paused, pinned, selected, or open. Evaluate the work and evidence of how it
was done—not merely the current diff and not the model or author.

Do not use it for ordinary code review, debugging, implementation, or general feedback.

## Evaluation rules

- Review exactly the requested targets. Use `listOpen` for all open sessions only when
  explicitly requested. Always exclude this evaluator session.
- Use the stable session-header ID as identity. If it is absent, use the tool's path
  fallback and preserve that fact.
- Do not re-evaluate a target with an existing canonical review. Queue its existing
  review for closure instead. Re-evaluation requires an explicit audit/calibration
  request.
- Keep authorship blind. Reviewers must not receive model/provider identity, model
  changes, runtime/settings identity, reputation, treatment data, or raw session JSONL.
- Use only the bounded, blinded bundle from `getEvidence`. Completion claims are
  evidence to weigh, not proof.
- Freeze the requirements before classifying results. Retain changed or withdrawn
  requirements as `superseded`.
- Human responses are evidence for one criterion or surface, never an overall score.
- Persist before closing. Never write sidecars, import the internal store, fabricate
  provenance, or replace the review tool with a script.

## Evaluation standard

### Criterion ledger

Create observable, independently classifiable criteria from the user's requirements
and only genuinely necessary implied conditions. Each criterion has:

```text
criterionId, statement, origin, importance, taxonomy
```

Use `origin: explicit` or `necessary_implied`; assign importance as:

- `core` — missing it defeats the primary outcome;
- `supporting` — materially affects quality or completeness;
- `optional` — useful non-core value or requested polish.

Taxonomy identifies activity, surface, and evidence mode. Avoid generic criteria such as
“high quality” unless they are necessary for the requested value.

### Criterion classification

Classify every frozen criterion exactly once:

| Status | Valid reasons |
| --- | --- |
| `met` | `none` |
| `partly_met` | `omitted`, `attempt_failed`, `incorrect_result`, `regression`, `unknown` |
| `unmet` | `omitted`, `attempt_failed`, `incorrect_result`, `regression`, `unknown` |
| `blocked` | `external_blocker`, `user_dependency`, `unknown` |
| `not_assessable` | `human_evidence_missing`, `insufficient_artifact_evidence`, `unknown` |
| `superseded` | `none` |

Attach evidence references to every classification. Do not mark a claimed completion
`met` when the bundle cannot verify it; use `not_assessable` when the evidence cannot
fairly distinguish success from failure.

### Process and evidence

Return these process dimensions:

```text
requirementDiscipline: proportionate | underclarified | overclarified | not_assessable
verificationDiscipline: proportionate | underverified | oververified | not_applicable | not_assessable
scopeControl: controlled | minor_avoidable_drift | material_scope_drift | not_assessable
recovery: effective | partly_effective | ineffective | not_needed | not_assessable
finalClaimAccuracy: accurate | overclaimed | underclaimed | unclear | no_final_claim
```

Return evidence coverage:

```text
requirements: clear | partly_clear | unclear
artifacts: direct | partial | none | not_applicable
execution: direct | partial | reported_only | none | not_applicable
human: not_needed | supports | contradicts | inconclusive | unanswered | unavailable
```

Include concrete limitations. Reported execution is not direct execution. Name
transcript/diff omissions, missing artifacts, workspace drift, ambiguous attribution,
and unanswered checks. Use confidence `high`, `medium`, or `low`; high requires direct
support for every active core and outcome-supporting classification.

Overall attainment and the quality index are derived from the canonical ledger by the
review tool. Never ask a reviewer to choose them or hand-calculate them.

## Lean workflow

Complete each phase for the whole batch before moving to the next. Independent calls
may be emitted as sibling subagent calls in parallel.

### 1. Snapshot and evidence

1. Call `listSelected` for named/pinned targets; otherwise call `listOpen` only for an
   explicit all-open request.
2. Partition once into unreviewed and already-reviewed targets.
3. Call `getEvidence` once for every unreviewed target. Give every reviewer the exact
   same target-specific bundle and preserve its manifest.
4. Queue already-reviewed targets for `closeReviewed` using their existing review ID.

Do not ask questions or record new reviews in this phase.

### 2. Independent requirement proposals

For every unreviewed target, launch two isolated proposal reviewers: one requested
`small`, one `medium` by default; use two `small` reviewers only when explicitly
constrained. Give each only the blinded bundle.

Require compact structured output containing:

1. proposed criterion definitions, without classifications;
2. at most one material human-only uncertainty/question.

Do not pass one proposal to the other reviewer. Do not ask users, run tools, choose an
overall result, or write records. Preserve runtime provenance from each successful
subagent result exactly. Use the authoritative `details.results[0]`: map its parent
call ID to `toolCallId`, requested bucket to `requestedBucket`, effective bucket to
`bucket`, downgrade flag to `bucketDowngraded`, model to `modelId`, and copy provider,
family, thinking level, and prompt hash. For coordination and adjudication, request
`medium` for the mixed profile and `small` for the small-only profile. Do not infer
any provenance from prose.

### 3. Consolidate and freeze

Run one isolated coordinator after both proposals exist for a target. Request `medium`
for the mixed profile or `small` for the small-only profile. It receives the same bundle
and both proposals and returns only:

- one deduplicated, immutable definition-only ledger;
- zero or one highest-importance human question;
- proposal IDs and concise merge notes.

Do not classify or modify the ledger after this phase. Finish consolidation for every
target before asking any human question.

### 4. Optional human verification

Ask questions sequentially, only when the bundle cannot resolve a material human-
observable issue: visual/interaction behavior, semantics/tone, accessibility,
external account, device, or permission boundary.

Ask at most one neutral question per affected target. Include minimum observation steps,
the exact criterion/surface, a neutral expected observation, observed/not observed/
unable-to-check options, and a custom-answer path when useful. Bind `reviewMeta` to the
target ID, current path, criterion, domain, and expected observation.

Store the complete question and response. For cancellation or no answer, omit `answer`
rather than storing an empty answer; preserve the state and timestamp. Mark affected
criteria `not_assessable` when necessary and lower confidence or coverage. Do not begin
classification until every target has answered or been marked unavailable.

### 5. Fresh independent classification

For every target, launch two **fresh** isolated classifiers with the selected profile
and `thinkingLevel: medium`. Give both the same final bundle: blinded evidence, frozen
ledger, and that target's human response.

Require compact structured output containing:

- every frozen criterion exactly once with status, reason, and evidence references;
- all process dimensions;
- evidence coverage and limitations;
- confidence.

Do not require or persist a proposed overall. Do not mutate the ledger, ask users, run
tools, or write records. Consume structured subagent results directly. If one classifier
fails, retry only that missing role once with the identical bundle.

### 6. Reconcile

Compare the two classifications. Use one fresh adjudicator with `thinkingLevel: high`
only for material disagreement, including:

- any core status disagreement;
- any disagreement involving `blocked`, `not_assessable`, or `superseded`;
- a two-step supporting/optional status disagreement;
- unequal human evidence;
- incompatible process values or any final-claim-accuracy disagreement;
- incomparable evidence coverage values.

The adjudicator receives both classifications and the same immutable bundle. It may
resolve disputed fields with evidence references but may not change the frozen ledger.

Without material disagreement, use only the permitted adjacent deterministic merges:
`met/partly_met → partly_met`, `partly_met/unmet → unmet`, clear/partly_clear →
partly_clear, direct/partial → partial, partial/reported_only → reported_only, and the
corresponding conservative adjacent process merges. Do not average categories or invent
conservative values for off-scale pairs. Union limitations and use lower confidence.

### 7. Compact persistence and closure

Prefer a compact review draft. It should contain only:

- target identity and frozen ledger;
- the two proposals and consolidation result;
- the two fresh component classifications;
- human evidence, if any;
- adjudication, if any;
- authentic reviewer runtime provenance and the issued evidence manifest.

Do not hand-assemble derived ledger/process/evidence/confidence/attainment fields,
comparison-only overalls, duplicate ledger hashes, pipeline projections, or transport
metadata. The session-review tool compiles and validates those fields. It fills IDs and
timestamps when omitted, but reviewer runtime facts must come from completed subagent
results.

For a batch, write one JSON array to an OS temporary file and call `recordReviews`.
For one target, use `recordReview`; it accepts the same compact draft. Review recording
is once-only and idempotent. A duplicate returns the existing review ID.

After each successful or duplicate record, enqueue closure. For a batch, use
`closeReviewedBatch`; otherwise use `closeReviewed`. A pending or retrying outbox action
is a valid asynchronous closure request—report its status and do not re-record. Include
already-reviewed targets from phase 1. Call `closeSelf` only after every closure has
been requested and any returned failure is reported. `closeSelf` must be the last tool
call.

## Tool contract

Use only these actions:

- `listSelected` / `listOpen` — snapshot targets;
- `getEvidence` — issue bounded blinded evidence;
- `recordReview` / `recordReviews` — compile, validate, and durably persist reviews;
- `closeReviewed` / `closeReviewedBatch` — enqueue target closure;
- `closeSelf` — enqueue evaluator closure.

Use `subagent` for isolated roles and copy its returned runtime provenance exactly. Use
`ask_user` only for phase-4 human verification. If a required action or reviewer result
is unavailable, report the blocker and leave affected unreviewed targets open.

## Final response

Give a compact per-target summary: session ID/path, new or existing review ID, delivered
and controllable attainment, confidence, closure status, and important limitations.
Then call `closeSelf` as the final tool action and make no further tool calls.
