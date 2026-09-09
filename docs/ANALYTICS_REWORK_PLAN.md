# Analytics and session-storage rework — planning specification

Status: scope aligned; full overnight implementation and gated live cutover authorized (§17); engine/performance qualification pending.
Updated: 2026-09-09.

Consolidated planning specification for the analytics and session-storage rework, produced by a
planning-only session. Statuses: **Settled** (approved requirement; implementation agents must not
reopen it), **Proposed** (recommendation to settle in the implementation specification; user policy
choices are marked separately), **Open** (undecided detail with a named workstream, §15). Existing architecture
and `docs/STATE_CONTRACT.md` remain authoritative until implementation updates them with matching
tests; no new production guarantees are claimed. The original planning session authorized no runtime
changes or data deletion. Subsequent execution authorization is recorded in §17; this preparation
session does not perform the rework or activate its retention policy. Authorized disposable mock
experiments and their limitations are in [ANALYTICS_EXPERIMENTS.md](ANALYTICS_EXPERIMENTS.md).

Document ownership: this plan owns settled scope, architectural decisions, open choices and activation
order. [ANALYTICS_IMPLEMENTATION_CONTRACT.md](ANALYTICS_IMPLEMENTATION_CONTRACT.md) owns detailed fields,
metric formulas, lifecycle/query mechanics, schema evolution, task gates and numerical qualification
budgets. Link to the owning rule rather than maintaining parallel specifications. Experiments own
measurement evidence, not requirements; they do not authorize implementation or cutover.
[ANALYTICS_OVERNIGHT_RUNBOOK.md](ANALYTICS_OVERNIGHT_RUNBOOK.md) owns unattended orchestration,
launch preparation and reporting, not a second data specification or task acceptance table.

## 1. Settled scope

**System, capture, and analysis**

- Redesign on the new-device transition rather than carrying forward old datasets, schemas, and compatibility machinery; the old dataset was deliberately not ported to this device.
- One unified analytics system and canonical store; separate processes or workload-specific projections are implementation boundaries, not permission for competing stores. Topology is not selected; bounded representative probes and operational/integration cost decide the engine (§10), not an exhaustive engine tournament; a permanent analytical hybrid is rejected.
- Deliver independently testable removals, analytics replacement and runtime-storage changes separately (§11.6). Preserve the agreed final scope without requiring every workstream to activate in one cutover.
- Rich, low-overhead capture: compact typed records for filtering/aggregation plus selectively accessed larger execution detail in the same system; capture broadly, avoid duplication, retrieve selectively, expose storage consumption by category; inexpensive asynchronous capture, persistence isolated from interactive execution, incremental live summaries, explicit detail retrieval. Never appear fast by reducing capture to sparse summaries, discarding history, or testing only tiny payloads; poor handling of volume — not capture volume — is the problem, and storage efficiency must not come from silently deleting useful analytics. No analytical TTLs, destructive rollups, or sampling compensate for poor volume handling; chunking and archival tiers are not approved default mechanisms.
- Capture for Pie and its subagents only. Standalone Pi CLI capture is out of initial scope; agents may query the store from either environment; no transcript backfill compensates for excluded sessions.
- In-depth analysis informs model and harness choices; most slices have insufficient volume for statistical decisions, so analysis is supplementary evidence, not an automatic decision authority. No automated model/harness tuning in initial scope. Agent query interface (CLI, skill, or similar) is an engineering choice; no further product alignment on its form.
- Reduce complexity across runtime code, data representations, tooling, tests, and docs; preserve useful capabilities, not necessarily their current implementations. Cover MCP, extensions, skills and related harness capabilities: installed/loaded/enabled state, discovered and model-exposed capabilities, pruning/loading/recovery, and execution.

**Live statistics**

- Retain session token/cost totals and attribution, context usage, generation speed, latency, busy working time, and tool/subagent detail; retain overall usage/cost trends, provider/model breakdowns, and current activity (§4). Preserve operational controls independently of analytics.
- Remove the adjusted-input-character productivity metric, including percentile caps, outlier adjustment, and productivity-specific trends. Raw input size remains a possible analysis dimension, not a replacement productivity metric.

**Runtime storage**

- Centralize Pie-owned persistent runtime data under one OS-local data root outside the checkout, with one override and no search across competing roots. Include analytics, sessions, managed artifacts, operational state and supported caches; keep source/configuration, credentials, VS Code preferences and dependency-managed files with their existing owners. OS-temp output may remain temporary. Exact internal layout and serialization are engineering specification (§11).

**Retention and cutoff**

- Delete session JSONL on a rolling deadline of 24 hours after explicit session closure (`closedAt + 24h`), not idle time. **Closed sessions cannot be reopened or resumed through the Pie UI.** The retention window is delayed cleanup, not a resume grace period; no closed-session history/reopen UI is required. Record `closedAt` durably so restarting Pie cannot reset the deadline. This approves the future retention requirement, not deletion of current files during planning.
- If Pie is closed when the deadline passes, physical cleanup runs on its next launch (explicitly approved). No OS-scheduled cleanup task; expired transcripts cannot be opened or mutated. While active, deadline handling revokes/stops any remaining writers before safe physical deletion, rather than postponing until a later idle.
- Session-only sidecars and Pie-managed artifacts expire with JSONL at the same 24h-after-closure deadline (explicitly approved). This includes session settings, managed screenshots and downloads, not caller-owned files or analytics-owned payloads. Durable lifecycle/privacy/trigger state retains its own operational rules.
- Retain captured analytics and detail after ordinary transcript expiry; there is no analytics TTL. Retained history must have essentially no idle CPU/RAM cost and not cause repeated processing. Ordinary expiry removes the conversation artifact, not retained facts/detail; private close and explicit forget are the deletion exceptions.
- **Privacy mode means delete on explicit session close, not prevent persistence.** Analytics and detail may be persisted and queried normally throughout the session. Use the current privacy setting when close mode is resolved: on deletes the entire session's analytics/detail, including pre-toggle activity and subagents; off retains it normally. The toggle is reversible, not sticky. Keep the privacy-mode label; clarify the tooltip as **“Privacy mode: data deleted on session close”**, with corresponding on/off and accessible wording that does not claim analytics is disabled or never persisted. Preserve immediate private-close transcript/owned-artifact cleanup, and prevent late capture from recreating deleted data. This replaces the earlier analytics non-persistence/toggle-time-scrub requirement when implemented; credential exclusions remain and execution follows §17.
- Close all then-existing Pie-managed sessions at the controlled storage cutoff (explicitly approved), using that cutoff as their normal `closedAt`. Their JSONL, sidecars and managed artifacts **expire in place at their existing locations** 24h later; do not relocate them for this final retention window. Sessions whose privacy setting is on at cutoff take immediate private-close deletion. New session-owned writes use the final root. No legacy-session exemption or reconstruction of historical closure times.
- Analytics activation preserves already-open conversations; the later storage cutoff closes them (§11.6). Retained closed transcripts remain evidence until expiry, not resumable Pie UI sessions. Reset analytics at its separate generation activation: no old analytics import or reconstruction of statistics from transcripts; sessions collect only activity since analytics activation, visibly scoped to the new generation. Old analytics/review files stay untouched and unread by ordinary collection/query paths; blanket physical cleanup requires separate approval; privacy/forget scrubbing remains an explicit exception, not a general purge.

**Retirement**

- Completely retire the LLM session-review system: review-triggered and review-tool-initiated session closing, evaluation skill/agent, review readers and storage, review-based quality rankings. No heuristic quality score or independent agent-closing replacement. Preserve manual session closing and ordinary code acceptance-review agents (§6).
- Remove the standalone analytics dashboard entirely; historical analysis is agent-query-first. A future dashboard may consume the data, but no dashboard, static-site pipeline, or UI compatibility is required now (§5). Storage consumption by category is exposed to guide layout and deduplication from actual cost.

**Performance targets**

