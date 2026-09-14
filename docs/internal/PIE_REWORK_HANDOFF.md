# Pie analytics/session-storage rework handoff

Date: 2026-09-13. This is a stocktake for the next owner, not a completion
claim. The full rework remains incomplete and the P7 analytics/storage
activation gates remain closed.

## P4 integration checkpoint - 2026-09-14, 13:30 Pacific/Auckland

The current task authority supersedes the 09:23 provisional schedule: feature freeze is hard at
15:00, this integration deadline is 15:15, children/jobs settle by 16:15, and no task operations
continue after 16:30. Actual startup clock was 13:25:03 NZST; no branch switch, stash, reset,
worktree, force-push, restart, activation, or cutoff was performed.

Baseline remains HEAD `8c76ddc9f584424f364669060c94c0037149dfdb`. This milestone integrates the
reviewed P4 root-session host/protocol/UI activity-and-facet exposure plus the rich handoff test.
The exact source/test/report scope is: `docs/STATE_CONTRACT.md`; `extension/src/host/core/projection.ts`,
`extension/src/host/extension-host.ts`, `extension/src/shared/protocol/webview.ts`; the eight
webview files `extension/src/webview/panel/app-body.tsx`, `bottom-section.tsx`,
`composer/session-cost-tooltip.tsx`, `composer/toolbar.tsx`,
`composer/use-composer-indicators.ts`, `session-tabs/token-usage.ts`, `state-validator.ts`,
`ui.tsx`; the five extension tests `extension/test/host/core/state/projection-draft.test.ts`,
`extension/test/webview/components/state-validator.test.ts`,
`extension/test/webview/composer/composer-bottom-bar.test.ts`,
`extension/test/webview/composer/session-cost-tooltip.test.ts`,
`extension/test/webview/session-tabs/canonical-activity-summary.test.ts`; and
`extensions/subagent/test/p4-production-bridge-sqlite.test.ts`. The durable reports are this file
and `docs/internal/ANALYTICS_REWORK_EXECUTION.md`. The unrelated pending files
`models.yaml`, `models.json`, `model-profiles.yaml`, `settings.json`, and
`docs/internal/model-token-pricing-sources.md` remain excluded and untouched.

Before-commit validation: `npm test` passed 4,204/4,219 tests, 15 skipped, zero failed, four of
four package groups (`C:/dev/scratch/pie-daytime-20260914-r01/integration/npm-test-beforecommit.log`).
`npm run extension:build` passed, publishing renderer/build ID `77cfc0031589f15d1760` and staging
immutable runtime generation
`d7afd53dd4a5d8978af279f4544341f27af20d63ac98d805fa948bc129c7bb36`. Independent verification
confirmed the selected staged manifest/content and matching host/renderer IDs across 50 files
(`integration/extension-build.log`, `integration/staged-integrity.log`). The staged generation is
for the next normal startup; PID 15424's separately rechecked backend commandline still loads
`3335b51944ac1a55b7740dab97c05d8e532a865e535d70453fa7850fda7c0308`. No manual or Playwright
verification is claimed. Full post-commit `npm run verify` remains next.

Do not qualify or transfer the latest mixed result: `C:/dev/scratch/pie-p0-mixed-20260914-r02/production-default.json`
reports functional mixed/query coverage 16/16, but overall P0 is unqualified because sampled
recorder high-water RSS is `286224384` bytes versus the `268435456`-byte gate. The actual peak was
already after the burst; `detail-refresh` is a label only, not a causal allocation claim. P2c has
only existing MCP cache mtime/event correlation, not writer-PID/read-use proof; the web cache is
empty and the actual-host gate is unverified. Candidate validation is unavailable, selected-branch
activity is blocked by missing full producer branch attribution, UI evidence is root/all-branches
only, and real SDK nested/cancel/failover coverage is absent. P7 activation/storage gates remain
closed.

Continuation: complete post-commit verification, then at a normal future restart manually check the
staged runtime; separately obtain qualified P0 resource/scale and actual-host P2c evidence, full
producer branch attribution, real SDK nested/cancel/failover coverage, and ordered P7 admission.
This handoff never claims full rework completion.

---

## Preflight checkpoint - 2026-09-14, 09:23 Pacific/Auckland

