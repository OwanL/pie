# Session-control refinement

Status: runtime `1a50dc361fa6261c02d02a1f9147b42db352e2e0082d854d7ff4a555f70c990e` is confirmed loaded after the user's restart. Its original create/configure/send-versus-close fix is live-verified; display projection is verified through live transcript reads and isolated headless rendering, not desktop inspection. Additional same-path close/reopen cancellation and lost-response warnings are regression-tested and staged for the next normal startup. No restart was forced. Product decisions and implementation notes remain here.

Latest validation (post-restart follow-up): full repository typechecks, lint, `git diff --check`, focused cancellation/transport/tool tests, and both isolated headless Agent-display browser cases passed. `npm test`, run separately from typechecking/building, passed 35/35 affected packages. The analytics reconciliation-capacity case passed at approximately 27 seconds against its 30-second deadline; the previous load-sensitive full-run timeout was not reproduced, not root-cause-fixed. The extension build staged runtime `d96cb657cab0a0b0efa23947c2e68bcf1e66e9ae9df008a7588b1eff926a296c`, build/renderer identity `6e0af25334080d56ef9b`, for the next normal startup.

## Follow-up review and verification

Live calls against the loaded older runtime exposed a hot-session ownership error while capturing inherited settings. Create failed before durable creation, so no new session or tab was created; reviewer subagents are not primary session tabs. Source fixes and regressions now cover:

- Read saved model/reasoning and cwd through the stable hot-read lease rather than ordinary cold ownership. Create reuses the captured settings/cwd, not stale applied worker state.
- Report inheritance failure as `creation.status: not_created`, configuration `not_started`, and optional task `not_sent`, distinct from an uncertain creation acknowledgement.
- Keep title namespace readiness independent of unrelated provisional-title refreshes. Retry failed startup hydration with bounded backoff, fenced by backend generation and disposal.
- Do not infer close completion from retained history or a racing UI close. Completion requires successful barrier evidence and no newer live/pending state; intentionally hidden running targets still enter stop/cleanup.
- Project transcript reads before the page byte budget: retain conversation content and sender identity once, omit renderer/debug/accounting mirrors, and explicitly bound tool previews and mark omitted image bodies.
- Reject action-inapplicable tool fields rather than silently dropping the agent's intent; describe persistent settings and exact title targeting in the tool schema/guidance.

The observed lookup failure for `Scan PIEM for Code Smells` remains unexplained: review did not establish whether the displayed value was an assigned title, a provisional label, or different runtime state. No speculative title-resolution change was made. After a normal VS Code restart, re-test create/list/read/settings/message/close using disposable primary sessions only, and verify assigned-title lookup. Existing live sessions must not be altered for verification.

## Post-restart live verification

The backend process command line confirmed runtime `1a622a706335660d5130f9d01703f69b327a692133930d70bd57c6a4c34632a4` was loaded. Disposable sessions verified hot self settings/read, exact assigned-title lookup, cold creation and inherited settings/cwd, collision suffixes, explicit cwd and settings overrides, bounded transcript paging, rejection of provisional/closed names, title reuse after close, and both idle close and interruption/cleanup during a running bash wait. All test tabs were closed normally; their diagnostic history was retained. Existing sessions were not modified.

The live checks found additional confirmed defects, now fixed in source with regression tests:

- The pinned SDK emits an initial user `message_start`. Treating it as queued delivery cleared authenticated attribution, so a prompt ran and answered despite its send reporting failure. The initial boundary now preserves its direct identity and leaves early queued follow-ups untouched, including when the direct prompt came from the user.
- SDK startup treated a configured, message-empty session as new and appended default reasoning over its explicit saved choice (`low` became `high`). Runtime construction now supplies explicit durable reasoning while leaving unspecified defaults and SDK model validation intact. A real-SDK regression reproduces this startup case.
- Worker IPC discarded the typed provenance-uncertainty code, and worker acknowledgement timeouts were also classified as rejected. Both now produce `unknown`, preserving potentially admitted rows and never implying a safe resend.

