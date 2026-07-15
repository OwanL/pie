---
name: evaluate-sessions
description: Autonomously review and rate pie's currently-open sessions, mark finished work done (closing those tabs), and close itself when complete. Runs end-to-end with no user input. Use only when the user asks to evaluate open sessions; not for ordinary code review or implementation.
---

# Evaluate Open Sessions (autonomous)

This skill reviews every open session, judges whether each has reached a
reasonable stopping point, marks finished sessions done (which closes their
tabs), rates the quality of the work, and finally **closes its own tab** when
all reviews are recorded. It is fully autonomous: it never asks the user to
confirm, adjudicate, or approve — it gathers evidence, decides, records, and
exits on its own.

## The only tool you need

Use the `session_review` tool (registered by the `session-reviewer`
extension). It has four actions:

- **`listOpen`** — lists the currently-open sessions (straight from the app's
  tab state) with their current review status (`done` ✓/○, rating, completion).
  The current (reviewer) session is marked `(self)` / `★` so you can skip it.
  No parameters. Call this first.
- **`getTranscript`** — `{ sessionPath, maxTurns? }` reads a session's JSONL
  transcript (user inputs + assistant outputs + tool calls + results),
  excerpted to a token-budgeted rendering. Use this to see what actually
  happened. `sessionPath` is the absolute path from `listOpen`.
- **`setReview`** — `{ sessionPath, done, rating, completion, reason,
  reviewerBuckets?, reviewerCount? }` records the review. Persists to the
  session-review sidecar. When `done: true`, the app closes that session's tab
  — the same close path a user takes (pinned tabs included) — so the tab is
  cleaned up rather than just badged, AND the host analytics service records an
  `agent_review` entry joined to the session's run and promotes the review to a
  scored run outcome for the main metrics and leaderboard. The outcome retains
  `source: agent` provenance so agent judgement remains distinguishable from a
  user's own `run_outcome`. A `partial` / `setback` review keeps the tab open
  with a status badge. `reviewerBuckets` / `reviewerCount` record the
  multi-reviewer provenance (see below).
- **`closeSelf`** — `{ reason? }` closes **this** (the reviewer) session once
  its work is complete. It resolves the current session's path from the
  runtime context (you never pass your own path), writes a `done: true`
  self-close marker, and the host closes this tab once the turn ends. The host
  skips scored agent-review analytics for self-close markers (a session rating
  itself is not an objective signal). **This is always the final action** —
  after calling it, give your summary and stop calling tools so the turn ends
  and the tab closes.

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
  completion classification, grounded in concrete evidence you gathered
  (transcript turns, tool results, diffs).

## Reviewer depth

Use reviewer effort proportionate to the session:

- **Simple sessions:** use one `reviewer` subagent, normally `medium`. Examples:
  a bounded edit with clear acceptance criteria, an empty/trivial session, or a
  transcript with decisive verification evidence.
- **Complex sessions:** use two `reviewer` subagents with different capability
  buckets (`medium` + `small`) and synthesize them. Examples: cross-cutting or
  high-risk changes, ambiguous completion, conflicting evidence, subjective UI
  work, large transcripts (>60 turns), or a disputed first review.
- **No-subagent request or unavailable subagents:** review directly in the main
  agent. User instructions override this default.

Fetch the transcript once and give each reviewer the same relevant excerpt
(plus the `session_changes` diff when the session touched code). Ask for
`{ done, rating, completion, reason }` grounded in concrete transcript evidence.
Include the rating calibration and reasonable-scope rule in the reviewer prompt:
3 is satisfactory, 4 requires notably strong evidence, and an impossible or
grossly disproportionate clause does not make an otherwise finished practical
task partial. Tell reviewers that ratings are a task-normalized outcome-quality
signal used to compare agents/models, while model identity itself must not
influence the score. Tell reviewers not to call `setReview`; the main agent owns
the final decision. When two reviewers are used, reconcile disagreements rather
than averaging ratings mechanically.

Pass `reviewerBuckets` and `reviewerCount` only for reviewers that actually
contributed. Omit both when reviewing directly.

## Flow (fully autonomous — never call `ask_user`)

