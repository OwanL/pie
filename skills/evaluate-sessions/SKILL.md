---
name: evaluate-sessions
description: "Use when asked to assess, audit, grade, benchmark, or review one or more agent sessions or their delivered work—especially requirement attainment, outcome quality, process discipline, evidence, or the accuracy of final claims. Apply an evidence-based session-evaluation workflow with blinded review and explicit target closure; not ordinary code review, debugging, or implementation."
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
- If available, human responses are evidence for one criterion or surface, never an overall score; human input is not required to complete a review.
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

## Compaction-safe workflow

The session-review tool owns workflow recovery; model context does not. Process each
unreviewed target **end-to-end and persist it before starting the next target**. Never
fetch evidence or accumulate role outputs for the whole batch up front. The only
parallel calls permitted are the two independent proposals or the two independent
classifiers for the current target.

Every delegated role must carry the exact `workflowRef` returned by
`getReviewStatus` in the subagent tool's `workflowRef` argument. The child never sees
that opaque value. The parent session JSONL retains the tagged call, final JSON output,
and authoritative runtime details even after history compaction. Do not copy model,
provider, prompt hash, bucket, or tool-call IDs into a draft; `recordRecoveredReview`
recovers and validates them itself.

### 1. Snapshot

1. Call `listSelected` for named/pinned targets; call `listOpen` only for an explicit
   all-open request.
2. Partition once into unreviewed and already-reviewed targets.
3. Queue already-reviewed targets for closure using their existing review IDs.
4. Work through unreviewed targets one at a time using phases 2–6 below.

After backend restart or history compaction, list again and call `getReviewStatus` for
the current target. It rehydrates issued evidence manifests and completed tagged roles
from the orchestrator JSONL. Never rerun a role reported complete. If the next role
needs the evidence bundle and it is no longer in context, call `getEvidence` again; the
static target produces the same bounded bundle/manifest.

### 2. Evidence and independent proposals

Call `getEvidence` for only this target, then call `getReviewStatus` to obtain role
refs bound to that exact evidence manifest. Give the exact bounded bundle—not a parent-written summary—to both proposal
reviewers. Request `small` for `proposal-small` and `medium` for `proposal-medium`.
Require JSON only:

```json
{
  "criteria": [{
    "criterionId": "stable-id",
    "statement": "observable outcome",
    "origin": "explicit",
    "importance": "core",
    "taxonomy": {
      "activity": "implement",
      "surface": ["application_logic"],
      "evidenceMode": ["static_inspection"]
    }
  }]
}
```

Choose one valid enum per field. Other taxonomy values are: activity `debug`,
`investigate`, `explain`, `design`, `operate`, `verify`, `other`; surface `ui`,
`api_integration`, `data`, `tests`, `documentation`, `configuration`, `infrastructure`,
`developer_tooling`, `agent_harness`, `external_system`, `communication`, `other`;
evidence mode `automated_check`, `runtime_observation`, `human_observation`,
`external_confirmation`, `reasoning_or_sources`, `other`. `origin` also permits
`necessary_implied`; importance also permits `supporting` and `optional`.

Do not classify, ask users, run tools, or choose an overall. Call `getReviewStatus`
after the results. An invalid latest role is a phase-boundary failure: retry only that
role with the same bundle and workflow ref.

### 3. Consolidate and freeze

The status response supplies both validated proposals. Give those proposals and the
same evidence bundle to one fresh coordinator, requested `medium`, using the
`consolidation` ref. Require JSON only:

```json
{
  "frozenLedger": [{
    "criterionId": "stable-id",
    "statement": "observable outcome",
    "origin": "explicit",
    "importance": "core",
    "taxonomy": { "activity": "implement", "surface": ["application_logic"], "evidenceMode": ["static_inspection"] }
  }],
  "dedupNotes": ["concise merge note"]
}
```

Do not classify or modify the frozen ledger after this role. Call `getReviewStatus` to
validate and obtain the next handoff.

### 4. Fresh independent classification

