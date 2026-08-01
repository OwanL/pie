# Architecture

## 1. System Overview

pie is a VS Code extension that provides a chat interface to a local PI (Programming Intelligence) backend. Three processes cooperate:

- **PI backend** — a separate process communicating via JSON-RPC over stdio. Executes language-model calls, tool invocations, and session persistence.
- **Extension host** — the VS Code extension process. Owns all application state, serializes mutations, and projects state to the webview.
- **Webview** — a Preact single-page app rendered in a VS Code sidebar panel. Displays the chat UI and dispatches user intents back to the host.

---

## Transport and Backend Lifecycle

Stdio uses UTF-8 JSONL with a shared **32 MiB per-record limit**, enough for a supported 10 MiB raw image after base64 encoding plus envelope headroom. Readers retain bounded memory, discard an overlong record through LF, and then recover. Oversized stdin requests receive a correlated `REQUEST_TOO_LARGE` response when their ID is present in the bounded preview; an oversized correlated response is replaced with `RESPONSE_TOO_LARGE`; an oversized critical event is fatal. Backend stdout writes are serialized with bounded response/event lanes. Live protocol v5 tool progress uses a full initial preview followed by base-revision structural patches and carries backend-calculated canonical/aggregate byte metadata. The host maintains matching per-execution/turn counters, so patch processing updates one execution without serializing every accumulated sibling preview. Only contiguous same-tool patch ranges may be composed while queued; their combined envelope retains the original base and newest sequence. Intervening lifecycle records prevent composition, terminals remain ordered and durable, and the host repairs any missing or incompatible range from the backend's bounded in-memory canonical checkpoint.

The host distinguishes intentional stops from unexpected, generation-tagged exits. Intentional stop during startup rejects that child’s readiness wait, and an old-generation exit cannot clear a replacement process. Unexpected exits terminalize orphaned in-flight state and preserve a classified interruption notice. There is no automatic backend restart; restart remains an explicit user action.

### Computer-use runtime isolation

The generic `computer` pi extension adds a separate native sidecar boundary below the PI backend. Each durable pie session owns one lazy Node child that loads Cua Driver and NutJS and communicates through bounded JSONL; screenshots and sequence traces remain artifact files. Exact PID/HWND and foreground validation gates global physical input, while parent/child held-input ledgers provide cancellation, timeout, restart, close, and shutdown release barriers. The webview's ordinary tool-result renderer displays mixed text/image content; no computer-specific host state or transcript component is introduced. See [COMPUTER-USE.md](COMPUTER-USE.md) for the full contract and evidence.

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

1. Webview dispatches `{ type: 'sendMessage', sessionPath, text, inputs }`.
2. `extension-host.ts` wraps it as a `Send` Command with a fresh `corrId` + local message ID.
3. Reducer inserts an optimistic user message into `state.pending[corrId]` and returns a `SendRpc` effect.
4. EffectRunner routes the RPC through `enqueueLifecycle → enqueueSessionOperation`.
5. On success: `SendRpcResult` event promotes the pending entry to authoritative.
6. On failure: reducer reverts via the snapshot in `state.pending[corrId]`.

### Streaming assistant reply

1. Before the provider call, the backend creates an in-memory turn accumulator with opaque turn/attempt IDs and a monotonic sequence.
2. Provider transport observations classify gate queue, header wait, headers received, raw chunks, retry, tool work, and teardown. Raw chunks never renew the semantic inactivity lease.
3. SDK observations become typed `live.semantic` envelopes. Invalid observations consume a sequence as `observation.rejected`; each tool input and progress/terminal preview is normalized to a bounded representation. There is no total tool-count limit: after durability is confirmed, the backend accumulator semantically compacts older settled-tool input/result payloads while retaining their lifecycle identity and a detailed recent tail.
4. The host validates each envelope and reduces it into `ArchState.livePipeline`. Gaps, rejected observations, unknown owners, and a missing final sequence request `liveTurn.checkpoint` through the EffectRunner. A compact repair checkpoint does not overwrite richer durability-confirmed tool details that the host already received, so normal rendering does not regress after repair.
5. Projection joins durable transcript rows with the active live turn, replaces large detail bodies with compact `LazyDetailRef` metadata, and posts a full `ViewState` through the one-post delivery controller. Expanding a detail deduplicates a bounded retrieval from the durable backend transcript or host-owned live state and sends the body once as an imperative response.
6. The webview reports receipt, app commit, signed transcript-leaf commit, and paint as separate protocol-v4 evidence.
7. SDK assistant/tool terminal callbacks are hot-patched to publish only after durable append returns a stable entry ID. The host then commits the durable terminal message and clears live state in one reducer transaction. Restart/reopen never replays a tool and normalizes dangling persisted work to interrupted.

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
  configured, the embedded SDK keeps its own defaults. The backend uses the
  canonical session root for create and fork, and listing reads it (plus its
  per-cwd subdirectories) exclusively — the legacy `<agentDir>/sessions` root is
  retired once a canonical root is configured. The installer's verified copy/merge
  is the authority for legacy content, and `npm run doctor` detects any newly
  stranded legacy sessions instead of the runtime scanning legacy roots forever.
  Listing caches a path-deduplicated canonical inventory, overlays live sessions
  and fresh reviews, and polls a cheap JSONL filename signature so external
  additions/removals invalidate the cache. Missing roots count as empty;
  inaccessible roots retain the last complete catalog until a safe refresh.
  Explicit resume/recovery paths remain migration-free.

### Host ↔ Webview

- Unidirectional state flow: host → webview via snapshots; webview → host via message commands.
- Per-session revision counter detects missed snapshots; recovery is a full snapshot.
- `hostInstanceId` detects extension restarts; webview resets all mirrors on change.
- `WEBVIEW_PROTOCOL_VERSION` prevents version skew between host and webview code.

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

## 9. Invariants

1. **Reducer purity** — `(State, Event) → { state, effects }`. No I/O, no `Date.now()`, no randomness.
2. **Single effect executor** — side effects only happen in the EffectRunner.
3. **Webview passivity** — the webview dispatches Commands and applies snapshots. It never mutates logic state.
4. **Session addressing** — every snapshot and session-scoped event carries `sessionPath`.
5. **Optimistic correlation** — pending ops are tagged with `corrId` and reconciled by `EffectResult`.
6. **Background preservation** — snapshots to non-active sessions update their mirrors; they are never dropped.
7. **Record-only state** — `Record<string, T>` for keyed collections (no Map/Set in host state).
8. **Serialized execution** — session RPCs are FIFO-ordered through the lifecycle + session queues.

See [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md) for additional invariants (snapshot recovery, cleanup, selection ownership).

---

## 10. Module Map

| Directory | Responsibility |
|-----------|---------------|
| `extension/src/host/core/` | Pure CQRS spine: reducer, effects, events, commands, projection, dispatch |
| `extension/src/host/session-service/` | Backend client lifecycle, session startup, tab actions, message actions |
| `extension/src/host/sidebar/` | Webview provider, sync state machine, hot reload |
| `extension/src/host/stats-service/` | Run analytics tracking, persistence, query |
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
