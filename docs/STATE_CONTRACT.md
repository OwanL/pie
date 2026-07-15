# pie State Contract

## Session Selection

- The host store owns selection through `activeSessionPath`.
- `activeSession` in the webview snapshot is derived from `activeSessionPath` plus the current session summaries.
- `session.create` and `session.open` carry a `selectionToken`.
- `session.opened` may only activate a tab when its `selectionToken` still owns selection.
- Stale `session.opened` payloads may refresh cached data, but they must not steal focus.
- A superseded selection request retains responsibility for operation cleanup,
  but its timeout/rejection is silent: only the current selection owner may
  replace the global notice or choose a fallback tab.

## Session Routing

- Mutating backend requests require an explicit `sessionPath`.
- `message.send`, `message.interrupt`, and `session.truncateAfter` never fall back to the viewed or active session implicitly.
- Session-scoped backend events must include `sessionPath`.
- Missing `sessionPath` is treated as a protocol defect.

## Backend Failure Recovery

- Backend JSONL records share a 32 MiB byte limit. An overlong correlated stdout response is replaced before writing with a `RESPONSE_TOO_LARGE` error carrying the same request ID, so the stream remains synchronized and the backend stays available. An overlong stdout event remains a fatal transport fault. Overlong stdin records are discarded through LF; when the bounded preview contains a request ID, the backend returns a correlated `REQUEST_TOO_LARGE` response. Subsequent requests remain readable.
- Intentional stops do not produce public unexpected-exit events, but an intentional stop during startup still rejects that child’s readiness promise. Process generations prevent an old exit from clearing a replacement. Backend restart is manual; there is no automatic restart.
- Provider header waits are bounded per provider. Two consecutive header stalls open a shared transport circuit, so sibling sessions fail locally instead of consuming every provider slot and timeout budget. After an exponentially backed-off cooldown, exactly one half-open probe may reach the provider; response headers close the circuit, while a failed probe reopens it. User cancellation never counts as provider failure. The circuit survives live concurrency-setting changes and is exposed through provider capacity/metrics.
- Affected session paths are deduplicated. Crash cleanup materializes each host-owned live turn as interrupted, preserves only durability-confirmed terminal tools, interrupts queued user messages, and clears pending extension-UI, retry, wait, interrupt, checkpoint, and queued transient state even when no transcript is loaded.
- The short exit notice contains the interrupted-session count and reliable activity classification; raw stderr is exposed only as `noticeRaw` with `noticeKind: backend-exit`.

## Session Cleanup

- Closing or invalidating a session clears durable transcript cache, `LivePipelineState` turn/tool/pending-owner/tombstone state, alias state, current-turn correlation metadata, busy dedup state, pending composer inputs, and queued per-session operations.
- Pending composer inputs are session-scoped host state: close/invalidate clears them for that session; extension restart/shutdown clears all remaining pending inputs.
- Pending-session placeholders are cleaned up one session at a time; overlapping creates must not share teardown.
- Pending session identifiers must be collision-safe under rapid repeated creation.

## Snapshot Recovery

