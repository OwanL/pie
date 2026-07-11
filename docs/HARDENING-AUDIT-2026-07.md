# Hardening audit — July 2026

This is a prioritized operating document, not a claim that every item below was fixed in one pass. It records the failures reproduced during the pass, the changes made, and the next reliability slices.

## Executive summary

The highest-risk pattern is not missing features; it is **unbounded or weakly-observed transition states**. A provider/tool can remain in progress, a queued message can wait behind it, and the transcript can then give too little evidence to distinguish “working”, “queued”, and “failed”. The CQRS/state architecture has strong tests, but several operational paths still rely on eventual SDK events.

The immediate pass therefore focused on:

1. bounding subagent provider hangs;
2. keeping terminal subagent failures visible in the transcript;
3. making queued-message semantics explicit;
4. restoring a fast developer feedback loop;
5. making skill/tool pruning materially prune instead of protecting almost the entire catalog.

## Reproduced failures and measurements

### Subagent call force-settled with no renderable children

A four-scout parallel call started at 2026-07-11 01:02 UTC and reached the 1,800-second settlement net at 01:32. The persisted tool result was:

```json
{
  "isError": false,
  "content": [{ "type": "text", "text": "Subagent did not settle within 1800s and was force-settled..." }],
  "details": { "mode": "parallel", "results": [] }
}
```

Backend logs showed children in `streaming` / `waiting for model response`, followed by `child.abort.invoked`; some `session.abort()` calls did not settle within the five-second diagnostic grace. This is a real provider/SDK teardown failure, not only a webview rendering bug.

The empty `results` array caused `getRenderableSubagentResultFromToolCall()` to return `undefined`, so the rich subagent cards disappeared and the generic tool fallback gave little evidence of what had been delegated.

### Queued message appeared not to trigger

The first follow-up message was accepted at 01:37:11 and entered the model transcript at 01:38:57: roughly 106 seconds. It was not lost; SDK steering waits for in-flight tool calls to finish before injecting the queued user turn. Long-running tests/tools made the queue look inert.

This remains an observability weakness: delivery depends on a future SDK `message_start(role=user)` event. If the current tool never settles, neither does delivery. The UI must explain that dependency and a future watchdog should flag excessive queue dwell.

### Test-loop baseline

Full repository verification took about 4.6 minutes for the extension and 1.5 minutes for subagent tests because coverage collection and serialized test files are intentionally enabled:

- extension: ~279 s
- subagent: ~89 s

A new fast mode (parallel test files, no coverage instrumentation) measured:

- extension: ~56 s (about 5× faster)
- subagent: ~13 s (about 7× faster)

The baseline working tree was initially red: extension markdown/model-sync tests and two subagent tests failed. This pass repaired the model-sync newline, made the subagent tests hermetic against host environment overrides, and moved the DOMPurify security test from unsupported happy-dom to jsdom. Final scoped coverage runs are green (extension 2,308 passed; subagent 553; skill-pruner 231).

## Changes completed in this pass

### 1. Bounded subagent runs

`extensions/subagent/runner.ts` currently treats `PI_SUBAGENT_TIMEOUT_MS=0` as invalid and falls back to a 15-minute safety timeout. This is temporary containment, not the target resilience model: productive slow agents must not be killed by total duration. The replacement design—progress-aware phase leases, bounded local settlement independent of remote teardown, provider circuit breaking, and a healthy run beyond 15 simulated minutes—is specified in [`HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md`](HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md). Once that acceptance matrix passes, remove the 15-minute normal timeout.

### 2. Terminal subagent failures remain visible

`extension/src/shared/subagent-result.ts` reconstructs failed child cards from the immutable tool input when a terminal call has empty/missing child results. It stamps the terminal tool-result error on each card. Parallel force-settles therefore show which agents/tasks failed instead of collapsing into an opaque generic row.

### 3. Queued-message semantics are explicit

Queued user messages now explain on hover that they are waiting for current tool calls and will be injected before the next model response. This does not pretend to solve a hung SDK queue; it removes the misleading “nothing happened” state while preserving steering semantics.

### 4. Fast test command

Use:

```bash
npm run test:fast -- --package extension
npm run test:fast -- --package subagent
```

This is the iteration loop. `npm run test -- --package <id>` remains the coverage-gated pre-merge verification.

### 5. Pruning configuration now actually prunes

The prior `pruning.tools.alwaysKeep` list protected 13 of 16 tools, structurally preventing useful tool pruning. The configuration now uses `topK` guidance (five skills, ten tools) with no user-protected tool list. `request_tool` remains protected intrinsically by the pruner, so over-pruned tools are recoverable. Two broad skill descriptions were also tightened to reduce false relevance.

## Prioritized next slices

### P0 — keep the restored release gate green

- The observed markdown-rendering, model-sync, and subagent test failures are resolved in this pass; prevent recurrence by running scoped fast tests during iteration and coverage-gated tests before package/install.
- Add a CI/local command that automatically detects and runs fast tests on changed packages before the full coverage gate.
- Record per-test-file duration in the concise reporter and publish the slowest 20. The current package total identifies pain but not the next bottleneck.
- Eliminate shared process-environment mutation between test files or keep only those files serialized; then full verification can parallelize more safely.

