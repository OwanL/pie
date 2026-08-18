# Session runtime isolation implementation plan

**Status:** Active — Phases 0–6 implemented; Phase 7 is at staged default-on with the bounded legacy rollback seam retained
**Priority:** P0 liveness and correctness  
**Scope:** `extension/src/backend/`, host/backend reconciliation, lazy subagent detail delivery, and deterministic integration tests  
**Out of scope for this document:** production implementation

## 1. Purpose and incident statement

This is an implementation-agent handoff for eliminating a backend-wide liveness failure without degrading the current subagent experience.

Locally observed diagnostic evidence (not repository-pinned test evidence; no durable incident artifact is currently linked):

- one backend Node event loop stopped dispatching all control RPCs for roughly 220 seconds, from 20:36:08 to 20:39:48;
- once dispatch resumed, queued handlers completed in approximately 26–110 ms, indicating that handler work was not itself responsible for most of the elapsed time;
- the outage ended while an in-process subagent held about 143 messages and 7.1 MiB of recursively nested details;
- the current hot path can repeatedly clone, normalize, compare/diff, measure, and serialize complete recursive subagent progress, at update rates up to 20 Hz;
- SDK/resource/extension initialization also performs separate synchronous work that can block the event loop for several seconds.

These facts make synchronous event-loop starvation the primary failure mode to prove or disprove. They do not, by themselves, prove that one exact clone/diff/serialization call caused the entire 220-second interval. Instrumentation and a spawned-process reproducer must establish phase ownership before optimization claims are made. The exact timestamps, counts, and sizes above remain local diagnostic observations until a machine-readable trace is committed or linked.

The existing cold-browsing path, lazy runtime promotion, service-loading gate, bounded snapshots, and response-priority JSONL writer are valuable containment. Retain them. None can dispatch a ping while the one process that owns them is synchronously blocked, so they are not the root isolation boundary.

## 2. Required outcome

Split the current backend into two roles:

1. A **lightweight coordinator process** owns the existing host-facing JSONL control plane, cold durable browsing, session/catalog/settings/model metadata, worker supervision, provider-wide admission/circuits, and event forwarding.
2. Each **hot root session** gets its own process-isolated worker. That worker owns the Pi SDK runtime, resource and extension loading, provider/tool execution, nested subagents, and all writes to that root's live session file.

Cold `session.create` and `session.open` do not create an execution runtime or hot worker. The first execution operation promotes the root session. A synchronous extension, SDK initializer, provider callback, tool, or recursive subagent hot path in session A may freeze A's worker, but it must not prevent the coordinator from answering `app.ping`, cold-browsing session B, or serving settings/models metadata.

The extension host remains CQRS/Elm-style MVI: the reducer stays pure, effects stay in `EffectRunner`, and the webview remains passive. The host-facing JSONL envelope and existing RPC/event names remain compatible. The live-detail additions are closed, typed, and protocol-versioned; existing methods are not renamed or reinterpreted.

## 3. Non-negotiable UX contract

Process isolation is not permission to make nested subagents summary-only.

### 3.1 Collapsed card

A collapsed subagent card continues to show a bounded live projection:

- child lifecycle/status;
- current phase and activity;
- model/provider where currently shown;
- bounded reasoning/text/output tail;
- nested running/completed counts and usage/accounting metadata needed by today's card;
- explicit indication when a longer output is available.

This compact projection may omit long bodies, but omitted content remains retrievable. A collapsed compact preview needs no detail subscription. Ordinary `ViewState`, `live.semantic`, control responses, and worker heartbeats must not repeatedly carry the recursive child transcript.

### 3.2 Expanded card

Explicit expansion subscribes to the **complete child transcript**, not a summary:

- the initial state is a bounded baseline or a paged baseline;
- every child message is available;
- live reasoning and assistant text append as they happen;
- tool input, progress, and output update as they happen;
- nested subagents remain recursively expandable and live;
- long outputs are paged/chunked losslessly rather than replaced by a plausible-looking snippet;
- terminal detail is exact and durable.

The renderer must show explicit `loading`, `retry`, `stale/rebasing`, and `unavailable` states. It must never silently substitute a summary for a failed detail load.

### 3.3 Contract supersession and collapse/re-expand

Phase 5 **superseded**, rather than added to, the former `docs/STATE_CONTRACT.md` rule that a mounted collapsed subagent requests full detail immediately. The implemented contract is: a collapsed card renders only its bounded compact preview with no detail subscription; only explicit expansion subscribes to complete detail. The authoritative contract, `sync-contract.test.ts`, lazy-detail routing, webview mount/expand/collapse behavior, and no-subscriber traffic tests now enforce that rule.

Collapsing a card:

- sends an unsubscribe;
- unmounts/discards the heavy body and its incremental patch state;
- retains only the compact card and cheap identity/revision metadata;
- does not cancel the subagent or an extension-UI question it owns.

Re-expanding starts from a current baseline plus ordered deltas. It does not replay every historical live update through `ViewState`.

### 3.4 Extension UI ownership

Nested `ask_user` and other extension-UI requests keep today's ownership semantics. The worker emits the exact root session, parent tool call, subagent call, and nested tool ownership independently of whether detail is expanded. If the exact inline prompt is not mounted because a card is collapsed, virtualized, loading, stale, or unavailable, the host-owned fallback above the composer remains actionable. A response is routed back to exactly one live worker generation and settled exactly once.

## 4. Retained, superseded, and non-goals

### Retain

- cold session browsing and paging without `AgentSessionServices`;
- first-execution lazy promotion;
- the service-loading admission gate, moved to worker-bootstrap supervision rather than used as a claim of liveness isolation;
- the 32 MiB JSONL record ceiling, 30 MiB producer budget, bounded snapshots, recovery checkpoints, and response-priority writer;
- current per-session mutation FIFO and lifecycle ordering guarantees;
- durability-before-terminal publication and lossless durable transcript detail;
- host `ArchState`/reducer/effect/projection ownership and webview snapshot recovery;
- provider circuit/admission semantics and extension-UI fallback behavior.

### Supersede

- `BackendServer` as both control plane and owner of every hot runtime;
- loading the full SDK/resource/extension stack on the coordinator event loop;
- carrying complete recursive subagent details through ordinary live snapshots/checkpoints at up to 20 Hz;
- treating settings and model-catalog hydration as one all-or-nothing `Promise.all` result;
- hydrating a host-only `__pending__:*` path;
- allowing stale hydration to race and overwrite an optimistic `SetModel`;
- emitting both a correlated RPC error response and a duplicate public generic error event for the same failure;
- deleting/rolling back a pending create tab merely because the local RPC waiter timed out while backend work can still succeed;
- renderer-ready recovery that reopens an intentionally user-hidden running tab. Review-closure hiding remains intentional too, but is no longer the only intentional-hide case.

### Non-goals

- per-child subagent processes in this project phase;
- replaying an interrupted provider/tool side effect after a worker crash;
- changing the public webview into a second state owner;
- replacing JSONL with a distributed messaging system;
- removing byte limits or retaining unbounded expanded bodies after collapse;
- choosing an arbitrary fixed maximum worker count;
- silently evicting a busy root session to make room for another;
- optimizing every synchronous SDK initialization path before isolation is proven;
- changing model/provider/cost/privacy policy during recovery.

Per-root worker isolation is the required architecture now. Per-child process isolation is a future option only if measurements show that a nested child must be isolated from its own root. Nested children may initially remain in the root worker, but the full-state 20 Hz amplification must still be removed.

## 5. Evidence-first instrumentation and failing test

### 5.1 First implementation commit: two spawned-backend liveness tests

Add a real spawned-process integration harness before moving code. Do not use an in-memory `BackendServer` test for either acceptance claim; an in-memory test shares the test runner's event loop and cannot prove process isolation.

Likely files:

- new `extension/test/backend/runtime/backend-session-worker-liveness.test.ts`;
- two blocking extension fixtures under `extension/test/fixtures/`, or a temporary `PI_CODING_AGENT_DIR` assembled by the test;
- extend `extension/test/fixtures/mock-backend.mjs` only for host reconciliation tests, not for process-isolation proof;
- reuse process startup helpers from `extension/test/backend/runtime/backend-request-handler.test.ts`, `backend-service-loading-gate.test.ts`, and `backend-cold-session-browse.test.ts` where practical.

Create two independent spawned scenarios:

1. an extension blocks synchronously in a session-A execution hook;
2. a separate extension blocks synchronously in its factory/resource bootstrap while A's worker is being promoted.

Each fixture synchronously writes an `entered` marker, then blocks while polling an externally controlled `release` marker, with a generous finite safety deadline that fails the fixture rather than hanging CI forever. The test owns the release marker and creates it in `finally`, including assertion-failure and teardown paths. Do not use a fixed-duration sleep as the release mechanism.

For each scenario:

1. Spawn the backend/coordinator with two durable sessions and enable the relevant blocking fixture only in A's worker.
2. Trigger A execution/promotion and wait until the external `entered` marker proves the synchronous block is active.
3. While the marker remains unreleased, concurrently issue:
   - `app.ping`;
   - cold `session.open` or transcript-page access for session B;
   - `settings.get`;
   - `models.list` for stable session B.
4. Record receipt of every response, assert all were received while the release marker was still absent, and only then release A in the test's `finally` cleanup.
5. Assert A eventually continues or is interruptible, and clean up the complete spawned process tree.

