# Pie analytics/session-storage rework handoff

Date: 2026-09-13. This is a stocktake for the next owner, not a completion
claim. The full rework remains incomplete and the P7 analytics/storage
activation gates remain closed.

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

Remaining main work: tool/file facet metrics and query/live activity consumers; remaining
rich producer/handoff coverage; P0 resource/scale and matched UI evidence; actual-host P2c
cache-use evidence; final P7 ordered activation/cutoff orchestration. No activation or
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
