# Architecture

## 1. System Overview

pie is a VS Code extension that provides a chat interface to a local PI (Programming Intelligence) backend. Five process roles cooperate in isolated mode:

- **PI coordinator** — a lightweight process communicating with the extension host over JSONL stdio. It owns cold durable browsing, settings/catalog authority, worker routing, and global provider-network admission; it never creates an `AgentSession` in isolated mode.
- **Cold browse helper** — one persistent, read-only child of the coordinator. It owns exact-v3 manager-free projection misses and their bounded in-memory LRU, returning only windowed public payloads; it never owns a write lease or `AgentSession`.
- **Root workers** — one process per hot root. Each owns exactly one SDK runtime/session context, extensions/tools, live event translation, extension UI bridge, and the root's sole write lease.
- **Extension host** — the VS Code extension process. Owns all application state, serializes mutations, and projects state to the webview.
- **Webview** — a Preact single-page app rendered in a VS Code sidebar panel. Displays the chat UI and dispatches user intents back to the host.

Isolated mode is the sole runtime path for every backend generation. The coordinator never creates an `AgentSession`; all hot session execution runs in per-root workers. There is no legacy in-process runtime and no runtime-mode flag — Git history is the rollback mechanism if a regression is discovered.

---

## Transport and Backend Lifecycle

Stdio uses UTF-8 JSONL with a shared **32 MiB per-record limit**, enough for a supported 10 MiB raw image after base64 encoding plus envelope headroom. Readers retain bounded memory, discard an overlong record through LF, and then recover. Oversized stdin requests receive a correlated `REQUEST_TOO_LARGE` response when their ID is present in the bounded preview; an oversized correlated response is replaced with `RESPONSE_TOO_LARGE`; an oversized critical event is fatal. Event producers therefore reserve two MiB of envelope headroom; durability-confirmed terminal tool side effects replace an otherwise-oversized result/input with an explicit bounded transport representation before entering the writer. Incremental session snapshots (`session.opened`, `session.preload`, and transcript pages) measure the complete final event/response JSONL envelope, including LF, against the 30 MiB producer budget before writer enqueue. If needed they first omit an oversized live checkpoint and restore the normalized durable projection, then remove whole transcript rows away from the pinned/requested edge while recomputing exact absolute window bounds. A required durable row is never byte-truncated: metadata plus a required single row that still cannot fit fails with `SESSION_SNAPSHOT_TOO_LARGE`. Correlated create/duplicate/truncate results are acknowledgement + `sessionPath` only; their authoritative state remains the ordered `session.opened` event. Backend stdout writes are serialized with bounded response/event lanes. Live protocol v7 tool progress uses a full initial preview followed by base-revision structural patches and carries backend-calculated canonical preview and complete-checkpoint byte metadata. The backend incrementally accounts the full active checkpoint (JSON escaping, text/reasoning parts, drafts, tool inputs/metadata/previews/terminal results, arrays, keys, and envelope syntax) and rejects an observation before it would exceed the 30 MiB checkpoint ceiling. The host validates and trusts that canonical checkpoint total on the progress hot path, so neither side reserializes an assembled multi-megabyte preview for each patch. A recovery RPC serializes exactly once and verifies the actual bytes do not exceed the cached conservative total. Only contiguous same-tool patch ranges may be composed while queued; their combined envelope retains the original base and newest sequence. Intervening lifecycle records prevent composition, terminals remain ordered and durable, and the host repairs any missing or incompatible range from the backend's bounded in-memory canonical checkpoint.

