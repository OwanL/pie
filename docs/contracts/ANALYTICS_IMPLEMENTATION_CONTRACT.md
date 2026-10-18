# Analytics and runtime storage: implementation contract

Living contract for the implemented canonical analytics authority and the gated session-storage
cutoff. It describes checked-in production source; it is not a plan, a qualification record, or
evidence that any gate has been activated.

[STATE_CONTRACT.md](STATE_CONTRACT.md) remains authoritative for host ↔ webview state sync, and
[ARCHITECTURE.md](../architecture/ARCHITECTURE.md) for the surrounding system. Query-level semantics live in
[`skills/query-analytics/SKILL.md`](../../harness/agent-instructions/skills/query-analytics/SKILL.md).

## 1. Canonical authority

Production host composition is canonical-only. This describes checked-in source mode, not
live activation, delivery, or installation evidence. Activation manifests, tombstones, and old
loaded/terminal receipts are inert historical artifacts: startup neither consults nor updates them.

The host resolves exactly `<data-root>/analytics/analytics.sqlite`. Read-only inspection adopts
its sole persisted capture namespace; an absent or genuinely empty database uses `canonical`.
Ambiguous namespaces, unsupported schemas, and inspection failures fail explicitly without
searching another root or selecting legacy capture. Recorder admission owns initialization and
migration. Namespace identity is not activation or qualification evidence.

One canonical context binds host capture, helper startup, and backend construction. Lifecycle
writer admission remains mandatory. Helpers prove recorder and disposable-query readiness before
accepting captures; helper failure pauses capture with no legacy fallback. Reads use the canonical
read model. Fresh history is captured automatically only in the canonical store; live in-memory
run/session projections remain available. Browser and pruning behavior are unchanged.

Host startup automatically reconciles stale writer identities before opening recorder admission.
Candidates are snapshotted before collecting a complete OS process census. Recovery requires evidence
that the original host, backend owners, and recorder children can no longer write; unknown process
births or an incomplete census prohibit cleanup. This includes orphaned leases attached to hosts
already marked stopped. Cleanup removes only exact-identity writer leases, not analytics or sessions.

Shutdown fences later host startup phases and drains in-flight startup before marking the host
stopped or closing its lifecycle registry. Analytics stop also joins helper startup and its admission
release; helpers cannot publish readiness after stop. A failed analytics start leaves capture closed
while the primary Pie host remains usable, with a warning, rather than selecting legacy capture.

Capture is exclusive: no legacy ledger append or dual-write. There is no import, backfill, or
transcript reconstruction of old analytics. Legacy export is retired; privacy scrubbing and
explicit forget remain. Historical activation tooling is not a production authority selector.

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
  (`analytics/contracts/contracts.ts`) rather than feature-specific stores. Settlements, executions,
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
  costs are not silently rewritten.

## 4. Privacy: delete on explicit close

Privacy mode is session-scoped, reversible, and never sticky. The operational session owner
persists the setting and freezes the value used at close, so a restart cannot change the decision.

- **Retired files.** Privacy scrubbing and explicit forget still remove attributed records from
  preserved legacy analytics files; retirement does not disable these deletion obligations.
- **Canonical authority, session open.** Enabling privacy neither suppresses capture nor scrubs
  existing facts: the session's analytics remain capturable and locally queryable while it is open.
- **Canonical authority, explicit close.** A private close deletes the whole session's captured
  analytics and detail, including pre-toggle activity and child work, and the deletion must succeed
  before the close reports success. Capture arriving during the deletion fence cannot repopulate
  deleted data.

Closing a private session retires the backend runtime, removes the transcript and
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
[`skills/query-analytics/SKILL.md`](../../harness/agent-instructions/skills/query-analytics/SKILL.md).

## 6. Retired legacy persistence and exports

Legacy run JSONL/checkpoint persistence, billable ledgers, activity timeline snapshots/journals,
automatic `run-analytics.json` exports, and the VS Code `pie.exportRunAnalytics` command are retired.
The local DuckDB batch-query workspace is also retired. None is a capture, query, or fallback path.
Existing files, exports, and databases are preserved, not swept or imported. Privacy scrubbing and
explicit forget remain the only deletion paths; retirement does not authorize physical cleanup.

## 7. Gated session-storage cutoff

The transcript-root switch and session closure/expiry behavior are implemented behind an explicit,
evidence-valued authorization: `PIE_STORAGE_CUTOFF_AUTHORIZATION=p7b-authorized-v1`
(`analytics/authority/storage-cutoff-authorization.ts`). With that value the host advertises the
cutoff capability, points the backend's session root at `<data-root>/sessions`, and enables the
gated lifecycle close/forget paths. Without it, the legacy session root and close behavior remain in
effect.

Nothing in this repository establishes that any installation sets that value, so the cutoff, 24-hour
post-closure expiry, and closed-session non-resumption must not be described as active. The settled
policy they implement is: sessions close at the cutoff and expire in place 24 hours after closure,
privacy-on sessions delete immediately instead, new session-owned writes use the final root, and
closed sessions have no Pie UI reopen/resume workflow.

## 8. Fresh history, not historical migration

Legacy history migration and ledger-to-activity healing are retired. Startup does not import,
backfill, reconstruct, or recalculate preserved history. Canonical history starts with newly
captured facts; old files do not establish canonical coverage. Capture fixes do not rewrite existing
canonical settlements. Incomplete or cost-only observations remain canonical facts with explicit
unknown channels, regardless of what a live in-memory projection can display.

## 9. Explicit non-claims

- Analytics activation, the storage cutoff, and cleanup of legacy files are not properties of the
  source tree. Do not report them as completed or in effect.
- This contract does not own field dictionaries, metric formulas, or qualification budgets: the
  implemented schema and read contracts are the authority, and the query skill documents what they
  answer.
- Legacy analytics/review files are not swept. Blanket physical cleanup requires separate approval;
  privacy scrubbing and explicit forget stay the only deletion paths.
