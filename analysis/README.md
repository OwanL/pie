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

> **Model ranking:** see `analysis/scripts/stratified-ranker.ts` for the stratified leaderboard — per-model entries ranked within complexity bands (low/medium/high) via a per-run complexity score, and assigned to buckets.

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
   prepared/stratified analytics at runtime. A new reader + cache is needed.
2. **Aggregation.** Raw per-run signals are too noisy to act on directly; they
   need rolling aggregation (e.g. trailing-window failure rates, per-model
   quality buckets from `analysis/scripts/stratified-ranker.ts`) before tuning.
3. **A tuning policy with safety rails.** Any auto-tuning must be bounded
   (min/max clamps), monotone-safe (never worsen a default on sparse data),
   overrideable by explicit user settings, and observable (log every applied
   delta). Without these, a noisy signal could silently regress a default.

Candidate signals (pick **one** for a first iteration):

| Signal | Runtime default it could tune |
|---|---|
| pruning-prepass token cost | compaction `reserveTokens`/`keepRecentTokens`, or pruning thresholds |
| model-quality scores (`stratified-ranker.ts`) | default-model suggestion |
| tool-failure rates | always-keep / drop-tool adjustments |

Caveat: any backfill-derived signal inherits the data-quality gaps noted under
[Data quality notes](#data-quality-notes) (e.g. historical runs with
`modelId: "unknown"` have null `provider`/`estimatedCostUsd` and cannot be
retro-assigned a model from per-turn throughput). A read-back consumer must
skip or down-weight those runs rather than treat `null` as a real signal value.

## Local dashboard data

Raw `run-analytics.json` exports and generated `analysis/site/data/*.json` are local analysis inputs/outputs. The dashboard server serves only the expected generated site-data files so accidental extra files in that directory do not affect the UI.

## Install

```bash
cd analysis
npm install
```

## Common commands

Inside `analysis/`:

```bash
cd analysis
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
- `npm run serve` auto-refreshes `analysis/site/data/` from your local run store by default (prefers the current workspace hash under `../data/outcomes/`).

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

## Query names

```text
core_runs
model_quality
verification_impact
tool_usage
tool_failures
treatment_comparison
timeline
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

1. auto-detect your local run store under `../data/outcomes/`,
2. regenerate dashboard-ready `analysis/site/data/*.json`,
3. start the localhost dashboard server.

If multiple run stores exist and none matches the current workspace hash, `serve` will ask for an explicit source. You can always force one with:

```bash
npm run serve -- --storage-dir ../data/outcomes/<workspace-hash>
npm run serve -- --export ./data/exports/run-analytics-export.json
```

Then open the localhost URL printed by the server.

Do not rely on `file://` loading.

## Data quality notes

- **Tool failure classification**: Runs recorded before per-tool failure classification was added lack `failureCountsByNameAndKind`. For these runs, the pipeline falls back to `failureCountsByKind` (aggregate-level classification) and emits failures under a sentinel tool name `(unattributed)`.
- **Scoring gap**: Most runs are `closed_unscored` (no satisfaction/resolution data). Model quality and treatment comparison metrics are only meaningful for the scored subset.
- **Open runs excluded**: Verification impact and timeline metrics exclude open (in-progress) runs since they have no finalized outcome.
- **Token usage**: `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` are available when the provider reports them. Many older runs have zero token data.
- **Cost**: `estimatedCostUsd` is the **parent-run** cost derived from token usage × per-model pricing in `models.json` (`null` when pricing is unknown, e.g. local/free models). `subagentEstimatedCostUsd` is the cost of spawned sub-agent sessions (which bill separately and were historically excluded from run cost), and `totalEstimatedCostUsd` = parent + subagent (the headline spend the overview card and cost-trend now use, falling back to parent-only for legacy runs). The dashboard's "Cost & token economics" section shows spend over time, spend over time by provider, spend per model, and average spend per model per session — a session rolls up all of its runs, so the per-session average differs from the per-run average when a session contains multiple runs. Per-provider spend attributes each run to its `models.json` provider; runs whose model isn't in the registry fall under `(unknown)`, and providers beyond the top 8 by spend fold into `Other`. The "Subagent cost attribution" chart stacks parent vs subagent spend by model to expose the hidden sub-agent portion.
- **Per-turn tokens & context trajectory**: `turnThroughputSamples` now carry per-turn `inputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`contextTokens` (in addition to `outputTokens`/`generationDurationMs`). These enable per-turn cost attribution and the context-growth trajectory chart. Older turns (recorded before this field existed) coerce to `0` (tokens) / `null` (context) and are excluded from those views.
- **Compaction & retry**: `compactionCount` (history-compaction `/compact` LLM calls — a hidden billable call whose tokens the SDK does not report back, so they remain absent from token totals) and `autoRetryCount` (backend auto-retries of failed turns) are captured per run. Both are `0` for runs recorded before tracking existed. The "Compaction & retry friction" chart surfaces them by model. Note: compaction token usage is not capturable today (no SDK usage hook); only the count and wall-clock (folded into `busyDurationMs`) are tracked.
- **Task group correlation**: Multiple runs can share the same `taskGroupId`. Per-run sample sizes in model quality and treatment comparison should be treated as upper bounds since runs in the same task group are not independent.
- **Small samples**: Model quality cells with fewer than 3 scored runs have highly variable satisfaction averages. Notes in `model-quality.json` flag this.

## Manual smoke test

1. Ensure you have local run data (use pie normally; optional: export manually with `pie: Export Run Analytics`).
2. Run `npm run serve` and open the localhost URL.
3. Optionally run `npm run validate-site-data` for an explicit contract check.
4. Confirm:
   - charts render,
   - global filters update multiple charts,
   - empty/no-scored subsets show useful messages,
   - browser devtools show no CDN or third-party requests.
