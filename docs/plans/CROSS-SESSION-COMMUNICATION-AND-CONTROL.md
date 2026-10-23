# Cross-session communication and control

Working proposal — 2026-10-24. Investigation and design only; no runtime changes or live failure injection.

## Recommendation

Make delegation **quiet, inspectable, and explicit about what has actually happened**. The largest observed problem was not failed routing: agents could not reliably distinguish a queued message, a consumed instruction, a final result, and permission to use a shared resource. They compensated with transcript polling, repeated reports, and long informal holds.

Start with the existing reply-intent/completion implementation and clearer outcome evidence. Do not start with a new scheduler, session-addressing scheme, or cross-window message bus.

The [session-control contract](../contracts/AGENT-SESSION-CONTROL.md) owns current behavior. The older [refinement plan](SESSION-CONTROL-REFINEMENT.md) contains historical decisions, some since superseded; it is not the current API specification.

## Investigation scope and limits

- Read-only canonical query: `<resolved PIE_DATA_DIR>/analytics/analytics.sqlite`, `analytics_tool_states`, snapshot revision `738005`, capture namespace `9ba84da9-dbb5-4d16-8173-16db5c99ecfb`.
- Window: **2026-10-21 00:00:00 UTC through, excluding, 2026-10-23 20:30:10.135 UTC** (this investigation's creation). Filter: `tool_definition_id = 'session_control'`, integer comparison of `started_at_ms`.
- Captured facts: **503 calls across 28 root sessions; 499 `completed`, 4 `failed`**. These are tool-observation outcomes, not task success or a delivery-reliability rate. Transport errors visible in transcripts are not all represented by these captured failures; coverage is not proven complete.
- Qualitative review: high-use orchestration sessions, the UI/benchmark exchange, codec/browser peers, and the automation parent's 18 directly created Oct23 children. Selected for contrasting workflows, not a random or exhaustive sample. No cost/token estimates or transcript-derived usage totals.
- Evidence below is retained local transcript history under `data/outcomes/sessions/`; locate a file by its session ID and then its entry ID. These are historical evidence anchors, **not new tool target selectors**. No raw transcript copies are checked in.
- Source was compared with the tool schema advertised to this investigation. The advertised schema lacks `expectReply`/`fulfills`, while checked-in source has them. This establishes a surface mismatch, not which generation is loaded or whether every source feature is active. Installed behavior must be qualified separately.

### Session keys

| Key | Session ID | Observed title |
| --- | --- | --- |
| UI | `01a15bd8-b13b-7764-9ff9-e8659c6a2091` | Polish Pie UI Rough Edges |
| Bench | `01a16095-2007-70e6-ab19-d5bb6a52d370` | Check the current ticket… |
| Handoff | `01a1657a-a0a4-7d6d-a17d-71f1c563d4f7` | If you read through rece… |
| Codecs | `01a166a5-6572-700b-a5a4-2ce02fb5d2f2` | GP format codecs |
| Browser | `01a166a6-0fd5-74d7-9fc2-bccfd7565993` | GP format browser |
| Auto | `01a16795-c31b-7425-b1b7-c691e80cfe87` | Run through some automat… |
| OAuth | `01a167b8-90da-75a9-a20e-2f351d96e672` | OAuth refresh flows |
| Audit | `01a167c9-b23a-7c30-92f1-da690da5fab6` | Communication audit |

### Observations that drive the proposal

All timestamps below are UTC. An agent's statement about process cleanup or transport failure is evidence of its report, not independent OS verification.

| Evidence | Transcript anchors | What happened / implication |
| --- | --- | --- |
| E1 — queued is not a usable grant | Bench, Oct22 `06:20:54.389`, `13829b81`; `09:07:02.466`, `8d3077ba`; `09:07:34.111`, `91b6c297` | A seven-minute READY grant was accepted/queued. Hours later Bench reported it was still holding; the peer reported interruption. Negotiation needs an acknowledged start boundary and a stale-grant rule, not an assumption that enqueueing starts the window. |
| E2 — all-clear had no reliable shared record | UI, Oct22 `05:14:26.252`, `08bafa17`; `05:14:41.355`, `0fbce057`; Bench `05:56:00.039`, `7e8c4f29`; `06:11:06.096`, `df27ecf9` | Progress and final all-clear sends returned transport-unavailable/unknown; receipt lookups also failed. Bench inspected the peer transcript and later received an explanation. A final answer in the sender's transcript is not proof the peer received it. |
| E3 — redundant reports, not proven duplicate delivery | OAuth, Oct23 `07:48:53.506`, `7bb960eb`; Auto `08:01:54.127`, `dd23f7a6`; OAuth `08:02:00.895`, `9f26251b`; Auto user `08:02:49.119`, `a9c96e87` | A committed result arrived after a delay; a renewed hash request prompted another confirmation. The user called out spam. Distinct overlapping sends are established; a transport duplication defect is not. |
| E4 — routing worked, with delayed consumption | Audit, Oct23 `08:07:11.025`, `974ce1af`; Auto `08:13:31.408`, `6a19cff6` | An exact `replyTo` send was accepted/queued and later appeared with authenticated child provenance. Preserve this routing; expose its intermediate state. |
| E5 — known rejection initially looked unknown | Bench, Oct22 `21:30:34.301`, `9e15b02b`; `21:30:53.676`, `96f5a0ad` | Sending to an unavailable assigned title returned an unknown-outcome warning; the receipt established a known validation error. Preserve typed pre-admission rejection evidence at the first response rather than forcing a recovery lookup. No evidence establishes why that target disappeared. |
| E6 — recovery already works | Handoff, Oct22 `22:36:24.302`, `bb59f76a`; `22:36:30.783`, `d022336c` | A create timed out; `operation.status` recovered successful creation/configuration without duplicate creation. Build on this evidence path, not automatic retries. |
| E7 — racing interface decisions | Codecs, Oct23 `02:52:05.969`, `f737f1fa`; Browser `03:14:08.314`, `4b9ebb4c` | Peers corrected competing Y-up/Y-down proposals and later reported fixture success. Give interface changes a revision and one decision owner before parallel implementation. |
| E8 — explicit ownership/release worked | Browser, Oct23 `03:34:04.541`, `05ec7ad6`; `03:36:24.766`, `846457e2`; `03:42:19.900`, `f08c9202`; `03:46:21.929`, `f7f6b5ab` (incoming Codecs report) | A fixture server had an identified lifecycle owner, consumer DONE, then an identity-checked close report. Preserve resource release as distinct from task success and session closure. |
| E9 — coordination scope exceeded file ownership | Auto, Oct23 `08:08:40.667`, `154e8e26`; `08:10:12.945`, `9f9a0c79`; `09:57:52.647`, `0c695759`; `10:03:21.917`, `1e2796e0` | Unrelated UI writes invalidated a repository-wide snapshot. A later explicit no-write grant/start/release exchange worked. Shared contracts, snapshots, and build gates need coordination even with non-overlapping edit files. |
| E10 — checkpoint mistaken for completion | Auto, Oct23 `07:38:16.470`, `6d8d4321`; user `07:39:32.144`, `558006b1` | The parent finished a reviewed plan; the user expected continued autonomous work. Agree on the stopping condition, not just the next task list. This is orchestration behavior, not a messaging failure. |

## Existing foundation — qualify, do not reinvent

Checked-in source already provides authenticated sender identity and live-only `replyTo`, explicit reply intent, send/delivery timestamps, creator-derived role context, and automatic delegated final handoffs. Relevant implementation: [tool](../../harness/tools/session-control/index.ts), [attribution](../../harness/agent-processes/lib/rpc/session-control-attribution.ts), [handoff](../../harness/agent-processes/workers/delegated-session.ts), and [mutation receipts](../../harness/agent-processes/coordinator/session-control-operations.ts).

Important limits remain:

- Automatic handoffs cover **delivered creator requests**, not arbitrary peer requests. Ordinary peer final output is not a reply transport.
- A durable handoff claim records an **attempt**, not confirmed delivery. Explicit final fulfillment suppresses another automatic attempt even if delivery is unknown.
- Role context survives restart; interrupted in-memory completion obligations are not reconstructed. No exactly-once/restart replay guarantee exists.
- `operation.status` is caller-scoped, bounded, coordinator-lifetime evidence. Unavailable never means not executed.
- Busy sends use ordinary steering/queue semantics. A message saying “pause” is not an interrupt or proof the peer has paused.

## Proposed work, in order

### 1. Establish a trustworthy baseline and reduce chatter

**First implementation slice.** Confirm the loaded generation and actual registered tool schema before judging the new reply behavior. Reconcile historical refinement guidance with the current contract. Update the owning harness guidance, not every task prompt independently.

Default delegation agreement: task, edit/shared-resource ownership, expected evidence, and stopping condition. Communicate only a decision, blocker, changed interface, resource transition, or final result. A new material result may justify a new message; a repeated “still ready” does not.

For qualified runtimes: delegated children normally finish with one automatic final; peers answer once through the authenticated reply reference; informational messages request no reply. Do not add a manual final alongside the automatic one. Continue independent work while a child runs; inspect on a dependency boundary or suspected stall, not in a tight poll loop.

**Done when:** the live schema matches the qualified source; a delayed final plus a redundant status request does not produce a report/acknowledgement cascade; autonomous checkpoints are not mistaken for the agreed stopping condition. E3, E4, E10.

### 2. Expose correlated message and task evidence

**Next bounded design/implementation slice.** Extend existing coordinator/worker evidence rather than build a second task tracker. The exact tool shape is not settled here; first prototype a bounded summary accessible to the sender without fetching transcript bodies.

Keep these facts separate, allowing unknown/unavailable at every boundary:

| Fact | Evidence required |
| --- | --- |
| Accepted / queued | Owning send/queue acknowledgement |
| Delivered | Authenticated durable input entry; enqueue alone is insufficient |
| Consumed by execution | Owning execution correlation; durable append alone is insufficient |
| Execution settled | Correlated settlement with final/error/cancellation; not proof of task success |
| Handoff attempted / delivered | Claim and receiving-side evidence respectively; attempt is not receipt |

Use existing request keys for mutation recovery and input IDs for delivered obligations; define an explicit mapping where enqueue precedes durable input creation. Do not pretend one ID already spans every boundary. Any additional message correlation must remain internal/bounded, not replace title addressing.

Return a compact latest outcome/evidence pointer and outstanding dependency state; retain `read` for inspection. Preserve known pre-admission validation failures through transport instead of blanket unknown warnings. Keep genuine lost acknowledgements unknown and never replay them automatically. E2, E5, E6.

**Done when:** a sender can distinguish queued, consumed, settled, attempted, and unavailable without scraping prose; a known unavailable-target rejection needs no receipt lookup; an uncertain create produces at most one creation. Bound payloads/retention and report truncation. Do not add durable replay in this slice.

### 3. Make shared-resource coordination explicit

**Start as a lightweight protocol, not a global lock service.** Identify the resource and its owner: whole-checkout snapshot, output tree, benchmark capacity, fixture server, or interface revision—not merely edit files.

For time-sensitive work, use a correlation/revision and explicit request → grant → start acknowledgement → release. Include an absolute UTC latest-start deadline and a running-work deadline. A late queued grant cannot start expired work. A running deadline prompts escalation/cancellation through the existing owner; it does **not** prove the process stopped or authorize conflicting work. Release must report both resource state and task outcome; failed tests can still release a confirmed-idle resource. E1, E8, E9.

For shared interfaces, name one decision owner and acknowledge the selected revision before incompatible parallel edits. Superseded proposals must not silently become “final.” E7.

**Done when:** delayed/contradictory grants cannot authorize stale work; owner interruption and transport loss leave explicit uncertainty, not an unbounded silent hold or unsafe automatic release. Only propose host-enforced reservations if a guidance-first trial still fails.

### 4. Address restart/close recovery only after the above

Add a bounded inspection path for unresolved handoff attempts and dependencies if qualification shows it is needed. Reconstruction/retry after restart requires a separate approved design: present claims cannot establish whether delivery happened.

Keep `close` as stop-and-close, not pause. Collect results before closing children; preserve any unresolved external-process evidence and its lifecycle owner. Do not describe close as proof that detached processes exited. Do not close a human-steered child blindly through bulk cleanup.

A separate question is whether callers need a bounded wait-for-change surface. Measure residual polling after slices 1–2 before proposing subscriptions or a new dashboard.

## Qualification and acceptance

Use deterministic coordinator/worker tests first, then disposable primary sessions in an isolated host. Do not mutate existing user sessions, force restart/failure on the user's host, or launch visible desktop checks as part of this document's investigation.

| Scenario | Required result |
| --- | --- |
| Idle and busy child; repeated creator instructions | Only delivered obligations count; correlated settlement yields one bounded final handoff for the consumed inputs. |
| Explicit final with `fulfills`; lost acknowledgement | Durable claim suppresses a later automatic duplicate; uncertainty stays visible, with no blind retry. |
| Peer request and informational completion | One explicit peer reply; no acknowledgement loop and no invented creator obligation. |
| Human steering, compaction, restart | Respect human steering; preserve role context. Report interrupted obligations as unavailable unless reconstruction is separately implemented. |
| Create timeout and unavailable-title rejection | Recover the original creation receipt without re-creation; proven pre-admission rejection stays known. |
| Expired grant, reordered interface revisions, owner interruption | No stale start or silent revision switch; no deadline-based claim that running work stopped. |
| Close, title reuse, external process still unresolved | Old `replyTo` never redirects; close cannot erase uncertainty or authorize unrelated process cleanup. |

For a small repeatable workflow, record sender-to-delivery delay where clocks/evidence allow, redundant final/ack messages, transcript reads used only for status, and time spent blocked on stale coordination. Missing boundaries remain unknown. Use canonical facts for aggregates; propose narrowly scoped capture additions only where current facts cannot answer. No reliability percentage or performance target is justified by this sample.

## Boundaries and decisions

Preserve host-local scope, exact live titles, identity-bound replies, explicit targeting, existing queue/settings/privacy owners, non-atomic create/configure/send, and no automatic mutation replay. No archive browser, permanent public session ID selector, generic RPC, global preferences editor, or new agent stop action is proposed.

Before implementation, settle the bounded summary's placement/retention and how much resource coordination should be host-enforced. Recommended starting point: **slices 1–2, lightweight protocol for slice 3, defer restart replay and a resource scheduler**. These are proposals, not changes to the current contract or evidence of installed behavior.