Session browsing is a durable-data path, not an execution-runtime path. One generation-scoped `ColdSessionStore`, installed after SDK loading, owns cold list/open/preload/page/detail/forget plus runtime-free create, duplicate, and idle truncate. It uses the SDK `SessionManager` for supported v1/v2→v3 migration and create/fork/tree/context semantics, and rechecks coordinator generation, path ownership, and file fingerprint at the final publication or write boundary. The coordinator-owned patch barrier adds fail-closed, versioned `SessionManager.create` and `SessionManager.open` seams. Create fsyncs and atomically publishes its own v3 header without replacing an existing destination before returning the same manager/path retained for handoff, and the create ledger cannot claim durability before that return. Open threads the entries it already parsed through the constructor into `setSessionFile`, removing the redundant second JSONL read while retaining that method's empty/invalid-file handling, migration, tree construction, and flushed-state semantics. Both transforms accept only exact pristine fingerprints or files that reverse exactly through the known transforms to those fingerprints; marker-preserving reorder or weakening fails startup closed. For an exact v3 cache miss, the persistent cold browse helper validates the coordinator's exact SDK patch identity, imports only cold SDK modules, and builds the immutable manager-free projection off the coordinator event loop. Its weighted LRU is keyed by canonical path, generation, ownership revision, and strong file fingerprint, retains at most four projections and 128 MiB of source weight (or one oversize current projection alone), and returns only bounded open/page/detail payloads—not the full projection—over correlated JSONL. The helper checks the exact fingerprint before open, after projection, and after building each response; the coordinator independently rechecks generation, ownership, canonical path, and fingerprint before stamping, publication, or rethrowing a typed producer error. v1/v2 migration, empty/malformed files, helper startup/crash/projection failure, tree/context, and every mutation retain the synchronous coordinator SDK path. A page whose required durable row cannot fit preserves `SESSION_SNAPSHOT_TOO_LARGE` without synchronously reopening the transcript. No transcript cache is written to disk; forget explicitly purges helper memory. The helper is eagerly warmed in production, remains lazy/restartable with bounded readiness/request waits, confirms actual exit after clean disposal, force-terminates a non-exiting child, watches parent liveness from before SDK import, and is absent from direct `BackendServer` test constructions unless explicitly configured. Review decoration, model settings, configured model catalogs, and the context-window denominator are applied afresh to each helper response. Replacement reservations use the same `ColdSessionLeaseAuthority` as coordinator cold operations: sorted canonical source/destination acquisition installs explicit one-use path tokens, invalidates existing stamps, and prevents new captures or cold commits until sorted release. During runtime transfer the source manager revokes its local lease before awaiting `commitTransfer`, so a failed/lost acknowledgement cannot reactivate source writes and enters fail-closed crash reconciliation. Cold payloads return `runtimeReady:false`; no cold route creates `AgentSessionServices`, loads extensions/resources, constructs an `AgentSession`, or subscribes to SDK events. For an empty session only, the coordinator may await a separate one-shot inventory child before publishing that cold payload. The child validates the coordinator's SDK patch identity, creates an in-memory SDK runtime, executes ordinary extension/resource discovery (including `resources_discover`), inventories the hot catalog's unfiltered `_originalSystemPromptOptions` plus `getAllTools()`, emits a token estimate, disposes, and exits without touching the durable session. A process-local deny boundary rejects outbound fetches and every turn-producing session method before `session_start`, while provider-catalog refresh handlers explicitly skip inventory mode. Any caught network attempt still invalidates the inventory rather than publishing a partial catalog. It is never used for internal promotion, promoted, retained, or cached; timeout/failure omits the estimate. A newly created/forked/truncated process-local manager and its creation reason remain retained through transactional promotion; they are retired only after worker runtime readiness, and failed promotion preserves exact-path retryability. Snapshot-known local tab changes remain visually synchronous and send a separate lightweight `session.viewed` RPC carrying the host-observed predecessor; that RPC reads no transcript and creates no runtime. Same-path selection is a no-op, and a monotonic view revision prevents an older asynchronous `session.open` from overwriting a newer local selection. The first execution mutation atomically promotes through the per-path single-flight owner, consumes one serialized cold grant, registers the worker's sole write lease, publishes a bounded `runtimeReady:true` metadata refresh before streaming, and then executes. Hot commands route by immutable root identity plus exact worker generation and current lease path/revision. SDK replacement reserve/commit/consume/abort/readiness frames atomically rekey the route while stale source writes and cross-session frames are rejected. Transfer consumption is coordinator-authoritative and exactly once: commit acknowledgement precedes a correlated consume acknowledgement, which precedes destination activation/write and runtime readiness; missing acknowledgement fails closed. Hot truncate publishes a transitioning fence before awaiting interrupt, so duplicate same-target truncates join and other commands receive `SESSION_TRANSITION_IN_PROGRESS` without reaching the old worker. The host separately tracks snapshot-known and runtime-ready paths, allowing warm local tab selection without hidden promotion; both sets reset with the backend generation. Cold-only send acknowledgement timeout expansion covers service initialization while retaining the short hot-send detector.

