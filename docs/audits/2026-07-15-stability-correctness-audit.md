# Stability and correctness audit — 2026-07-15

## Executive summary

This audit found and fixed multiple independently reproducible liveness and
state-convergence defects across the backend runtime, provider gate,
host-to-webview delivery, transcript commit protocol, diagnostics, subagent
cleanup, and repository verification gates. The most consequential fixes:

- locally bounded provider-header and stuck-abort handling no longer leaves UI
  or concurrency ownership hostage to an abort-ignoring upstream;
- replacement runtimes and interrupt/semantic watchdogs now have single-owner
  recovery semantics;
- stale/terminal live checkpoints cannot overwrite newer authority or resurrect
  completed turns;
- provider circuit, account-pause, active permits, queues, and afterburn holds
  survive live reconfiguration, including cap shrink/grow and half-open races;
- rejected sends restore their draft/input state and re-enter readiness recovery
  without attaching background-session inputs to the active composer;
- diagnostic boundaries redact recognizable credentials before persistence,
  stderr-tail propagation, or webview projection;
- subagent cancellation and post-create setup failures release sessions and
  root permits exactly once;
- large valid live turns are no longer blocked by a 512-leaf transcript-commit
  cap, and composer indicators cannot reuse a prior session's memoized values.

The first pushed whole-repository checkpoint at `c4a5883` passed model
generation, all 14 configured TypeScript projects, lint, 15 package suites
(4,410 passed, 0 failed, 4 skipped), and the production extension build with
`--no-sync`. Final independent review then found and closed additional
provider, terminal-UI, chunk-redaction, subagent-proxy, and verification-map
races through implementation checkpoint `c9a5d3d`. The first four post-review
commits each passed the expanded 15-package hook (4,427 passed, 0 failed, 4
skipped); the shutdown follow-up passed its selected extension and subagent
suites (3,193 passed, 0 failed, 1 skipped).
A sequential real-provider smoke using `umans/umans-glm-5.2` also returned the
expected response in 23.4 seconds.

This evidence does **not** justify claiming that every long-running in-process
operation is quarantined or that pie is fully ready for unattended real work.
The highest residual risks are generation-unfenced SDK writes/side effects from
retired runtimes, incomplete subagent retry/orphan controls, and the absence of
real-browser end-to-end paint/interaction testing (VS Code manipulation was
prohibited during this audit).

## Initial repository and verification state

- Target: `C:\Users\OwanLazic\Documents\GitHub\pie`.
- The workspace and repository `AGENTS.md`, all required architecture/state/
  operational docs, and the relevant bundled pi SDK docs were read before
  changes in their areas.
- `master` contained two unpublished commits plus 32 files of legitimate
  analytics, model-catalog, and run-analytics work (2,075 insertions, 48
  deletions). It was inspected for secrets/runtime data and committed as the
  pre-audit safety checkpoint `ec1d826`, then pushed.
- The existing pre-push build could synchronize into the installed extension.
  `84869cb` made that hook explicitly use the isolated `--no-sync` build and
  added a regression test before the audit branch was created.
- Audit branch: `audit/overnight-stability-20260715`, pushed without force.
- Initial safety checks included `git diff --check` and
  `npm run sync-models -- --check`; generated model files matched
  `models.yaml`.

## Architecture and data-flow map

### Message and transcript path

```text
webview optimistic command
  -> host message router -> pure command reducer -> centralized effect runner
  -> backend JSONL RPC client -> backend request handler -> pi SDK/provider gate
  -> session event handler -> sequenced live envelope/checkpoint
  -> host backend event dispatch -> LivePipelineState reducer/repair
  -> durable + live projection -> state delivery controller
  -> webview readiness/host-sync -> virtual transcript renderer
  -> renderer-owned commit evidence -> host commit/paint acknowledgement
```

`LivePipelineState` remains the sole live transcript authority. Durable session
history and live state are projected together; generations, revisions,
sequence numbers, terminal watermarks, and renderer-owned evidence prevent
older work from acknowledging or replacing newer state.

### Backend lifecycle path

```text
extension activation -> backend spawn/generation -> readiness handshake
  -> request registry + JSONL stdout/stderr transport
  -> session runtime/context -> SDK subscriptions/provider request
  -> exit/error classification -> pending rejection + affected-session repair
  -> local interruption materialization -> replacement runtime -> cleanup
```

