---
name: evaluate-sessions
description: "Use when asked to assess, audit, grade, benchmark, or review one or more agent sessions or their delivered work—especially requirement attainment, outcome quality, process discipline, evidence, or the accuracy of final claims."
---

# Evaluate sessions

Use this skill only when the user wants **agent sessions evaluated**. A target may be
completed, paused, pinned, selected, or open. Evaluate the work and evidence of how it
was done—not merely the current diff and not the model or author.

Do not use it for ordinary code review, debugging, implementation, or general feedback.

## Evaluation standard

### Scope and evidence

- Review exactly the requested targets. Completion claims are evidence to weigh, not
  proof. Use only the bounded, blinded `getEvidence` bundle; never expose model,
  provider, model-change, runtime/settings, treatment, reputation, or raw session JSONL
  to evaluators.
- Freeze the requirements before classifying results. Preserve changed or withdrawn
  requirements as `superseded`.
- Human responses, when available, support one criterion or surface, never an overall
  score. Human input is not required to finish a review.
- Persist through the review tool. Never write sidecars, import its internal store,
  fabricate provenance, or replace it with scripts.

### Criterion ledger

Create observable, independently classifiable criteria from the user's requirements
and only genuinely necessary implied conditions. Each criterion has `criterionId`, an
observable `statement`, `origin` (`explicit` or `necessary_implied`), `importance`
(`core`: missing it defeats the primary outcome; `supporting`: materially affects
quality or completeness; `optional`: useful non-core value or requested polish), and
taxonomy for activity, surface, and evidence mode. Avoid generic criteria such as
“high quality” unless they are necessary to the requested value.

Classify every frozen criterion exactly once. Use only these status/reason pairs:

- `met` or `superseded` → `none`;
- `partly_met` or `unmet` → `omitted`, `attempt_failed`, `incorrect_result`,
  `regression`, or `unknown`;
- `blocked` → `external_blocker`, `user_dependency`, or `unknown`;
- `not_assessable` → `human_evidence_missing`, `insufficient_artifact_evidence`, or
  `unknown`.

Attach evidence references to every classification. Do not mark a claimed completion
`met` when the bundle cannot verify it; use `not_assessable` when evidence cannot
fairly distinguish success from failure.

### Process, evidence, and confidence

Return process dimensions `requirementDiscipline`, `verificationDiscipline`,
`scopeControl`, `recovery`, and `finalClaimAccuracy`, using the review tool's issued
enums. Return evidence coverage for `requirements`, `artifacts`, `execution`, and
`human`, plus concrete `limitations`. Reported execution is not direct execution;
name transcript/diff omissions, missing artifacts, workspace drift, ambiguous
attribution, and unanswered checks. Use confidence `high`, `medium`, or `low`; `high`
requires direct support for every active core and outcome-supporting classification.

Overall attainment and the quality index are derived from the canonical ledger by the
review tool. Never ask a reviewer to choose them or hand-calculate them.

## Durable control loop

The `session-review` checkpoint is the executable workflow and owns recovery; model
context does not. Its orchestrator JSONL retains tagged calls, role outputs, and
runtime provenance across compaction. Process one unreviewed target end-to-end,
persist it, and request closure before starting another. The
checkpoint's `taskInstructions` is authoritative for each role's output contract,
enums, namespace rules, retry correction, and raw-JSON requirements; do not duplicate
or override those contracts here. This skill owns target control, evidence handling,
phase handoffs, and evaluation principles.

For every listed launch, use exactly the issued `agent` (`session-evaluator`), bucket,
`workflowRef`, and `taskInstructions`. Put `taskInstructions` verbatim in the
`subagent` task and append only the exact bounded evidence and phase handoff; the
subagent schema has no separate task-instructions field. Preserve the exact role ref,
target, evidence manifest, and handoff. The opaque ref is for orchestration; the child
remains tool-free and blind. Never substitute a general-purpose reviewer, change a
bucket, paraphrase the issued instructions, or invent a role. Launch only entries in
`checkpoint.launch`; independent proposal or classification entries may run as sibling
calls.

Call `getReviewStatus` once after each settled launch group. Do not poll while children
run or call it twice without new durable role results. A retry is the same role, target,
evidence manifest, phase handoff, and workflow ref, with only the newly issued
corrective `taskInstructions` changed; launch it only when `checkpoint.launch`
explicitly issues attempt 2. Never exceed the one-retry budget.

### 1. Snapshot and target queue

1. Choose one snapshot action: `listSelected` for a pinned-target request, or
   `listOpen` for explicitly named open targets or an explicit all-open request. These
   are host-pushed tab sets, not disk-wide session listings. For a named request,
   filter the result strictly to the requested session IDs/paths; resolve a display
   name only when it is exact and unambiguous. Never review a returned but unrequested
   tab. Always exclude this evaluator session.
2. Use the stable session-header ID as identity. If absent, use the tool path fallback
   and preserve that fact. Partition this effective set once into unreviewed and
   already-reviewed targets; do not re-rate an existing canonical review. Only an
   explicit calibration request (including an explicitly named audit/re-evaluation)
   authorizes it.
