# Handoff: subagent and provider resilience

**Status:** In progress — core subagent/provider reliability + REM-06 acceptance evidence implemented; remaining gaps noted below
**Priority:** P0 reliability  
**Scope:** `extensions/subagent/`, provider request lifecycle, transcript rendering, queued messages, and operational analytics

## July 2026 reliability-audit update

The structural execution work described below is partially implemented:

- productive runs use a renewable outer inactivity net rather than a default short total-runtime deadline;
- child terminal ownership, exact-once permit release, and locally bounded settlement are in place;
- process permits are owned by root subagent trees and borrowed by nested descendants, preventing parent/child semaphore deadlocks at full capacity;
- parallel sibling/partial-result preservation is covered by focused tests;
- provider queue/header/stream recovery, shared circuit/active state across reconfiguration, half-open probe closure, afterburn-expiry wake-ups, and cancellation timer cleanup are implemented;
- deep nesting preserves inherited skill state and the innermost UI/subagent identity, while AbortSignal fallbacks clean up listeners on normal settlement;
- queued-message correlation (`queuedLocalIds`/`QueuedDelivered` FIFO delivery, `ClearQueue`, `EditQueued`) is implemented and tested at the backend and host-reducer levels; the §F dwell watchdog, elapsed-wait UI, and Stop / Keep waiting / Remove queued offer are proposed but not yet implemented;
- warm-bash remains non-gating and its marker protocol handles every stdout chunk boundary deterministically.

This handoff is **not yet closed**. Phase-specific outer inactivity leases,
bounded retry/`Retry-After`, provider-aware failover, generation-owned orphan
cleanup, and the deterministic fake-provider matrix are implemented. The same
injected clock now owns both execute-level settlement and retry waits, and
`retry_wait` is published as an active lifecycle so its phase lease is real
rather than dead configuration. Broader host analytics aggregation and dedicated
queued-message fake-clock coverage remain; the acceptance-gap section lists
them. Do not infer full operational closure merely from the focused reliability
suites passing.

## Why this handoff exists

A parallel scout call made during the July 2026 hardening pass remained open for 30 minutes and was force-settled. Some children were still marked `streaming` or `waiting for model response`; backend logs also showed child `session.abort()` calls that did not settle during the five-second diagnostic grace.

The first response changed `PI_SUBAGENT_TIMEOUT_MS=0` to fall back to a 15-minute wall-clock timeout. That is only a temporary containment measure. It prevents an immortal parent tool call, but it is not the desired resilience model:

- a useful subagent may legitimately work for more than 15 minutes;
- a slow provider is not necessarily a failed provider;
- tool-heavy subagents can make steady progress without model tokens for long periods;
- terminating by total elapsed time conflates useful work with inactivity;
- a fixed deadline does not repair provider connections, release broken teardown, or explain what phase is blocked.

**The target design must bound stalled phases, not the total duration of productive work.** Once the progress-aware lifecycle below is implemented and tested, the 15-minute overall timeout should be removed as the normal control path. A much longer last-resort containment ceiling may remain only as defense in depth.

## Reproduced incident

Parent tool call:

```text
mode: parallel
children: 4 scouts
started: 2026-07-11 01:02 UTC
force-settled: 2026-07-11 01:32 UTC
```

