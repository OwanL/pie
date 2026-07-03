# pie State Contract

## Session Selection

- The host store owns selection through `activeSessionPath`.
- `activeSession` in the webview snapshot is derived from `activeSessionPath` plus the current session summaries.
- `session.create` and `session.open` carry a `selectionToken`.
- `session.opened` may only activate a tab when its `selectionToken` still owns selection.
- Stale `session.opened` payloads may refresh cached data, but they must not steal focus.

## Session Routing

- Mutating backend requests require an explicit `sessionPath`.
- `message.send`, `message.interrupt`, and `session.truncateAfter` never fall back to the viewed or active session implicitly.
- Session-scoped backend events must include `sessionPath`.
- Missing `sessionPath` is treated as a protocol defect.

## Session Cleanup

- Closing or invalidating a session clears transcript state, alias state, current-turn state, busy dedup state, pending composer inputs, and queued per-session operations.
- Pending composer inputs are session-scoped host state: close/invalidate clears them for that session; extension restart/shutdown clears all remaining pending inputs.
- Pending-session placeholders are cleaned up one session at a time; overlapping creates must not share teardown.
- Pending session identifiers must be collision-safe under rapid repeated creation.

## Snapshot Recovery

- Full snapshots are the authoritative base.
- A full snapshot contains the currently loaded transcript window (`transcript`) plus explicit window metadata (`transcriptWindow`), not necessarily the entire historical transcript.
- State-envelope revisions are global and advance on each full snapshot; they continue to detect host-instance counter resets in combination with `hostInstanceId`.
- Every envelope carries `protocolVersion` matching `WEBVIEW_PROTOCOL_VERSION`.
- Transport is snapshots-only. Full snapshots carry the complete ViewState. When the view is hidden or not ready, the host marks globalDirty; the next flush emits a full snapshot.
- When visibility returns, the next host-to-webview sync is a full snapshot.
- The webview clears overlay/transient UI when the host instance changes or the active session changes.
- A busy `session.opened` refresh may update tab/session metadata, but it must not discard in-memory optimistic or streaming transcript state that is newer than the backend snapshot.
- **Watchdog force-reload suppression while streaming is a correct invariant, not a bug.** The `StateAppliedWatchdog` first does a revision-gated **resnapshot** (re-post the dirty snapshot) on a missed ack — this runs regardless of running count and is the self-healing path. Only the *consecutive-timeout* **force-reload** is suppressed when `runningCount > 0`, because a mid-stream reload discards transient streaming state and produces the exact "old + new at once" symptom. Do not remove this suppression. Lowering streaming debounce (Brief G-enabled) and making webview revision/length-identity guards total are the correct levers; the watchdog is not.
- **A stale `webviewReady=false` belief self-heals via `WebviewReadinessProbe`.** `canPostSnapshotToView()` gates posting on `hasView && webviewReady`, and `webviewReady` is the host's *belief*: it flips `false` on every webview reload (asset-version mismatch, hot reload, watchdog force-reload) and is restored only by an inbound `ready`/`refreshState` reaching the readiness setter. If that handshake does not restore it (a lost `ready`, or an asset-version reload loop whose handshake is consumed by the mismatch branch before the setter), the host marks `globalDirty` and posts nothing indefinitely — the agent advances host-side while the webview freezes on its last frame, recovered only when the user refocuses. The probe breaks that stall: while the view exists, readiness is believed false, and state is dirty, it periodically pushes the pending snapshot directly and adopts `postMessage`'s `delivered=true` as the readiness signal. Bounded by `READINESS_PROBE_MAX_ATTEMPTS`; a genuinely-unresponsive webview is left to the watchdog force-reload / visibility transitions. The probe's reload-skip is time-bounded: it bails for the first few ticks of a genuine reload (don't post to a renderer being replaced) but, past `RELOAD_STUCK_SKIPS` consecutive skips (~6s), treats `reloading` as stale (a reload loop whose every `ready` is consumed by the asset-mismatch branch, or a lost `ready` from a renderer that never finished loading), force-clears it, and probes — otherwise the bail would trap the probe forever (`attempts` never increments on a reloading-skip) and, with the watchdog force-reload suppressed while streaming, the webview would freeze until the user interrupts.

## Execution Ordering

- Lifecycle requests (`create`, `open`) are serialized through a host lifecycle queue.
- Session mutations (`send`, `edit`, `truncateAfter`, `interrupt`) are serialized per session path.
- Optimistic UI writes must be reversible when the authoritative operation fails.
- The EffectRunner routes session-scoped RPC effects through `enqueueLifecycle → enqueueSessionOperation(sessionPath, ...)` to guarantee FIFO ordering with respect to other session operations.
- Lifecycle effects (`OpenSession`, `CreateSession`) use `enqueueLifecycle(...)` directly (no inner session queue).
- Non-session effects (`PersistTabs`, `Log`) execute directly without queueing.

