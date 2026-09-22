# Analytics and runtime storage: implementation contract

Living contract for the implemented analytics authority switch and the gated session-storage
cutoff. It describes checked-in production source; it is not a plan, a qualification record, or
evidence that any gate has been activated.

[STATE_CONTRACT.md](STATE_CONTRACT.md) remains authoritative for host ↔ webview state sync, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the surrounding system. Query-level semantics live in
[`skills/query-analytics/SKILL.md`](../skills/query-analytics/SKILL.md).

## 1. Authority

Pie has exactly one analytics authority at a time, decided by the activation manifest in the
resolved state directory (`<data-root>/state/analytics-activation-v1.json`).

- **Legacy authority (default: no active generation).** `AnalyticsRuntime.start()` starts no helper,
  creates no database, and captures nothing. A validated manifest with no active generation
  (candidate or ready) also selects legacy. The legacy owners stay authoritative: the run-analytics
  store and checkpoints under the workspace outcomes root, and the billable-invocation ledger
  (`billable-invocations.jsonl`) plus activity timeline (`activity-intervals.json`) under the
  workspace analytics store.
- **Canonical authority (a validated active generation).** The host validates the manifest, derives
  one descriptor snapshot from it, starts the production recorder, and proves the read path with a
  disposable query. Before capture counts as ready it re-reads the activation and fails closed
  unless that snapshot's authority, manifest revision/hash, and generation identity still match;
  any failure fails startup closed rather than falling back to legacy capture.

Reads follow the same switch. `StatsService.getAnalyticsReadModel()` exposes the canonical read
model only under canonical authority; `queryRunAnalytics()` returns an explicit empty legacy run
layer under canonical authority (canonical usage comes from the canonical read model); and the
canonical activity/facet projections are omitted under legacy authority.

The switch is exclusive and fail-closed:

- Capture is never a dual-write. Under canonical authority a settlement is submitted to the
  canonical recorder and **never** appended to the legacy JSONL ledger; under legacy authority the
  canonical recorder is not started at all.
- Authority is never inferred from the other store's contents. A malformed, oversized, or
  unreadable manifest raises instead of reading as legacy, and any incomplete or inconsistent
  tombstone/manifest combination — a tombstone without a manifest, an ever-active manifest without
  its tombstone, or an ever-active state without an active generation — fails closed rather than
  re-enabling legacy authority.
- There is no import, backfill, or transcript reconstruction of old analytics into the canonical
  store. Canonical facts begin at activation. Canonical collection and queries do not read legacy
  analytics/review files. Explicit legacy export still reads the legacy stores; privacy scrubbing
  and explicit forget can delete legacy records.

Persisted activation state is still validated on read, including the mandatory
`qualificationSha256`/`trialSha256` evidence fields. The one-time admission/qualification tooling
that recorded those fields has been removed from this tree, and any future admission is outside the
retained workflow.

## 2. Storage layout

One OS-local data root owns Pie's persistent runtime data. Pie currently supports Windows only,
where the root defaults to `%LOCALAPPDATA%\pie\data`. It is resolved deterministically, never
searched for.

`PIE_DATA_DIR` overrides it (absolute values are used verbatim; relative values resolve once against
the agent directory or an explicit `PI_CODING_AGENT_DIR`). Resolution failures raise
`PIE_DATA_ROOT_UNRESOLVED` rather than falling back to another root. The derived tree is:

```text
<data-root>/
  analytics/   canonical analytics store and captured payloads
  sessions/    session transcripts written after the storage cutoff (§7)
  artifacts/   Pie-managed feature artifacts
  state/       operational lifecycle metadata and session settings
  cache/       derived, rebuildable indexes and caches
```

The canonical store is one SQLite database at `<data-root>/analytics/analytics.sqlite`. It has no
TTL: ordinary analytics survive transcript expiry, and only explicit privacy deletion or forget
removes them.

Session transcripts keep their existing owners: `PI_CODING_AGENT_DIR` /
`PI_CODING_AGENT_SESSION_DIR`. This checkout's Windows installer pins the session dir to
`<agent-dir>/data/outcomes/sessions`; when neither is configured the host synthesizes no path and
the embedded SDK keeps its own defaults. The `<data-root>/sessions` location applies only under the
gated cutoff in §7.

## 3. Capture boundary

- **Analytics never make agents wait.** Observation and handoff are synchronous and bounded;
  serialization, hashing, and database work happen in the recorder helper process, and admission,
  provider/tool execution, completion, cancellation, and failover never await acceptance,
  persistence, or queue drainage.
- Producers submit typed facts and detail through one versioned contract
  (`shared/analytics/contracts.ts`) rather than feature-specific stores. Settlements, executions,
  tool calls and facets, activity spans, capabilities, and features are facts; large tool/subagent
  bodies are separately addressed detail.
- The recorder owns the database schema, ordered migrations, and projection revisions. Producers do
  not write SQL.
- Aggregates are never derived by scanning transcripts. Missing usage channels are unknown, not
  zero, and int64 values cross the query boundary as decimal strings.
- Pi SDK `usage.cost.total` is a catalog estimate, not a provider invoice. New captures reserve
  `reportedCostUsd` for explicitly labelled provider-reported amounts (including a real zero).
  Otherwise cost is calculated from complete per-invocation channels and provider-qualified
  catalog rates, including the applicable context tier. Subscription-provider catalog costs
  measure estimated usage value, not necessarily money charged to the subscription account.
