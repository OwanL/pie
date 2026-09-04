# Deferred triggers

Design and behavioral contract for the `defer_trigger` tool and its host-side
registry: a session can register an asynchronous condition — a timer, user
input, or another session finishing — and end its turn. Timer and
session-finished conditions resume with a synthetic wake-up message; a real
user prompt is itself the wake for `user_input` and consumes the trigger
without dispatching a second `Send`.

Runtime code:

- tool: `extensions/deferred-triggers/` (backend process)
- host registry + sidecar store: `extension/src/host/deferred-triggers/`
- shared sidecar paths: `extension/src/shared/deferred-triggers-paths.ts`
- protocol types: `extension/src/shared/protocol/deferred-triggers.ts`
- webview menu: `extension/src/webview/panel/aggregate-stats-strip/deferred-triggers-menu.tsx`

## 1. Why this exists

Long-running tasks (e.g. "wait for X, then finish the report") previously
forced one of two bad shapes: the agent burned model tokens polling inside a
single turn, or the task simply ended and the condition was never re-checked.
Deferred triggers give the agent an explicit "wake me up when" primitive: the
model registers a trigger, ends the turn, and is resumed automatically — as a
synthetic user message on the same session — when the condition fires.

## 2. Architecture and ownership

Three owners, two processes, one append-only sidecar plus per-trigger atomic
claim artifacts in the same sidecar directory.

### 2.1 The sidecar (`triggers.jsonl`)

Append-only JSONL op log, one JSON object per line, located as a sibling of
the sessions directory:

```
<root>/data/outcomes/sessions          ← sessions
<root>/data/outcomes/deferred-triggers ← triggers.jsonl (this feature)
```

Path derivation lives in `extension/src/shared/deferred-triggers-paths.ts`
and is shared so host and backend agree on the location. The backend child
additionally receives `PIE_TRIGGERS_DIR` (`extension/src/host/backend/client.ts`)
because the tool runs in the backend process and cannot import host code.
When no session dir is configured the feature degrades gracefully: the tool
errors, the host registry is a no-op.

Op shapes (multi-writer, so replay is `replayTriggers(readTriggerOps())` over
the whole file; files stay small — a handful of ops per session):

```jsonc
{"id":"…","op":"register","sessionPath":"…","triggers":[{"kind":"timer","ms":60000}],"note":"…","at":"…"}
{"id":"…","op":"claim","sessionPath":"…","claimId":"…","ownerId":"…","ownerPid":1234,"reason":"…","at":"…","dispatchStartedAt":"…"} // dispatchStartedAt only when delivery already began
{"id":"…","op":"dispatch-started","sessionPath":"…","claimId":"…","ownerId":"…","ownerPid":1234,"reason":"…","at":"…","dispatchStartedAt":"…"}
{"id":"…","op":"release","sessionPath":"…","claimId":"…","reason":"…","recoveryState":"dead-owner-recovered","at":"…"} // recoveryState only for crash recovery
{"id":"…","op":"failed","sessionPath":"…","reason":"…","at":"…"}
{"id":"…","op":"fire","sessionPath":"…","claimId":"…","reason":"…","at":"…"}
{"op":"cancel","sessionPath":"…","targetId":"…","at":"…"}   // targetId absent = cancel all for sessionPath
```

Before appending `claim`, a host publishes
`triggers.jsonl.claim-<sha256(triggerId)>` with an atomic hard link. The source
file is fully written before linking, and the destination is never replaced.
That artifact is the compare-and-set shared by host processes; the JSONL ops
are the replayable state. A claim artifact carries the registry instance ID,
OS process ID, claim timestamp, and whether delivery had already begun. Only
host registries create/remove claim artifacts; the backend tool never does.
Claim artifacts are also replayed directly, so a host crash between atomic
publication and the `claim` append remains visible and cannot permit a second
dispatch. Every append and the complete temporary claim payload are `fsync`ed
before progressing.

Synthetic delivery appends and fsyncs `dispatch-started` immediately before
calling the host `Send` path. A `user_input` claim includes
`dispatchStartedAt` in its initial artifact because the real prompt was already
dispatched before trigger consumption. On startup and every reload, a registry
checks a claim's owner PID. Only a confirmed-dead owner with no durable dispatch
boundary is released as `dead-owner-recovered`. After confirming death, the
registry replays the exact claim once more so a dispatch boundary fsynced just
before owner exit cannot be missed. It persists an idempotent `claim` first (so
artifact-only crashes remain replayable), then makes the release durable before
the exact old artifact is removed. The fixed artifact therefore remains the
cross-host compare-and-set even when two registries race recovery and retry.
A live PID, permission/lookup ambiguity, a legacy claim without a PID, PID
reuse, or any claim with dispatch-started evidence remains fail-closed. The
last case may represent a lost acknowledgement and must not be retried
automatically.

