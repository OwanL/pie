---
name: evaluate-sessions
description: Review and rate pie's currently-open sessions, marking genuinely completed work done. Use only when the user explicitly asks to evaluate open sessions; not for ordinary code review or implementation.
---

# Evaluate Open Sessions

This skill reviews the requested open sessions, judges whether each has reached
a reasonable stopping point, marks finished sessions done, and rates the quality
of the work. It is a tab-cleanup and time-saving workflow: review in a batch and
ask for one confirmation of the proposed batch rather than making the user
approve every session individually.

## The only tool you need

Use the `session_review` tool (registered by the `session-reviewer` extension).
It has three actions:

- **`listOpen`** — lists the currently-open sessions (straight from the app's
  tab state) with their current review status (`done` ✓/○, rating, completion).
  No parameters. Call this first.
- **`getTranscript`** — `{ sessionPath, maxTurns? }` reads a session's JSONL
  transcript (user inputs + assistant outputs + tool calls + results), excerpted
  to a token-budgeted rendering. Use this to see what actually happened in a
  session. `sessionPath` is the absolute path from `listOpen`.
- **`setReview`** — `{ sessionPath, done, rating, completion, reason, reviewerBuckets?, reviewerCount? }` records
  the review. Persists to the session-review sidecar. When `done: true`, the
  app closes that session's tab — the same close path a user takes (pinned
  tabs included) — so the tab is cleaned up rather than just badged, AND the
  host analytics service records an `agent_review` entry joined to the
  session's run and promotes the review to a scored run outcome for the main
  metrics and leaderboard. The outcome retains `source: agent` provenance so
  agent judgement remains distinguishable from a user's own `run_outcome` and
  can still be compared separately in the dashboard. A `partial` / `setback` review keeps the tab
  open with a status badge. `reviewerBuckets` / `reviewerCount` record the
  multi-reviewer provenance (see below).

`sessionPath` values come from `listOpen` (the paths it prints at the bottom).
Never invent a path.

## Rating model

For each reviewed session, set:

- **`done`** (boolean): true only when the session's task is genuinely complete
  or has been conclusively stopped. Never mark an in-progress, ambiguous, or
  still-streaming session done.
- **`rating`** (integer 1–5): the quality of the work done in the session.
  - **5** — exceptional: unusually insightful or comprehensive work with strong
    evidence and no material shortcomings.
  - **4** — notably strong: better than routine competent execution (for example,
    excellent diagnosis, thoughtful safeguards, or especially strong verification).
  - **3** — satisfactory: the normal score for competent work that reasonably
    accomplishes the task. Minor rough edges or ordinary verification do not
    lower it below 3.
  - **2** — weak: useful progress, but avoidable mistakes or material gaps reduce
    its value.
  - **1** — poor: mostly wrong, broken, harmful, or wasted effort.

Do **not** choose 4 by default. Start from 3 for satisfactory work and move up or
down only for concrete evidence. Completion and rating are independent: a
reasonably completed task can still merit 2, and a deliberately stopped task can
contain excellent work.

### Ratings are an outcome-quality signal

The purpose of the rating is to compare how well different agents/models perform,
including on similar tasks. Rate the **observed outcome and process quality**, not
merely whether the tab can be closed. For the same task, a stronger result should
score higher when it demonstrates better correctness, reasoning, efficiency,
scope control, implementation quality, and proportionate verification; weaker,
meandering, error-prone, or poorly verified work should score lower even if it
eventually completes.

Normalize for task difficulty and available evidence. Do not reward a model just
because it received an easy task, and do not punish one merely because the user
included an impossible stretch clause. Conversely, valid reasons for stopping
can justify `fully`/`done`, but they do not automatically justify a high rating:
score the quality of the judgment, execution, and delivered value. Judge from the
transcript without using model identity or reputation as evidence; stronger
models should rate higher on average only because their outcomes are better.
- **`completion`** (one of):
  - `fully` — the task was completed.
  - `partial` — real work was done but the task is not fully resolved.
  - `setback` — the session left things *worse* than it found them (a
    regression, a failed/harmful approach, or damage that should be revisited).
- **`reason`** (string): one or two sentences justifying the rating and
  completion classification, grounded in what you saw in the transcript.

## Reviewer depth

Use reviewer effort proportionate to the session:

- **Simple sessions:** use one `reviewer` subagent, normally `medium`. Examples:
  a bounded edit with clear acceptance criteria, an empty/trivial session, or a
  transcript with decisive verification evidence.
- **Complex sessions:** use two `reviewer` subagents with different capability
  buckets (`medium` + `small`) and synthesize them. Examples: cross-cutting or
  high-risk changes, ambiguous completion, conflicting evidence, subjective UI
  work, or a disputed first review.
- **No-subagent request or unavailable subagents:** review directly in the main
  agent. User instructions override this default.

Fetch the transcript once and give each reviewer the same relevant excerpt.
Ask for `{ done, rating, completion, reason }` grounded in concrete transcript
evidence. Include the rating calibration and reasonable-scope rule in the
reviewer prompt: 3 is satisfactory, 4 requires notably strong evidence, and an
impossible or grossly disproportionate clause does not make an otherwise
finished practical task partial. Tell reviewers that ratings are a task-normalized
outcome-quality signal used to compare agents/models, while model identity itself
must not influence the score. Tell reviewers not to call `setReview`; the
main agent owns the final decision. When two reviewers are used, reconcile
disagreements rather than averaging ratings mechanically.

