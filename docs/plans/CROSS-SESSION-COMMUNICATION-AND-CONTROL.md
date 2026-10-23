# Cross-session communication and control

Working research and redesign proposal — revised 2026-10-24. No production changes or live failure injection. Proposed operations below are **not available APIs**.

## Recommendation

**Separate work assignment from information, and make results belong to tasks rather than conversations.** Keep bounded subagents as the default; use independent primary sessions only when ongoing coordination or human steering warrants them.

The first version of this proposal leaned too heavily on improving guidance and receipts around the existing design. That is insufficient: Pie currently makes an agent decide whether the same message is information, new work, an intermediate reply, or a final handoff, with different rules for creators and peers. More evidence would make those rules inspectable, not necessarily easier to follow.

Research supports testing a simpler task-and-notification interface, **not claiming it already improves agent performance**. Compare it against both the current interface and a guidance-only simplification before shipping. A scheduler, cross-window bus, and restart replay are not prerequisites.

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

## What the current interface asks the agent to infer

The [tool](../../harness/tools/session-control/index.ts), [message envelope](../../harness/agent-processes/lib/rpc/session-control-attribution.ts), [delegated worker](../../harness/agent-processes/workers/delegated-session.ts), and [settlement handler](../../harness/agent-processes/workers/session-event-lifecycle.ts) establish these source facts:

| Agent-visible choice | Implemented behavior | Why it is a design risk, not just missing telemetry |
| --- | --- | --- |
| “This is information; no answer needed.” | `message` with `expectReply:false` still wakes an idle target. | Reply intent and execution intent are different. A no-ack instruction does not prevent an unnecessary turn. |
| “I have answered the request.” | A creator request can receive an automatic final; a peer request needs explicit `message` to `replyTo`. | The answer mechanism depends on who created the session, not just the current request. |
| “Send the final now.” | A manual delegated final needs `fulfills` containing consumed creator input entry IDs, exact creator `replyTo`, and `expectReply:false`. Other sends are intermediate. | The model must retrieve storage identifiers and understand automatic-completion suppression to avoid a second report. |
| “The final was sent.” | A claim is written before dispatch; a failed/unknown attempt suppresses the automatic handoff for those inputs. | Duplicate suppression is not delivery confirmation. The sender may have finished while the requester still lacks the result. |
| “The task is complete.” | At `agent_settled`, the worker selects the last assistant message after the last tracked creator input and derives completed/error/cancelled. | This is an execution boundary, not an explicit semantic declaration that a particular assignment was satisfied. |
| “Wait until the child finishes.” | `read` exposes conversation/activity; `wakeup_timer` also supports `session_finished`. | Activity is not assignment completion. The existing trigger is useful but not a correlated task-result wait. |

The creator role survives prompt rebuilds and restart; interrupted in-memory obligations do not reconstruct. Messages delivered within one request can be grouped into a handoff. A message saying “pause” remains ordinary queued input, not proof of interruption. Title addressing and identity-bound replies solve different problems; successful routing (E4) does not settle the issues above.

**Evidence limit:** these are reproducible protocol rules and plausible confusion mechanisms. E1–E10 show workflow failures and successes, but do not prove which rule caused a model mistake. No controlled model comparison has run. In particular, no evidence shows that deploying the checked-in reply-intent code alone would fix the historical sample.

### Checked locally in this research

At source baseline `4c438d491`, **25 focused tests passed** across [tool](../../harness/tools/session-control/test/session-control-tool.test.ts), [attribution](../../harness/agent-processes/lib/rpc/test/session-control-attribution.test.ts), and [delegation/settlement](../../harness/agent-processes/workers/test/delegated-session.test.ts). They cover reply guidance, creator-only accumulation, explicit fulfillment claims, lost-ack handling, and settlement versus `agent_end`.