These fixes were subsequently loaded and live-tested as recorded below. The earlier specific `Scan PIEM for Code Smells` discrepancy cannot be reconstructed because it is no longer live; current exact assigned-title lookup and provisional-label rejection behaved correctly. One initial pruning prepass reported a usage-field error and kept all skills; subsequent prepasses succeeded. That separate issue was not changed here.

## Second-restart verification and screenshot follow-up

The backend process command line confirmed runtime `c4f11c6e9e5620b3fcf1554e76beadb6273d9621085f1f13dac22e908d55b2a1` was loaded. Three disposable sessions verified:

- Combined create/configure/send reported `accepted`, answered, and retained durable sender attribution. Explicit `low` reasoning survived both initial startup and the cold child's first promotion.
- A busy send reported `accepted` with `queued: true`, delivered once, and retained authenticated provenance. Busy reasoning updates failed without mutation, and a combined settings/send call reported `not_sent`; its marker never reached the durable transcript.
- A hot peer created a cold child inheriting its saved `low` reasoning and `autonomousMode: true`, independently of the original caller's `high`/false choices.
- A peer replied using the exact authenticated `replyTo` reference; the intended original sender received and answered it with correct sender metadata.
- Disposable self-close persisted the `closeRequested` response, then disappeared from both live membership and closing reservations. Remaining test sessions were closed normally; on-disk diagnostic history and other sessions were preserved. Worker timeout/provenance uncertainty paths were not deliberately failure-injected live; they retain their regression coverage.

The user's screenshot then exposed duplicate Agent cards and visible model-only sender envelopes. The SDK transcript contained each of the four user entries once. Host optimistic rows held the original prompt, while durable display rows included the injected sender prefix, so existing one-to-one content reconciliation failed and retained the optimistic cards at the bottom. Display mapping now strips exactly one canonical prefix matched against validated durable sender metadata, including SDK text-array/image content; it preserves sender fields, images, and durable model input, and leaves unmatched or unprovenanced lookalikes untouched. Mapper regressions failed before the fix. Composition regressions cover actual formatter → mapper → host reconciliation, including idle four-card reconstruction, queued delivery and repeated identical prompts. The UI fix is staged, not loaded; live visual confirmation requires the next normal restart.

## Concurrency, cancellation, and error-path follow-up

The running backend still used `c4f11c6e9e5620b3fcf1554e76beadb6273d9621085f1f13dac22e908d55b2a1`; the screenshot fix was therefore not live-tested. Disposable peers exercised concurrent same-base-title creation. Both obtained distinct assigned titles, completed configuration, and inherited their saved `low` reasoning even while application defaults differed. Closing a child running `sleep 90` aborted its tool and cancelled its queued marker; the retained SDK transcript contained neither the queued marker nor its answer. Two close attempts yielded one confirmed close and one later unavailable-title error, not two overlapping close operations; true close joining remains covered by deterministic regression tests. A captured reply reference failed after its original sender closed and its assigned title was reused by another session; the replacement's transcript stayed empty.

The third bounded create/close race attempt reproduced a real defect: the closer persisted `closed: true` at `23:33:31.083Z`, but the create workflow appended the child's initial user message at `23:33:32.075Z` and the child answered at `23:33:34.576Z`. Closing-state reservations had already been released when later delivery was admitted. Source now rechecks authoritative live-target admission after configuration and before/after asynchronous runtime promotion, using existing publication-gap authority and only strengthening coordinator-authenticated agent sends. Durable creation/configuration outcomes remain intact; a late send is rejected without reviving the closed target. Gated configuration and promotion tests failed against prior behavior and now pass. All disposable tabs were closed normally; diagnostic history and existing sessions were preserved.

Fault-injected worker acknowledgement timeouts additionally showed model/reasoning and prompt-toggle configuration reporting `failed` rather than `unknown`. Both catches now recognize `WorkerRequestTimeoutError`; combined sends report `not_sent` after uncertain configuration. These two regressions failed before the correction and pass now. No live worker crash/timeout or whole-host restart was forced.

