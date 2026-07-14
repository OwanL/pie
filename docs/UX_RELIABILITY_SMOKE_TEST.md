# UX & Reliability Remediation — Manual Smoke-Test Checklist

> Companion to the now-completed UX & Reliability remediation (Briefs A–H, all implemented and unit-tested; the plan and handoff docs were removed once the code became authoritative — see git history). This checklist covers the scenarios that need a **real backend / human interaction** (they can't be app-smoke'd without a fake backend). Run it after any change that touches the host↔backend RPC boundary, the prepass lifecycle, the snapshot/reconciliation path, or error surfacing.

**Goal:** confirm the `Failed to send message: Timed out waiting for response to
req-NN` error is gone, errors are plain-language + actionable (no `req-NN`), and
the editing/interrupting/multi-prompt/stale-state flows feel right — judged
against Nielsen's 10 heuristics.

---

## 0. What's already automated (don't re-run here)

These are covered by unit/app-smoke tests — they are the regression net, not the
smoke matrix. Run `cd extension && npm run test` (1709+ tests) as the gate.

| Scenario | Automated coverage | Test file(s) |
|---|---|---|
| Paste-image clear/restore (Brief C) | app-smoke | `app-smoke.test.ts` |
| Second-send rejection (Brief E) | app-smoke | `app-smoke.test.ts` (in-repo) |
| Prepass chip phase render (Brief F) | app-smoke + reducer | `prepass-status-chip.test.ts`, `arch-reducer.test.ts` |
| Revision-discard / host-instance rebase (Brief D) | app-smoke | `app-smoke.test.ts` |
| NoticeBanner action buttons render + post the right message (Brief H) | app-smoke | `app-smoke.test.ts` |
| Retry re-sends the LIVE draft; disablePruning restores (Brief H) | app-smoke + effect-runner + reducer | `app-smoke.test.ts`, `arch-effect-runner.test.ts`, `arch-reducer.test.ts` |
| Interrupt one-frame "Stopping…" (Brief E) | app-smoke | `app-smoke.test.ts` |
| Error mapper: no `req-NN`, decimal-budget (Brief H) | unit | `error-mapping.test.ts` |
| Prepass succeeded/idle transitions (Brief F) | reducer | `arch-reducer.test.ts` |
| Resnapshot strictly-higher revision (Brief D) | unit | `sidebar-sync.test.ts` |

**Manual scenarios below** are the ones that need a live backend or a wedged
transport — they verify the *integration* the unit tests can't.

---

## Prerequisites

- A workspace with the pie extension installed (`cd extension && npm run build`
  after any `extension/src/` change — the build syncs to the installed VS Code
  extension).
- A model configured (the prepass runs the configured `pruningModel`).
- Pruning **enabled** (`pruning.mode: auto` in settings) for scenarios 1, 3, 5.
- DevTools open on the webview (Help → Toggle Developer Tools, or the
  "Developer: Open Webview Developer Tools" command) to inspect posted messages
  and to wedge the transport (scenario 6).

### How to make the prepass artificially slow (scenarios 1, 5)

The prepass is the `skill-pruner` `before_agent_start` LLM call. To slow it:

- Set `pruning.model` to a **slow / high-latency** model (or one that is
  rate-limited), **or**
- Lower `prepassTimeoutSec` to a few seconds (e.g. `3`) so a normal prepass
  approaches the budget — this exercises the send-timer / `prepass-timeout`
  path without needing a genuinely slow model. Keep it high enough that a
  legitimate prepass completes (e.g. `8`) for the "no false timeout" checks.

> The host infers the prepass START at send dispatch (no SDK `preflightStarted`
> event today — a cross-repo refinement, not yet landed). So the live chip's
> elapsed-time has a small (send-dispatch → preflight-callback) error bound.

### How to force a backend stderr / parse failure (scenario 7)

- **Stderr:** kill the backend child process out-of-band
  (`pie.restartBackend` restarts it; or stop it hard and let the host detect the
  exit). The next send should surface a `backend-exit` notice
  ("The pie backend stopped unexpectedly…") with a **Restart backend** button.
