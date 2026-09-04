# pie analysis

Standalone local analytics transforms, DuckDB queries, and static dashboard build for pie run analytics.

## Purpose

This package is a human-facing and agent-facing view over the existing local analytics store. It is **not** a second source of truth.

Data flow:

```text
analytics source export or analytics store
  -> prepared intermediate model
  -> DuckDB database + SQL queries
  -> generated site-data JSON
  -> static localhost dashboard
```

> **V2 model/harness ranking:** `analysis/scripts/leaderboard.ts` is the canonical dashboard leaderboard. It produces one provider-agnostic row per model family and ranks only families with attributable canonical V2 review-quality evidence. Runtime/process telemetry remains diagnostic and has zero ranking weight.

## Bias-aware model strength

The leaderboard is an observational, cohort-relative estimate—not a universal or causal capability benchmark:

- **Review-only ranking:** the rank uses only canonical V2 `qualityIndexV1 / 100`, deterministically derived from criterion attainment. Process/runtime telemetry, coverage, confidence, blockers, cost, and latency have zero ranking weight.
- **Evidence eligibility:** only model families with attributable stable-ID V2 review mass are ranked. Successful-work transcript shares supplement canonical run joins when a contributing family's run snapshot is absent, and preserve attribution when the whole reviewed session lacks a run. Other observed families remain visible as unranked diagnostics. V2 review shrinkage uses `k=8`; rows are labelled `review-backed`, `thin-review`, or `telemetry-only`.
- **Stable identity and no double counting:** canonical run retries collapse deterministically. V2 reviews join by stable session-header `sessionId`, including moved/renamed sessions when run exports carry that header ID. An unmatched stable-ID review may retain transcript attribution but remains excluded from run-dependent metrics and canonical task coverage. Path fallback is flagged and excluded from ranking, though it may remain visible in diagnostics.
- **Mixed-model attribution:** transcript successful-token shares are used when available; otherwise each distinct stable model family receives an equal fraction. Shares sum to one review. DuckDB model/thinking cells use the disclosed equal-fraction fallback after retry deduplication.
- **Common case mix:** ex-ante initial prompt characters, attachment count, and context-file count define low/medium/high bands. Tokens, duration, cost, tool volume, mutations, and verification activity never define or improve V2 quality.
- **Uncertainty:** the 80% interval propagates V2 outcome-channel posterior variance through its standardized logit (`z=1.282`). Rank ranges come from interval overlap.

Thinking-level, provider, process, cost, usage, token, and duration diagnostics remain inspectable but do not affect V2 rank.

## Feedback loop

Analytics is **observability-only**: the runtime writes runs to the local store
(`run-snapshots.jsonl` / `run-analytics.json`), and this package reads them for
human/agent-facing dashboards and queries — but **nothing reads run-analytics
back to tune model selection, pruning thresholds, thinking defaults, or the
always-keep tool list**. The skill-pruner's live catalog is fed by per-session
factors (`extension/src/host/core/projection.ts`), not by aggregated run
analytics.

This is intentional for now. Closing the loop is a deliberate architectural
change, not an ad-hoc wire-up, and is tracked here as a follow-up.

### Follow-up: closing the loop (Option A)

To wire one concrete signal back into a runtime default, three pieces must exist
first — none do today:

1. **A read-back path.** The pruning catalog is fed by *live* per-session
   factors, not by `run-analytics.json`; no component currently consumes the
   prepared analytics at runtime. A new reader + cache is needed.
2. **Aggregation.** Raw per-run signals are too noisy to act on directly; they
   need rolling aggregation (e.g. trailing-window failure rates, per-model
   bias-aware strength estimates from `analysis/scripts/leaderboard.ts`) before tuning.
3. **A tuning policy with safety rails.** Any auto-tuning must be bounded
   (min/max clamps), monotone-safe (never worsen a default on sparse data),
   overrideable by explicit user settings, and observable (log every applied
   delta). Without these, a noisy signal could silently regress a default.

Candidate signals (pick **one** for a first iteration):

| Signal | Runtime default it could tune |
|---|---|
| pruning-prepass token cost | compaction `reserveTokens`/`keepRecentTokens`, or pruning thresholds |
| bias-aware model-strength scores (`leaderboard.ts`) | default-model suggestion |
| tool-failure rates | always-keep / drop-tool adjustments |

Caveat: any backfill-derived signal inherits the data-quality gaps noted under
[Data quality notes](#data-quality-notes) (e.g. historical runs with
`modelId: "unknown"` have null `provider`/`estimatedCostUsd` and cannot be
retro-assigned a model from per-turn throughput). A read-back consumer must
skip or down-weight those runs rather than treat `null` as a real signal value.

