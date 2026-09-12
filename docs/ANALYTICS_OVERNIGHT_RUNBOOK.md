# Analytics rework: overnight execution runbook

Status: execution in progress, 2026-09-12. The bounded P0 validation/qualification CLI, the durable
worker transport, the inactive recorder/query/capture/read-model sources and the P6 retirement
milestone are implemented, committed and pushed; the dormant production bridge is accepted. The r08
1M result is a scenario-only pass under the 128 MiB recorder heap setting, so full P0 qualification
remains incomplete. The activation helper is still unfinished and unqualified, so analytics/storage
authority remains on the legacy path and no cutover has occurred. Durable progress, current file
ownership and the next ready tasks are recorded in [the execution record](internal/ANALYTICS_REWORK_EXECUTION.md);
resume from its latest checkpoint.

## Goal and authority

Deliver the full analytics/session-storage rework, including live analytics activation, storage
cutoff, supported cache relocation, verification and milestone commits/pushes to `origin/master`.
The user will review afterward, not approve each engineering step overnight. A separate long-lived,
one-shot activation script is permitted to finish after the implementing Pie session closes.

- [Scope plan](ANALYTICS_REWORK_PLAN.md), especially §§1, 11.6 and 17: product requirements,
  independent activation boundaries and execution authorization.
- [Implementation contract](ANALYTICS_IMPLEMENTATION_CONTRACT.md): the **only** field/metric,
  lifecycle/query, task-dependency and performance-gate specification.
- [Experiments](ANALYTICS_EXPERIMENTS.md): corrected evidence, not production qualification.
- `skills/develop-pie/SKILL.md`, `docs/ARCHITECTURE.md` and the owning clauses of
  `docs/STATE_CONTRACT.md`: current implementation invariants and verification conventions.

This runbook owns execution mechanics, not a competing implementation design. Proposed engineering
choices may be settled by the responsible lead with source evidence and tests. Settled product policy
and the explicitly deferred storage-outage/loss policy must not be silently changed.

## Before launching

Use a fresh Pie session with cwd `C:/dev/repos/pie`, on `master`, after the preparation changes have
been pushed. Do not run other editing agents in this checkout overnight. Save editor changes before
the final controlled restart. Keep the machine powered, awake and connected using existing user
settings; do not install wake tasks or change machine-wide power policy as part of this rework.

Restart VS Code normally **before** the overnight run so it starts with the prepared runtime, not an
older loaded host. Ordinary `npm run extension:build` stages a complete runtime; if publication reports
that the startup loader is missing, use the documented one-time `extension:activate` setup. Neither
build success nor opening the sidebar proves the new backend is loaded. The final activation helper
still needs implementation and a separate rehearsal during the overnight work.

### Model and delegation settings

Set these in Pie's existing settings UI before submitting the launch prompt. These are launch
recommendations, not changes made to the user's persisted UI preferences by this preparation session.

| Setting | Overnight choice |
|---|---|
| Main model | GPT-6 Astra, orchestration only; `high` is a reasonable cost-conscious reasoning choice, not a capability requirement |
| Autonomous mode | On; removes `ask_user`, including stale calls, but does not auto-continue finished agents |
| Always use parent model | Off |
| Model buckets | Explicit provider-qualified assignments with supported reasoning; exclude Astra from **every** child bucket |
| Frontier bucket | Existing GPT-5.6 Sol assignments are the configured starting point for difficult integration/ownership leads |
| Medium bucket | Existing GPT-5.6 Luna / GLM-5.3 Flash assignments for normal implementation; retain only models trusted to finish bounded code tasks |
| Small bucket | Cheap, reliable models for mechanical removals/inventories only; not accounting, concurrency or privacy decisions |
| Allowed nested buckets | Small **on**, medium **on**, frontier **on** |
| Buckets allowed to delegate | Frontier **on**; medium and small **off** |
| Maximum depth | **2**: Astra → lead → leaf; no further manager layer |
| Tree session budget | **10**; split the work into fresh root trees instead of raising it for the whole plan |
| Inflight root trees | **2**; this is a process-level root-tree permit, not a cap on all nested editors |
| Route around busy providers / failure fallback | On; preserve provider concurrency and bounded transport/retry settings |
| Dropped child tools | Keep `ask_user` dropped; retain required read/edit/write/bash and lead delegation tools |
| Providers for the new session | Enable the providers required by its buckets, preferably both configured Copilot and Codex routes plus any retained Ollama route |
| History compaction | On, with an explicit available cheaper summary model; do not summarize using Astra by default |