That preflight recorded a provisional 16:30 hard deadline; the current authority above supersedes
it with feature freeze 15:00, integration deadline 15:15, children/jobs settle 16:15, and no task
operations after 16:30.
Ownership: fresh parent worker PID 22812 with backend PID 15424 (Win32_Process commandline
evidence, both from runtime generation
`3335b51944ac1a55b7740dab97c05d8e532a865e535d70453fa7850fda7c0308`); prior editing session
`01a09c95` last wrote 09:03:57, before the fresh parent `01a09c98` opened 09:07:32 — no overlap.
Loaded backend runtime `3335b51944ac…` confirmed from the backend process commandline only;
loaded/manual behavior remains unverified. No activation, restart or cutoff performed.
Baseline HEAD `8c76ddc9` with exactly five pending user files (`models.yaml`, `models.json`,
`model-profiles.yaml`, `settings.json`, `docs/internal/model-token-pricing-sources.md`) preserved
and excluded from all child tasks. Pending gates: P0 qualification incomplete (recorder RSS
exceeds 256 MiB; P2c actual-host cache use unproven), production candidate-trial validator
unavailable, P7 analytics/storage activation gates closed. Delegation evidence: last subagent
return (parent session, 21:20:32Z) was scout on `ollama/glm-5.3-flash:cloud`, medium, thinking
`max`; routing: Astra orchestration only, no Astra children; next safe child route is
openai-codex `gpt-5.6-luna` (`eligible: true`, xhigh/max, `model-profiles.yaml` lines 218-232);
Copilot `gpt-5.6-luna` stays subagent-ineligible.

---

## Current implementation milestone (2026-09-13)

The user restarted VS Code and reported the normal reply, tool call, cancellation,
and privacy-enabled session-close smoke checks completed successfully. Backend
startup evidence identifies runtime `8ff7365a67f86d8a937ce6067c533752fbb9fd6a2776ca207b73e33699143914`.
Later builds remain separately staged; these smoke checks do not verify them.

Completed source units since recovery:
- Retry and tool durations use explicitly marked same-process monotonic measurements,
  with real wall anchors retained separately. Missing recovered tool timing stays unknown.
  Existing tool wall-union accounting is preserved, not replaced with parallel-group maxima.
- Schema-12 activity projection was independently implemented and reviewed against all
  six quarantined findings. Tests cover ownership/order, monotonic evidence, scoped
  unknowns, schema-11 migration, transactional/resumable deletion, and leading indexes.
  A deletion-key collision for activity kinds containing NUL was corrected and tested.
  The quarantined backup was not blindly restored. This is source integration, not P0 qualification.
- Authenticated all-host writer-fence primitives now have production host/backend/worker
  wiring. Actual SessionManager fences revoke admission and drain active mutations before
  acknowledgement, including retired managers. The final storage-cutoff orchestrator is
  still incomplete and disabled: authoritative census, deletion adapter, durable receipt
  orchestration and production authorization remain explicit next work.

Further integrated units: schema-13 typed tool/file facets with explicitly unverified
attempted-change proxies, subject deletion and migration; bounded activity/facet query
worker APIs; guarded resumable analytics cutover orchestration, actual process-birth
census and authenticated production adapters, read-only helper preflight, dynamic
restart-host key lookup and crash-resume timestamp binding. Legacy restart environment
now includes the receipt path required by the new runtime. Production activation still
fails closed: the authoritative candidate-trial validator is unavailable. Storage-cutoff
production entry and actual terminal restart proof remain unfinished. G1-to-G2 replacement
is explicitly refused, not silently performed.

Latest integration (before midnight Auckland, 2026-09-14): all three affected test
packages passed; extension 4,884 passed, 19 skipped, no failures. Typecheck/lint passed.
Build `8b06e0475cacde8cc45f` staged runtime
`d4db74edde73906e068f632d7e411c54e3004f437b702c6bb038b9d9e2b54570`.
Loaded host behavior is still only verified for the earlier user-tested generation.
Logs: OS-temp `pie-overnight-milestone-XxwO95/{test,build}.log`.

