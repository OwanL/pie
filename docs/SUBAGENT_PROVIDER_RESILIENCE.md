# Subagent and provider resilience

**Status:** Implemented operational reference. The core resilience model below is in place and covered by focused reliability suites; the remaining items are nonblocking optional follow-ups (see the end), not P0 gaps.

**Scope:** `extensions/subagent/`, provider request lifecycle, queued messages, and operational analytics.

## Origin

A July 2026 hardening pass force-settled a parallel scout run that stayed open for 30 minutes: children were left in `streaming`/`waiting for model response`, child `session.abort()` calls did not settle during the diagnostic grace, and the terminal result replaced known child details with an empty `results[]`. The original containment (a 15-minute total wall-clock timeout) conflated useful long-running work with inactivity. It was replaced by the progress-aware model documented here.

## Implemented resilience model

### Renewable inactivity settlement (no total-duration deadline)

There is no normal overall runtime deadline. `execute()` arms a renewable outer inactivity net instead:

- Default settlement budget **12 minutes** of *inactivity*, not of runtime (`PIE_SUBAGENT_SETTLEMENT_MS` overrides; `0` disables the net for debugging). Every credible progress publication renews the lease, so a productive child can run for 30+ minutes.
- Active leases follow the child's observable phase (`PHASE_INACTIVITY_MS` in `src/execute.ts`): `queued` 10 min, `preparing` 2 min, `waiting_provider` 5 min, `streaming` 3 min, `running_tool` 15 min, `retry_wait` 3 min, `orphaned_cleanup` 1 min. The max active child-phase budget owns the lease; provider queue/header liveness is additionally bounded by `ProviderGate`.
- After the deadline fires, the dispatch gets `PIE_SUBAGENT_SETTLEMENT_GRACE_MS` (default 5 s) to surface its own abort result before a synthesized terminal error is emitted.
- Progress is generation-fenced: a stale `5 → 4 → 5` sequence inside one attempt is rejected, and duplicate terminal callbacks never renew a lease that is already armed.

### Bounded local settlement and cleanup

Local completion never depends on remote teardown:

- terminal child state is owned locally and set exactly once (compare-and-set);
- concurrency/tree permits are released exactly once by the local owner even if remote teardown is orphaned;
- latest known child details are preserved at the execute boundary — a force-settled parent retains partial/completed `results[]`, never an empty replacement;
- remote abort/dispose runs in a bounded background cleanup path via the orphan registry (`src/cleanup.ts`): cleanup that fails or exceeds grace stays observable (typed errors, attempt-identity counters) without blocking settlement or a subsequent send;
- late events from an old attempt cannot revive a terminal child (generation high-water fencing).

### Provider retry, failover, and circuit breaking

- Bounded per-attempt retry with exponential backoff; structured `Retry-After` hints (numeric seconds and HTTP-date) are honored against the injected clock. `retry_wait` is published as an active lifecycle phase, so its lease is real.
- Provider-aware failover excludes every configured model belonging to the failed provider; auth/permission failures are never retried; mid-stream failures terminate the attempt visibly and preserve partial output instead of silently replaying a turn that already produced output or tool side effects.
- `extension/src/backend/provider-gate.ts` owns shared provider admission: concurrency slots with owner-affine afterburn, response-header liveness, an account-pause circuit breaker, and a shared transport circuit with exponential-cooldown half-open probes. One provider outage cannot cause a retry storm across parallel children.

### Queued messages

Queued user messages are correlated (`queuedLocalIds` → `QueuedDelivered`) and delivered FIFO; `EditQueued` and `ClearQueue` let the user edit or discard queued entries. Queued messages are never silently discarded and cannot hold a turn immortal. Warm-bash remains non-gating; its marker protocol handles every stdout chunk boundary deterministically.

### Truthful parent/transcript state

A child is exactly one of `queued → preparing → waiting_provider → streaming ↔ running_tool → retry_wait → completed | failed | cancelled | orphaned_cleanup`. Transitions are monotonic except documented streaming/tool cycles; every terminal child remains renderable; a terminal parent cannot contain a running child; partial output and completed sibling results survive another child's failure; error text distinguishes timeout, provider outage, auth, cancellation, and orphaned cleanup.

## Acceptance evidence