This is causal responses-before-release evidence, not a tight duration benchmark; use generous safety deadlines for Windows CI. Both desired assertions must fail against the legacy monolithic backend. Preserve that evidence in the PR history and trace artifact. If the harness lands before isolation, quarantine only with explicit known-failure markers and issue/phase references; do not weaken ordering. Remove both markers when the worker path lands.

### 5.2 Instrumentation contract

Instrumentation must be metadata-only, bounded, disabled or sampled in ordinary use, and must not stringify the recursive body merely to measure it.

Add/extend traces in these components:

- `extension/src/backend/index.ts` and `server.ts`: process start/readiness and coordinator event-loop delay;
- `extension/src/backend/request-handler.ts`: request received, validation complete, route selected, queued, handler start, handler finish/error;
- `extension/src/backend/server-io.ts`: lane, queue depth/bytes, oldest age, enqueue-to-write duration, active-write duration;
- `extension/src/backend/runtime-factory.ts`: SDK import, service/resource/extension loading, session construction, subscriptions, prompt rebuild/guard installation;
- `extension/src/backend/session-event-handler.ts`, `live-turn-accumulator.ts`, and `tool-progress-normalizer.ts`: SDK observation to canonical live event;
- `extensions/subagent/runner.ts` and `extensions/subagent/src/execute.ts`: source update, dedupe, clone/normalization, recursive traversal, diff/patch, measurement, terminal handoff;
- coordinator/worker IPC modules introduced below: frame enqueue/read/write, worker heartbeat, generation drop, backpressure, and restart.

Required fields, where applicable:

- process role, PID, coordinator generation, worker ID/generation;
- session/turn/tool/attempt/request correlation IDs;
- phase and monotonic sequence/revision;
- event-loop delay histogram/maximum and interval drift;
- queue depth, queued bytes, oldest frame age, writer lane;
- child count, message count, maximum recursive depth, and already-maintained byte counters;
- source payload bytes and produced compact/detail-delta bytes;
- sampled phase durations for clone, JSON-safe normalization, recursive projection, diff, measure, serialize, and write;
- detail subscriber count and whether a baseline, page, delta, rebase, or terminal handoff was sent.

Do not log prompts, reasoning, tool inputs/results, auth material, or full recursive objects. For hot-path timing, use counters maintained during normalization and sampled serialization; an instrumentation call that performs an extra 7 MiB `JSON.stringify` invalidates the measurement.

### 5.3 Evidence output

The reproducer should emit one machine-readable timeline that can answer:

- Was the coordinator event loop responsive while A's worker was blocked?
- Which synchronous phase owned A's stall?
- Were host response writes queued behind another response, an event, or an active OS write?
- How many recursive bytes were processed per source update, compact event, detail baseline/page, and terminal append?
- Did the subagent producer generate real semantic changes, or duplicate updates?

## 6. Independent correctness fixes

These fixes do not depend on process isolation and should land first in small PRs. Their tests remain valid under both legacy and worker modes.

### 6.1 Pending picker and hydration

Likely files:

- `extension/src/shared/tab-behavior.ts`;
- `extension/src/host/core/message-router.ts`;
- `extension/src/host/core/reducer/command-model-handlers.ts`;
- `extension/src/host/core/reducer/set-model-handlers.ts`;
- `extension/src/host/core/reducer/session-handlers.ts`;
- `extension/src/host/session-service/message-actions.ts`;
- `extension/src/shared/protocol/models.ts` and `sessions.ts`;
- `extension/test/host/core/state/hydrate-model-state.test.ts`;
- `extension/test/host/core/architecture/arch-set-model.test.ts`;
- webview model-picker tests under `extension/test/webview/composer/`.

Contract:

1. Never issue `models.list` or model hydration for `__pending__:*`, including normalized pseudo-path variants recognized by `isPendingTabPath`.
2. When create/duplicate opens a pending picker, seed it from the configured catalog cache or the real predecessor session's last-known catalog. Carry the selected model's last-known reasoning capability/levels forward while target metadata is loading.
3. Mark this picker data `provisional/loading`; do not clear it to an empty catalog merely because the target path is unresolved or one hydration branch failed.
4. Transfer the provisional catalog/capability cache when `PendingPathReplaced` resolves the durable path, then replace it only with a successful authoritative catalog response.
5. Start `settings.get` and stable-path `models.list` independently and settle them independently (`Promise.allSettled` or equivalent effect results). A settings failure must not suppress a valid catalog; a catalog failure must not suppress valid settings.
6. Deduplicate concurrent hydration per `{backendGeneration, stableSessionPath}`. Focus/visibility chatter joins the same in-flight work.
7. Every hydration result carries the generation/revision captured when it started. `SetModel` advances a model-write fence before optimistic apply. A result older than that fence cannot change global settings, the session badge, known reasoning capability, or picker selection. A newer explicit refresh may still update the catalog independently.

### 6.2 Correlated RPC errors are single-surfaced

Current `BackendServer.handleLine` writes a correlated error response and then emits a public `error` event. Make ownership explicit:

- a handler throw for request `id` produces one correlated error response, structured stderr/trace diagnostics, and no duplicate generic public error event;
- a later asynchronous incident may emit `operational-error`, but it must have its own incident identity and must not repeat the already-settled request failure;
- the host defensively deduplicates public notice/analytics ownership by backend generation plus request/incident identity;
- exactly one user notice and one failure analytics record result from one correlated RPC failure.

Likely files/tests:

- `extension/src/backend/server.ts`, `server-io.ts`;
- `extension/src/host/backend/client.ts`;
- `extension/src/host/core/event-dispatch.ts` and notice handlers;
- `extension/test/backend/runtime/backend-error-codes.test.ts`;
- `extension/test/host/backend/backend-client.test.ts`;
- reducer notice tests.

### 6.3 Idempotent create timeout and late success

Treat local request timeout as loss of timely acknowledgement, not proof that creation stopped.

Introduce a host-generated create operation identity that is stable across retries. Keep an operation ledger with states equivalent to:

```text
pending → delayed-awaiting-outcome → succeeded(path) | failed
```

Contract:

- the pending tab remains visible with delayed/retry state when the local waiter times out; do not delete it while backend work can still commit;
- retry uses the same operation identity and cannot create a second durable session;
- `session.opened` with the matching selection token/operation identity reconciles late success idempotently, replaces the pending path once, drains queued sends once, and applies current selection ownership rules;
- a duplicate/late RPC acknowledgement after `session.opened` is a no-op;
- if the user intentionally hides the delayed pending tab, late success resolves the hidden operation without stealing focus or reopening it;
- only a definitive backend failure or backend-generation death permits rollback/failed UI; cleanup is scoped to that one create;
- coordinator-side create dedupe retains in-flight and completed results for the backend generation. Durable creation itself must be atomic enough that a retry can identify the already-created session.

Likely files/tests:

- `extension/src/host/core/arch-state.ts`, `events.ts`, `effects.ts`;
- `extension/src/host/core/effect-runner.ts`;
- `extension/src/host/core/reducer/command-session-handlers.ts` and result/session handlers;
- `extension/src/host/session-service/state.ts`, `tab-actions.ts`, and `handlers/attach.ts`;
- `extension/src/backend/rpc.ts`, `request-handler.ts`, and coordinator create ledger;
- `extension/test/host/core/architecture/arch-create-session.test.ts`;
- `extension/test/host/core/lifecycle/create-session-ordering.test.ts`;
- `extension/test/backend/sessions/session-opened-reconciliation.test.ts`.

The operation identity can be an additive optional field during compatibility rollout. Do not rename `session.create`, `session.opened`, or the existing acknowledgement shape.

### 6.4 Intentional hidden running tabs

Current ready handling restores ordinary hidden running tabs and excludes only review-closure hides. Replace that distinction with explicit hide intent.

Contract:

- closing a running tab remains a hide, not runtime cleanup;
- a user hide adds the path to host-owned `intentionallyHiddenRunningPaths` (or an equivalent reason-tagged record);
- review closure records the same intentional-hide property plus its durable outbox reason;
- renderer ready/reload preserves hidden intent and does not reopen those paths;
- renderer recovery still restores an actually accidental omission when no hide intent exists;
- reopening explicitly clears hide intent; terminalization prunes the running-only marker but does not force the tab open;
- extension-host/backend generation loss follows normal durable session restoration and does not claim an in-process run survived.

Likely files/tests:

- `extension/src/host/core/arch-state.ts`;
- `extension/src/host/core/message-router.ts`;
- `extension/src/host/core/reducer/command-session-handlers.ts`, `session-handlers.ts`, and helpers;
- `extension/test/host/core/architecture/arch-close-session.test.ts`;
- `extension/test/host/core/architecture/arch-review-closure-hide.test.ts`;
- `extension/test/host/core/lifecycle/session-tab-actions.test.ts`;
- webview handshake/reload tests.

## 7. Target process architecture

```text
VS Code extension host
        │ existing bounded JSONL RPC/events
        ▼
┌──────────────────────────────────────────────────────────────┐
│ Coordinator process                                          │
│ host protocol · cold files/catalog/settings/models · tabs     │
│ worker supervision · provider admission/circuits · forwarding │
│ bounded live checkpoints · response-priority host writer       │
└──────────────┬──────────────────────────────┬─────────────────┘
               │ private IPC v1               │ private IPC v1
               ▼                              ▼
      ┌─────────────────┐            ┌─────────────────┐
      │ root worker A   │            │ root worker B   │
      │ Pi SDK/runtime  │            │ Pi SDK/runtime  │
      │ extensions/tools│            │ extensions/tools│
      │ nested agents   │            │ nested agents   │
      │ sole live writer│            │ sole live writer│
      └─────────────────┘            └─────────────────┘
```