Helper transcript pages are fitted before IPC against the exact eventual response transport and pinned message; the request handler repeats the same fitter as an idempotent writer-boundary fence.

The transition fence has two non-conflicting exceptions. Runtime-free `session.viewed` notifications remain immediate while a hot truncate is replacing that session, and a concurrent public interrupt waits for the transition before targeting only its resulting current owner (or settles as an idle no-op if no hot owner remains). Host-side edit cancellation is permitted only before its destructive truncate request is issued; after that boundary, the session queue completes truncate plus send and then delivers the interrupt, so local rollback cannot diverge from a backend truncate that still commits. A local truncate deadline is therefore commit-ambiguous, not failure evidence: the host retains the exact request correlation, optimistic replacement, and queue owner until the late response confirms success or transport death, and never emits rollback after that boundary.

`ColdSessionStore` and `ColdSessionLeaseAuthority` remain **in the coordinator process**; only exact-v3 manager-free projection work moves to the helper. The coordinator imports the runtime-free `config`, `AuthStorage`, `ModelRegistry`, and `SessionManager` modules for fallback and mutation semantics, while the helper uses the worker-only validation branch and can never patch the shared SDK. Runtime workers load the full SDK only after promotion. Private runtime IPC v1 uses dedicated inherited directional descriptors and closed runtime/ownership/provider/sync frame families; the browse helper has a separate bounded correlated JSONL protocol whose results are independently fenced by coordinator authority. Provider admission and circuit state are coordinator-owned per provider: configured capacity updates in place, unrelated providers remain independent, failures from any worker contribute to one global circuit, and exactly one generation-owned half-open probe may run. Workers perform the HTTP request but acquire immediately at the fetch boundary, publish bounded status/classification observations, and retain the lease through response-body EOF/error/cancel or confirmed worker death; they do not install an independent per-process admission/circuit gate. Queued acquisition races the fetch `AbortSignal`; correlated `provider.cancel` removes the exact queued request or releases its just-granted lease once, preventing a settled interrupt from receiving a stale grant. Settings, configured catalog, auth fingerprints, runtime preferences, and provider policy use monotonic coordinator revisions and worker acknowledgements. Startup synchronization remains a fail-closed readiness fence. During a live turn, an acknowledgement deadline marks only that worker/domain revision as delayed: the coordinator preserves active work and retries the latest retained snapshot with bounded backoff. A timeout alone is never evidence of worker death; definite transport/protocol failure and confirmed process exit remain fail-closed. Extension-UI requests are registered against exact session/worker-generation/request lineage and settle once; stale, mismatched, duplicate, or crash-retired responses return a typed unavailable result without reaching a worker callback. Bounded checkpoints retain only execution identities, usage/durable watermarks, and the detail-subscription manifest needed for crash terminalization without replay. The perf harness measures cache-miss open and a concurrent public `app.ping`; helper acceptance is gated on keeping that ping snappy while retaining exact open/session semantics. The explicit `COLD_SESSION_STORE_PLACEMENT` constant and transport/fence tests prevent silent placement drift.

Provider queue, response-header, and body-idle phases are each finite and capped at five minutes; a configured queue value of zero selects that safety maximum. Provider rejection frames preserve retryability and HTTP status across the process boundary. Healthy completion may retain an owner-affine afterburn slot, while owner release, expiry, policy disable, or an open circuit clears it. Host and backend semantic timers defer only for the exact request currently queued or waiting on provider I/O, and a cumulative twenty-minute ceiling prevents unrelated provider activity from masking a stuck turn.

The complete open-tab registry is a host-authoritative worker-sync domain rather than a process-spawn environment snapshot. Each snapshot carries the current open summaries plus `pinned` and `isRunning`, advances a monotonic host source revision, and is retained behind a separate monotonic coordinator sync revision. Startup promotion applies and acknowledges the retained registry before runtime readiness. Later tab, pin, and accepted `busy.changed` transitions publish asynchronously to ready hot workers; starting workers catch up during startup, and a missed auxiliary registry acknowledgement keeps active work alive while the latest revision retries with bounded backoff. Workers mirror the accepted array to `PIE_OPEN_TABS` and its sync fence to `PIE_OPEN_TABS_REVISION` for extension compatibility. Host publication is latest-wins, structurally deduplicated, and retry-idempotent; only backend startup/replacement force-resends an unchanged source revision. Ownership and startup readiness fences remain fail-closed. Reloadable live-sync deadlines retain and retry the newest authoritative snapshot instead of retiring a session that may still be healthy.

