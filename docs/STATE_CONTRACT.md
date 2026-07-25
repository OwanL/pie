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
- The short exit notice contains the interrupted-session count and reliable activity classification; credential-redacted stderr is exposed only as `noticeRaw` with `noticeKind: backend-exit`.

## Session Cleanup

- Closing an **idle** session or invalidating a session clears durable transcript cache, `LivePipelineState` turn/tool/pending-owner/tombstone state, alias state, current-turn correlation metadata, busy dedup state, pending composer inputs, and queued per-session operations.
- Closing a **running** session is a tab hide, not session cleanup. It removes and persists the tab selection only; live transcript/tool state, pending ownership, running markers, composer/file state, backend work, and current-run analytics remain recoverable. Repeated/stale close commands for an already-hidden tab are no-ops, and renderer close interactions carry a bounded interaction identity in addition to the existing view-generation fence.
- A webview ready handshake restores any running session absent from the persisted open-tab list to the visible tab strip. This repairs the incident case where a running tab was hidden before renderer reload without pretending that a full extension-host restart can preserve an in-process backend. Review-closure-hidden running tabs (closeReviewed/closeSelf) are excluded: their hide is a durable outbox action, not an accidental pre-reload hide, so the handshake must not resurrect them. The exclusion marker (`reviewClosedRunningPaths`) is host-owned, survives the webview reload boundary, and is pruned when the session is reopened or no longer running.
- V2 review closure actions are durable outbox commands, not review writes. `closeReviewed` is allowed for an already-reviewed running session (a tab hide) while evidence and review recording remain forbidden for running targets; `closureEligible` reflects this (non-self with a persisted canonical production review). An idle target reaches `succeeded` only after correlated close cleanup and tab persistence both succeed; a running target remains live and reaches `succeeded` after its tab-hide persistence succeeds. Failures append retryable state, and a crash before the fsynced terminal append leaves the prior pending/retrying action authoritative. A still-failing action becomes terminal `failed` after a bounded number of attempts (`MAX_CLOSURE_ATTEMPTS`); the durable `failed` status prevents reclaim on later refreshes, while a crash before the terminal append leaves the prior retrying record authoritative so crash reclaim/retry semantics are preserved.
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
- Ordinary state transport is snapshots-only. Full snapshots carry the complete compact `ViewState`; large tool results, recursive subagent transcripts, and reasoning bodies are represented by bounded `LazyDetailRef` metadata rather than inline content. A separate bounded detail-response imperative loads content from the durable backend transcript (or current host-owned live state): generic tool/reasoning bodies request it on expansion, while a mounted subagent requests it immediately because its collapsed state is itself the required child-transcript preview. A lazy subagent must render directly as that collapsed preview card and then toggle only between collapsed preview and expanded transcript; it must never first degrade to a generic tool row. Loading/failure/retry/unavailable/stale states are explicit; in-flight requests are deduplicated and loaded details use bounded 32-entry/64-MiB LRU caches on both sides. Detail subscriptions are key-scoped so one response does not re-render unrelated visible cards. Detail responses are not copied into every later full snapshot, and cache eviction/reload only requires re-fetching from the lossless durable source.
- When the view is hidden or not ready, the host marks globalDirty; the next flush emits a full snapshot.
- When visibility returns, the next host-to-webview sync is a full snapshot.
- The webview clears overlay/transient UI when the host instance changes or the active session changes.
- Active text, reasoning, reply model/reasoning-level metadata, tool-call drafts, typed bounded previews, tool lifecycle, producer phase, sequence, and extension-UI ownership live only in host `LivePipelineState`. `ArchState.transcript` is the durable history cache, not a second live authority. Projection purely joins the two.
- Agent reply headers derive the request time from the preceding delivered user message's `createdAt`; queued follow-ups do not take ownership until delivery. If that user message is outside the loaded transcript window, the header omits the request time rather than substituting the assistant start time.
- Backend semantic envelopes use live protocol **v5**, independently of the RPC transport wire version. They are monotonic per turn/attempt; version skew, missing, rejected, illegal-owner, or out-of-order events trigger rejection or the effect-owned `liveTurn.checkpoint` RPC. Tool progress establishes an initial JSON-safe preview snapshot and then carries restricted structural patches (`set`, `delete`, string append, and array append) with both turn `baseSeq`/`seq` and per-tool progress revisions. The backend retains the complete assembled canonical preview; identical cumulative SDK updates consume no sequence and emit nothing. The host applies a patch only to its declared base revision and otherwise enters gap reconciliation. Checkpoints are structurally validated, byte-bounded below the shared JSONL record ceiling, recovery-only, and in-memory; they contain the complete currently assembled live state and impose no total tool-count limit. Older durability-confirmed tool input/result payloads are semantically compacted in backend repair state while lifecycle identity and a detailed recent tail remain. Applying such a checkpoint preserves richer matching terminal details already held by the host. Terminal lifecycle watermarks expose a lost final event. Repeated repair failure interrupts locally and never replays tool execution.
- Tool and assistant terminal envelopes are withheld until the patched SDK append returns a stable session-entry ID. Aggregate completed-tool count or payload size does not abort a healthy turn; individual semantic records remain bounded. The reducer atomically appends the durability-confirmed terminal message and removes its live turn/tools. A fresh session branch wins on reopen; dangling persisted work is shown as interrupted.
- A busy `session.opened` refresh may update tab/session metadata and durable paging state, but it cannot erase the separately-owned active live turn. Webview reload also restores that host state through the next full snapshot.
- The delivery controller retains one unsettled post and at most one accepted-but-uncommitted revision. New host state is lazily coalesced behind that commit gate, because `webview.postMessage()` acceptance does not prove Chromium consumed or rendered the snapshot; allowing streaming posts to outrun transcript commits creates a stale renderer queue that catches up only after the agent stops. Settlement and commit are timed independently. A post-settlement timeout retires its posted revision before retry, just as commit-timeout recovery retires accepted revisions, so late `stateReceived`, `appCommitted`, `transcriptCommitted`, and paint evidence is stale telemetry rather than a future/unaccepted protocol defect. Recovery resnapshots the latest desired state before bounded reload escalation. Reload does not discard host-owned live work.
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
- Tool-call lifecycle is monotonic in `LivePipelineState`: late progress/start envelopes cannot replace a durability-confirmed terminal or revive its tombstoned attempt. Stable parallel-group IDs, execution/sequence/phase commit metadata, and typed per-record bounded previews are carried by the canonical live record. The backend carries its canonical `previewBytes` and aggregate byte count on progress envelopes; the host stores per-execution and per-turn cached counts, validates arithmetic/bounds, and updates only the changed execution. Structural patches never stringify the reconstructed accumulated preview merely to enforce aggregate capacity. Checkpoint validation may recompute all bytes once because it is recovery-only, and rebuilds trustworthy counters before queued envelope replay. Completed tool history may grow for the duration of a valid turn; safety is enforced by semantic payload compaction and total checkpoint bytes rather than an arbitrary completed-tool count. Supported semantic consumers skip legacy transcript `ToolCall`/terminal mutation while retaining analytics, file-change, and notice side effects. Raw/cyclic/BigInt SDK `onUpdate` values never cross into the host. Opaque transport-bound progress markers cannot replace an earlier
  renderable live result; cyclic/BigInt progress is converted to JSON-safe data
  while preserving subagent lifecycle details.