**Observed preparation-session settings:** always-parent is already off, tree budget/inflight are
10/2, medium/small are leaves, routing/fallback are on, and `ask_user` is dropped. However, frontier is
currently **disallowed**, and Copilot/Codex are disabled in subagent-provider defaults unless a
session override enables them. Both need attention for a new overnight session. The current explicit
summary model is Copilot GPT-5.6 Luna at `high`, with 140k/170k token thresholds and 30k recent tokens.
Validate its availability and thresholds against the actual selected context windows; these are
observations of this session, not a promise about a newly opened session.

The nested allowlist applies at child depth **1**, so disallowing frontier also downgrades Astra's
direct frontier requests. Since medium is a leaf, that breaks the proposed lead topology. Bucket
selection uses balanced shuffled cycles, not a quality ranking or a preferred-first fallback list.
Empty/ineligible pools can inherit the active parent model, potentially Astra; configured bucket names
alone are not a cost guarantee. Preflight must verify effective selection, provider eligibility and
thinking support, then inspect returned model/bucket provenance. Do not keep dispatching if unexpected
Astra fallback or a lead downgrade is observed. Use a known eligible cheaper route or complete the
remaining safe work with existing qualified children; never silently accept a costly parent fallback.

Auth is shared, not provisioned by the prompt. Verify existing provider access before leaving the
machine. An authentication/client failure is not a replay-safe transient failover. Do not edit auth,
global VS Code databases or generated model configuration to work around a routing problem.

## Orchestration contract

### Astra is the supervisor, not an implementer

Astra reads this runbook and concise handoff/checkpoint evidence, assigns bounded work, resolves
priority/ownership conflicts, and dispatches follow-up work until the full objective is complete. All
source reconnaissance, design investigation, coding, tests, builds, Git operations and report-file
updates go to subagents. Astra may choose between evidence-backed lead recommendations; it must not
start reading the whole codebase or writing the implementation itself.

Use the existing named agents, not a new general agent framework:

- `worker`, **frontier**, as an engineering lead for exceptional cross-cutting work: capture ownership,
  lifecycle fencing, accounting integration and activation. The lead does the difficult engineering
  and integration itself, delegating concrete independent implementation to medium/small workers.
  It is **not** another pure dispatcher. Supply the approved engineering latitude explicitly so the
  worker's default “report missing material decisions” rule routes issues back to the lead/root,
  rather than leaving the unattended user a question.
- `worker`, **medium**, directly for ordinary bounded work, including independent retirement and
  routine tests/docs. Do not pay for a frontier manager for every file deletion or fix.
- `scout` for bounded read-only discovery when a named uncertainty needs it.
- `reviewer` for independent **code acceptance review** of a settled milestone. This is unrelated to
  the LLM session-evaluation system being removed; preserve `agents/reviewer.md`.

Prefer one active writing lead tree at a time. Its leaves may use at most two concurrent, disjoint
editing assignments; the lead does not edit their files until they return. Independent read-only work
may overlap when it cannot observe a half-written target. Reviews of changed code wait for writers to
settle. Do not run two repository-wide builds, lockfile/install operations, Git writers or scale probes
in parallel. Workers share a filesystem and, within a root, a process; they have isolated transcripts,
not worktrees or process containment.

A fresh root delegation receives a fresh tree budget. Plan roughly one lead plus at most six planned
child sessions, leaving room within ten for review/fix/recovery. Count actual dispatches, including
replacement attempts. On exhaustion, the lead finishes its current safe unit, writes its handoff and
returns; Astra opens a new bounded tree for the remainder. Do not send the entire plan to one
long-lived child and expect its budget or context to reset.

Use native sibling `subagent` calls for independent work and later turns for dependencies. Use explicit
`cwd`, `agent`, `bucket` and a self-contained `task`. Omit `userContext` by default: it copies only
bounded user messages, not the parent's discoveries, decisions or tool outputs. Put the required
context and authority references in the task. Do not invent a model override or per-call reasoning
parameter; the bucket configuration owns both model and reasoning.

### Every delegation must carry

1. Contract task IDs, exact objective and acceptance criteria, owning document sections.
2. Exact allowed files/modules, forbidden overlapping owners, and prerequisite evidence/interfaces.
3. Whether the agent is a lead or a leaf; permitted child count and concurrency.
4. The settled scope and engineering latitude, including relevant nonblocking capture, privacy,
   accounting and lifecycle invariants. Blockers are reported to the parent, not an unattended user.