## Local dashboard data

Raw `run-analytics.json` exports and generated `analysis/site/data/*.json` are local analysis inputs/outputs. The dashboard server serves only the expected generated site-data files so accidental extra files in that directory do not affect the UI.

## Install

From the repository root, run `npm ci`. Its postinstall restores this package's
locked dependency tree. To restore only this package in an existing checkout, use:

```bash
cd analysis
npm ci
```

## Common commands

Inside `analysis/`:

```bash
npm run build-db
npm run query -- --name model_quality
npm run export-site-data
npm run validate-site-data
npm run build-site
npm run serve
npm run validate
```

From repo root (preferred shortcuts):

```bash
npm run analytics:build-db
npm run analytics:query -- --name model_quality
npm run analytics:export-site-data
npm run analytics:validate-site-data
npm run analytics:build-site
npm run analytics:serve
npm run analytics:validate
```

## Source inputs

By default, source-building scripts use the committed fixture:

- `analysis/fixtures/small-run-analytics.json`

Notes:

- `npm run build-db` and `npm run export-site-data` build from the fixture when no explicit source is provided (with a warning).
- `npm run query` reuses an existing `analysis/data/usage.duckdb` when present.
- `npm run validate-site-data` validates existing generated site data when present; otherwise it validates a temporary build from the selected source.
- `npm run serve` auto-refreshes `analysis/site/data/` from the machine-wide `../data/outcomes/` authority by default, aggregating every workspace-sharded run store together with that root's sessions and global V2 review sidecar.

For real local data, use one of these explicit inputs:

### Option 1: export from VS Code

Use the command palette entry:

- `pie: Export Run Analytics`

Save the export to a git-ignored path such as `analysis/data/exports/run-analytics-export.json`, then point analysis scripts at it:

```bash
cd analysis
npm run export-site-data -- --export ./data/exports/run-analytics-export.json
```

### Option 2: read directly from a run store directory

```bash
cd analysis
npm run build-db -- --storage-dir ../data/outcomes/<workspace-hash>
npm run export-site-data -- --storage-dir ../data/outcomes/<workspace-hash>
```

### Historical transcript evidence (analysis-only)

Local source modes derive transcripts and V2 reviews from the same selected
outcomes root as the run stores: `<outcomes>/sessions/**/*.jsonl` and
`<outcomes>/session-reviews/reviews.jsonl`. This prevents cwd/workspace changes
from splicing runs with a different review sidecar. Paths are normalized case-
and slash-insensitively on Windows and loaded once. An explicit portable
analytics export is never supplemented by scanning local transcripts; it may
carry an optional serialized `historicalSessions` summary array instead.

The reader reconstructs only the active `id`/`parentId` branch and attributes
successful assistant work (`stop` or `toolUse`) by reported token share, falling
back to successful-turn share. Errors and aborts remain separate counters.
Prepared summaries contain timestamps, counts, usage/cost telemetry, model +
thinking shares, provenance, a path hash, and the latest privacy-safe review
fields. Prompt text, review reasons, thinking text, and tool output are never
copied. Raw normalized paths exist only transiently in the source layer for
canonical-run and review joins and are removed from `PreparedAnalyticsData`.

Canonical runs always take precedence: a transcript with a matching normalized
canonical session path is marked `matchedCanonical` and does not add process
mass. Its latest review may still supply deduplicated agent evidence. Only
`transcriptOnly` sessions add fractional process mass by prepared model-family
attribution share. Limitations: malformed JSONL lines are skipped; missing
provider usage/cost stays missing; thinking is `null` when no active-branch
change establishes it; transcript summaries cannot recover canonical task
boundaries or task-result semantics; and this evidence remains observational.

## Generated outputs

Generated outputs are git-ignored:

- `analysis/data/usage.duckdb`
- `analysis/data/exports/*.json`
- `analysis/site/data/*.json`
- `analysis/site/dist/*`

Site-data files:

- `manifest.json`
- `overview.json`
- `run-summary.json`
- `model-quality.json`
- `verification-impact.json`
- `tool-usage.json`
- `treatment-comparison.json`
- `timeline.json`
- `model-leaderboard.json`
- `pruning-impact.json`
- `tool-result-pruning-impact.json`
- `session-review-analytics.json` — V2 delivered/controllable attainment, pure `qualityIndexV1`, ingestion accounting (raw/accepted/rejected/reasons), review↔run join coverage (joined/unmatched counts + unmatched reasons), and criterion/process/evidence/disagreement/reviewer diagnostics
- `outcome-correlations.json` — observational `qualityIndexV1` associations across reviewed sessions vs. verification usage, compaction, thinking level, prompt-size band, pruning mode, and subagent-parent toggle; per-group sample counts + 95% t-intervals and Welch mean-difference intervals. Observational only — never implies causality and never alters the V2 quality formula.
- `evidence-reliability.json` — diagnostics that qualify qualityIndexV1-based recommendations: dominant model-family share, effective reviewed families, and ceiling saturation (perfect/achieved rates, distinct values).
- `backend-errors.json`
- `file-types.json`
- `token-throughput.json`
- `retry-timing.json` — measured per-attempt scheduled delay, observed delay, and retry-episode duration; absent historical samples remain absent