1. **List open sessions.** Call `session_review` with `{ action: 'listOpen' }`.
   Build the work queue from the result:
   - **Skip** sessions already `done` (✓) — they are already closed/badged.
   - **Skip** the session marked `(self)` / `★` — that is *this* reviewer
     session. Never review or rate yourself; you close yourself at the end with
     `closeSelf`.
   - **Skip** sessions that are still streaming/running (you cannot judge
     completion of an in-flight session; its transcript is incomplete). You may
     still record a `done: false` checkpoint if the user explicitly asked for
     one, but say so in the reason.
   - The remaining non-done sessions are your queue. If the queue is empty
     (everything already done or it's just you), go straight to the final
     self-close step.

2. **For each session in the queue, gather evidence thoroughly, then review and
   record — with no user confirmation.** Per session:
   a. **Read the transcript.** Call `getTranscript` with `maxTurns` 40 first.
      The rendering keeps the first user message (the original task/intent) plus
      the most recent turns. If the session has many turns or completion is
      ambiguous from the excerpt, re-call with a larger `maxTurns` (up to 200)
      until you can judge the final state confidently.
   b. **Verify code changes independently.** If the session edited files, call
      `session_changes` with `{ action: 'list', sessionPath }` to see the
      changed-file manifest, then `{ action: 'diff', sessionPath, paths: [...] }`
      for the material changes. Cross-check that the diffs actually exist, are
      coherent, and match what the agent claimed to do. An agent's "done" claim
      unsupported by a real diff is weak evidence; a diff that contradicts the
      claim counts against the review. Read files directly when a diff is
      incomplete (generated or untracked files).
   c. **Identify the practical intent**, not merely every literal clause in the
      first message. Separate the core deliverable from examples, stretch goals,
      jokes, contradictory constraints, and requirements that are plainly
      impossible or wildly disproportionate to a single session.
   d. **Judge completion against a reasonable interpretation** of the request.
      A session is `fully` complete when it delivered the useful, feasible core
      and reached a valid stopping point. Do not classify it `partial` solely
      because it declined or could not complete an impossible/disproportionate
      clause (for example, "also build a chess engine stronger than Stockfish")
      or because an external blocker made further work impossible. Mention the
      excluded clause or blocker in the reason. Use `partial` when a feasible,
      material part of the practical task remains unresolved and another agent
      turn could reasonably finish it.
   e. **Consider verification proportionately.** Green tests/builds/typechecks
      are strong evidence when applicable, but lack of a test is not
      automatically partial for advice, investigation, tiny edits, subjective
      work, or work whose verification is unavailable. Conversely, known failures
      or unsupported completion claims count against the review.
   f. **Assign a rating** per the calibrated rubric above, citing concrete
      evidence about correctness, reasoning, efficiency, scope control,
      implementation quality, and verification. Evaluate counterfactually:
      compared with a competent response to the same practical task, was this
      weaker, ordinary, notably stronger, or exceptional? Never inherit 4 from a
      reviewer without a specific reason it was notably stronger than
      satisfactory execution.
   g. **Decide `done`:** use `true` when the practical task is `fully` complete,
      the session was conclusively stopped for a valid reason, or no useful next
      turn is warranted. Keep it open only when there is specific, feasible
      follow-up work worth doing. `done` is a cleanup decision, not a demand for
      literal fulfillment of unreasonable requirements.
   h. **Record the review directly** — do not batch-confirm with the user. Call
      `session_review` with `{ action: 'setReview', sessionPath, done, rating,
      completion, reason, reviewerBuckets, reviewerCount }`. Pass the actual
      `reviewerBuckets` and `reviewerCount` when one or more reviewers
      contributed. Use a `reason` grounded in concrete evidence and, when
      relevant, summarize disagreement between reviewers.

3. **Close yourself.** Once every session in the queue has been reviewed and
   recorded, call `session_review` with `{ action: 'closeSelf' }` (optionally
   with a `reason` summarizing the batch). This is always the last tool call.
   After it returns, print your final summary table and **stop** — do not call
   any more tools. The host closes this tab once the turn ends.

4. **Final summary.** Print a compact table of all reviews you recorded:

   ```
   | session | done | rating | completion | reason |
   ```

   Then end the turn so `closeSelf` takes effect.

## Edge cases

- **Empty/placeholder sessions** (no user messages, `messageCount` 0): record
  `done: true`, `rating` low (1–2), `completion: 'partial'` with reason
  "empty/placeholder session, no work performed" (or `'setback'` only if they're
  clutter). Close them — they have no useful next turn.
- **Currently-streaming sessions** (still running): never mark `done: true`. You
  can read the transcript-so-far and record a `done: false` checkpoint if the
  user wants one, but say so in the reason. Otherwise skip and leave for a later
  run.
- **`listOpen` returns none / only yourself**: there is nothing to review. Go
  straight to `closeSelf`.
- **`getTranscript` says "excerpted"**: if you can't judge done-ness from the
  excerpt, re-call with a larger `maxTurns` before recording the review.
- **A session you already reviewed flips back to not-done** (user reopened it):
  re-review it normally on this run.

## What "truly done" means

A session is truly done when the transcript supports that its practical,
feasible purpose was achieved or that it reached a justified terminal state.
Look for proportionate evidence: successful relevant checks, re-read diffs,
concrete outputs, or a final explanation consistent with tool results. An
assistant's unsupported "done" claim is weak evidence, but do not mechanically
require builds/tests for tasks where they are irrelevant or unavailable. If the
only omitted work is impossible, nonsensical, explicitly optional, blocked
outside the session, or grossly disproportionate to the useful core, document
that judgment and close the session rather than manufacturing a `partial`.

**Some changes can't be validated from tool results at all.** UI styling,
visual layout, animations, copy/wording, and other subjective or perceptual
changes may compile, typecheck, and pass tests yet still not be what the user
actually wanted — and you (like the agent that did the work) cannot see the
rendered result from the transcript. For these, do **not** infer visual success
from green builds alone. Note the uncertainty in the `reason`. If the transcript
otherwise shows a reasonable completed implementation and no concrete defect, it
may still be marked done; keep it open only when user validation is a material,
specific next step rather than a generic precaution.