- **Parse failure / dropped line:** inject a malformed line into the backend
  stdout (e.g. a debug build that writes a non-JSON line to stdout, or a
  skill-pruner `process.stderr.write` that the host's 64KB stderr ring captures).
  The send should surface a `dropped-line` notice
  ("The backend sent a malformed response…") with **Retry** + **Show logs**.

---

## Scenario 1 — Slow prepass: no `req-NN` timeout + live chip + cancel

**Briefs:** A (early-ack), F (prepass chip), B (send-timer), E (cancel).

1. Ensure pruning is enabled with a slow prepass (see Prerequisites).
2. Send a turn whose prepass will take well over the old 30s `message.send`
   default (e.g. a long transcript that triggers a big prepass, or a slow
   pruning model).
3. **Expected:**
   - The user message appears **immediately** (early-ack — Brief A). No
     `Failed to send message: Timed out waiting for response to req-NN`.
   - A live **prepass status chip** renders ("Pruning context… {elapsed}s")
     with a **Cancel** affordance (Brief F).
   - The send-timer (Brief B) does **not** fire prematurely while the prepass
     legitimately progresses — the chip clears at the first streaming delta
     (commit point), not at ack.
4. **Cancel mid-prepass:** click the chip's Cancel (or the Stop button).
   - The prepass is aborted (Brief E's cancel hook aborts the in-flight
     `message.send`); the UI reflects "Stopping…" within one frame; the
     optimistic message rolls back + composer inputs restore (Brief C).
5. **Failure path (optional):** set `prepassTimeoutSec` low enough that the
   prepass genuinely exceeds the send-timer budget. Expect a `prepass-timeout`
   notice naming the budget ("Pruning took too long to start this turn (it
   exceeded the Ns budget)") with **Retry** / **Retry without pruning** /
   **Open settings** — no `req-NN`.

---

## Scenario 2 — Pasted image clears instantly + restores on reject

**Briefs:** C (composer-input lifecycle), H (recovery).

1. Paste/drop an image into the composer. Confirm the attachment card shows.
2. Send the turn.
3. **Expected:** the image **disappears from the composer immediately** on send
   (cleared at send time — Brief C), regardless of prepass duration.
4. **Restore on reject:** trigger a pre-ack send failure (e.g. kill the backend
   between paste and the send RPC acking, or use a model that rejects). The
   `sendRejected` imperative restores **both** the draft text AND the image to
   the composer (no data loss). The restored image is staged as a transient
   override until the next snapshot confirms.
5. **Post-ack reject (Brief A/C):** if the prepass fails after ack, the same
   restore happens from `pending.promoted[corrId].inputs`.

---

## Scenario 3 — Edit a mid-transcript message: no truncated-frame flash

**Briefs:** E (edit pipeline invisibility), D (preserve-decision).

1. With a turn streaming or just finished, click **Edit** on a mid-transcript
   user message, change the text, and submit.
2. **Expected:**
   - The view **stays stable** — no flash of the truncated transcript before the
     new send's first delta lands (the `busy || hostRunning` preserve-decision +
     the webview revision/length-identity guards keep the pre-truncate view).
   - The optimistic edit message replaces the original; the new turn streams
     after the prepass.
3. If a `session.opened` snapshot arrives mid-edit (e.g. a tab refocus), the
   optimistic edit content **survives** — the snapshot does not overwrite it
   with stale backend content.

> The webview-side guard is covered by `app-smoke.test.ts` (revision-discard);
> the host-side preserve-decision is code-read-verified. This manual scenario
> is the end-to-end visual confirmation.

---

## Scenario 4 — Interrupt: UI stops within one frame; slow send abortable

**Briefs:** E (interrupt responsiveness), B (cancel hook).