The user requested sustained overnight work, feature work stopping by 03:00 and stability
by 07:00 on 2026-09-14 Pacific/Auckland. Morning usability takes priority: defer incomplete
features, preserve live sessions, and do not activate/cut over without proven gates.

Additional reviewed source: StatsService now hydrates bounded, revision-fenced activity
and facet read models (service accessors only, not UI/branch integration). Recorder capture
avoids duplicate envelope/array/JSON allocations; contended lock retries share a bounded
20-second worker budget, with intact-batch replay if the supervisor deadline wins.
Exhausted-lock recovery tests were updated and pass. Resource collection now combines
runtime and identity-bound native terminal receipts, covering forced-cancellation workers.

Production-default mixed probe `pie-p0-mixed-20260914-r01/p0-qualification.json` in OS temp
was functionally passed but remains P0-unqualified: recorder RSS 270,524,416 bytes exceeds
268,435,456. Query-worker topology coverage was 16/16 via runtime/native evidence union.
This measured result precedes the subsequent allocation reductions; do not infer a memory
pass from those code changes. Actual-host P2c cache use remains unproven (startup path
and older cache files are not causal evidence). No live activation is authorized by these
results. Remaining qualifications will not be forced to meet the morning deadline.

Latest stability check: focused recorder/collector tests 53 passed; affected extension
4,892 passed, 19 skipped, zero failures. Typecheck/lint/build passed. Build
`fecd8274163d41c31ca8` staged runtime
`3335b51944ac1a55b7740dab97c05d8e532a865e535d70453fa7850fda7c0308`.
Logs: OS-temp `pie-stability-0200-8GB8vE/`. Source remains inactive behind existing gates.

Remaining main work: live UI/branch-specific activity integration; remaining rich producer/handoff coverage;
P0 resource/scale and matched UI evidence; actual-host P2c cache-use evidence; final P7
qualification authority and ordered activation/cutoff execution. No activation or
storage cutoff has occurred. Cosmetic cleanup is deferred per user priority. Commit and
push verified milestones as work proceeds; exclude unrelated model/settings/pricing edits.

## Earlier continuation checkpoint: retry clock repair (2026-09-13)

One bounded P4 unit is implemented in the working tree, not committed or pushed.
Retry wait and episode durations now use same-process `performance.now()` samples;
wall timestamps remain correlation anchors. An optional `durationClockDomain`
marker travels through the existing retry event into canonical capture. Explicitly
monotonic measurements survive reversed or missing wall bounds. Legacy unmarked
wall-derived evidence retains its prior qualification, and partial sample fallback
uses one consistent wall domain rather than mixing clocks. The existing first
provider-attempt/gate observation boundary is unchanged; retry wait does not add
provider queue occupancy. No schema migration or quarantined activity code was used.

Real backend wall-jump, partial-sample fallback, capture, forwarding and protocol
validation regressions pass. Root `npm test` passed all three selected packages
(extension: 4,830 passed, 19 skipped, zero failures); typecheck and lint passed.
Logs: OS-temp `pie-retry-clock-020iVO/npm-test.log` and `extension-build.log`.

The required source build staged a newer immutable runtime
`8ff7365a67f86d8a937ce6067c533752fbb9fd6a2776ca207b73e33699143914`
and published coordinated host/renderer build `fcea2f669722da9b52a6`. This now
supersedes the recovery selection below for the next normal VS Code startup.
Loaded host identity and manual turn/tool/cancel/private-close behavior remain
unverified. No restart, analytics activation, storage cutoff or authority switch
was performed. P0 and P7 gates remain closed. The remaining activity/tool/file
metrics and the quarantined projection's six findings are not resolved by this unit.

Unrelated model/settings edits remain untouched. An additional concurrent change
to `docs/internal/model-token-pricing-sources.md` appeared during verification and
was also left untouched. Next: manual runtime sanity check at the user's convenience,
then one bounded remaining producer or metric unit, not a wholesale schema-12 restore.

## Prior recovery release state

The reviewed recovery commit is
`77b0526865efbe0d8aaa4044a9655797c628d0da`, pushed to `origin/master`. It
contains the stable opened-session identity repair, duplicate/ambiguous
all-host census rejection, and the execution checkpoint. The four pending
user configuration files (`model-profiles.yaml`, `models.json`, `models.yaml`,
`settings.json`) remain dirty and were not staged. No lockfile was changed.