Exact same-revision worker-sync retries are idempotent only when their bounded payload fingerprint matches the original apply; they join an in-flight apply or replay its acknowledgement. A changed payload at the same revision remains fatal. Reloadable settings/catalog/auth/runtime-policy broadcasts have a 30-second acknowledgement grace, while the open-tab registry uses a shorter detector. Every live-sync deadline is nonfatal and retries the latest retained snapshot with 1s/5s/15s/30s capped backoff; successful acknowledgement clears that worker/domain retry state.

Paged durable-detail subscription resolution remains a coordinator fallback and can still reopen a large cold transcript. It is intentionally outside the bounded open/page/detail helper protocol in this phase and remains a measured responsiveness follow-up.

Restored-session preloads run through a FIFO, single-flight background queue. No preload starts while a foreground create/open/duplicate lifecycle task is queued or in flight, or while any session is generating. If foreground work or generation begins after a preload was admitted, the host immediately fences its payload and cancels its local response waiter. The JSON-RPC transport has no request-cancellation frame, so cancellation cannot physically abort backend work already in progress (including runtime creation on a path that has already crossed that seam). The scheduler therefore retains the occupied background slot until the correlated response or backend shutdown settles it; this preserves maximum backend background concurrency of one before queued preloads can resume.

The host distinguishes intentional stops from unexpected, generation-tagged exits. Intentional stop during startup rejects that child’s readiness wait, and an old-generation exit cannot clear a replacement process. Unexpected exits terminalize orphaned in-flight state and preserve a classified interruption notice. There is no automatic backend restart; restart remains an explicit user action.

An explicit restart is a configuration commit boundary: the host projects backend unavailability first, drains model/reasoning/preference effects that were already accepted, closes coordinator stdin, and waits for accepted coordinator requests to settle before spawning the next generation. Settings updates use a PID-owned cross-process lock with dead-owner recovery, so forced termination cannot strand the replacement behind an orphaned lock.

### Computer-use runtime isolation

The generic `computer` pi extension adds a separate native sidecar boundary below the PI backend. Each durable pie session owns one lazy Node child that loads Cua Driver and NutJS and communicates through bounded JSONL; screenshots and sequence traces remain artifact files. Exact PID/HWND and foreground validation gates global physical input, while parent/child held-input ledgers provide cancellation, timeout, restart, close, and shutdown release barriers. The webview's ordinary tool-result renderer displays mixed text/image content; no computer-specific host state or transcript component is introduced. See [COMPUTER-USE.md](COMPUTER-USE.md) for the full contract and evidence.

### Playwright runtime isolation

The first-class `playwright` pi extension adds an independent rendered-page sidecar boundary below the PI backend. Each durable Pie session owns one lazy Node child, and each Playwright tool session owns one dedicated Playwright-pinned headless Chromium process plus an isolated primary `BrowserContext`. Bounded versioned JSONL carries requests and accessibility evidence; complete reduced snapshots, screenshots, downloads, oversized code results, and storage state remain session artifacts. Revision-scoped AI accessibility refs fail closed after any state-changing action, while parent deadlines, Windows process-tree termination, stdin/parent-liveness watching, explicit close, and `session_shutdown` prevent Chromium descendants from outliving their owner. The parent never imports Playwright or attaches to user browsers. Ordinary tool-result rendering and generic image-context projection require no Playwright-specific host state or transcript component. See [PLAYWRIGHT.md](PLAYWRIGHT.md) for the full behavior and evidence.

## 2. Architecture Pattern

The system follows a **CQRS/Elm-style MVI** pattern. User actions and backend events are unified into a single `Event` type processed by a pure reducer. The reducer returns updated state plus effect descriptors. An effect runner executes side effects (RPCs, persistence, logging) and feeds results back as events. The webview is a passive renderer of projected state — it never mutates logic state directly.