- Subagent progress is the exception to tail-only tool previews: while below the shared 32 MiB transport-record ceiling, the backend canonical state retains every child and the complete recursively renderable child transcript (reasoning, tool inputs/results, nested subagents, reply text, lifecycle, usage, and accounting metadata). Only the first progress record normally transports that complete snapshot; later records transport structural changes, including appended streamed text/reasoning and nested message/tool-result mutations. Raw cyclic, BigInt, non-finite, function, symbol, or throwing SDK values are converted to explicit JSON-safe representations before diffing. The parent-facing terminal details persist the same transcript without lossy result compaction. Collapsed webview cards keep those bodies unmounted and expanded threads continue to render the host-assembled recursive transcript. Under blocked stdout, only contiguous same-tool v5 progress ranges may be composed into one equivalent patch; control/lifecycle records remain FIFO, terminal records remain durable and ordered, and no patch may skip an intervening lifecycle record. Crossing the hard transport ceiling is surfaced as an explicit protocol/transport failure; it must never be presented as a plausible complete snippet.
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
- Backend events arriving before `SendRpcResult` are applied normally — the pending user message is already in the transcript, so assistant deltas append after it. A first `MessageStarted` / applied `turn.started` before the acknowledgement commits the oldest non-queued `pending.ops` owner for that session and clears its send timer; the later acknowledgement is a no-op. A correlated `MessageFinished` / `MessageAborted` that is the first observable terminal boundary settles the operation and timer the same way, without rolling back the persisted user message. Session mutation FIFO makes this early-boundary fallback unambiguous.

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
> it (restores from `pending.ops[corrId].inputs`). When the rejected session is
> active, the webview stages the imperative's `inputs` as a transient override
> of `pendingComposerInputs` until the next snapshot confirms. A background
> rejection must not project those inputs into the active composer; its
> host-owned per-session inputs appear when that session becomes active. The
> subsection below describes the full state.