### 7.1 Coordinator ownership

The coordinator owns:

- parsing, validating, correlating, and responding to host JSONL;
- `app.ping` and diagnostics;
- session list/catalog/review metadata and cold transcript/page/detail reads;
- configured model catalog and settings reads/writes;
- create/open/duplicate/forget and other cold durable operations when no worker owns the file;
- promotion state and per-root command routing;
- worker process spawn, heartbeat, interruption, kill, exit, and generation fencing;
- provider-wide admission leases and circuit state shared across all workers;
- compact last-known live checkpoints and worker event forwarding;
- the existing response-priority host writer.

The coordinator must not call `createAgentSessionServices`, load user extensions/resources, construct an `AgentSession`, run provider callbacks, execute tools, or normalize recursive subagent details. A top-level SDK import used only for the cold-store API is an evidence-driven seam, not an absolute prohibition; §7.2 determines where that import and its operations execute. Reuse `session-browser.ts`, `session-catalog.ts`, `session-metadata.ts`, and transcript helpers after extracting accidental runtime dependencies.

### 7.2 `ColdSessionStore` seam

The SDK's top-level `SessionManager` currently owns session-format migration and the supported create, open, fork, and tree semantics. Define a narrow `ColdSessionStore` adapter over that API for list/open snapshot, transcript/page/detail reads, create, duplicate/fork, tree projection, and metadata changes. Preserve SDK behavior for header/session-directory naming, parent links, active leaf/branch/context construction, entry identities, and automatic v1/v2→v3 migration. Do not casually parse-and-rewrite or reimplement the session format in coordinator code.

The coordinator logically owns this adapter and every cold-operation lease, but measurement decides its execution location:

- first measure top-level SDK import and representative `ColdSessionStore` operations against explicit control-plane event-loop-delay and `app.ping` budgets;
- if they stay within budget, use the supported SDK wrapper in the coordinator without creating `AgentSessionServices`, a resource loader, an `AgentSession`, or user extensions;
- if import or an operation misses budget, run the **same adapter** in a bounded dedicated browse/migration helper process. Bound helper count, requests, frame bytes, and cancellation; coordinator ping and unrelated controls must remain responsive while it imports, migrates, or scans;
- in either placement, the coordinator acquires the logical cold lease and the adapter rechecks ownership immediately before every read publication and write commit. A helper result is discarded if promotion, forget, replacement, or generation ownership changed while it ran.

Parity tests must cover legacy v1 and v2 migration to v3, create/fork/duplicate and tree/leaf/context semantics, concurrent cold reads around promotion or mutation, and the immediate pre-publication/pre-commit ownership recheck in both in-process and helper-backed execution. The helper is isolation for the supported adapter, not a license to invent another session format.

### 7.3 Worker ownership

One worker owns one hot root session at a time. It owns:

- SDK import/runtime creation for that root;
- resource and extension loading;
- system-prompt/tool guard installation;
- the session event subscription and live-turn accumulator;
- provider request execution after coordinator admission;
- tools, nested subagents, extension UI bridge endpoints, and auxiliary LLM metering;
- live detail baselines/deltas;
- the sole write-capable session manager/file handle while its ownership lease is active;
- durability-before-terminal handoff.

A worker never serves an unrelated root session. A blocked A worker therefore cannot block B's worker or the coordinator.

### 7.4 Cold-to-hot ownership states

Use an explicit per-session owner state:

```text
cold(coordinator) → promoting(fenced) → hot(workerId, workerGeneration)
                  ← retiring(flush/exit confirmed) ←
```

Rules:

- cold create/open/list/page/detail does not spawn a worker;
- the first execution mutation enters `promoting` through a per-path single flight;
- while promoting, coordinator cold writes are fenced and concurrent execution requests join the owner;
- the worker publishes runtime-hydrated metadata before the initiating operation can stream, preserving current promotion ordering;
- in `hot`, every session-file mutation routes to the worker; coordinator reads may use stable cold reads or worker checkpoints but never write;
- return to `cold` only after the worker has flushed/closed and its process exit or explicit lease release is confirmed;
- if death cannot be confirmed, do not start a replacement writer. Surface unavailable/retry rather than risk two writers.

Cold model selection and metadata-only operations should remain coordinator-owned where they can be performed losslessly without runtime creation. Execution operations include send/edit execution, history compaction, live interrupt, extension-UI continuation, and any action that invokes SDK/extensions/tools. An idle cold truncate may remain a coordinator durable operation; a hot truncate routes to the worker.

### 7.5 SDK-driven session replacement ownership checkpoint

The pinned SDK permits extensions and commands to call `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()`. Those flows replace `runtime.session`, can change `runtime.session.sessionFile`, and preserve a defined extension lifecycle. A worker may therefore never treat a changed `runtime.session` or session file as implicit permission to start writing a different path.

Phase 4 begins with an ownership-protocol spike and must establish this sequence before enabling extension-driven replacement:

1. Before any destination file create/open/write, the worker sends a replacement intent containing source lease/generation, operation identity, requested destination or creation parameters, and lifecycle reason.
2. Under the coordinator's per-path ownership lock, the coordinator validates policy, resolves and reserves the exact destination, and fences cold writes. The reservation is bound to the source worker generation and operation; no destination worker, coordinator writer, or other write owner may coexist with it.
3. Only a coordinator-authorized SDK adapter may continue. At its supported **pre-write barrier**, after old-session writes are quiesced and the old manager is closed, the coordinator atomically releases the source lease and converts the destination reservation into the same worker generation's sole-writer lease. Only the returned one-use authorization permits destination create/open-for-write/append and destination streaming. There is no interval with two write leases or with an unleased destination write.
4. Cancellation or failure before that barrier releases the reservation without changing source ownership. Failure or crash after transfer leaves the destination lease fenced until process death, durable fingerprints, and lease state are reconciled; it never silently rolls ownership back to the source.
5. Every source append/truncate after transfer is rejected as stale, and every destination write before transfer commit is rejected. No new worker may own the destination until the old process is confirmed dead or has acknowledged release.

Preserve SDK `session_before_switch`/`session_before_fork`, `session_shutdown`, resource reload/rebind, `session_start`, cancellation, and `withSession` behavior. Public `session.opened`, selection-token/operation ownership, pending replacement reconciliation, and runtime-ready-before-stream ordering must describe the actual destination path without stealing selection.

If the pinned SDK has no supported hook before destination creation/write, **Phase 4 is blocked**: add a fail-closed adapter or obtain an upstream pre-write seam. Observing `runtime.session`/`sessionFile` only after replacement is not sufficient. Tests cover new, fork/clone, and switch conflicts; extension cancellation; crash after reservation and mid-transfer; destination-owner collision; and stale old-session writes after commit.

### 7.6 Bootstrap, patch, build, and teardown prerequisites

`extension/src/backend/sdk.ts` currently patches files in a shared installed SDK, while Vite's node build emits only `extension.js` and `backend.js`. Before any real worker starts:

- implement one coordinator-owned, cross-process-locked pre-spawn patch barrier, or move to immutable build-time patching. It runs once per SDK path/version, verifies the durability/retry patch fingerprints, and fails startup closed on unsupported state;
- workers must never race writes to shared SDK files. They receive a verified patch identity and may only validate it before import;
- add `worker-entry.ts` as a dedicated Vite node input with a stable packaged output path, include it in installed/package artifacts, and spawn that artifact rather than a source TypeScript path;
- add build tests for all node entries and a packaged-artifact test that installs/unpacks the produced shape, starts the coordinator, spawns a real worker entry, completes readiness/IPC, and exits cleanly;
- coordinator shutdown, worker restart, failed bootstrap, runtime crash, and test cleanup terminate the complete worker process tree, including tool/subagent descendants spawned after readiness. POSIX uses the worker process group. Before bootstrap, Windows assigns the worker to a private kernel Job held by a guardian process with `KILL_ON_JOB_CLOSE`; coordinator/guardian death, explicit kill, or runtime crash cleanup therefore does not depend on PID snapshots or live parent links.

These are Phase 2 prerequisites, not rollout cleanup.

## 8. Private coordinator/worker IPC v1

Private frames use two dedicated inherited descriptors: one coordinator→worker JSONL pipe and one worker→coordinator JSONL pipe. Node child-process object IPC is not an ingress because it deserializes before application bounds can run; workers have no `process.send` or `message` listener. Worker `stdout` and `stderr` are diagnostic-only: Pi extensions may call `console.log`, `console.error`, or write directly to either stream, so those streams can never carry private framed IPC and diagnostic bytes can never poison protocol parsing. Drain diagnostics independently with bounded logging/backpressure behavior. Each descriptor applies the shared bounded JSONL reader before `JSON.parse`; senders serialize JSON+LF and verify its exact byte cap before the OS write.

Transport/build acceptance pins and tests this two-descriptor transport. Tests inject extension factory, hook, tool, and nested-subagent stdout/stderr noise (including JSON-looking lines, partial lines, and output around the diagnostic bound) while commands, heartbeats, detail pages, and exits remain synchronized. Also test IPC close/malformed/oversize handling, generation rejection, coordinator shutdown, packaged worker spawn, and complete process-tree cleanup.