The host owns pending RPC and optimistic reconciliation. The backend owns SDK
session runtimes and replacement. Recovery must be single-owner because two
replacement constructors for the same session path can otherwise dispose an
already-authoritative runtime.

### Provider and subagent path

Provider admission is centralized in `ProviderGate`: account pause and
transport circuit checks precede a priority/FIFO concurrency pool; header and
body liveness controls release the exact slot; live reconfiguration mutates the
same pool authority. Subagents run as fresh **in-process** SDK sessions. They
have isolated transcript/context state, but share process, filesystem, auth,
extensions, and external side-effect authority with the parent.

## Findings and resolutions

| ID | Severity | Subsystem | Evidence / root cause | Resolution and evidence | Commit | Residual risk |
|---|---|---|---|---|---|---|
| INF-01 | P1 | Build safety | Pre-push used the syncing extension build, which could modify the active installed extension. | Hook uses `--no-sync`; safety test pins the command. | `84869cb` | Manual installed-extension validation intentionally omitted. |
| INF-02 | P1 | Verification | Script tests and generated-model safety were not first-class changed-file/pre-commit gates; focused script tests used an inconsistent cwd; most root maintenance scripts selected no tests. | Added package/generation gates, flake characterization, repo-root focused execution, and mapping of supported root `scripts/*.mjs` changes to the scripts suite. | `b27b3b9`, `befdd85`, `a6e0de2`, `02aef45` | Subagent is still absent from the configured TypeScript project list; see REM-05. |
| BE-01 | P0 | Provider headers | Header timeout depended on upstream honoring abort, so a fetch could retain a slot forever. | Local promise settlement and exact release; deterministic abort-ignoring fetch tests. | `1418579` | An in-process upstream may still continue external work after local settlement. |
| BE-02 | P0 | Runtime recovery | Semantic timeout retired UI events but reused/stalled the same runtime. | Stuck contexts are fenced and replaced; sends wait for authoritative recovery. | `fb0517a`, `5daf3a2` | SDK persistence/external effects from the retired runtime are not generation-fenced; see REM-01. |
| BE-03 | P1 | Recovery race | Interrupt checked recovery only before awaiting abort; semantic recovery could start during that await and both watchdogs would replace the runtime. | Revalidate ownership after the abort race; deterministic delayed-abort race test. | `42d7386` | Recovery construction remains split across call sites rather than one server `ensureRecovery` primitive. |
| BE-04 | P2 | Extension UI | `cancelAll()` settled existing dialogs but a retired runtime could emit new late dialogs/notices. | Permanent bridge `dispose()` fence at replacement, semantic/interrupt retirement, and shutdown; normal Stop keeps reusable cancellation. | `e99d8b4` | This fences UI requests, not arbitrary SDK/tool external side effects. |
| PG-01 | P1 | Transport circuit | Ordinary connect failures were not counted; 5xx half-open responses could close a circuit; queued requests did not always revalidate. | Count pre-header failures, reopen on retryable 5xx, and revalidate after queue admission. | `eff240d` | The gate deliberately does not replay responses; SDK retry policy remains separate. |
| PG-02 | P1 | Live reconfiguration | Rebuilding `ProviderPool` discarded active/queued accounting, account pause, and afterburn ownership. | Mutate the same pool; preserve state; drain cap shrink, wake cap growth/hold expiry, retain pause. | `b71bb3d` | Removing then re-adding an entire provider generation while old calls remain is not migrated. |
| PG-03 | P1 | Half-open ownership | Boolean probe ownership let a stale cancellation release a newer probe. | Monotonic probe tokens; only the owning attempt may clear/close. | `b71bb3d` | No blind replay is attempted after partial output, by design. |
| PG-04 | P2 | Body cancellation | Caller abort after headers could retain the slot until body read/idle timeout. | Caller signal fences/cancels the reader and releases synchronously without provider-failure accounting. | `b71bb3d` | Abort-ignoring upstream body work can outlive the local wrapper. |
| PG-05 | P1 | Pause/teardown races | A stale concurrent success could clear a newer account suspension; 429/403 inspection could wait forever after headers; removing a provider or shutting down the server left timers/waiters; the first abort fix did not cancel both cloned response branches. | Generation-bound pause clearing, 1 MiB bounded/abortable inspection with both branches cancelled on caller abort, idempotent pool disposal, and production `BackendServer.dispose()` teardown. | `7898042`, `c9a5d3d` | Local cancellation cannot guarantee termination of arbitrary work outside the fetch stream. |
| TR-01 | P0 | Live checkpoints | Equal/older checkpoints and late terminal repair could overwrite newer live authority. | Monotonic checkpoint acceptance, tombstones, and terminal guards. | `27fc019`, `2d4c5a2` | Real webview/VS Code paint behavior remains manually untested. |
| TR-02 | P1 | Transcript commit | The registry silently rejected leaves above 512 even though valid live tool history is unbounded by contract. | Remove leaf cap; retain the pure 600-tool decision case and add a mounted-provider characterization proving all 601 accepted leaves traverse `reportLeaf`. | `64aa65d`, `7a0a775` | A future aggregate proof should remain renderer-owned and revision-bound. |
| UI-01 | P1 | Send recovery | Post-ack/preflight failure could lose draft inputs or leave readiness recovery idle; background inputs could attach to the active composer. | Lossless promoted rollback, imperative readiness retry, session-scoped drafts/inputs; contract tests/docs. | `9725286` | None known in characterized paths. |
| UI-02 | P1 | Indicators | Transcript-derived memo signatures omitted session identity, so equal-shaped tabs could show stale cost/context values. | Key every transcript-derived memo by `sessionPath`; equal-shape switch test. | `c4a5883` | Recursive large subagent payload scans remain a performance risk; see REM-04. |
| UI-03 | P1 | Live cost | Canonical context footprint combines uncached/cache channels but was priced entirely at the uncached input rate; a live model with no pricing was displayed as a known `$0.00`. | Keep live context tokens unclassified, price only known output, and render unpriced live usage as unavailable rather than zero; distinct-rate and no-pricing tests cover label, tooltip, and ARIA. | `2840e69`, `7a0a775` | The exact live total remains unknown until provider channel usage arrives. |
| UI-04 | P2 | Auto-follow | Settled bottom-follow scheduled another rAF before checking zero delta, retaining a no-op 60 Hz callback. | Quiesce at target; transcript, virtual-size, session, and resize signals restart it; empty-queue/resize tests. | `326c757` | Real-browser frame/paint impact is not measured. |
| UI-05 | P1 | Terminal extension UI | Direct semantic `turn.terminal` committed durable state but did not clear its session's pending extension dialog; replayed terminal events had the same gap. | Every committed semantic terminal now clears pending extension-UI requests, with direct and repair-path coverage. | `7a0a775` | A dialog already rendered by an unresponsive webview still depends on the next state delivery. |
| SEC-01 | P1 | Diagnostics | Log messages, nested string values, stderr tails, dropped-line reasons, and raw notices could carry credentials; per-chunk stderr redaction leaked suffixes when a label/value straddled chunks. | Shared redactor at persistence/transport/webview boundaries; stderr now buffers bounded raw bytes and redacts only complete log/diagnostic boundaries; every byte split of a labeled credential is characterized. | `94de53a`, `7a0a775` | Redaction is pattern-based; arbitrary secrets without recognizable context cannot be guaranteed. |
| SA-01 | P0 | Subagent admission | An already-aborted child acquired with no signal and could wait forever behind the process cap. | Pass the aborted signal; saturated-cap test proves prompt local settlement and no session creation. | `fa2621b` | Late session creation after a separate pre-spawn abort race remains orphanable; see REM-02. |
| SA-02 | P0 | Subagent cleanup | Exceptions after session creation but before prompt `try/finally` leaked session and root permit. | Single exact-once cleanup owner established immediately after creation; `setUIContext` and subscribe failures each tested with capacity-one follow-up. | `fa2621b` | Upstream loader has no reliable disposal API; listener reclamation remains heuristic. |
| SA-03 | P1 | Attempt ownership | No-op unsubscribe and trailing throttled callbacks let a failed attempt mutate/publish after retry or terminal cleanup. | Close attempt emitter, fence every subscription callback before teardown, and cancel parent UI proxy in final cleanup. | `f8c9cd8` | In-process upstream side effects remain outside the local fence. |
| SA-04 | P1 | Retired UI proxy | The SDK or an extension could retain a child UI proxy after terminal cleanup and use it to create a new parent dialog after the one-shot cancellation. | Attempt cleanup permanently disposes the proxy; captured post-terminal select/input/confirm/notify calls are fenced while active nested identity forwarding remains covered. | `2431f71` | This fences extension UI only, not arbitrary retained SDK/tool callbacks. |