- A definitive unconsumed non-tail rejection retires the host producer's sequence epoch. New
  captures use a fresh origin/sequence stream; the old reconciliation gap remains auditable.
  Ambiguous transport failures remain replayable and do not authorize sequence reuse. This
  recovery prevents a missing receipt from blocking later accounting; it does not repair lost
  facts or make historical totals complete. Historical SDK estimates already captured as reported
  costs are not silently rewritten by this change.

## 4. Privacy: delete on explicit close

Privacy mode is session-scoped, reversible, and never sticky. The operational session owner
persists the setting and freezes the value used at close, so a restart cannot change the decision.

- **Legacy authority.** While privacy is enabled, run analytics are suppressed and existing
  analytics are scrubbed. Ledger rows for the session stay process-local (never appended to disk,
  never exported), enabling privacy rewrites away already-persisted rows, and closing the private
  session scrubs the in-memory rows.
- **Canonical authority, session open.** Enabling privacy neither suppresses capture nor scrubs
  existing facts: the session's analytics remain capturable and locally queryable while it is open.
- **Canonical authority, explicit close.** A private close deletes the whole session's captured
  analytics and detail, including pre-toggle activity and child work, and the deletion must succeed
  before the close reports success. Capture arriving during the deletion fence cannot repopulate
  deleted data.

Either way, closing a private session retires the backend runtime, removes the transcript and
session-owned sidecars, scrubs attributed records from the retired review sidecars, and removes the
persisted privacy marker only after deletion succeeds. Turning privacy off before close selects
ordinary retention instead.

## 5. Query surface

The canonical store is queried read-only through the four logical commands (`schema`, `query`,
`detail`, `storage`) exposed by the read helper and the `CanonicalAnalyticsReadModel` host adapter.
The helper forks one disposable process per request with bounded rows/bytes, a caller-cancellable
inactivity timeout, and explicit truncation and coverage metadata. A missing database or a schema
mismatch is a hard stop — there is no legacy fallback in the read path. Session-usage refreshes
publish only completed coherent root reads and carry explicit fresh/stale/unknown plus idle/
refreshing/error metadata. Catch-up is bounded under sustained revision changes; same-root stale
reads remain visibly stale, while deletion/privacy/identity fences remain fail-closed. Field-level semantics,
scopes, coverage, and example SQL belong to
[`skills/query-analytics/SKILL.md`](../skills/query-analytics/SKILL.md).

## 6. Retained local analysis tooling

[`analysis/`](../analysis/README.md) is a separate, retained local workspace: it reads privacy-safe
run-analytics exports, legacy storage stores, and the legacy side-channel JSONL sinks, and builds a
DuckDB database for named batch queries. It has no dashboard or static-site pipeline, is not the
runtime query path, and never writes the canonical store. Removing it is not required for the
canonical authority to be active.

## 7. Gated session-storage cutoff

The transcript-root switch and session closure/expiry behavior are implemented behind an explicit,
evidence-valued authorization: `PIE_STORAGE_CUTOFF_AUTHORIZATION=p7b-authorized-v1`
(`extension/src/shared/storage-cutoff-authorization.ts`). With that value the host advertises the
cutoff capability, points the backend's session root at `<data-root>/sessions`, and enables the
gated lifecycle close/forget paths. Without it, the legacy session root and close behavior remain in
effect.

Nothing in this repository establishes that any installation sets that value, so the cutoff, 24-hour
post-closure expiry, and closed-session non-resumption must not be described as active. The settled
policy they implement is: sessions close at the cutoff and expire in place 24 hours after closure,
privacy-on sessions delete immediately instead, new session-owned writes use the final root, and
closed sessions have no Pie UI reopen/resume workflow.

## 8. Historical migration and recalculation

New capture fixes do not rewrite historical ledger or canonical settlement rows. Historical usage
migration is an explicit, restartable operation owned by `BillableAccounting`; it appends only
missing compatibility rows and marks them with `evidenceOrigin: migration`. Its stable invocation
identity is derived from the selected session identity, billable kind, and source row/event id, so a
retry is idempotent and cannot silently replace a live observation.

A separate auditable recalculation is required when a historical catalog estimate must be corrected.
Each run must retain, at minimum, the invocation id, source ledger/run/observation row ids, prior
and replacement cost provenance, the catalog version/rate snapshot used, and the reason for the
correction. It must not present a catalog estimate as provider-reported evidence or mutate the
original source row in place.

Migration and recalculation operators must record bounded-work metrics. The historical migration
reports runs considered, attempted rows, new durable invocation rows, activity-batch flushes,
duration, and cancellation. The ledger-to-activity healing pass separately reports ledger rows
considered, intervals healed, activity-batch flushes, duration, and cancellation. These metrics are
operational evidence of what was attempted; they are not proof that an unobserved provider cost was
recovered.

The legacy in-memory run tracker forwards auxiliary usage only when all token channels are known.
An incomplete or cost-only auxiliary observation is still retained by the billable ledger and
canonical analytics path; consumers that require complete historical coverage must read that
canonical source rather than infer absence from the legacy tracker projection.

## 9. Explicit non-claims

- Analytics activation, the storage cutoff, and cleanup of legacy files are not properties of the
  source tree. Do not report them as completed or in effect.
- This contract does not own field dictionaries, metric formulas, or qualification budgets: the
  implemented schema and read contracts are the authority, and the query skill documents what they
  answer.
- Legacy analytics/review files are not swept. Blanket physical cleanup requires separate approval;
  privacy scrubbing and explicit forget stay the only deletion paths.