`message.send` will resolve as soon as the prompt is *queued* (before the pruning prepass), so an optimistic send will have two failure windows, not one:

1. **Pre-ack failure** — the `message.send` RPC itself rejects. Revert via `state.pending.ops[corrId]`, exactly as the legacy contract describes. `SendResult{ok:false}` is the trigger.
2. **Post-ack, pre-commit failure** — the RPC succeeded but the prepass then fails. The trigger is a dedicated `PreflightFailed{corrId, sessionPath, requestId, error}` event, **not** a reused `SendResult{ok:false}` (the RPC genuinely succeeded; the prepass is a distinct phase). On `SendResult{ok:true}` the rollback snapshot is **not** deleted — it moves from `state.pending.ops[corrId]` to `state.pending.promoted[corrId]`, which retains the snapshot and composer-input restore payload until the turn commits.

**Commit point:** a promoted send commits at the **first streaming event** (`MessageStarted`/first `Delta`) for its `requestId`. At that point `pending.promoted[corrId]` is dropped and a later prepass/turn failure becomes an in-turn error (surfaced by the error mapper), never a rollback. This bounds the rollback window so a flaky prepass cannot yank a turn the user has already watched start streaming.

A post-ack, pre-commit `PreflightFailed` must: remove the optimistic transcript entry by `pending.promoted[corrId].localId`, restore `pending.promoted[corrId].previousSummary`, restore `pendingComposerInputsBySession[sessionPath]` from `pending.promoted[corrId].inputs`, clear `pending.requestIdToLocalId[requestId]`, fire a `sendRejected` imperative (carrying `inputs`), and surface a plain-language error.

**Timer ownership:** a send has phase-scoped timers, never racing. A short `RequestTracker` timeout owns the pre-ack (queue-time) RPC (`message.send` is sized ~10s in `RPC_TIMEOUTS_MS`); its rejection is the pre-ack failure window. One send-timer owns the post-ack-to-first-delta interval. It starts in the **prepass** phase; when the backend's explicit internal `preflight-succeeded` message arrives, `MarkPrepassSucceeded` replaces that timer with a fresh **model-start** budget. The signal is allowed to cross stdio before the RPC acknowledgement when every hook returns synchronously (notably when skill pruning is disabled or has no candidates): the reducer associates it with the oldest non-queued `pending.ops` entry for that session, and `SendResult`/`EditResult` preserve the already-succeeded phase while promoting the op. A backend `preflight.failed` event has the same pre-ack ordering allowance and rolls back that pending op; its later RPC acknowledgement is a no-op. This boundary is also what makes timeout diagnosis truthful: the first phase reports pruning timeout, while the second reports model-start timeout. The timer is cleared at the commit point (first streaming `MessageStarted` for the `requestId` — where `handleMessageStarted` drops `pending.promoted[corrId]` and emits `ClearSendTimer`), and on fire it dispatches `PreflightFailed` *with `corrId`*. The pre-ack rejection also clears it, and `handlePreflightFailed` no-ops if the owning pending/promoted entry was already dropped, so a late fire cannot double-rollback. `edit` follows the same shape. Independently, the backend forwards the persisted pruning-result at `agent_start`, `turn_start`, or the first assistant `message_start` (whichever first observes it) using its stable session-entry id, with duplicate suppression for a later SDK `message_end/custom`. Thus timeout phase tracking does not depend on the summary, and the reply-header summary does not depend on an optional live custom-message event.