## Reducer Purity

- The reducer is pure: `(State, Event) → { state, effects }`. No I/O, no `Date.now()`, no randomness.
- Side effects only happen inside the EffectRunner.
- An `EffectResult` handler in the reducer may return new effects, but those are queued asynchronously by the runner; the reducer never synchronously awaits another effect.

## Optimistic Reconciliation

- Optimistic mutations (send, edit) are tagged with a `corrId` that correlates the command, the pending state entry, and the eventual `EffectResult`.
- `state.pending.ops: Record<corrId, PendingOp>` tracks in-flight optimistic operations with rollback snapshots.
- On RPC success: promote pending → authoritative (clear `corrId` tag, finalize backend-assigned id).
- On RPC failure: revert via `state.pending.ops[corrId]` — remove the optimistic transcript entry by `localId`, restore `previousSummary`, fire a `sendRejected` imperative, drop the entry.
- Backend events arriving before `SendRpcResult` are applied normally — the pending user message is already in the transcript, so assistant deltas append after it.

### Two failure windows for `send` (mechanism implemented in Brief A; inputs payload/webview restore added in Brief C)

> The early-ack mechanism is implemented in Brief A: `message.send` now resolves as
> soon as the prompt is *queued* (before the pruning prepass), `state.pending.promoted`
> exists, and the `SendResult{ok:true}` ops→promoted move, the post-ack
> `PreflightFailed` rollback, and the commit-point drop at the first `MessageStarted`
> are all in code. Brief B implemented the **send-timer** that *dispatches*
> `PreflightFailed` (with `corrId`) when the post-ack, pre-commit phase elapses
> with no commit point — closing the gap where a hung prepass left
> `pending.promoted[corrId]` until a commit point that never came (Brief A had
> wired only the backend prepass-failure bridge, which dispatches *without*
> `corrId`); see the "Timer ownership" bullet below. Brief C landed the `sendRejected.inputs` payload
> and the webview composer-input restore (plus composer clear-at-send): the
> post-ack rollback restores host-side `pendingComposerInputsBySession`
> from `pending.promoted[corrId].inputs` AND carries `inputs` on the
> `sendRejected` imperative; the pre-ack `SendResult{ok:false}` path mirrors
> it (restores from `pending.ops[corrId].inputs`). The webview stages the
> imperative's `inputs` as a transient override of `pendingComposerInputs`
> until the next snapshot confirms. The subsection below describes the full state.

`message.send` will resolve as soon as the prompt is *queued* (before the pruning prepass), so an optimistic send will have two failure windows, not one:

1. **Pre-ack failure** — the `message.send` RPC itself rejects. Revert via `state.pending.ops[corrId]`, exactly as the legacy contract describes. `SendResult{ok:false}` is the trigger.
2. **Post-ack, pre-commit failure** — the RPC succeeded but the prepass then fails. The trigger is a dedicated `PreflightFailed{corrId, sessionPath, requestId, error}` event, **not** a reused `SendResult{ok:false}` (the RPC genuinely succeeded; the prepass is a distinct phase). On `SendResult{ok:true}` the rollback snapshot is **not** deleted — it moves from `state.pending.ops[corrId]` to `state.pending.promoted[corrId]`, which retains the snapshot and composer-input restore payload until the turn commits.

**Commit point:** a promoted send commits at the **first streaming event** (`MessageStarted`/first `Delta`) for its `requestId`. At that point `pending.promoted[corrId]` is dropped and a later prepass/turn failure becomes an in-turn error (surfaced by the error mapper), never a rollback. This bounds the rollback window so a flaky prepass cannot yank a turn the user has already watched start streaming.

A post-ack, pre-commit `PreflightFailed` must: remove the optimistic transcript entry by `pending.promoted[corrId].localId`, restore `pending.promoted[corrId].previousSummary`, restore `pendingComposerInputsBySession[sessionPath]` from `pending.promoted[corrId].inputs`, clear `pending.requestIdToLocalId[requestId]`, fire a `sendRejected` imperative (carrying `inputs`), and surface a plain-language error.