Deterministic fake-provider/SDK scenarios with injected clocks (no real-time sleeps) map to:

| # | Scenario | Test evidence |
|---|---|---|
| 1 | Never returning headers | `extension/test/backend/models/provider-gate.test.ts` — stalled headers time out and release the slot |
| 2 | Headers then no first token | `subagent-provider-resilience.test.ts` — provider wait expires on the injected inactivity clock |
| 3 | Productive run beyond the old 15-minute deadline | `subagent-provider-resilience.test.ts` — 15+ simulated minutes renew the real settlement clock seam |
| 4 | Mid-stream disconnect | `subagent-provider-resilience.test.ts` — partial output preserved, no replay |
| 5 | 429 with/without `Retry-After` | `retry.test.ts` (hints, deterministic clock, bounded fallback) + `subagent-provider-resilience.test.ts` (execute-level injected clock, observable `retry_wait`, different-provider success) |
| 6 | 5xx burst then recovery | `provider-gate.test.ts` — half-open 503 reopens, later recovery closes |
| 7 | Auth failure | `retry.test.ts` — never retried; `provider-failure.test.ts` — classified terminal |
| 8 | Output followed by hung tool | `settlement.test.ts` + `subagent-provider-resilience.test.ts` — output retained when the tool phase expires |
| 9 | `abort()` never settles | `interrupt-hardening.test.ts` — local settlement; `orphan-cleanup.test.ts` — detached cleanup observable |
| 10 | Late deltas after terminal state | `modes.test.ts` — stale retry-attempt update fenced; `subagent-provider-resilience.test.ts` — generation high-water rejects stale progress |
| 11 | One hung child among successful siblings | `settlement.test.ts` — completed/partial details survive force settlement; native sibling tool calls settle independently |
| 12 | Circuit open while another provider healthy | `provider-gate.test.ts` + `retry.test.ts` (provider exclusion) + `subagent-provider-resilience.test.ts` (different-provider recovery) |

**Test files:** `extensions/subagent/test/{retry,settlement,interrupt-hardening,orphan-cleanup,provider-failure,provider-capacity,subagent-provider-resilience}.test.ts`, `extension/test/backend/models/provider-gate.test.ts`.

## Operational analytics

The host ingests terminal `attemptRecords` into `RunSnapshot.subagentAttemptSamples` and aggregates attempt duration, runner phases, retry/backoff, attempt outcomes, and telemetry coverage across completed and open runs (`extension/src/host/run-analytics/`, `extension/src/host/stats-service/`). Every value preserves `reported`/`measured`/`estimated`/`unknown` provenance; malformed or legacy calls remain explicitly unknown and terminal delivery is idempotent.

## Nonblocking optional follow-ups

These are quality/telemetry refinements, not stability gaps; the resilience model does not depend on them:

- **Dwell-watchdog UX for queued messages** — an elapsed-wait indicator with current blocker plus a hard-threshold offer (Stop current turn / Keep waiting / Remove queued message) and backend-restart queue reconciliation. The underlying queue is already FIFO, correlated, editable, and clearable, so nothing is silently discarded or immortal.
- **Finer producer telemetry** — separately observing provider-gate queue versus header/first-token/stream-idle subphases; carrying the parent settlement source in child attempt records; correlating eventual asynchronous orphan cleanup back into the terminal result as a reported `cleanupOutcome` (host aggregation already accepts and surfaces it when reported).

## Relevant files

- `extensions/subagent/runner.ts`, `src/execute.ts` — settlement net, phase leases, progress fencing, terminal synthesis.
- `extensions/subagent/src/{single,modes}.ts` — per-attempt orchestration, retry/failover, sibling aggregation.
- `extensions/subagent/src/{retry,provider-failure,provider-capacity,cleanup}.ts` — backoff/`Retry-After`, classification, model exclusion, orphan registry.
- `extensions/subagent/src/concurrency-limit.ts` — process-level permit ownership.
- `extension/src/backend/provider-gate.ts` — shared provider admission/circuit/afterburn.
- `extension/src/backend/session-event-handler.ts`, `extension/src/host/core/reducer/streaming-handlers.ts` — queued-message delivery and transcript reconciliation.
- `extension/src/shared/subagent-result.ts` — transcript compatibility/fallback rendering (still useful for legacy results; new runtime results are complete without it).