Create a private protocol separate from `PROTOCOL_VERSION`, likely in:

- new `extension/src/backend/worker-protocol.ts`;
- new `extension/src/backend/worker-client.ts`;
- new `extension/src/backend/worker-supervisor.ts`;
- new `extension/src/backend/worker-entry.ts`;
- new `extension/src/backend/worker-server.ts`;
- shared bounded writer/reader support factored from `server-io.ts` and `shared/jsonl.ts`.

Names may be adjusted to repository style, but do not hide the coordinator/worker boundary inside `BackendServer` callbacks.

### 8.1 Frame identity and generations

Every frame carries:

```ts
interface WorkerFrameBase {
  ipcVersion: 1;
  coordinatorGeneration: number;
  workerId: string;
  workerGeneration: number;
  sessionPath: string;
  kind: string;
  seq: number;             // monotonic in the declared ordered stream
  requestId?: string;      // coordinator↔worker correlation
  turnId?: string;
  attemptId?: string;
  toolCallId?: string;
}
```

The supervisor validates the worker's PID/process identity, assigned session path, version, generation, sequence, and frame size before dispatch. Frames from an exited/replaced generation are telemetry-only drops; they cannot mutate state, settle a current request, answer extension UI, release/reacquire a provider lease, or write a host event.

`kind` is a discriminant, not an open-ended event name at the validation boundary. IPC v1 defines and exhaustively validates these frame families:

```ts
type CoordinatorToWorkerFrame =
  | { kind: 'command'; requestId: string; operation: WorkerOperation; payload: unknown }
  | { kind: 'interrupt'; requestId: string; targetRequestId?: string; reason: string }
  | { kind: 'sync'; domain: 'settings' | 'catalog' | 'auth' | 'runtimePrefs' | 'providerPolicy'; revision: number; payload: unknown }
  | { kind: 'ownership.consumed'; requestId: string; authorizationId: string; lease: SdkSessionWriteLease }
  | { kind: 'provider.leaseResult'; requestId: string; leaseId?: string; status: 'granted' | 'rejected' | 'cancelled'; payload?: unknown }
  | { kind: 'provider.cancelAck'; requestId: string; targetRequestId: string; status: 'queued' | 'granted' | 'not-found'; leaseId?: string }
  | { kind: 'extensionUi.response'; requestId: string; uiRequestId: string; subagentCallId?: string; toolCallId?: string; payload: unknown }
  | { kind: 'detail.subscribe'; requestId: string; subscriptionId: string; address: LiveSubagentDetailAddress; cursor?: DetailCursor; maxPageBytes: number }
  | { kind: 'detail.unsubscribe'; requestId: string; subscriptionId: string };

type WorkerToCoordinatorFrame =
  | { kind: 'ready'; runtimeMetadata: unknown }
  | { kind: 'response'; requestId: string; ok: boolean; result?: unknown; error?: WorkerError }
  | { kind: 'event'; event: WorkerEventName; payload: unknown }
  | { kind: 'heartbeat'; payload: WorkerHeartbeat }
  | { kind: 'ownership.consume'; requestId: string; authorization: SdkSessionTransferAuthorization; canonicalDestinationPath: string }
  | { kind: 'provider.leaseRequest' | 'provider.observation' | 'provider.release'; requestId: string; leaseId?: string; payload: unknown }
  | { kind: 'provider.cancel'; requestId: string; targetRequestId: string; reason: string }
  | { kind: 'extensionUi.request'; requestId: string; uiRequestId: string; subagentCallId?: string; toolCallId?: string; payload: unknown }
  | { kind: 'detail.subscribed'; requestId: string; subscriptionId: string; baselineRevision: number; pageCount: number; totalBytes: number }
  | { kind: 'detail.page'; subscriptionId: string; baselineRevision: number; pageIndex: number; pageCount: number; payload: unknown; payloadBytes: number; checksum: string }
  | { kind: 'detail.delta'; subscriptionId: string; baseRevision: number; revision: number; operations: JsonStructuralPatchOperation[] }
  | { kind: 'detail.rebaseRequired'; subscriptionId: string; currentRevision: number; reason: 'gap' | 'backpressure' | 'evicted' }
  | { kind: 'detail.terminal'; subscriptionId: string; revision: number; durableRef: LazyDetailRef }
  | { kind: 'detail.unsubscribed'; requestId: string; subscriptionId: string };
```

`WorkerOperation`, `WorkerEventName`, `WorkerError`, sync payloads, and every `unknown` placeholder above must be replaced by closed typed unions in `worker-protocol.ts`; the sketch lists required families without duplicating all existing public payload types in this plan. Unknown kinds/fields that violate their selected payload validator fail the worker generation rather than being forwarded.

Extension-UI identity is the existing `uiRequestId` plus optional exact `subagentCallId` and `toolCallId`, under the frame's root session and worker generation. The coordinator records one pending owner before forwarding a public request. A host response must match all present ownership fields; only the owning live generation receives it. The first accepted worker settlement clears the owner. Duplicate, mismatched, timed-out, cancelled, or stale-generation responses receive a correlated stale/unavailable result and never reach an extension callback. `detail.subscribe` and `detail.unsubscribe` likewise settle only on `detail.subscribed`/`detail.unsubscribed` (or a correlated error); collapse may drop the body immediately but keeps the bounded subscription tombstone until unsubscribe acknowledgement or worker death so late pages/deltas are ignored.

### 8.2 Ordering and stale fences

- mutation commands are FIFO per root session;
- worker responses correlate by request ID and may use a response-priority lane;
- lifecycle and terminal events preserve worker sequence order;
- detail deltas have their own subscription sequence/revision and cannot reorder lifecycle events;
- a promoted worker's `runtimeReady` metadata is forwarded before its first stream event;
- coordinator generation change invalidates all workers and subscriptions;
- worker generation change invalidates old commands, provider leases, UI requests, and live-detail cursors;
- gaps trigger an explicit checkpoint/rebase, never best-effort patch application.

### 8.3 Byte and backpressure rules

- retain the shared 32 MiB hard frame/record limit and stricter producer headroom; do not allow an IPC frame larger than a host JSONL record simply because it is private;
- ordinary control, heartbeat, compact progress, and terminal metadata must be much smaller than the hard limit and have explicit semantic bounds;
- complete expanded detail uses bounded pages/segments. A single huge tool output is represented by exact paged content, not byte-truncated JSON;
- each dedicated-FD reader discards an overlong frame through its delimiter before deserialization and fails the offending worker generation; malformed or gapped current-generation JSONL fails likewise. Correlated coordinator requests receive a typed failure;
- writers maintain bounded response/control, lifecycle, and detail queues. Responses/control drain before progress, FIFO within a lane; an active OS write is not preempted;
- only contiguous same-owner progress/detail patches may compose. Terminal/durable handoff records are never dropped or coalesced away;
- on detail backpressure, stop producing deltas for that subscription and issue `rebase-required` at the newest retained revision. Do not enqueue an unbounded history;
- coordinator-to-host ordinary snapshots remain compact even while a detail subscription is active. Detail is forwarded through the closed public protocol in §9, not copied into `ViewState`.

### 8.4 Heartbeat, crash, restart, and interrupt

Heartbeat fields include worker generation, phase, active request identity, last event/detail revision, event-loop delay, and last durable append identity. Heartbeats are cheap and contain no transcript bodies.

- missed heartbeat marks the worker `unresponsive` but does not freeze coordinator control handling;
- user interrupt first sends a soft, correlated worker interrupt;
- if soft interrupt/teardown misses its grace, coordinator marks the root interrupted in its bounded live checkpoint/ViewState projection, revokes provider leases/UI ownership, and kills the worker process tree;
- this coordinator terminalization is explicitly **render/reconciliation state**, not a durability-confirmed assistant/tool terminal: it carries no fabricated durable entry ID and does not write the hot session file while the worker may still exist;
- replacement waits for confirmed exit and write-lease release. The durable file remains authoritative up to the old worker's last confirmed append; on cold reopen or fresh promotion, existing dangling-work normalization renders unconfirmed work interrupted without replay. If implementation adds durable interrupted-state repair, it may run only after confirmed old-process exit under a newly acquired sole-writer lease and must use the SDK/session format's supported append API—never ad-hoc JSONL fabrication;
- never replay the interrupted operation automatically;
- after crash/kill, the next explicit execution may promote a fresh generation from durable state;
- a normal worker crash affects only its root. Other roots, cold browsing, settings/models, and ping remain available;
- coordinator-process restart remains governed by the existing host backend-generation contract.

Use realistic configurable grace values and the existing Windows `taskkill.exe /T /F` strategy in `host/backend/client.ts` as a reference. Tests should inject clocks where possible; production values should not be tuned from one fast workstation.

### 8.5 Single-writer ownership

Instrument every session append/truncate with `{sessionPath, ownerRole, workerId, workerGeneration}` in test builds. Acceptance requires:

- no coordinator write while a hot worker owns the path;
- no two workers simultaneously hold write ownership;
- a stale worker cannot append after replacement;
- replacement does not start until old-process exit is confirmed;
- terminal tool/assistant publication follows the durable append from the same owner;
- cold coordinator writes recheck ownership immediately before commit.

If process death cannot be proven, fail closed and require retry/restart. Do not rely solely on in-memory generation checks to restrain a synchronously wedged old process.

### 8.6 Settings, auth, and catalog synchronization