Slow-create investigation found three serialized, unprewarmed inventory discoveries per earlier create, costing roughly 30–45 seconds, plus runtime startup. One discovery came from the internal cold model-settings metadata read and was unnecessary. That read now explicitly skips inventory; public cold opens and prompt-toggle publications still perform fresh discovery. A real server-path inventory spy proves one discovery avoided per metadata read. This is not yet a live wall-clock improvement claim, and remaining required discovery/startup costs have not been optimized.

Next normal-startup verification must confirm the staged generation, re-test the timed create/close cancellation race and configuration outcomes, visually confirm Agent-card reconciliation, and measure create latency again. Long-duration soak testing and deliberate live worker/host failure recovery remain unverified; the tool is not described as error-free or fully reliable yet.

## Post-restart live and design assessment

The startup log at `2026-10-01T00:45:12.546Z` identifies the leased backend as runtime `1a50dc361fa6261c02d02a1f9147b42db352e2e0082d854d7ff4a555f70c990e`. Disposable peers received distinct assigned titles and retained saved `low` reasoning through startup. Direct and queued messages appeared once each in the live projected transcript, with validated sender metadata and no display-only envelope. The queued send used ordinary steering: the later instruction superseded the earlier requested answer, which is expected rather than a delivery failure.

The original live close race is now verified: the child `SC Close Verify 0200` closed at `01:58:48.951Z`; its creator subsequently reported creation/configuration succeeded and message rejected because the target was no longer live. The retained child SDK file has zero message entries and no `SC_CLOSED_RACE_MARKER`. Closing a running disposable peer aborted its `sleep 60` tool and ended its SDK assistant with `stopReason: aborted`; the queued `SC_ABORTED_QUEUE_0215` marker was absent from durable history. Reusing that peer's name for a new empty cold session did not redirect its former authenticated reply reference: the stale reply failed and the new transcript stayed empty. All disposable tabs were closed without deletion; other sessions were not changed.

The user requested headless-only checks while using Pie. `agent-session-control-display.pw.ts` runs an isolated BrowserServer with built Preact assets, no SDK/backend, and empty temporary settings/data. Real provenance formatting, transcript mapping, and host reconciliation feed the renderer: one case preserves a still-queued optimistic row, and the other reconciles both delivered rows when idle. Both remain single attributed rows after reload, without raw envelopes or duplicated cards. Phone/tablet visual inspection of isolated captures found contained, readable rows. This is not evidence of the actual desktop webview or the live host's selection state.

Design review retains current title semantics and the non-atomic staged create/configure/send contract. Names address current live owners, not permanent identities; the user questioned the proposed identifier complexity, and existing name semantics were retained. No new selector or identity precondition was introduced. Identity-bound replies continue to fail safely after the original session closes. Lost mutation replies/cancellation are now explicitly `outcome: unknown` at the tool boundary, with a warning that admitted coordinator work may continue and must not be automatically repeated. Known validation/acknowledged failures and read-only calls retain their original behavior.

A narrower implementation gap was reproduced deterministically: after a close, reopening the *same durable path* could admit an older prompt whose configuration had been awaiting completion. Current live membership alone could not establish uninterrupted admission. The fix captures the existing per-path cancellation generation before configuration and carries it through promotion; owning close and relevant membership transitions invalidate it. It rejects the old prompt while permitting fresh reopened requests and leaving unrelated session changes alone. No additional generation map, target API, compound transaction, or global membership revision fence was introduced. A real inherited-FD transport test also proves an expired request's late response cannot settle or poison a newer pending request.

These additional cancellation/warning changes are staged, not loaded or live-verified yet. No whole-host restart or live worker failure was forced; long-duration soak and deliberate live failure recovery remain unverified. No broad design rollback is indicated by the tested cases, but neither the tool nor the broader runtime is claimed error-free. Remaining cold inventory/startup work is still visible in create latency; no statistically controlled performance claim is made.

## Boundaries

