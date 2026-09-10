# Analytics rework — execution record

Durable checkpoint and morning-review record for the overnight analytics/session-storage rework.
Maintained by the designated preflight/integration owner at every handoff and milestone, per
`docs/ANALYTICS_OVERNIGHT_RUNBOOK.md` ("Sequence and durable progress"). Sanitized engineering
evidence only. Recover from this file plus the owning specifications after compaction or child
failure; inspect actual files before any retry (subagent sessions are in-memory and cannot be
resumed).

Owning specifications: runbook; `docs/ANALYTICS_REWORK_PLAN.md` §§1, 11.6, 17;
`docs/ANALYTICS_IMPLEMENTATION_CONTRACT.md` §5 (tasks/acceptance) §6 (qualification);
`docs/ANALYTICS_EXPERIMENTS.md` (evidence, not qualification); `skills/develop-pie/SKILL.md`;
`docs/ARCHITECTURE.md`; owning clauses of `docs/STATE_CONTRACT.md`.

---

## Checkpoint 1 — 2026-09-09T10:4xZ, bounded preflight (this session)

**State: PREFLIGHT COMPLETE. Execution not started. No product code changed. Working tree clean.**

### Baseline

| Item | Evidence |
|---|---|
| Git | branch `master` @ `fa425069` == `origin/master` (up to date, verified), tree clean, no worktrees (`git worktree list`: only `C:/dev/repos/pie`). Preparation commit `fa425069` "Checkpoint runtime updates and prepare overnight analytics rework" (118 files: runbook/plan/contract/experiments docs, runtime generations+bootstrap activation groundwork, subagent provider-resilience refactor, settings.json) |
| Runtime versions | Node v24.16.0; SDK `@earendil-works/pi-coding-agent` 0.80.6 (pinned, `extension/node_modules`); VS Code extension 0.3.0; PIE changelog version 0.85.0 |
| Staged vs loaded | Staged generations: `4c2757bd…` (older), `65349a2e7ba29f220971b9d2e58d2763a5c4e479afcecd58d663cf7a1a8e6d72` (newest, published 2026-09-09T10:12:27Z). **Loaded** by host at 10:21:15Z: `~/.vscode/extensions/pie.pie-0.3.0/pie-runtime/generations/65349a2e…/out/backend.js` (pie.log). Startup loader working; prepared runtime is the loaded backend. agentDir `C:\dev\repos\pie`; sessionDir `C:\dev\repos\pie\data\outcomes\sessions` |
| Resources | Disk C: 796 GiB free of 935 GiB (qualification envelope bounds easily met: keep ≥20 GiB/20% free; temp probe cap 16 GiB). RAM 15.3 GiB total, ~3.7 GiB free at preflight — tight; scale probes must stream from disk and run one at a time |
| Test baseline | NOT run in preflight (tree clean → affected runner selects nothing; full fast suite is the first lead task). All npm wrappers present (`test`, `test:all`, `test:changed`, `test:file`, `verify`, `extension:build`, `sync-models`, `doctor`, …) |
| Existing rework state | No rework implementation exists (no `shared/analytics/`, `shared/pie-data-root.ts`, `extension/src/analytics/`, `extension/src/backend/session-lifecycle-store.ts`, `skills/query-analytics/`). Runbook status "not implemented yet" still accurate. Old analytics authority live at `data/outcomes/8c401ee313ff7786/` (billable-invocations.jsonl etc.) — will be switched off at P7a |
| Existing completed work | Preparation only (docs + activation-ingress groundwork: `extension/runtime/bootstrap.cjs`, `extension/runtime/runtime-generations.cjs`, `extension/scripts/{build,publication,runtime-publication}.mjs`). Old overnight report `docs/internal/overnight-reports/2026-07-16.md` is unrelated (July run) |

### Effective delegation policy (live process-env evidence in this tree)

`PIE_SUBAGENT_*` env mirrored from ChatPrefs via `runtimePrefs.set`:

- **Buckets** (`PIE_SUBAGENT_BUCKETS_JSON`): small `[copilot/luna@xhigh, ollama/deepseek-v4-flash:0731-cloud@max, codex/luna@xhigh]`, medium `[copilot/luna@max, ollama/glm-5.3-flash:cloud@max, codex/luna@max]`, frontier `[copilot/sol@high, codex/sol@high]`.
- **Effective pools** after `model-profiles.yaml` eligibility + provider toggles for THIS session: **github-copilot entries are ineligible in profiles** ("Auto-discovered from GitHub Copilot; not yet vetted for subagents") **and** github-copilot is disabled in `PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON` (this session's override enables only openai-codex). Effective: frontier **= [openai-codex/gpt-5.6-sol@high] (single assignment)**; medium = [ollama/glm-5.3-flash:cloud@max, openai-codex/gpt-5.6-luna@max]; small = [ollama/deepseek-v4-flash:0731-cloud@max, openai-codex/gpt-5.6-luna@xhigh]. Providers absent from the toggles map (ollama) are enabled.
- **Runbook deltas fixed vs its preparation-time note:** frontier is now allowed and populated (`PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON` all-true); openai-codex enabled for subagents in this session. Copilot remains disabled in subagent defaults (moot for buckets while profiles-ineligible).
- Nested buckets small/medium/frontier: all allowed; delegation (canSpawn) frontier-only (small/medium are leaves); `PIE_SUBAGENT_MAX_DEPTH=2`; tree sessions 10; inflight roots 2; always-parent off; route-around-saturated on; fallback-on-provider-failure on; dropped child tools `["ask_user"]`; autonomous mode on.
- Concurrency (models.yaml → provider gate): codex 4, ollama 3, copilot 2; retry: maxRetries 8/base 5s; provider maxRetries 2/60s; subagent retry env defaults initial 1s, max 60s, Retry-After clamp 120s.
- **History compaction**: on; soft 140k / hard 170k / keep 30k tokens; summary model `github-copilot/gpt-5.6-luna@high`. Live compaction record absent so far; two `history_compaction` billable records are `evidenceOrigin: "migration"` backfill only — **live summary-model availability still unverified** (validate first live compaction; Copilot route had a live success today 06:38 `github-copilot/gpt-5.6-sol`).
- **Route live evidence today (old analytics, `evidenceOrigin: live`):** openai-codex/gpt-6-astra (parent turns), ollama prepass/title models, one copilot conversation success.

### Provenance mechanism (for verifying future frontier leads)

Selection: requested bucket (`perCallBucket ?? agent.bucket ?? "medium"`) → nested allowlist downgrade (depth ≥ 1) → `selectModel` balanced shuffled cycle over the bucket pool filtered by profiles eligibility, provider toggles, retry exclusions, capacity, hard requirements → **empty/eligible-exhausted pool falls back to the caller's active model with `fallback: true`** (Astra in this tree — codex enabled). Auth/client failures are terminal, not failover. Tree budget counts every created subagent session tree-wide (`consumeTreeSlot`); fresh root trees get fresh budgets.

**Every child result carries provenance** (extensions/subagent/src/runtime-provenance.ts, selection.ts `attachSelectionMetadata`): `provider`, `model`, `bucket`, `requestedBucket`, `bucketDowngraded`/`bucketDowngradeReason`, `fallback`, `selectedModel`, `selectionPool`, `thinkingLevel`, `family`, `promptHash`, `parentToolCallId`. **Gate: inspect these on every result; stop substantial dispatch if `fallback: true`, `model: gpt-6-astra`, or bucket ≠ requested.** This preflight session's own provenance could not be self-verified from inside (in-memory session, not persisted, no live analytics record yet) — the parent must read it from this dispatch's result metadata before dispatching substantial work.

### Known deviations / risks

1. Parent workspace cwd is `c:\dev`, not `C:/dev/repos/pie` (runbook §"Before launching"). Mitigated: every subagent dispatch sets explicit `cwd` (this preflight ran at `C:/dev/repos/pie`); agentDir/sessionDir resolve correctly regardless.
2. Frontier pool is a single model (see above) — codex capacity 4; provider-level failure on codex empties frontier for that dispatch → Astra fallback risk is real. Recovery per runbook: use eligible cheaper route (medium pool) or existing qualified children; never silently accept parent fallback.
3. RAM headroom modest at preflight; disk ample.
4. Existing test failures unknown (deferred to first lead task below).

### Next ready tasks (contract §5 order; ≤2 disjoint editors per writing lead tree)

1. **Baseline test record** (medium leaf, read+run only): `npm run test:all` (fast suite), record failures into this file. No code changes.
2. **Tree #1 (frontier lead)**: P1 (`shared/analytics/{contracts,metrics}.ts` + focused tests) and P2a (`shared/pie-data-root.ts` + existing resolver files) — disjoint file sets; then P0 bounded engine-selection prototype on the real nested-child handoff with disposable temp data; early P2b privacy/close owner prototype contract; P2c package-seam investigation (read-only); early P7 terminal-handoff prototype. Frontier lead does the hard engineering; ≤2 concurrent disjoint leaf editors.
3. **Independent P6 removals** (medium leaf, separate tree): review/dashboard retirement groups per plan §6 — extract shared consumers first; needs no engine.

Cutover plan reminders: P7a analytics activation and P7b storage cutoff are separately gated (§11.6; contract §5); terminal one-shot helper must be rehearsed before reliance; final pre-cutover push precedes activation.

---

(Evidence from later milestones accumulates below this checkpoint.)

---

## Checkpoint 2 — 2026-09-09T10:46Z, baseline and fresh-dispatch provenance gate

**State: BLOCKED BEFORE PRODUCT IMPLEMENTATION. Runtime analytics/storage remains not activated. No
product source, test, dependency, configuration, runtime-data, cutover, restart, commit, or push
change was made.** The only checkout change remains this authorized execution record, which is
untracked at `fa425069` (`master == origin/master`).

### Baseline correction

The first execution lead ran the repository baseline before implementation: `npm test` completed all
7 selected packages with **6,806 passed, 0 failed, 29 skipped**. This supersedes Checkpoint 1's
"NOT run in preflight" future-action note. There is no preexisting failing test to carry into this
milestone.

### Fresh frontier assignment gate — failed closed

The fresh implementation dispatch is the durable parent-session record at
`data/outcomes/sessions/2026-09-09T10-22-04-382Z_01a085b0-625e-7718-a175-5c7feff981ba.jsonl`:

- parent tool call
  `call_onS8ErnpWkqg0I5ZpEnHiRSi|fc_0986f6d4fb825c3f016aa1366e66d487d0ab6b9f1e0e2a3589`,
  `agent: worker`, requested `bucket: frontier`;
- SHA-256 of its exact delegated `task` string, using the runtime's
  `hashDelegatedPrompt` rule: `393a9b3994c9c2808c5918573854f43792600dfd25ba5f31df6fd65621e45ede`;
- the parent JSONL currently has 11 records. Record 11 contains that call and there is **no matching
  durable `toolResult`**; exact search of
  `data/outcomes/8c401ee313ff7786/billable-invocations.jsonl` also has no matching tool-call row;
- exact search of `/tmp/pie-logs/pie.log` found no matching call ID or prompt hash and no current
  child-selection diagnostic; rotated `pie.log.1` was absent.

This is expected from the current implementation, but it means the gate cannot be proved during the
in-flight child itself: `extensions/subagent/src/single.ts` enriches transient progress and the final
result with `withRuntimeProvenance`, and
`extension/src/host/billable-accounting/service.ts::observeSubagentToolResult` derives durable child
usage from a tool result. The requested bucket alone is not actual assignment evidence. In
particular, the configured one-member frontier pool does not prove that this dispatch avoided the
active-parent fallback. Therefore actual `provider`, `model`, effective `bucket`, `fallback`, and any
provider-retry chain remain unknown until the parent durably receives the terminal result.

Per the runbook and dispatch instructions, substantial P0/P1/P2/P2b/P2c/P7 engineering stopped. No
Astra assignment was inferred, but no supported non-Astra assignment was proved either. Recovery is:

1. allow this child to return without product edits;
2. inspect the matching parent `toolResult.details.results[*]` for exact `provider`, `model`,
   effective `bucket`, `requestedBucket`, `fallback`, `selectedModel`, `selectionPool`, `promptHash`,
   `parentToolCallId`, and every `attemptRecords`/`providerInvocations` entry;
3. require `openai-codex/gpt-5.6-sol`, effective/requested `frontier`, `fallback !== true`, matching
   prompt hash/tool-call ID, and no disallowed retry target before opening the implementation gate;
4. if fields are missing, fallback is true, Astra appears, or the bucket differs, do not reuse the
   attempt. Disable active-parent fallback for the qualified dispatch or provide an independently
   auditable frontier launch/receipt record, then issue a fresh bounded lead.

The earlier medium preflight's verified `ollama/glm-5.3-flash:cloud` assignment is evidence only for
that completed preflight; it cannot establish this fresh frontier dispatch's identity.

### Safe preparatory seam inventory completed while blocked

This is read-only change-point preparation, not implementation or qualification:

- **P1/P0 shared boundary:** create the canonical wire contracts and invariant code under
  `shared/analytics/` (new source) and consume it from host/backend/subagent rather than cloning DTOs.
  Existing immutable subagent identity/provenance is in
  `extensions/subagent/src/{single,runtime-provenance,runtime-trace}.ts`; terminal billable extraction
  is in `extension/src/shared/{subagent-result,session-usage}.ts`. The P0 prototype must exercise the
  real `runSingleAgent`/nested-child handoff and real transcript envelopes, not a generic fixture.
- **P2/P2b storage authority:** the current split starts at
  `extension/src/shared/session-storage-paths.ts` and
  `extension/src/host/backend/client.ts`; backend cold/open/create/fork ownership remains in
  `extension/src/backend/server.ts`, `cold-session-store.ts`, `session-directory.ts`,
  `session-catalog.ts`, `worker-runtime-router.ts`, and `worker-runtime-host.ts`. The canonical
  lifecycle/privacy adapter belongs
  between those owners and the recorder; it must not add a second transcript writer or perform
  transcript I/O in the isolated analytics recorder.
- **P2c installed dependency seams:** pinned `pi-mcp-adapter` 2.20.1 stores `mcp-cache.json` and
  `mcp-npx-cache.json` directly under its `getAgentDir()`
  (`npm/node_modules/pi-mcp-adapter/{agent-dir,metadata-cache,npx-resolver}.ts`). Pinned
  `pi-web-access` 0.27.0 resolves configuration from `PI_CODING_AGENT_DIR` and stores fetched-content
  cache in `<config-dir>/web-search-cache`
  (`npm/node_modules/pi-web-access/{utils,storage}.ts`). Copilot discovery stores the advisory marker
  `<agent-dir>/.copilot-catalog-sync.json` and lock beside `models.yaml`
  (`extensions/copilot-model-discovery/{index,src/catalog-ttl,src/catalog-lock}.ts`). These versions
  expose no separate Pie data-root/cache-root option at those seams. A later qualified lead must first
  check a reproducible upstream upgrade; otherwise make an explicit checked-in dependency/wrapper
  change with focused tests. Do not mutate installed `node_modules` as the deliverable. The ordinary
  npm cache used by MCP npx resolution remains platform tooling unless the owning spec is amended.
- **P7 startup seam:** `extension/package.json` enters through
  `extension/runtime/bootstrap.cjs`. The bootstrap acquires one immutable runtime generation before
  the first `require(extension.js)`, delegates `activate`, and releases only after delegated
  `deactivate`; a failed partial activation deliberately has no second-candidate fallback.
  `extension/src/extension.ts` currently starts `PieExtension`/`BackendClient` without an analytics
  supervisor. The early prototype should wrap this ingress with a disabled-by-default supervisor and
  test a real disposable recorder process tree, bounded startup/shutdown, crash observation, and
  terminal status handoff while leaving both P7a analytics activation and P7b storage cutoff false.

### Remaining dependency graph and file ownership

`P1 contracts/invariants -> P0 real-producer engine qualification -> engine choice -> P3 recorder`
and `P2 root resolver -> P2b lifecycle/privacy adapter -> P3/P4/P5 producers`; P2c cache relocation
can proceed after P2 but before P7b. `P3 + P4 + P5 -> P6 legacy retirement -> P7a analytics cutover`.
`P2 + P2b + P2c + storage verification -> P7b storage cutoff`. P7a and P7b are independent gates;
restart/activation is a final separate gate after both required preflight checks and a pushed commit.
No live gate is open.

Next qualified lead owns only the new `shared/analytics/**`, `shared/pie-data-root.ts`, focused tests,
and bounded P0/P2b/P2c/P7 prototype seams until a reviewed handoff. Existing production P3-P6
consumers and all cutover/activation controls remain out of scope for that foundational milestone.

---

## Checkpoint 3 — 2026-09-09T10:50:41Z, durable terminal provenance recovery

**State: provenance gate recovered; ordinary foundation work may proceed.** The parent session's durable
JSONL contains terminal `toolResult` records for both earlier workers. This is actual selection metadata,
not parent-visible final prose or a requested bucket inference. No product source changes existed before
this recovery; the only pre-existing checkout change remains this untracked execution record.

### Decisive sanitized records

1. **Preflight medium worker**
   - Parent tool call: `call_npUuHUt6f8zKXrB0RoySgbtg|fc_0986f6d4fb825c3f016aa13430666887d094401859f8071d89`
   - `promptHash`: `bc792deb9f48b00762ab6458208ffcabe7eaede765d59ba18d7e098443f35d1a`
   - Actual `provider`: `ollama`; `model`: `glm-5.3-flash:cloud`; `selectedModel`:
     `ollama/glm-5.3-flash:cloud`; requested/effective `bucket`: `medium`/`medium`;
     `fallback`: `false`; `bucketDowngraded`: `false`; selection pool was
     `ollama/glm-5.3-flash:cloud`, `openai-codex/gpt-5.6-luna`; one successful attempt,
     with no Astra target.
2. **Last frontier worker**
   - Parent tool call: `call_onS8ErnpWkqg0I5ZpEnHiRSi|fc_0986f6d4fb825c3f016aa1366e66d487d0ab6b9f1e0e2a3589`
   - `promptHash`: `393a9b3994c9c2808c5918573854f43792600dfd25ba5f31df6fd65621e45ede`
   - Actual `provider`: `openai-codex`; `model`: `gpt-5.6-sol`; `selectedModel`:
     `openai-codex/gpt-5.6-sol`; requested/effective `bucket`: `frontier`/`frontier`;
     `fallback`: `false`; `bucketDowngraded`: `false`; selection pool contained only
     `openai-codex/gpt-5.6-sol`; one successful attempt, with `providerResponseObserved: true`.
   - **Conclusion:** the last frontier dispatch really ran Sol. Its no-product-change return was
     a failed-closed gate in the child prompt, not evidence of Astra fallback.

The durable source was
`data/outcomes/sessions/2026-09-09T10-22-04-382Z_01a085b0-625e-7718-a175-5c7feff981ba.jsonl`,
records 8 and 12, each matching its parent tool call, result metadata, and prompt hash. The current
recovery worker's own terminal provenance is not yet available until this dispatch returns; no
self-identity claim is made here.

### Gate distinction and supported future controls

The runbook has two separate requirements: **before dispatch**, validate effective provider-qualified
pools, nested allowlist, thinking support, provider access, always-parent/depth/tree settings and
fallback policy; **after every result**, inspect terminal `provider`, `model`, effective/requested
`bucket`, `fallback`, `selectedModel`, `selectionPool`, downgrade fields, prompt hash, parent tool
call ID, and every retry/attempt record. The requested bucket alone is never assignment evidence.
The recovered frontier result satisfies the after-result gate; the current worker may therefore do only
bounded ordinary P1/P2a work (and no unproven difficult integration).

The supported session-local control surface is the host `runtimePrefs.set` mirror, not auth or
`globalState`: set `subagentAlwaysParentModel: false`; explicit provider-qualified
`subagentBuckets` with Astra excluded; `subagentNestedAllowedBuckets: {small:true,medium:true,frontier:true}`;
`subagentBucketCanSpawn: {small:false,medium:false,frontier:true}`; `subagentProviderDefaults` enabling
providers present in those pools; `subagentMaxDepth: 2`, `subagentMaxTreeSessions: 10`,
`subagentMaxInflight: 2`, and the approved route/fallback/drop-tool settings. The implementation reads
these through `PIE_SUBAGENT_*` environment mirrors. There is no supported per-call "never fallback to
parent" or model-identity override: an empty/ineligible pool still follows the designed active-parent
fallback, so prevention is a nonempty eligible pool plus mandatory terminal provenance inspection.
No auth/global-state/generated-model setting was changed in this recovery.

### Ordinary foundation milestone ownership

This worker owns `shared/analytics/{contracts,metrics}.ts`, `shared/pie-data-root.ts`, their focused
`extension/test/` fixtures, the minimal host forwarding seam needed to expose the resolved `PIE_DATA_DIR`,
and this checkpoint. It does not own P0/P2b/P2c/P3–P5, cutovers, activation, or broad P6 deletion.
P6 remains pending until shared identity/prompt-setting/privacy helpers are extracted; no safe deletion
was selected before this foundation is integrated.

### Foundation milestone result — P1/P2a, 2026-09-09 recovery continuation

Implemented, without a live cutover:

- `shared/analytics/contracts.ts`: versioned observation/commit/deletion DTOs, trusted capture subjects,
  workspace/scope/provenance fields, typed logical record fields, int64 parsing/range checks and
  JSON-safe encoding, typed sink/no-op sink, privacy close disposition, numeric validation,
  deterministic idempotency identity, exact-redelivery acceptance and visible source-key conflict
  handling.
- `shared/analytics/metrics.ts`: missingness-aware distinct-invocation channel/cost aggregation,
  explicit cache/reasoning normalization, captured-rate pricing, cost parity tolerance, branch/copy
  and execution-inclusive selection, DST-safe local settlement buckets, busy-interval union,
  additive session/tool work, live estimates, measured settled throughput, distinct latency summaries,
  point-in-time context utilization, and small dimensional daily/weekly projections.
- `shared/pie-data-root.ts`: one `PIE_DATA_DIR` override, absolute/agent-rooted relative resolution,
  OS-local defaults (`%LOCALAPPDATA%\\pie\\data`, macOS Application Support, Linux XDG), explicit
  resolution errors, and stable analytics/sessions/artifacts/state/cache category paths.
  It performs no mkdir, migration, delete, fallback discovery, or data cutover.
- `extension/src/host/backend/client.ts`: resolves and forwards the canonical root as `PIE_DATA_DIR`
  before backend spawn while leaving current SDK session paths and all live gates unchanged. The
  existing session resolver remains the operational authority until the separately gated storage cutoff.
- Focused tests cover numeric/source-key/privacy invariants, the required accounting formulas,
  DST/week boundaries, root defaults/override failures, and host child-environment forwarding.

Validation completed: `npm run shared:typecheck`; `npm run extension:typecheck`; `npm run lint`; focused
extension tests for analytics/root/backend/session resolution — **26 pass, 0 fail**. No analytics or
session directory was created or moved, no dependency was changed, and no runtime/live activation was
performed. The repository's recorded baseline remains `6806 pass/29 skip` until the prescribed broader
suite is run.

### Durable dependency graph after this milestone

`P1 contracts/invariants [complete] -> P0 real-producer engine qualification [blocked/pending] -> engine choice -> P3 recorder`;
`P2a root resolver [complete] -> P2b lifecycle/privacy adapter [pending] -> P3/P4/P5 producers`;
`P2c supported cache relocation [pending]` may proceed after P2a but is not implemented here.
`P3 + P4 + P5 -> P6 legacy retirement -> P7a analytics cutover`; `P2a + P2b + P2c + storage
verification -> P7b storage cutoff`; `P7a/P7b -> restart/activation/report gate`. No live gate is open.

### Required direct handoff excerpts

- Runbook preflight/dispatch gate (§ observed settings and routing): “Empty/ineligible pools can inherit
the active parent model, potentially Astra; configured bucket names alone are not a cost guarantee.
Preflight must verify effective selection, provider eligibility and thinking support, then inspect
returned model/bucket provenance. Do not keep dispatching if unexpected Astra fallback or a lead
downgrade is observed.” (`docs/ANALYTICS_OVERNIGHT_RUNBOOK.md`, lines 72–76.)
- Runbook phase/continuation boundary: “Do not emit a final answer at a phase boundary, because
autonomous mode will not restart a finished turn. Productive work may continue beyond a nominal
overnight window; do not declare completion just because a time estimate elapsed.” (lines 186–190.)
- Scope plan §17 model identity/completion: “approval is not evidence that a gate passed”; “Complete
overnight means the agreed implementation, qualification and both live activations, with supported
cache relocation delivered and post-activation evidence recorded”; and “Unimplemented scope,
unqualified gates and activation failures remain incomplete, distinct from this explicitly required
delay.” (`docs/ANALYTICS_REWORK_PLAN.md`, §17.)

### Verification update

The prescribed affected/full fast suite completed after this milestone: **7/7 packages passed,
6,822 passed, 0 failed, 29 skipped**. One Windows startup-background cleanup case failed on its
first run but passed on the runner's automatic rerun and was reported as flaky; no case remained
failed. Full `npm run typecheck` passed for all registered packages, and
`npm run extension:build:validate` passed (only pre-existing Vite/Zod annotation and chunk-size
warnings). The 16-test foundation addition accounts for the increase from the recorded 6,806 pass
baseline. Git status contains only the intended source/tests/checkpoint; no generated build output is
tracked. This remains a foundation commit candidate, not completion of §17: P0 engine qualification,
P2b/P2c, producer capture, retirement, both live cutovers, supported cache relocation and durable
restart activation are still pending. No commit or push was made by this implementation worker; the
separate Git/integration gate must inspect the complete untracked/modified manifest, review the focused
diff, and commit/push only this coherent foundation milestone.

---

## Checkpoint 4 — 2026-09-09T11:4xZ, foundation integration gate

**State: P1/P2a VERIFIED; foundation commit/push in progress. No analytics/storage activation or
runtime cutover.** Baseline remains `fa425069`; only the foundation files named in Checkpoint 3 and
this execution record are owned by this milestone.

### Mandatory reviewer provenance and effective frontier preflight

The most recent completed reviewer result was read directly from parent JSONL
`data/outcomes/sessions/2026-09-09T10-22-04-382Z_01a085b0-625e-7718-a175-5c7feff981ba.jsonl`,
record 16 / tool call
`call_riVbfDl2H9GtiRoZtGXqXlua|fc_0986f6d4fb825c3f016aa1424686f887d0952037266b902159`.
Its durable `details.results[0]` says actual `provider: "ollama"`,
`model: "glm-5.3-flash:cloud"`, `selectedModel: "ollama/glm-5.3-flash:cloud"`,
requested/effective bucket `medium`/`medium`, `fallback: false`, `bucketDowngraded: false`,
`thinkingLevel: "max"`, prompt hash
`160199efee0b5ffa84ca6c39e7bec880240337b7dc18a3bb3b2aba2b09fb1039`, and one successful
attempt (`providerResponseObserved: true`, `backoffMs: 0`, no alternate target). The review verdict
approved P1/P2a content and required the missing copy/truncation fixtures before integration.

Current process configuration was revalidated before engineering: always-parent is off; all nested
buckets are allowed; only frontier can spawn; depth/tree/inflight are 2/10/2; fallback and
route-around-saturation remain enabled; Astra appears in no child bucket. The frontier pool config
contains Copilot and Codex Sol, but Copilot is profile-ineligible and provider-default disabled;
parent-session override enables Codex, and `model-profiles.yaml` marks
`openai-codex/gpt-5.6-sol` eligible with `high` supported. The effective frontier candidate is thus the
same single Codex Sol route that completed record 12 with requested/effective frontier/frontier,
`fallback: false`, `bucketDowngraded: false`, and one successful response-observed attempt. No Astra or
downgrade evidence was observed. This worker makes no impossible self-terminal provenance claim;
the next independent worker must inspect this dispatch after return.

### Reviewer repairs and verification

- Added the exact §2 parity assertions: copy A+B then D=.04 yields source=.03, inherited=.03,
  copy-own=.04 and global=.07 (not .10); branch B/C views are .03/.04 and root all-work remains .06
  after truncation changes the selected branch.
- Closed the reviewer's recorder-boundary follow-up early: envelope validation now cross-checks the
  supplied idempotency key against its generation/kind/source tuple, uses a no-NUL deterministic JSON
  tuple identity, and recursively validates all known timestamp fields as signed int64. Exact
  redelivery remains a no-op; conflicting source content remains visible.
- Focused 3-file tests: 19 passed, 0 failed. `npm run shared:typecheck`,
  `npm run extension:typecheck`, and `npm run lint` passed. Fresh `npm test`: 7/7 packages,
  **6,823 passed, 0 failed, 29 skipped**. `npm run extension:build:validate` passed with only the
  pre-existing Vite annotation/chunk warnings.

P0/P2b/P2c/P7 prototypes remain pending until this milestone is committed, pushed, and remote-verified.
All live authority flags remain old-runtime/default-off; no new database, runtime directory, session
closure, restart, dependency change, or production cutover occurred.

### Foundation Git barrier receipt — 2026-09-09T11:5xZ

Foundation commit `46cf69b715137fa542ed72494c5f494b4b85e8c0` (`Add analytics contracts and
canonical data root`) was pushed normally to `origin/master`. A subsequent `git fetch origin master`
verified `HEAD == origin/master == 46cf69b715137fa542ed72494c5f494b4b85e8c0`; the worktree was clean.
This receipt-only checkpoint update is committed separately so the exact milestone hash can be named
without a self-referential commit. P0 is now ready in contract §6 order.

---

## Checkpoint 5 — 2026-09-09T20:27Z, bounded recovery after interruption

**State: P1/P2a remain verified and already pushed; no analytics/storage activation or live cutover.**
Recovery inspection found an unreviewed partial P3 prototype and unrelated working-tree changes. They
are preserved and are not included in the foundation receipt below. The next fresh frontier task is
P0 only after a new effective-provider preflight; no new child was dispatched from this recovery worker.

### Recovered repository and runtime state

- `HEAD` and `origin/master` were both `5443929b121d0005c29772c6b28dbb190ebb1b03` before this
  checkpoint update. Foundation source is in pushed commit `46cf69b715137fa542ed72494c5f494b4b85e8c0`
  (`Add analytics contracts and canonical data root`), with its pushed receipt in `5443929b`
  (`Record analytics foundation milestone receipt`). The reviewed fixture and runtime invariant repairs
  are present in that commit: copy A+B plus D=.04 proves global=.07 rather than .10; truncation keeps
  root all-work; idempotency keys and known timestamp fields are validated at the envelope boundary.
- The preserved interrupted work is exactly: modified `extension/scripts/build.mjs` and
  `extension/vite.config.ts` adding three analytics bundle entries; untracked
  `extension/src/analytics/{recorder-supervisor.ts,recorder-worker-entry.ts,sqlite-recorder.ts}` and
  `extension/test/analytics/sqlite-recorder.test.ts`; and an unowned `settings.json` default model/provider
  change. The partial recorder test passes, but this P3 code/config is not reviewed, integrated, or
  committed. No unknown change was reset, stashed, deleted, or bundled.
- The installed/loaded runtime remains generation
  `65349a2e7ba29f220971b9d2e58d2763a5c4e479afcecd58d663cf7a1a8e6d72` (backend start evidence in
  `/tmp/pie-logs/pie.log` at 2026-09-09T20:16:05Z); the source-only `extension:build:validate` produced
  build identity `b85f083ec3c80257aae9` but did not publish or replace the installed generation. The
  analytics recorder is disabled/not wired into the live extension, storage roots and old analytics
  authority are unchanged, and no production database, migration, restart, or cutover occurred.

### Completed terminal provenance recovered from the prior parent JSONL

Source: `data/outcomes/sessions/2026-09-09T10-22-04-382Z_01a085b0-625e-7718-a175-5c7feff981ba.jsonl`,
with fields read from each completed subagent `toolResult.details.results[0]` (not parent-visible prose):

| Record / call | Actual provider/model; effective/requested bucket | Fallback/downgrade | Attempt evidence |
|---|---|---|---|
| 8 / `call_npUuHUt6f8zKXrB0RoySgbtg\|fc_0986f6d4fb825c3f016aa13430666887d094401859f8071d89` | `ollama` / `glm-5.3-flash:cloud`; medium / medium | `false` / `false` | 1 success, response observed, settlement `stop`, backoff 0 |
| 12 / `call_onS8ErnpWkqg0I5ZpEnHiRSi\|fc_0986f6d4fb825c3f016aa1366e66d487d0ab6b9f1e0e2a3589` | `openai-codex` / `gpt-5.6-sol`; frontier / frontier | `false` / `false` | 1 success, response observed, settlement `stop`, backoff 0 |
| 14 / `call_P9oSXWm2bO9u2nsFNjr1ne9E\|fc_0986f6d4fb825c3f016aa139f27b8487d0863e0d762a87479d` | `openai-codex` / `gpt-5.6-luna`; medium / medium | `false` / `false` | 1 success, response observed, settlement `stop`, backoff 0 |
| 16 / `call_riVbfDl2H9GtiRoZtGXqXlua\|fc_0986f6d4fb825c3f016aa1424686f887d0952037266b902159` | `ollama` / `glm-5.3-flash:cloud`; medium / medium | `false` / `false` | 1 success, response observed, settlement `stop`, backoff 0 |
| 18 / `call_2KAE2cSXHlsy2h0C4QCvnrr1\|fc_0986f6d4fb825c3f016aa143ec12c887d096a263a7bdf93f52` | `openai-codex` / `gpt-5.6-sol`; frontier / frontier | `false` / `false` | terminal attempt failure, response observed, settlement `error`, backoff 0; no Astra/alternate target |
| 20 / `call_4yFihqXB4XmRWXdUQvILkpyF\|fc_0986f6d4fb825c3f016aa1bd60f62087d0ba0f167aad43681e` | `openai-codex` / `gpt-5.6-luna`; medium / medium | `false` / `false` | terminal attempt aborted, response observed, settlement `aborted`, backoff 0 |

Thus every completed prior child was non-Astra; the successful frontier evidence is Codex
`gpt-5.6-sol` at `high` with matching effective/requested frontier and no fallback/downgrade. The
failed frontier route and aborted recovery route are recorded as outcomes only; no shutdown or provider
outage diagnosis is made.

### Recovery preflight and validation

The current recovery process environment was checked before any substantial dispatch: always-parent
`0`; nested buckets small/medium/frontier all allowed; only frontier can spawn; max depth/tree/inflight
`2/10/2`; route-around-saturated and fallback-on-provider-failure enabled; dropped tools
`["ask_user"]`; but both `github-copilot` and `openai-codex` are currently disabled in
`PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON`. Therefore no fresh frontier assignment was attempted; requested
bucket would not prove an effective non-Astra route. Recovery made no intentional auth, global-state,
generated-model-config, or machine-setting change; the unowned `settings.json` diff above remains
untouched.

Validation after recovery inspection:

- Focused foundation plus preserved recorder tests (`npm run test:file -- extension/test/shared/analytics-contracts-metrics.test.ts extension/test/shared/pie-data-root.test.ts extension/test/host/backend/backend-client.test.ts extension/test/analytics/sqlite-recorder.test.ts`): **22 passed, 0 failed**.
- Affected `npm test`: **4,499 passed, 0 failed, 19 skipped** (extension package).
- `npm run typecheck`: passed for all registered packages; `npm run lint`: passed.
- `npm run extension:build:validate`: passed; only the existing Vite/Zod annotation and chunk-size
  warnings; source output was not published.
- Full fast suite `npm run test:all`: **7/7 packages, 6,826 passed, 0 failed, 29 skipped**.

No test result authorizes P3 integration or either live gate. The foundation milestone remains the
only accepted analytics work; all P0/P2b/P2c/P3–P7 criteria remain pending, with analytics generation
and storage cutoff still off.

### Exact next fresh frontier gate

After restoring/enabling a supported Codex frontier pool through the existing session-local
`runtimePrefs.set` mirror and inspecting that child's terminal provenance, dispatch one fresh bounded
P0 owner. It must use disposable temp data and the real nested-child producer boundary first: large
tool/detail handoff, independent payload ownership, delayed recorder acknowledgement, completion,
cancellation and failover, explicit reconstruction, producer overhead and retained-byte measurement.
Only then run the bounded SQLite capture/projection/query/restart and multi-host comparison required by
implementation contract §6, recording the selected-engine decision in `docs/ANALYTICS_EXPERIMENTS.md`.
Keep the preserved unreviewed P3 files out of the P0 acceptance set, do not change the old authority,
and do not perform P2b/P2c/P3 production integration or either cutover in that task. Inspect its actual
provider/model/effective-requested bucket/fallback/downgrade/attempt fields after return before any
subsequent substantial dispatch.

### Recovery checkpoint Git barrier receipt — 2026-09-09T20:30Z

This checkpoint was committed as `d58cad71004e2e8223e863a76157ec42c4aed9c3`
(`Record analytics recovery checkpoint`) and pushed normally to `origin/master`. A fresh fetch verified
`HEAD == origin/master == d58cad71004e2e8223e863a76157ec42c4aed9c3`. The remaining dirty paths are
only the preserved, unreviewed recorder prototype/config and the unowned `settings.json` change listed
above; they were not included in this receipt.

---

## Checkpoint 6 — P2c supported cache relocation implementation (working-tree milestone)

**State at this checkpoint:** P2c implementation was present but not yet committed or activated. It
was subsequently committed and pushed; see the Git barrier receipt below. The protected recorder
prototype/config and user-owned `settings.json` remain untouched. No installed `node_modules` file was
edited as a deliverable, no cache migration/cutover ran, and ordinary npm/`_npx` cache ownership is
unchanged.

### Supported seams and exact ownership

- `extension/src/host/backend/client.ts` now resolves `resolvePieDataPaths()` once and forwards the
  absolute internal `PIE_CACHE_DIR=<PIE_DATA_DIR>/cache` alongside the existing canonical
  `PIE_DATA_DIR`. This is a backend child-process seam, not a second user-facing data-root override.
- `extensions/web-access-guard/index.ts` locates only the active managed installs under
  `<PI_CODING_AGENT_DIR>/npm/node_modules`. For exactly `pi-mcp-adapter@2.20.1`, a source-shape
  fingerprint routes only `mcp-cache.json` and `mcp-npx-cache.json` through `PIE_CACHE_DIR`; other
  `getAgentPath` callers (MCP config/auth/onboarding/server state) remain in the agent root. The
  adapter's npm `_npx` package cache is deliberately not moved.
- For exactly `pi-web-access@0.27.0`, a source-shape fingerprint routes only the fetched-content
  `web-search-cache/` directory through `PIE_CACHE_DIR`; web configuration and credentials remain
  under the package's existing config root. Both transforms are atomic, idempotent, and fail closed
  on package-version/source drift. The existing web workflow/corruption guard remains independent.
- `extensions/copilot-model-discovery/src/catalog-ttl.ts` and `index.ts` route only the advisory
  `.copilot-catalog-sync.json` freshness marker through `PIE_CACHE_DIR`, creating its parent on
  successful refresh. The authoritative `models.yaml` and `${catalogPath}.copilot-sync.lock` remain
  in the agent directory; no pricing/model configuration authority moved.

This satisfies the plan's “supported new package seam or reproducible pinned-package seam” condition
without claiming an upstream independent cache-root API. The checked-in guard is the reproducible
adapter for the locked versions and emits a visible diagnostic/no-op on version drift; a future
upstream release with a native seam can replace it without migrating existing cache files.

### Focused evidence

- `npm run test:file -- extensions/web-access-guard/test/web-access-guard.test.ts extensions/copilot-model-discovery/test/copilot-models.test.ts extension/test/host/backend/backend-client.test.ts` — **3/3 packages passed; 42 + 26 + 2 tests passed**.
- `npm run extension:typecheck` — passed.
- Guard fixtures cover the exact 2.20.1/0.27.0 source shapes, idempotence, absolute-cache routing,
  managed MCP lookup, and version-drift fail-closed behavior. Copilot fixtures cover cache-marker
  selection and agent-root fallback. Backend forwarding asserts the absolute cache category.
- At checkpoint time, the remaining gate was the broader typecheck/lint/build/fast-suite and
  independent review before committing only this P2c/docs milestone. The broader checks passed and
  the milestone was committed as recorded below; independent acceptance review remains outstanding.
  P2c does not authorize analytics activation, storage cutoff, or the preserved P3 recorder
  integration.

### P2c Git barrier receipt — 2026-09-10

Commit `28421714917577a300b8b98372aa92a9d9beb539` (`Add supported cache-root seams`) was pushed
normally to `origin/master`; a fetch verified `HEAD == origin/master == 28421714917577a300b8b98372aa92a9d9beb539`.
Only the P2c source/tests/docs listed above were staged. The modified `extension/scripts/build.mjs`,
`extension/vite.config.ts`, `settings.json`, and untracked `extension/src/analytics/**` plus
`extension/test/analytics/**` remain unstaged and preserved as the prior unreviewed/user-owned dirty
set.

### Current routing preflight handoff

The inherited shell mirror currently reports `always-parent=0`, nested allowed buckets all true,
frontier-only child spawning, `depth/tree/inflight=2/10/2`, and fallback-on-provider-failure enabled.
The frontier pool names Copilot Sol and Codex Sol, but `PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON` currently
disables both `github-copilot` and `openai-codex`. The current session identity is not exposed as
`PI_SESSION_ID` or an equivalent supported shell variable, so the per-session toggle record cannot be
safely selected from the inherited map. Fresh delegation attempts therefore cannot prove the required
Codex Sol route and were not accepted as frontier evidence; no settings/global/auth change and no
unsupported environment edit was made. A future live session must use the existing supported
session-local `runtimePrefs.set`/control surface to enable the qualified Codex provider for its own
session, then independently inspect terminal provenance before substantial frontier work. Parent and
nested provider resolution remain separate gates.

### Durable completion status

P2c is pushed and verified, but independent acceptance review remains outstanding. P0 real-producer
qualification, P2b lifecycle/close ownership, reviewed P3/P4/P5 production capture/query integration,
P6 retirement, P7a analytics activation, P7b storage
cutoff, and the post-restart activation helper remain incomplete. The recorder prototype is still
disabled and not wired into the live extension; no analytics database, storage cutoff, cache migration,
or live activation was performed. The supported cache code is source-only until a rebuilt runtime is
loaded, so this receipt must not be reported as post-activation cache evidence. The next owner should
recover routing through the supported control mirror, keep the preserved dirty paths isolated, and
qualify the real producer/capture/lifecycle gates before any live activation or destructive cutoff.

---

## Checkpoint 7 — 2026-09-10, bounded P0/early-risk prototype milestone

**State: REAL PRODUCER BOUNDARY AND BOUNDED SQLITE CANDIDATE PASS; NO ENGINE SELECTED; NO LIVE
ACTIVATION.** `HEAD == origin/master == 8628fd0f` before this checkpoint. The worktree's pre-existing
`settings.json` model preference diff remains unowned and untouched. The user is actively using Pie and
current `PIE_AUTONOMOUS_MODE=0`; this milestone did not change autonomous mode, install/activate an
extension, publish a runtime, close a live session, terminate/restart a host, or arm a later disruptive
process. Only disposable recorder helpers and OS-temp databases were started and cleanly stopped.

### Recovered routing/provenance evidence

The exact root session is
`data/outcomes/sessions/2026-09-09T10-22-04-382Z_01a085b0-625e-7718-a175-5c7feff981ba.jsonl`.
`PIE_OPEN_TABS` identifies its active parent as OpenAI Codex/Astra. Root-path toggle resolution in
`extensions/subagent/src/execute.ts` resolves the root snapshot once and `single.ts` propagates it;
the exact root override `{"openai-codex":true}` therefore beats disabled defaults tree-wide. The
effective frontier pool is `[openai-codex/gpt-5.6-sol@high]`; always-parent is off.

The two terminal results that were pending at Checkpoint 6 were read from records 31 and 32:

- record 31 scout: `ollama/glm-5.3-flash:cloud`, medium requested/effective, `fallback:false`,
  `bucketDowngraded:false`, thinking `max`, prompt hash
  `1cace3d0d91b69df3f79a12bfdf617168f7bce007edd3d84342c8d5e72069b11`; one successful,
  response-observed attempt, zero backoff;
- record 32 reviewer: `openai-codex/gpt-5.6-luna`, medium requested/effective,
  `fallback:false`, `bucketDowngraded:false`, thinking `max`, prompt hash
  `b75612afec960e2b91d39bc1d26c63faa380f03d975b84ca827100d5e48139b1`; one successful,
  response-observed attempt, zero backoff.

Neither result used Astra, fallback, downgrade or an alternate attempt. This current implementation
worker cannot inspect its own terminal result before return and makes no self-provenance claim.

### Mandated-order results

1. **Real nested-child/large-detail handoff and teardown first — passed for the bounded seam.** The
   actual `executeSingleTask` attempt loop snapshots every terminal attempt before result compaction
   using the shared typed sink. A two-level nested tool result with a ~1.4 MiB child body remained exact
   after the returned result was mutated. Attempt resources were released before handoff. Separate
   fixtures retained failed and successful failover attempts plus cancellation. Capture status is
   explicit (`disabled|submitted|rejected`); no storage acknowledgement enters completion/failover.
2. **Privacy/close operational owner next — early prototype passed.**
   `SessionLifecycleStore` persists reversible per-session privacy, freezes the first close operation,
   retains non-private sessions for exactly 24 hours with signed-64-bit arithmetic, survives app-store
   reopen, increments write epoch, and exposes indexed due selection. The recorder's own transaction
   atomically installs a minimal deleted-subject marker and removes session facts, detail references and
   last-owner content. Late fact/detail writes cannot resurrect the subject. This is not the still-needed
   cross-host filesystem mutation/revocation primitive.
3. **Independent P7 ingress/restart helper next — early prototype passed, disabled by default.** A
   disabled supervisor started no worker. A disposable enabled rehearsal cleanly replaced only its
   recorder helper three times (109.2 ms p50, 132.5 ms max). It does not control the extension host or
   constitute the terminal one-shot P7a/P7b activation helper.
4. **SQLite evaluation last — bounded candidate pass, not selection.** The matrix and full sanitized
   output are in `docs/internal/ANALYTICS_P0_QUALIFICATION_2026-09-10.json`; interpretation is in
   `docs/ANALYTICS_EXPERIMENTS.md`. On Node 24.16.0/Windows x64, four helpers accepted 10,000 mixed
   facts and drained in 1.642 s. Synchronous fact handoff p99 was 0.0094 ms; 2 KiB detail
   serialize+handoff p99 0.0798 ms (950 samples), 32 KiB max 0.1779 ms (49), and the single 2 MiB
   sample 0.9566 ms. A deliberate 300 ms ACK delay left handoff at 0.2265 ms and simulated completion
   at 2.3374 ms. Nested reconstruction was exact; 10.12 MB logical detail used 3.31 MB content storage.
   Final backlog was zero; peak detail backlog 8.06 MB. Four helpers used 223.65 MB aggregate RSS;
   producer RSS grew 28.41 MB. The database/WAL used 27.66 MB while preserving the 20 GiB free-space
   reserve and 16 GiB temp cap; the unique temp tree was removed. A private delete racing another
   helper's late fact/detail reported two asynchronous delivery failures, kept the ingress live for an
   unrelated fact, and left both private counts zero. A deliberate 1 MiB cap visibly rejected one 2 MiB
   handoff rather than silently dropping it or choosing an outage policy.

### Criteria still open and exact ownership

No production engine is selected because contract §6 still requires the 1M/10M history tiers (or an
honest capacity-based smaller required envelope), two independent 10k-sample sustained 50-fact/s runs,
two five-minute 1-fact/s runs, ordinary one/two/four-host comparisons, matched analytics-disabled
agent/UI baselines, idle/active CPU, mixed read/write and cancellation bounds, schema/projection upgrade,
and full semantic accounting/query fixtures. The one 2 MiB sample is not called a p99. Deferred
storage-outage/loss policy remains unresolved; explicit capacity rejection is qualification evidence,
not a production policy.

- **P2b owner next:** integrate the durable close decision with the existing operation owner, implement
  the session-scoped cross-host filesystem mutation/revocation and artifact/expiry barriers, then run
  the full races. Do not move this authority into the recorder.
- **P3/P4 owner after selected-design gate:** harden schema migration/projections, wire the typed sink at
  host/provider/tool roots, add bounded delivery reconciliation and measured queue defaults, and retain
  full attempt detail. Do not activate or treat the current recorder as production.
- **P5 owner:** native read-only authorization, bounded/cancelable queries and detail ranges remain
  absent. Current recorder methods are qualification probes only.
- **P7 owner after all gates:** build/rehearse the independent commit-identifiable one-shot activation
  artifact with parent-loss/idempotent recovery and all-host writer fencing. Neither P7a nor P7b may run
  from this milestone.

The **actual loaded old authority** remains the previously evidenced generation
`65349a2e7ba29f220971b9d2e58d2763a5c4e479afcecd58d663cf7a1a8e6d72`, with old analytics under
`data/outcomes/8c401ee313ff7786/`. `extension:build:validate` emitted a disposable source validation build
only; it did not publish or change the loaded generation. Analytics generation and storage cutoff both
remain off.

### Verification at checkpoint

- `npm run test:file -- extensions/subagent/test/model-requirements.test.ts` — 20 passed, including
  rich success, failover-attempt and cancellation ownership.
- `npm run test:file -- extension/test/analytics/sqlite-recorder.test.ts extension/test/analytics/session-lifecycle-store.test.ts`
  — 7 passed: exact redelivery/conflict, linked reconstruction/dedup/last-owner removal, deletion fence,
  projection/restart/int64, privacy/restart/first-close/24-hour due behavior.
- `npm run typecheck` — all 18 registered projects passed.
- `npm run extension:build:validate` — passed; emitted worker/supervisor/recorder bundles with only the
  existing Zod annotation and large-chunk warnings; no publish/activation.
- `node extension/scripts/analytics-p0-qualification.mjs` — passed the predeclared bounded matrix and
  removed disposable data; exact JSON above.

Final integration checks: `npm test` ran the full fast suite — **7/7 packages, 6,841 passed,
0 failed, 29 skipped**. Full `npm run typecheck`, `npm run lint`, the focused analytics/lifecycle and
subagent source tests (**28 passed**), `npm run extension:build:validate`, and the disposable
qualification harness passed. Build validation emitted only the existing Vite annotation/chunk warnings and did not publish.
One permitted independent reviewer was dispatched after the prototype settled, but its tool call
returned no readable result to this worker; no reviewer approval or terminal provenance is claimed,
and no replacement reviewer was dispatched. Session-scoped manifest/diff review, commit and push
remain the integration barrier. No milestone commit/push is yet claimed here.

### P0 prototype Git barrier receipt — 2026-09-10

Commit `9f182782058136d213aa154464f7277d852127f1` (`Prototype analytics capture and SQLite
qualification`) was pushed normally to `origin/master`; a fresh fetch verified
`HEAD == origin/master == 9f182782058136d213aa154464f7277d852127f1`. Only the 18 P0/capture/lifecycle/
recorder/build-test/evidence paths listed above were staged. The pre-existing user-owned
`settings.json` diff is the sole remaining worktree change and was not staged or modified by this
milestone.

Source and tests are committed; emitted validation build identity `51d49b0c0dbc1941e394` is only a
`build:validate` artifact and was not published or activated. The latest observed actually loaded
runtime remains the old generation
`65349a2e7ba29f220971b9d2e58d2763a5c4e479afcecd58d663cf7a1a8e6d72`, with ordinary analytics
still owned by `data/outcomes/8c401ee313ff7786/`. Analytics generation activation, storage cutoff,
session closure, host restart and cache activation therefore remain not performed. The next P2b owner owns the
session-scoped cross-host mutation/revocation and artifact/expiry integration; the next P3 owner owns
production recorder migrations/projections, bounded query/cancellation, asynchronous reconciliation
and capacity-policy work after full selected-design qualification. A later P7 owner must build and
rehearse the actual finite one-shot activation process; this helper prototype is not that authority.

## Checkpoint 8 — 2026-09-10, bounded P6 prerequisite extraction and post-P0 integration review

**State: P6 prerequisites are extracted and pushed; review retirement itself is not performed.** The
neutral identity/settings seam was implemented without deleting the reviewer, evaluation skill/agent,
review fields, review sidecars, review outbox, or review-triggered close paths. The post-P0 analytics
capture/query integration remains a separate uncommitted candidate and is not represented by the P6
commit below. No runtime publication/install, host restart, session closure, storage cutoff, analytics
activation, or live cutover occurred.

### P6 prerequisite milestone

- Generic `sessionPathHash`/`resolveSessionIdentity` now live in
  `extension/src/shared/session-identity.ts`; review storage imports the neutral helper, while stats
  storage/service and privacy cleanup no longer depend on review ownership. The focused identity
  behavior remains covered by the review-store test fixture.
- Session-prompt toggles now have the neutral `extension/src/backend/session-settings-store.ts`
  owner and `PIE_SESSION_SETTINGS_DIR` authority under `<PIE_DATA_DIR>/state/session-settings`.
  `PIE_LEGACY_SESSION_SETTINGS_DIR` is a one-way compatibility source for the former review-sidecar
  file: reads preserve existing toggles, the first successful write copies them to the neutral store,
  and privacy cleanup scrubs the old entry. `PIE_REVIEWS_DIR` remains review-only. The old
  `system-prompt-toggle-store.ts` is only a deprecated re-export shim so unrelated imports cannot
  silently lose behavior during the staged retirement.
- `extension/src/backend/server.ts`, `worker-runtime-host.ts`, `private-session-artifacts.ts`, the
  host backend environment forwarding, and focused cold-session/backend tests were updated to use the
  neutral settings owner. No review reader or writer was removed.

Git barrier receipt: commit `d5704d26` (`Extract neutral session identity and settings ownership`) was
pushed normally to `origin/master`; `git fetch origin master` verified `HEAD == origin/master ==
d5704d26`. The user-owned `settings.json` change and the separate post-P0 analytics candidate remain
unstaged and preserved.

### Post-P0 candidate classification and evidence

The remaining dirty product files are not P6 retirement work. They are a candidate integration layer
across canonical capture, recorder supervision/restart, SQLite projections and query workers, dormant
host accounting/stats adapters, subagent detail capture, redaction, build entries, qualification
probe/tests, and shared contracts. Exact current product paths are:

- modified: `extension/scripts/analytics-p0-qualification.mjs`, `extension/scripts/build.mjs`,
  `extension/src/analytics/{recorder-supervisor,recorder-worker-entry,sqlite-recorder}.ts`,
  `extension/src/host/{billable-accounting/service,extension-host}.ts`,
  `extension/src/host/stats-service/{service,types}.ts`,
  `extension/src/shared/sensitive-redaction.ts`,
  `extension/test/analytics/sqlite-recorder.test.ts`,
  `extension/test/shared/analytics-contracts-metrics.test.ts`, `extension/vite.config.ts`,
  `extensions/subagent/src/analytics-capture.ts`, and `shared/analytics/contracts.ts`;
- untracked: `extension/scripts/analytics-real-producer-probe.ts`,
  `extension/src/analytics/{canonical-capture,query-client,query-worker-entry}.ts`,
  `extension/test/analytics/canonical-capture.test.ts`, and `shared/sensitive-redaction.ts`;
- separate user-owned change: `settings.json`.

The real-producer qualification was rerun successfully after correcting the probe's terminal shape and
capture call signature. It covered 10,000 fact rows, 1,000 detail payloads (950 x 2 KiB, 49 x 32 KiB,
1 x 2 MiB), four producer helpers, clean helper restart x3, private deletion racing late detail,
bounded queues, read-only queries, and explicit capacity rejection. It demonstrates detached serialized
detail, nested evidence retention, credential redaction before serialization, non-blocking handoff, and
visible `rejected` capacity status. This remains bounded qualification evidence only: no production
engine is selected, and the 1M/10M tiers, sustained/light-load runs, UI/CPU baselines, cancellation,
upgrade, full selected-design review, production lifecycle/reconciliation, and activation gates remain
open.

### Validation and runtime/provider evidence

- `npm run lint` — passed.
- `npm run typecheck` — all 18 registered projects passed.
- `npm test` — 7/7 packages, **6,853 passed, 0 failed, 29 skipped**.
- Focused P6 backend/identity/settings/backend-client tests — **36 passed, 0 failed**.
- `npm run extension:build:validate` — passed; only existing Zod annotation and chunk-size warnings;
  latest source validation build identity `57c618a62c42bf3c5f7e` was not published.
- Earlier P0 focused analytics tests and the corrected disposable qualification harness also passed;
  no generated output is tracked.

Verified prior child provenance for the bounded P0 work remains: medium route
`ollama/glm-5.3-flash:cloud`, requested/effective `medium`, `fallback:false`,
`bucketDowngraded:false`; frontier route `openai-codex/gpt-5.6-sol`, requested/effective `frontier`,
`fallback:false`, `bucketDowngraded:false`, one successful attempt. A separate Codex response failure
returned HTTP 503 and its recorded circuit remained open until `2026-09-10T11:32:34.244Z`; no
post-expiry frontier retry is claimed and no circuit bypass was attempted.

The actually loaded runtime remains the old generation
`65349a2e7ba29f220971b9d2e58d2763a5c4e479afcecd58d663cf7a1a8e6d72`, with ordinary analytics under
`data/outcomes/8c401ee313ff7786/`. The P6 source commit and all source-only checks did not publish or
activate a runtime. Next work is a bounded contract review and integration decision for the post-P0
candidate, followed by the still-gated P2b/P3/P4/P5 work; do not claim P6 completion, production
capture, live cutover, or restart activation from this checkpoint.

### Checkpoint 9 — post-P0 contract review hold, 2026-09-10

A bounded local review compared the dirty post-P0 candidate with the implementation contract. The
candidate is a coherent future integration direction, but it remains intentionally uncommitted and is
not an accepted P3/P4/P5 milestone. The following gates still require implementation and qualification:

- The recorder does not yet persist the complete detail metadata contract (content/media/encoding/
  completeness/capture-stage/source-version and omission/availability state), and its query seam has
  no byte-range detail response or truncation/coverage metadata.
- Pending-create binding and private deletion are recorder primitives only. The operational close owner
  does not invoke them; the canonical StatsService branch leaves close deletion unwired, and the
  pending-binding/deletion race needs an explicit privacy fixture and cleanup policy.
- Source-sequence reconciliation is stored as a received-sequence projection, but the supervisor
  protocol does not yet acknowledge contiguous fact/detail watermarks or surface capture-incomplete
  evidence through the producer lifecycle.
- Host canonical capture is constructed in legacy mode and the subagent seam currently captures only
  terminal detail; actual provider/tool/execution producers, lifecycle ownership, and replacement query
  consumers remain gated integration work.
- The required engine-selection and production qualification envelope remains open: upgrade and
  semantic fixtures beyond the bounded probe, sustained/light-load and topology comparisons, matched
  analytics-disabled UI/agent baselines, capacity/loss policy, and activation/restart gates.

No candidate source file or `settings.json` was staged or changed during this review. The separate
execution-record update is committed as `13770285` and verified at `origin/master`; the loaded runtime
and old analytics authority remain unchanged. An independent readable reviewer result was not
available, so this hold is based on the local contract review and existing focused/full validation
rather than an acceptance review.