Acceptance: clean checkout, `npm ci`, `npm run typecheck`, `npm run test`, and `npm run extension:build` all pass.

### P0 — provider and subagent liveness state machine

- Give every provider request explicit phases: queued for gate, connecting/headers, streaming, retry backoff, aborting, terminal.
- Persist phase timestamps and provider/model/request IDs in diagnostics.
- Add a bounded queue-acquire timeout, header timeout, stream-idle timeout, and abort grace with one terminal owner; never rely on `session.abort()` settling.
- On a retryable outage, rotate only across explicitly compatible configured models/providers; do not silently change capability or billing class.
- Preserve the latest subagent progress details in the final settlement result rather than returning `results: []`.
- Add an end-to-end fake-provider test for: no headers, mid-stream disconnect, 429 with Retry-After, 5xx burst, auth failure, and abort that never settles.

Acceptance: every injected failure reaches a terminal transcript state within its documented budget, releases all concurrency permits, stops billable windows, and leaves the next send usable.

### P0 — queued-message delivery watchdog

- Track queued messages by correlation/local ID, not only FIFO position.
- Start a queue-dwell timer after `SendResult{queued:true}` and clear it only on the matching delivery event.
- After a short threshold, show “waiting for current tools” with elapsed time; after the hard threshold, surface actions to stop the current turn, keep waiting, or remove the queued message.
- Reconcile queue state after backend restart by querying SDK queue state or explicitly marking delivery unknown; never leave an immortal optimistic `queued` row.

Acceptance: a fake current tool that never resolves cannot leave a queued message silently pending forever.

### P1 — editing and transcript reconciliation

The authoritative contract is `docs/STATE_CONTRACT.md`. Add a browser-level fixture covering the complete edit lifecycle rather than only reducer events:

- edit pre-ack rejection;
- post-ack/pre-commit pruning failure;
- first-stream commit;
- backend crash in each window;
- edit while another turn is running;
- image attachment rollback;
- webview reload between optimistic edit and backend response.

Assert the user text/tail is never lost, the inline editor exits deterministically, and a retry is always possible.

### P1 — analytics correctness and growth

Current storage is bounded but lossy: each JSONL history defaults to the most recent 2,000 lines once it crosses 5 MB. Read-side queries parse the retained JSONL and checkpoint state. This prevents unbounded files but eventually removes historical cohorts, so long-range metrics silently become a rolling sample.

Recommended evolution:

1. Keep JSONL as a write-ahead/event log, rotated into dated immutable segments rather than truncating history.
2. Incrementally ingest segments into DuckDB with `(schemaVersion, event kind, stable event ID)` idempotency.
3. Materialize daily/model/provider aggregates; dashboards should not reparse all raw history on each refresh.
4. Publish data-quality counters beside every metric: eligible runs, missing usage, unknown pricing/provider, legacy-coerced rows, scored fraction, and task-group-adjusted sample size.
5. Version metric definitions separately from storage schema so a changed formula is not compared as if it were the same series.

High-value telemetry still needed:

- provider request attempts, retry class, Retry-After, gate wait, header latency, stream idle, disconnect phase, failover decision, and final recovery status;
- queued-message dwell and cancellation reason;
- subagent queue wait vs model time vs tool time vs teardown time;
- compaction usage/cost when the SDK exposes it;
- explicit metric provenance (`reported`, `estimated`, `legacy default`, `unknown`) instead of coercing absent historical values to meaningful-looking zero.

### P1 — portability and dependency management (completed baseline)

The multi-machine baseline now pins Node/npm and derives the standalone pi CLI version from the extension lockfile; uses `npm ci` for all tracked lockfile roots; provides `npm run bootstrap` and a non-destructive `npm run doctor`; keeps sessions machine-local on both installer paths; builds/installs the VSIX on macOS/Linux when the VS Code CLI is available; and runs a Windows/Linux fresh-machine portability workflow. Monthly Dependabot updates cover `/`, `/extension`, and `/analysis`.

Workspaces remain deliberately disabled: the direct-glob test runner is documented in `package.json`, and adopting workspaces would first require package manifests for every local extension. Generated `.vsix`, platform binaries, dependencies, auth, and runtime data remain git-ignored.

### P2 — maintainability hotspots

Static analysis found no actionable Semgrep smells, but highlighted concentrated risk:

- `effect-runner.ts` (~1,350 lines)
- `runner.ts` (~1,280 lines)
- `request-handler.ts` / `provider-gate.ts` (~1,000 lines each)
- analytics coercion and aggregate functions with high complexity
- duplicated analytics source/coercion rollups

Refactor by state-machine boundary, not by arbitrary line count. Extracting shared analytics coercion is particularly valuable because duplicated formulas can drift and produce inaccurate metrics while each copy remains locally tested.

## Release posture

Pie should not be considered “move on and forget it” stable until:

1. the clean baseline is green;
2. provider failure injection is terminal and recoverable;
3. queued/edit optimistic states have watchdogs and restart reconciliation;
4. metric definitions expose provenance/sample quality;
5. installation is exercised on a clean second machine/OS.
