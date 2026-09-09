# Analytics rework: implementation contract

Status: proposed engineering specification, 2026-09-09. Supplements
[the scope plan](ANALYTICS_REWORK_PLAN.md), not the current runtime STATE_CONTRACT.
The original planning authorization covered documentation and disposable synthetic experiments.
The user subsequently authorized full overnight implementation, milestone commits/pushes and gated live
cutover under [scope plan §17](ANALYTICS_REWORK_PLAN.md#17-overnight-execution-authorization-and-completion-boundary).
This preparation session does not implement or activate the rework. Bounded engine selection precedes
the production recorder; selected-design scale/resource qualification precedes activation, not an
exhaustive engine tournament before integration. The detailed storage-outage policy remains deferred.

Document ownership: the scope plan owns product policy, architecture choices and activation order.
This document owns field definitions, metric formulas, lifecycle/query mechanics, schema evolution,
implementation gates and numerical qualification budgets. Experiments record evidence, not new rules.
The aligned privacy policy is delete-on-close (§3), replacing analytics non-persistence/toggle-time
scrubbing only when implemented and activated with matching runtime contract changes and tests.

## 1. Typed capture and collection boundary

Use one shared versioned DTO contract and recorder API, not per-feature persistence adapters that
later merge their histories. The logical dictionary below is not finalized DDL. Use the same shape
for built-ins, extension and MCP tools; keep current producer identities rather than creating a
second lifecycle vocabulary. Native SDK session format remains unchanged; analytical identities and
captured content cannot depend on future transcript scans or temporary recall files.

**Settled execution boundary:** analytics must never make agents wait. Admission, provider/tool
execution, completion, cancellation and retry/failover must not await analytics acceptance, persistence,
commit/detail acknowledgements or queue drainage. Single-digit milliseconds applies to synchronous
source observation/handoff overhead, not eventual persistence. Background ingestion may take longer
while meeting throughput, bounded-backlog and display-freshness needs without materially degrading UI
or agent responsiveness as history grows. Perform serialization, hashing, compression and database
work outside the execution path. Operational transcript persistence and explicit close/delete barriers
remain operational responsibilities;
this rule removes analytics-specific execution barriers, not those close acknowledgements. Measure
agent-path overhead and end-to-end impact.

### Logical field dictionary (engine-neutral)

| Record | Identity / required links | Draft scalar fields and explicit detail links |
|---|---|---|
| Analytical session | Stable SDK header `sessionId`, analytics generation, workspace reference | First post-cutoff observation, transcript reference, observed lifecycle facts. Operational closure/expiry remains owned by §3, not this analytical projection |
| Execution | Existing host `operationId`, or child `childId + attemptId` within its parent tool scope; host/session scope and applicable parent execution/tool links | Operation kind, source, run/turn/request IDs where applicable, backend/worker generations, start/end, outcome/reason, acceptance/commit evidence; child runtime-session ID optional |
| Provider call | Stable producer `sourceId` mapped to one `invocationId`; execution/root session/branch and parent tool when applicable | Purpose, observed workspace/cwd, dispatched provider/model/thinking plus differing reported model when known, retry-group/attempt link, start/end and source `settledAtMs`, outcome; optional input/output/cache-read/cache-write/reasoning/provider-total token channels; reported USD cost, historical calculated USD cost, pricing snapshot, coverage/provenance, error-detail reference |
| Tool call | Scoped source `toolCallId`; execution, tool-definition reference, optional parent tool-call ID | Start/execution-end/outcome, transcript-terminal evidence separately, source entry/branch link, arguments/result references, optional resolved MCP target and coverage. Connection/discovery phases use spans, not fabricated tool calls |
| Tool facets | Tool-call link and typed facet identity | Commands/cwd, observed file paths, patch/input-derived line activity, verification classification with provenance. Exact command/patch/output bodies are detail references; shell text is not a count of underlying processes |
| Activity span | Stable source span ID; owner execution/session; optional invocation/tool link | Kind, start/end, measured duration, clock domain/resolution, observed vs scheduled/estimated coverage, parent span where meaningful |
| Component definition | Definition/version identity with content digest and source/owner | Kind (extension/skill/tool/server), name, package/build/content version, owning extension or MCP server, schema/definition detail reference. Tool and skill names alone are not unique identities |
| Configuration version | Identity of effective non-secret values at observation time | Harness/build/model settings and pricing references, definition references, content detail where useful; never auth material |
| Capability/context set | Stable set identity; members reference definitions/configurations | Set role (discovered/exposed), applicable execution/provider call; changed membership is a new set, unchanged sets are reused. No fresh full-catalog copy per event |
| Capability observation | Stable event ID, component/set and execution/context links | Explicit discovered/exposed/pruned/read/recovered/missing observation, reason, source route, measured/estimated size effect, detail reference; observed read is not proof of compliance |
| Feature observation | Typed source identity plus affected execution/tool/component | Validated fields for pruning/result-pruning/warm-bash/runtime-health; auxiliary provider calls link to the provider-call record rather than copying cost |
| Detail payload | Payload identity/digest; attributed references from facts or parent detail | Media/encoding, byte length, capture source, completeness and availability, content or linked structure. Deduplication shares content, not execution identities; scalar queries never implicitly load content |

### Types and common fields

- IDs are opaque UTF-8 strings. Scoped SDK/tool/child IDs are composite keys, never unqualified names.
  A root authority ID plus analytics generation fences an installation/cutoff; it is not a workspace.
- Every submitted observation carries `schemaVersion`, `generationId`, `producerKind`, stable
  `sourceKey`, `entityKind`, `entityKey`, `observationKind`, `observedAtMs`, applicable scope IDs,
  producer build/process identity, and typed fields. Recorder adds `commitSequence` and `committedAtMs`.
  Assign the idempotency key before delivery, scoped to kind, stable origin and analytics generation.
  Observation and commit times stay distinct. Process IDs/generations and recorder surrogate IDs are
  provenance, not replacement execution/idempotency keys.
- Reuse `SessionOperation.operationId` from `host/core/operation-types.ts`. Its acknowledgement
  `attempt` is not a provider retry or subagent failover. Keep run, SDK turn, request/message, child
  attempt and invocation IDs distinct; do not mint a competing analytics operation registry.
- Entity references: `sessionId`, `executionId`, `invocationId`, scoped `toolCallId`, `definitionId`,
  `configurationId`, `capabilitySetId`, `payloadId`. Null links require an attribution/coverage reason;
  host-scoped operations legitimately have no session. Later authoritative linkage is permitted,
  including pending creates; no fuzzy path joins invent session attribution. Unattributed calls
  still contribute to global known usage.
- Workspace scope is explicit: `workspaceId?`, `workspaceCoverage(known|unknown|not_applicable)` and
  `cwd?` on applicable executions/calls, inherited by their observations. `workspaceId` identifies a
  canonical workspace URI or sorted multi-root URI set through a definition record; a storage-shard
  hash is not the identity. The session's initial workspace does not override a later invocation's
  actual workspace. Sessionless public host work may be not-applicable; unknown scope stays visible.
  All workspaces share the canonical store, with explicit SQL filters, not implicit store isolation.
- Provider settlements carry `settledAtMs?`: the source billable record's `endedAt`, not recorder receipt
  or commit time. It is the canonical calendar timestamp. Keep an independently observed provider-end
  phase separate for latency. Missing settlement time puts known usage in an explicit undated bucket;
  a later authoritative timestamp link can move that contribution once without changing its amount.
- Every session-capable observation needs a trusted `captureSubject`, independent of nullable
  analytical attribution: the owning root session or its pending-create operation identity. Children,
  payload references and session-specific definitions retain that subject so close-time deletion can
  find the whole session. Missing subject is not public scope; reject it or hold it only in bounded
  volatile memory. Genuine host-only observations use explicit host-public scope. There is no
  per-toggle private/nonprivate capture grant or `privacyEpoch`: open sessions record normally.
  Ingestion checks the recorder's close-time deletion marker in its own write transaction (§3).
- UTC timestamps are signed 64-bit epoch milliseconds; counts/byte lengths are nonnegative 64-bit
  integers. Durations are finite nonnegative float64 milliseconds with clock domain and resolution.
  Reject nonfinite/negative usage. Do not pass large integers through implicit 32-bit driver binding.
  Transfer integers beyond JS safe range as decimal strings; query JSON uses decimal strings for int64.
- Cost/rates use finite float64 USD values, matching current source numeric authority; retain raw
  provider decimal text if supplied, and never round stored values for display. SQLite REAL / DuckDB
  DOUBLE are equivalent candidates. Apply rounding only to UI formatting. Aggregation uses stable
  summation; parity tolerance is `1e-9 USD + 1e-12 * abs(reference USD total)`, not exact bit equality
  between differently ordered SQL sums. This is usage accounting, not an invoice reconciliation system.
- Optional numeric fields are null when unavailable, with coverage and provenance. An empty set has
  zero occurrences; a nonempty set with no known values has an unknown total, not zero.

### Lifecycle observations and exactly-once projection

| Observation | Allowed change |
|---|---|
| Begin | Creates the entity's identity/known dispatch fields; absence of a begin must not discard an independently observed terminal fact |
| Phase/end | Adds measured boundary, outcome and coverage under a distinct source key; does not imply final provider usage or SDK persistence |
| Provider settlement | Attaches one immutable terminal usage/pricing settlement to the dispatched invocation; updates usage summaries exactly once |
| Transcript evidence | Attaches an authoritative `(sessionId, entryId)` to an execution/tool already observed; does not count another execution |
| Attribution link | Fills a previously unknown applicable link using source evidence, not path guesses; updates affected derived scope totals without creating another call |
| Detail completion | Publishes complete payload references after their bytes are durably available; does not settle usage again |

One transaction accepts new observations, applies the corresponding entity changes, and advances
necessary projections/watermarks. Keep source keys and canonical field comparison/digests with the
entity or its typed observations; no mandatory parallel copy of every DTO into a generic event ledger.
Exact redelivery is a no-op. Conflicting content under an existing source key is rejected visibly,
not hidden by unconditional `ON CONFLICT DO NOTHING`. Independent phases have independent keys.
A terminal arriving before a begin can create a partial entity; a later begin may fill missing fields,
never overwrite terminal usage. A terminal unknown-usage settlement is not a provisional zero awaiting
repricing; source settlement finality follows existing billable-invocation rules. Distinct attempts
remain distinct even when their payloads match; a gap belongs to its existing dispatched attempt,
never a second synthetic invocation.

`tool.executionEnded` records observed status/duration. Only a matching persisted SDK entry supplies
transcript-terminal evidence (`durableEntryId`). Analytics cannot promote an observed execution end
to a durability-confirmed UI terminal; see `backend/live-turn-accumulator.ts` and STATE_CONTRACT.

The public API provides a nonblocking handoff; any local delivery receipt is distinct from eventual
recorder acceptance and commit acknowledgement. Small facts and detail completeness have separate
acknowledgement/watermarks; these never gate agent execution, and a reference marked complete must
already resolve to bytes. No synchronous JSON serialization of historical state. Use time- and
size-bounded batches, with large payload transfer streamed separately. Tune batching against sustained
throughput, backlog, end-to-end freshness and resource use (§6), not an assumed single-digit-ms commit
deadline. Queue limits are in bytes as well as record count; establish final normal/burst capacities
from the next probe. Do not implement a silent-drop policy to meet them or wait for queue capacity on
an agent path. Outage/overflow policy remains deferred, with agent blocking excluded as a fallback. Bounded
memory, nonblocking producers and lossless capture through an arbitrarily long outage are not jointly
guaranteed by this contract; do not claim otherwise or select an unapproved loss policy.

### Child/attempt delivery and teardown

Inject the same typed `AnalyticsSink` into Pie's subagent execution context; forward it through
`extensions/subagent/src/{single,execute}.ts` and `runner.ts`. It is absent/no-op outside Pie, not a
reason to restore file loggers. The bridge uses the supported Pie recorder transport, independent of
throttled tool/UI progress callbacks and result compaction. Do not import a host storage implementation
into the reusable extension or invent child transcript files.

Emit `execution.begin`, provider dispatch/settlement observations, `tool.begin/end`, phase spans and
detail completion as observed, using the attempt/source IDs already fixed before delivery. Provider
attempt evidence comes from the actual provider-call boundary; SDK message-end is settlement evidence,
not proof that every retry was observed. Assign execution/attempt identity and submit the admission
observation without awaiting recorder acceptance or persistence before starting work. An observed
planned attempt is not counted as a dispatched call without dispatch evidence.
A supported provider instrumentation seam is required wherever current callbacks omit retries.

The recorder acknowledges a contiguous source sequence plus separate complete-detail watermark.
Normal completion/failover/cancellation finalizes observed boundaries and submits the attempt's sealed
source sequence without waiting for either watermark. Establish independent capture ownership of
available detail while it is observed, so child execution and failover can finish without destroying
pending capture or awaiting its storage. Defer only analytics-owned resource reclamation until drainage;
do not retain execution locks, provider capacity or agent completion solely for analytics. The exact
bounded transport/resource-ownership mechanism remains to prototype, not a claim that asynchronous
handoff alone preserves bytes. Failure attempts follow the same ownership rules as successful ones.
The parent terminal result references source IDs and only watermarks already known; its aggregate is
reconciliation, not another usage producer, and pending acknowledgement is not capture failure.

If a child disappears and leaves an unrecoverable capture gap rather than independently owned pending
delivery, mark that *existing* execution or known dispatched invocation `captureIncomplete`, recording
last acknowledged sequence and reason.
Retain known usage and mark missing settlement/detail unknown; never fabricate another invocation or
zero-charge completion. An admitted attempt with unknown dispatch remains dispatch-unknown. Facts
never observed/delivered cannot be recovered by claiming a full transcript capture. This specifies
normal teardown and explicit evidence gaps, not the deferred general outage/replay policy.

### Capture coverage and payload policy

| Source | Capture at observation time | Boundary / no claim |
|---|---|---|
| Provider calls | Dispatch/resolved model, purpose, attempt/retry group, configuration/exposure set, timestamps, independently present usage channels, pricing provenance, errors | Each real call once, including failure. Child aggregate delivery is not another call |
| Tool calls | Definition, arguments, execution outcome, result and error bodies as observed; commands/cwd and observed path/change facets | Shell text is not a process census; attempted patch lines are not verified final repository changes |
| Pruning and context treatment | Decision/rule version, before/after set or payload refs, measured/estimated size effect, recovery/read observations | One pruning decision can reference set changes; do not duplicate it as independently authored feature and capability facts |
| Harness | Effective non-secret configuration, definition content/version and actual exposure changes | No credentials or wholesale auth/environment dump. Unchanged definitions/sets are reused |
| Diagnostics | Existing operation/queue/provider/tool/retry spans; bounded event-loop/backlog/commit summaries using existing instrumentation | No per-frame tracing by default, no persistence of every UI rate tick, no inference of CPU time from wall duration |
| Managed output | Tool-returned text/image/binary content when actually observed; owned artifact reference otherwise | Do not silently archive every downloaded/caller-owned file's bytes just because a tool returned its path |

Default proposed detail coverage includes full arguments/results available at Pie's capture seam and
before/after Pie-owned result pruning, with the linked subagent representation below. Existing
sensitive-data/credential exclusions still apply; privacy mode uses close-time deletion (§3), not
capture suppression or immediate scrubbing when toggled on.
If an external adapter already truncated or spilled content before the seam, record that limitation;
full pre-guard capture requires its supported adapter change. Do not call inaccessible content retained.
No separate final-worktree diff collector or new system-wide profiler is required in the initial cut.

**Settled representation:** retain child content once. A parent subagent result stores references to
that captured child detail plus its distinct parent text, ordering and metadata, not another embedded
transcript copy. References address the observed immutable content/version, not a child's mutable
latest state. Explicit detail retrieval can reconstruct the complete nested view; byte-for-byte
wrapper serialization is not required. Retain every captured child transcript part, including message
text/reasoning, tool bodies, ordering and metadata; scalar call records alone cannot reconstruct it.
Preserve original leaf content and genuinely different before/after or failed-attempt evidence.
Distinct executions remain distinct even when content matches.
Implement this at the known subagent-result seam, not as a generic JSON-normalization framework.

Use payload metadata, content and attributed reference relations separately. Cross-session payload
deduplication is included: identical leaf content shares one stored body, while occurrences, provenance
and attributed ownership remain independent. Content digest covers exact leaf bytes plus encoding
semantics, not execution identity; whole-payload hashes alone cannot deduplicate embedded transcripts.
Use the existing recorder transactions for shared-content insertion, reference publication/removal
and last-owner deletion, so concurrent helpers cannot leave dangling references or delete content still
legitimately owned elsewhere. Keep encoding, logical/stored bytes, original-known size,
completeness, omission reason, capture stage and source version. A linked result is complete only when
its required content resolves; missing or scrubbed references are explicit, never reconstructed from a
newer child state or an expired transcript. Scalar queries do not expand this structure.

Start with one canonical database with separate content tables. The scope plan §9 owns the
monolithic-by-default decision and the evidence needed before reconsidering a hot-fact/detail split;
choose optional compression only after equivalent measurements. Chunked transfer is not a history
partition/archive policy. No TTL on captured content. Close-time deletion removes the session's
facts/references and content retained only by those references; independently captured references from
another retained session may keep shared bytes.
Inherited transcript aliases and parent wrappers cannot preserve a deleted source session's facts or
private-only content. Content deduplication does not merge ownership or defeat deletion.

### New-store schema evolution

The recorder/store module owns `databaseSchemaVersion` and explicit ordered migrations for this new
store. Producer DTO `schemaVersion`, captured configuration/normalization versions and the analytics
generation are separate concepts. A schema upgrade does not reset the generation or import retired
analytics. Keep one current schema/query contract rather than permanent parallel old-format readers.

Run migrations only for an actual version change, under one migration writer for the data authority,
outside interactive callbacks. They preserve captured facts, pricing provenance, content references
and deletion markers. New fields absent in earlier capture remain qualified/unknown; do not reconstruct
them from transcripts or today's defaults. Unsupported newer schemas produce a visible compatibility
error rather than a fallback store or destructive reset. Do not build a general migration framework.

The same module versions derived SQL views and persisted live projections. Their explicit upgrade or
maintenance rebuild may scan retained facts; ordinary startup/refresh still cannot replay history.
Keep lifecycle metadata under its operational owner, outside analytical rebuilds. Required migration
fixtures preserve known totals, linked detail, missingness and deleted-subject rejection across an
upgrade; fresh installs create only the current schema.

## 2. Attribution, formulas and parity fixtures

### Metric dictionary and source authority

| Metric | Definition and required qualification |
|---|---|
| Usage channel `k` | Sum known `k` values over distinct invocations selected by scope, with known/unknown invocation counts. If all values are absent the value is unknown; an empty scope has zero occurrences. Never present a partial sum as a complete total |
| Effective cost per invocation | Reported cost when present (including explicit zero), otherwise complete captured calculated cost, otherwise unknown. Global/session totals sum distinct selected calls with coverage counts; preserve reported/calculated provenance |
| Daily/weekly cost and tokens | Preserve current UI scope: today starts at local midnight; week is today plus the preceding six local calendar dates, not a rolling 168 hours. Attribute calls at source settlement time, not receipt. Store UTC timestamps and key derived day buckets by explicit timezone/provider/model/purpose/scope; calendar boundaries are DST-safe. A timezone change refreshes the small live-window projection off the host path, not all historical facts. Other timezone/rolling-window queries are explicitly named |
| Session busy wall time | Union of the session owner's busy intervals and explicitly uncovered preflight spans; active intervals extend only to the current observation point. Tool, child and auxiliary spans inside that envelope are explanations, not additional parent busy time |
| Aggregate working time | Sum of per-session busy wall time (session-work), preserving the current meaning; concurrent sessions can exceed elapsed clock time. A machine-wide elapsed union, if queried, is a separately named metric |
| Tool/child work | Additive measured durations of selected tool/child attempts. Parallel work can exceed wall time; never sum parent wrappers and descendants into the same elapsed-time metric |
| Live generation rate | Preserve the bounded, explicitly estimated live rate for reply/reasoning/tool-argument/child output during generation. Existing `shared/token-rate.ts` and `host/token-rate-service.ts` own the window/stall rules; do not replace it with a supposedly exact token count or persist every display tick |
| Settled throughput | Known output tokens divided by the matching measured generation duration, or by full assistant duration for explicitly named end-to-end throughput. Unknown/estimated numerator or missing/zero duration remains qualified/unavailable; do not average per-call rates without duration weighting |
| Latency | Keep request-to-first-output, provider header/first-output wait and full operation duration as distinct intervals; report scope/coverage. A tool result timestamp or receipt delay is not automatically model latency |
| Context utilization | Most recent applicable provider context observation / selected model context limit. Before provider evidence, retain the separate initial estimate. This is state at a point in time, not a sum of historical input tokens |

Provider metering, generation estimates and context estimates have different authorities; estimates
must never be added on top of a settled provider usage row. Preserve current branch selection and
rate/window behavior through parity fixtures. Source authority: `shared/billable-invocation.ts`,
`shared/session-usage.ts`, `shared/activity-interval.ts` under `extension/src/`; current local-calendar
behavior is in `host/billable-invocation-ledger/aggregate.ts` and `host/stats-service/aggregate-stats.ts`.

### Usage and pricing

Keep raw input/output/cache-read/cache-write/reasoning/provider-total channels independently optional.
A versioned provider normalization declares which channels are disjoint or subsets. For example, if
raw input includes cache-read and cache-write, billable base input is their difference only when all
required values and that convention are known. Reject an impossible negative normalized channel;
never repair it with a clamp. A provider-defined omitted-as-zero convention is permitted only with
explicit normalization provenance; missing telemetry is not such a convention.

Normalized total is the sum of disjoint known channels only when coverage is complete. Otherwise expose
known partial sums and missingness, or the independently reported provider total. Do not add reasoning
to output when it is already included. Calculated cost is the sum of disjoint billable channels times
the captured channel rates, with explicit rate units. Only a complete calculation can provide fallback
effective cost. Effective cost is reported USD (including zero), else complete historical calculated
USD, else unknown. Keep partial price estimates separate, not mislabeled as complete charges.

Global usage selects distinct invocation IDs. Execution-inclusive usage selects the transitive
execution/tool descendants then distinct invocation IDs. Default root-session all-work groups by the
call's owning root; unattributed calls remain in global totals with an attribution gap. Joins to
multiple facets/capability members must not multiply measures: select distinct calls before aggregation.

### Branches and duplicate sessions: accounting only

**Settled scope:** retain only the branch/copy relationships needed for correct usage/cost attribution,
existing live accounting scope and privacy scrubbing. Do not build a general branch-analysis subsystem,
branch reports or new inherited-subtotal UI. This does not reduce execution/child capture.

- Capture the SDK entry-parent edges, invocation/entry links, selection changes and execution anchors
  necessary for those accounting relationships as they occur. Pre-cutoff entry IDs may be structural reference stubs;
  do not reconstruct their usage/content or import old branch statistics.
- A selected-branch view follows captured ancestry, including a current pending execution anchored to
  that branch. A failed/retried attempt follows its triggering execution/branch even if it has no
  assistant entry. Compaction does not itself discard incurred work.
- An edit/fork/truncate changes membership of the displayed branch, not ownership/existence of facts.
  Capture the source selection change; do not infer deletion from the loaded webview window.
- Duplicating a session creates a new session identity and the minimal source/invocation associations
  needed to avoid copying provider-call rows or counting inherited spend again. Its own-work subtotal
  starts at zero. Any existing selected-session scope that includes inherited spend is nonadditive
  across copies; global and owning-root totals count the original calls only once. The fixtures below
  verify those amounts, not a requirement to add new UI subtotals.
- Keep only entry/branch metadata needed for accounting and privacy after JSONL expiry. Ordinary updates
  are incremental. A branch switch can compute ancestry/deltas in the helper; UI refresh must not
  rescan history. Remove inherited links to scrubbed source facts rather than retaining private facts
  through a duplicate's reference.

### Time and live projections

Prefer durations measured on the producer's monotonic clock with a UTC correlation anchor. Preserve
clock domain/resolution and wall-time-only coverage; clock jumps are not precise elapsed time.
Use half-open intervals `[start,end)`. Busy time is the measure of the union of the owner's busy and
explicitly uncovered preflight intervals in a common clock domain, not the sum of nested spans. Active
intervals end at the current observation point for display only. Do not persist every tick. Unknown
cross-process clock alignment makes overlap coverage partial; measured individual durations remain
usable but do not imply an exact cross-clock union.

Per-session busy totals can be summed as session-work even across concurrent sessions; label a
machine-wide union separately. Tool/child attempt-seconds are additive at the requested level
(outer calls, remote calls, or child attempts), not CPU time or parent wall time. Settled throughput is
`sum(known output for matched calls) / sum(matching measured generation seconds)`; use only matched
pairs and report excluded coverage. Live estimated rate and context-window observations retain their
current bounded source algorithms. Neither is added to settled usage.

Daily buckets use the invocation's `settledAtMs` and explicit IANA timezone. Today and the previous six local
dates form the current week; they are not necessarily 168 hours around DST. Projections retain known
sums, missing counts and settlement counts per scope/provider/model/purpose/timezone. Apply only newly
accepted settlements, explicit link corrections and close-time deletions. Late arrivals update the
source bucket unless the capture subject was deleted. A timezone change refreshes the recent live
window, not all history; historical SQL uses explicit boundaries.

### Cross-host summary refresh

Live statistics may lag across Pie windows. Advance a small shared projection revision in the same
database transaction as changes to stored live summaries, including deletion and attribution changes.
After a local commit, notify that host promptly. Other hosts check the revision in their helper at a
bounded interval and read only their relevant small summary rows when it changes, with revision and
rows from one consistent snapshot. Start with roughly one second for cross-host refresh; this is a
tuning target, not a requirement for synchronized displays. Resume/reattach fetches current summaries.
No event-history polling, historical recalculation, or new replay/change-log subsystem is required.

Count revision checks and all helper processes in idle/resource measurements. Queries read committed
database state directly, not a possibly stale UI cache. Clear the closing host's deleted-session
projection; peers refresh through the same revision mechanism. Do not add a shared broker solely for
instant notifications; the selected engine's ownership needs still decide topology.

### Required parity fixtures

Small deterministic fixtures before DDL/capture integration:

| Fixture | Expected result |
|---|---|
| Call A: output 100, cost .01; retry B: missing output/cost; success C: output 200, cost .02; redeliver C | Three calls, known output 300/cost .03, one unknown for each measure; redelivery changes nothing |
| Parent .01, failed child .02, failover child .03, nested child .04, parent receives inclusive child result | Global and parent-inclusive .10, parent-direct .01; no added aggregate charge |
| Branch prefix A=.01, fork tips B=.02 and C=.03 | Branch views .03/.04; root all-work .06; truncating either tip never reduces all-work |
| Copy A+B into another session, then new D=.04 | Source all-work .03; copy own-work .04, inherited .03; global .07, not .10 |
| Busy [0,10), preflight [-2,2), nested tool [3,8) seconds | Busy union 12 seconds, tool work 5, not 17 |
| Raw input 100 includes cache read 40 and cache write 10; output 20 includes reasoning 5 | Base input 50, total disjoint tokens 120, not 175; pricing uses captured channel rates |
| Reported cost zero but a positive calculated price; late delivery across midnight/DST | Effective cost zero; original source-local day used; receipt day never substitutes |
| Session already open at analytics activation continues, closes with privacy off, then expires | Stable root identity; only post-activation work contributes; expiry changes transcript availability, not captured totals; no UI reopening after close |
| Privacy on while open; close with it on | Capture remains available during the session; close removes all its analytics/detail and derived contributions, including pre-toggle activity and children |
| Privacy on, then off before close; restart before closing | Latest persisted setting at close wins; off retains analytics under ordinary expiry; enabling once is not sticky |
| Another host commits a settlement, correction or private close while this host makes no writes | Relevant cached summaries refresh through the shared revision without scanning history |

These are specification fixtures, not tests already implemented. The generic mock database does not
prove semantic retry/branch/unknown-usage correctness.

## 3. Durable lifecycle and expiry

### Owner and backing

The reducer's existing close operation owns close mode and acknowledgement barrier. Add one named
`closure-persisted` acknowledgement for ordinary idle closure, delivered from the operational store
through the existing effect/controller. `running-hide` adds no timestamp. A close with privacy enabled
uses the delete-on-close path below, not ordinary expiry. Closed sessions have no Pie UI reopen/resume
workflow; the 24-hour window retains evidence pending deletion, not a resumable tab. Preserve switching
and restart restoration for sessions not explicitly closed. Do not resurrect the review outbox.

Prefer a distinct indexed SQLite operational store under `state/session-lifecycle.sqlite` for the
first ownership prototype, independent of analytics engine selection. It provides indexed durable
lifecycle records and short metadata transactions without sharing the analytics write path. It does
not supply a database-wide lock around transcript filesystem writes; those use the session-scoped
coordination boundary below. This is operational storage, not an analytical SQLite/DuckDB hybrid or a
second usage ledger. Colocation remains an alternative only if the same fencing and latency properties
are demonstrated; the disposable catalogue file is never the sole lifecycle authority.

Proposed row: `sessionId`, `transcriptRelativePath?`, `closedAtMs?`, `expiresAtMs?`, `firstCloseOperationId?`,
`writeEpoch`, `cleanupState(retained|deleting|deleted)`, `cleanupOperationId?`, `deletedAtMs?`.
New-root sessions use `transcriptRelativePath`. Closed cutoff sessions instead have their exact unchanged
transcript path recorded as a cutoff-owned file target in the registry below; do not manufacture a new
relative destination. The same deadline index and cleanup owner handle both locations. Only minimal
closure/fencing metadata survives completed deletion, not session content or retained analytical facts.
Owned file records use session ID, feature, location and ownership evidence. Index pending deadlines by
`(expiresAtMs,sessionId)` and exclude completed cleanup; primary-key lookups never enumerate history.

First ordinary close commits its timestamp/deadline once; the close barrier succeeds only after the
durable acknowledgement. Retried or duplicate close requests return the same values, never reset the
deadline. Keep first-close correlation on the row and use the existing operation registry for current
acknowledgements, not an unbounded second close-operation log.
At the approved cutoff, all retained existing sessions receive the cutoff closure timestamp through
the normal metadata fields and expire in place under the scope plan §11.6. No no-timestamp legacy
policy branch or transcript relocation.

### Privacy: delete on close

The operational session owner persists the reversible privacy setting and freezes its current value
when resolving the close operation. Retries use that same decision; no sticky ever-private flag.
Windows closing the same session must consult that owner, not independently decide from stale UI
markers. Enabling privacy does not stop capture, scrub existing analytics, or hide live facts from the
local query interface. Capture throughout the open session follows the same accounting/detail path.

When privacy is enabled at explicit close, delete the entire session's analytics and detail, including
pre-toggle activity, nested/failed child attempts, linked definitions unique to the session and derived
contributions. Preserve the existing immediate transcript/owned-sidecar/artifact cleanup rather than
waiting 24 hours. Turning privacy off before close selects ordinary retention instead. App shutdown is
not explicit session close; the persisted setting survives restart. At analytics activation, update the
composer toolbar's tooltip and accessible on/off labels to the scope plan §1 wording; neither may claim
analytics is disabled or never persisted. This is a copy clarification, not a privacy-control redesign.

Use the existing close/forget barrier, not a general cross-database transaction framework:

1. The operational owner records the idempotent delete intent, stops/revokes session writers through
   existing ownership, and requests analytics deletion for the root/pending-create capture subjects.
2. The recorder writes a minimal deleted-subject marker and scrubs attributed facts, derived
   contributions and payload references/content in its own analytics transaction. All fact/link/detail
   write transactions check that marker inside the same transaction boundary. A write that wins first
   is scrubbed; a write that follows is rejected. This covers other helpers and delayed child payloads
   without a check in a separate operational database followed by an unprotected analytics insert.
3. Discard pending capture for the deleted subject and invalidate projections through §2. Finish the
   owned-file and required legacy scrub paths. Acknowledge close only after required deletion succeeds;
   retain an idempotent pending cleanup on failure rather than reporting success. Minimal deletion
   markers prevent replay from recreating data; they are not an analytical history of private work.

Ordinary agent execution never waits for this recorder acknowledgement. The explicit private close is
an operational deletion barrier, not an analytics admission/completion gate on every agent attempt.
This is close-time coordination only: no per-toggle capture fencing or new local-user isolation system.
Credential exclusions and caller-owned file boundaries remain unchanged.

Required fixtures: on/off toggles plus restart; capture and query while on; whole-session deletion;
close racing both a small fact and late linked detail from another helper; retry after an interrupted
close; no stale producer resurrection. Deduplication fixtures cover concurrent capture of identical
payloads by different sessions, distinct bytes/encodings staying distinct, one owner's private close
preserving another's independent evidence, and last-owner deletion racing a new legitimate reference.
Private-only content must be removed when its last legitimate reference is deleted. The close-time
analytics boundary must work before analytics activation, independently of the later storage cutoff
and expiry.

### Cross-host mutation barrier

A metadata epoch checked *before* an unprotected filesystem write is insufficient: revocation can win
between the check and append. **Design direction:** use a cross-host critical section scoped to the
session identity for SDK mutation and expiry/transfer/privacy revocation. Do not hold a database-wide
SQLite write transaction across filesystem mutations; a slow transcript write in session A must not
hold a shared transcript-write lock needed by unrelated session B. Short indexed metadata transactions
remain separate. Do not put SQLite on the Electron host event loop.

Prototype the exact session-scoped primitive, ownership and crash recovery before adoption; no specific
OS lock/lease implementation is selected here. All same-session mutation and revocation paths must
participate, with a documented lock order and no check/write gap. Test concurrent hosts on the same
session, slow writes across unrelated sessions, process exit during mutation, and revocation racing
append/rewrite. Timeout alone never proves ownership release. This is operational safety coordination,
not an analytics persistence acknowledgement; analytics must not enter its execution critical path.

The lease includes authority/session/epoch plus the current local SDK lease. Check both the epoch and
`now < expiresAtMs` inside the session-scoped boundary, then perform the append/rewrite/header write
before releasing it. Extend the existing SDK patch to cover the whole mutation, not just
`_assertPieWriteLease`. Include prepared creation/fork/rewrite/settings seams; protect cold mutations
and sidecar writers with the same lifecycle rule. Current process-local leases alone cannot do this.

Long asynchronous managed-artifact jobs register their owner before admission and retain completion/
stop tracking; do not hold a database write transaction over a download or provider call. Revocation
blocks new jobs, requests cancellation of registered work, and waits for completed stop/release or
verified process exit before deletion. A timeout by itself never proves a live writer is gone. Caller
processes writing arbitrary paths and standalone Pi CLI are not made safe by a cooperative Pie lease;
cutover must establish that all Pie-managed writers use the new boundary.

### Deadline and scheduling

**User settled:** if Pie is closed at the deadline, physical cleanup runs on its next launch. No OS
scheduled task, daemon installation or wake-from-sleep requirement. The deadline itself remains fixed.

- While a host is active, schedule one next-deadline wakeup using the indexed due range. Rearm after
  closure and on a bounded cross-host deadline check (proposed maximum interval 60 seconds). Check due
  work on startup/system-resume and before transcript open, trigger dispatch or mutation admission.
  These are indexed point/range queries, never a directory/history sweep. Timer delivery may lag; admission
  checks enforce the deadline independently. The timer lateness is observable, not a changed deadline.
- On `now >= expiresAtMs`, refuse transcript opens/new mutations. Mark deleting/revoke epoch atomically,
  stop any remaining or stale cross-host writers, drain protected writes and registered artifact jobs,
  then delete through existing ownership/cache invalidation boundaries. These checks protect cleanup
  races; they do not introduce a closed-session UI resume workflow. Do not postpone until an arbitrarily
  later idle or reset the deadline.
- Physical deletion follows safe writer drainage and OS availability; it cannot be instantaneous while
  the machine is off or a file handle is held. If a writer cannot be stopped/proven gone, keep the
  session logically expired and report blocked cleanup, not success or an invisible retention extension.
- Multiple hosts claim due work transactionally. A deleting row is resumable/idempotent cleanup state,
  not permission for competing sweepers to delete blindly. Revalidate session identity/path ownership;
  missing owned files are already absent, reused/mismatched paths are not deletable targets.
- Finish with a minimal deleted tombstone so stale producers cannot recreate that identity/path. Expiry
  revokes transcript/artifact write authority, not analytical capture: late usage settlement and
  already-observed detail drainage still persist unless an explicit private close deleted their
  capture subject. Rebuild the catalogue independently. Ordinary expiry preserves payloads; query/open
  checks expose expired transcript links even before physical cleanup completes.
- Trigger dispatch respects expiry before acquiring session write authority. Retention never directly
  unlinks the shared trigger journal/claim files; session-target cancellation/delivery outcomes remain
  owned by the existing trigger store. Private forget continues its stronger scrub transaction/barrier.

Implementation seams: `host/core/reducer/{command-session-handlers,misc-handlers}.ts`,
`host/core/session-operation-effect-controller.ts`, `host/session-service/service.ts`,
`backend/{session-ownership-authority,cold-session-store,sdk-session-ownership-patch}.ts`, session
sidecar/artifact resolvers, and `host/deferred-triggers/store.ts`. Full cross-host admission/append race,
remaining-writer cancellation at expiry and interrupted-cleanup tests are required; mocks have not
proven them. Reconcile the stale session-history-menu claim identified in the scope plan §11.5 with
focused UI/contract tests; no new closed-session reopen control is required.

### Artifact registry and legacy scrub boundary

Use the operational store's `ownedArtifacts(sessionId, feature, artifactId, location, ownerKind,
ownerEvidence, availability)` relation. Locations distinguish managed-root-relative paths, fixed
cutoff-only absolute paths and external references. `ownerKind` distinguishes managed file, managed
session setting and external reference; external references are never sweep targets. Register ownership
at the resolver before publishing a new managed path; async jobs also register their active owner as
above. Session-only MCP overrides and prompt toggles participate, including removal of a session's entry
from an aggregate settings file rather than deleting the whole file. Registry rows do not copy
analytical payload bytes.

At the approved cutoff, record existing transcript and session-owned artifact/setting targets in this
same registry, with their unchanged canonical paths, header IDs and ownership evidence. Resolve old
computer-use and Playwright paths through their exact resolvers, including path hashes. These fixed
records support expiry/private cleanup, not ordinary runtime discovery or a second root resolver.
No files are copied or rekeyed; no destination mapping or separate cleanup-manifest service is needed.
Revalidate identity/ownership before deletion; unresolved targets remain visible and unswept. Preserve
only independently required legacy privacy aliases after file cleanup, not a browsable legacy catalogue.

Extend `backend/private-session-artifacts.ts` before retirement: current cleanup covers reviews,
prompt toggles and JSONL, not complete MCP/browser artifacts. Its replacement coordinates the registry,
MCP override removal, prompt-toggle entry removal and managed feature artifacts under the existing
privacy barrier; fallible attributed cleanup completes before reporting transcript/forget success.
Ordinary expiry uses the same owned target selection but does not scrub analytical facts/payloads.

Retain one explicitly invoked legacy privacy-scrub boundary, separate from recorder/query startup:
use existing session-specific deletion logic from stats storage/accounting, ledger/activity storage,
run-analytics storage and review sidecars, with the recorded old session IDs/path aliases and only the
explicitly configured legacy roots. Extract required identity helpers before deleting reviewer code.
Preserve dependencies needed for deletion, not a normal legacy ingestion/export service. No directory
search for additional historical roots, old-format query API, import or new reconstruction path.
Serialized old records may need reading to remove their attributed subset during explicit privacy
scrub; that exceptional deletion path is not ordinary analytics collection.

Legacy analytics/review files otherwise stay untouched. This small compatibility boundary can be
removed only after separately approved legacy-data disposition. Missing/ambiguous target ownership or
failed scrub remains a visible incomplete privacy operation with its fence retained; it must not
silently succeed. Required fixtures cover MCP settings, aggregate toggles, both browser resolvers,
shared payload references, unchanged cutoff paths and unrelated/caller-owned files. Cutoff fixtures
verify ordinary files remain unchanged until their deadline, private files delete immediately, new
session-owned writes use only the final root, and interrupted cleanup resumes from fixed indexed targets
without root searching. All fixtures retain writer fencing and path-reuse checks.

## 4. Query and integration contract

CLI logical commands: `schema`, `query`, `detail`, `storage`. Publish the resolved schema, relationships,
normalization/metric versions, capture coverage and example SELECTs in one agent skill. Include a small
canonical usage/cost SQL-view layer encoding distinct invocations, coverage and effective cost, with
explicit owning-session versus selected-session scope. Test it against the same accounting fixtures as
live projections. Raw read-only SQL remains available; views are derived semantics, not a report catalog
or another persisted authority. Resolve only the canonical root (`PIE_DATA_DIR` override), never search
legacy roots or reconstruct transcripts.

- `query`: read-only analytical SELECT/CTE/EXPLAIN, enforced by native engine access controls, not merely
  a first-word regex. Disable mutation/attachment/extension loading and unrelated external-file access.
  Default output 200 rows/256 KiB, explicit row/cell/byte truncation, default timeout 10 seconds and
  caller-selected longer timeout within configured query resource limits. Result limits do not bound
  execution: cancellation and memory/concurrency controls remain separate. No silent full-result export.
- Return schema/generation, scope description when a helper selects scope, timezone where relevant,
  snapshot watermark, pending-detail coverage and truncation metadata. Arbitrary SQL must state its
  own filters; the CLI must not silently rewrite it into a selected-session scope. Privacy-enabled
  open sessions use the normal local query path; completed private closes remove their data.
- `detail`: explicit payload ID plus byte range, default 64 KiB. Return total length, encoding,
  completeness, omitted/unavailable reasons and next offset. Binary bytes use a declared encoding;
  do not stringify a driver-specific BLOB wrapper. Transcript availability and captured payload
  availability are separate. Linked subagent detail is explicitly reconstructed under the same
  output/cancellation bounds; declare that representation rather than claiming original wrapper bytes.
  Missing/scrubbed references stay unavailable. An expired transcript link never falls back to another
  file at its path.
- `storage`: category logical/stored bytes and shared-content accounting; report unknown engine
  allocation overhead honestly rather than attributing the same deduplicated bytes to every session.
- Cancellation stops the query's work without terminating ingestion or the owning recorder. SQLite
  independent readers are a candidate; DuckDB queries need connections within its write-owning process.
  No long analytical scan on the recorder's single synchronous event loop.

Capture integrations use host/provider settlement sources and subagent observation delivery before
in-memory teardown. Child terminal tool results remain a reconciliation source, not the only retained
source for failed-attempt detail. Prompt-toggle storage is rehomed before reviewer removal. MCP and
web-access cache relocation/pre-guard capture require supported pinned-package seams; installed package
edits are not an implementation strategy. Artifact ownership is registered by resolvers, not inferred
later from arbitrary paths. Copilot's configuration lock remains scoped to its configuration target.

## 5. Implementation handoff and gates

Proposed new-file ownership below is an assignment boundary. Execution authorization is in scope plan
§17; the overnight runbook owns delegation, not a duplicate acceptance table. Confirm naming and exact
file ownership before parallel implementation.

| Task | New-file / existing owner boundary | Dependency and acceptance |
|---|---|---|
| P0 bounded engine selection | Isolated thin capture-to-query prototype with disposable temp data; decision in experiment note | First exercise the real nested-child/large-detail handoff and teardown (§6), then SQLite capture/projection/query/restart and multi-host paths. Focused native DuckDB evidence only for decision-relevant gaps. Weight agent isolation, packaging/ownership/maintenance and latency. Stop comparison once justified; qualify selected design before activation |
| P1 shared types + fixtures | Proposed `shared/analytics/{contracts,metrics}.ts`; mirror focused tests | Engine-neutral phase/identity/normalization fixtures; minimal branch/copy accounting and privacy only; reject conflicting source keys |
| P2a root resolver | Proposed `shared/pie-data-root.ts`; existing forwarding/resolver files | Final root contract, deterministic category ownership; no legacy analytics fallback/search. Independent of engine/expiry and external package-cache seams |
| P2b operational lifecycle + expire-in-place cutoff | Proposed `extension/src/backend/session-lifecycle-store.ts`; existing session/ownership/effect/artifact files | P2a; first deliver the durable privacy/close owner and legacy scrub boundary needed by P3/P7a without activating expiry or switching transcript roots. Then complete fixed cutoff targets, session-scoped mutation/revocation and cross-host races, including slow unrelated-session writes. New writes switch only at P7b; cutoff files expire in place without copying/remapping. No catalogue deletion loses deadlines; no expiry touches caller files |
| P2c supported cache relocation | Existing resolvers and reproducible pinned-package seams | P2a plus each package's supported seam; investigate package compatibility early, using actual installed/locked versions rather than possibly stale docs. Prefer a supported release/configuration API; otherwise use a minimal checked-in version/fingerprint-checked patch with install/reinstall tests, following existing patch conventions. No manual installed-file edit, broad SDK upgrade merely for convenience or unapproved external-repository push. Independent delivery, one explicit owner/location per category; required for final single-root completion, not P7a/P7b |
| P3 recorder | Proposed `extension/src/analytics/{recorder,store,projections,entry}.ts`; store owns schema migrations and projection versions | P0/P1/P2a and close-time deletion owner fixed; not P2b expiry or P2c cache relocation. One selected engine; bounded asynchronous capture, atomic deletion markers, persisted projections/revision, versioned upgrades, no event-sized history scans |
| P4 producers + live consumers | Existing billable/stats/subagent/pruner/tool producers and host/webview owners | P1/P3; real nested-detail ownership across teardown; delayed acknowledgements/saturated queues never gate execution/completion/failover; measure agent impact and referenced-detail reconstruction; selected-branch/local-calendar parity, cross-host summary refresh, no duplicate child charges or legacy sinks |
| P5 agent query | Proposed `extension/src/analytics/query-entry.ts`, `skills/query-analytics/SKILL.md` | P3/schema; canonical usage/cost views plus raw read-only SQL, bounded output, cancelable scans, safe integer/BLOB encoding, retained detail usable after JSONL expiry |
| P6 retirement | Existing review/dashboard groups from scope plan | Extract shared identity/prompt-setting/working-time/queue/privacy consumers first. Remove obsolete code/tests/dependencies/commands without blanket deleting old analytics |
| P7a analytics activation | Recorder/capture/live/query owners; old analytics writer shutdown | P1/P2a/P3–P5 plus selected-design qualification and delete-on-close readiness. Switch analytics privacy semantics with this authority, preserving existing behavior until then. Quiet activation, no import/dual-write; no dependency on full P2b expiry/P2c/P6. Authorized for overnight execution under scope plan §17 |
| P7b storage cutoff + expiry activation | Installer/doctor and session/trigger/privacy/artifact owners | P2b validated and P7a retaining required detail; close all then-existing sessions and switch new session-owned writes to the final root under writer fencing (§11.6 of plan). Ordinary cutoff files expire in place after 24h; private close deletes immediately. Preserve the analytics generation. No dependency on unrelated package-cache seams or retirement. Authorized under scope plan §17; terminal handoff rehearsal and post-restart evidence are required |

Production STATE_CONTRACT changes land with corresponding tests, not with this planning document.
P1/P2 design prototypes and P6 retirement can proceed independently of P0. Do not combine P6/P7a/P7b
and package-cache relocation into one release gate. Analytics activation precedes destructive transcript
expiry; final single-root completion still requires P2c and cutoff-file cleanup. After storage cutoff,
new session-owned writes use the final root; old closed files remain only as fixed operational cleanup
targets until deletion, never fallback/search roots or analytics dual-writes. Final engine/process
ownership, measured batch/queue limits and physical DDL remain measurement-dependent.
No additional product questionnaire is needed for the settled scope; the deferred outage policy is
not silently resolved by these normal-path contracts.

**Scheduling clarification:** P1 fixtures/P2a and independent P6 removals can start immediately. P0's
real-producer seam and P2b's session-scoped ownership prototype are early high-risk work, not late
integration chores. P3 needs the early P2b privacy/close ownership contract, not finished expiry. Check
P2c package seams and prototype the P7 terminal activation handoff early, but activate only at their
own gates. Small local scripts may own the finite cutover and report, not another operational lifecycle
store or permanent agent supervisor. Rehearsal must prove parent-process loss, generation selection,
closed-session non-resumption, interrupted idempotent activation, and all-host old-writer fencing. The
post-restart smoke exercises real new-root session creation, capture/live/query parity and private
close; disposable clock-controlled fixtures prove 24-hour expiry without changing the real deadline.

**Recovery after activation:** distinguish code rollback from data rollback. Before irreversible
activation, leave the old authority unchanged if a gate fails. After an analytics generation switch or
storage closure, prefer an in-scope forward repair; never restore stale analytics, resurrect deleted
private data or reopen cutoff sessions to make an old build start. Recovery must retain committed
lifecycle/deletion facts and the selected authority, and report failure until verified.

## 6. Performance qualification and budgets

The scope plan §10 owns bounded engine selection and the decision to qualify the selected design,
not an exhaustive comparison framework. This section owns the engineering workload and numerical
gates; experiments record measurements against them.

### First prototype: real capture boundary

Before further engine tuning, exercise the actual parent/nested-child producer seam with large tool
results, referenced child content and distinct parent metadata. Trace observation, handoff, independent
payload ownership, commit and explicit reconstruction through successful completion, cancellation and
failover. Delay recorder acknowledgements deliberately: agent completion and execution resources must
be released without destroying retained capture or waiting for storage. Measure producer-thread
serialization/copying and retained bytes, not just helper SQL time. An asynchronous API label is not
proof that work moved off the producer. Use this existing thin prototype, not another framework; if it
fails, fix representation/transport rather than reduce capture or weaken the no-wait requirement.

### Selected-design workload envelope

This is a risk-based qualification menu, not a mandatory Cartesian product before engine selection.
Choose and record representative conditions and required scale before running; extend only where a
specific scaling or contention risk warrants it. Large rich-payload histories, correctness, no-wait
behavior and resource bounds remain requirements, not optional shortcuts.

| Dimension | Proposed probe envelope |
|---|---|
| History | 10k, 1M, then 10M primary fact rows; report actual rows per table and physical bytes, not just invocation count. Generate incrementally without holding the history in RAM |
| Mix | Provider/tool/span/capability observations with 12 model/provider combinations, multiple workspaces, configuration changes, failed attempts, two levels of child delegation and parallel MCP tools. Include missing channels/costs, duplicates and deliberate identity conflicts as separately labeled correctness cases |
| Detail | 10% of primary rows link to payloads; deterministic mixture: 95% 2 KiB, 4.9% 32 KiB, 0.1% 2 MiB. Include repeated and unique content with stated entropy; report logical/stored bytes. Add large unique bursts and nested subagent wrappers over shared child bodies; verify complete reconstruction without repeated embedded copies |
| Load | 1 fact/s light traffic; 50 fact/s sustained; 1,000 fact/s for a 5-second burst. Run with 1, 2 and 4 producer hosts; distinguish delivered records, unique accepted facts and bytes/s |
| Reads | Single session/execution drill-down; current daily/weekly provider totals; month/all-history model-tool-error aggregations; nested child joins; explicit small/large detail fetch. No query automatically loads a whole transcript |
| Mixed load | Ingestion alone, then ingestion with one broad scan plus repeated small lookups; multi-query saturation verifies cancellation/bounded backlog, not unlimited-query latency. Include a non-writing host refreshing summaries after another host's commit or deletion |
| Lifecycle (separate operational prototype) | Session-scoped mutation/revocation races; slow writes in one session do not lock unrelated sessions; point reads/close commits and indexed due selection. Validate independently of engine selection; test mixed analytical traffic before storage activation |

Method and limits:

1. Record OS/runtime/engine versions, CPU, storage type, selected settings, actual fixture sizes and available temporary disk. Start small; estimate/approve the large-tier footprint before generating it. Do not fill the disk to satisfy a nominal row target or claim a skipped tier passed.
2. Include hashing/compression/serialization in attribution wherever they run. Measure source observation to committed fact and separately to complete committed detail; a fast enqueue with a growing payload backlog is failure, not a win. Include reference reconstruction correctness and actual nested-result storage cost.
3. For each selected sustained 50-fact/s qualification condition, collect at least 10k fast-path samples and repeat in independently started processes. Report per-condition p50/p95/p99/max and backlog drain, not pooled averages. Use two independently started, at least five-minute 1-fact/s light-load runs for timer/batching/freshness behavior, reporting sample count, p50/p95/max without claiming a qualified p99 from that smaller sample. Do not stretch every light-load/topology combination into 10k wall-clock seconds: the envelope is risk-based, not a Cartesian product. Repeat each query at least ten times and report individual times/median/max; do not claim reliable p99 from ten queries.
4. Distinguish warm queries from the first query after process start; neither is automatically a cold OS filesystem cache. Do not flush machine-wide caches or perturb the desktop to manufacture a cold test.
5. Verify token/cost totals under the stated precision, missingness, once-only retry/child accounting, configuration attribution and scalar/detail separation against a small oracle. Terminal execution and transcript durability stay distinct. Include capture while privacy is on, followed by close-time deletion racing another helper's fact/detail write; no deleted data may reappear. This checks the analytics boundary, not full SDK/file/VS Code cleanup (§3).
6. Restart normally from persisted summaries without full fact replay. Explicitly test a schema/projection upgrade separately (§1); it must not reset retained facts or deletion markers. Targeted crash/partial-write tests belong to durability implementation; detailed outage policy is not a prerequisite for normal-path engine comparison.
7. Compare against a matched analytics-disabled baseline: measure agent turnaround/cancellation/failover and UI interaction/stream/render responsiveness under growing history, large detail and concurrent queries. Record incremental CPU/RSS, idle revision-check cost, total topology RSS, peak backlog bytes, database/WAL growth and query cancellation. Commit latency alone cannot establish agent or UI impact. Probe files/dependencies stay in a uniquely owned OS-temp directory; cleanup removes only its artifacts.

### Proposed numerical acceptance envelope

The user approved single-digit-ms synchronous agent-path overhead, practical UI/agent responsiveness
and delayed cross-window statistics, not single-digit-ms durable ingestion or these exact percentiles
and resource ceilings. These are engineering starting gates to validate on the target machine before
selecting production defaults. Background batching may be slower provided throughput, bounded backlog
and observation-to-visible freshness remain adequate.

| Measurement | Proposed gate |
|---|---|
| Producer overhead, small facts and large-detail handoff | p99 <= 9 ms synchronous added work per handoff; no dependence on total retained history or waits for persistence/queue drainage. Include actual nested-detail ownership and copying costs |
| UI/agent responsiveness | No material analytics-induced regression against the matched baseline under representative history/detail/query loads; measure the full path, not only recorder timings |
| Observation -> committed small fact | Report p50/p95/p99 and query-visibility lag; no single-digit-ms commit gate. Sustained ingestion must keep up, burst backlog must drain, and live freshness/resource budgets must remain satisfied |
| Complete detail ingestion | Report latency by byte-size and peak queued bytes, including 2 MiB bursts; backlog stays bounded and drains after a finite burst. Fix payload-throughput/queue-byte budgets from measured capacity before production; scalar commit alone is insufficient |
| Local live summary freshness | p95 <= 250 ms, p99 <= 500 ms from source observation to that host's visible summary, including ingestion delay; no historical scan on refresh |
| Cross-host live summary freshness | Start with roughly 1 s from committed summary while statistics are displayed; a brief reporting delay is accepted, not synchronized delivery. Also report observation-to-visible age so slow ingestion is not hidden. Measure polling/refresh overhead and tune within idle budgets |
| Indexed session/lifecycle lookup or ordinary close commit | p99 <= 9 ms persistence-service latency under mixed load; measure the full host close barrier separately. Private close includes deletion, not merely a point metadata write |
| Representative historical queries | Each representative query <= 9 s in each executed proposed tier; indexed drill-down target <= 250 ms. Final required scale remains to qualify; skipped tiers are not passed. Arbitrary expensive SQL remains cancelable, not promised this latency |
| Idle analytics overhead | No history polling/replay; incremental CPU target < 0.5% of one logical core averaged over 60 seconds, including bounded revision checks but excluding active capture/query/cleanup |
| Active capture CPU | Sustained 50 facts/s target <= 10% of one logical core above baseline, with the stated payload mix; report burst and query CPU separately |
| Incremental RAM | Target <= 16 MiB retained analytics state per host, <= 128 MiB recorder/helper idle RSS in the single-owner topology, <= 256 MiB during ordinary ingestion; report total topology RSS. Query peak allowance <= 512 MiB additional, with cancellation/concurrency bounds |

Burst overhead/backlog, restart latency, large-detail throughput and cancellation completion need
measured numbers before final gates are fixed; do not report only easy steady-state cases. No engine
is selected.
[Corrected mock experiments](ANALYTICS_EXPERIMENTS.md) cover 100k facts and a short same-live-database
mixed workload, not production qualification or the real handoff/reconstruction path. They favor
SQLite's small-write/point workload and DuckDB's scans in the measured adapters; neither establishes
actual producer overhead or UI/agent non-interference. Their commit-ACK latency is not synchronous
agent-path overhead. Earlier integer-binding-bug comparisons remain invalidated.