## Query names

```text
core_runs
model_quality
session_review_quality
verification_impact
tool_usage
tool_failures
treatment_comparison
timeline
pruning_prepass_cost
warm_bash
retry_timing
latency_friction
```

Example:

```bash
cd analysis
npm run query -- --name tool_usage --export ./data/exports/run-analytics-export.json
```

## Dashboard workflow

```bash
cd analysis
npm run serve
```

`npm run serve` will:

1. aggregate every run store under the machine-wide `../data/outcomes/` authority,
2. join its global V2 review sidecar and canonical session summaries,
3. regenerate dashboard-ready `analysis/site/data/*.json`,
4. start the localhost dashboard server.

To inspect one workspace shard or a portable export instead, use:

```bash
npm run serve -- --storage-dir ../data/outcomes/<workspace-hash>
npm run serve -- --export ./data/exports/run-analytics-export.json
```

Then open the localhost URL printed by the server.

Do not rely on `file://` loading.

## Data quality notes

- **Tool failure classification**: Runs recorded before per-tool failure classification was added lack `failureCountsByNameAndKind`. For these runs, the pipeline falls back to `failureCountsByKind` (aggregate-level classification) and emits failures under a sentinel tool name `(unattributed)`.
- **Tool timing attribution**: Run rows retain `toolDurationMs` and `timedToolCallCount` independently of per-tool attribution. Historical terminal events that lost their tool metadata are surfaced as `(unknown)` tool-usage rows rather than dropped; their mean duration is null because no reliable terminal call count exists. New events repeat start metadata on `tool.finished`, so future duration, failure, verification, and file-mutation attribution remains named even when the owner transcript message is unavailable.
- **V2 review identity**: Production reviews use stable session IDs. Path fallback is excluded from ranking but may remain visible in diagnostics (join coverage, evidence reliability). An unmatched stable-ID review can contribute family-level quality through its reviewed transcript's successful-work attribution, while remaining excluded from run-dependent metrics and correlations.
- **Review↔run join coverage**: `session-review-analytics.json` exposes a `joinCoverage` aggregate (joined vs. unmatched, with per-row `joinKey` and `unmatchedReason`) so absent run evidence remains visible even when stable transcript attribution preserves family-level review quality. Unmatched reasons are derived from sound identity evidence only — `no_run_for_identity` (the reviewed session is absent from the export) or `identity_conflict_at_path` (a run sits at the review's exact path but carries a different stable header, so joining is declined to avoid a false attribution). No heuristic/fuzzy path matching is ever performed to recover a run join.
- **Outcome correlations & evidence reliability**: `outcome-correlations.json` and `evidence-reliability.json` are cwd-agnostic and observational. Correlations group reviewed sessions (with a non-null `qualityIndexV1` that joined ≥1 run) by behavioral dimensions and report 95% Student-t mean intervals and 95% Welch mean-difference intervals; intervals are null when a group has fewer than 2 samples. Unmatched reviews are excluded from correlations (their runtime behavior cannot be attributed) but remain counted in `evidence-reliability.json` ceiling saturation and use stable transcript family attribution when available. Path-fallback reviews likewise remain counted in ceiling saturation (unattributed) but are excluded from ranking. Reliability family mass uses equal fractional split across each session's prepared families; a dominant family, few effective reviewed families, or high ceiling saturation all reduce how discriminating the evidence is.
- **V2 ingestion accounting**: `session-review-analytics.json` and the dashboard expose raw, accepted, and rejected production review counts plus rejection reasons; malformed or unsupported records are never silently treated as accepted evidence.
- **Open runs excluded**: Verification impact and timeline metrics exclude open (in-progress) runs since they have no finalized outcome.
- **Token usage**: `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` are available when the provider reports them. Many older runs have zero token data.
- **Cost**: `estimatedCostUsd` is the **parent-run** cost derived from token usage × per-model pricing in `models.json` (`null` when pricing is unknown, e.g. local/free models). `subagentEstimatedCostUsd` is the cost of spawned sub-agent sessions (which bill separately and were historically excluded from run cost), and `totalEstimatedCostUsd` = parent + subagent (the headline spend the overview card and cost-trend now use, leaving incomplete historical totals null). The dashboard's "Cost & token economics" section shows spend over time, spend over time by provider, spend per model, and average spend per model per session — a session rolls up all of its runs, so the per-session average differs from the per-run average when a session contains multiple runs. Per-provider spend attributes each run to its `models.json` provider; runs whose model isn't in the registry fall under `(unknown)`, and providers beyond the top 8 by spend fold into `Other`. The "Subagent cost attribution" chart stacks parent vs subagent spend by model to expose the hidden sub-agent portion.
- **Per-turn tokens & context trajectory**: `turnThroughputSamples` now carry per-turn `inputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`contextTokens` (in addition to `outputTokens`/`generationDurationMs`). These enable per-turn cost attribution and the context-growth trajectory chart. Older turns (recorded before this field existed) coerce to `0` (tokens) / `null` (context) and are excluded from those views.
- **Provider queue timing**: `providerQueueMs` is nullable measured provider-gate wait per turn, and `providerQueueAttemptCount` records how many provider attempts contributed. An explicit `0ms` means an immediate observed grant; absent historical/ungated observations remain `null` with attempt count `0` and are excluded from queue-duration coverage and medians.
- **Auxiliary prepass timing**: measured `durationMs` on `skill_pruning_prepass` auxiliary usage is summed per run as `skillPruningPrepassDurationMs`. Runs with no measured prepass duration remain `null`; token-only historical samples are not displayed as zero-duration prepasses.
- **Per-turn model attribution**: each flattened throughput row attributes its `modelId` from `sample.modelId` when present (per-sample provider attribution, e.g. a sub-agent turn or a mid-run model swap), falling back to the parent run's `modelId`. `mixed_model_config` on the run flags when a run's turns span more than one model.
- **Throughput artifact retention & concurrency**: the `token-throughput.json` site artifact retains every turn — including errored and tokenless turns with null `tokensPerSecond` — so coverage and error-rate analysis see the full population; chart transforms filter null `tokensPerSecond` at render time only. `concurrentBusySessions` is end-of-turn descriptive telemetry (how many sessions were mid-run when the turn ended); it is not a causal rate-limit signal, so treat any throughput-vs-concurrency correlation as descriptive, not causal.
- **Compaction & retry**: `compactionCount` (history-compaction `/compact` LLM calls — a hidden billable call whose tokens the SDK does not report back, so they remain absent from token totals) and `autoRetryCount` (backend auto-retries of failed turns) are captured per run. Both counters are `0` for runs recorded before tracking existed. New `retryTimingSamples` preserve each attempt's scheduled backoff plus nullable measured gate-entry delay and nullable full retry-episode duration in `retry-timing.json` and DuckDB's `retry_timing` table. Historical runs have no rows, not synthetic zero-duration attempts. The "Compaction & retry friction" count chart and measured-only "Runtime friction timing" chart serve different purposes. Note: compaction token usage is not capturable today (no SDK usage hook); only the count and wall-clock (folded into `busyDurationMs`) are tracked.
- **Tool critical path and overlap**: `toolDurationMs` is cumulative timed-tool duration, while `criticalPathDurationMs` is the non-overlapping union of reliably timed tool intervals. Their non-negative difference is parallel overlap. Historical runs without interval-union telemetry remain `null` in prepared/site data and are excluded from critical-path/overlap coverage rather than shown as zero; DuckDB and the dashboard expose cumulative, critical-path, and overlap values together.
- **Task group correlation**: Multiple canonical runs can share a `taskGroupId`; the leaderboard uses only the deterministic latest stable run per task and family, while other views may still report per-run counts.
- **Case-mix coverage**: Transcript-only sessions join canonical tasks in the ex-ante complexity population. Historical sessions expose prompt character count but not attachment/context counts, which are conservatively zero; post-treatment telemetry is never used.
- **Small review samples**: Leaderboard rows expose review mass, evidence tier, 80% score intervals, and overlapping rank ranges. The dashboard keeps provisional ranks visible while making sparse evidence and uncertain ordering conspicuous.

## Manual smoke test

1. Ensure you have local run data (use pie normally; optional: export manually with `pie: Export Run Analytics`).
2. Run `npm run serve` and open the localhost URL.
3. Optionally run `npm run validate-site-data` for an explicit contract check.
4. Confirm:
   - charts render,
   - global filters update multiple charts,
   - empty and sparse subsets show useful messages,
   - browser devtools show no CDN or third-party requests.