1. Start a streaming turn (busy).
2. Click **Stop**.
3. **Expected:** the button flips to a disabled **"Stopping…"** within one frame
   (Brief E's optimistic `interrupting` flag), BEFORE the host round-trip clears
   `busy`. (Automated: `app-smoke.test.ts` "Brief E: interrupt reflects…".)
4. **Slow-send abort:** start a turn whose prepass is slow (scenario 1), then
   click Stop while the prepass runs. The in-flight `message.send` is aborted
   via Brief B's cancel hook (the `AbortController` passed to `backend.request`);
   the send does **not** wait for its timeout to elapse.

---

## Scenario 5 — Four queued follow-ups: exact delivery or explicit interruption

1. Start a tool-using turn and send at least four follow-up prompts while it is busy.
2. **Expected:** each prompt appears immediately as a distinct optimistic `queued` row. The backend mirrors the SDK steering/follow-up FIFO with each row's `localId`.
3. Let the tool finish. Each SDK user-role delivery promotes the exact correlated row to `completed`; no row disappears merely because the active owner moves outside the durable transcript tail.
4. Repeat and press **Stop** before delivery. The backend clears the SDK queue and the host removes/interrupts every queued optimistic row; none may execute during a later unrelated send.
5. Reload the webview mid-queue. Host-owned queued/live state returns in the next authoritative snapshot; webview-local overlays do not become a second queue authority.

---

## Scenario 6 — Wedge the webview (delayed acks) during streaming: converges without old+new overlap

**Briefs:** D (stale-state / snapshot recovery), G (memoized projection).

> **Bucket 2 item 3** — the one scenario not unit-tested end-to-end (a full
> streaming-wedge harness is too heavy; the mechanism is code-read-verified +
> covered by the revision-discard unit test). This is the human confirmation.

1. Start a streaming turn.
2. **Wedge the transport:** in the webview DevTools console, intercept the
   `message` event handler so transcript commit evidence (`transcriptCommitted`) is delayed (e.g. wrap
   `window.postMessage` / the host's `postMessage` to defer delivery by ~500ms).
   Alternatively, throttle the VS Code webview to simulate a slow host→webview
   post.
3. While commit evidence is delayed, let the host continue producing sequenced semantic events and full snapshots. The delivery controller allows only one unsettled `postMessage`, coalesces the newest desired state lazily, and keeps the state dirty until acceptance.
4. **Expected:**
   - The view **converges** to the authoritative state without showing old + new
     messages simultaneously. Out-of-order / duplicate envelopes are **discarded**
     by the webview revision guard (`revision <= lastApplied` → drop).
   - `stateReceived` and `appCommitted` alone do not clear transcript correctness. Only a signed leaf-displayed `transcriptCommitted` entry in the accepted-revision ledger advances progress; `paintObserved` remains separate telemetry.
   - The monotonic commit-progress watchdog resnapshots the latest desired state without resetting its deadline on every newer accepted post. Bounded reload escalation remains available while streaming.
   - Reload restores the host-owned `LivePipelineState`; it does not discard active text/tools or flash a separately-owned old streaming row.
5. Restore normal ack delivery. The view settles to the final authoritative
   state with no leftover stale overlay.

---

## Scenario 7 — Force a backend stderr/parse failure: actionable plain-language error, no `req-NN`

**Briefs:** H (error messaging), B (correlation diagnostics).

1. Force a backend failure (see Prerequisites): kill the backend, or inject a
   malformed stdout line.
2. Send a turn (or let an in-flight turn hit the failure).
3. **Expected:** a plain-language notice that **names the problem + offers a
   concrete recovery action** — **no internal `req-NN` id** anywhere in the UI.
   - Backend exit → `backend-exit`: "The pie backend stopped unexpectedly.
     Restart the backend, then retry your message." + **Restart backend** +
     **Show logs**.
   - Dropped line → `dropped-line`: "The backend sent a malformed response. You
     can retry, or show the logs for details." + **Retry** + **Show logs**.
   - Prepass failure → `prepass-failed` / `prepass-timeout`: includes the
     sanitized backend detail (any `req-NN` stripped) + **Retry** /
     **Retry without pruning**.
4. **Recovery actions** (Brief H, now wired):
   - **Retry** re-sends the live composer draft as a `retrySend` (honoring an
     edit between rejection and retry — `draftRestore` would be stale).
   - **Retry without pruning** disables pruning atomically before the re-send,
     then **restores the prior pruning mode** once the retried turn commits
     (commit point / fire / pre-ack failure — verified by
     `arch-effect-runner.test.ts`). Pruning is **not** left permanently off.
   - **Show logs** opens the pie OutputChannel; **Open settings** opens
     `settings.json` (filtered to "pie" if the file can't be resolved).
   - **Restart backend** runs `pie.restartBackend` and dismisses the notice.
   - Retry + Restart **dismiss** the notice; Show logs / Open settings do **not**
     (the error still stands — the user just opened a surface).
5. Confirm the raw error is still **logged host-side** (diagnostics not lost) —
   only the user-facing string is sanitized.

---

## Scenario 8 — Live-pipeline fault matrix

Run each fault independently: missing `turn.started`, missing middle sequence, malformed observation, raw heartbeat without semantics, delayed/false/rejected/never-settling post, dropped transcript commit, render exception, lost readiness, backend exit during a pending post, large preview/checkpoint, nested subagent siblings, and interrupted modifying tool. Each run must end in exact durable/live equality, an explicit interrupted message, or a classified bounded protocol fault. The next send must remain usable. Do not count Node synthetic timing as Chromium evidence.

---

## Done-criteria for this checklist

- All 8 scenarios pass with the expected behavior.
- No `req-NN` id appears anywhere in the UI across any scenario.
- No "old + new message at once" during scenario 6.
- Pruning is restored to the user's prior mode after a "retry without pruning"
  (scenario 7) — verify in settings after the retried turn commits.
- `cd extension && npm run typecheck && npm run test && npm run build` green.
- Real VS Code trace evidence records snapshot bytes and receipt→app commit→transcript commit→paint budgets for small and 240-row sessions; synthetic reports remain labelled synthetic.

Record any deviation as a follow-up note (no active `TODO.md` exists in the
repo; track in your issue tracker or a fresh note).