## Provider-resilience matrix

| Scenario | Automated evidence | Current behavior | Status |
|---|---|---|---|
| Connect/DNS/reset before headers | Deterministic rejected fetch | Counts toward shared transport circuit; slot exact-release | Passed |
| Headers never arrive; abort ignored | Local header-deadline tests | Locally rejects/releases without awaiting upstream | Passed |
| Repeated failure opens circuit | Fake clock/fetch | Locally blocks until cooldown | Passed |
| Half-open success/failure | Controlled probes | One token-owned probe; success closes, 5xx/failure reopens | Passed |
| 429 account suspension | Controlled response/body | Arms account pause; survives reconfiguration | Passed |
| Concurrent stale success after suspension | Two controlled in-flight responses | Older success cannot clear newer pause generation | Passed |
| Ordinary transient 429 | Controlled response | Does not misclassify as account suspension | Passed |
| 429 headers with stalled inspection body | Stalling body + caller abort | Inspection is bounded/abortable and releases the slot | Passed |
| Retry hint parsing/backoff | Provider gate and SDK are separate | No central replay; subagent-specific bounded `Retry-After` is not implemented | Open |
| Stalled response body | Idle watchdog | Errors stream and releases slot | Passed |
| Caller abort before/after headers | Controlled abort | Releases promptly; cancellation is not provider failure | Passed |
| Queue expiry and queued abort | Controlled queue | Bounded rejection/removal | Passed |
| Reconfigure with active/queued work | Cap 1/2 controlled fetches | Same pool authority, no over-admission; shrink drains/grow wakes | Passed |
| Afterburn expiry | Controlled hold and waiter | Earliest-expiry timer wakes eligible waiter | Passed |
| Provider removal/uninstall with queued waiter | Held slot + unbounded waiter | Disposal clears wake timer and rejects waiter locally | Passed |
| Backend production disposal with queued waiter | `BackendServer.dispose()` integration | Uninstalls global gate, restores fetch, rejects waiter | Passed |
| Outage then recovery | Fake clock circuit probes | Half-open recovery restores normal admission | Passed |
| Productive >15 simulated minutes | Required fake-clock control absent | Not proven | Open |
| Real Umans compatibility | One sequential ephemeral smoke | `umans-glm-5.2`, thinking off, exact response, 23.4 s | Passed (single smoke) |

