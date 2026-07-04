---
name: evaluate-sessions
description: >
  Use when the user wants to evaluate/review the app's currently-open sessions —
  judge which are truly done, mark them done, and rate the quality of work. The
  user typically says things like "evaluate all currently open sessions, mark
  each as done that is truly done, and provide a rating for the quality of work
  done for each". Drives the session_review tool (listOpen / getTranscript /
  setReview) and checks in with the user per session via ask_user.
---

# Evaluate Open Sessions

This skill reviews the sessions currently open as tabs in the app, judges which
are genuinely complete, marks them done, and rates the quality of work —
checking with the user before finalizing each review.

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
- **`setReview`** — `{ sessionPath, done, rating, completion, reason }` records
  the review. Persists to the session-review sidecar. When `done: true`, the
  app closes that session's tab — the same close path a user takes (pinned
  tabs included) — so the tab is cleaned up rather than just badged. A
  `partial` / `setback` review keeps the tab open with a status badge.

`sessionPath` values come from `listOpen` (the paths it prints at the bottom).
Never invent a path.

## Rating model

For each reviewed session, set:

- **`done`** (boolean): true only when the session's task is genuinely complete
  or has been conclusively stopped. Never mark an in-progress, ambiguous, or
  still-streaming session done.
- **`rating`** (integer 1–5): the quality of the work done in the session.
  - **5** — excellent: surprisingly good, beyond expectations; reserve for
    standout work, not the baseline for "done well".
  - **4** — good: solid, complete, verified work. This is the baseline for
    work done well; default to 4 unless the work genuinely stands out.
  - **3** — adequate: done but with notable rough edges or incomplete verification.
  - **2** — weak: partial / sloppy work, significant gaps.
  - **1** — poor: mostly wrong, broken, or wasted effort.
- **`completion`** (one of):
  - `fully` — the task was completed.
  - `partial` — real work was done but the task is not fully resolved.
  - `setback` — the session left things *worse* than it found them (a
    regression, a failed/harmful approach, or damage that should be revisited).
- **`reason`** (string): one or two sentences justifying the rating and
  completion classification, grounded in what you saw in the transcript.

## Flow

1. **List open sessions.** Call `session_review` with `{ action: 'listOpen' }`.
   Note which are already `done` (skip those unless the user asks to re-review).

2. **For each non-done open session**, evaluate it:
   a. Call `session_review` with `{ action: 'getTranscript', sessionPath,
      maxTurns: 40 }`. If the session is long and the task/intent isn't clear
      from the excerpt, call again with a higher `maxTurns` (up to 200).
   b. Identify the **original intent**: the first user message states what was
      wanted. The final state shows what was delivered.
   c. Judge **completion** against the intent: was the task actually finished?
      Did the agent verify its work (build/typecheck/tests/re-read diffs)? Or
      did it stop mid-task, leave compile/test failures, claim done without
      evidence, or regress something?
   d. Assign a **rating** per the rubric above, grounded in concrete evidence
      from the transcript (cite specific outcomes — e.g. "left `foo.ts` with a
      syntax error per the bash output", "tests pass per final bash run",
      "claimed done but never rebuilt").
   e. Decide `done`: only `true` when completion is `fully` *and* the work is
      verified, OR when the user explicitly concluded the session. Otherwise
      `false` (you can still record a `partial`/`setback` review without marking
      done — that captures "this is where things stand" and keeps the tab open).
      Note: `done: true` closes the session's tab, so only set it when the task
      is genuinely finished and you've confirmed with the user.

3. **Check in with the user before finalizing each review.** Before calling
   `setReview`, use the `ask_user` tool to present your evaluation and confirm
   the user's take. For example:

   ```
   ask_user:
     question: "Session '<name>': I see <completion summary>. I'd rate it <rating>/5
       (<completion>). Mark done=<true/false>. Agree, or adjust?"
     options: ["Agree", "Higher rating", "Lower rating", "Not done — keep open"]
     context: "<one-paragraph evidence summary citing the transcript>"
   ```

   Adjust the rating / completion / done based on their reply. If they say
   "keep open", record the review with `done: false` (so the status is
   captured) and move on. The user's judgment overrides yours when you
   disagree — record what they decide.

4. **Record the review.** Call `session_review` with `{ action: 'setReview',
   sessionPath, done, rating, completion, reason }`. Use a `reason` that names
   concrete evidence.

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

A session is truly done when, from the transcript, you can see the task's
acceptance criteria met AND verified — not merely claimed. Look for evidence:
successful build/test runs, re-read diffs, a final assistant message that
matches the original intent. "The agent said it's done" is **not** sufficient
by itself; corroborate it with tool results. If you can't corroborate, prefer
`done: false` with a `partial` review and say why in the reason.