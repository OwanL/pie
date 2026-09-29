# Subagent and provider resilience

**Status:** Implemented operational reference. The core resilience model below is in place and covered by focused reliability suites; the remaining items are nonblocking optional follow-ups (see the end), not P0 gaps.

**Scope:** `harness/tools/subagent/` (discovered through the `extensions/subagent/index.ts` shim), provider request lifecycle, queued messages, and operational analytics.

## Implemented resilience model

### Settlement ownership (no absolute/inactivity/phase settlement timer)

Elapsed time alone cannot distinguish useful long-running work from a stalled child, so it must not force settlement.

There is no absolute, inactivity, or phase settlement timer — no settlement net, phase lease, or prompt timer. `execute()` arms no elapsed-time force settlement: a healthy long-running child stays alive until it completes or is explicitly cancelled. Settlement is owned by:

- **local terminal CAS** — terminal child state is owned locally and set exactly once by compare-and-set, never synthesized from elapsed time;
- **explicit parent/user cancellation** — an `AbortSignal` cancellation settles the dispatch promptly and preserves partial output in `results[]`;
- **exact completion** — a real child result is returned unsynthesized; a productive run can exceed any historical phase budget (tests cover 15+ simulated minutes);
- **provider bounds** — provider queue/header/body deadlines in `provider-gate.ts` plus per-attempt retry/backoff policy in `harness/tools/subagent/{retry,provider-capacity}.ts` bound how long a dispatch can wait on a dead provider;
- **generation fencing** — `progressGeneration` sequences and attempt identity fence stale progress from a retired attempt so it cannot revive a terminal child; and
- **bounded detached cleanup** — the orphan registry (`harness/tools/subagent/cleanup.ts`) disposes failed or late remote teardown observably.

### Bounded local settlement and cleanup

Local completion never depends on remote teardown:

- terminal child state is owned locally and set exactly once (compare-and-set);
- concurrency/tree permits are released exactly once by the local owner even if remote teardown is orphaned;
- latest known child details are preserved at the execute boundary — a cancelled or locally settled parent retains partial/completed `results[]`, never an empty replacement;
- remote abort/dispose runs in a bounded background cleanup path via the orphan registry (`harness/tools/subagent/cleanup.ts`): cleanup that fails or exceeds grace stays observable (typed errors, attempt-identity counters) without blocking settlement or a subsequent send;
- late events from an old attempt cannot revive a terminal child (generation high-water fencing).

### Provider retry, failover, and circuit breaking

- Bounded per-attempt retry with exponential backoff; structured `Retry-After` hints (numeric seconds and HTTP-date) are honored against the injected clock. `retry_wait` is published as an active lifecycle phase, so the wait stays observable without being bounded by any settlement timer.
- Provider-aware failover excludes every configured model belonging to the failed provider; auth/permission failures are never retried; mid-stream failures terminate the attempt visibly and preserve partial output instead of silently replaying a turn that already produced output or tool side effects.
- [`provider-gate.ts`](../../harness/model-providers/concurrency/provider-gate.ts) owns the coordinator-local in-process fetch gate, installed by [`coordinator/server.ts`](../../harness/agent-processes/coordinator/server.ts): concurrency slots with owner-affine afterburn, response-header liveness, an account-pause circuit breaker, and a transport circuit with exponential-cooldown half-open probes. Cross-worker capacity and circuit admission instead belong to [`coordinator-provider-network-lease.ts`](../../harness/model-providers/concurrency/coordinator-provider-network-lease.ts); workers do not install an independent `ProviderGate` ([`worker-runtime-host.ts`](../../harness/agent-processes/workers/worker-runtime-host.ts)). One provider outage cannot cause a retry storm across parallel children.

### Queued messages

Queued user messages are correlated (`queuedLocalIds` → `QueuedDelivered`) and delivered FIFO; `EditQueued` and `ClearQueue` let the user edit or discard queued entries. Queued messages are never silently discarded and cannot hold a turn immortal. Warm-bash remains non-gating; its marker protocol handles every stdout chunk boundary deterministically.

### Truthful parent/transcript state