The real smoke was not a resilience/load test and did not deliberately induce
an outage. No prompt was replayed after visible output or tool activity.

## Transcript and UI convergence

- Stale backend generations are rejected by the client/host generation model.
- Live checkpoint application is monotonic; terminal tombstones prevent late
  checkpoint resurrection.
- Recovery sends wait for the replacement runtime instead of steering the
  retired one.
- Optimistic send rollback preserves text, inputs, names, pruning overrides,
  and session ownership through both pre-ack and post-ack failures.
- Transcript commit evidence is renderer-owned, revision/generation-bound, and
  supports large live tool owners without an arbitrary completed-tool cap.
- Remaining manual cases from `UX_RELIABILITY_SMOKE_TEST.md` were not run because
  opening/reloading/manipulating VS Code or an Extension Development Host was
  explicitly prohibited.

## Measurement-accuracy audit

| Value | Source and update policy | Finding |
|---|---|---|
| Token/context footprint | Backend context-usage event; projected per accepted snapshot | Canonical footprint combines input/cache categories and must not be presented as a known uncached-input split. |
| Completed token cost | Durable assistant usage, model-specific pricing | Preserves input/output/cache categories where reported. |
| Live cost | Current context footprint plus streaming estimate | Cache/category uncertainty must be labeled rather than priced with false precision. |
| Subagent direct cost | Nested terminal subagent result usage | Session-keyed after this audit; large recursive previews can still be expensive. |
| Provider state | ProviderGate pool/circuit/account state | Active, queued, cap, pause, strikes, and afterburn now survive live overrides. |
| Timing/activity | Backend/session/subagent lifecycle observations | Outer settlement timing is implemented; phase-specific subagent lease/retry analytics remain incomplete. |