Keep session control a typed worker-to-coordinator bridge, not a generic RPC
tunnel. Assigned titles are the primary tool address, with identity-bound reply
references as a narrow messaging exception. Backend session operations remain
explicitly path-addressed and internally identity-fenced. Do not replace paths
throughout the application. Reuse existing message, settings, interrupt,
privacy, and operation-ordering authorities. Change UI and tool close together:
close must stop work and close the tab, not merely hide a running session.

Do not add passive notifications, completion-report obligations, cross-window
federation, a new next-turn settings queue, or a general preferences editor.
Combined create/configure/send is a convenience sequence, not an isolated or
atomic workflow. Do not add a compound recovery ledger, public recovery-token
API, durable initialization block, or first-message reservation. Do not add an
agent-facing stop action; preserve the UI Stop control. An ordinary message
asking a peer to stop is cooperative, not an interrupt guarantee. The live-status
list exposes existing UI/host information through the tool; no new UI dashboard,
independent status tracker, or accounting feature is in scope. Proper session
monitoring, nested subagent inspection, and progress subscriptions are future
work; this pass keeps a basic live overview and existing bounded transcript read.

## Implementation sequence

### 1. Establish title authority

The coordinator owns allocation across all local live sessions and in-progress
name reservations, not retained closed history or the bounded tool-list page.
Use host-owned live membership, including restored open tabs; no full archive
scan/migration is required. Preserve existing unique live names; resolve live
collisions deterministically and persist suffixes. Reserve
literal existing suffixes before allocating new ones: an existing `Review (2)`
must not collide with a newly suffixed `Review`.

Use existing SDK session metadata for durable assigned titles. Add an
ownership-aware assignment seam: cold writes go through `ColdSessionStore`
mutation fencing; hot writes go through the owning worker. Do not write JSONL
from the coordinator while a worker owns its lease. Catalog/index refresh and
host publication follow confirmed assignment. Retained cold handles cover the
existing create-to-catalog publication gap.

Title generation currently persists its candidate inside
`harness/agent-processes/workers/session-title-generator.ts`. Separate candidate
generation from final unique assignment. The coordinator reserves a name, the
current owner persists it, and only then is the assigned name published. Apply
that authority to create, duplicate, generated titles, and snippet fallbacks.
All newly assigned base titles use the same 25-character limit, with automatic
collision suffixes additional. Update generation instructions/validation and
bound first-prompt snippet fallbacks accordingly; explicit oversize create
input is rejected, not silently shortened. Preserve existing assigned titles
rather than bulk-shortening history. Blank UI sessions remain provisional.
Assigned names stay stable while their sessions are live. Release a name after
successful close or confirmed deletion, not merely optimistic tab removal;
pending/failed close keeps the reservation so restoration cannot collide. Ordinary
close retains the recorded title in historical metadata, not a live reservation.
User-driven reopen reuses that title if available, otherwise allocates and
persists a suffix before live admission. Agent messages never implicitly reopen
history. Do not retain reserved historical aliases; title lookup does not prove
continuity with a previously remembered session.

Startup reconciliation covers restored live sessions only. It must be repeatable
and must not modify transcript messages, identity, selection, or runtime readiness.
Incomplete live membership/title hydration or failed assignment cannot be
presented as a ready unique namespace. Do not rename, shorten, or rerun the naming
model over the closed archive.

Use exact title matching after trimming outer whitespace, without fuzzy
matching. For existing collisions, the oldest durable header creation timestamp
keeps the original; stable session identity breaks ties. The metadata reader
already retains `headerTimestamp` and `sessionId`; expose/use those rather than
mutable `modifiedAt` or tool-list order. Missing/invalid creation timestamps sort
after valid ones, then by existing session identity. Resolve identity before
allocation rather than relying on optional summary fields. Reuse
`resolveSessionIdentity`, including its deterministic normalized-path fallback
when a legacy header has no valid ID; do not add an identity-repair migration.

### 2. Resolve assigned titles without a global generation wait

Initial restoration of live membership and its assigned titles must establish
the unique namespace before title-based resolution or allocation is available.
Report namespace unavailable while that initialization is incomplete; do not
guess from partial live membership or wait for unrelated archive indexing.

