# Analytics Performance Remediation Plan

## Context

Pie is substantially faster on a newly configured machine with little analytics history. Investigation confirmed that analytics work scales with accumulated history and same-day turn activity in several startup and UI paths.

Measured against existing local stores:

| Store | Snapshot file | Query | Aggregate | Compact stringify |
|---|---:|---:|---:|---:|
| Small | 0.24 MB | 17.7 ms | 3.6 ms | 1.5 ms |
| Large | 11.2 MB | 155–165 ms | 21–51 ms | 64–68 ms |

One current `aggregateStats` payload was approximately 606 KB and contained 1,859 `todayTokenSeries` points. Cloning that aggregate alone took approximately 15 ms. Because Pie sends authoritative full `ViewState` snapshots during streaming with a 60 ms minimum debounce, analytics serialization consumes a significant portion of the host event-loop budget before transcript rendering and IPC overhead.

The remediation must preserve the snapshots-only contract in [STATE_CONTRACT.md](./STATE_CONTRACT.md): full `ViewState` remains authoritative, aggregate statistics remain host-owned, and the webview remains a projection of host state.

## Goals

1. Bound the analytics contribution to every full UI snapshot.
2. Bound analytics storage by bytes as well as record count.
3. Remove derived export generation from the startup critical path.
4. Avoid redundant startup reads of the complete analytics store.
5. Make active aggregate refresh cost scale with open runs rather than all historical runs.
6. Restore the documented reference-stability invariant of `AggregateStatsService`.
7. Add realistic regression and benchmark coverage.

## Non-goals

- Replacing the JSONL/checkpoint canonical store.
- Moving analytics computation into the webview.
- Introducing incremental host-to-webview state patches.
- Changing explicit export semantics: an explicitly requested export must remain fresh.

## Phase 1 — Bound the UI payload

### Implementation

Update `extension/src/host/stats-service/aggregate-stats.ts`:

1. Add a maximum intraday chart size, initially 240 points.
2. Bucket raw cost and token samples by time before creating cumulative points.
3. Accumulate provider and model values within each bucket.
4. Build cumulative points from the buckets.
5. Reserve one point for the trailing `now` value so the final series never exceeds the cap.
6. Leave the hourly throughput series unchanged because it is naturally bounded to at most 24 points per day.

Downsampling must preserve:

- Exact final cumulative token and cost totals.
- Exact provider and model totals.
- The first-to-last time range.
- Chronological ordering.

### Tests

Extend `extension/test/aggregate-stats.test.ts`:

- Generate thousands of same-day samples.
- Assert each intraday series contains at most 240 points.
- Assert the final cumulative value exactly matches the undownsampled total.
- Assert provider and model totals remain correct.
- Cover multiple samples falling into the same bucket.
- Cover the trailing `now` point without exceeding the cap.

### Acceptance criteria

- The measured 606 KB aggregate payload falls below a target of approximately 100–150 KB.
- Payload size no longer grows linearly after reaching the point cap.
- Existing chart totals and tooltip values remain correct.

## Phase 2 — Enforce real storage limits

### Implementation

Update `extension/src/host/stats-service/storage.ts`:

1. Replace the current threshold-only behavior with two explicit limits:
   - `maxRunHistoryEntries`, default 2,000.
   - `maxRunHistoryBytes`, initially 5 MB per JSONL file.
2. When either limit is exceeded:
   - Walk records newest-to-oldest.
   - Retain the largest suffix satisfying both limits.
   - Always retain at least the newest valid record, even if that record alone exceeds the byte limit.
   - Atomically rewrite the file only when records were removed.
3. Calculate UTF-8 byte size rather than JavaScript string length.
4. Apply the policy independently to:
   - `run-snapshots.jsonl`
   - `outcome-history.jsonl`
   - `agent-reviews.jsonl`
5. Update option names and comments so the byte value is a hard retention limit rather than merely a pruning trigger.

No eager migration is required. Existing oversized files will be corrected on the next persistence flush.

### Tests

Extend `extension/test/run-analytics-performance-regression.test.ts`:

- File exceeds bytes but not line count: it is pruned.
- File exceeds line count but not bytes: it is pruned.
- File exceeds both: it satisfies both afterward.
- Multibyte UTF-8 content is counted correctly.
- Newest records are retained.
- A single oversized newest record is retained without a rewrite loop.
- Atomic-write failures preserve the original file and surface a persistence error.

### Acceptance criteria

- Existing 11 MB snapshot files reduce to the configured limit after persistence.
- A small number of large records cannot leave a file indefinitely above the intended bound, except for the documented single-record case.
- Full-query cost is bounded by configured storage size.

## Phase 3 — Remove export work from startup

### Implementation

Update `extension/src/host/stats-service/storage.ts`:

1. Remove the awaited `writeAutoExportSafely()` call from `RunAnalyticsStorage.start()`.
2. After checkpoint restoration, compare canonical source mtimes with the export mtime.
3. If `run-analytics.json` is absent or stale, schedule a background export without awaiting it during startup.
4. Do not rewrite an export that is already current.
5. Preserve bounded retry and backoff for background export failures.
6. Keep explicit export synchronous and fresh.
7. Keep shutdown export behavior so pending analytics are exported before disposal.

Update startup ordering in `extension/src/host/extension-host.ts`:

```ts
this.tokenRateService.start();
await this.statsService.start();
this.aggregateStatsService.start();
await this.service.start();
```