- **Settled: analytics must never make agents wait.** Agent admission, provider/tool execution, completion, cancellation and retry/failover must not await analytics persistence, commit/detail acknowledgements or queue drainage. Recording must not backpressure execution. Keep producer-side observation/handoff minimal and bounded; serialization, hashing, compression and storage run off the execution path. Measure end-to-end agent impact, not just enqueue latency. This does not waive operational transcript/privacy guarantees or authorize silent data loss; the detailed outage/overflow policy remains deferred, but blocking agents is not an available fallback.
- **Single-digit milliseconds applies to synchronous agent-path observation/handoff overhead, not durable ingestion.** Background ingestion may take longer provided it keeps up with capture, queues remain bounded, live statistics stay reasonably fresh, and growing history does not materially degrade Pie UI responsiveness or agent execution. The purpose is to prevent database growth from slowing Pie, not to minimize commit latency in isolation. Retain single-digit-second historical retrieval and low incremental CPU/RAM. Live daily/weekly cost/token displays use incremental summaries, not repeated historical scans; ingestion work is proportional to newly observed data. The implementation contract §6 owns qualification and resource/freshness budgets.
- Detailed storage outage/loss policy is deferred at the user's request — not selected, waived, or a planning gate; define normal-path batching/acknowledgement for probes without inventing an outage subsystem.

## 2. Terminology

- **Operational state:** session lifecycle, active execution, recovery, tab state, provider queues, privacy/forget behavior. Not disposable analytics.
- **Usage accounting:** attributed provider calls, tokens, cost, and measured activity used by live statistics and historical analysis.
- **Historical analysis:** queries over recorded usage, execution behavior, and configuration for human/agent investigation; no LLM-reviewed outcomes.
- **Performance diagnostics:** measurements explaining runtime latency, resource use, waiting, and failures; trace depth not yet selected.
- **Analytics activation / hard cutoff:** the new analytics generation boundary, with no import of old analytics. Pre/post-cutoff analytical facts refer to this time; it does not close sessions or switch their storage root.
- **Storage cutoff:** the later controlled closure and new-write root switch. All then-existing Pie-managed sessions close and expire in place at `closedAt + 24h`, except immediate private-close deletion. New sessions use the final root. It preserves the already-active analytics generation; do not conflate these two times.

## 3. Current system: owners, evidence, lessons

Scout reconnaissance findings (code-level, not measurements proving the historical slowdown).

```text
Runtime turn/tool observations -> StatsService/SessionRunTracker -> run snapshots, checkpoints, JSON export
Provider usage -> BillableAccounting -> invocation ledger + activity timeline -> live projections
Sessions + review sidecars + pruning/tool/bash side channels + run stores from all workspace shards
  -> analysis source/prepare pipeline -> dashboard artifacts OR DuckDB
```

| Area | Current owners |
|---|---|
| Run stats/snapshots | `extension/src/host/stats-service/{service,tracker,storage}.ts` |
| Provider accounting | `extension/src/host/billable-accounting/service.ts`, `billable-invocation-ledger/service.ts`, `activity-timeline/service.ts` |
| Run analytics/query | `extension/src/host/run-analytics/{query,storage,side-channel}.ts`, `shared/run-analytics-contracts.ts` |
| Dashboard/build | `analysis/scripts/{source,transcript-source,prepare,serve-site,duckdb}.ts` |
| Review machinery | `extensions/session-reviewer/src/`, `extension/src/backend/session-review-store.ts` |
| Session storage | `extension/src/shared/session-storage-paths.ts`, `host/backend/client.ts`, `backend/{session-directory,session-catalog,session-index-store,cold-session-store}.ts`, `sdk-session-ownership-patch.ts` |

| Scaling risk (not yet measured at target scale) | Trigger and implication | Verification needed |
|---|---|---|
| `BillableAccounting.appendUsageSample` calls `projectAll().records.find(...)`; appends invalidate projection caches | Usage recording can rebuild/search total ledger history on the interactive path | Settlement latency and event-loop delay vs ledger size |
| Run persistence reads checkpoint slots and rewrites the session map | Debouncing reduces frequency, not accumulated serialized state | Vary historical session and per-run sample counts independently |
| Automatic exports read history and copy ledger/activity into derived payloads | Recurring history-sized I/O competes with interactive work | Bytes, CPU, lock duration, responsiveness during export |
| Dashboard startup reads all shard stores and parses historical transcripts | Startup work scales with transcript volume | Time each pipeline stage on synthetic multi-shard histories |

`analytics:serve` regenerates data once before serving static files; it is not a continuously rebuilding
watcher and does not use DuckDB. Do not assume the dashboard or DuckDB caused interactive slowdowns.
Existing protections (snapshot/retention limits, debounced persistence, incremental completed-history
caching, bounded chart points) do not bound every ledger, checkpoint, or transcript operation. Lessons:
run analytics is a compatibility dual-write whose snapshots also own productivity/outcome dimensions —
removing them needs an explicit decision per retained dimension. The live UI uses the billable ledger
while analysis derives cost from run tokens and the model catalog — competing cost truths a replacement
must not duplicate. Runtime and analysis source coercion contain hand-synchronized logic; a clean schema
has one owner and one supported reader contract. Transcript reconstruction and legacy attribution fill
historical gaps; fresh capture records required identities at the source. Scientific-looking rankings
do not solve sparse observational evidence; do not preserve ranking formulas merely because they exist.

## 4. Agreed live-stat scope (settled)

| Surface | Preserve |
|---|---|
| Session | Token/cost totals and attribution, context usage, generation speed, latency, busy working time, tool/subagent breakdowns |
| Overall | Usage/cost trends, provider/model breakdowns, current activity |
| Operational, independent of analytics | Queue/retry status, stop/continue/compaction, deferred triggers and their cancellation, session lifecycle controls |

Preserve meaningful distinctions: generation-time vs elapsed-time rate; parallel/additive tool or child
work vs parent wall time; provider-reported usage/cost vs estimates or unknowns. Retaining capabilities
does not require retaining current chart formats or duplicated calculations; no UI redesign or reuse of
the existing implementation is implied. **Settled:** brief reporting delay across Pie windows is
acceptable; displays need not update in lockstep. Use prompt local updates and bounded refresh of small
shared summaries, not historical rescans or a broker solely for instant notifications. Detailed metric,
refresh and restart rules are in the implementation contract §§1–2; its §6 owns tuning budgets.
Display owners: `extension/src/webview/panel/aggregate-stats-strip/`,
`extension/src/webview/panel/composer/working-time-tooltip.tsx`,
`extension/src/webview/panel/session-tabs/token-usage.ts`, `extension/src/webview/context-window/`; host
owners `aggregate-stats-service.ts`, `token-rate-service.ts`, `working-time-service.ts` under
`extension/src/host/`; the aggregate strip also contains deferred-trigger controls, and working-time
detail must not be accidentally removed by deleting a service that currently mixes it with analytics.

## 5. Historical access: agent queries, no dashboard (settled)

Remove the standalone dashboard, static server, dashboard chart code, and the generated site-data
build/validation pipeline (`analysis/site/`,
`analysis/scripts/{serve-site,serve-site-listen,serve-site-paths,site-data,export-site-data,validate-site-data}.ts`,
associated tests, and the `analytics:serve`/site-build commands); check remaining imports before deletion.
Historical data must be flexibly queryable by agents with a clear schema and metric guide, not a fixed
report catalog. Default interface: a small read-only SQL CLI with bounded displayed output, cancellation,
and explicit result truncation; agents may run arbitrary analytical SELECTs, and queries never mutate
canonical facts. No custom replacement analytics UI in initial scope; the in-Pie live strip, context
indicators, and session stats are not the retired dashboard. The fate of remaining DuckDB/query code
follows the chosen store; retaining it is not a requirement. Root dependency installation and dev-command
docs must stop restoring or advertising retired packages/surfaces.

## 6. Review retirement boundary (settled removal groups)