Afterward, assigned titles remain usable while unrelated title generation runs.
List returns without waiting for naming and distinguishes provisional labels
from assigned title targets. An unresolved title returns unavailable/not found;
it never waits for a guessed future name. Every action on an existing session
requires an explicit title or self target, with reply references as a
messaging-only alternative. Explicit self targeting works while the caller is
unnamed; there is no implicit current-session default.

Resolve and pin the target against the title authority at admission, synchronized
with namespace changes. Also verify live membership: an assigned title or valid
reply reference is not authority to act on retained closed history. Use existing
host-owned open-tab and close-operation state for live membership, communicated
through the typed coordinator bridge; do not add a second durable session list.
List and target admission must observe that same membership, independently of
asynchronous catalog/index refresh. Newly created background tabs enter it via
host-owned creation publication; retained cold handles supply their identity
while indexing catches up.

Once admitted, use stable identity/path rather than re-resolving the title.
Closing removes live addressability immediately and fences new execution;
requests waiting to execute must not promote or restart a closing/closed target.
Already-started work is covered by close's ordinary interrupt/queue cancellation,
not replayed after close. Repeated close requests join the owning close operation;
failure restoration restores membership, not cancelled work. Concurrent final
assignments do not rename existing assigned sessions or retarget operations.

Do not add a global naming barrier, waiter queue, or new cancellation protocol
for naming waits. Keep existing operation cancellation and ownership fencing.
Do not hold the naming critical section while awaiting message execution,
settings acknowledgements, or worker callbacks that can need that authority.

### 3. Reuse and extend settings ownership

Inherit a one-time snapshot of the source's durably saved execution
configuration, then apply explicit overrides. Resolve inherited defaults at
capture; include saved settings awaiting runtime application, not stale
worker-applied values or unpersisted optimistic UI choices. Capture it once per
create call. This call must finish configuration before sending its optional
initial task; it does not exclude other callers. Do not copy conversation
history, pending work, privacy mode, selection, or transient UI state.

| Setting | Existing authority and planned use |
| --- | --- |
| Main model/provider and reasoning | Durable Pi session entries plus live SDK setters. Add a session-only persistence scope to the owning model-settings path; preserve model validation, busy guards, rollback and cold restoration without changing global defaults. |
| Subagent provider choices | Host-owned `subagentProviderTogglesBySession`. Copy effective choices for the configured provider surface into the target's own entry; preserve independent later edits. |
| Autonomous mode | Add a session-keyed override beside the existing host-owned session preference maps. Resolve it over the shared default before worker execution and during live preference application. |
| Disabled system-prompt entries | Reuse the existing session settings sidecar and hot/cold `systemPromptToggles.set` paths. |

Session MCP inheritance, inspection, and update are deferred from this slice.
New sessions use normal MCP discovery for their target directory; do not copy
the source's MCP artifact. Existing MCP controls remain unchanged. A follow-up
must reconcile the no-global-enable contract with the current artifact writer,
which accepts force-enable flags; UI projection alone does not enforce runtime
configuration.

Shared defaults remain shared: model defaults, provider defaults, subagent bucket
configuration and capacity limits, provider concurrency, title-generation
configuration, global MCP configuration, and application preferences. Agent
configuration is not a way to rewrite these global settings.

For host-owned settings, add a narrow correlated request/acknowledgement flow
through host reducer/effects, persistence, and existing runtime-preference
synchronization. The coordinator must not bypass the host and rewrite its
preferences file. Success means the owning persistence/application path has
acknowledged the change, not merely that an event was emitted. Background tabs
and restarted workers must show and use the same effective settings. Session
removal/rekey/privacy cleanup must cover the new autonomous override using the
existing session-keyed preference lifecycle.

Inspect and update use these same authorities. Keep model/reasoning busy
rejection and live preference behavior; do not invent uniform next-turn
application. Report pending application where the existing owner already does
so. Validate a requested settings patch before starting writes and do not imply
an atomic cross-store transaction that does not exist.

### 4. Compose create, configure, and optional message

Extend tool `create` with required `title`, optional initial-task `prompt`, and
optional `settings` overrides, alongside optional `cwd`:

```json
{
  "action": "create",
  "title": "Review session control",
  "prompt": "Review the implementation and identify correctness issues.",
  "settings": {
    "autonomousMode": true
  }
}
```

Enforce the contract's 25-character supplied-title limit after trimming; reject
oversize input rather than truncating it. Automatic collision suffixes are
outside that input limit. Omitted settings inherit from the creator. Add explicit
settings inspection/update actions. Read, message, settings inspection/update,
and close require explicit targeting as described below. Preserve bounded
schemas/results and the current host-local scope.

Omitted `cwd` inherits the creator session's working directory, not the
backend startup directory or selected UI session. An explicit `cwd` wins.
Validate the request and capture inheritance before creating, then:

1. Create a named cold session through the existing durable-create path.
2. Apply inherited settings and overrides through their owning paths, awaiting
   configuration acknowledgements.
3. Only if configuration succeeds, send the optional task through ordinary
   `message.send`, retaining agent-message provenance. Without a task, leave
   the session cold and idle.

This call configures before it sends; it does not isolate the session from other
callers. Keep ordinary tab publication, settings edits, execution admission,
queue/busy behavior, close/delete, and background-selection preservation. Do not
add a special readiness state or reserve the first message. Concurrent edits or
messages can affect the outcome through ordinary settings/send semantics.

The existing `CreateOperationLedger` commits at durable creation and treats later
publication failures as successful creation. Keep configuration and send outside
that success catch so their failures cannot be hidden. Return bounded, separate
creation, configuration, and message-acceptance outcomes, including the assigned
title and session identity whenever known:

- Configuration failure leaves the ordinary created session with any settings
  already applied; report the failure and do not send this call's task. No
  automatic rollback, deletion, or permanent execution block is introduced.
- Send rejection leaves the configured session; report the send failure rather
  than claiming creation failed. Success means acceptance, not task completion.
- Lost acknowledgement or owning-worker/backend-generation loss is unknown
  where existing operation evidence cannot establish the outcome. Never
  automatically repeat creation or send because a response is missing.

Reuse existing per-operation identity, idempotency, and read-only reconciliation;
do not introduce a compound ledger, resumable create token, or tool `status`
action. A fresh create call is a new create, not recovery of the previous one.
After partial failure, inspect/configure/message the existing session rather
than rerunning create; after an uncertain result, inspect surviving state before
choosing further work. There is no cross-restart workflow recovery promise.

### 5. Make messaging and lifecycle workflows consistent

Every action on an existing session (`read`, `message`, settings inspection/update,
and `close`) requires an explicit target; omission is an error, not an implicit
current-session operation. `title` addresses an assigned title, and an explicit
self selector addresses the caller. `message.replyTo` is the messaging-only
identity-bound alternative. `list` and `create` need no existing target. Reject
conflicting selectors. Use `prompt` for
message content as well as `create.prompt`, replacing the current `message.text`
field. `message` also accepts optional `settings` overrides, using the same
configure-then-send sequence as create without recopying inheritance. Overrides
are persistent session edits, not temporary per-message settings. Validate the
patch, apply it through existing owners, then send only on configuration success.
Busy-setting rejection or other configuration failure reports any partial writes
and does not send this call's prompt. Without overrides, use ordinary message
behavior. Do not add rollback or a deferred-settings queue. Update schema,
coordinator validation, results, examples, and tool guidance together; internal
backend RPC fields remain unchanged.

Cross-session messages, including the optional `create.prompt`, must carry
coordinator-supplied sender attribution and a reply reference. The current bridge
knows the source session but drops that identity before sending; durable
provenance records only the generic agent-message tag. Extend the existing
message/provenance path rather than requiring agents to embed addressing in
free-form text. The recipient model and transcript UI must both receive the
attribution, and it must survive reload. Source identity comes from the calling
worker, not tool arguments or message text. Initial tasks, updates, and replies
use the same message path; do not add a parent/child session hierarchy or
automatic reply/completion obligations.