Persisted terminal result:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Subagent did not settle within 1800s and was force-settled."
    }
  ],
  "details": {
    "mode": "parallel",
    "results": []
  }
}
```

Observed backend events included:

- `subagent force-settled`;
- children in `streaming` and `waiting for model response`;
- `child.abort.invoked`;
- `child.dangling-detected` with `session.abort() did not settle within 5s`.

The final empty `results` array also caused the rich subagent UI to disappear. A completed first-pass fix now reconstructs failed child cards from the immutable tool input, but the execution layer should preserve actual last-known child details instead of requiring UI reconstruction.

## Reliability contract

### 1. Productive work has no short wall-clock deadline

A run may continue while it produces credible progress. Progress includes more than model text:

- provider queue position or circuit-breaker state changes;
- response headers received;
- reasoning/text deltas;
- tool start, output, heartbeat, and completion;
- retry attempt/backoff transitions;
- nested subagent state changes;
- compaction or branch-summary transitions;
- queued user-message delivery.

Each credible progress event renews a **liveness lease**. Total runtime is recorded for observability, not used as the primary kill switch.

### 2. Every blocking phase is independently bounded

Use phase-specific inactivity budgets rather than one run timer:

| Phase | Required bound/recovery |
|---|---|
| provider-gate queue | bounded queue wait or visible continued-wait state; circuit breaker may extend while its state changes |
| connection / headers | header timeout; classify as retryable transport failure |
| pre-first-token | model-start idle budget; retry/failover policy |
| active stream | stream-idle budget renewed by every meaningful delta/heartbeat |
| tool execution | tool-owned timeout/heartbeat; provider watchdog must not kill a healthy tool |
| retry backoff | explicit deadline and attempt count |
| abort/teardown | short grace, then detach locally and quarantine the orphan; never await indefinitely |
| concurrency permit | released by the local owner even if remote teardown remains orphaned |

A provider slowdown may extend latency, but it cannot leave a phase with no progress and no terminal decision indefinitely.

### 3. Local completion must not depend on remote teardown

`session.abort()` is advisory cleanup, not the owner of parent settlement.

When cancellation or a phase failure occurs:

1. atomically mark the child terminal locally;
2. stop known billable windows synchronously where the SDK permits;
3. release local concurrency/tree permits exactly once;
4. emit the final child result and parent `onUpdate` immediately;
5. invoke remote abort/dispose in a bounded background cleanup task;
6. quarantine/log cleanup that exceeds its grace;
7. ignore late events using generation/request IDs.

A broken provider socket may remain an observable orphan, but it must not hold the parent tool call, UI busy state, or process-wide semaphore hostage.

### 4. Recovery must preserve semantic safety

Automatic retry/failover policy must depend on phase:

- **Before any assistant output:** a transient connection/429/5xx failure may safely retry according to bounded exponential backoff and `Retry-After`.
- **After partial output but before tools:** retrying from scratch can duplicate prose but has no external side effect; prefer SDK-supported continuation, otherwise terminate the attempt visibly and let the agent decide.
- **After a tool call or external side effect:** never silently replay the turn. Preserve partial transcript and surface a recoverable terminal state.
- **Authentication/permission failures:** do not retry repeatedly. Mark actionable auth failure immediately.
- **Provider-wide outage:** open a circuit breaker and avoid sending every child into the same failure. Fail over only to an explicitly eligible compatible model/provider under user-configured policy.

Do not silently change capability, privacy boundary, cost class, or provider account merely to make a request succeed.

### 5. Parent and transcript state remain truthful

At every moment the child is exactly one of:

```text
queued → preparing → waiting_provider → streaming ↔ running_tool
       → retry_wait → completed | failed | cancelled | orphaned_cleanup