Unknown or unclassified data should remain explicit. In particular, a combined
context footprint is not evidence that every token was billed at the uncached
input rate.

## Performance baseline and measurement limits

The preserved pre-change synthetic reports were produced at `84869cb` on
Node `v24.16.0`, Windows x64:

- `streaming-pipeline-2026-07-15T11-47-31-543Z.json`: current burst sync was
  about 21.2 µs/delta at 0 rows and 53.0 µs/delta at 100 rows; the tool lookup
  index reduced the 1,000-row microbenchmark from about 89.5 µs to 0.063 µs.
- `analytics-2026-07-15T11-47-43-583Z.json`: a 2,000-run cold tick used about
  97.6 ms query + 100.9 ms compute + 4.2 ms clone; warm compute fell to
  4.6–16.1 ms with a ~121.5 KiB aggregate payload.

These are synthetic microbenchmarks, not end-to-end UI latency. The streaming
fixture uses legacy events and unreachable loaded-window sizes above the
production 240-row cap, and its projection timing includes envelope work.
It excludes VS Code IPC, hydration, commit proof, virtualizer, DOM, layout, and
paint. No claim about frame rate or interaction latency is derived from it.

The post-change rerun at `f8c9cd8` wrote
`streaming-pipeline-2026-07-15T13-42-23-794Z.json` and
`analytics-2026-07-15T13-42-25-564Z.json` (ignored runtime reports, not source):

- current burst sync measured 18.15 µs/delta at 0 rows, 47.09 µs at 100,
  65.08 µs at 400, and 63.05 µs at 1,000;
- current slow-stream sync measured 31.04, 60.64, 87.44, and 89.23
  µs/delta respectively;
- analytics cold query/compute/clone measured 61.75/61.42/2.64 ms; its final
  warm tick measured 0/2.27/2.19 ms at the same ~118.7 KiB aggregate.

All reported post-change synthetic values were lower than this audit's stored
baseline, but the changed UI rAF/cost paths are not exercised by those
microbenchmarks and no multi-sample variance was collected. The comparison is
therefore a non-regression observation, not a causal speedup claim. The direct
auto-follow improvement is instead proven structurally: its deterministic fake
scheduler has zero pending frames once settled and wakes on resize/content.

Deterministic render-count tests do prove that stable transcript rows and
expensive composer walks do not recompute per streaming clone, and this audit
added cross-session memo correctness plus large commit-evidence coverage.
A future real-browser trace should measure host snapshot build through
`stateReceived`, `transcriptCommitted`, and paint, with 1–30 MiB nested results,
600+ live tools, and 1/4/8 background running sessions.

## Test, hook, and build findings

- `test:file` is the tight iteration path; scripts now run from repo root.
- Changed-file detection includes scripts and generated-model safety.
- Pre-commit runs changed packages. The first four post-review commits each
  selected all packages while the test mapper was dirty and passed 4,427 tests
  with 0 failures and 4 skips.
- Pre-push is the canonical release gate and now builds with `--no-sync`.
- First pushed release-checkpoint totals: 15/15 packages, 4,410 passed, 0
  failed, 4 skipped; extension coverage 90.3% lines / 84.3% branches;
  subagent 98.0% / 90.1%. The post-review full-hook total before the shutdown
  follow-up is 4,427 passed.
- Configured typecheck is incremental and parallel (14 projects, 8.5 s in the
  first pushed checkpoint). The subagent package is not yet one of those projects;
  its existing tsconfig exposes unresolved SDK compatibility and stale test
  fixture types when invoked directly.
- No hooks were bypassed. The first push attempt hit the coordinator's
  four-minute wrapper timeout and pushed nothing; it was rerun unchanged with a
  longer outer timeout and completed in 305.2 seconds.

## Security, lifecycle, and cleanup

- No credentials, `auth.json`, transcripts, or runtime session data were added
  to Git. The real smoke inherited credentials through the environment and did
  not print or pass them as command-line values.
- Diagnostics are now sanitized before persistent logs, stderr-tail errors,
  dropped-line previews, and raw webview notices.