- Full snapshots are the authoritative base.
- A full snapshot contains the currently loaded transcript window (`transcript`) plus explicit window metadata (`transcriptWindow`), not necessarily the entire historical transcript.
- State-envelope revisions are global and advance on each full snapshot; they continue to detect host-instance counter resets in combination with `hostInstanceId`.
- Every envelope carries `protocolVersion` matching `WEBVIEW_PROTOCOL_VERSION`.
- Delivery evidence is split: `stateReceived` proves receipt, `appCommitted` proves the app tree committed, `transcriptCommitted` proves the signed displayed transcript leaves match the host expectation, and `paintObserved` records the next visible paint. Only a valid accepted-ledger `transcriptCommitted` identity advances transcript correctness.
- The semantic identity is bounded-cost and computed from the projected `TranscriptView`: durable rows joined with the host-owned active turn/tool records. It signs the last three transcript leaves plus bounded live/terminal tool aggregates. Queued follow-ups cannot push an active owner outside the signed live-tool aggregate.
- Transport is snapshots-only. Full snapshots carry the complete ViewState. When the view is hidden or not ready, the host marks globalDirty; the next flush emits a full snapshot.
- When visibility returns, the next host-to-webview sync is a full snapshot.
- The webview clears overlay/transient UI when the host instance changes or the active session changes.
- Active text, reasoning, reply model/reasoning-level metadata, tool-call drafts, typed bounded previews, tool lifecycle, producer phase, sequence, and extension-UI ownership live only in host `LivePipelineState`. `ArchState.transcript` is the durable history cache, not a second live authority. Projection purely joins the two.
- Backend semantic envelopes use live protocol **v4**, independently of the RPC transport wire version. They are monotonic per turn/attempt; version skew, missing, rejected, illegal-owner, or out-of-order events trigger rejection or the effect-owned `liveTurn.checkpoint` RPC. Checkpoints are structurally validated, byte-bounded, and in-memory only; they impose no total tool-count limit. Older durability-confirmed tool input/result payloads are semantically compacted in backend repair state while lifecycle identity and a detailed recent tail remain. Applying such a checkpoint preserves richer matching terminal details already held by the host. Terminal repair checkpoints may use bounded transport headroom beyond the ordinary active-checkpoint budget because they are one-shot recovery payloads, not repeatedly streamed live state. Terminal lifecycle watermarks expose a lost final event. Repeated repair failure interrupts locally and never replays tool execution.
- Tool and assistant terminal envelopes are withheld until the patched SDK append returns a stable session-entry ID. Aggregate completed-tool count or payload size does not abort a healthy turn; individual semantic records remain bounded. The reducer atomically appends the durability-confirmed terminal message and removes its live turn/tools. A fresh session branch wins on reopen; dangling persisted work is shown as interrupted.
- A busy `session.opened` refresh may update tab/session metadata and durable paging state, but it cannot erase the separately-owned active live turn. Webview reload also restores that host state through the next full snapshot.
- The delivery controller retains one unsettled post, lazily coalesces the newest desired snapshot, times settlement out locally, ignores late settlements from stale view generations, and maintains one monotonic accepted-revision/commit ledger. Recovery resnapshots the latest desired state before bounded reload escalation; reload does not discard host-owned live work.
- **A stale `webviewReady=false` belief self-heals via `WebviewReadinessProbe`.** `canPostSnapshotToView()` gates posting on `hasView && webviewReady`, and `webviewReady` is the host's *belief*: it flips `false` on every webview reload (asset-version mismatch, hot reload, watchdog force-reload) and is restored only by an inbound `ready`/`refreshState` reaching the readiness setter. If that handshake does not restore it (a lost `ready`, or an asset-version reload loop whose handshake is consumed by the mismatch branch before the setter), the host marks `globalDirty` and posts nothing indefinitely — the agent advances host-side while the webview freezes on its last frame, recovered only when the user refocuses. The probe breaks that stall: while the view exists, readiness is believed false, and state is dirty, it periodically pushes the pending snapshot directly and adopts `postMessage`'s `delivered=true` as the readiness signal. Bounded by `READINESS_PROBE_MAX_ATTEMPTS`; a genuinely-unresponsive webview is left to the watchdog force-reload / visibility transitions. The probe's reload-skip is time-bounded: it bails for the first few ticks of a genuine reload (don't post to a renderer being replaced) but, past `RELOAD_STUCK_SKIPS` consecutive skips (~6s), treats `reloading` as stale (a reload loop whose every `ready` is consumed by the asset-mismatch branch, or a lost `ready` from a renderer that never finished loading), force-clears it, and probes — otherwise the bail would trap the probe forever (`attempts` never increments on a reloading-skip) and, with the watchdog force-reload throttled rather than suppressed while streaming, leave the webview stuck for the throttle window until the probe self-healed it.

## Execution Ordering

- Lifecycle requests (`create`, `open`) are serialized through a host lifecycle queue.
- Session mutations (`send`, `edit`, `truncateAfter`, `interrupt`) are serialized per session path.
- `message.interrupt` is a bounded abort-completion barrier. While pending, `runningSessionPaths` and `interruptInFlightBySession` keep the composer in `Stopping…`; submission is blocked so stop→send cannot enter the dying turn. If remote teardown does not settle, the backend terminalizes locally, reports the classified timeout, replaces the session runtime, and gates the next send on that replacement rather than waiting forever. Interrupting an already-idle session is idempotent.
- Editing has restart semantics. `EditRpc` performs idempotent interrupt → truncate → send inside one serialized session operation, so editing a prior message cannot race a live assistant turn.
- Optimistic UI writes must be reversible when the authoritative operation fails.
- The EffectRunner routes session-scoped RPC effects through `enqueueSessionOperation(sessionPath, ...)` to guarantee per-session FIFO ordering without holding the global lifecycle queue. A slow prepass, interrupt, or checkpoint for one session cannot block opening, creating, or interacting with another session.
- Lifecycle effects (`OpenSession`, `CreateSession`) use `enqueueLifecycle(...)` directly (no inner session queue).
- Non-session effects (`PersistTabs`, `Log`) execute directly without queueing.
- Backend stdout has separate ordered control and event lanes. Correlated RPC
  responses drain ahead of queued stream events (FIFO within each lane), while
  event/event order and the active OS write are never preempted. This prevents
  bulk tool/stream output from starving lifecycle and persistence RPCs.
