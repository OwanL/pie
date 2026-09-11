---
name: query-analytics
description: Query Pie's canonical normalized analytics store (run/provider usage, costs, coverage, execution/tool/activity/feature facts). Use when a question needs settled per-invocation usage or cost numbers from real session history — never guess and never read the legacy JSONL ledger or raw session logs for aggregates
---

# Pie Canonical Analytics Queries

The authoritative analytics root is one normalized SQLite database:

```
<canonical-data-root>/analytics/analytics.sqlite
```

The canonical data root comes from `PIE_DATA_DIR` (absolute, or relative
rooted at the agent directory); with no override it defaults to
`%LOCALAPPDATA%\pie\data` on Windows,
`~/Library/Application Support/pie/data` on macOS, and
`$XDG_DATA_HOME/pie/data` (else `~/.local/share/pie/data`) on Linux.

**Rules of engagement:**

- Open the database read-only (`sqlite3` CLI, `node:sqlite` with
  `readOnly: true`, or the pie query helper). Never write, migrate, or delete.
- Never derive aggregates from the legacy JSONL invocation ledger
  (`billable-invocations.jsonl`), raw session logs, or detail payloads.
  Only the normalized canonical store answers "how much".
- Missing usage channels are `NULL` (never `0`); a stored `0` is a real
  provider-reported zero. Report unknown ≠ zero.
- Integer values (timestamps, token counts, revisions) are stored as
  decimal strings; compare/aggregate them as integers, not strings.
- The compatibility session-usage UI has numeric token fields. A canonical
  int64 outside JavaScript's safe-integer range stays exact in query results
  and is exposed to that UI as an explicitly unknown channel; never convert it
  with `Number(...)` or present the rounded value.

## Commands and bounds

The pie read helper exposes four logical commands — `schema`, `query`,
`detail`, `storage` — as one disposable read-only process per query with a
default 10 s inactivity timeout (caller-cancellable), a default 200-row /
256 KiB result bound (maximum 10 000 rows / 16 MiB), and 64 KiB detail
ranges. Every logical-command result carries metadata read in the same SQLite
snapshot as its payload: database schema version, projection revision,
snapshot watermark (`commit_sequence` coverage), generation IDs,
`pendingDetailCoverage` (delivery-history coverage, complete-detail watermark,
and retained detail bytes), and explicit truncation flags (`rowLimit`,
`byteLimit`, `cellLimit`, `generationIdsTruncated`). Detail
reads return `nextOffset` + `truncated`; page with `offset` instead of
raising bounds. Queries are cancelled by aborting the caller; only that
helper fork is terminated.

The host-side adapter is `CanonicalAnalyticsReadModel`
(`extension/src/analytics/query-entry.ts`). Until the P7a cutover, the
production default stays on the legacy authority; use this skill against a
store you know exists, and treat every explicit error (missing database,
schema-version mismatch) as a hard stop — there is no legacy fallback.

## Primary usage view

`analytics_provider_usage_v1` — one row per settled provider invocation:

| Column | Meaning |
|---|---|
| `invocation_id` | stable billable-invocation identity |
| `generation_id` | producing pie process generation |
| `owning_root_session_id` | root session that owns the settlement (branch/copy work is attributed to the owning root) |
| `provider`, `effective_model`, `purpose`, `outcome` | attribution dimensions |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `provider_total_tokens` | decimal strings; `NULL` = unknown channel |
| `normalized_base_input_tokens`, `normalized_output_tokens`, `normalized_cache_read_tokens`, `normalized_cache_write_tokens`, `normalized_total_tokens`, `normalized_usage_complete`, `reasoning_included_in_output` | engine-normalized channels + completeness flag |
| `reported_cost_usd`, `calculated_cost_usd`, `calculated_cost_complete`, `effective_cost_usd`, `effective_cost_source`, `effective_cost_coverage` | provider-reported vs catalog-calculated cost with explicit coverage |
| `settled_at_ms` | settlement time, epoch ms decimal string |
| `projection_revision` | revision that committed this row |

Scope semantics: every row is attributed to its **owning root session**
(`owning_root_session_id`), so current-branch, inherited, and global scopes
all read the same durable rows — branch/copy identifiers are not projected
yet, so never synthesize branch-local totals; filter by
`owning_root_session_id` instead. Copied/inherited work is counted by
reference to the same settled rows and is not re-added as new global work.

Calendar semantics: bucket on local calendar days/weeks **with an explicit
timezone** (IANA name, e.g. `UTC` when unsure), converting
`settled_at_ms` in the query layer; the projection never stores local dates.

## Examples

Total effective cost and coverage by provider and model:

```sql
SELECT provider, effective_model,
       COUNT(*) AS invocations,
       SUM(CAST(effective_cost_usd AS REAL)) AS effective_cost_usd
FROM analytics_provider_usage_v1
WHERE effective_cost_coverage = 'known'
GROUP BY provider, effective_model
ORDER BY effective_cost_usd DESC;
```

One root session's channel coverage (unknown stays unknown):

```sql
SELECT invocation_id, purpose, outcome, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, provider_total_tokens,
       effective_cost_usd, effective_cost_source, effective_cost_coverage
FROM analytics_provider_usage_v1
WHERE owning_root_session_id = ?
ORDER BY CAST(settled_at_ms AS INTEGER);
```

Current projection revision (cheap refresh check):

```sql
SELECT revision FROM analytics_projection_state WHERE singleton = 1;
```

Detail completeness / pending-coverage state via the `storage` command
(delivery accounting): `deliveryHistoryCoverage` (`complete` vs
`retained_only`), `completeDetailWatermark`, and retained byte counts. A
`retained_only` value means pre-v3 history has no replay/deletion outcome —
say so instead of implying complete history coverage.

## Reading results

- Trust truncation metadata: when `rowLimit`/`byteLimit`/`truncated` is set,
  page or refine the query; never silently widen bounds.
- `detail` payloads are node-v8 representations of captured tool results and
  subagent results (`application/x-pie-tool-observation`,
  `application/x-pie-subagent-result`); `omission_reason` and `capture_stage`
  explain absent content — pending details are not silently zero.
- Reconcile producers with `analytics_producer_reconciliation` /
  `analytics_producer_sequences` (visible sequence gaps mean missing
  upstream facts, not zeros).
- Deleted subjects live in `analytics_deleted_subjects`; their observations
  are durably removed, not scrubbed-in-place.