**Timer ownership:** a send has two phase-scoped timers, never racing. A short `RequestTracker` timeout owns the pre-ack (queue-time) RPC (`message.send` is sized ~10s in `RPC_TIMEOUTS_MS`); its rejection is the pre-ack failure window. One send-timer owns the pre-ack-to-first-delta phase; it is started at RPC dispatch and cleared at the commit point (first streaming `MessageStarted` for the `requestId` — the same commit point at which `handleMessageStarted` drops `pending.promoted[corrId]` and emits a `ClearSendTimer` effect), and on fire it dispatches `PreflightFailed` *with `corrId`* (the reducer's explicit-corrId path short-circuits its `requestId` scan). Both timers are short-circuited by the same commit-point event, so they can never both fire for one send; the pre-ack rejection also clears the send-timer (no commit will come), and `handlePreflightFailed` no-ops if `promoted` was already dropped (commit happened) — so a late fire cannot double-rollback. `edit` follows the same phase-scoped shape. *(Implemented in Brief B: the send-timer lives in `EffectRunner` (`startInFlightSend`/`clearInFlightSend`/`onSendTimerFire`), the `ClearSendTimer` effect is emitted by `handleMessageStarted`, and the `AbortController` passed to `backend.request` is abortable via `EffectRunner.abortInFlightSend(sessionPath)` — Brief E's interrupt hook.)*

## Webview-Local State

The webview must not hold logic state in local `useState`/`useReducer`. Only the following ephemeral UI concerns are allowed as webview-local state:

- **contextMenu** — position and type of the currently open context menu (dismissed on click-outside/Escape)
- **peek / hover overlay** — transient overlay visibility for the changed-files rail (and analogous hover-peek surfaces), dismissed on mouse-leave / tap-outside / Escape. It is an overlay, not a layout push — it reserves no horizontal space; only an explicit pin (`ViewState.fileChangesExpanded`) durably reserves space. The moral equivalent of `contextMenu`.
- **scrollPosition / autoScroll** — viewport scroll tracking
- **input focus / caret position** — DOM focus state
- **drag state** — transient tab drag-and-drop position
- **animation / transition state** — CSS transition tracking
- **protocol-sync bookkeeping** — `lastRevisionRef`, `awaitingSnapshotRef`, `hostInstanceIdRef`, pending-draft-restore tracking, pending-composer-inputs-restore tracking (Brief C: a transient render override of `pendingComposerInputs` staged between a `sendRejected` imperative and the next confirming snapshot — the analog of draft-restore), in-flight `corrId` set for UI gating
- **derived UI telemetry** — FPS counters, render-timing buffers. (Token-rate measurement is no longer webview-local: it runs host-side in `TokenRateService`, which ticks every running session — including ones that are not the active/selected tab — using the transcripts the host already holds, and posts the per-session states as `ViewState.tokenRateBySession`. The webview just displays the active session's pre-computed state.)
- **per-keystroke draft buffer** inside an active input (the committed draft on blur/send/tab-switch is host state; the live keystroke buffer is not)
- **optimistic user message overlay** — pending user messages shown instantly before the host confirms them. The webview generates a `localId`, sends it with the `send` protocol message, and displays the message in the transcript immediately. When the host state arrives containing a message with that `localId`, the optimistic overlay entry is reconciled away. On `sendRejected`, the overlay entry is removed and the draft is restored.

All other state (editing, outcome dialogs, draft content, session selection, model settings, prefs) lives in the host store and reaches the webview via ViewState snapshots.

## Notice Surfacing

- The host owns a single global notice triple in `settings`: `notice` (short, user-facing summary, `string | null`), `noticeKind` (Brief H failure category for recovery buttons, `NoticeKind | null`), and `noticeRaw` (the verbatim, unredacted backend error string, `string | null`).
- The short `notice` summary **never** contains internal `req-NN` correlation ids (Brief H criterion 1). `noticeRaw` **does** retain them verbatim so the webview can reveal the full error via a "show raw" affordance for debugging.
- Invariant: `noticeRaw` is non-null only when `notice` is an error notice (set at the send/edit/prepass error sites, `handleError`, and `revertSetModel`). Plain `NoticeShown` notices (info/warnings, including `notice: null` clears) always set `noticeRaw = null` so a stale "show raw" can't outlive its notice.
- `dismissNotice` clears all three together. A non-error `NoticeShown` clears `noticeKind` and `noticeRaw` together (a plain info banner carries no recovery actions and no raw detail).
- The projection surfaces all three as `ViewState.notice`, `ViewState.noticeKind`, and `ViewState.noticeRaw`. The webview's `NoticeBanner` renders the short summary, recovery action buttons (from `kind`), and — when `noticeRaw` differs from `notice` — a "Show raw" toggle that reveals the verbatim error in a scrollable monospaced block.