5. Focused verification commands, evidence/report destination, and whether it owns the Git barrier.
6. Return format: done/not done by criterion, changed paths, checks/results, decisions with evidence,
   remaining failures and exact next action. Keep the parent-facing result approximately 500 words
   or less, linking detailed evidence rather than copying logs or transcripts.

Do not trust a child's “done” without evidence tied to the assigned acceptance criteria. If a child
fails after edits/tool side effects, inspect the actual working tree and durable handoff before a
replacement continues. Never replay its original task blindly or reissue irreversible actions because
an acknowledgement was lost. Runtime failover already avoids unsafe replay; preserve that protection.

## Sequence and durable progress

The implementation contract §5 remains the only task/dependency/acceptance table. Execute it as
bounded milestone waves, splitting further as actual code ownership demands:

1. **Preflight and early risks:** a medium worker records the clean baseline, effective delegation
   policy, runtime/SDK/package versions, loaded/staged identities, disk/RAM headroom and existing
   test failures. Discover the P2c dependency seams and final restart/activation ingress early.
   Then start P1/P2a foundations, the real P0 handoff, and the P2b ownership prototype; independent
   P6 removals need not wait for the engine. Do not do another broad product-planning exercise.
2. **Decide and build:** select the engine from the bounded representative path; freeze the shared
   interfaces. Deliver early durable close/privacy ownership, the P3 recorder, then P4 capture/live
   consumers and P5 queries. Address the real nested-child handoff before optimizing SQL. Keep
   old and new authority activation explicit, not an accidental dual-write during integration.
3. **Complete integration:** finish P2b fencing/retention, P2c reproducible cache seams, remaining P6
   retirement and source coverage. Rehearse the P7 terminal handoff with disposable data before
   relying on it to survive the agent's own shutdown.
4. **Qualify and review:** run selected-design scale/mixed-load probes and the required accounting,
   privacy, lifecycle, package-install and UI tests. Independent reviewers target the high-risk
   boundaries, then workers fix supported in-scope findings. Integrate and push every coherent
   major milestone; do not wait until the end for the first commit.
5. **Activate and verify:** after all relevant gates and the final pre-cutover push, transfer ownership
   to the rehearsed one-shot process. It executes and records P7a then P7b, verifies the loaded new
   runtime and real new-root behavior, and saves/pushes sanitized final evidence. Do not let an
   unrelated later task gate an already independently ready category unnecessarily.

The preflight worker creates `docs/internal/ANALYTICS_REWORK_EXECUTION.md` as the durable, sanitized
execution record. One designated integration/report owner updates it at every handoff/milestone with:

- baseline/current commit and remote push status; task criterion states (`pending`, `in_progress`,
  `verified`, `blocked`, `activated`), exact current file ownership and next ready task;
- settled engineering decisions, schema/API versions, named risks and recovery attempts;
- commands, results, measured conditions, fixture seed/harness revision, sample sizes and report paths;
- built/staged/loaded generation evidence, analytics-generation and storage-cutoff status;
- the terminal helper's ownership/readiness, durable local report location and expected expiry status.

Keep the top checkpoint concise; retain the evidence needed for morning review below it. It is a
maintained delivery record, not a dump of private sessions. Raw logs, mock databases and probe files
stay in a uniquely owned OS-temp directory. Retain concise reproducibility instructions/results in
Git; a disappearing temp file must not be the only proof of a milestone. Durable cutover state belongs
under its operational owner, not OS temp or a second lifecycle registry. No report needed after close
may live solely in the closing session's transcript, sidecars or managed artifacts.

After history compaction, recover from this checkpoint and the owning specifications. An interrupted
child cannot be resumed from an in-memory SDK session; use the checkpoint and inspect actual files.
Astra must continue issuing work after a child's return, including “blocked” returns with remaining
safe options. Do not emit a final answer at a phase boundary, because autonomous mode will not restart
a finished turn. Productive work may continue beyond a nominal overnight window; do not declare
completion just because a time estimate elapsed.

## Verification, resources and safe recovery

- Use root test wrappers. Run focused tests while iterating, `npm test` before a normal milestone
  commit, and final `npm run verify` plus relevant integration/browser/large-detail/performance tests.
  The default affected runner examines working-tree changes: **after milestone commits it may select
  nothing**, so it is not sufficient as the final whole-rework gate. Justify skips individually.
- After `extension/src/` changes run `npm run extension:build` as required by develop-pie. At this
  preparation baseline, `npm run verify` ends in a build with `--no-sync`; it validates but does **not**
  publish the runtime. Run the normal publishing build and check actual staging separately.