This ensures migration and checkpoint restoration complete before the initial aggregate query begins.

### Tests

- `storage.start()` completes without waiting for export serialization or write.
- Missing or stale exports are eventually generated in the background.
- A current export is not needlessly rewritten.
- Explicit export and shutdown still produce current data.
- Aggregate polling does not begin before stats restoration completes.
- Background export failure does not prevent session startup.

### Acceptance criteria

- Startup no longer blocks on writing a 17–18 MB pretty-printed export.
- Startup performs one complete analytics query rather than an export query followed by an aggregate query.
- Derived exports remain eventually consistent.

## Phase 4 — Cache historical aggregate work

This is the most invasive phase and should land separately from the storage and payload fixes.

### Implementation

Refactor `extension/src/host/stats-service/aggregate-stats.ts` into two stages:

1. **Accumulate runs** into mergeable internal accumulators for:
   - Provider usage and cost.
   - Daily usage and cost.
   - Throughput.
   - Global totals.
   - Session paths.
   - Intraday series samples.
   - Last-run selection.
2. **Finalize aggregate** by converting merged accumulators into protocol-facing `AggregateStats`.

Update `extension/src/host/aggregate-stats-service.ts` to maintain:

- A completed-run accumulator rebuilt only when `run-snapshots.jsonl` changes.
- An open-run accumulator rebuilt from the usually small set of active runs.
- A final aggregate produced by merging completed and open accumulators.

Do not rely solely on an open-run string signature. Open runs legitimately change during generation; the optimization must avoid walking historical runs even when an open run changes.

Refresh these live-only fields independently:

- `liveTokensPerSecond`
- Running-session count
- Open-tab count
- Warm-bash metrics
- Provider-gate metrics

Pricing changes must invalidate any cached accumulation whose cost attribution depends on pricing.

### Tests

Add a computation seam or instrumentation counter to verify:

- The initial tick reads and accumulates completed history once.
- Unchanged ticks do not revisit completed runs.
- Updating an open run recomputes only the open accumulator.
- Completing a run invalidates and rebuilds the completed cache.
- Pricing changes invalidate cost-related cached accumulation.
- Final merged output matches the existing all-runs implementation.

Use deterministic and randomized fixture comparisons between:

```ts
computeAggregateStats(allRuns)
```

and the refactored equivalent:

```ts
finalize(merge(accumulate(completedRuns), accumulate(openRuns)))
```

### Acceptance criteria

- Active one-second ticks scale with open runs rather than historical run count.
- The measured 21–51 ms historical recomputation is removed from steady-state streaming.
- Aggregate totals remain equivalent to the existing implementation.

## Phase 5 — Restore reference stability

### Implementation

Update `extension/src/host/aggregate-stats-service.ts` so an equal recomputation retains the existing reference:

```ts
if (!aggregateEqual(this.cached, next)) {
  this.cached = next;
  this.deps.onChanged();
}
```

Do not assign `this.cached = next` in the equal branch.

For live-only changes, shallow-copy the aggregate while retaining historical array references. This does not eliminate IPC serialization—full snapshots still clone complete state—but it restores the service's documented invariant and improves host-side memoization.

### Tests

- Unchanged recomputations preserve root object identity.
- Live-field changes create a new root while retaining historical array references.
- Historical changes replace affected arrays and invoke `onChanged()` once.

### Acceptance criteria

- `getAggregateStats()` returns the same object between perceptibly unchanged recomputations.
- Existing update behavior remains correct for changed metrics.

## Phase 6 — Add realistic performance coverage

Update `extension/test/perf/streaming-pipeline.perf.ts` or add a dedicated analytics benchmark.

### Fixtures

Include realistic large-state fixtures containing:

- Approximately 2,000 historical runs.
- Multiple providers and models.
- Thousands of same-day turn samples.
- At least one changing open run.

### Measurements

Record:

- Serialized aggregate size.
- Intraday series point count.
- Analytics query duration.
- Aggregate computation duration.
- Structured-clone duration.
- Completed-history accumulation count across active ticks.

Keep wall-clock timing measurements informational to avoid flaky CI. Enforce structural assertions in CI:

- Series point cap.
- Aggregate payload-size ceiling for the fixed fixture.
- No repeated completed-history accumulation.
- Storage byte ceiling.
- No awaited startup export.

## Delivery order

1. Bounded series and tests.
2. Hard storage limits and tests.
3. Deferred startup export and startup ordering.
4. Historical/open-run accumulator refactor.
5. Reference stability.
6. Realistic benchmark fixtures and final measurements.

Each phase should be a separate reviewable change. Re-run the baseline measurements after phases 1, 3, and 4 to attribute improvements to the correct change.

## Verification

After every change under `extension/src/`:

```bash
cd extension
npm run typecheck
npm run test
npm run build
```

Targeted development loop:

```bash
cd extension
npx tsx --test test/aggregate-stats.test.ts
npx tsx --test test/run-analytics-performance-regression.test.ts
npx tsx --test test/stats-service.test.ts
```

Final manual verification should compare the existing large analytics store with a fresh store and record:

- Extension startup time.
- Time until the sidebar is interactive.
- Host CPU during streaming.
- Full snapshot and `aggregateStats` payload sizes.
- Aggregate computation time per active tick.
- Analytics query and background-export durations.
- Streaming responsiveness and aggregate-strip correctness.