This pattern was chosen to eliminate the class of bugs caused by distributed mutable state across host and webview, ensure testability of all state transitions without I/O, and make streaming/optimistic-update interactions explicit and auditable.

See git history (commit `d581d83`) for historical context on the migration from Redux to this architecture.

---

## 3. Information Flow

```
                       ┌──────────────────────────────────────────┐
  Webview Command  ──► │                                         │
  Backend Event    ──► │   Reducer: (ArchState, Event)           │
  EffectResult     ──► │      → { archState', effects: Effect[] } │
  Timer Msg        ──► │   (pure — no I/O, no Redux)             │
                       └──────────┬───────────────────────────────┘
                                  │
                ┌─────────────────┴──────────────────┐
                │                                    │
                ▼                                    ▼
     Projection: ArchState → ViewState    EffectRunner executes:
                │                           - RPCs to PI backend
                ▼                           - File operations
       Per-session snapshot channel          - Notifications
                │                           - Analytics export
                ▼                           Results → Event
       Webview mirror[sessionPath]
                │
                ▼
       Render active session
```

**File locations:**

| Box | File |
|-----|------|
| Reducer | `extension/src/host/core/reducer.ts` |
| EffectRunner | `extension/src/host/core/effect-runner.ts` |
| Projection | `extension/src/host/core/projection.ts` |
| Snapshot transport | `extension/src/host/sidebar/sync.ts`, `extension/src/host/sidebar/provider.ts` |
| Backend event dispatch | `extension/src/host/core/event-dispatch.ts` |
| Message router | `extension/src/host/core/message-router.ts` |

---

## 4. Key Concepts

**Command** — an intent posted from the webview to the host. Carries `corrId` (correlation ID) and `sessionPath`. Defined in `extension/src/host/core/commands.ts`.

**Event** — any input to the reducer: a wrapped Command, a backend streaming event (delta, tool call, message finished), or an EffectResult. Defined in `extension/src/host/core/events.ts`.

**Effect** — a plain data descriptor of a side effect the reducer wants performed (e.g., `SendRpc`, `InterruptRpc`, `PersistTabs`). Never executed inside the reducer. Defined in `extension/src/host/core/effects.ts`.

**EffectRunner** — the single host-side executor of effects. Owns no state. Consumes effects, produces result events. Located at `extension/src/host/core/effect-runner.ts`.

**Projection** — the pure function `ArchState → ViewState` that computes what the webview should display. Located at `extension/src/host/core/projection.ts`.

**LivePipelineState** — the sole host authority for active assistant text/reasoning, tool drafts/executions/previews, producer phase, sequence/checkpoint state, and extension-UI ownership. Durable `ArchState.transcript` contains completed/interrupted history only.

**Snapshot** — a full compact `ViewState` used for normal rendering, initial load, and recovery. It projects durable history joined with `LivePipelineState`; no direct delta channel exists. Large tool/reasoning/subagent bodies are represented by retrieval metadata and delivered once, on explicit expansion, through a bounded detail-response path rather than repeated in snapshots.

**Mirror** — the webview-side cache of `ViewState` per session. Managed in `extension/src/webview/panel/hooks/use-host-sync.ts`.

**GlobalViewState / SessionViewState** — the ViewState is composed of global fields (session list, tabs, prefs) and per-session fields (transcript, busy, file changes). Both defined in `extension/src/shared/protocol.ts`.

---

## 5. Data Flow Scenarios

### User sends a message

1. Webview dispatches `{ type: 'send', sessionPath, text, localId }`.
2. For non-empty text or composer inputs, the host wraps it as a `Send` Command with a fresh `corrId` + local message ID.
3. Reducer inserts an optimistic user message into `state.pending[corrId]` and returns a `SendRpc` effect.
4. EffectRunner routes the RPC through the per-session operation queue.
5. On success: `SendResult` promotes the pending entry to authoritative.
6. On failure: reducer reverts via the snapshot in `state.pending[corrId]`.
7. An empty submit after an interrupted assistant tail is different: the host emits `Continue` → `ContinueRpc` → `message.continue`, adds no user row, and enters the SDK continuation lifecycle without `session.prompt()` or the `before_agent_start` skill-pruning prepass.

### Streaming assistant reply