3. Queue already-reviewed targets for closure using their existing review IDs. If more
   than one exists, make exactly one `closeReviewedBatch` call with each snapshot's
   `sessionId`, `reviewId`, and `sessionPath`. Inspect every result; do not resend
   successes, and relist before retrying only an authority-stale failure.
4. The snapshot remains valid across ordinary follow-ups, deferred wake-ups, history
   compaction, and closure of earlier targets. The tool revalidates membership,
   identity, running state, and review state. Relist after an extension/backend
   restart, an edited/resubmitted/rewritten evaluator branch, or to add newly requested targets. An
   absent target is ineligible. A `listSelected` target must remain pinned; a
   `listOpen` target may be pinned or unpinned. The old snapshot never gains targets
   implicitly; use an explicit relist to adopt additional requested targets.
5. After a required relist, call `getReviewStatus` for the current target. It
   rehydrates issued manifests and completed tagged roles; never rerun a completed
   role. History compaction alone needs no relist: call status directly and reissue
   `getEvidence` once only if the identical bundle is no longer in context, never just
   to check progress.
6. Count committed targets in the current turn. For a large batch, after three
   targets each reach persisted-review plus closure-requested, if `defer_trigger` is
   available and targets remain, register a
   1-second timer whose note contains `resume review batch`, the last committed
   session ID, and the next target ID, then end the turn. Register only at a committed
   target boundary. Resume from the existing snapshot after wake-up.

### 2. Evidence and checkpoint loop

For the current target, call `getEvidence` once, then `getReviewStatus` to obtain the
checkpoint and exact bounded handoff. Use the same blinded bundle for every role in
this target; do not replace it with a parent-written summary.

Repeat this control loop until recording or a durable blocker:

- `run-roles`: launch every and only `checkpoint.launch`, forwarding each entry's
  exact instructions, role ref, agent, bucket, bundle, and applicable handoff. Do not
  launch another evaluator until the next status checkpoint.
- After the group settles, call `getReviewStatus` once. Its recovered roles and
  `handoff` are authoritative; do not rewrite, classify, or add to them.
- Proposals are independent, propose observable criteria only, and do not classify or
  choose an overall. Consolidation receives the same evidence and the exact proposal
  handoff. It merges/deduplicates and freezes the ledger; it does not classify it.
- The two fresh classifiers receive the same evidence, the immutable frozen ledger,
  and the recovered human response if present. They classify every frozen criterion;
  do not mutate the ledger or reuse a proposal role.
- If status requests `adjudication`, provide the same evidence and its exact handoff
  (ledger, both component outputs, and every listed `materialFields`, including the
  required criterion reason fields). Resolve every and only those fields. Do not
  adjudicate non-material differences; the tool performs permitted deterministic
  merges, limitation unions, and lower-confidence selection.

If the checkpoint is `ready-to-record`, stop launching roles. If it is `blocked` after
its issued attempt-2 retry, report the role error, leave this target unreviewed, and
continue with the next original target; a blocked target releases the one-target
batch guard. Do not launch a third attempt, create a new evidence key, or reset the
retry budget. Keep the evaluator session open.

### 3. Record and close immediately

When status is `ready-to-record`, call `recordRecoveredReview` with the target session
ID. It reconstructs the compact draft, tagged role outputs, human evidence, manifest,
and authentic runtime provenance, then derives and validates canonical fields. Do not
create a draft or copy model/provider, prompt-hash, bucket, tool-call, or other
runtime metadata manually.

After a successful or duplicate record, immediately call `closeReviewed` with the
returned review ID. A pending/retrying outbox action is an accepted closure request,
not proof that the tab has visibly disappeared: say **closure requested**, do not
relist merely to wait, and proceed to the next original target. This is the one-target
commit boundary; later evidence must not be gathered before it.

Use only the listed session-review actions: `listSelected`/`listOpen`, `getEvidence`,
`getReviewStatus`, `recordRecoveredReview`, `closeReviewed`/`closeReviewedBatch`, and
`closeSelf`. Direct `recordReview`/`recordReviews` are legacy compatibility routes,
not this workflow. Human input is optional. A blocked target remains unreviewed and
must not be fabricated into a record.

Do not call `closeSelf` as cleanup. Only when the user explicitly asks to hide or close
this evaluator session, and only after a fresh same-turn `listSelected` confirms that
this session is pinned, may you call `closeSelf` with `confirmSelf: true`. A
`listOpen` result or an earlier-turn list does not authorize it. Make `closeSelf` the
final tool call; it never interrupts running work.

## Final response

Give a compact per-target summary: session ID/path, new or existing review ID,
delivered and controllable attainment when a review was recorded, confidence, closure
status, and important limitations. For a blocked target, state that no review was
recorded, identify the blocker, and omit unavailable metrics rather than inventing
values. Do not close the evaluator session unless explicitly requested; if requested,
`closeSelf` with `confirmSelf: true` must have been the final tool action.