The coordinator is authoritative for configured settings/catalog metadata. Workers receive a startup snapshot with independent revisions such as settings, catalog, auth fingerprint, runtime preferences, and provider policy.

- revisions are monotonic within a coordinator generation;
- deltas are ordered and acknowledged before a dependent command executes;
- workers report runtime-discovered model URLs/capabilities back without replacing configured catalog authority;
- auth bytes are not logged or copied through ordinary events. Prefer normalized auth path plus revision/fingerprint where SDK semantics allow it;
- an auth mutation/refresh bumps authority and invalidates or updates affected workers explicitly;
- settings and catalog failures remain independently settleable;
- `SetModel` uses the same generation fence as host hydration and routes any live-session runtime mutation to the owning worker;
- worker crash cannot roll configured settings/catalog back to a stale snapshot.

### 8.7 Provider-wide admission and circuits

`ProviderGate` is currently process-wide. Extract its admission/circuit state into a coordinator-owned service while keeping actual provider I/O in workers.

Worker flow:

1. request a provider lease with root/turn/attempt/provider/model/generation identity;
2. coordinator queues/grants/rejects according to global capacity and circuit state;
3. worker reports headers, classified failure, retry/cancel, and terminal release;
4. coordinator updates the shared circuit and grants queued work;
5. worker exit/replacement releases all generation-owned leases exactly once.

A lease is not transferable between workers or generations. Half-open probe ownership is global. Cancellation does not count as provider failure. Configuration changes update the coordinator state in place. This preserves provider-wide behavior when sessions are split across processes and prevents each worker from independently consuming the full configured concurrency.

### 8.8 Last-known live checkpoint

The coordinator retains a bounded compact checkpoint per hot root:

- active turn/attempt/tool identities and sequences;
- compact text/reasoning/activity tails;
- lifecycle, extension-UI ownership, usage, and durable-entry watermarks;
- detail subscription manifests/revisions, but not the complete recursive transcript.

On worker crash, this checkpoint supports truthful interrupted rendering and diagnostics. It is explicitly last-known and may be stale. If a durability-confirmed terminal handoff exists, cold durable detail is authoritative. If not, expanded live detail becomes `stale/unavailable` with retry after restart; the UI must not claim a non-durable recursive body is exact.

## 9. Public coordinator → host → webview detail protocol

Private worker IPC is not the public UI contract. Add closed typed unions at both remaining boundaries; no open `event: string` or `payload: unknown` may cross validation.

```ts
type HostToCoordinatorDetailMessage =
  | { kind: 'detail.subscribe'; requestId: string; subscriptionId: string; address: LiveSubagentDetailAddress; cursor?: DetailCursor; maxPageBytes: number }
  | { kind: 'detail.unsubscribe'; requestId: string; subscriptionId: string; reason: 'collapse' | 'rebase' | 'session-change' | 'host-dispose' };

type CoordinatorToHostDetailMessage =
  | { kind: 'detail.start'; subscriptionId: string; address: LiveSubagentDetailAddress; source: 'live' | 'durable'; baselineRevision: number; pageCount: number; totalBytes: number; fence: BackendDetailFence }
  | { kind: 'detail.page'; subscriptionId: string; baselineRevision: number; pageIndex: number; pageCount: number; payload: DetailPagePayload; payloadBytes: number; checksum: string; fence: BackendDetailFence }
  | { kind: 'detail.delta'; subscriptionId: string; baseRevision: number; revision: number; operations: JsonStructuralPatchOperation[]; fence: BackendDetailFence }
  | { kind: 'detail.rebase'; subscriptionId: string; currentRevision: number; reason: 'gap' | 'backpressure' | 'evicted' | 'generation-change'; fence: BackendDetailFence }
  | { kind: 'detail.terminal'; subscriptionId: string; revision: number; durableRef: LazyDetailRef; fence: BackendDetailFence }
  | { kind: 'detail.error'; subscriptionId: string; code: DetailErrorCode; message: string; retryable: boolean; fence: BackendDetailFence };
```

`BackendDetailFence` contains backend/coordinator generation and, for a live source, worker ID/generation. `DetailCursor` is revision/segment progress only and is not identity. `DetailPagePayload`, patch operations, refs, and error codes are closed validated types. Subscribe/unsubscribe RPC acknowledgements remain correlated control responses; stream content is only the six coordinator-to-host variants above.

The webview boundary mirrors the same state machine:

```ts
type WebviewToHostDetailMessage =
  | { kind: 'detail.subscribe'; viewGeneration: number; detailKey: string; address: LiveSubagentDetailAddress; cursor?: DetailCursor }
  | { kind: 'detail.unsubscribe'; viewGeneration: number; detailKey: string; reason: 'collapse' | 'unmount' | 'session-change' };

interface HostDetailRoute {
  hostInstanceId: string;
  hostGeneration: number;
  viewGeneration: number;
  backendGeneration: number;
  coordinatorGeneration: number;
  workerId?: string;
  workerGeneration?: number;
  detailKey: string;
  subscriptionId: string;
}

type HostToWebviewDetailMessage =
  | (HostDetailRoute & { kind: 'detail.start'; address: LiveSubagentDetailAddress; source: 'live' | 'durable'; baselineRevision: number; pageCount: number; totalBytes: number })
  | (HostDetailRoute & { kind: 'detail.page'; baselineRevision: number; pageIndex: number; pageCount: number; payload: DetailPagePayload; payloadBytes: number; checksum: string })
  | (HostDetailRoute & { kind: 'detail.delta'; baseRevision: number; revision: number; operations: JsonStructuralPatchOperation[] })
  | (HostDetailRoute & { kind: 'detail.rebase'; currentRevision: number; reason: 'gap' | 'backpressure' | 'evicted' | 'generation-change' })
  | (HostDetailRoute & { kind: 'detail.terminal'; revision: number; durableRef: LazyDetailRef })
  | (HostDetailRoute & { kind: 'detail.error'; code: DetailErrorCode; message: string; retryable: boolean });
```

A host or backend generation change invalidates the stream; a view generation change invalidates renderer ownership.

Routing/ownership rules:

- webview expansion asks the host to subscribe; the `EffectRunner` allocates the backend subscription ID and routes subscribe/unsubscribe through the owning session service. Reducers may request effects and track compact loading/error metadata, but never hold pages or execute I/O;
- the host owns exactly one active subscription record per `{hostInstanceId, viewGeneration, detailKey}` and records its exact session/address/backend/worker owner before forwarding content;
- collapse/unmount immediately discards the webview's heavy key store, sends unsubscribe, and leaves a bounded host tombstone until acknowledgement, worker/backend death, or expiry. Late start/page/delta/terminal messages matching a tombstone are dropped and cannot recreate UI;
- all generations, address, subscription ID, page/revision order, byte counts, and checksums are validated before forwarding. Gaps emit `detail.rebase`; typed terminal/error states close or transition the subscription exactly once;
- the webview uses a key-scoped store keyed by `detailKey` plus subscription ID. Applying one page/delta must notify only that expanded subtree, not replace `ViewState` or rerender unrelated cards;
- ordinary `ViewState` contains only bounded compact previews and cheap detail status/cursor metadata. It never contains baseline pages, deltas, complete transcripts, or huge output segments.

Protocol tests exhaustively validate every union variant and reject unknown/missing fields, stale backend/worker/host/view generations, wrong owners, duplicate terminal/error settlement, post-unsubscribe traffic, and cross-key rerenders.

## 10. Demand-driven subagent detail protocol

Likely implementation points:

- `extensions/subagent/runner.ts`, `types.ts`, and `src/execute.ts`;
- `extension/src/backend/session-event-handler.ts`;
- `extension/src/backend/tool-progress-normalizer.ts`;
- `extension/src/backend/live-turn-accumulator.ts`;
- `extension/src/shared/live-pipeline-protocol.ts`;
- `extension/src/shared/lazy-details.ts` and `subagent-result.ts`;
- `extension/src/host/session-service/detail-retrieval.ts`;
- `extension/src/host/core/events.ts`, `effects.ts`, reducer/projection;
- `extension/src/shared/protocol/event-payloads.ts` and `webview.ts`;
- webview lazy-detail store/hooks and transcript tool components under `extension/src/webview/panel/transcript/tools/`.

### 10.1 Address and subscription

A live detail address includes immutable producer identity, not a revision, tool name, or array index:

```ts
interface SubagentChildIdentity {
  childId: string;             // producer-issued identity for this child attempt
  spawningToolCallId: string;  // stable subagent tool call that created it
  attemptId: string;
}

interface LiveSubagentDetailAddress {
  sessionPath: string;
  turnId: string;
  rootToolCallId: string;
  rootAttemptId: string;
  lineage: readonly SubagentChildIdentity[]; // root child through target, non-empty
}
```

The subagent producer must issue a stable `childId`/attempt identity for every single, parallel, chain, and nested child when it is created. Every descendant carries the stable ancestor lineage at every depth; reordering, filtering, insertion, parallel completion, or rebasing cannot change the address. Array indexes are display order only. `revision` is solely a `DetailCursor`/delta-order field and is never part of `LiveSubagentDetailAddress`.

The transport also carries coordinator/worker generation and a host-minted `subscriptionId`. Migration parsing may synthesize a best-effort display key for old durable details that lack producer identity, but that fallback is display-only: it cannot subscribe to, merge, or own live deltas.

Expansion sends subscribe with the last cached cursor if any. The owning worker responds with:

- a bounded baseline when it fits; or
- a manifest plus ordered pages/segments captured at baseline revision R;
- then ordered deltas with `baseRevision` and `revision` greater than R.

Updates that occur while baseline pages are being delivered are retained only as a bounded post-R delta window. If that window cannot be retained, send `rebase-required`; the renderer discards the partial body and requests a fresh baseline.

### 10.2 Baseline and delta semantics

The baseline is a complete semantic transcript projection at one revision. Pages split on semantic record/part boundaries where possible. An individually oversized output uses exact content segments with byte ranges/checksums and deterministic reassembly. No page pretends to be a complete result when it is not.

The subscribe request negotiates `maxPageBytes`; the coordinator clamps it to a configured target and to a value whose complete serialized IPC and host-imperative envelopes remain below the existing 30 MiB producer budget and 32 MiB hard record ceiling. Each page reports exact UTF-8 `payloadBytes`, ordered `pageIndex/pageCount`, baseline revision, and a content checksum. A large string/blob segment carries semantic part identity plus `[startByte,endByte,totalBytes]`; splits occur only at UTF-8 boundaries. The receiver verifies envelope bytes, checksum, contiguity, non-overlap, page count, and total bytes before committing the baseline. Pages and the bounded post-baseline delta window may be discarded on collapse, gap, checksum failure, or worker loss and restarted from a fresh baseline.

There is no fixed total-detail byte rejection analogous to today's `server.ts::loadDetail` check against `LIVE_PIPELINE_LIMITS.previewBytes`. Replace that check for subagent transcript/long-output refs with paged retrieval from the live worker or durable transcript. The full detail remains bounded by the actual canonical/durable source and receiver cache policy, not by one frame; only one page and a bounded reassembly window need cross the transport at once. Generic details that remain single-frame may retain their current limit. Add tests directly covering a detail whose total exceeds `LIVE_PIPELINE_LIMITS.previewBytes`, exact segment reassembly, non-ASCII split boundaries, bad checksum, missing page, retry/rebase, and durable reload. The configured page target is a rollout tuning value selected by §13 measurements, not a change to the hard safety ceilings.

Deltas are restricted operations already supported by the live structural patch model: set/delete, string append, and array append, with stable child/message/tool keys. They update only the subscribed detail store. Duplicate revisions are idempotent; a gap or base mismatch rebases.

The worker should build the compact card and subscriber deltas incrementally from the source update. It must not clone/normalize/diff/measure the complete recursive tree separately for every downstream consumer. Normalize a changed branch once, maintain revisioned canonical detail in the worker, update compact tails/counters incrementally, and serialize only demanded pages/deltas.

### 10.3 Durable terminal handoff

Terminal ordering is:

1. worker finalizes exact subagent details;
2. worker appends the terminal tool result to the root session file;
3. append returns stable durable entry identity;
4. worker emits terminal lifecycle plus a durable detail reference/revision;
5. coordinator/host switch the subscription source from live worker detail to durable retrieval without changing the rendered card identity;
6. collapse/reopen/backend restart can retrieve the exact terminal detail from disk.

A terminal payload that exceeds one frame is never embedded whole in the lifecycle event; its durable reference plus paged retrieval is the handoff. Long terminal output remains accessible after restart.

### 10.4 Ordinary state bounds

Add deterministic counters to prove:

- collapsed card bytes have a fixed semantic bound independent of total recursive transcript size;
- ordinary `ViewState` and `live.semantic` updates do not contain recursive detail bodies;
- with no subscribers, no detail baseline/page/delta frames are produced;
- with one subscriber, only changed branches are sent after one baseline;
- collapse stops detail traffic after unsubscribe acknowledgement, except an already-active bounded write;
- re-expand receives a current baseline and ordered deltas, not accumulated historical event replay.

### 10.5 Bounded page-backed renderer and cache ownership

“Complete” means every message and output byte remains navigable and retrievable; it does not mean the whole recursive transcript is simultaneously mounted in the DOM or retained in RAM.

- virtualize each nested message list and nested subagent subtree. Page records by stable semantic identity, and render huge tool inputs/outputs as independently virtualized exact byte/semantic segments rather than one giant string node;
- keep active subscription metadata plus the current viewport/reassembly pages in a dedicated bounded active-subscription store, pinned separately from the generic 32-entry/64-MiB one-shot lazy-detail LRU. The generic LRU cannot evict ownership/cursor state for an expanded card;
- the active store is still bounded: offscreen pages and oversized output segments may be evicted while metadata/checksums/cursors remain. Re-entering the viewport re-fetches exact content from the live worker's canonical state or, after terminal handoff, the durable source;
- never concatenate a detail larger than the active budget merely to pass it to the renderer. Verify and commit pages/segments independently at semantic boundaries;
- collapse unsubscribes, removes subscription metadata after the tombstone lifecycle, and immediately discards all heavy pages, segment buffers, and virtualizer measurements for that key.

Fast tests inject tiny page/cache/viewport budgets to force eviction, offscreen navigation, live and durable re-fetch, nested virtualization, oversized-segment reassembly, and collapse cleanup deterministically. Add a separate opt-in end-to-end integration test whose exact detail exceeds the current 64-MiB cache; it must prove end-to-end navigation/re-fetch and terminal equality but stay outside canonical `npm test` so the ordinary development suite is not slowed.

## 11. PR-sized implementation phases

Each phase must be independently reviewable and preserve a backend-generation rollback seam. Do not mix broad host reducer refactors with worker extraction.

### Phase 0 — Evidence and observability

**Dependencies:** none.  
**Deliverables:** two spawned blocking-extension harnesses (execution hook and synchronous factory/resource bootstrap), legacy failing causal liveness assertions/characterization, phase/event-loop/writer/subagent instrumentation, trace artifact schema.

**Exit:** both blocks are externally entered/released with fail-safe cleanup, and incident phases can be distinguished without logging content or adding full-tree serialization.

### Phase 1 — Independent host/backend correctness

**Dependencies:** Phase 0 instrumentation helpers only where useful.  
**Deliverables:** pending-path hydration guard; provisional catalog/reasoning preservation; independent settings/models settlement; hydration dedupe/generation fence; single-surfaced correlated errors; create timeout ledger/late reconciliation; intentional-hide state.  
**Exit:** focused tests pass in legacy mode and do not depend on worker isolation.

Split this into multiple PRs if needed: model hydration, error ownership, create reconciliation, and hide intent are independent review units.

### Phase 2 — Private IPC and supervisor skeleton behind a flag

**Dependencies:** Phase 0.  
**Deliverables:** two dedicated inherited directional FDs (no Node object IPC); `WORKER_IPC_VERSION`; pre-deserialization bounded reader/exact-cap writer; spawn/ready/heartbeat/exit; generation fences; response correlation; independent diagnostic stdout/stderr draining; coordinator-owned locked SDK patch barrier; dedicated bundled worker entry/package output; POSIX process-group and Windows kernel-Job guardian process-tree kill; test worker; no Pi runtime yet.

**Exit:** extension stdout/stderr cannot enter IPC, stale/malformed/oversize frames and writer backpressure are deterministic, patch writes cannot race, missed heartbeat/soft interrupt/kill/restart clean the process tree, and the packaged-artifact spawn test passes.

Select one backend mode for an entire coordinator generation via an internal rollout flag such as `PIE_SESSION_RUNTIME_ISOLATION=0|1`. Do not mix legacy and worker write ownership for different sessions in the same generation during early rollout. (This flag was removed in Phase 7; isolated mode is now the sole path.)

### Phase 3 — Lightweight coordinator and cold operations

**Status:** Implemented (2026-08-15). Phase 4 routing is now integrated.
**Dependencies:** Phase 2; Phase 1 create semantics.  
**Deliverables:** implement `ColdSessionStore`; extract cold session/catalog/settings/models/create/open paths from `BackendServer`; measure top-level SDK import/operations and choose coordinator or bounded helper execution; cold create/open remains runtime-free.

**Exit:** v1/v2→v3 migration, create/fork/tree, concurrent read, and ownership-recheck parity tests pass; coordinator never creates `AgentSessionServices` or loads user extensions; ping budgets determine and document the placement. The SDK patch barrier now fail-closes on the pinned `SessionManager.create` seam and atomically publishes the SDK-owned v3 header before returning the exact retained manager/path; its separately fingerprinted identity is validated by coordinators and workers, and the create ledger records a durable path only after that return. Isolated coordinators import only the cold config/auth/session exports, not the package root or history-compaction internals, and do not mutate `AgentSession.prototype`; legacy/runtime-worker loading remains full. Measurement selected the in-process adapter: the one-time cold SDK module import is bounded by the 15 s contended-Windows startup budget, representative cold operations by a 1 s event-loop probe, and a causal public JSONL test proves the correlated `app.ping` response crosses the response writer before a suspended cold catalog operation is released. A helper-backed placement was therefore not implemented; `COLD_SESSION_STORE_PLACEMENT` and its tests pin that decision.

### Phase 4 — One hot root per worker

**Status:** Implemented (2026-08-15): transactional cold promotion, one-hot-root worker routing, SDK replacement rekey, priority interrupt, crash reconciliation, and coordinator-authoritative settings/prefs sync are integrated.
**Dependencies:** Phases 2–3.  
**Blocking checkpoint:** prove a supported pre-write seam for SDK-driven `newSession`/fork/clone/switch. If the pinned SDK lacks one, Phase 4 stops for a fail-closed adapter or upstream seam; post-write observation is not acceptable.