Command: `proto run pnpm -- run test:file --sdk-path application/hosts/vscode/out/pi-runtime/node_modules/@earendil-works/pi-coding-agent harness/tools/session-control/test/session-control-tool.test.ts harness/agent-processes/lib/rpc/test/session-control-attribution.test.ts harness/agent-processes/workers/test/delegated-session.test.ts`. The materialized runtime was independently checked with `verifyPiRuntimeArtifact` first. These are source/helper tests using compiled SDK aliases, not live model, transport-reliability, or installed-generation qualification. The schema advertised to this investigation still lacks the source's reply-intent fields.

## External comparison: borrow semantics, not a product's tool names

### Codex: implementation, not just tool descriptions

Source pin: [`970111f6cb62cc02fe36a82ea7d71b37a2889c97`](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97), retrieved 2026-10-24. This is not a claim about an installed release. The newer multi-agent v2 path must not be conflated with the older `send_input` / final-status wait path.

- [`send_message`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs) selects `QueueOnly`; [`followup_task`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs) selects `TriggerTurn`. The [shared handler](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs) resolves the target and submits through the same controller. This is an explicit difference in intent, not separate transport infrastructure.
- **Correction to the earlier comparison:** “informational messages never wake an idle agent” is too absolute. [`reserve_pending_work_turn` / `should_wake_on_agent_messages`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/turn_input.rs) can admit pending-mail work for a non-interrupted root when `WakeOnAgentMessages` and collaboration-mode conditions permit it. An outstanding durable sleep is another admission path. Queue-only submission and the receiver's wake policy are distinct; the tool description alone does not establish liveness.
- [`wait_agent` v2](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs) subscribes to input-queue activity, checks already pending activity, and waits with a bounded deadline. It returns a brief mailbox/steered/timeout result, not the child's result body. Waiting for mail is not waiting for task success.
- [`notify_parent_of_terminal_turn`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/agent/control/completion.rs) routes terminal child results to the structural parent with `trigger_turn:false`. Delivery is explicitly best effort; metrics distinguish queued from failed. An initiating peer can receive completion activity without being the destination of the parent result. Automatic parent routing is not a universal requester/result protocol.
- [`interrupt_agent`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs) interrupts current work without closing the worker. This is useful separation, not evidence that arbitrary external processes stopped.
- The [tool specifications](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) describe canonical/relative agent-tree paths, automatic child finals, and sparse waiting only on the critical path. They do not demonstrate arbitrary messaging between unrelated chats/windows or improved task quality.

**Takeaway:** explicit assignment intent and event-driven waiting are strong precedents. Copying Codex wholesale would also import parent/requester distinctions and wake-policy complexity that Pie should evaluate, not hide.

### Claude Code: three different coordination scopes

Official documentation retrieved 2026-10-24; these are documentation claims, not inspected internals or verified installed behavior:

| Scope | Documented model | Relevant limit / lesson |
| --- | --- | --- |
| [Subagents](https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background) | Foreground calls block; background results arrive through completion notifications. Named subagents can be resumed through messaging. | Result-oriented delegation is the simplest default. Waiting/resume behavior is version/mode-dependent; do not treat every worker as an independent chat. |
| [Agent teams](https://code.claude.com/docs/en/agent-teams.md#context-and-communication) | Direct teammate messages, shared tasks/dependencies, automatic idle/final notifications; a lead coordinates and synthesizes. | [Experimental and disabled by default](https://code.claude.com/docs/en/agent-teams.md#enable-agent-teams). [Limitations](https://code.claude.com/docs/en/agent-teams.md#limitations) explicitly include lagging task status, in-process resume gaps, and slow shutdown. A shared board is not proof of completion. |
| [Independent sessions](https://code.claude.com/docs/en/cross-session-messaging.md#message-delivery) | `ListAgents` / `SendMessage`; busy recipients read between tool calls, idle recipients start a turn. Local transport is a socket/named pipe; cross-machine transport differs. | Closest to Pie's broad session messaging, not to agent-family delegation. Cross-session messaging has its own version/provider/inbound-control constraints. It does not eliminate information-triggered turns. |

The [idle-notice subscription](https://code.claude.com/docs/en/cross-session-messaging.md#get-a-notice-when-another-session-goes-idle) can be requested without sending text or spending tokens in the watched session; it fires immediately if already idle and expires after 12 hours. Notices can wake the requester, and inbound controls can hold/refuse them. It observes idle/exit, **not verified task success**. Team [shutdown](https://code.claude.com/docs/en/agent-teams.md#shut-down-teammates) is a cooperative request that a teammate may reject, unlike Pie's forceful stop-and-close lifecycle.

**Takeaway:** task-result delegation, team collaboration, and independent-session messaging need distinct expectations. Neither product is evidence that “more messaging” or a task board alone solves coordination.

## Alternatives considered

| Approach | Benefit | Main objection / decision |
| --- | --- | --- |
| Guidance and receipts only | Smallest change; preserves current API. | Keep as the control condition, not the assumed solution. It retains creator/peer reply branching and implicit task boundaries. |
| Mailbox split only: information versus work | Makes execution intent clear; can reduce incidental turns. | Strong minimal candidate, but still needs a result owner and an explicit idle/wait policy. |
| **Task-backed assignments plus information channel** | Makes requester, revision, and result explicit independent of session creator. | Preferred hypothesis. New state/operations can themselves burden agents; must beat the simpler split in trials. |
| Full shared task board, scheduler, locks, durable replay | Can manage complex dependencies and resources. | Not justified as a first response. More independently maintained state and recovery rules can worsen the original problem. |

## Candidate operating model

### Ordinary case: do not coordinate a team to obtain one answer

Use Pie's existing bounded `subagent` for a focused task with a direct result. It already has a call/result relationship. Independent primaries remain useful for sustained parallel work, human intervention, and peer exchanges; they should not be the default substitute for every subagent.

For primary-session assignments, the agent should normally need to know only:

1. Assign a bounded task and name its expected result and ownership.
2. Continue independent work; wait for a relevant result only when blocked.
3. Finish the named task once; the runtime makes the result available to its requester.

### Work plane versus information plane

The names below illustrate **logical operations**, not a settled tool catalog or implementation approval:

| Operation | Candidate meaning |
| --- | --- |
| Assign / delegate | Give a live worker a new task, or create/configure a worker with its first task. Return a task handle and separate session/configuration/admission outcomes. Assignment wakes an idle worker; busy admission is explicit, not silently merged. |
| Note | Give context linked optionally to a task. No reply obligation, no new assignment, and no implicit permission to start work. Deliver to an active worker at a safe boundary; otherwise retain until that worker next runs. |
| Finish | Worker records `taskId`, accepted revision, outcome, concise result and evidence. The requester is fixed by assignment, whether creator or peer. No manual reply reference or input-entry-ID collection. |
| Inspect / wait | Return bounded task state/result, or wait for a version change/result/user steering/deadline. Already available results return immediately. Transcript reads remain diagnostic, not the routine result channel. |
| Amend / cancel | Explicit task-scoped control. Revisions prevent silently overwriting newer instructions. Cancellation acknowledgement is separate from confirmed execution teardown. |

Keep session settings and close on the control surface; do not bundle persistent configuration changes into ordinary information messages. Creating/configuring/sending remains non-atomic unless separately redesigned. Task handles identify work, not new general-purpose session addresses; preserve authenticated, live identity resolution and title-reuse protection.

### A result is a record, not a message the parent must catch

An assignment needs one authoritative record: requester identity, worker identity, task handle, accepted revision, scope/stopping condition, current state, and an optional terminal result/evidence pointer. It references existing execution/request/operation lineage; it does not replace those authorities or reinterpret send acceptance as task success.

Candidate task states: queued, running, blocked, awaiting-result, terminal. Terminal outcomes distinguish worker-reported completion, failure, and cancellation. Model-reported success remains a claim for the requester to verify. Blocked/needs-input is not successful completion. Idle, a settled run, an expired deadline, and a closed tab are not success states.

Prefer testing **explicit `finish` for primary assignments** instead of scraping the latest assistant text. Finishing commits one immutable result before notification; duplicate same-intent finishes return that result, while conflicting/stale-revision finishes reject. A lost acknowledgement does not license a new task or different result. The ordinary subagent's direct final-return path remains unchanged.

The tradeoff is real: an explicit finish adds a tool call and can be forgotten. If a worker settles without one, expose awaiting-result rather than invent success; failures/interruption may be recorded only from owning lifecycle evidence. Test this against a task-correlated automatic-final variant. Do not build an auto-retry/nudge loop to conceal missing finishes.

Result availability, notification enqueue/delivery, and requester consumption are separate facts. Read-only inspection/wait must recover an available result after notification loss without re-executing work. Storage ownership, commit atomicity, retention and restart visibility must be settled before claiming durable recovery. A prototype may be coordinator-lifetime only and must report unavailable after loss; do not add a second, independently authoritative task mirror.

### Non-waking notes need a liveness rule

A note is genuinely non-waking in this candidate—not merely a queue-only submission followed by a hidden automatic wake. Therefore an idle peer will not answer a question sent as a note: a question requiring work must be an assignment.

A result arriving while its requester is actively waiting satisfies that wait; active requesters receive coalesced result evidence at a safe boundary. If the requester is idle, retain the result for inspection. Autonomous continuation requires an **explicit one-shot result subscription**, armed before yielding, with already-completed checks; it is not enabled for every message. Otherwise quiet delivery could strand the parent forever.

Evaluate adaptation of existing [deferred triggers](../contracts/DEFERRED-TRIGGERS.md) before introducing another wake registry. `session_finished` already observes streaming completion, but it is not task-correlated and must not be relabeled as task success. Bound waits/subscriptions; handle user steering, cancellation and lost owners explicitly. No polling LLM turns or periodic “still waiting” traffic.

### Shared resources remain a separate correctness problem

A task result does not grant a shared-checkout freeze or release a fixture server. E1/E7–E9 need explicit resource/interface owners, revisions, latest-start deadlines, acknowledged start and confirmed release. An expired grant cannot start work. A running deadline triggers escalation, not proof a process stopped. Prefer serializing conflicting whole-checkout checks over adding more negotiated messages.

Preserve existing close/privacy/queue owners. Close stops and closes; it is not pause, a result-delivery guarantee, or independent evidence that detached processes exited. An explicit task-cancel operation would be a separately approved new agent capability, not something available through today's schema. Human steering must not silently transfer task ownership or allow bulk cleanup to interrupt a human's work.

## Test the explanation before implementing the redesign

### Falsifiable hypotheses

| Hypothesis | Distinguishing prediction |
| --- | --- |
| H1: mixed information/execution intent creates unnecessary work | Splitting note from assignment reduces incidental turns and acknowledgement traffic on the same schedules, without increasing missed requested answers. |
| H2: creator-dependent reply rules cause misrouted/missing/duplicate results | Task-fixed requesters reduce these errors on matched creator and peer assignments. If only guidance changes help equally, task records may not be worth their cost. |
| H3: implicit settlement is an unreliable semantic task boundary | Explicit finish reduces false completion under steering/revision changes; forgetting to finish is measured as a competing failure, not hidden by retries. |
| H4: stale advertised/runtime behavior explains some confusion | Matching tool schema, guidance and runtime changes outcomes even with the existing design. Qualify this before attributing failures to a new protocol. |
| H5: shared resources or task decomposition dominate | Clean read-only/disjoint tasks improve but conflicting snapshot/resource tasks still fail. Fix ownership/scheduling rather than enlarging the message API. |

### Evaluation sequence

1. **Qualify the baseline:** capture registered schema, effective guidance, loaded artifact identity and relevant flags. Use the same model/provider/reasoning and ownership rules for each arm. The present source/runtime-surface mismatch prevents a fair live comparison today.
2. **Deterministic protocol fixtures:** test admission, already-finished races, revision handling, finish idempotency, notification loss, cancellation and unavailable evidence without models. These establish mechanics, not usability.
3. **Disposable-host agent trials:** compare (A) current qualified interface, (B) simplified guidance with existing mechanics, (C) explicit note/assignment split, then (D) task-backed results if C leaves result ambiguity. Use the same sanitized work items and delivery schedules; no writes to the user's checkout or live sessions. Start with a small pilot, then predeclare repetitions, budgets, scoring and stopping rules before the measured run. Test explicit versus automatic task-correlated finals only if D is warranted.
4. **Judge outputs, not just tool success:** score requested deliverable correctness first; separately record missing/duplicate results, wrong-recipient replies, false completion, forgotten finishes, unnecessary wakes, transcript polling, latency and coordination cost. Blind artifact scoring to interface where feasible; retain failed/time-limited runs. Report per-scenario counts and uncertainty, not a single reliability percentage from a tiny sample. Use canonical analytics for actual usage/cost and coverage limits; do not infer costs from transcript size.
5. **Only promote a demonstrated improvement:** lower chatter with missing work is failure. Reject added task machinery if the split/guidance arm is equally effective. Keep protocol changes behind one isolated rollout path until compatibility and lifecycle qualification pass.

### Minimum scenario matrix

| Scenario / evidence | Required property of the candidate |
| --- | --- |
| Delayed final; requester asks status before arrival (E3) | One task result, no acknowledgement cascade; status lookup does not create another assignment. |
| Creator, sibling, unrelated peer ask the same bounded question (E4) | Result belongs to the actual requester under one rule; a note requires no reply. |
| Idle recipient; requester waiting versus finished | Notes do not wake; assignments do. Results satisfy an armed wait/subscription or remain available without hidden execution. |
| Assignment followed by amendment; busy worker receives another task | Distinct task/revision evidence; no silent merge or stale finish. Busy workers reject/queue explicitly with bounded admission. |
| Worker settles without finish; human steers; provider errors (E10) | No invented success. Missing finish, blocked input, failure and cancellation remain distinguishable. |
| Lost send/finish acknowledgement; lost result notification (E2/E6) | Inspect original evidence/result; never recreate or re-execute blindly. Unavailable stays unavailable. |
| Unavailable title; close and title reuse (E5) | Known rejection stays known; identity-bound work/results never redirect to the new title owner. |
| Late grant; competing interface revisions; checkout snapshot (E1/E7–E9) | No stale start, silent revision switch or false release. Messaging success does not excuse resource conflicts. |
| Requester closes, host restarts, cancellation races finish | No reopening or auto-replay. One authoritative outcome only when evidence permits; otherwise explicit uncertainty. |

## Scope and decision gates

This research updates the recommendation; it does not amend the [current contract](../contracts/AGENT-SESSION-CONTROL.md) or qualify a deployed fix. No live-session mutation, production prototype, controlled model trial, runtime build or publication was performed. The focused source tests establish existing semantics only.

Before production implementation, decide: (1) note versus task-result wake policy, (2) explicit versus task-correlated automatic finish, (3) authoritative task storage/retention and lost-owner behavior, (4) busy-worker admission and human-steering conflicts, and (5) migration of existing creator obligations without dual finals. Resolve these through the bounded prototype/evaluation, not another layer of prose in every message.

**Next deliverable:** a disposable-host comparison of the current interface, guidance-only baseline and note/assignment split. Add task-backed results only if that experiment supports the extra machinery. Defer a full team scheduler, general locks, restart replay, public permanent session IDs and cross-window federation.