- Serialize shared SDK/package changes, builds and tests that mutate shared output. Current host/
  backend bundles remain leased, but reusable extensions can be freshly loaded from source by later
  children. Do not spawn another child through a half-edited subagent/pruner integration. Complete
  and test that seam before new delegations use it. Do not refactor unrelated harness orchestration.
- Synthetic providers and controlled clocks prove deterministic behavior without expensive model
  calls or real retention deletion. Source integration and matched UI/agent baseline measurements
  remain necessary; mock SQL speed is not real producer/teardown proof.
- Pick and record the representative qualification matrix **before** timing it, using contract §6.
  Aim to include the 10M-row history tier if measured disk/time capacity permits. Stream generation,
  estimate total database/WAL/fixture bytes first, keep at least 20 GiB or 20% of initial free disk
  (whichever is larger) unused, and cap temporary probe storage at 16 GiB or 25% of initial free disk
  (whichever is smaller). If those bounds cannot support the planned tier, first reduce duplicate
  temporary copies or use a justified smaller required envelope; name the unqualified larger tier.
  Never fill the disk, shrink rich payload coverage, or label a skipped/failed tier passed.
- The bounded P0 harness accepts only explicit `baseline` (exactly 10,000 rows) and `scale` (exactly
  1,000,000 rows) scenarios. Every invocation must provide a seed and an absolute JSON report path.
  Run its validation-only preflight first; it creates no database or helper and writes `validated` or
  `blocked` evidence while leaving code qualification unqualified:

  ```powershell
  node .\extension\scripts\analytics-p0-qualification.mjs --validate --scenario baseline --rows 10000 --seed p0-baseline-20260911-r01 --report C:\dev\scratch\pie-p0-qualification-20260911-r01\baseline-validation.json
  ```

  After the source/build identity and resource envelope are independently accepted, run baseline
  qualification into the same uniquely owned scratch directory. A scale run additionally requires
  that completed baseline report as matching evidence; do not substitute an old report or omit the
  report paths:

  ```powershell
  node .\extension\scripts\analytics-p0-qualification.mjs --scenario baseline --rows 10000 --seed p0-baseline-20260911-r01 --report C:\dev\scratch\pie-p0-qualification-20260911-r01\baseline.json
  node .\extension\scripts\analytics-p0-qualification.mjs --scenario scale --rows 1000000 --seed p0-scale-20260911-r01 --baseline-report C:\dev\scratch\pie-p0-qualification-20260911-r01\baseline.json --report C:\dev\scratch\pie-p0-qualification-20260911-r01\scale.json
  ```

  Keep reports outside the repository and retain their resolved configuration, matrix, provenance,
  resource and cleanup evidence. A successful bounded scenario does not qualify overall P0: the
  remaining history, endurance/light-load, mixed/fault/version, matched agent/UI and other contract
  gates must remain explicitly unqualified until separately exercised and accepted. Never invoke
  the retired environment-controlled endurance mode.
- Run heavy probes one at a time, account for all host/helper/query RSS, and preserve the contract's
  idle/active resource gates. Use meaningful explicit shell timeouts, typically minutes for tests
  and longer bounded timeouts for scale runs, rather than the current 60-second bash default. A
  separately launched long job needs an owned PID, completion marker, log and safe cancellation.
- On a blocker: inspect its precise cause, try the simplest supported alternative, verify the change,
  and record the result. After repeated failure at the same seam, get a fresh targeted diagnosis or
  raise it to the engineering lead instead of looping identical commands. Continue independent work.
- Do not disable safeguards, bypass an approval by disguising a command, invent credentials, force
  push, discard unowned changes, weaken assertions, or select a destructive outage/overflow policy.
  An unattended permission/auth failure is a real unavailable route, not a prompt to wait on forever.
- A hard safety/qualification gate can block its activation, not all unrelated progress. If no safe
  route remains, push all verified work and record the exact incomplete criterion and attempted
  alternatives. Honesty about an unresolved blocker takes precedence over a false “full cutover”.

There is no dollar cap or wall-clock completion guarantee in this runbook. Cost is controlled by
Astra's small context, qualified non-Astra buckets, bounded fresh trees, leaf policies and concise
handoffs, not a prompt pretending to enforce a billing limit. Pie has no subagent wall-clock watchdog
and no automatic backend restart; provider/transport retries do not recover every stalled tool or a
failed root session. Bounded commands and durable checkpoints reduce this risk but cannot eliminate it.

## Git and terminal activation barriers

