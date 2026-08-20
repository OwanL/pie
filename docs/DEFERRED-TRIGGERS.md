# Deferred triggers

Design and behavioral contract for the `defer_trigger` tool and its host-side
registry: a session can register an asynchronous condition — a timer, user
input, or another session finishing — and end its turn; the host resumes that
session with a synthetic wake-up message when the condition fires.

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

Three owners, two processes, one append-only sidecar.

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
{"id":"…","op":"fire","sessionPath":"…","reason":"…","at":"…"}
{"op":"cancel","sessionPath":"…","targetId":"…","at":"…"}   // targetId absent = cancel all for sessionPath
```

- The **backend process** (`defer_trigger` tool) appends `register`/`cancel`.
- The **extension host** (`DeferredTriggerRegistry`) appends `fire`/`cancel`
  and reads the log.
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
- `user_input` — fires when the user sends a message in the watcher session.
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
- `fire(id, reason)` removes the trigger, best-effort appends the `fire` op
  (so a restart does not re-arm an already-consumed trigger), and dispatches a
  synthetic `Send` Command through the reducer — the exact same path as a
  typed message — when the watcher's tab is open. If the tab is closed the
  trigger is still consumed (it cannot be delivered to a closed session);
- `cancel(...)` updates in-memory state immediately and appends the sidecar op
  (the webview must not wait for the debounced watcher to reflect a cancel).

The wake-up message starts with the stable prefix `[deferred trigger fired: …]`
and carries `customType: 'deferred-trigger'` + `customDetails: { reason }` on
the optimistic user message so the webview renders it as an auto-resume (not a
typed message). The SDK persists user messages without custom metadata, so
`extension/src/backend/transcript.ts` re-derives the tag from the text prefix
on transcript reload.

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

- A registered trigger fires **at most once** per process; the in-memory set
  and the persisted `fire` op agree on consumption. If the `fire` append fails
  (sidecar unavailable), the in-memory state is still consumed — a later
  reload may re-arm from the sidecar's `register` op, an acceptable rare case
  (idempotent fire guards double-delivery within one process).
- A `session_finished` trigger never fires on the watcher's own session.
- Delivery is exactly-once per host instance: the wake-up dispatches through
  the reducer `Send` path; if the watcher's tab is busy, the existing
  `message.send` → `followUp` queue defers the wake-up until the current turn
  ends.
- The webview can cancel triggers from the menu (`cancelDeferredTrigger`
  command → host `registry.cancel`) — same sidecar op as the tool's `cancel`,
  so both surfaces stay consistent.
- Best-effort persistence everywhere: a failed sidecar append never blocks
  in-memory behavior or the webview.
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
  — registry lifecycle: reload, timer re-arm vs absolute deadline, fire paths
  (tab open/closed), cancel, self-wake guard.
- `extension/test/host/deferred-triggers/deferred-triggers-store.test.ts` —
  sidecar store edge cases.
- `extension/test/backend/transcript/transcript-deferred-trigger.test.ts` —
  wake-up prefix → customType re-derivation on transcript reload.
- `extension/test/webview/…` — aggregate-stats-strip menu render + cancel.

Run: `npm run test:file -- extensions/deferred-triggers/test/store.test.ts` and
the extension suite (`npm run test:all`).