Durable `fire`/`release` records make a leftover artifact stale; replay removes
that crash residue. The JSONL remains the historical source and is not
compacted today; terminal artifacts are removed eagerly and on replay.

- The **backend process** (`defer_trigger` tool) appends `register`/`cancel`.
- The **extension host** (`DeferredTriggerRegistry`) owns claim artifacts,
  appends `claim`/`release`/`failed`/`fire`/`cancel`, and reads the log.
- Two host instances (two VS Code windows) share the sidecar; each registry
  reconciles on reload and `fs.watch` changes, so a trigger registered in one
  window can be listed/cancelled in the other.

`sessionPath` on every op is the **watcher's** session (the one that called
`defer_trigger` and will be resumed). `triggers[].sessionPath` (on
`session_finished` specs) is the **watched** session.

### 2.2 The `defer_trigger` tool (backend process)

`extensions/deferred-triggers/index.ts` registers a single tool with three
actions:

- `register` — validates specs, appends a `register` op, then ends the turn
  (`ctx.abort()` on `setImmediate`, so the successful tool result reaches the
  model first and no further tools run before the wake-up).
- `list` — replays the sidecar for the current session and renders pending
  triggers (id, spec, note, registration time).
- `cancel` — appends a `cancel` op (one trigger by id, or all for the session).

Trigger kinds (OR semantics across specs — the first to fire wins and consumes
the whole trigger):

- `timer(ms)` — fires after `ms` from registration; re-armed on host restart
  against the absolute registration deadline.
- `user_input` — is consumed by the real user message sent in the watcher
  session. It does not create synthetic content.
- `session_finished` — fires when a session (specific path, or any session)
  finishes streaming. **Never fires on the watcher's own session** (a
  self-wake loop guard: the watcher's own deferring turn ends as a session
  finish too).

### 2.3 The host registry (extension host process)

`extension/src/host/deferred-triggers/registry.ts`:

- `start()` replays the sidecar and starts an `fs.watch` watcher (debounced);
- `onSessionFinished(path)` / `onUserInput(path)` are called at host event
  boundaries and reconcile the sidecar synchronously first — so a register op
  appended by the tool immediately before the event cannot miss its only
  matching event due to watcher debounce;
- `fire(id, reason)` is used only for timer/session-finished synthetic wakes.
  It first verifies that the watcher tab is open, then atomically claims the
  trigger, durably marks dispatch as started, and dispatches one synthetic
  `Send`. The claim remains until the ordinary `SendResult` reports acceptance,
  which appends `fire`; a definitive
  rejection appends `release`. A second host cannot dispatch while the claim
  artifact exists. A stale registry that wins after completion replays the
  `fire` under its claim and exits without dispatching;
- `onUserInput(path, corrId)` claims after the message router has dispatched
  the real prompt and settles from that prompt's ordinary `SendResult`. It
  never calls the synthetic wake path, so one user action creates exactly one
  `Send`;
- startup/reload releases a confirmed-dead owner's pre-dispatch claim to
  `retryable` with `recoveryState: dead-owner-recovered`; an open watcher
  automatically retries that safely recovered timer/session-finished wake on
  the next event-loop turn, while a closed watcher retains it until reopen.
  Live, unknown, legacy, PID-reused, and dispatch-started claims remain
  `claimed`. A dispatch-started claim is projected with
  `recoveryState: acknowledgement-ambiguous` so the UI explains why automatic
  retry is blocked;
- a closed tab records `failed` and leaves the trigger `retryable`; a definite
  dispatch exception, rejected `SendResult`, or backend-ready watchdog drop
  appends `release` and removes its claim artifact. If dispatch succeeded but
  acknowledgement/completion is lost, the claim is retained as an explicit
  ambiguous `claimed` state rather than risking duplicate delivery. Reopening
  the watcher retries retained timer/session-finished failures; `user_input`
  waits for the next real prompt. Ordinary retryable elapsed timers are not
  automatically re-armed, preventing a persistent rejection from creating a
  refire loop; the narrow exception is a confirmed-safe dead-owner recovery;
- `cancel(...)` updates in-memory state immediately and appends the sidecar op
  (the webview must not wait for the debounced watcher to reflect a cancel).

Synthetic timer/session-finished wake-up messages start with the stable prefix
`[deferred trigger fired: …]` and carry `customType: 'deferred-trigger'` +
`customDetails: { reason }` on the optimistic user message so the webview
renders them as an auto-resume (not a typed message). The SDK persists user
messages without custom metadata, so `extension/src/backend/transcript.ts`
re-derives the tag from the text prefix on transcript reload. A `user_input`
trigger has no synthetic text or metadata because the real prompt is its wake.