- Backend and provider timers/slots added or changed by this audit have
  deterministic exact-release tests.
- Subagent transcript sessions are in-memory and context-isolated, but not a
  process/security sandbox. Documentation now states that boundary explicitly.

## Documentation changes

- `STATE_CONTRACT.md` was updated with matching tests for terminal checkpoint,
  send-rejection/input ownership, and diagnostic-redaction behavior.
- `extensions/subagent/README.md` now distinguishes transcript isolation from
  security/process isolation and describes the actually implemented timeout
  controls.
- `HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md` no longer claims phase leases,
  orphan retries, or shutdown drain are complete.
- This report is linked from `docs/INDEX.md`.

## Verification commands and outcomes

Automated commands run during the audit included:

```text
git diff --check
npm run sync-models -- --check
npm run test:file -- <focused files>
npm run test:changed
npm run typecheck
npm --prefix extension run lint --
npm run test
npm --prefix extension run build -- --skip-typecheck --no-sync
git push
```

The first pushed checkpoint release gate reported:

```text
sync-models: all derived files in sync
14/14 configured TypeScript projects passed
lint passed
15/15 packages passed — 4410 passed, 0 failed, 4 skipped
no-sync production build passed
```

Post-review implementation commits and their hook evidence:

```text
7898042  provider pause generation, bounded inspection, pool disposal
7a0a775  terminal UI, chunk-safe stderr, live-cost truth, mounted commit proof
2431f71  permanently fenced retired subagent UI proxies
02aef45  root maintenance-script changed-test mapping
c9a5d3d  bounded/cancelled inspection branches + production gate teardown
first four: 15/15 packages — 4427 passed, 0 failed, 4 skipped (each commit)
c9a5d3d: extension + subagent — 3193 passed, 0 failed, 1 skipped
```

The real-provider check was an automated external smoke, distinct from the
deterministic suites:

```text
provider/model: umans/umans-glm-5.2
mode: ephemeral print, no session, no project approval, no tools
thinking: off
expected/received: PIE_AUDIT_SMOKE_OK
elapsed: 23.4 s
```

## Manual checks omitted

No VS Code window was launched, reloaded, closed, or manipulated. No Extension
Development Host, watcher, or syncing extension build was run. Therefore the
manual visual/keyboard/screen-reader, real paint latency, focus restoration,
notification, and forced-backend-crash smoke cases remain unperformed.

## Remaining prioritized work

| ID | Priority | Remaining work | Why it remains |
|---|---|---|---|
| REM-01 | P1 | Add generation ownership at the SDK session persistence boundary, or isolate runtimes in workers/processes. | Event fencing cannot prevent a retired in-process SDK prompt/abort from appending to the same JSONL or causing late external side effects. |
| REM-02 | P1 | Track and dispose sessions/resource loaders that resolve after a pre-spawn abort race. | Local settlement releases the permit, but a late creation promise can become an invisible in-process orphan. |
| REM-03 | P1 | Implement provider-aware subagent attempt identity, bounded abortable backoff/`Retry-After`, per-attempt tree budget, and an orphan registry/shutdown drain. | Current fallback can retry the same failed provider, has no backoff, and counts a multi-attempt task as one tree session. |
| REM-04 | P1 | Bound/collapse repeated recursive signature, JSON serialization, and tokenization work for multi-megabyte live subagent previews; cache token-rate projections by live revision. | Valid payloads up to the protocol ceiling can still consume the webview/host main thread repeatedly. |
| REM-05 | P1 | Make subagent source a supported configured TypeScript project, separating source/test configs and reconciling SDK compatibility types. | Direct `tsc` currently exposes module/type drift that the release gate does not see. |
| REM-06 | P1 | Build the complete fake-clock provider/subagent matrix, including >15-minute productive control and persisted per-attempt analytics. | Required acceptance evidence is still incomplete. |
| REM-07 | P2 | Replace heuristic process-listener reclamation with upstream loader disposal and coordinate overlapping loader lifetimes. | One subagent scope can otherwise remove another overlapping scope's SDK listener. |
| REM-08 | P2 | Replace the legacy streaming microbenchmark with production v5 envelopes/window sizes and add a real-browser trace. | Current numbers cannot establish end-to-visible or paint latency. |