1. Before the provider call, the backend creates an in-memory turn accumulator with opaque turn/attempt IDs and a monotonic sequence.
2. Provider transport observations classify gate queue, header wait, headers received, raw chunks, retry, tool work, and teardown. Raw chunks never renew the semantic inactivity lease.
3. SDK observations become typed `live.semantic` envelopes. Invalid observations consume a sequence as `observation.rejected`; concurrent tool-call start/delta/end observations retain bounded raw argument JSON as ordered keyed drafts until matching execution starts, and each tool input and progress/terminal preview is normalized to a bounded representation. There is no total tool-count limit: after durability is confirmed, the backend accumulator semantically compacts older settled-tool input/result payloads while retaining their lifecycle identity and a detailed recent tail.
4. The host validates each envelope and reduces it into `ArchState.livePipeline`. Gaps, rejected observations, unknown owners, and a missing final sequence request `liveTurn.checkpoint` through the EffectRunner. A compact repair checkpoint does not overwrite richer durability-confirmed tool details that the host already received, so normal rendering does not regress after repair.
5. Projection joins durable transcript rows with the active live turn, replaces large detail bodies with compact `LazyDetailRef` metadata, and posts a full `ViewState` through the one-post delivery controller. Expanding a detail deduplicates a bounded retrieval from the durable backend transcript or host-owned live state and sends the body once as an imperative response.
6. The webview reports receipt, app commit, signed transcript-leaf commit, and paint as separate protocol-v4 evidence.
7. SDK assistant/tool terminal callbacks are hot-patched to publish only after durable append returns a stable entry ID. The host then commits the durable terminal message and clears live state in one reducer transaction. A host-only, non-authoritative render identity carries the live row's canonical ID onto that durable projection so virtualized row and scroll identity survive even when the durable message ID differs; durable ownership and protocol evidence still use the real ID. Restart/reopen never replays a tool and normalizes dangling persisted work to interrupted.

### Tab switching

1. Webview dispatches `{ type: 'openSession', sessionPath }`.
2. The Command is dispatched to the reducer, which updates `ArchState.sessions.activePath`.
3. Projection produces a ViewState for the new active session.
4. Webview receives a snapshot for the new active session.

### Extension-driven transcript mutation (pruning)

1. Backend emits a custom message with `customType: "pruning-result"` and typed `customDetails`.
2. Reducer processes it as a `MessageFinished` event, updating `ArchState.transcript`.
3. Projection includes pruning data in ViewState; the webview renders the pruning banner from structured data (no regex parsing).

---

## 6. Boundaries and Contracts

### Host ↔ PI backend

- JSON-RPC over stdio. Request/response plus streaming event lines.
- Transcript snapshots serialize complete tool results once in ordered
  `ChatMessage.parts`. The legacy flat `toolCalls` mirror omits a result on the
  wire when the matching part already carries it; the host restores that mirror
  immediately after receipt. This is lossless and prevents nested subagent
  transcripts from being doubled by JSON serialization.
- Backend events carry `sessionPath` — missing `sessionPath` is a protocol defect.
- The host serializes all RPCs per session to prevent races.
- The host normalizes one absolute agent/session storage authority and supplies
  it through `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`; with neither
  configured, the embedded SDK keeps its own defaults. The session root's parent
  is the one machine-wide outcomes authority: reviews live in its
  `session-reviews/` sibling and workspace-sharded run stores are aggregated from
  that same root, never selected by cwd. The backend uses the canonical session
  root for create and fork, and listing reads it (plus its
  per-cwd subdirectories) exclusively — the legacy `<agentDir>/sessions` root is
  retired once a canonical root is configured. The installer performs a second
  idempotent outcomes merge after extension installation to capture writes from
  an old backend that retained its pre-migration process environment. Migration
  sources are registered as bounded receipts, and `npm run doctor` detects both
  newly stranded legacy sessions and post-migration outcomes writes instead of
  the runtime scanning legacy roots forever.
  Listing projects a path-deduplicated canonical inventory through a derived,
  versioned SQLite metadata sidecar adjacent to the session authority. Strong
  stat fingerprints identify unchanged files; append checkpoints plus bounded
  head/tail witnesses guard the ordinary SDK append path and let growing JSONL
  files resume metadata parsing without rescanning their established prefix.
  These samples are not a hash of the whole prefix: a same-inode interior
  rewrite followed by an append triggers a full reparse only when a sampled
  boundary changes. The transcript JSONL remains the source of truth, and
  corrupt/incompatible index data is discarded and rebuilt. This
  SQLite database is an operational point-lookup/upsert cache on the request
  path; DuckDB remains confined to the `analysis/` batch analytics workspace.
  Before an existing sidecar snapshot is projected, a coalesced filename-only
  directory scan (no transcript reads or stats) removes absent rows durably;
  changed files then reconcile in the background. This publication fence runs
  on every list so forgets and external deletions from another backend process
  cannot leak stale metadata, while an inaccessible root retains the last
  complete catalog. When a store has no snapshot, the first list waits for at
  least one newest file and otherwise caps its useful initial slice at 16 MiB
  or 24 files. Remaining work publishes in batches capped at 64 MiB or 128
  files, emitting catalog-change events after each durable batch. Live sessions
  and reviews are overlaid afresh. Missing roots count as empty, and an
  unavailable sidecar falls back to SDK discovery. Explicit resume/recovery
  paths remain migration-free.