- `extensions/session-reviewer/`, `skills/evaluate-sessions/`, `agents/session-evaluator.md`: automated evaluation, evidence preparation, recovery, persistence, and the blinded evaluation worker. Keep the unrelated code acceptance-review agent at `agents/reviewer.md`.
- `extension/src/backend/session-review-store.ts` and its callers: review decoration/watchers and review-only session-summary fields. **Relocate generic `resolveSessionIdentity`/`sessionPathHash` helpers first** — privacy and analytics filtering still use them.
- `extension/src/shared/review-auto-close.ts` and review-specific outbox handling in the host session service. Ordinary user-driven closing, running-tab hiding, and tab persistence do not depend on reviews and must remain.
- `extension/src/host/session-service/open-tabs-registry.ts` and its `openTabs.set`/worker-registry publication chain currently feeds review tools; recheck consumers before deleting the chain.
- Review-only `reviewMeta` fields/labels across ask-user, extension UI bridge, subagent UI forwarding, and webview. Preserve generic questions and UI bridging; remove `workflowRef` if the final consumer check confirms it is unused. Review ingestion, review-only rankings, outcome correlations, and review evidence artifacts in `analysis/`; review migrations and doctor checks; bundled-extension registration and review tool catalog entry; related tests/fixtures, skill links, and contract documentation.
- Accepted removal: the review tool's agent-initiated closing (`closeReviewed`/`closeSelf`) disappears without replacement; the review outbox is deleted, not recreated.
- **Preserve before deleting reviewer storage:** `extension/src/backend/system-prompt-toggle-store.ts` imports `REVIEWS_DIR_ENV` and writes a session-path-keyed disabled-prompt map to `system-prompt-toggles.json` under `PIE_REVIEWS_DIR`. Prompt toggles are not reviews; rehome them under a neutral session-settings owner (§11.3) before retiring review storage. `extension/src/backend/private-session-artifacts.ts` clears these toggles during privacy cleanup and must keep working.

Update the corresponding normative STATE_CONTRACT clauses and tests during implementation, preserving
shared session lifecycle and privacy behavior.

## 7. Analytics data model and capture contract

Status: Proposed engineering model, with settled capture scope. The implementation contract §1 owns
typed fields, identities, payload representation and child teardown; §3 owns privacy delete-on-close.
Source integration tests must prove coverage. Durable standalone CLI capture is not required by the agreed scope.

One schema/identity model, one canonical analytics database, one collection API, and one documented
agent-query interface. All retained structured analytics goes through this system: provider accounting,
activity/tool timing, retries and child attempts, skill-pruning decisions, tool-result-pruning
measurements, warm-bash execution counters, configuration attribution, and selected runtime health
samples. No individual JSONL side-channel authorities plus a later merge pipeline.

Side-channel producers to integrate rather than merely delete:

- `extensions/skill-pruner/logger.ts`: pruning decisions and recovery/miss events; replaces `data/pruning.jsonl`.
- `extensions/tool-result-pruner/logger.ts`: applied rules and before/after token estimates; replaces `data/tool-result-pruning.jsonl`.
- `extensions/warm-bash/src/logger.ts`: execution counters and warmup/fallback observations; replaces `data/warm-bash.jsonl`. Raw before/after command text is a capture-field choice independent of counters; captured detail is retained.
- Retry/provider/subagent producers: retain measured waits/attempt phases with source correlation rather than copying both detailed facts and inclusive totals.

These extensions also run outside Pie. With CLI capture excluded, an absent Pie collector must not
recreate legacy analytics logs or break ordinary functionality. **Warm-bash and pruner numerical JSONL
sinks must be replaced by the canonical recorder — never copied into new `analytics/*.jsonl` files.**
Raw SDK/pruner output spills stay in OS temp with existing cleanup.

Do not confuse unification with persistence of everything: transcripts, operational session
lifecycle/queues, and privacy state retain their own authorities (analytics observes them and must not
become their control plane); live context/rate estimates and active execution state remain bounded
in-memory projections; raw diagnostic logs remain diagnostic evidence, not numeric analytics — capture
agreed queryable performance facts directly rather than ingesting whole logs.

### 7.1 Logical model