**Deliverables:** move `createAgentSessionRuntime`, session subscription, runtime factory, extension UI endpoint, live accumulator, tool/provider execution, and session writes into the worker; implement promotion, atomic replacement lease transfer, and runtime-ready-before-stream ordering while preserving SDK lifecycle and public `session.opened`/selection semantics.

**Exit:** both spawned blocking-extension tests pass causally, and new/fork/clone/switch conflict, cancellation, crash-mid-transfer, and stale-old-write tests prove no target owner overlap.

### Phase 5 — Subagent detail decoupling

**Status:** Implemented (2026-08-15). Producer-issued identities, worker/live and coordinator/durable paged authorities, the closed coordinator→host→webview protocol, host ownership/tombstones, expansion/collapse subscriptions, bounded page-backed rendering, eviction/refetch, rebase, durable terminal handoff, and the opt-in >64-MiB verification are in place. Generic one-shot `session.loadDetail` remains bounded for compatibility.
**Dependencies:** Phase 4 for final routing; protocol/store pieces can be prepared earlier.
**Deliverables:** producer-issued stable child identities/lineages; complete closed coordinator→host→webview detail protocol; `EffectRunner`/session-service ownership and tombstones; compact card projection; demand-driven baseline/pages/deltas; bounded page-backed virtualized renderer; gap rebase; collapse unsubscribe; exact durable terminal handoff; explicit UI states; no recursive trees in ordinary lanes. Supersede the mounted-collapsed immediate-detail rule in `STATE_CONTRACT.md` and update matching sync-contract tests in the same implementation PR.

**Exit:** small-budget paging/eviction/re-fetch tests and large recursive live-subagent stress pass in collapsed, expanded, collapsed-again, re-expanded, terminal, and restart states; the opt-in >64-MiB end-to-end detail test passes outside `npm test`.

### Phase 6 — Cross-worker global services and failure recovery

**Status:** Implemented (2026-08-15). Per-provider coordinator admission and global circuits, classified worker observations, monotonic settings/auth/catalog/runtime-policy sync, exact extension-UI ownership, bounded recovery checkpoints, crash/restart reconciliation, and write-owner tracing are integrated. The opt-in spawned matrix kills one of two hot workers while provider/UI work is pending and proves unrelated streaming/coordinator controls, typed terminalization without replay, descendant cleanup, exact lease/UI release, confirmed-exit replacement, and single-writer generations.
**Dependencies:** Phase 4; detail crash behavior from Phase 5.  
**Deliverables:** coordinator provider leases/circuits; settings/auth/catalog revision sync; extension-UI request/response routing; bounded last-known checkpoint; worker crash/kill/restart reconciliation; single-writer enforcement.  
**Exit:** crash/kill/lease/UI/single-writer matrix passes with no impact on unrelated sessions.

Provider admission may need to move into Phase 4 if no safe temporary way exists to preserve global limits. Never enable multi-worker provider calls with per-worker independent capacity.

### Phase 7 — Rollout, defaults, and legacy removal

**Status:** Complete (2026-08-18). Isolated mode is the sole runtime path. The `PIE_SESSION_RUNTIME_ISOLATION` flag, runtime-mode resolution, and the monolithic in-process hot-runtime ownership were removed after the observation window and telemetry comparison completed without a critical fallback. Git history is the rollback mechanism.
**Dependencies:** all correctness gates.  
**Deliverables:** opt-in dogfood, telemetry comparison, staged default-on, documented rollback, then deletion of monolithic hot-runtime ownership after the rollback window.  
**Exit:** completion criteria below hold for the default path and no critical regression requires fallback.

## 12. Deterministic test matrix

### 12.1 Hard correctness gates

These are pass/fail gates. Use causal ordering and fake clocks rather than tight microbenchmarks.

| Scenario | Required assertion | Likely test location |
|---|---|---|
| Sync-blocking execution hook in A | fixture writes `entered`; controls for ping/cold B/settings/models are received before the test creates `release`; `finally` releases and cleans the tree | new `backend-session-worker-liveness.test.ts` |
| Synchronous extension factory/resource bootstrap | separate fixture uses the same entered/release protocol; coordinator controls respond before release while A promotes | liveness test + `backend-service-loading-gate.test.ts` |
| IPC diagnostic isolation | JSON-looking, partial, and bounded-large stdout/stderr from factory/hooks/tools/subagents never parses as IPC or disrupts command/detail ordering | new worker IPC transport test |
| Build/package spawn | build emits backend, extension, and dedicated worker entries; packaged artifact spawns worker, reaches ready, and cleans its process tree | build/package integration test |
| Cold store parity | supported v1/v2→v3 migration, create/fork/duplicate/tree/context behavior, concurrent reads, and final ownership rechecks match in-process/helper adapters | cold-session-store tests |
| SDK session replacement | new/fork/clone/switch reserve before write, preserve lifecycle/`session.opened` selection, reject conflicts and stale writes, and fail closed on cancel/crash mid-transfer | worker ownership + replacement integration tests |
| Large recursive live subagent (~incident scale) | expanded detail is complete/live/incremental; collapsed ordinary traffic stays bounded; collapse stops heavy traffic; stable identities survive reorder; re-expand rebases correctly | new backend detail integration test + webview nested-subagent tests |
| Public detail protocol | closed variants, all generation fences, owner/tombstone routing, and key-scoped updates reject stale/cross-key/post-collapse traffic | protocol sync + host EffectRunner/session-service + webview store tests |
| Page-backed renderer | tiny injected budgets force nested virtualization, page/segment eviction, live/durable re-fetch, and collapse cleanup without content loss | fast webview/detail store tests |
| >64-MiB detail | complete detail remains navigable/re-fetchable and terminal-equal without all content in DOM/RAM | opt-in end-to-end integration test, excluded from `npm test` |
| Collapsed contract supersession | mounted collapsed preview sends no subscribe; expansion alone subscribes; collapse unsubscribes | `sync-contract.test.ts` + webview lazy-detail tests |
| Pending picker | no pending-path `models.list`; configured/predecessor catalog and known reasoning remain visible while loading | `hydrate-model-state.test.ts`, composer picker tests |
| Independent hydration | settings success applies when models fail and vice versa | `hydrate-model-state.test.ts` |
| Hydration vs `SetModel` | old hydrate result cannot revert optimistic/successful user selection; duplicate refresh joins | `arch-set-model.test.ts` |
| Correlated error | one RPC error produces one public notice/event ownership | backend error + host client/reducer tests |
| Late create | timeout keeps delayed tab; retry is idempotent; late `session.opened` reconciles once and drains queued sends once | create ordering/reconciliation tests |
| Intentional hide | renderer ready/reload does not reopen user-hidden or review-hidden running tab; accidental omission still repairs | close/review/handshake tests |
| Worker crash | only root A terminalizes; coordinator, B, settings/models, and cold browsing continue; all A descendants are cleaned up | new worker-supervision integration test |
| Soft interrupt then kill | soft path settles when responsive; wedged worker is killed after grace without replay | worker supervision test with fake clock/process fixture |
| Single writer | no overlapping write owners; stale worker append rejected; replacement waits for exit | new worker ownership test |
| Provider lease | limits/circuit/half-open are global across workers; crash releases leases exactly once | `provider-gate.test.ts` plus worker integration |
| Extension UI response | nested request routes to exact worker generation once; stale response rejected; fallback ownership survives collapse | extension UI bridge + host architecture integration |
| Durable terminal handoff | after collapse/restart, exact child transcript and long output load from durable source | backend detail + webview lazy-detail tests |
| IPC gap/overflow | stale/gapped/malformed/oversize frames fail or rebase explicitly; stream remains synchronized where contract permits | new worker IPC test |

The recursive stress fixture should generate realistic nested messages, reasoning, tool inputs/results, nested subagents, and at least one long output. It must assert semantic equality at terminal, not merely card presence.

### 12.2 Windows CI budgets

Use generous causal windows:

- give each entered/release fixture a generous multi-second safety deadline, but release it causally from test cleanup rather than after a fixed sleep;
- allow control responses a multi-second CI budget while still requiring receipt before the test creates the release marker;
- allow process spawn/kill extra Windows headroom;
- inject clocks for heartbeat, grace, circuit, and retry tests rather than sleeping production durations;
- retry only known OS process-observation races, never failed semantic assertions.

A hard gate should say “B responded before A unblocked,” not “ping was under 100 ms.”

### 12.3 Performance telemetry and trend budgets

Keep these separate from correctness gates initially:

- coordinator event-loop delay p50/p95/p99/max;
- worker bootstrap SDK/services/extensions duration;
- worker idle and busy RSS/heap by root count;
- compact event bytes/update and detail bytes/subscriber;
- recursive normalization/diff/serialization CPU per changed message/byte;
- host writer queue age/bytes;
- expansion baseline time and rebase rate;
- worker crash/restart and forced-kill counts.

Trend budgets warn and produce artifacts before they become hard gates. Promote a budget to a hard threshold only after Windows CI distributions are measured and stable.

## 13. Capacity and measurement decision points

Do not encode an arbitrary fixed worker count in the architecture.

Required behavior:

- every busy root retains its worker until terminal/interrupt/crash; it is never silently evicted;
- one worker never hosts multiple hot roots;
- idle worker retention/TTL and maximum concurrent bootstraps are bounded and configurable;
- memory pressure may retire eligible idle workers or visibly delay a new promotion, but cannot kill a busy root without an explicit failure path;
- a queued promotion exposes “starting session runtime” rather than appearing hung.