A child is exactly one of `queued → preparing → waiting_provider → streaming ↔ running_tool → retry_wait → completed | failed | cancelled | orphaned_cleanup`. Transitions are monotonic except documented streaming/tool cycles; every terminal child remains renderable; a terminal parent cannot contain a running child; partial output and completed sibling results survive another child's failure; error text distinguishes timeout, provider outage, auth, cancellation, and orphaned cleanup.

## Acceptance evidence

Deterministic fake-provider/SDK scenarios with injected clocks (no real-time sleeps) map to:

| # | Scenario | Test evidence |
|---|---|---|
| 1 | Never returning headers | `harness/model-providers/concurrency/test/provider-gate.test.ts` — stalled headers time out and release the slot |
| 2 | Headers then no first token | `subagent-provider-resilience.test.ts` — the stalled provider wait stays alive until explicit cancellation; no elapsed-time bound fires (provider/header liveness remains `provider-gate.test.ts`'s contractual deadlines) |
| 3 | Productive run beyond the old 15-minute deadline | `subagent-provider-resilience.test.ts` + `settlement.test.ts` — 15+ simulated minutes complete normally with no settlement timer armed |
| 4 | Mid-stream disconnect | `subagent-provider-resilience.test.ts` — partial output preserved, no replay |
| 5 | 429 with/without `Retry-After` | `retry.test.ts` (hints, deterministic clock, bounded fallback) + `subagent-provider-resilience.test.ts` (execute-level injected clock, observable `retry_wait`, different-provider success) |
| 6 | 5xx burst then recovery | `provider-gate.test.ts` — half-open 503 reopens, later recovery closes |
| 7 | Auth failure | `retry.test.ts` — never retried; `provider-failure.test.ts` — classified terminal |
| 8 | Output followed by hung tool | `settlement.test.ts` + `subagent-provider-resilience.test.ts` — the hung tool phase stays alive and retains the output until explicit cancellation |
| 9 | `abort()` never settles | `interrupt-hardening.test.ts` — local settlement; `orphan-cleanup.test.ts` — detached cleanup observable |
| 10 | Late deltas after terminal state | `modes.test.ts` — a stale trailing update from a failed retry attempt is fenced by attempt identity; runner progress generations dedupe replayed snapshots so late events cannot revive a terminal child |
| 11 | One hung child among successful siblings | `subagent-provider-resilience.test.ts` — a cancelled child preserves partial/completed `results[]`; `interrupt-hardening.test.ts` — parallel sibling abort settles each child locally |
| 12 | Circuit open while another provider healthy | `provider-gate.test.ts` + `retry.test.ts` (provider exclusion) + `subagent-provider-resilience.test.ts` (different-provider recovery) |

**Test files:** `harness/tools/subagent/test/{retry,settlement,interrupt-hardening,orphan-cleanup,provider-failure,provider-capacity,subagent-provider-resilience}.test.ts`, `harness/model-providers/concurrency/test/provider-gate.test.ts`.

## Operational analytics

The host ingests terminal `attemptRecords` into `RunSnapshot.subagentAttemptSamples` and aggregates attempt duration, runner phases, retry/backoff, attempt outcomes, and telemetry coverage across completed and open runs (`analytics/legacy/run-analytics/`, `application/backend/analytics-views/`). Every value preserves `reported`/`measured`/`estimated`/`unknown` provenance; malformed or legacy calls remain explicitly unknown and terminal delivery is idempotent.

## Nonblocking optional follow-ups

These are quality/telemetry refinements, not stability gaps; the resilience model does not depend on them:

- **Queued-message dwell UX** — an elapsed-wait indicator with current blocker plus an explicit user offer (Stop current turn / Keep waiting / Remove queued message) and backend-restart queue reconciliation. The underlying queue is already FIFO, correlated, editable, and clearable, so nothing is silently discarded or immortal; any threshold remains a user choice, not an automatic abort.
- **Finer producer telemetry** — separately observing provider-gate queue versus header/first-token/stream-idle subphases; correlating eventual asynchronous orphan cleanup back into the terminal result as a reported `cleanupOutcome` (host aggregation already accepts and surfaces it when reported).
