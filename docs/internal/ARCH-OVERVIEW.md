# Architecture Overview — Developer Onboarding

**Pattern:** CQRS-shaped Elm/MVI
**Authoritative contract:** [`docs/STATE_CONTRACT.md`](../STATE_CONTRACT.md)
**Migration plan:** [`docs/ARCHITECTURE.md §10`](../ARCHITECTURE.md)

> **Note:** The CQRS/Elm/MVI migration is **complete**. All webview→host flow goes through Command→reducer→Effect→runner. See [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) for the full architecture. The file map below reflects the current codebase.

---

## Three Processes

| Process | Role | Entry point |
|---------|------|-------------|
| PI backend | Language model + tool execution | External; communicates via JSON-RPC stdio |
| VS Code extension host | State, effects, projection, webview transport | `extension/src/host/extension-host.ts` |
| Webview (Preact) | Render + user input | `extension/src/webview/panel/app.tsx` |

---

## Spine Files

All core architecture types live in `extension/src/host/core/`:

| File | Responsibility |
|------|----------------|
| `commands.ts` | `Command` discriminated union — intents from webview. Each carries `corrId` + `sessionPath`. |
| `events.ts` | `Event` discriminated union — inputs to the reducer (commands, backend events, effect results). |
| `effects.ts` | `Effect` discriminated union — side-effect descriptors grouped into namespaces (`SessionRpc`, `SessionLifecycle`, `FileOperation`, `Notification`). |
| `reducer.ts` | Pure function `(ArchState, Event) → { archState, effects }`. No I/O. |
| `effect-runner.ts` | Executes effects and posts observations back to the reducer. Retains opaque timers/controllers/promises only; semantic lifecycle state lives in `ArchState.operations`. |
| `projection.ts` | Pure function `ArchState → ViewState`. Computes what the webview should display. |
| `event-dispatch.ts` | Dispatches raw backend JSON lines — read + `JSON.parse`d in `host/backend/client.ts` (`attachJsonlLineReader`, `JSON.parse`) — as typed `BackendEvent` objects to the reducer. |
| `message-router.ts` | Converts `WebviewToHostMessage` into `Command` objects and dispatches to the reducer. |

All application state lives in `ArchState` — no separate Redux store.

---

## Information Flow

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
       Per-session snapshot channel          - PostImperative
                │                           - Analytics export
                ▼                           Results → Event
       Webview mirror[sessionPath]
                │
                ▼
       Render active session
```

---

## ArchState Sub-States

| Sub-state | Contains | Former slice |
|-----------|----------|-------------|
| `transcript` | Messages, deltas, tool calls, pruning results, message status, editing state | `transcript-slice` + editing from `ui-slice` |
| `sessions` | Session list, running states, unread marks, active path | `sessions-slice` |
| `settings` | Model settings, chat prefs, pruning config, available models, backend ready | `settings-slice` + `ui-slice` (backendReady) |
| `composer` | Pending composer inputs, active run summaries | `session-state-slice` (partial) |
| `fileChanges` | File change entries, derived state | `file-changes-slice` |
| `pending` | Exact optimistic rollback snapshots and execution queues | was already in `ArchState` |
| `operations` | Stable operation identity, source/causality, session/branch and process generations, phase/ack/commit/reconciliation, recovery, immutable terminal outcome | common lifecycle registry |

---

## Glossary

| Term | Definition | Source file |
|------|-----------|-------------|
| **Command** | Webview → host intent, carries `corrId` | `host/core/commands.ts` |
| **Event** | Reducer input (command, backend event, or effect result) | `host/core/events.ts` |
| **Effect** | Plain data describing a side effect, grouped by namespace | `host/core/effects.ts` |
| **EffectRunner** | Executes effects and retains opaque execution resources only | `host/core/effect-runner.ts` |
| **Operation registry** | Reducer-owned lifecycle authority for accepted state-changing actions | `host/core/operation-types.ts`, `host/core/operation-registry.ts` |
| **Projection** | `ArchState → ViewState` | `host/core/projection.ts` |
| **ArchState** | All application state, nested into sub-states | `host/core/arch-state.ts` |
| **Snapshot** | Full ViewState for recovery | `shared/protocol.ts` |
| **Mirror** | Webview-side cache of ViewState per session | `webview/panel/hooks/use-host-sync.ts` |

---

## Key Invariants

1. The reducer is pure — no I/O, no `Date.now()`, no randomness.
2. Side effects only happen inside the EffectRunner.
3. Webview never mutates logic state directly — it dispatches Commands and applies Patches/Snapshots.
4. Every Patch and session-scoped backend event carries an explicit `sessionPath`.
5. Stable `operationId`/attempt—not transport `corrId` or queue membership—owns lifecycle truth and one immutable terminal outcome.
6. `agent.settled` is accepted only for matching operation/request/turn/attempt and backend/worker generation lineage.
7. Optimistic state uses `corrId` only for exact rollback and imperative response targeting.
8. Background-tab snapshots update that tab's mirror; they are never dropped.
9. Host state uses `Record<string, T>` only (no `Map`/`Set`).
10. See `STATE_CONTRACT.md` for the full set.

---

## Effect Routing

| Effect category | Queue path |
|-----------------|----------|
| `SessionRpc` (Send, Edit, Interrupt, Truncate, ExtensionUiResponse) | Per-session FIFO; queue membership is execution-only |
| `SessionLifecycle` (Open, Create, Duplicate) | Global lifecycle FIFO |
| `CloseSession` | Host cleanup plus reducer-joined persistence/cleanup acknowledgements |
| `RestartBackend` | Configuration drain → confirmed old-generation death → replacement start; phases are reducer events |
| `FileOperation` (Diff, Revert, OpenFileInEditor) | Direct execution, no queue |
| `PostImperative` (sendRejected) | Direct execution, fire-and-forget |
| `Log` | Direct execution, no queue |
| `PersistTabs` | Dedicated ordered persistence queue (never lifecycle/session queues) |
| `HydrateModel` | Direct execution, fire-and-forget |
| `DrainPendingSendQueue` / `DrainBackendReadyQueue` | Async IIFE, re-dispatches `Send` Commands |
| `StartBackendReadyWatchdog` / `CancelBackendReadyWatchdog` | Timer management, no queue |
| `ShowModelSwitchConfirm` | Modal dialog, no queue (serialized by VS Code) |

> **Note:** `FileOperation` effects are executed directly by the `EffectRunner` (no queue). `Notification` effects (`PostImperative`) are also direct. The dead `PlayCompletionSound` / `FlashWindow` effects were removed during the migration.

---

## Webview State Rules

The webview owns **only** ephemeral render concerns:
- Scroll/focus/hover/drag/animation state
- Protocol bookkeeping (revision refs, snapshot flags)
- Per-keystroke draft buffer (committed draft is host state)

Everything else is host state delivered via ViewState. See `STATE_CONTRACT.md § Webview-Local State`.

---

## Where To Make Changes

| Task | Files to touch |
|------|---------------|
| New user action | `commands.ts` → `events.ts` → `reducer.ts` → `effects.ts` → `effect-runner.ts` → `message-router.ts` |
| New backend event | `events.ts` → `backend/client.ts` (parse) + `event-dispatch.ts` (typed dispatch) → `reducer.ts` (+ `effects.ts` if side-effects needed) |
| New ViewState field | `projection.ts` → `shared/protocol.ts` → webview consumer |
| New effect type | `effects.ts` (in the right namespace) → `effect-runner.ts` → `events.ts` (result event) |
| New webview component | `webview/panel/components/` → import in `app.tsx` |