### Host ↔ Webview

- Unidirectional state flow: host → webview via snapshots; webview → host via message commands.
- Ordered assistant `ChatMessage.parts` are authoritative on this boundary. If
  they contain tool calls, the host omits the redundant legacy `toolCalls`
  mirror from the renderer projection; legacy-only messages keep it.
- Streaming snapshots remain latest-wins full snapshots, with cadence backed
  off for very part-heavy transcripts so multi-megabyte state cannot monopolize
  Chromium's main thread.
- The transcript host/surface survives tab selection, but its session-owned
  virtualizer remounts at the new session's bottom. Completed tool cards older
  than the signed commit tail materialize near the viewport; live, queued, and
  signed-tail cards never defer. Explicit bottom jumps retain bounded scroll
  ownership through delayed row measurement and yield immediately to manual
  scrolling.
- Per-session revision counter detects missed snapshots; recovery is a full snapshot.
- `hostInstanceId` detects extension restarts; webview resets all mirrors on change.
- `WEBVIEW_PROTOCOL_VERSION` fails closed on incompatible host/webview wire shapes. State/hello and readiness handshakes also carry the deterministic compile-time `PIE_BUILD_ID`, but build identity is diagnostic only at runtime: same-protocol renderer assets remain usable with the running extension host, so active sessions continue until the user chooses to reload. Compile/validate emits coordinated host and renderer identities. Ordinary build/watch publication copies only the renderer into an immutable generation, verifies its manifest references, then atomically creates an append-only selection marker; the current and prior generations remain available. It never replaces installed host/backend/worker bundles or rewrites the installed extension manifest. Host/backend activation is an explicit command or install/reload boundary and refuses folder/manifest version skew.

See [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md) for the full invariant set.

---

## 7. State Ownership Rules

| Owner | What it holds |
|-------|--------------|
| **ArchState** (reducer) | All application state: sessions, transcripts, model settings, prefs, file changes, pending optimistic ops, UI logic state, interrupt-in-flight flags, backend event routing |
| **Webview** (local only) | Scroll position, focus/caret, hover, drag, animation, context menu position, protocol bookkeeping (revision refs), per-keystroke draft buffer |

**Rule of thumb:** if you're unsure whether something is host state or webview state, it's host state.

State-shape constraint: all keyed collections in host state use `Record<string, T>` — never `Map`/`Set`.

Full allowlist of webview-local state: see `STATE_CONTRACT.md § Webview-Local State`.

---

## 8. Extension Points

### Adding a new Command (user action)

1. Add variant to `extension/src/host/core/commands.ts`.
2. Add corresponding Event wrapper in `extension/src/host/core/events.ts`.
3. Handle in `extension/src/host/core/reducer.ts` — return state change + effects.
4. If an RPC is needed, add Effect variant in `extension/src/host/core/effects.ts`.
5. Add execution logic in `extension/src/host/core/effect-runner.ts`.
6. Wire the webview message → Command conversion in `extension/src/host/core/message-router.ts`.
7. Add reducer unit test in `extension/test/`.

### Adding a new backend event type