Before choosing defaults, benchmark on supported Windows setups:

1. cold coordinator startup/RSS, top-level SDK import cost, and representative in-process/helper `ColdSessionStore` event-loop delay;
2. one idle initialized worker RSS;
3. one streaming/tool/subagent worker peak RSS;
4. worker bootstrap latency with warm/cold filesystem caches;
5. N concurrently busy roots, up to a machine-limited test range;
6. idle retirement and re-promotion latency.

Decision points:

- choose bootstrap concurrency from measured CPU/event-loop/memory impact, preserving the existing serial gate as the conservative initial value;
- choose idle retention/TTL from measured RSS versus re-promotion latency;
- choose detail page/segment target below the hard transport ceiling from expansion latency and writer-age data;
- consider optional per-child isolation only if per-root isolation passes global liveness but root-worker measurements still show unacceptable child-induced stalls;
- do not raise byte limits or worker concurrency to hide an amplification bug.

## 14. Rollout and rollback

Isolated mode is the sole runtime path; the legacy in-process hot runtime and its
`PIE_SESSION_RUNTIME_ISOLATION` flag were removed (2026-08-18). Rollback is via
Git history/reverts rather than a retained legacy code path.

Rollout stages (historical):

1. tests/CI only;
2. developer opt-in with comparative traces;
3. dogfood default-on with one-command backend restart rollback;
4. default-on release while legacy path remains available for a bounded window;
5. remove legacy hot-runtime ownership only after completion criteria and telemetry stability.

Rules:

- mode is selected once per coordinator generation;
- changing mode requires backend restart and normal generation reset;
- never hand a live write lease between legacy and worker modes in one generation;
- protocol version mismatch fails closed with actionable logs;
- rollback preserves durable transcripts/settings and may interrupt only currently live, non-durable work under the existing backend-restart contract.

## 15. Likely file/component map

| Area | Existing files to change or extract | Likely new files |
|---|---|---|
| Coordinator entry/control | `extension/src/backend/index.ts`, `server.ts`, `request-handler.ts`, `rpc.ts`, `server-io.ts`, `sdk.ts`, `vite.config.ts`, build/package scripts | `worker-supervisor.ts`, `worker-client.ts`, `worker-protocol.ts`, SDK patch-barrier module |
| Worker runtime | `runtime-factory.ts`, `server-types.ts`, `session-event-handler.ts`, `extension-ui-bridge.ts`, system-prompt/runtime helpers | bundled `worker-entry.ts`, `worker-server.ts` |
| Cold durable ownership | `session-browser.ts`, `session-catalog.ts`, `session-metadata.ts`, `session-opened.ts`, transcript modules | `cold-session-store.ts` plus bounded helper entry/client if measurements require it |
| Provider global state | `provider-gate.ts`, provider progress/incident modules | coordinator admission adapter and worker lease adapter, preferably adjacent to `provider-gate.ts` |
| Live/detail protocol | `live-turn-accumulator.ts`, `tool-progress-normalizer.ts`, shared `live-pipeline-protocol.ts`, `lazy-details.ts`, backend↔host and host↔webview protocol payload files | focused canonical detail/subscription modules in worker/backend |
| Subagent producer | `extensions/subagent/runner.ts`, `types.ts`, `src/execute.ts`, `src/result-compaction.ts` | stable child-identity support only where existing producer state cannot hold it |
| Host CQRS/routing | host `core/{arch-state,commands,events,effects,effect-runner,message-router,projection}.ts`, reducer handlers, session service | bounded subscription owner/tombstone registry, not a parallel state system |
| Webview detail | lazy-detail hooks/store, transcript tool components, `use-host-sync.ts` | key-scoped page store and nested/segment virtualizer integration |
| Tests | existing backend runtime/session, host architecture/lifecycle/state, webview lazy/subagent suites | spawned liveness, worker IPC/supervision/ownership/detail integration tests |

Keep target modules narrow. Do not move cold catalog, provider policy, and transcript rendering into one new “manager.”

## 16. Verification commands during implementation

From repository root, use focused tests while iterating, then the canonical gates:

```bash
npm run test -- --fast --package extension --test-name-pattern="worker|liveness|hydration|create|hidden|detail"
npm test
npm run typecheck
npm run extension:build
```

`npm test` is the canonical development test command. Any edit under `extension/src/` also requires the extension build, which syncs the installed extension. Before default-on rollout, run the spawned integration matrix on Windows and the manual UX reliability smoke scenarios that cover session selection, backend restart, streaming, expansion/collapse, extension UI, and late reconciliation.

Performance telemetry/trend runs are additional evidence; they do not replace `npm test`, typecheck, build, or deterministic integration assertions. Phase 5 also adds a clearly named opt-in large-detail command (for example `npm run test:large-detail`) for the >64-MiB end-to-end case; it is deliberately not invoked by `npm test`.

## 17. Documentation updates when implementation lands

This plan is not an authoritative runtime contract. As phases land:

- update `docs/ARCHITECTURE.md` with the coordinator/per-root-worker process diagram, cold/hot ownership, provider admission, and crash flow;
- update authoritative `docs/STATE_CONTRACT.md` with the new detail subscription semantics, explicitly superseding its mounted-collapsed immediate-detail rule, plus intentional-hide ownership, create late reconciliation, model hydration fences, worker-generation recovery, and single-writer invariants;
- update protocol contract tests whenever `STATE_CONTRACT.md` changes, especially `extension/test/shared/protocol/sync-contract.test.ts`, including collapsed-no-subscribe/expand-subscribe/collapse-unsubscribe coverage;
- update `docs/UX_RELIABILITY_SMOKE_TEST.md` or its current replacement with worker block/crash, expansion/collapse, and extension-UI scenarios;
- move/remove this plan from Active plans in `docs/INDEX.md` once the implementation and contract docs are complete.

## 18. Completion criteria

Implementation is complete only when all of the following are true:

1. Both spawned synchronous-block tests—execution hook and extension factory/resource bootstrap—prove ping, cold session B, settings, and models respond after `entered` and before the test creates `release`; `finally` releases and cleans every descendant.
2. Private frames use two dedicated inherited directional FDs with pre-deserialization JSONL bounds and exact-cap serialization; no Node object IPC remains. Worker stdout/stderr remain diagnostic-only under noisy extensions, and packaged output contains a spawnable dedicated worker entry.
3. One locked pre-spawn or immutable build-time SDK patch barrier runs before workers; workers never race shared patch writes and validate the same patch identity.
4. Coordinator traces show no `AgentSessionServices`, user extension/resource, `AgentSession`, provider/tool, or subagent work on its event loop.
5. `ColdSessionStore` preserves supported v1/v2→v3 migration, create/fork/duplicate/tree/context behavior and ownership rechecks; measurements justify coordinator or bounded-helper execution while ping remains responsive.
6. Cold create/open creates no runtime; first execution promotes exactly once and publishes runtime-ready metadata before streaming.
7. Every hot root has its own worker/process generation and sole live session-file writer. SDK-driven new/fork/clone/switch is pre-authorized and atomically transfers ownership with no destination owner overlap, including conflict, cancellation, crash-mid-transfer, and stale-write cases.
8. A blocked/crashed/killed A worker does not block or corrupt B or the coordinator; its process tree is cleaned and no operation is silently replayed.
9. Provider capacity, circuit, and half-open probe ownership remain global across workers; crash releases leases exactly once.
10. Settings/auth/catalog revisions and extension-UI requests route correctly across worker restart and reject stale generations; nested `ask_user` fallback remains actionable.
11. Pending-path hydration, independent hydration settlement, `SetModel` fencing, correlated-error single surfacing, late create reconciliation, and intentional hide all pass focused tests.
12. Producer-issued stable child IDs/attempts and full ancestor lineages address parallel, chain, and nested detail at every depth; revision remains only a cursor and legacy synthesized identities cannot own live deltas.
13. The closed coordinator→host→webview detail protocol enforces backend/worker/host/view generations, subscription owners/tombstones, `EffectRunner`/session-service routing, and key-scoped webview updates without putting detail pages in `ViewState`.
14. The authoritative contract and sync tests supersede mounted-collapsed immediate detail: collapsed cards use bounded previews with no subscription; expansion subscribes; collapse unsubscribes and discards heavy state.
15. Expansion shows the complete child transcript and live incremental reasoning/text/tool/nested-subagent updates through a bounded page-backed virtualized renderer. Evicted/offscreen pages and huge segments re-fetch exactly from live or durable authority.
16. Long output remains accessible and terminal detail is exact/durable after collapse, worker retirement, backend/session reopen, and the opt-in >64-MiB end-to-end case; gap, stale, loading, retry, rebase, and unavailable states are explicit.
17. No arbitrary fixed worker count or busy-worker eviction policy is introduced; bootstrap concurrency and idle retention defaults are configurable and justified by Windows measurements.
18. Hard correctness gates pass under realistic Windows budgets; performance telemetry is stable enough for default-on rollout.
19. `npm test`, `npm run typecheck`, `npm run extension:build`, packaged/spawned integration verification, opt-in large-detail verification, and relevant manual UX smoke checks pass.
20. `ARCHITECTURE.md`, authoritative `STATE_CONTRACT.md`, protocol tests, and the documentation index describe the implemented—not merely planned—contract.