Pass `reviewerBuckets` and `reviewerCount` only for reviewers that actually
contributed. Omit both when reviewing directly.

## Flow

1. **List open sessions.** Call `session_review` with `{ action: 'listOpen' }`.
   Note which are already `done` (skip those unless the user asks to re-review).

2. **For each requested, non-done session**, fetch the transcript, choose one or
   two reviewers using the proportional policy above (or review directly when
   required), synthesize any reviewer judgement, then:
   a. Identify the **practical intent**, not merely every literal clause in the
      first message. Separate the core deliverable from examples, stretch goals,
      jokes, contradictory constraints, and requirements that are plainly
      impossible or wildly disproportionate to a single session.
   b. Judge completion against a **reasonable interpretation** of the request.
      A session is `fully` complete when it delivered the useful, feasible core
      and reached a valid stopping point. Do not classify it `partial` solely
      because it declined or could not complete an impossible/disproportionate
      clause (for example, “also build a chess engine stronger than Stockfish”)
      or because an external blocker made further work impossible. Mention the
      excluded clause or blocker in the reason. Use `partial` when a feasible,
      material part of the practical task remains unresolved and another agent
      turn could reasonably finish it.
   c. Consider verification proportionately. Green tests/builds are strong
      evidence when applicable, but lack of a test is not automatically partial
      for advice, investigation, tiny edits, subjective work, or work whose
      verification is unavailable. Conversely, known failures or unsupported
      completion claims count against the review.
   d. Assign a rating per the calibrated rubric above, citing concrete evidence
      about correctness, reasoning, efficiency, scope control, implementation
      quality, and verification. Evaluate counterfactually: compared with a
      competent response to the same practical task, was this weaker, ordinary,
      notably stronger, or exceptional? Never inherit 4 from a reviewer without
      a specific reason it was notably stronger than satisfactory execution.
   e. Decide `done`: use `true` when the practical task is `fully` complete, the
      session was conclusively stopped for a valid reason, or no useful next turn
      is warranted. Keep it open only when there is specific, feasible follow-up
      work worth doing. `done` is a cleanup decision, not a demand for literal
      fulfillment of unreasonable requirements.

3. **Confirm once, in a batch.** Before any `setReview` calls, present a compact
   table of all proposed reviews and use one `ask_user` call. Offer options such
   as `["Apply all", "Adjust some", "Keep all open"]`; allow a free-form reply.
   Include enough evidence in the table/reasons for the user to spot a bad call.
   Only ask separately if the user requests adjustments or one session is too
   ambiguous to include. This confirmation is a safeguard, not a requirement
   that the user manually adjudicate every tab.

4. **Record the review.** Call `session_review` with `{ action: 'setReview',
   sessionPath, done, rating, completion, reason, reviewerBuckets, reviewerCount }`.
   Pass the actual `reviewerBuckets` and `reviewerCount` when one or more
   reviewers contributed. Use a `reason` grounded in concrete evidence and,
   when relevant, summarize disagreement between reviewers.

5. **Report a final summary table** to the user after all sessions are
   reviewed:

   ```
   | session | done | rating | completion | reason |
   ```

## Edge cases

- **Empty/placeholder sessions** (no user messages, `messageCount` 0): skip
  unless the user asked to review them. If asked, record `done: false`,
  `rating` low, `completion: 'setback'` only if they're clutter; otherwise
  `partial` with reason "empty/placeholder session, no work performed".
- **Currently-streaming sessions** (the app shows them running): never mark
  `done: true`. You can still read the transcript-so-far and record a
  `done: false` review if the user wants a checkpoint, but say so in the
  reason.
- **`listOpen` returns none**: tell the user no sessions are currently open as
  tabs and ask whether to evaluate all on-disk sessions instead (do not invent
  paths; `session_review` only knows open sessions).
- **`getTranscript` says "excerpted"**: if you can't judge done-ness from the
  excerpt, re-call with a larger `maxTurns` before recording the review.

## What "truly done" means

A session is truly done when the transcript supports that its practical,
feasible purpose was achieved or that it reached a justified terminal state.
Look for proportionate evidence: successful relevant checks, re-read diffs,
concrete outputs, or a final explanation consistent with tool results. An
assistant's unsupported “done” claim is weak evidence, but do not mechanically
require builds/tests for tasks where they are irrelevant or unavailable. If the
only omitted work is impossible, nonsensical, explicitly optional, blocked
outside the session, or grossly disproportionate to the useful core, document
that judgment and close the session rather than manufacturing a `partial`.

**Some changes can't be validated from tool results at all.** UI styling,
visual layout, animations, copy/wording, and other subjective or perceptual
changes may compile, typecheck, and pass tests yet still not be what the user
actually wanted — and you (like the agent that did the work) cannot see the
rendered result from the transcript. For these, do **not** infer visual success from green builds alone. Flag the
uncertainty in the batch confirmation. If the transcript otherwise shows a
reasonable completed implementation and no concrete defect, it may still be
proposed as done; keep it open only when user validation is a material,
specific next step rather than a generic precaution.