Long timers: Node clamps `setTimeout` delays beyond ~24.8 days to 1ms, so
`armTimer` schedules bounded slices (`MAX_TIMER_SLICE_MS = 2^31 - 1`) and
checks the absolute deadline after each slice.

### 2.4 The webview

`ViewState.deferredTriggers` (`DeferredTriggerView[]`) is projected in
`PieExtension.buildViewState` from `registry.getActiveTriggers()`. The bottom
status strip renders a waiting-triggers segment; clicking it opens
`DeferredTriggersMenu` (a webview-local popup, `STATE_CONTRACT` webview-local
state) listing each trigger with its watcher session, condition, note, and
elapsed wait, plus a cancel action per trigger. Session tabs with a pending
`timer`/`user_input` trigger show a small indicator
(`deferredSessionPaths`/`deferredTimerSessionPaths` in app-body derived state).
`deferredTriggers` is a fresh array on every snapshot — no shared mutation
across the postMessage boundary.

## 3. Contract and invariants

- A registered trigger produces **at most one dispatch across host
  processes**. The atomic per-trigger artifact selects one claim owner. It is
  removed only after durable `fire`, or after a durable `release` proving that
  dispatch failed before completion.
- A `session_finished` trigger never fires on the watcher's own session.
- Timer/session-finished delivery dispatches through the reducer `Send` path;
  if the watcher's tab is busy, the existing `message.send` → `followUp` queue
  defers the synthetic wake until the current turn ends. `user_input` consumes
  the claim using the already-dispatched real prompt and never dispatches a
  follow-up.
- Closed-tab, claim-persistence, synchronous dispatch, confirmed pre-dispatch
  owner death, and definitive Send rejection failures remain active with
  `deliveryState: retryable` and a visible reason. Recovered owner death also
  carries `recoveryState: dead-owner-recovered` and is automatically retried
  only when its watcher is open. An unconfirmed dispatch remains
  active with `deliveryState: claimed` and
  `recoveryState: acknowledgement-ambiguous`; it is fail-closed and requires
  cancellation rather than an automatic duplicate dispatch.
- The webview can cancel triggers from the menu (`cancelDeferredTrigger`
  command → host `registry.cancel`) — same sidecar op as the tool's `cancel`,
  so both surfaces stay consistent.
- Claim persistence is fail-closed. Failure before a claim means no automatic
  delivery. A confirmed process death may recover a claim only before the
  durable dispatch boundary; failure after that boundary retains the claim.
  Cancel remains available when acknowledgement is ambiguous.
- The webview differentiates wake-up messages by `customType`; the backend
  re-derives it from the stable text prefix on reload.

## 4. Configuration

- `PIE_TRIGGERS_DIR` — backend-side sidecar dir (set by the host; derives from
  the same session/env config as the host path).
- `PIE_EXTENSION_TOGGLES_JSON` with `{"deferred-triggers": false}` disables
  the tool at runtime (Settings → Extensions checkbox).

## 5. Verification

- `extensions/deferred-triggers/test/store.test.ts` — op-log append/replay,
  cancel semantics, OR-trigger resolution.
- `extension/test/host/deferred-triggers/deferred-triggers-registry.test.ts`
  — registry lifecycle: real-input consumption without synthetic `Send`,
  timer re-arm, retryable delivery failures, self-wake guard, dead-owner
  recovery, ambiguous acknowledgement retention, and two registry instances
  racing both recovery and retry.
- `extension/test/host/deferred-triggers/deferred-triggers-store.test.ts` —
  sidecar replay/claim edge cases, including owner PID artifacts, injected
  liveness, safe dead-owner release, ambiguous dispatch retention, and two
  stores sharing one file.
- `extension/test/host/deferred-triggers/deferred-triggers-process-race.test.ts`
  — two real OS processes race one claim and durable dispatch witness, then two
  replacement processes race recovery and witnessed delivery after a real claim
  owner exits before the dispatch boundary.
- `extension/test/backend/transcript/transcript-deferred-trigger.test.ts` —
  wake-up prefix → customType re-derivation on transcript reload.
- `extension/test/webview/…` — aggregate-stats-strip menu render + cancel.

Run the focused tests with:

```bash
npm run test:file -- \
  extensions/deferred-triggers/test/store.test.ts \
  extension/test/host/deferred-triggers/deferred-triggers-store.test.ts \
  extension/test/host/deferred-triggers/deferred-triggers-registry.test.ts \
  extension/test/host/deferred-triggers/deferred-triggers-process-race.test.ts
```
