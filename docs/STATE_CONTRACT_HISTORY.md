# State Contract History

Completed remediation chronology for [STATE_CONTRACT.md](STATE_CONTRACT.md). This file records what was done and when so production code and the normative contract never need historical labels again. Do not reference these labels in new code, comments, or tests; state the invariant and its reason instead, and link the contract section that governs it.

## Label retirement

Production comments previously used remediation labels — `Brief A`–`Brief H`, `Phase 0`–`Phase 6`, `REM-0x`, `Bug n`, `FIX` — that explained chronology rather than the invariant a maintainer must preserve. They were rewritten into current invariant/reason wording. A few occurrences intentionally remain as runtime evidence and must not be treated as comments:

- `REQUEST_IN_PROGRESS`-style backend error strings such as "requires Phase 4 isolated-runtime routing" are pinned by tests and remain literal protocol evidence.
- File/test names containing old labels (for example legacy fixture names) are historical identifiers, not comments.

## UX reliability remediation series (Brief A–H)

A consolidated send/interrupt/error UX pass, superseded by the reducer-owned operation registry ([STATE_CONTRACT.md § Execution Ordering](STATE_CONTRACT.md)):

- **Brief A** — every production send mints a host-owned stable `operationId`; rollback snapshot payloads (`inputs`, `previousSummary`, `localId`) are carried on the pending op.
- **Brief B** — bounded send acknowledgement timers via `RequestTracker`/`BackendClient`, with a known-error classification contract consumed by the error mapper.
- **Brief C** — webview composer-input restore wiring: `sendRejected` carries `inputs`, staged as a transient override of `pendingComposerInputs` until the next confirming snapshot.
- **Brief E** — interrupt/edit responsiveness: best-effort pre-ack abort plus enqueued `message.interrupt`; post-commit interrupt never rolls back; edit truncate fences local cancellation.
- **Brief F** — pruning-prepass phase visibility: `prepassStartedAt` ViewState field and the per-session prepass status chip driven by the send lifecycle.
- **Brief H** — user-facing error mapping: raw RPC errors mapped to plain-language notices with correct severity, action labels, and no internal request IDs at the renderer boundary.

## Session runtime isolation phases (Phase 0–6)

The backend/host isolation migration, superseded by the current runtime-free coordinator and worker architecture ([STATE_CONTRACT.md § Execution Ordering](STATE_CONTRACT.md), `docs/ARCHITECTURE.md`):

- **Phase 0** — structured process/runtime evidence trace stages (metadata only).
- **Phase 1** — session-routing invariant: every command carries an explicit `sessionPath`; no implicit viewed/active fallback.
- **Phase 2** — CQRS/Elm-style reducer cutover: `Command`/`Effect` type spines, reducer-owned optimistic reconciliation routing, worker ping/liveness, and explicit worker restart.
- **Phase 3** — runtime-free coordinator operations and cold-session ownership adoption; message routing through the reducer.
- **Phase 4** — isolated per-session worker runtimes: dedicated worker command frames, coordinator-side routing/validation, optimistic-update reconciliation, and the conservative cross-worker provider admission fence.
- **Phase 5** — page-backed detail subscription for large tool results and recursive subagent transcripts (`detail.subscribe`/`detail.unsubscribe` protocol, renderer generation fences, coordinator durable paged authority). Phase 5.2 fixed a `sendRejected` regression, now guarded by a compile-time exhaustiveness check.
- **Phase 6** — worker runtime host/router hardening: coordinator-owned provider capacity/circuit authority and monotonic coordinator→worker sync (auth fingerprint refresh, open-tab registry).

## Subagent and provider resilience (REM items, Bug fixes)

Remediation recorded in `docs/HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md`; invariants live in [STATE_CONTRACT.md § Execution Ordering](STATE_CONTRACT.md) and the subagent extension tests:

- **REM-03** — bounded per-attempt retry analytics, provider-aware failover excluding configured provider models, structured `Retry-After` handling, and billable evidence for every dispatched attempt.
- **REM-04** — token-rate activity classification distinguishing generating, tool-executing, and provider-waiting states.
- **REM-06** — productive runs beyond a fixed wall-clock deadline, different-provider recovery, late-event fencing, orphan observability, and sibling preservation.
- **Bug 1–3** — interrupt-hardening fixes for abort/teardown races covered by `extensions/subagent/test/interrupt-hardening.test.ts`.

## Stability architecture milestones

The completed stability architecture plan was retired on 2026-09-05 under the repository convention that `*_PLAN.md` files describe only active work. Its durable outcomes are:

- **Milestone 0** (2026-09-05) — canonical traversal policy, deterministic operation-schedule/fault-injection baselines, two-process deferred-trigger claim races, redacted structured tracing, active-session publication reproduction, accounting fixtures.
- **Milestone 1** (2026-09-05) — authoritative continuation/activity capabilities, durable deferred-trigger claiming, explicit compaction outcomes, bounded transitions, severity-correct typed incidents, renderer-boundary redaction, context/cost corrections, and restored active working-time intervals.
- **Milestone 2** (2026-09-05) — reducer-owned common operation registry across create/duplicate/open/close/restart/send/edit/interrupt/continue/compact; idempotent backend mutations; correlated `agent.settled` lineage; generic effect state reduced to opaque execution resources.
- **Milestone 3** (2026-09-05) — conserved billable accounting: idempotent invocation ledger and correlated activity timeline owning all usage/cost/working-time surfaces; cross-process transaction lock and privacy fences.
- **Milestone 4** (2026-09-04) — non-disruptive publication: separate compile/publish/activate concepts, immutable generation-addressed renderer output with append-only selection marker, no ordinary manifest rewrites, explicit activation with exact identity checks.
- **Milestone 5** (2026-09-05, commits 2a–2d) — consolidation: session-operation effect controller, split backend request handlers and SDK event processing by domain, billable-accounting/completed-history-cache/aggregate-pricing-cache module ownership, registry single-sourcing, and documentation restructure (normative contract split from implementation notes and this history).

## Documentation structure (2026-09-05)

`STATE_CONTRACT.md` was restructured: normative guarantees remain in the contract; transport/protocol mechanics, byte budgets, thresholds, and file mappings moved to [STATE_CONTRACT_IMPLEMENTATION.md](STATE_CONTRACT_IMPLEMENTATION.md); completed remediation chronology moved to this file. Contract section headings were preserved so existing references and tests remain valid.