Give both fresh classifiers the exact same evidence bundle, immutable ledger from
status, and recovered human response if present. Request `small` for
`classification-small` and `medium` for `classification-medium`; each bucket's
user-configured assignment owns the model and reasoning level. Require JSON only:

```json
{
  "criteria": [{
    "criterionId": "frozen-id",
    "status": "met",
    "reason": "none",
    "evidenceRefs": ["bundle reference"]
  }],
  "process": {
    "requirementDiscipline": "proportionate",
    "verificationDiscipline": "proportionate",
    "scopeControl": "controlled",
    "recovery": "not_needed",
    "finalClaimAccuracy": "accurate"
  },
  "evidence": {
    "requirements": "clear",
    "artifacts": "direct",
    "execution": "direct",
    "human": "not_needed",
    "limitations": ["concrete limitation"]
  },
  "confidence": "high"
}
```

Every frozen criterion appears exactly once. Status/reason pairs must follow the
criterion-classification table above. Do not repeat criterion definitions, propose an
overall, mutate the ledger, ask users, run tools, or write records. Call
`getReviewStatus`; retry only an invalid/missing role.

### 5. Reconcile only when requested

`getReviewStatus` deterministically compares validated components. If it reports
`adjudication`, give a fresh `medium`, high-thinking adjudicator the exact status
handoff (ledger, both components, and exact `materialFields`) plus the same evidence.
Require JSON only:

```json
{
  "resolvedFields": [{
    "field": "exact field from materialFields",
    "value": "resolved enum/string value",
    "rationale": "evidence-grounded rationale",
    "evidenceRefs": ["bundle reference"]
  }]
}
```

Resolve every and only listed field. A material criterion status also has a listed
reason field. Do not alter the ledger or resolve non-material differences; the tool
performs permitted deterministic merges, unions limitations, and selects lower
confidence. Call `getReviewStatus` after adjudication.

### 6. Persist and close immediately

When status reports `ready-to-record`, call `recordRecoveredReview` with the target
session ID. It reconstructs the compact draft, reviewer outputs, human evidence,
evidence manifest, and authentic runtime provenance from JSONL, then derives and
validates canonical fields. Never create a temporary draft, manually copy runtime
metadata, or use raw session scripts.

After a successful or duplicate record, call `closeReviewed` immediately with the
returned review ID. A pending/retrying outbox action is a valid asynchronous closure
request. Only then proceed to the next target. The tool enforces this one-target
commit boundary so later evidence cannot create a large parallel context or discard
completed reviews.

Do not call `closeSelf` as routine cleanup. The evaluator is not one of the pinned
targets: leave it open after a completed review, or after a blocker such as a reviewer
429. Only if the user explicitly asks to close this evaluator session may you call
`closeSelf` with `confirmSelf: true`, as the final tool call.

## Tool contract

Use only these session-review actions:

- `listSelected` / `listOpen` — snapshot targets and rehydrate durable workflow state;
- `getEvidence` — issue/reissue one target's bounded blinded evidence;
- `getReviewStatus` — recover/validate tagged roles and return the next bounded handoff;
- `recordRecoveredReview` — compile and persist a ready tagged pipeline;
- `closeReviewed` / `closeReviewedBatch` — enqueue target closure;
- `closeSelf` — enqueue evaluator closure only with `confirmSelf: true` after an explicit user request.

The direct `recordReview`/`recordReviews` actions are legacy compatibility routes, not
part of this workflow. The tool rejects evidence/review work for a second target until
the current target has been recorded and its closure requested. Use `subagent` only
with status-issued workflow refs. Human input is not required by this workflow. If a
required role remains unavailable after one identical retry, report the blocker, leave
that target unreviewed, and keep the evaluator session open.

## Final response

Give a compact per-target summary: session ID/path, new or existing review ID, delivered
and controllable attainment, confidence, closure status, and important limitations.
Do not close the evaluator session unless the user explicitly requested that; if so,
call `closeSelf` with `confirmSelf: true` as the final tool action.