1. Add variant to `Event` union in `extension/src/host/core/events.ts`.
2. Handle in reducer — return state change + effects.
3. Wire the raw backend event → typed Event dispatch in `event-dispatch.ts`.
4. If the event requires a side-effect (RPC, notification, file operation), add an Effect variant.

### Adding a new ViewState field

1. Add to the `ViewState` interface in `extension/src/shared/protocol.ts`.
2. Populate in the projection function (`selectViewState`).
3. Consume in webview components.
4. Update test ViewState literals in `extension/test/host/sidebar/sidebar-sync.test.ts` and `extension/test/shared/protocol/sync-contract.test.ts`.

### Adding a new Effect type

Effects are grouped into namespaces (e.g., `SessionRpc`, `SessionLifecycle`, `FileOperation`, `PostImperative`). To add a new effect:

1. Add variant to the appropriate group in `extension/src/host/core/effects.ts` (or create a new group if it's a new category).
2. Add result Event variant to `extension/src/host/core/events.ts` (if the effect produces a result).
3. Add execution case in `extension/src/host/core/effect-runner.ts`.
4. Handle the result in the reducer.

---

## 9. Conserved Accounting

`StatsService` owns two correlated but separate persisted authorities. The append-only billable-invocation ledger records one immutable settlement for every observable provider call and supplies session usage/cost, aggregate usage/cost, and exports. Run analytics remain a compatibility dual-write and own productivity/outcome dimensions. `WorkingTimeService` projects the separately persisted run activity timeline; time is never inferred from tokens or cost.

Provider seams emit exact usage when available and explicit gap settlements otherwise. Ledger rows preserve provider-qualified model identity, source kind, session/branch and parent operation/run/tool correlation, outcome/timing, provider totals/reported cost, and an immutable pricing-catalog snapshot. Transcript-derived usage is accepted only for idempotent migration/rebuild. Private rows are memory-only and exports contain ordinary rows only. See [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md#conserved-billable-accounting).

## 10. Invariants

1. **Reducer purity** — `(State, Event) → { state, effects }`. No I/O, no `Date.now()`, no randomness.
2. **Single effect executor** — side effects only happen in the EffectRunner.
3. **Webview passivity** — the webview dispatches Commands and applies snapshots. It never mutates logic state.
4. **Session addressing** — every snapshot and session-scoped event carries `sessionPath`.
5. **Optimistic correlation** — pending ops are tagged with `corrId` and reconciled by `EffectResult`.
6. **Background preservation** — snapshots to non-active sessions update their mirrors; they are never dropped.
7. **Record-only state** — `Record<string, T>` for keyed collections (no Map/Set in host state).
8. **Serialized execution** — session RPCs are FIFO-ordered through the lifecycle + session queues.
9. **Accounting conservation** — one billable provider invocation maps to at most one immutable ledger row; missing usage is an explicit gap, never an inferred zero.

See [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md) for additional invariants (snapshot recovery, cleanup, selection ownership).

---

## 11. Module Map

| Directory | Responsibility |
|-----------|---------------|
| `extension/src/host/core/` | Pure CQRS spine: reducer, effects, events, commands, projection, dispatch |
| `extension/src/host/session-service/` | Backend client lifecycle, session startup, tab actions, message actions |
| `extension/src/host/sidebar/` | Webview provider, sync state machine, hot reload |
| `extension/src/host/stats-service/` | Run/activity analytics tracking, compatibility persistence, query |
| `extension/src/host/billable-invocation-ledger/` | Immutable provider-invocation persistence and session/aggregate/export projections |
| `extension/src/backend/` | JSON-RPC server, SDK abstraction, request routing, session context |
| `extension/src/webview/panel/` | Preact UI: transcript, composer, tabs, settings |
| `extension/src/shared/` | Protocol types, validation, cross-layer helpers |
| `extensions/` | Reusable pi plugins: ask-user, cwd-skills, safeguard, skill-pruner, subagent |

---

## 11. Further Reading

- [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md) — authoritative host ↔ webview invariants
- [`docs/internal/ARCH-OVERVIEW.md`](internal/ARCH-OVERVIEW.md) — concise file map and glossary
- [`AGENTS.md`](../AGENTS.md) — repo conventions, test commands, build instructions
- Git history (commit `d581d83`) — original migration plan