`message.replyTo` accepts the supplied reference instead of a title. Bind it to
the original source session identity, not a fresh lookup of its title. It works
for unnamed senders, and a deleted source returns unavailable even if another
session reused the title. Reuse existing session identity and catalog ownership;
this is not a new operation-token ledger, historical-title alias, or cross-host
address. Durable attribution retains the reply reference rather than requiring
an in-memory message-to-sender registry.

Preserve and verify the general [queued-continuation pruning rule](../../harness/tool-and-skill-selection/README.md#integration):
queued steering/follow-up messages retain the active selection without another
skill-pruning prepass, regardless of user or agent origin. Idle-session requests,
including `create.prompt`, use normal pruning. Do not add an agent-origin bypass,
message-type classifier, or per-message pruning flag. Tool-result pruning and
history compaction remain unchanged.

Agents may close any explicitly targeted live session, including user-created
sessions currently in use. Do not add creator-based restrictions or a new
approval gate; agent behavior remains subject to explicit user instructions.
Close must stop active and queued work and close the tab, consistently across
UI and tool ingress. This deliberately replaces the current STATE contract's
running-tab hide behavior. Compose the existing interrupt-completion mechanism
with host-owned close, tab persistence, and privacy cleanup; do not retain the
tool's lifecycle-only acknowledgement or bypass host cleanup with direct forget.
Ordinary close preserves the transcript and recorded historical title on disk,
releases its name reservation on confirmed completion, and removes the session
from the agent-control surface. Closed history is neither listed nor
addressable for read/message/settings through titles or reply references; agent
messages must not implicitly reopen it. History retention/expiry policy belongs
to future data-lifecycle work and is outside this slice. Private or explicitly
deleted sessions retain the existing deletion lifecycle. Update the STATE contract and
owning UI/tool tests when implementing this changed behavior.

Remove the tab immediately, then complete stop and cleanup under host-owned
operation tracking. Tab removal is optimistic presentation, not proof of stopped
execution or successful close. Retain the state needed for shutdown and recovery
until the outcome is known. If stop/cleanup fails, restore the surviving session's
tab and surface the failure without automatically restarting work. A committed
deletion cannot be undone: retain/report remaining cleanup failure rather than
reopening a nonexistent transcript. Preserve existing selection ownership when
restoring a tab so a late failure does not steal focus from newer user selection.

Allow self-close. First hand off to the host-owned close operation and acknowledge
`close requested`, then stop the calling worker; never claim it has already
closed. The host retains shutdown and failure handling after the caller stops.
Closing another session waits for confirmed stop/cleanup, within existing request
budgets; a missing acknowledgement remains unknown rather than successful close.
No new notification or recovery API is introduced.

List is a live coordination overview of sessions still in use, not a saved
history browser. Exclude closed sessions and do not add an all-saved scope.
Expose assigned/provisional titles, coarse activity (running tools/subagents,
waiting for user input, or idle), elapsed time for the current request including
waits, and cumulative session working time/cost with reported/estimated cost
provenance. Tool/subagent activity can overlap, but do not include nested child
summaries, individual tool output, or progress streams. This is an overview, not
a session-monitoring API. Tab age is not working time. Project existing UI/host activity/accounting information into a compact
tool response; do not build another dashboard, parallel status tracker, or new
accounting feature. Unavailable/not-yet-loaded metrics remain explicit rather
than fabricated zeroes. Keep results bounded,
make indexing incompleteness explicit, and include newly created sessions without
waiting for the saved catalog's asynchronous reconciliation.

Create/message return compact outcomes for the resolved target, configuration,
and send acceptance/queueing/rejection/uncertainty, not the recipient's completed
answer or a detailed activity snapshot. Use existing result budgets and preserve
known partial outcomes. Live-list response bounds/paging are implementation
mechanics: avoid silent omission and do not turn them into a monitoring feature.

### 6. Verify the connected behavior

- Supplied create titles accept 1–25 characters after trimming and reject blank
  or oversize input without truncation; automatic collision suffixes do not
  consume the input allowance. Newly generated titles and snippet fallbacks use
  the same base-title limit; existing assigned titles are not bulk-shortened.
  Cover concurrent allocations, existing numbered names, repeat live restoration,
  provisional labels, fallback finalization, and stability while live. Successful
  close/deletion releases names; pending/failed close retains reservations.
  User-driven reopen handles collisions without modifying closed archive entries
  or delaying live operations for archive indexing.
- Live list excludes closed history, includes newly created sessions, and
  reports useful activity/time/cost from existing authorities with explicit
  unavailable/incomplete states. Current-request elapsed time is distinct from
  cumulative session working time/cost; waiting for user input differs from idle,
  and tool/subagent activity can overlap. No archive-list scope is introduced. Closed
  sessions cannot be read, configured, or revived by agent title/reply targeting;
  ordinary close still preserves their on-disk history. List/admission use the
  same host-owned live membership through create, close, failure restoration,
  and delayed catalog refresh. A racing send cannot restart a closing target.
- Hot/cold ownership changes during assignment; no writes bypass worker leases.
- Operations on assigned titles and list do not wait for unrelated naming;
  provisional labels never resolve as titles. Incomplete live-title restoration
  reports namespace unavailable. Concurrent assignment cannot retarget admitted
  operations, and naming failures retain existing fallback/cleanup behavior.
- Creation without a task stays cold; with a task, this call applies inherited
  provider/model/autonomous choices before ordinary send, not just in the UI.
  Omitted cwd uses the creator's directory; explicit cwd wins independently of
  backend startup directory and UI selection.
- Explicit overrides win; later source and target edits remain independent;
  global defaults and unrelated sessions remain unchanged. Inheritance includes
  durable pending-application settings, excludes unpersisted optimistic choices,
  and never substitutes the source worker's stale applied configuration. MCP
  overrides are not copied or exposed through the new settings actions.
- Host persistence failure, worker sync failure, backend restart and cold
  promotion do not silently revert or falsely acknowledge inherited settings.
- Configuration failure never sends this call's task; send rejection retains
  the configured session. Partial and unknown outcomes remain distinguishable,
  and missing acknowledgements never authorize automatic recreate/resend.
- Concurrent user/agent interaction retains ordinary settings and message
  semantics; no initialization block or first-message reservation is introduced.
- Read/message/settings/close reject missing or conflicting targets; explicit
  self targeting remains valid, including for unnamed callers. Create/message
  share `prompt` and optional `settings` fields.
  Message overrides persist without recopying inheritance; configuration failure,
  including busy rejection, prevents that call's send and reports partial writes.
- Sender attribution reaches the recipient model and transcript for both initial
  tasks and later messages, survives reload, and cannot be forged through tool
  arguments or body text. Updates/replies retain ordinary send semantics.
- Queued steering/follow-up messages from both users and agents run no additional
  skill-pruning prepass and retain the active selection. New idle-session
  requests retain normal pruning; transport/startup delay is not a bypass.
- UI and tool close both stop active/queued work and remove the tab through
  host-owned cleanup. Ordinary close retains history but releases the live name
  on success; privacy deletion
  retains its cleanup guarantees. The tab disappears immediately, but success
  awaits stop/cleanup. Failure restores a surviving tab without restarting work
  or stealing newer selection; committed deletion is never rolled back. No
  running-hide path remains for close. Agent close accepts any explicitly
  targeted live session regardless of creator. Self-close acknowledges host acceptance
  before stopping the caller, while cross-session close reports confirmed
  completion or an explicit failure/unknown outcome.
- Unchanged message queue/busy/recycle behavior, agent-message provenance, privacy
  cleanup, and background-creation selection remain intact.

Use focused owning tests plus `test/integration/sync-contract.test.ts` for changed
host-state guarantees. Update SESSION-TITLES and STATE contracts when implementing,
not as claims about the current runtime. Required build/staging verification
belongs to implementation, not this planning pass.

## Agent discretion

Both messaging and execution-setting overrides are at agent discretion, subject
to explicit user instructions and existing validation. Inheritance supplies the
default configuration, not a restriction on later agent choices. No additional
approval gate is introduced.