- Concurrent cold opens/preloads for the same session share one in-flight
  runtime creation. Slow SDK service initialization cannot build and replace
  duplicate contexts for a single session path.
- Tool-call lifecycle is monotonic in `LivePipelineState`: late progress/start envelopes cannot replace a durability-confirmed terminal or revive its tombstoned attempt. Stable parallel-group IDs, execution/sequence/phase commit metadata, and typed per-record bounded previews are carried by the canonical live record. Completed tool history may grow for the duration of a valid turn; safety is enforced by semantic payload compaction and total checkpoint bytes rather than an arbitrary completed-tool count. Supported semantic consumers skip legacy transcript `ToolCall`/terminal mutation while retaining analytics, file-change, and notice side effects. Raw/cyclic/BigInt SDK `onUpdate` values never cross into the host. Opaque transport-bound progress markers cannot replace an earlier
  renderable live result; cyclic/BigInt progress is converted to JSON-safe data
  while preserving subagent lifecycle details.
- Subagent progress is the exception to tail-only tool previews: while below the shared 32 MiB transport-record ceiling, it carries every child and the complete recursively renderable child transcript (reasoning, tool inputs/results, nested subagents, and reply text). The parent-facing terminal details persist the same transcript without lossy result compaction. Collapsed webview cards keep those bodies unmounted, expanded threads use bounded scrolling, and full recursive provider/nested-tool update bursts are coalesced to a trailing 20fps snapshot without dropping accumulated content, so rendering and serialization cost stay bounded without hiding information. Crossing the hard transport ceiling is surfaced as an explicit protocol/transport failure; it must never be presented as a plausible complete snippet.
- A subagent child's `exitCode` owns its running/terminal lifecycle;
  `runningTools` is activity detail only. Every terminal path clears live tool
  and streaming flags. Parent interruption is retained as `stopReason: aborted`
  and renders as `Interrupted`, distinct from a failed child. A failed parallel
  tool does not relabel siblings whose own child results completed.
- A retry that exceeds the backend's existing delay-plus-grace watchdog is
  terminalized automatically: all exposed billable windows are aborted, SDK
  teardown gets a bounded five-second grace, and the backend emits an
  interrupted message plus `busy=false`. `RETRY_STUCK` is therefore a terminal
  recovery event, never a warning that leaves the session busy indefinitely.

## Queued Follow-ups

- Sends accepted while a session is already running remain optimistic `queued` transcript messages until the backend reports delivery.
- While the current assistant turn is live, transcript projection places queued follow-ups after that turn, at the boundary where the backend will deliver them, rather than before the in-progress output.
- Delivery reconciliation is FIFO, matching the SDK's steering/follow-up queue order. Interrupt and queue-clear operations remove queued optimistic messages and their pending rollback snapshots.
- Queued follow-ups remain editable without interrupting or truncating the active turn. Because the SDK exposes only whole-queue clearing, an edit atomically replaces the ordered backend queue and preserves every message's local delivery correlation.
- Queued user rows do not own the current turn's pruning or activity state. Pending assistant/activity UI stays attached before the queued boundary until delivery.

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

**Timer ownership:** a send has phase-scoped timers, never racing. A short `RequestTracker` timeout owns the pre-ack (queue-time) RPC (`message.send` is sized ~10s in `RPC_TIMEOUTS_MS`); its rejection is the pre-ack failure window. One send-timer owns the post-ack-to-first-delta interval. It starts in the **prepass** phase; when the backend's explicit internal `preflight-succeeded` message arrives, `MarkPrepassSucceeded` replaces that timer with a fresh **model-start** budget. This boundary is also what makes timeout diagnosis truthful: the first phase reports pruning timeout, while the second reports model-start timeout. The timer is cleared at the commit point (first streaming `MessageStarted` for the `requestId` — where `handleMessageStarted` drops `pending.promoted[corrId]` and emits `ClearSendTimer`), and on fire it dispatches `PreflightFailed` *with `corrId`*. The pre-ack rejection also clears it, and `handlePreflightFailed` no-ops if `promoted` was already dropped, so a late fire cannot double-rollback. `edit` follows the same shape. Independently, the backend forwards the persisted pruning-result at `agent_start`, `turn_start`, or the first assistant `message_start` (whichever first observes it) using its stable session-entry id, with duplicate suppression for a later SDK `message_end/custom`. Thus timeout phase tracking does not depend on the summary, and the reply-header summary does not depend on an optional live custom-message event.