The [implementation contract's field dictionary](ANALYTICS_IMPLEMENTATION_CONTRACT.md#logical-field-dictionary-engine-neutral)
owns the engine-neutral records: analytical sessions,
executions, provider/tool calls and facets, activity spans, component/configuration definitions,
capability sets/observations, feature observations and linked detail. This is one typed model, not a
second operational lifecycle or a mandatory generic event ledger.

### 7.2 Identity and evidence

Reuse source identities and distinguish execution, provider settlement and transcript durability.
Capture once at the source, preserve unknowns and pricing provenance, and link detail without merging
distinct occurrences. Exact key, phase, missingness and numeric rules are owned by the implementation
contract §§1–2; close-time deletion ownership is in §3. No later transcript reconstruction fills gaps.

### 7.3 Accounting scope

Preserve the whole-selected-branch session UI independently of its loaded transcript window.
Historical global usage includes all actual post-activation work, including abandoned branches and
failed attempts. Current local-calendar day/week scope and bounded live rate/context behavior remain;
formulas, source mappings and parity fixtures are owned by
[implementation contract §2](ANALYTICS_IMPLEMENTATION_CONTRACT.md#2-attribution-formulas-and-parity-fixtures).

Branches, forks and copies retain only the relationships needed for correct accounting and deletion,
not a branch-analysis subsystem or new inherited-subtotal UI. Execution/child lineage remains required.
Provide canonical usage/cost SQL views alongside raw read-only SQL, so agents do not reimplement
conservation and missingness rules; these views are derived semantics, not another authority.

Current capture ownership: `StatsService`/`BillableAccounting` in the Pie host persist provider
settlements. Subagents use in-memory SDK sessions (`extensions/subagent/runner.ts`) and deliver
per-response billing evidence plus attempt/aggregate detail through terminal tool results
(`extensions/subagent/src/single.ts`; `extension/src/shared/{subagent-result,session-usage}.ts`).
`src/result-compaction.ts` preserves the final result's nested transcript in parent tool details, but
failed attempts' full transcripts may not survive there; `extensions/tool-result-pruner/{index,reaper}.ts`
keeps some pre-pruning text only in temp recall files. Capture required attempt/pruning evidence when
observed instead of relying on transcript or temp-file reconstruction.

## 8. Harness and capability capture; MCP as tools

Status: settled modeling, open coverage details. The model must answer both what executed and what
could have been used. Capture catalogue/configuration definitions when they change and reference them
from calls/decisions; a provider invocation needs the effective capability/context-set identity, not a
fresh copy of every schema and skill text. Preserve actual exposure separately from the globally
available catalog, including subagent differences. Never snapshot credentials or authentication material.

| Domain | State to retain | Observations to correlate |
|---|---|---|
| Extensions | Source/package or build identity, enabled vs loaded state, effective configuration, owned tools/hooks | Load/error and configuration transitions; hook timings where directly instrumented |
| Skills | Name/source, content identity, discovery/catalog membership, model-invocation eligibility | Exposure/pruning decision, observed content load, recovery/miss, execution context |
| Ordinary tools | Tool identity, source/owning extension, schema/version | Availability, exposure, recovery, invocation, typed result facets |
| MCP-backed tools | Shared tool definition with source/owner, server, original remote name/schema, proxy/direct mode | The shared tool-call record with resolved remote identity; optional nested calls/phase measurements in the common lineage model |
| Context/harness treatments | Effective prompt/catalog/configuration references, compaction and result-pruning definitions | Changes, actual exposure, measured/estimated size effects, attributable auxiliary calls |

A discovered skill is not necessarily exposed; an exposed skill is not necessarily loaded; an observed
read does not prove the model followed it; configured MCP servers are not necessarily connected. Use
these specific observation names, not a generic `used=true` flag. Preserve provenance/coverage where a
loading route is not observable.

MCP simplification (settled): one tool-definition model and one tool-call model for built-ins, extension
tools, MCP gateways, and remote tools, with typed source-specific fields (server, original remote name,
registration mode, protocol correlation). No separate MCP persistence, aggregation path, or MCP call
tables. Enrich outer `mcp` calls with resolved server/remote identity; for `mcpScript`, capture observed
inner calls as children using the same tool-call structure where the adapter exposes reliable evidence;
keep parent wrapper identity/timing. Optional nested lineage:

```text
root session -> execution -> outer mcp/mcpScript/direct tool call
  -> MCP search/describe/connect/auth-wait or remote invocation
      -> server + original tool/resource + attempt/protocol correlation
```

Define whether a tool-count query counts outer calls or nested remote calls; remote call totals may
exceed script elapsed wall time. If remote usage/cost is not reported, do not manufacture it from the
parent LLM call. Full protocol-level discovery/auth/connection tracing is optional detail, not a
prerequisite. Capture seams and limitations:

- `extensions/skill-pruner/src/{register,tools}.ts` observes pruning and successful `request_capability` recoveries; its logger records some skill reads/misses. Empty discovery polls and other loading routes are not equivalently instrumented; add specific source observations, not transcript scans.
- `extension/src/backend/{session-analytics,session-opened}.ts` capture selected factors and loaded extension IDs; `getAllTools().sourceInfo` supplies tool ownership. Run-start settings alone do not describe all mid-execution changes.
- MCP is implemented by the pinned external `pi-mcp-adapter` (see `docs/MCP.md`); Pie mostly sees outer calls. The adapter has result metadata, script operation timing, and optional protocol tracing, but no complete stable nested-call bridge into Pie analytics today. Complete nested attribution needs a supported adapter seam or reproducible pinned package change; establish that before claiming complete inner-call capture. Do not edit a machine's installed dependency as the durable implementation or silently substitute gateway counts for remote metrics. Adapter output guards and temporary spill files can lose detail needed after expiry; capture agreed analytical detail at the producer boundary. Connection/auth telemetry concerns status/timing only, never credentials.

Example investigations supported: skills repeatedly pruned then recovered; capability exposure changes
after harness revisions; which extension supplied a tool; which MCP server/call caused script delay;
discovery vs execution latency; configuration changes coinciding with retry/error/usage shifts.
Descriptive comparisons, not causal quality rankings.

## 9. Rich detail and diagnostics

Status: rich capture and referenced child detail are settled; the implementation contract §1 owns
field coverage and representation rules. Keep compact typed facts separate from selectively retrieved
commands, arguments/results, failure output, mutation evidence and configuration/pruning detail.
Ordinary scalar queries do not materialize those payloads. Sensitive-data/credential exclusions still
apply; privacy follows delete-on-close (§1), not suppression while the session is open.

**Settled representation:** retain child detail once. Parent subagent results reference that content
and retain distinct parent text/metadata; explicit queries reconstruct the complete nested view.
Preserve content and structure, not byte-for-byte copies of every wrapper serialization. Whole-payload
hashing alone does not deduplicate embedded transcripts. This changes analytical representation, not
the SDK transcript format or the current live transport contract.

**Settled simplicity preference:** start with payloads in linked tables within the same canonical
database as the typed facts. Keep that monolithic design if it meets practical performance needs.
Revisit physical separation of high-frequency/hot facts from larger, less frequently accessed detail
only if measurements show a practical problem and the benefit justifies the added complexity; no split
or additional analytics authority is selected.

**Settled content reuse:** include cross-session deduplication of identical payload content. Share
bytes, not execution identities or session ownership; private close must remove that session's evidence
without deleting another session's independently captured copy or preserving private-only content.
Implement within the canonical store's content/reference relations, not as a separate service. Measure
storage savings and overhead; expected savings are not yet demonstrated. Hashing and optional
compression stay off the execution path, without rescanning history or adding sampling/TTLs; evaluate
compression from actual savings. A hash or temp-file path is not retained evidence. The implementation
contract owns completeness/availability, reference deletion and bounded reconstruction rules.
No new final-worktree diff collector is required.

Session JSONL is conversation/tool evidence, not a complete measurement of runtime health. Keep stable
database-to-transcript references, but do not infer event-loop stalls, storage latency, or renderer
delay from message timestamps. Existing reusable instrumentation — do not build a second tracing stack:
`extension/src/shared/live-pipeline-trace.ts` (opt-in stage events, backend event-loop histograms,
writer queues/durations, transport/render evidence); `extensions/subagent/src/runtime-trace.ts` (opt-in
phase durations, byte/serialization measurements); `extension/src/host/util/stream-telemetry.ts`
(opt-in stream/snapshot rates, acknowledgement latency); `stats-service/service.ts` startup stage
metrics and activity-timeline IO counters (some evidence currently reaches only logs or process-local
counters). Local runtime performance (CPU, memory, event loop) is not in the current run snapshot
contract; inventory any separate diagnostic instrumentation before adding new capture.

Proposed small durable addition (not yet selected): bounded runtime health summaries (event-loop delay,
ingestion backlog/commit duration, relevant startup and transport/render timing) emitted directly
through the unified recorder. Detailed per-frame traces remain opt-in; their storage policy is
undecided. Do not use new `pie.log` records or legacy run snapshots as the replacement numeric
authority. Captured diagnostic analytics follows the same no-TTL policy.

## 10. Performance targets and engine direction

Settled targets: single-digit-ms synchronous agent-path overhead, single-digit-second historical
retrieval, low incremental CPU/RAM, and incremental live summaries with restart that does not replay
all history. Background ingestion need not commit within single-digit milliseconds; qualify throughput,
bounded backlog and end-to-end display freshness while protecting agent and UI responsiveness as the
database grows. Retrieval may yield to capture; do not optimize query latency at the cost of growing
ingestion queues. Observation/handoff, commit/query visibility, and live display freshness are separate
measurements. Analytics admission and fact/detail acknowledgements are asynchronous observations, not
permission to start, finish or retry work. Detail drainage must have ownership independent of a child's
execution lifetime; keeping capture alive must not keep the agent waiting.

Engine feasibility findings: repository Node is pinned to 24.16.0, and `node:sqlite` is already used by
`extension/src/backend/session-index-store.ts` (WAL, cross-process readers), loading under the pinned
local Node. The VS Code host is Electron; do not assume repo Node built-ins there. `node:sqlite` has a
synchronous API — place database work in a standalone-Node helper, not on the interactive host event
loop. Extension builds bundle JS and omit native binaries from the VSIX; the SQLite built-in avoids a
new native dependency path. DuckDB can remain external tooling but is not needed merely to expose SQL.
Current DuckDB usage is a separate batch query/build package — an implementation choice, not an engine
limitation: DuckDB supports direct incremental inserts without JSONL, exports, or periodic rebuilds;
compare that design fairly, since event files plus a second query database would retain avoidable
replay/rebuild machinery. Backend runtime resolution accepts a broader SDK Node range than the repo
pin; define the helper's Node prerequisite and validate it rather than silently failing capture.

Proposed ingestion/query flow:

```text
Pie + subagent observations -> shared typed recorder API, stable source IDs, producer idempotency keys
  -> bounded asynchronous IPC; no database or historical work in host callbacks
  -> dedicated Node persistence helper; short time- AND size-bounded batches
  -> one database: canonical facts + explicitly derived incremental summaries
       -> small live projections returned to Pie; read-only SQL CLI for agent investigations
```

| Fact or behavior | Target authority | Live/history relationship | Legacy disposition |
|---|---|---|---|
| Provider invocation tokens/cost | Canonical invocation records | Incremental live summaries and SQL derive from identical settlements/pricing | Replace the JSONL billable ledger; no dual-write or import |
| Busy/provider/tool/retry/auxiliary time | Correlated span/interval facts | Active intervals may tick in memory; settled totals and history use the same facts | Replace activity JSON/journal and run-based timing fallbacks |
| Tool/feature observations, configuration | Typed facts/configuration records | Small live projections where needed; flexible historical SQL | Replace historical run snapshots and individual side-channel logs |
| Active session/execution recovery | Existing operational session owners with necessary live-state extraction | Analytics observes boundaries; not the recovery authority | Remove analytics-only checkpoints after extracting required operational behavior |
| Privacy/forget | Operational owner fixes the setting at close and requests recorder deletion | Open-session capture is normal; private close scrubs all attributed facts/detail and derived contributions, rejecting late writes | Required legacy session-specific scrub remains separate from ordinary collection/query |

Maintain only summaries required by live consumers: session usage, daily/provider/model buckets and
necessary timing state. Updates, scope corrections and close-time removals follow canonical facts and
the implementation contract §2, never independently authored totals. Use indexed session/time/model/
workspace query paths; an explicit maintenance rebuild may scan facts, but normal event handling and
startup must not require it.

Two viable physical topologies (neither approved or demonstrated at target scale):

| | SQLite | DuckDB |
|---|---|---|
| Persistence ownership | One helper per Pie host, short transactions into one WAL database; no shared broker required | One shared broker per data authority owns the read-write database; all hosts send records to it |
| Agent reads | Separate read-only query process, independent of recorder event loops | CLI submits SQL to the broker; separate connection, bounded query concurrency within the owner process |
| Strength | Small incremental writes/indexed lookups, simple independent readers, built-in runtime dependency | Rich analytical SQL and broad aggregation/scans without an extra analysis engine |
| Cost/risk to prove | Cross-host writer contention, long-read checkpoint lag/WAL growth, large analytical query cost | Broker discovery/lifetime across hosts, native packaging, query CPU/memory contention with ingestion |

Cross-host reporting may lag (§4). The implementation contract §2 owns bounded shared-revision checks
and small-summary refresh, including deletion; §6 owns their resource/freshness budgets. Count this
coordination cost in either topology. Do not introduce a broker solely to synchronize displayed stats.

A shared SQLite broker is possible, but do not add singleton lifecycle machinery without demonstrated
need. Under the embedded ownership model, do not assume a separate process can open the live DuckDB
file for independent queries while its read-write owner is active. Neither WAL nor separate processes
eliminate CPU/memory/disk competition; do not claim a long query can never affect ingestion. Limit
query concurrency, provide cancellation, and test committed-ingestion latency under concurrent scans.
For SQLite, long reader snapshots can delay checkpoint progress; for DuckDB, an async Node API does not
guarantee ingestion priority over native analytical work.

### 10.1 Bounded selection, then selected-design qualification

**Settled direction:** engine selection is a bounded engineering decision, not a prerequisite to
building an exhaustive benchmark framework. No shipped pluggable-engine layer or permanent hybrid.
Start with a thin SQLite capture-to-query prototype because its incremental writes, independent readers
and runtime packaging fit the required workload. **First prove the real capture boundary:** large
nested-child results, referenced detail and teardown without persistence waits, including producer-side
serialization/copying and independent payload ownership. Only then spend more effort tuning the engine.
Continue through projection, restart, concurrent capture/query and multi-host paths. The implementation
contract §6 owns the probe procedure; this remains one thin prototype, not a new benchmark framework
or production activation. Full capture completeness still requires source integration tests.

Use the existing corrected comparison plus a focused native DuckDB comparison only where an unresolved
requirement could change the choice. Compare equivalent facts, payloads, durability and validation;
include serialization/IPC/compression cost. Weight execution isolation, packaging, process ownership
and maintenance cost explicitly alongside write/query latency. Select when the representative path
meets its gates and remaining risks are named; if it fails, investigate that failure or the alternative,
not every combination of both engines and all topologies. Record the decision and stop the comparison.

Then qualify the selected implementation at realistic scale before production activation. Choose and
record representative conditions and required scale; extend only for a named risk. Rich payloads,
correctness, no-wait behavior and resource bounds remain requirements, not shortcuts to trade away.

### 10.2 Qualification ownership and current evidence

[Implementation contract §6](ANALYTICS_IMPLEMENTATION_CONTRACT.md#6-performance-qualification-and-budgets)
owns the workload envelope, measurement procedure and proposed percentile/CPU/RAM/queue budgets. Those are engineering targets to qualify, not already demonstrated
production guarantees; cross-window reporting delay is accepted separately from ingestion latency.
[Corrected mock experiments](ANALYTICS_EXPERIMENTS.md) cover 100k facts and a short mixed workload,
not the real producer handoff or production-scale qualification. They do not establish the agent-path
overhead or UI/agent non-interference targets; their commit latency is not a measurement of synchronous
agent overhead. Invalidated preliminary comparisons remain excluded from selection.

## 11. Proposed runtime-data root and layout

The OS-local single-root direction is **Settled**. Default path spelling, override name, internal tree,
matrix and cutover mechanics below are engineering proposals. Session-only sidecars/artifacts share
the agreed JSONL deadline. At cutoff, existing sessions close; ordinary files expire in place 24h later,
while private close deletes immediately. Their files are not relocated into the new root (§11.5).

### 11.1 Root resolution

One OS-local, per-user runtime-data root outside the source checkout, resolved deterministically once
per host process:

| OS | Proposed default root |
|---|---|
| Windows | `%LOCALAPPDATA%\pie\data` |
| macOS | `~/Library/Application Support/pie/data` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/pie/data` |

- One override: `PIE_DATA_DIR`. The exact spelling is an engineering proposal, not already implemented. Absolute values are used verbatim; relative values resolve once against a documented anchor (proposed: the agent dir); tilde is expanded. Resolution failure is an explicit error — never a silent fallback to another root.
- The resolved root is forwarded as absolute paths into backend workers, subagent child runtimes, and query tooling via the existing forwarding pattern (`extension/src/host/backend/client.ts` resolves/forwards absolute roots and environment). The SDK receives a derived `sessionDir` (and corresponding env) computed internally from the root; it does not get independent user-facing overrides of SDK internals. Existing agent/config/auth roots remain separate and keep their owners.
- Installer/doctor remove competing analytics/session fallback roots (a separate analytics resolver such as `PIE_ANALYTICS_DIR`, legacy root merging) at the corresponding category's explicit activation (§11.6), not by coupling all categories into one cutover. No global environment or machine-wide changes are made now. Cwd/workspace remains metadata/filtering, not another implicit authority.

### 11.2 Root tree and transcript layout

```text
<pie-data-root>/
  analytics/                               canonical analytics store + captured payloads (engine per §10)
  sessions/                                new SDK transcript JSONL after storage cutoff
  artifacts/<stable-session-id>/<feature>/ computer-use, playwright, and similar outputs
  state/                                   operational lifecycle metadata + session config sidecars
  cache/                                   derived rebuildable indexes and supported runtime caches
```

- These are purpose namespaces, not a decision for every backing format, and not multiple analytics databases: one canonical store lives in `analytics/`.
- The SDK custom `sessionDir` is used verbatim and flat: `dist/core/session-manager.js` writes `timestamp_<uuid>.jsonl` directly in the configured directory. New sessions use that flat layout. Existing trees mix flat SDK files and legacy nested cwd buckets; cutoff closes those sessions and leaves their files unchanged for expiry in place. No transcript copying, mass renaming or schema fork is needed.
- Reuse the SDK writers and current cold/read fencing plus incremental/lazy catalog reads (`session-directory`/`session-catalog`/`session-index-store`, `cold-session-store`, the SDK ownership patch) instead of raw filesystem operations.
- `artifacts/<stable-session-id>/<feature>/` avoids feature directories stranded beside deleted transcripts. In-memory child attempts need root-session plus execution attribution; do not invent child transcript files.

### 11.3 Location and authority matrix

| Category | Current writer (owner) | Proposed location | Authority and retention | Dependencies / notes |
|---|---|---|---|---|
| Canonical analytics + captured payloads | `stats-service`, `billable-accounting`, `billable-invocation-ledger`, `activity-timeline`, run snapshots, `analysis/` DuckDB build | `analytics/` | No TTL; retained unless deleted by private close/explicit forget | One engine/owner from probe result; legacy analytics not imported; open privacy-enabled sessions capture normally |
| Session transcripts (JSONL) | SDK `session-manager` via `session-storage-paths.ts` + `host/backend/client.ts` forwarding | `sessions/` for new sessions; cutoff transcripts stay in place | Deleted at `closedAt + 24h`; evidence links then expired | SDK-owned writes; cold/read fencing; catalog incremental/lazy reads; format unchanged |
| Session config sidecars | `mcp-session-config.ts` (`<session>.mcp-overrides.json` sibling); `system-prompt-toggle-store.ts` (`system-prompt-toggles.json` under `PIE_REVIEWS_DIR`) | `state/session-settings/` keyed by stable session id | Expires with JSONL at `closedAt + 24h` (settled) | Toggles rehomed out of reviewer storage before review retirement; privacy cleanup already clears toggles |
| Browser/desktop artifacts | `extensions/computer-use/src/artifacts.ts`, `extensions/playwright/src/artifacts.ts` (direct Pie-owned resolvers) | `artifacts/<stable-session-id>/<feature>/` | Expires with JSONL at `closedAt + 24h` (settled); caller-owned upload/download targets outside the managed root are never swept | `backend.mjs` quotas + partial cleanup are not proven general expiration; `setInputFiles` uses caller paths; no durable upload archive exists |
| Operational lifecycle metadata | `host/deferred-triggers/store.ts` + `shared/deferred-triggers-paths.ts` (`triggers.jsonl`, hard-link claims); new closure metadata | `state/` | Durable, not disposable; NOT a retired analytics ledger | Backing open (§11.4); behavior preserved |
| Operational session catalog/index | `backend/session-{directory,catalog,index-store}.ts` (SQLite + WAL) | `cache/` | Rebuildable cache; **not** the sole `closedAt` authority | Incremental fingerprint-checked inventory and lazy reads preserved |
| MCP/web-search/model caches | Pinned external packages: `npm/node_modules/pi-mcp-adapter/{metadata-cache,npx-resolver}.ts` (`mcp-cache.json`, `mcp-npx-cache.json` follow agentDir; no independently verified data-only override); `npm/node_modules/pi-web-access/{storage,utils}.ts` (web-search cache, 1h TTL/128 entries/128 MB); `extensions/copilot-model-discovery` marker+lock | `cache/` only via a supported new package seam or reproducible pinned update | Rebuildable caches; TTLs owned by their packages | Never edit an installed dependency or repoint the entire agentDir/auth; npm `_npx`/package install trees remain npm-owned; an unsupported integration is a named dependency, not a silent second root; model config/pricing authority is not moved; the freshness marker may move, but its configuration-writer lock stays scoped to the same `models.yaml` target across all data-root overrides (retain the current lock owner until that is demonstrated); existing snapshot pricing in analytics is permanent, `model-pricing-history` compatibility is not required |
| VS Code state | Host-owned `globalState`: open/pinned/active tab paths, preferences, private-session UI markers | Existing owner | Preferences unchanged; tabs keep their existing owner; never blanket-swept | Persist cutoff closure without restoring the old tabs or remapping paths; privacy UI reflects the operational setting used at close, not a second capture policy |
| Diagnostics/temp spills | `pie.log`, opt-in pipeline/stream/boot traces, bash output spills, tool-result-pruner recall stashes, raw SDK/pruner output spills | OS temp / log locations, outside the root | Preserve existing bounds; verify missing boot/stream trace cleanup rather than claiming every log is bounded | Numerical sinks go through the canonical recorder, never copied to new `analytics/*.jsonl`; outside Pie these extensions never recreate legacy analytics logs |
| Auth, configuration, dependencies | Secure auth store; `settings.json`; `models.yaml` + sync-models; skills/extensions/source; npm/package install trees | Unchanged external owners | Never expired or swept | Do not relocate source files or capture credentials. Non-secret effective configuration, capability definitions and pricing snapshots remain required analytics (§7–8) |
| Retired analytics/review files | Legacy `data/` analytics, review sidecars and dirs | Not moved | Untouched and unread by ordinary runtime; physical cleanup is a separate approval; privacy scrub remains the exception | Old roots stay reachable only for privacy-scrub boundaries |

Session-owned destinations govern new writes after cutoff. Existing closed transcripts, sidecars and
artifacts retain their exact locations solely for evidence/cleanup until deletion, not as a competing
runtime root. Do not copy or rekey those files just to expire them. Earlier extraction of shared prompt
settings for review retirement remains separate (§6).
Centralization does not approve blanket deletion; every row keeps its explicit owner and retention.
The ordinary deadlines do not delay private-close cleanup (§1).

### 11.4 Operational lifecycle metadata

Status: separate indexed operational backing is the starting architecture; exact primitives remain
to qualify. Operational session state owns closure, expiry, the reversible privacy setting and
cleanup intent. The host's existing reducer/effect close operation remains its command/acknowledgement
boundary; analytics observes lifecycle rather than controlling execution. The implementation contract
§3 owns fields, close mechanics and tests. Do not create a competing close registry or growing closure
JSONL, and do not treat the rebuildable catalog as the source of `closedAt`.

#### Operational backing choice, independent of the analytics engine

Both candidates below use an indexed durable lifecycle record. Its fields/close-barrier owner are the
same regardless of physical location; placement does not transfer control to analytical queries.

| Candidate | Advantages | Costs / required proof |
|---|---|---|
| A: operational tables colocated with the selected canonical database | One database runtime/transaction owner; indexed session lookups and due-deadline range queries; lifecycle/privacy and analytical rows can participate in a DB transaction | Lifecycle commits share the persistence path with ingestion and queries. Operational tables must survive analytical projection rebuilds and generation changes. A DB transaction does not make transcript-file deletion or VS Code persistence atomic |
| B: dedicated indexed operational backing under `state/`, reusing SQLite capabilities if appropriate | Lifecycle remains independent of analytical scans and engine resets; existing SQLite indexing/fencing knowledge is reusable; native due-deadline index | Additional durable-store ownership and coordination with analytics/privacy; still shares CPU/RAM/disk. This is operational storage, not a SQLite-to-DuckDB analytics pipeline. No second token/cost authority |

Do not put sole lifecycle records into the current disposable session-catalog file unchanged:
`backend/session-index-store.ts` legitimately removes that whole file during invalidation. Candidate B
must either use a distinct durable store or deliberately change catalog ownership so rebuilds replace
only derived tables, with tests proving lifecycle preservation. Per-session JSON files are not assumed
cheaper: without a maintained due index they require history-sized enumeration at startup/sweeps;
adding a second index/journal solely to compensate would undermine the simplification goal.

Start with B, a distinct operational SQLite store for indexed durable metadata, independently of
analytical engine selection. **Coordination direction:** protect transcript mutations and revocation
per session across hosts; do not hold a database-wide write transaction across SDK filesystem writes.
A slow write in one session must not serialize unrelated sessions through a shared transcript-write
lock. Prototype the session-scoped mechanism and crash/revocation behavior before adopting it; exact
locking primitives remain an engineering choice. Short metadata transactions are distinct from the
filesystem critical section. A remains an alternative only with equivalent isolation and fencing proof.
Neither placement alone revokes SDK write authority; the per-session boundary must serialize the epoch
check and actual mutation against revocation, not merely check an epoch before an unprotected append. The implementation contract §3
specifies the proposed close acknowledgement, row fields, mutation barrier and deadline handling.
Point-query mocks do not prove those guarantees. Detailed storage-outage behavior remains deferred.

Privacy no longer requires capture suppression or cross-store checks whenever its toggle changes.
The operational owner selects delete-on-close; the recorder owns atomic deletion/rejection within the
analytics database so late delivery cannot restore erased data. The implementation contract §3 owns
this close-time boundary. No general distributed transaction or local-user isolation subsystem is
needed, and ordinary execution remains independent of analytics persistence.

### 11.5 Expiry semantics and activation policy

Settled anchors: JSONL is deleted at `closedAt + 24h`; the clock starts at explicit closure, not
response completion, last modification, or idle. Closed sessions cannot be reopened/resumed through the
Pie UI; keeping their files for 24 hours does not introduce such a workflow. The deadline survives
restart because `closedAt` is durable. A running-tab hide is not execution termination or closure, and
application shutdown is not explicit session closure. Retention uses a retention-specific operation
through established session ownership and cache-invalidation boundaries, not a filesystem timer.
Explicit privacy/forget still scrubs analytics while ordinary expiry preserves it. The review outbox
is retired and must not become the retention mechanism. Do not derive closure from transcript `modifiedAt`.

Current-document drift: STATE_CONTRACT's Session Cleanup section still claims a session-history menu
for closed sessions, which the current tab UI does not expose. Reconcile that clause and its relevant
tests during implementation; do not build a reopen feature to satisfy stale wording. Existing lower-level
transcript readers are not a promised UI resume path, and stale cross-host writers still require fencing.

**Settled retention extension:** session-only sidecars and managed artifacts (session settings,
browser artifacts) follow the same 24h-after-closure deadline. Caller-owned upload/download targets
outside managed storage are never swept; ordinary expiry retains captured analytics payloads.
Private close uses the separate immediate deletion policy in §1.

**Settled cutoff policy:** explicitly close all existing Pie-managed sessions at cutoff and record
that actual cutoff closure time as `closedAt`. Their JSONL, session-only sidecars and managed artifacts
expire in place after 24 hours; new session-owned writes use the final root. Store exact old cleanup
targets under the operational owner, without copying files, creating destination mappings or retaining
a fallback runtime resolver. Do not introduce a grandfathered/no-timestamp branch or infer old closures
from `modifiedAt`. Establish the quiet boundary first: stop/settle running work through the normal
lifecycle before closing, since a running-tab hide alone is not closure. Each session's privacy setting
at that close selects immediate deletion or ordinary expiry in place. Execute this cutover only under
§17's authorization and gates, not as part of the preparation session.

Implementation requirements and unresolved mechanics:

- Distinguish normal expiry (analytics preserved) from private forget (scrubs analytics and attributed artifacts), and running-tab hide from closure/cleanup. Retries never reset the first closure deadline; retention requires no closed-session UI restoration.
- **Shared-root expiry needs genuine cross-host write revocation/coordination, not only a sweeper lock.** Current coordinator leases are process-local and do not solve cross-host cases.
- **Scheduling (settled policy):** physical cleanup waits for the next Pie launch if Pie is closed at the deadline. No OS task or wake requirement. Active hosts use indexed due-deadline scheduling plus startup/system-resume checks; admission/mutation checks reject expired sessions independently of timer delivery. At the deadline, revoke and stop any remaining or stale cross-host writers before deletion, not at an arbitrarily later idle. This protects cleanup races, not a supported closed-session resume workflow. Physical deletion follows safe drainage/OS availability; blocked cleanup is visible. The implementation contract §3 specifies proposed mechanics and required race tests.
- Include sidecar/detail-reference handling in deletion so artifacts do not orphan; a reused file path must never resolve to another conversation; evidence links need an explicit expired/unavailable state.

### 11.6 Staged delivery and expire-in-place storage cutoff

**Settled delivery direction:** separate the changes below rather than one all-workstream activation.
The user has given execution approval for both production activations in the overnight run (§17).
Approval does not waive their separate readiness, ownership, privacy or performance gates.

1. Retire review/dashboard surfaces independently after extracting shared helpers/settings and preserving
   privacy cleanup. These removals do not depend on the new engine or expiry implementation.
2. Fix the final root resolver and build/test the analytics vertical slice independently of the session
   root switch and expiry. Activate the fresh analytics generation at a quiet boundary once recorder,
   delete-on-close, retained detail, live accounting and query readiness are verified; switch the old
   analytics authority off without import or dual-write. Switch analytics privacy semantics with this
   activation, preserving current behavior until then. Analytics uses its final resolved root; existing
   sessions keep their explicit transcript locations through closure and expiry.
3. Prototype and validate session-scoped lifecycle coordination separately. Switch new session-owned
   writes to the final root and activate expiry only after replacement capture retains the required
   evidence. The storage cutoff closes all then-existing Pie-managed sessions and starts their normal
   24h deadlines in place, except immediate private-close deletion. It does not reset analytics or
   reconstruct historical closure times.
4. Deliver supported external-package cache relocation separately; it does not gate analytics activation
   or safe session expiry. Until its explicit switch, each category keeps its one known owner/location,
   not fallback/search across roots. Final single-root completion waits for those seams and cutoff-file
   cleanup; temporary, fixed cleanup targets are not permanent competing runtime resolvers.

The bounded storage cutoff coordinates closure, writer fencing and new-write routing, not a file
migration:

1. Inventory only explicitly configured source roots. Record exact transcript paths, stable header IDs and proven session-owned sidecar/artifact targets. Use existing computer-use/Playwright resolvers, including their path hashes, rather than guessed filenames. Report missing/malformed IDs and ambiguous ownership without inventing identity or sweeping unresolved files.
2. Stop admission across affected hosts, including hidden running sessions and trigger dispatchers. Stop/settle work through the normal lifecycle and coordinate trigger cancellation/claims through their existing owner. Fence old writers and revalidate the inventory under that boundary; abort if ownership cannot be established. Never copy trigger claims or make them dispatchable twice.
3. Durably record fixed cleanup locations in the operational owned-target store before closing all sessions through their normal barriers. Ordinary closes record the cutoff timestamp/deadline and leave transcripts, settings and artifacts unchanged until expiry; private closes delete immediately. Persist closure through the existing tab owner without restoring the old open-tab set. No copies, destination validation, path remapping or cutoff-only sidecar rekeying. Required legacy privacy-scrub targets remain addressable.
4. Activate final-root routing for new transcripts, session settings and managed artifacts, plus the durable expiry scheduler. Release admission only for hosts using the new routing/ownership policy; old writers remain fenced. Keep the already-active analytics generation and captured facts unchanged. Ordinary runtime resolution/catalogue reads use the new root, never fallback discovery of closed cutoff sessions.
5. Clean fixed cutoff targets at their recorded deadlines through the same indexed scheduling, identity checks and safe deletion boundaries as new-root sessions. If Pie is closed, cleanup runs on its next launch. Interrupted or blocked cleanup remains visible and retryable; it is not permission for indefinite retention or blanket deletion of old directories. Existing read tooling may inspect retained evidence by exact path before expiry, without UI resume support or analytics backfill.
6. Update installer/doctor for the active locations and report pending cutoff cleanup and package-cache seams rather than claiming premature single-root completion. Legacy analytics/review files remain untouched except required session-specific privacy/forget scrubs; their blanket disposal still requires separate approval.

Fixed cleanup targets belong to the operational store, not a second root resolver or migration
framework. The preparation session performs neither runtime cutover nor physical deletion; the
subsequently authorized overnight execution follows §17.

## 12. Analytics activation and retirement

Decision: preserve transcripts, reset analytics. This section's cutoff is analytics activation, not the
later storage-cutoff closure/deletion schedule (§11.6). Already-open conversations remain usable until
explicit closure or storage cutoff; analytics activation does not close them. Their prior tokens,
cost, time, and activity are outside the new analytics population. Session IDs remain usable
correlation identities; new-generation statistics are never presented as lifetime totals for pre-cutoff
sessions. Implementation defines an explicit generation/activation boundary, isolates new storage from
legacy readers/writers, and prevents cached legacy dashboard artifacts from appearing as current
results. Prefer controlled activation after active work settles rather than migrating an in-flight run.

Retire rather than preserve: old analytics schema coercion, legacy cohorts, path-based identity
fallbacks, automatic legacy discovery/migration/merging, transcript-statistics backfill, compatibility
run dual-writes, periodic full exports and intermediate formats without a retained consumer, the
dashboard pipeline, review rankings, and adjusted-input productivity calculations. Obsolete fixtures,
tests, package scripts/dependencies, and docs for removed paths go with them. Keep the session-format
support needed to read existing transcripts and continue sessions that have not been closed; that is
not analytics compatibility or a new closed-session UI resume feature. Installer migrations
currently handle transcripts, reviews, closure actions, and run snapshots together
(`scripts/install/lib/outcomes.mjs`); split those categories before removing analytics migrations. Auth
and unrelated session compatibility are out of scope even though they are old.

Old analytics and review data, including current-device pre-cutoff data, remains untouched and unread
by ordinary collection/query paths; do not clear `data/`. Exception: private close/explicit forget must
still scrub the session's required legacy targets under the implementation contract §3. This is a narrow
deletion path, not schema compatibility for ingestion, backfill or analytics queries; after the new
privacy policy activates, toggling it on alone is not a legacy scrub request.
Specify that cleanup boundary before retiring old privacy helpers; if fulfilling it would require
retaining substantial legacy machinery, return that trade-off for explicit data-disposition alignment
rather than silently weakening privacy or rebuilding an old analytics reader.

**Settled evolution direction:** this fresh start is a one-time boundary, not a recurring reset policy.
The new store has a versioned schema and explicit migrations for actual schema changes, with one
recorder/store owner for migrations and derived-view upgrades. Preserve retained facts, detail and
pricing provenance; previously uncaptured fields remain unknown. The implementation contract owns
[new-store schema evolution](ANALYTICS_IMPLEMENTATION_CONTRACT.md#new-store-schema-evolution). No old-data import, transcript backfill, parallel compatibility readers or general
migration framework is required.

## 13. Preservation boundaries

Preserve existing session/transcript persistence, recovery, switching, closing and running-tab hide;
live activity, provider queues and host-owned projection; conserved accounting, explicit usage gaps,
immutable pricing provenance and cross-host concurrency protection.

**Approved exception:** new analytics uses the delete-on-close privacy policy in §1, replacing its
former private-session non-persistence, toggle-time scrub and active-private query exclusion. Existing
immediate private-close file cleanup and credential/caller-owned-file protections remain. Review
collection/evaluation and review-specific closure are retired. Change the corresponding normative
STATE_CONTRACT clauses and tests with implementation, not during this preparation session; current runtime
guarantees remain authoritative until then. Design rules carried from alignment:

- No history-sized scans, projections, or exports per ordinary runtime event.
- Capture each retained fact once; derive live and historical metrics from the same definitions rather than dual-writing competing aggregates.
- Expensive analysis must not prevent ordinary sessions from starting or running.
- Bound queue memory, hot caches, raw diagnostic log retention and UI payloads; overflow behavior distinguishes disposable raw diagnostics from durable accounting. Captured diagnostic analytics has no TTL.
- Unknown usage/timing is not zero; measured cost, estimated cost, and incomplete attribution stay distinguishable. Estimated pruning savings and authored-line activity remain labeled estimates/proxies.
- Record configuration identity when facts are produced, not from today's defaults at query time. Display sample counts, missingness, attribution limits, and uncertainty where relevant.

## 14. Workstreams

[Implementation contract §5](ANALYTICS_IMPLEMENTATION_CONTRACT.md#5-implementation-handoff-and-gates)
is the single task/owner/dependency/acceptance table; its §6 owns measured qualification gates. This plan's §11.6 owns the independent activation boundaries. Do not maintain a
second handoff table here or combine retirement, analytics activation, expiry and package-cache seams
into one release gate. Engine choice remains open; deferred outage policy does not block specification
or normal-path probes. Execution authorization and its limits are in §17; this preparation work
changes documentation rather than implementing or activating the rework.

## 15. Open questions

The core scope, CLI flexibility and analytics/session-file retention anchors are settled, including
sidecars and managed artifacts. Closing every existing session at cutoff removes the old-session
activation exception (§11.5). Remaining engineering work:

1. Database engine and process topology, decided by bounded representative evidence and integration/operational cost (§10); no permanent hybrid.
2. Physical DDL/index/compression tuning after engine selection; implement and test the proposed typed capture/lineage/payload contract, rather than reopening the product capture direction.
3. Validate indexed lifecycle backing and session-scoped cross-host mutation/revocation coordination; no database-wide lock held across transcript writes. Closed-app next-launch cleanup is settled; writer revocation and interrupted-cleanup recovery still require implementation tests.
4. Implement normalization, overlap and local-calendar parity fixtures, plus minimal branch/duplicate relationships required for accounting and privacy, in the implementation contract §2. No general branch-analysis subsystem.
5. Qualify the real nested-detail handoff, workload percentiles, resource ceilings, batching, queues and cross-host summary refresh under the implementation contract §6; partial experiments are not production acceptance.
6. Storage-failure policy — explicitly deferred by the user; not a planning gate.

## 16. Acceptance outcomes

Detailed fixtures and task gates are owned by the implementation contract. The plan is delivered when:

- Growing history, large detail and concurrent queries do not materially degrade Pie UI or agent responsiveness. Synchronous agent-path overhead remains single-digit milliseconds without persistence waits or history-sized work per ordinary event; longer background ingestion meets throughput, bounded-backlog and freshness needs. Real producer handoff and end-to-end impact are measured, not inferred from enqueue/SQL timing.
- Live and historical accounting conserve the same facts and definitions. Cross-window reporting may lag without becoming a competing accounting authority.
- Complete nested detail remains accessible through references without duplicate embedded transcripts; ordinary expiry preserves that evidence, and storage consumption is visible.
- Privacy uses the setting at explicit close. Open-session capture is normal; private close deletes the whole session's captured data without late-write resurrection. Ordinary retention and caller-owned-file boundaries remain intact.
- Session ownership remains operational, with safe cross-host mutation/expiry and no unrelated-session filesystem lock contention.
- Retirement, analytics activation and storage cutoff remain independently gated. At storage cutoff, existing closed session files expire in place while new session-owned writes use the final root, without copying or fallback discovery. Fresh installs and sparse datasets work, old analytics is never imported, and pre-cutoff sessions show only new-generation statistics.
- Versioned upgrades preserve the new store's retained data instead of resetting it; removed surfaces have no leftover command, dependency, installer or documentation consumers.

## 17. Overnight execution authorization and completion boundary

On 2026-09-09 the user authorized **full implementation and full live cutover**, not merely a staged
branch for morning review. Commit and push each coherent, verified major milestone to `origin/master`
(the repository's existing primary branch; the user's initial “main” wording was clarified). The
preparation session is separately authorized to commit and push all pending Pie source/configuration/
documentation changes. Preserve runtime data and credentials; “all changes” is not an instruction to
publish ignored data, generated bundles or machine-local caches.

The overnight agent may settle remaining **engineering** choices from the existing proposed defaults,
source evidence and qualification, including reproducible, version-pinned dependency seams. It must not
reopen settled product scope, invent a storage-outage/loss policy, weaken failed acceptance gates, or
replace full capture with sparse summaries. Resolve recoverable blockers, try supported alternatives,
and continue independent work rather than asking an unattended user or stopping at the first failure.
If safe activation remains impossible after recovery attempts, finish and push all safe work and report
the exact unmet gate honestly; approval is not evidence that a gate passed.

Long-lived scripts and a separate one-shot activation process are approved. Implement and rehearse the
terminal handoff early enough to expose self-hosting blockers before the final milestone. The overnight
Pie session cannot close itself or restart its owning host and then promise further tool calls. Transfer
final activation/report ownership to the tested process before that boundary, after committing and
pushing the implementation. It must use established lifecycle/ownership APIs, survive parent exit,
coordinate all affected hosts and trigger admission, preserve unsaved editor work, and verify the
actually loaded host/backend generation after controlled restart. Do not invent a permanent agent
supervisor, alter automatic-restart policy, or force-replace loaded bundles. Analytics activation and
storage cutoff remain distinct, ordered and independently recorded even when both occur in one night.

This authorizes the specified session closures, immediate private-close cleanup and scheduled ordinary
expiry, **not** blanket deletion of old analytics/review directories, unrelated files or caller-owned
artifacts. Before terminal closure, save the morning report outside session-owned storage so privacy or
expiry cannot erase it. Public Git reports contain sanitized engineering evidence only, never transcript
content, credential material or inventories of private sessions.

“Complete overnight” means the agreed implementation, qualification and both live activations, with
supported cache relocation delivered and post-activation evidence recorded. Ordinary cutoff files still
wait until their genuine `closedAt + 24h` deadlines; do not shorten retention, advance the system clock,
or keep an agent running solely to await them. Report those pending deadlines as expected delayed
cleanup, not completed physical single-root consolidation. Final physical consolidation is established
by the indexed cleanup owner at/after those deadlines (or next launch if Pie is closed), with a durable
status the user can inspect. Unimplemented scope, unqualified gates and activation failures remain
incomplete, distinct from this explicitly required delay. Execution mechanics and the launch prompt
are in the [overnight runbook](ANALYTICS_OVERNIGHT_RUNBOOK.md).