`npm.cmd run extension:build` completed with exit code 0. The host and renderer
share build ID `0d5f8c46e992ba622290`. The installed extension has staged runtime
generation
`87aefd4741c794e1c7287161a105ca4af5652f5f3d4610669846ba3ad6f4bd47` and
renderer generation `0d5f8c46e992ba622290`; 33/33 installed Node bundles match
the build and the renderer manifest verifies. These generations are selected
for the next VS Code startup. The currently loaded generation is unverified;
running sessions may still be using their prior loaded generation. No restart,
canonical activation, storage cutoff, or authority switch was performed.

Validation for this recovery was 79 targeted tests passed, with zero failures
or cancellations, plus extension typecheck and lint. Prior broader evidence
covered 4,823 passing tests, zero failures, and 19 skips within its recorded
scope. The build and release evidence is in
`C:\dev\scratch\pie-deferred-activity-20260913-r01\release-build-receipt.json`.

## What is integrated and what is not

The integrated milestone includes the schema-11 recorder/query and migration
work, canonical capture and accounting/read-model paths, startup/runtime
identity checks, and the reviewed session metadata and handoff census repairs.
It supports bounded canonical reads and durable generation/build identity.

The unfinished schema-12 activity projection was deliberately removed from
the candidate after review found six defects:

- subject/root ownership changes with arrival order, risking deletion of the
  wrong subject;
- valid monotonic tool and retry durations can be discarded;
- global unknown counts can contaminate scoped coverage;
- migration fabricates wall-clock times and collapses states, losing late
  evidence;
- activity removal after a published revision is neither transactional nor
  resumable; and
- root deletion lacks a leading index and falls back to a full history scan.

Its exact files and binary diff are preserved under
`C:\dev\scratch\pie-deferred-activity-20260913-r01` (`receipt.json` and
`activity.diff`). The backup may include an interrupted partial fix; review it
against the current contract before applying anything. Schema 12 is not
released.

Substantial work remains: P3/P4 producer and off-path rich handoff coverage,
missing activity/file/tool/working-time metrics, P0-qualified workloads and
resource evidence, P7 all-host authentication/writer fencing and the ordered
analytics activation/storage cutoff, and the P2c supported package-cache
proof. The pinned MCP/web package scratch cache probe passed for the installed
versions; its receipt is
`C:\dev\scratch\pie-managed-p2c-proof-20260913-r01\result.json`. Only
actual-host load/cache-use proof remains. P6 standalone
dashboard/reviewer retirement is largely implemented, so no new dashboard or
export pipeline is required. The mixed functional run was scenario-passed but
remained overall
P0-unqualified: recorder high-water RSS exceeded 256 MiB and native worker
coverage was incomplete. Do not promote that report to qualification.

The only canonical UI evidence rendered a text reply but stayed in
"responding" with the red stop control; later sends were disabled and no
provider calls were observed. The stable SDK session-ID defect is fixed in
`77b05268`, but the UI was not rerun. Do not claim the new runtime is loaded or
Pie is already usable; the user will perform the manual check.

## Ordered next work

1. Preserve this staged recovery build. After the user chooses a convenient
   restart, manually sanity-check one normal turn, one tool turn, cancellation,
   and an open/private-close session. Record loaded build/generation separately
   from the on-disk selection.
2. Give one fresh Luna implementation lane one bounded defect or metric unit
   at a time. Keep the activity backup quarantined until its six findings are
   resolved against the contract.
3. Run focused tests and typecheck for each unit, then one comprehensive
   milestone check. Avoid repeating a whole historical audit or rereading
   thousands of lines when a scoped source/test check answers the question.
4. Only after the documented qualification and P7 handoff/fencing gates pass
   consider the separately ordered activations. Never infer activation from a
   successful build or staged selection.

Authoritative references: [implementation contract](../ANALYTICS_IMPLEMENTATION_CONTRACT.md),
[rework plan](../ANALYTICS_REWORK_PLAN.md), [overnight runbook](../ANALYTICS_OVERNIGHT_RUNBOOK.md),
and [execution record](ANALYTICS_REWORK_EXECUTION.md).