## Webview-Local State

The webview must not hold logic state in local `useState`/`useReducer`. Only the following ephemeral UI concerns are allowed as webview-local state:

- **contextMenu** — position and type of the currently open context menu (dismissed on click-outside/Escape)
- **peek / hover overlay** — transient overlay visibility for the changed-files rail (and analogous hover-peek surfaces), dismissed on mouse-leave / tap-outside / Escape. It is an overlay, not a layout push — it reserves no horizontal space; only an explicit pin (`ViewState.fileChangesExpanded`) durably reserves space. The moral equivalent of `contextMenu`.
- **scrollPosition / autoScroll** — viewport scroll tracking
- **input focus / caret position** — DOM focus state
- **drag state** — transient tab drag-and-drop position
- **animation / transition state** — CSS transition tracking
- **protocol-sync bookkeeping** — `lastRevisionRef`, `awaitingSnapshotRef`, `hostInstanceIdRef`, mounted-inline-prompt request counts (DOM-presence only; host pending requests remain authoritative), pending-draft-restore tracking, pending-composer-inputs-restore tracking (Brief C: a transient render override of `pendingComposerInputs` staged between a `sendRejected` imperative and the next confirming snapshot — the analog of draft-restore), in-flight `corrId` set for UI gating
- **derived UI telemetry** — FPS counters, render-timing buffers. (Token-rate measurement is no longer webview-local: it runs host-side in `TokenRateService`, which ticks every running session — including ones that are not the active/selected tab — using the transcripts the host already holds, and posts the per-session states as `ViewState.tokenRateBySession`. The webview just displays the active session's pre-computed state.)
- **per-keystroke draft buffer** inside an active input (the committed draft on blur/send/tab-switch is host state; the live keystroke buffer is not)
- **optimistic user message overlay** — pending user messages shown instantly before the host confirms them. The webview generates a `localId`, sends it with the `send` protocol message, and displays the message in the transcript immediately. When the host state arrives containing a message with that `localId`, the optimistic overlay entry is reconciled away. On `sendRejected`, the overlay entry is removed and the draft is restored.

All other state (editing, outcome dialogs, draft content, session selection, model settings, prefs) lives in the host store and reaches the webview via ViewState snapshots.

## Extension UI Requests

- Every pending interactive extension-UI request for the active session has an
  actionable surface. A tool/subagent-owned request renders inline when its
  exact prompt is mounted; otherwise a fixed fallback appears above the
  composer. Inline ownership alone is insufficient because the card can be
  collapsed, virtualized, delayed, or stale while the tab already signals that
  the session is waiting for input.
- Requests without an inline owner retain priority when several requests are
  pending; if all requests are inline-owned, the fixed fallback uses the oldest
  request whose exact inline prompt is not mounted. One visible sibling must
  not hide another collapsed/virtualized question.

## Notice Surfacing

- The host owns a single global notice triple in `settings`: `notice` (short, user-facing summary, `string | null`), `noticeKind` (Brief H failure category for recovery buttons, `NoticeKind | null`), and `noticeRaw` (the verbatim, unredacted backend error string, `string | null`).
- The short `notice` summary **never** contains internal `req-NN` correlation ids (Brief H criterion 1). `noticeRaw` **does** retain them verbatim so the webview can reveal the full error via a "show raw" affordance for debugging.
- Invariant: `noticeRaw` is non-null only when `notice` is an error notice (set at the send/edit/prepass error sites, `handleError`, and `revertSetModel`). Plain `NoticeShown` notices (info/warnings, including `notice: null` clears) always set `noticeRaw = null` so a stale "show raw" can't outlive its notice.
- `dismissNotice` clears all three together. A non-error `NoticeShown` clears `noticeKind` and `noticeRaw` together (a plain info banner carries no recovery actions and no raw detail).
- The projection surfaces all three as `ViewState.notice`, `ViewState.noticeKind`, and `ViewState.noticeRaw`. The webview's `NoticeBanner` renders the short summary, recovery action buttons (from `kind`), and — when `noticeRaw` differs from `notice` — a "Show raw" toggle that reveals the verbatim error in a scrollable monospaced block.