## Webview-Local State

The webview must not hold logic state in local `useState`/`useReducer`. Only the following ephemeral UI concerns are allowed as webview-local state:

- **contextMenu** — position and type of the currently open context menu (dismissed on click-outside/Escape)
- **peek / hover overlay** — transient overlay visibility for the changed-files rail (and analogous hover-peek surfaces), dismissed on mouse-leave / tap-outside / Escape. It is an overlay, not a layout push — it reserves no horizontal space; only an explicit pin (`ViewState.fileChangesExpanded`) durably reserves space. The moral equivalent of `contextMenu`.
- **scrollPosition / autoScroll** — viewport scroll tracking
- **input focus / caret position** — DOM focus state
- **drag state** — transient tab drag-and-drop position
- **animation / transition state** — CSS transition tracking
- **protocol-sync bookkeeping** — `lastRevisionRef`, `awaitingSnapshotRef`, `hostInstanceIdRef`, mounted-inline-prompt request counts (DOM-presence only; host pending requests remain authoritative), pending-draft-restore tracking (keyed by session; it survives same-host tab switches and is cleared on host replacement), pending-composer-inputs-restore tracking (Brief C: for the active session only, a transient render override of `pendingComposerInputs` staged between a `sendRejected` imperative and the next confirming snapshot — the analog of draft-restore), in-flight `corrId` set for UI gating, and the bounded ephemeral cache of explicitly fetched lazy details (durable/live source remains authoritative; cache loss triggers re-fetch)
- **derived UI telemetry** — FPS counters, render-timing buffers. (Token-rate measurement is no longer webview-local: it runs host-side in `TokenRateService`, which ticks every running session — including ones that are not the active/selected tab — using the transcripts the host already holds, and posts the per-session states as `ViewState.tokenRateBySession`. The webview just displays the active session's pre-computed state.)
- **per-keystroke draft buffer** inside an active input (the committed draft on blur/send/tab-switch is host state; the live keystroke buffer is not)
- **optimistic user message overlay** — pending user messages shown instantly before the host confirms them. The webview generates a `localId`, sends it with the `send` protocol message, and displays the message in the transcript immediately. When the host state arrives containing a message with that `localId`, the optimistic overlay entry is reconciled away. On `sendRejected`, the overlay entry is removed and the draft is restored.

All other state (editing, draft content, session selection, model settings, prefs) lives in the host store and reaches the webview via ViewState snapshots.

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

- The host owns a single global notice triple in `settings`: `notice` (short, user-facing summary, `string | null`), `noticeKind` (Brief H failure category for recovery buttons, `NoticeKind | null`), and `noticeRaw` (the full host-side backend error string, `string | null`).
- The short `notice` summary **never** contains internal `req-NN` correlation ids (Brief H criterion 1). Projection retains those ids in `noticeRaw` but redacts credentials before the webview boundary, so "show raw" remains useful without exposing secrets.
- Invariant: `noticeRaw` is non-null only when `notice` is an error notice (set at the send/edit/prepass error sites, `handleError`, and `revertSetModel`). Plain `NoticeShown` notices (info/warnings, including `notice: null` clears) always set `noticeRaw = null` so a stale "show raw" can't outlive its notice.
- `dismissNotice` clears all three together. A non-error `NoticeShown` clears `noticeKind` and `noticeRaw` together (a plain info banner carries no recovery actions and no raw detail).
- Backend `operational-error` events retain their stable code, request correlation, and optional root-cause `detail` in `noticeRaw`; only the plain-language `message` becomes the short notice. Provider semantic-inactivity timeouts include provider/model, the elapsed inactivity threshold, what semantic signals were absent, and the last SDK provider/retry error when one was observed. If no provider error event preceded the silence, the detail says so rather than inventing a cause.
- The projection surfaces all three as `ViewState.notice`, `ViewState.noticeKind`, and credential-redacted `ViewState.noticeRaw`. The webview's `NoticeBanner` renders the short summary, recovery action buttons (from `kind`), and — when `noticeRaw` differs from `notice` — a "More" toggle that reveals the sanitized diagnostic in a scrollable monospaced block.