```

Requirements:

- transitions are monotonic except documented streaming/tool cycles;
- every terminal child remains renderable;
- parent completion includes the latest known `results[]`, never an empty replacement;
- a terminal parent cannot contain a running child;
- late events from an old attempt cannot revive a terminal child;
- error text distinguishes timeout, provider outage, auth, cancellation, and orphaned cleanup;
- partial output and completed sibling results survive another child's failure.

## Proposed implementation

### A. Introduce a child lifecycle controller

Create a controller owned by each `runSingleAgent` attempt, for example:

```ts
interface ChildLifecycle {
  attemptId: string;
  phase: ChildPhase;
  phaseStartedAt: number;
  lastProgressAt: number;
  terminal: boolean;
  transition(next: ChildPhase, detail?: ProgressDetail): void;
  progress(detail?: ProgressDetail): void;
  finish(result: SingleResult): boolean; // false on duplicate terminal attempt
  fail(error: ClassifiedProviderError): boolean;
  cancel(reason: string): boolean;
}
```

It should own timers, terminal compare-and-set, cleanup registration, and permit release. `runner.ts` currently spreads these responsibilities across prompt racing, abort listeners, teardown, and the outer settlement net.

Suggested module boundaries:

- `extensions/subagent/src/lifecycle.ts` — pure transitions and lease decisions;
- `extensions/subagent/src/provider-failure.ts` — error classification/retry safety;
- `extensions/subagent/src/cleanup.ts` — bounded abort/dispose and orphan registry;
- `runner.ts` — orchestration only.

### B. Replace overall timeout with a renewable inactivity lease

The lease should inspect the current phase and use its phase budget. It is renewed by lifecycle progress. A healthy 45-minute tool-using agent therefore continues; a stream producing no event for the configured idle budget is recovered.

Avoid treating raw token frequency as the only heartbeat. Tool starts/output/completion and provider-gate state changes are also progress.

Recommended configuration shape:

```json
{
  "subagent": {
    "liveness": {
      "providerQueueMs": 600000,
      "headerMs": 120000,
      "firstTokenMs": 300000,
      "streamIdleMs": 180000,
      "abortGraceMs": 5000,
      "cleanupRetentionMs": 3600000,
      "absoluteContainmentMs": 0
    }
  }
}
```

`absoluteContainmentMs: 0` should mean no normal overall deadline after the lifecycle controller is trusted. During migration, retain a long containment ceiling and log whenever it fires; it must be exceptional telemetry, not routine recovery.

### C. Preserve latest progress in settlement results

Wrap `onUpdate` at the top-level `execute()` boundary and retain the latest valid `SubagentDetails`. If final dispatch/cleanup fails, synthesize the terminal response from those details, converting only still-running children to a classified failure. Never replace known completed/partial children with `results: []`.

The webview reconstruction added in the first pass remains useful for old transcripts and malformed legacy results, but new runtime results should be complete without it.

### D. Add an orphan cleanup registry

Track detached sessions that exceeded abort/dispose grace:

```text
attemptId, provider, model, phase, detachedAt, abortAttempts,
lastError, billableWindowsStopped, cleanupCompletedAt
```

The registry should:

- retry cleanup with bounded backoff;
- never reacquire child execution permits;
- cap retained entries and log eviction;
- expose counts in aggregate diagnostics;
- be drained best-effort on backend shutdown.

### E. Provider circuit breaking and failover

Build on the existing provider gate rather than creating a second concurrency system.

Minimum provider state:

```text
closed | open(until, reason) | half_open(probeInFlight)
```

Inputs should include transport failures, 429/Retry-After, 5xx bursts, auth failures, and successful probes. All subagents must observe the shared provider state so one outage does not cause a retry storm across parallel children.

Failover selection must use model eligibility already present in `models.yaml` and explicit policy. Record both attempted and final provider/model.

### F. Queued-message liveness

The reported queued message was delivered, but only after active tools completed. Add correlation-based queue tracking and a dwell watchdog:

- queued messages carry `corrId`/`localId` through delivery;
- UI shows elapsed wait and current blocker (`waiting for 2 tools`, provider retry, etc.);
- a soft threshold is informational;
- a hard threshold offers **Stop current turn**, **Keep waiting**, and **Remove queued message**;
- backend restart reconciles or explicitly marks queue state unknown;
- queued messages are never silently discarded or left immortal.

Do not auto-interrupt healthy tools just because a user queued a follow-up.

## Test strategy

### Deterministic fake-provider matrix

Add a fake provider/SDK seam capable of:

1. never returning headers;
2. headers then no first token;
3. periodic slow tokens beyond the old 15-minute total deadline;
4. mid-stream disconnect;
5. 429 with and without `Retry-After`;
6. 5xx burst followed by recovery;
7. auth failure;
8. successful model output followed by hung tool;
9. `abort()` never settling;
10. late deltas after local terminal state;
11. one hung child among successful parallel siblings;
12. provider circuit open while another provider remains healthy.

Use fake clocks. No test should wait real timeout durations.

### Required assertions

For each failure scenario assert:

- parent tool call reaches a terminal result within the phase budget;
- completed sibling output is preserved;
- partial child transcript is preserved;
- all local permits are released exactly once;
- busy/queued UI state becomes terminal or actionable;
- no late event revives the run;
- retry count and backoff are bounded;
- auth failures are not retried;
- orphan cleanup is visible but does not block a subsequent send;
- analytics records phase, classification, recovery, and cleanup outcome.

### Long-running healthy control

A fake child should run longer than 15 simulated minutes while alternating model, tool, and queue progress. It must complete successfully. This is the acceptance test proving the design no longer kills useful slow work by total duration.

## Analytics required for course correction

Capture per attempt:

- queue wait, header wait, first-token latency, stream-idle maxima;
- phase durations and last-progress phase;
- provider/model attempted and selected;
- retry/failover count and classified reason;
- cancellation initiator;
- abort grace exceeded;
- orphan cleanup duration/outcome;
- parent settlement source (`normal`, `phase-watchdog`, `user-cancel`, `absolute-containment`);
- queued-message dwell and delivery/cancellation outcome.

Metrics must distinguish `reported`, `measured`, `estimated`, and `unknown`. A force-settlement count without the blocked phase is not actionable.

## Implementation order

1. **Characterization tests:** encode the reproduced hung-abort and empty-final-results incident.
2. **Lifecycle controller:** terminal ownership, phase transitions, renewable lease, exact-once permit release.
3. **Progress preservation:** final results retain the latest child details.
4. **Bounded cleanup/orphan registry:** detach remote teardown from local settlement.
5. **Provider classification/circuit breaker:** prevent retry storms and make outages explicit.
6. **Queued-message watchdog and correlation.**
7. **Operational analytics and dashboard quality counters.**
8. **Remove the 15-minute normal timeout** after the healthy-long-run and failure matrix pass.

Do not begin with broad UI refactoring. Establish deterministic provider/lifecycle seams first; otherwise changes will be judged against flaky live-provider behavior.

## Relevant files

- `extensions/subagent/runner.ts` — current prompt race, timeout, abort, and teardown orchestration.
- `extensions/subagent/src/execute.ts` — 30-minute settlement net and terminal response synthesis.
- `extensions/subagent/src/modes.ts` — parallel/chain result aggregation and sibling behavior.
- `extensions/subagent/src/concurrency-limit.ts` — process-level permit configuration.
- `extension/src/backend/provider-gate.ts` — shared provider concurrency/backpressure state.
- `extension/src/backend/request-handler.ts` — send/interrupt lifecycle and provider-aware precommit watchdog.
- `extension/src/backend/session-event-handler.ts` — SDK event projection and queued-message delivery.
- `extension/src/shared/subagent-result.ts` — transcript compatibility/fallback rendering.
- `extension/src/host/core/reducer/streaming-handlers.ts` — terminal/queued transcript reconciliation.
- `extension/src/host/stats-service/` — operational metric capture.
- `extensions/subagent/test/interrupt-hardening.test.ts` — existing abort/hang characterization.
- `extensions/subagent/test/settlement.test.ts` — current absolute settlement-net coverage.

## Scenario → test matrix (REM-06 acceptance evidence)

| # | Scenario | Existing test(s) | New test(s) | Status |
|---|---|---|---|---|
| 1 | Never returning headers | `provider-gate.test.ts` — stalled headers locally time out and release the slot | — | ✅ |
| 2 | Headers then no first token | — | `subagent-provider-resilience.test.ts` — provider wait expires on the injected inactivity clock | ✅ |
| 3 | Periodic slow tokens beyond old 15-min deadline | — | `subagent-provider-resilience.test.ts` — productive run exceeds 15 simulated minutes using the actual settlement clock seam | ✅ |
| 4 | Mid-stream disconnect | — | `subagent-provider-resilience.test.ts` — transport failure preserves partial output and is not replayed | ✅ |
| 5 | 429 with/without Retry-After | `retry.test.ts` — numeric/HTTP-date hints, deterministic clock, bounded exponential fallback | `subagent-provider-resilience.test.ts` — execute-level injected clock drives `Retry-After`, observable `retry_wait`, and different-provider success | ✅ |
| 6 | 5xx burst followed by recovery | `provider-gate.test.ts` — half-open 503 reopens the circuit and later recovery closes it | — | ✅ |
| 7 | Auth failure | `retry.test.ts` — auth failures never retry; `provider-failure.test.ts` — auth classified terminal | — | ✅ |
| 8 | Successful output + hung tool | `settlement.test.ts` — duplicate tool updates do not renew the lease | `subagent-provider-resilience.test.ts` — output is retained when the tool phase expires | ✅ |
| 9 | `abort()` never settles | `interrupt-hardening.test.ts` — hung child `session.abort()` settles locally | `orphan-cleanup.test.ts` — detached cleanup remains observable | ✅ |
| 10 | Late deltas after local terminal state | `modes.test.ts` — stale retry-attempt update is fenced | `subagent-provider-resilience.test.ts` — generation high-water rejects stale progress | ✅ |
| 11 | One hung child among successful siblings | Native sibling tool calls settle independently; `settlement.test.ts` proves latest completed/partial details survive force settlement | — | ✅ (architecture-adjusted) |
| 12 | Provider circuit open while another healthy | `provider-gate.test.ts` — shared circuit/probe recovery; `retry.test.ts` — failed provider is excluded | `subagent-provider-resilience.test.ts` — execute-level different-provider recovery | ✅ |

**Test file locations:**
- `extensions/subagent/test/retry.test.ts` — REM-03: retry/backoff/provider failover/analytics
- `extensions/subagent/test/settlement.test.ts` — settlement net: force-settle, progress renewal, nested progress
- `extensions/subagent/test/interrupt-hardening.test.ts` — abort/teardown: Bug 1-3 hardening
- `extensions/subagent/test/orphan-cleanup.test.ts` — orphan registry: unit + runner integration
- `extensions/subagent/test/provider-failure.test.ts` — error classification: retry safety, replay, Retry-After
- `extensions/subagent/test/provider-capacity.test.ts` — capacity model ID exclusions
- `extension/test/backend/models/provider-gate.test.ts` — provider gate: concurrency, circuit breaker, afterburn
- `extensions/subagent/test/subagent-provider-resilience.test.ts` — REM-06: productive-run-beyond-15min, different-provider recovery, late-event fencing, orphan observability, sibling preservation

## Still-unimplemented acceptance gaps

The following broader acceptance requirements remain open:

1. **Operational lifecycle analytics aggregation (partially closed)** — The host now safely ingests terminal `attemptRecords`, persists/coerces them in `RunSnapshot.subagentAttemptSamples`, and aggregates attempt duration, measured runner phases, retry/backoff, attempt outcomes, and telemetry coverage across completed and open runs. Every value preserves `reported`/`measured`/`estimated`/`unknown` provenance, malformed or legacy calls remain explicitly unknown, and terminal delivery is idempotent. The remaining producer gaps are explicit rather than inferred: provider-gate queue versus header/first-token/stream-idle subphases are not separately observed, the parent settlement source is unavailable from child attempt records, and `cleanupOutcome` remains unset because eventual asynchronous orphan cleanup is not correlated back into the terminal result.

2. **Dedicated queued-message fake-clock coverage** — Queued-message correlation (`queuedLocalIds`/`QueuedDelivered` FIFO delivery, `ClearQueue`) is implemented and tested at the backend and host-reducer levels. The §F dwell watchdog, elapsed-wait UI, and Stop / Keep waiting / Remove queued offer are **not** yet implemented (contrary to an earlier draft of this handoff); a dedicated fake-clock end-to-end suite cannot cover them until they exist.

## Definition of done

This work is complete when:

- a productive subagent can run beyond 15 minutes without termination;
- every inactive provider/tool/abort phase has a deterministic bound and recovery;
- broken remote teardown cannot block parent settlement or retain local permits;
- parallel siblings preserve their output when one child stalls;
- terminal runtime results retain actual latest child details;
- provider outages open a shared circuit instead of causing retry storms;
- queued messages are correlated, observable, and actionable during long waits;
- all fake-provider scenarios pass without real-time sleeps;
- the ordinary 15-minute total timeout is removed or disabled by default;
- the absolute containment path, if retained, is rare, loudly logged, and measured.