Only the designated integrator writes Git. At a milestone, wait for assigned editors to finish,
inspect status/diff, run the required checks, stage only task-owned source/docs/tests/lockfile changes,
commit descriptively, and push `origin master` without force. Verify the remote commit. Do not stash,
reset, switch branches or create worktrees to hide concurrent changes. If an unexpected writer changes
the checkout, preserve its work and isolate the conflict; do not bundle it blindly. Retry transient
push failures while independent work continues, but keep the unpushed status explicit.

Prepare a commit-identifiable, rehearsed activation artifact and its handoff receipt **before** ending
the agent session. The process must not depend on the parent's stdio, worker lifetime, another agent
turn, an uncommitted moving script, or live edits to a loaded bundle. It owns only the finite approved
cutover and report. Verify it can continue on parent exit and can recover interrupted phases
idempotently. Do not hold it waiting for an approval the user has already provided in scope plan §17.

At the terminal boundary, stop new affected admission and coordinate triggers through their existing
owner, settle/stop work using normal lifecycle boundaries, confirm old writers are gone/fenced, and
perform the separate approved activations. A hide, sleep or timeout is not proof of closure/process
exit. Preserve unsaved editor work; no force-kill of the entire VS Code process tree. If the chosen
restart mechanism cannot preserve those guarantees, choose another supported quiet restart path or
report the exact gate rather than pretending staged code is loaded. The helper may finish the final
sanitized evidence commit/push once it is the sole Git writer and tests/activation actually passed.

Post-activation evidence must distinguish: source committed, build staged, host/backend loaded,
analytics generation active, storage cutoff committed, new writes using the final root, privacy and
query/live behavior verified, cache seams activated, and ordinary cleanup pending. The actual
24-hour deadlines must not be shortened; clock-controlled tests stand in for waiting a day, not for
claiming old files are already physically removed. Do not roll back durable deletion or closure facts
if a post-activation smoke fails. Finish with an exact recovery/status report, not a success marker
written before the irreversible work.

## Copy-paste launch prompt

```text
Execute the complete analytics/session-storage rework in C:/dev/repos/pie, following
C:/dev/repos/pie/docs/ANALYTICS_OVERNIGHT_RUNBOOK.md and its owning specifications.
Read the runbook first. This is an execution request, not another planning session.

I authorize full implementation, tests, required reproducible dependency changes, both
separately gated live cutovers, and a tested long-lived one-shot activation/report process
that survives this session closing and performs a controlled restart. Scope plan §17
records the authorization and its limits. Commit and push each coherent verified major
milestone to origin/master, including final sanitized activation evidence. No worktrees,
force pushes, blanket legacy-data deletion, or shortened 24-hour retention deadlines.

You are GPT-6 Astra acting only as supervisor. Delegate all reconnaissance, engineering,
implementation, testing, Git operations and file-based reporting. Use fresh bounded frontier
worker leads for the difficult capture/accounting/lifecycle/activation work, medium workers
for ordinary implementation, and independent reviewer agents at meaningful gates. Leads
must do the hard engineering and integration, not merely add another delegation layer.
Use cheaper leaves, explicit file ownership, at most two concurrent disjoint editors, and
the existing ten-session tree budget. Never use Astra as a worker or silently accept
parent-model fallback. Follow the runbook's settings/provenance preflight before dispatching
substantial work; do not assume a requested frontier bucket actually ran as frontier.

Have the preflight/integration worker maintain
C:/dev/repos/pie/docs/internal/ANALYTICS_REWORK_EXECUTION.md as the durable checkpoint and
morning review record. Keep your own context and child handoffs concise. Recover from that
record after compaction or child failure, inspecting actual work before any retry.

Do not stop at the first blocker, after a child returns, or after a milestone. Resolve
engineering choices from the approved defaults and evidence, try safe supported alternatives,
and continue every independent task. Do not ask an unattended user questions. Do not weaken
requirements, fabricate evidence, bypass safeguards or turn deferred outage policy into an
invented data-loss rule. A failed gate requires repair or an honest incomplete status,
not a false success. Exhaust safe recovery paths before concluding anything cannot finish.

Continue until all agreed work and verification are complete and live cutover has either
been verified or its remaining terminal steps have been durably accepted by the rehearsed
independent activation process. Never end merely because code builds or is staged. That
process must finish and record post-restart evidence without expecting another turn from
this closing session. The final record must identify commits/push status, actual loaded
and activated state, expected delayed expiry, and any genuinely unresolved acceptance gate.
Begin by delegating the bounded preflight, then execute the full dependency graph.
```
