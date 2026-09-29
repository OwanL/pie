# Architecture

Pie is a coding-agent application built around the Pi runtime. VS Code and standalone hosts share one application backend and Preact UI; host adapters supply platform capabilities rather than separate application implementations.

## Components and processes

| Component | Responsibility | Implementation |
|---|---|---|
| Application runtime | State, effects, session actions, renderer projection, and lifecycle composition through injected platform ports | `application/backend/`; composition starts in `composition/host-runtime.ts` |
| Host adapters | VS Code integration or standalone startup, browser serving, editor/file capabilities, and notifications | `application/hosts/{vscode,standalone,browser,lib}/` |
| Renderers | Shared passive Preact UI in the sidebar or browser | `application/frontend/` |
| Agent coordinator | Cold session operations, settings/catalog authority, worker routing, and provider-network admission | `harness/agent-processes/coordinator/` |
| Root workers | One isolated process per hot root, owning its Pi session/runtime, tools, and write lease | `harness/agent-processes/workers/` |
| Cold browse helper | Read-only durable transcript projection off the coordinator event loop | `harness/agent-processes/cold-browse-helper/` |
| Analytics | Capture, accounting, queries, privacy, and storage authority; recorder/query helpers run under canonical authority | `analytics/` |

The coordinator does not create an `AgentSession`. Browsing a saved session does not start execution: the first execution mutation promotes it into a worker. `ColdSessionStore` and write-lease authority remain in the coordinator; the browse helper only computes read projections. This keeps browsing separate from agent startup and prevents competing writers.

Prompt inventory discovery uses a separate one-shot worker without promoting the session. Computer-use and Playwright tools also isolate native/browser execution in sidecars; see their [computer-use](../operations/COMPUTER-USE.md) and [Playwright](../operations/PLAYWRIGHT.md) documentation.

### Single active pie host per machine

Only one application host is active per machine. An exclusive loopback listener owns this right, acquired before backend startup and held until shutdown completes. A second standalone host or VS Code window refuses to start; VS Code can request a bounded graceful handoff from standalone. It must acquire the released listener before starting its backend and never kills another host by PID.

The coordinator listener is separate from the browser server and remains loopback-only, including when browser LAN access is enabled. Ownership is machine-wide across OS user sessions. Handoff is unauthenticated local IPC within the supported single-user desktop scope; failed probes or an occupied port do not authorize takeover. The implementation is `application/hosts/lib/host-coordinator.ts`.

## State and event flow

Pie uses a CQRS/Elm-style state loop:

```text
Renderer commands / backend events / effect results
                         |
                         v
                  Pure reducer
                   /         \
                  v           v
              ArchState     Effects
                  |           |
                  v           v
              Projection   EffectRunner --> results return as events
                  |
                  v
              ViewState snapshots --> renderers
```

This makes state transitions testable without I/O and avoids competing application state in the host and UI.

- **Commands** express user intent; **events** are reducer inputs; **effects** describe work to execute outside the reducer.
- **ArchState** owns application state and semantic operation lifecycle. Keyed state uses `Record<string, T>`, not `Map` or `Set`.
- **EffectRunner** and delegated controllers own execution resources such as timers, queues, and promises, not user-visible lifecycle truth.
- **Projection** joins durable history and active live-turn state into `ViewState`.
- **Renderers** own only transient presentation state and protocol bookkeeping. Session selection, settings, editing, and committed drafts belong to the host.

For example, sending a message creates optimistic state and a stable operation identity, then emits an RPC effect. Backend observations reconcile that operation through the reducer. An RPC acknowledgement is not completion; rollback depends on definitive pre-commit failure, not merely a timeout.

## Communication and recovery

The host communicates with the agent coordinator over bounded JSONL request/response and event streams. Session-scoped messages identify their session explicitly. Worker ownership and generation checks prevent stale processes or delayed events from changing a replacement session.

Backend live events update the host's live-turn state; missing or incompatible sequences trigger checkpoint recovery rather than tool replay. Ordinary host-to-renderer state delivery uses full compact snapshots, not patches. Large tool and reasoning details are retrieved separately on expansion. Each renderer has independent delivery and recovery state, so a blocked browser or sidebar does not stall another renderer or agent execution.

Unexpected backend exit ends orphaned in-flight work with an interruption notice. Restart is explicit, not automatic. Builds stage immutable runtime generations; running hosts keep their loaded files until a normal restart, while compatible renderer updates can be published independently.

The [state contract](../contracts/STATE_CONTRACT.md) owns synchronization, lifecycle, and recovery guarantees. [Implementation notes](STATE_CONTRACT_IMPLEMENTATION.md) explain transport budgets, storage caches, and protocol mechanics. The [GUI development guide](../operations/GUI-DEVELOPMENT.md) covers publication and reload workflows.

## Ownership and dependencies

- Harness code must not depend on application or concrete host implementations. Analytics core must not depend on application state, host adapters, or harness execution code.
- The application backend uses contracts and injected platform ports, not concrete host or frontend implementations. Hosts compose the shared runtime rather than introducing another state store, reducer, or agent backend.
- Frontend dependencies, including transitive imports, must remain browser-safe: no Node APIs, SDK runtime, analytics recorder, or host adapters.
- Root `lib/` contains cross-domain low-level helpers, not domain implementations. Tool and skill policies must not import their selection coordinator.
- Contracts stay with their owner and have one definition. These boundaries apply to type-only imports too.

Session persistence belongs to `harness/session-storage/`; provider catalog, pricing, and request policy belong to `harness/model-providers/`. Tools live under `harness/tools/`, while `extensions/` supplies Pi discovery adapters. Authored instructions and their discovery live under `harness/agent-instructions/`; shared tool/skill selection orchestration lives under `harness/tool-and-skill-selection/`.

## Storage and analytics

Transcript JSONL is durable session truth. Session catalog indexes and browse caches are derived and rebuildable, not alternative transcript authorities. Explicit session paths remain distinct from execution-worker readiness.

Analytics have exactly one active authority: legacy stores by default, or the canonical SQLite store selected by a validated activation manifest. Capture is never duplicated across those authorities. Analytics persistence does not block agent execution; usage, pricing provenance, and activity timing remain separate facts rather than estimates reconstructed from transcript display.

The [analytics implementation contract](../contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) owns authority selection, data-root resolution, privacy, and the separately gated session-storage cutoff. Source support does not establish that an installation has activated either gate. The [local analysis workspace](../../analytics/analysis/README.md) reads legacy exports, not the canonical store.

## Where to make changes

The state loop lives in `application/backend/conversation-state/`:

| Change | Main entry points |
|---|---|
| User action | `message-router.ts`, `commands.ts`, `events.ts`, `reducer.ts` and its handlers |
| Side effect | `effects/effects.ts`, `effects/effect-runner.ts`; session mutations delegate to `session-operation-effect-controller.ts` |
| Backend observation | `application/backend/agent-connection/client.ts`, then `event-dispatch.ts`, `events.ts`, and reducer handlers |
| Displayed state | `projections/projection.ts`, canonical DTOs in `application/lib/protocol/`, and the relevant frontend consumer |
| Platform capability | Inject a port through application composition and implement it in the appropriate host adapter |

Keep reducer transitions pure, address session work explicitly, and test the owning behavior. See the [development skill](../../harness/agent-instructions/skills/develop-pie/SKILL.md) for commands and workflow, and the [UI philosophy](UI-DESIGN-PHILOSOPHY.md) for presentation choices.
