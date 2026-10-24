# Agent session control

Pie separates information, work assignments, task results, and session lifecycle. Independent primary sessions can discover and contact unrelated live peers in the same host. Settings inheritance and model buckets retain the user's provider and execution choices. Bounded in-memory subagents keep their direct call/result workflow and read-only session discovery.

## Tools

| Tool | Purpose | Inputs |
| --- | --- | --- |
| `session_control` | List/create/read sessions, inspect/change settings, interrupt, close, clean up, or inspect an uncertain operation. | `action`; existing targets use identity-bound `address`, exact assigned `title`, or `self:true`. Creation requires title and bucket. |
| `session_send` | Give information without starting an idle turn or requesting an acknowledgement. | `target`, `message` (16 KiB UTF-8 maximum). |
| `session_assign` | Assign work to an existing live session and start a turn. | `target`, `prompt` (16 KiB maximum); optional taskId/current revision resume an awaiting-result task. |
| `session_finish` | Commit one result for the authenticated requester. | taskId, accepted revision, outcome, result (32 KiB maximum). |
| `session_wait` | Inspect task evidence or wait without model polling. | Optional 1–16 taskIds; timeoutMs 0–300000, default 60000; afterRevision is the returned record-version cursor. |
| `session_resources` | Inspect memory samples and cooperative reservations; wait for compatible availability. | action: status, acquire, start, renew, release, reclaim, or wait. Wait takes an exact name, optional mode, and bounded timeout; it returns an observation, never a lease. |

`session_control message`, `expectReply`, and manual `fulfills` entry-ID collection are no longer advertised to primary agents. Compatibility transport remains readable for historical attribution. Historical legacy creator rows alone never reconstruct a handoff after restart. A currently authenticated, newly consumed legacy `expectReply: true` message can still produce its one-shot standard `message.send` handoff to the creator; new primary tools do not advertise or establish that legacy path.

The catalog and initial-context inventory expose the same six definitions. In-memory subagents receive only session_control list/read; both transport and coordinator enforce this boundary. Tool pruning preserves an available finish tool for assignment prompts. Retained session_control also retains available session_assign and session_wait, including sticky and transitive dependency selection, so cold creation can be followed by assignment. Retained session_assign preserves available session_wait. These rules never restore tools excluded by a user or child allowlist.

## Addresses and authority

List and successful create return a compact identity-bound `pie-session:v1:` address (31 characters). Communication and existing-session lifecycle/read/settings actions accept that address or an exact assigned title; self actions use `self:true`. Historical `pie-reply:v1:` reply references remain accepted during migration. Reusing a title never redirects an old address. Paths and provisional display labels are diagnostic metadata, not target selectors.

The host's open tabs and nonterminal close operations remain the membership authority. A retained cold handle bridges only the durable-create/publication interval. Closed history is not automatically reopened. Scope is the current host/profile; cross-window and cross-machine federation are not implemented.

List, read, note and assign can cross creator boundaries. Close/delete and settings changes require self or direct durable creator ownership. Interrupt additionally permits the original requester of a worker's current nonterminal task. Cleanup selects directly owned sessions and skips running sessions by default. Human steering does not transfer creator ownership.

Live discovery intentionally exposes coarse assignment relationships (task ID/revision/state and requester address) to peers so they can avoid busy workers and contact the right participant. Task prompts and result bodies still require requester/worker identity for task inspection; diagnostic transcript read remains a separate existing permission.

## Assignments and results

Create without a prompt leaves a cold session. Its optional initial assignment prompt is limited to 16 KiB UTF-8, matching `session_assign`; larger assignments should use file references or split the work deliberately. With a prompt, it commits creation and inherited configuration before admitting an assignment. The result exposes creation, configuration, optional top-level task, message delivery, and modelSelection separately. These phases are not atomic; a configuration or send failure does not remove durable creation.

An assignment fixes requester and worker independently of who created them. A worker may own one nonterminal assignment. Busy workers reject new work, with another check at execution to prevent a racing user send from silently merging tasks.

An assignment error proves rejection only when it identifies a known pre-admission failure. A timeout, lost IPC response, generic worker failure, or unclassified backend error is unknown and reserves the worker. Correlated start, settlement, or immutable finish evidence takes precedence over a later rejected acknowledgement; the receipt remains unknown without regressing that task evidence. Inspect the original operation/task rather than submitting replacement work automatically.

At the final SDK preflight boundary, an authenticated assignment requires an active `session_finish` tool. If user policy disabled it, or the SDK cannot report its active tools, preflight rejects before the task's provider turn. This does not restore disabled tools. Ordinary user prompts retain their existing behavior.

| State | Evidence |
| --- | --- |
| accepted | Coordinator recorded the assignment; execution is not established. |
| running | Correlated semantic `live.semantic` evidence with `kind: 'turn.started'` established start. |
| awaiting-result | Execution settled without explicit finish; success is not established. |
| terminal | An immutable result exists: completed, failed, blocked, cancelled, or lifecycle-derived unknown. |
| rejected | Known execution admission failure. |
| unknown | Admission is ambiguous; the worker stays reserved until evidence or lifecycle control resolves it. |

The assigned worker calls session_finish with its task ID and accepted revision. The coordinator commits the result before notifying its requester. Identical repeated finishes return retained evidence; conflicting results or stale revisions reject. Completed is the worker's claim for the requester to verify. Ordinary final assistant output, idle state, settlement, and tab closure do not declare task success.

Every explicit finish outcome is terminal, including `blocked`: it reports that this attempt cannot continue without input. After providing input, the requester creates a new assignment; only an `awaiting-result` task can be resumed in place.

Creator, sibling and unrelated-peer assignments use the same result rule. The worker does not also send its final as a note. A requester can resume awaiting-result work with the same task ID/current revision; the revision advances and old finishes reject. Active work must settle or be interrupted first. Terminal unsuccessful attempts require a new deliberate assignment.

An authorized `session_control interrupt` of a worker cancels its current nonterminal assignment only after the host confirms interruption settled (interrupted or already stopped). An unknown or unconfirmed interruption does not become task cancellation. Task-level interruption does not release cooperative resource leases; owned work/processes still need an explicit release or verified reclaim.

## Information and waiting

Notes never start an idle model turn. A hot idle recipient gets SDK custom context with `triggerTurn:false`; an active recipient queues it at a safe boundary before its next model call. Cold recipients retain a bounded mailbox until their next ordinary run or explicit wait. Sending a note does not promote a cold worker. A question requiring new work belongs in an assignment. Note bodies are limited to 16 KiB UTF-8; task-result notification bodies are limited to 32 KiB UTF-8.

Receipts distinguish mailbox retention, SDK append, queued steering, rejection and unknown acknowledgement. Append/queue acceptance is not proof the model read the content. An SDK exception can follow persistence, so the outcome remains unknown and is not automatically retried. Admission is limited to five notes per requester/recipient pair as a burst and 20 per minute, plus 15 per recipient as a burst and 60 per minute. An identical body matching that pair's most recently admitted note within five seconds returns its previous receipt and does not send again. This also preserves prior rejected or unknown evidence; an unknown prior receipt stays unknown and cannot be retried through duplicate input.

Results follow the same non-waking policy. An armed requester wait receives committed evidence; other hot requesters get custom context, while cold requesters retain the result/notification for their next run or inspection. There is no hidden wake policy, periodic nudge, or automatic continuation after an idle requester finishes.

Use `session_wait` with taskIds to inspect or wait for those tasks; timeoutMs:0 inspects without waiting. Without taskIds, it waits for unread mailbox information, not for historical task results, and includes at most the 16 most recently changed visible task records. A result notice whose task record is omitted preserves its bounded status/result body and identifies the task for a targeted inspection; a notice whose task record is included points to that evidence in the same response. Consumed historical task records may be included in the bounded snapshot but do not make a later mailbox wait return early. Already available relevant evidence returns immediately; otherwise an event-driven bounded wait holds no provider request. Direct information can end a task-filtered wait; unrelated task notices remain for their own consumer. If cancellation wins before wait completion, unread mailbox items remain; if completion wins the race, a response may already have consumed an item before Stop or transport loss is observed. No automatic replay occurs, and task results remain inspectable. The reason distinguishes information, change, inspection, timeout, cancellation and unavailable evidence. afterRevision suppresses unchanged record versions and is distinct from the assignment revision.

Notes and result notifications use authenticated `pie.session-note` custom messages and coordinator-lifetime mailboxes. Mailboxes hold at most 64 items and 256 KiB per recipient; the coordinator-wide limit is 4 MiB across 4,096 items. Byte limits count the full JSON-encoded routing envelope, including owner/address metadata, not just the visible message body. The worker separately caps its pending SDK custom-message queue at 32 messages and 256 KiB of UTF-8 JSON for complete custom messages. It releases a pending charge only after the exact custom message starts in the SDK stream or a confirmed queue clear. A known capacity rejection happens before SDK enqueue; an SDK exception remains charged as unknown until consumption, confirmed clear, or worker collection. No queued note is replayed automatically.

An ordinary send opportunistically drains a bounded oldest-first mailbox batch through the worker's non-waking control lane. In-flight entries remain charged against mailbox capacity and cannot also be consumed by another drain or wait. Known pre-enqueue rejection/unavailability retains the entry for a later ordinary send or explicit wait; uncertain SDK dispatch removes that attempt without replay. Delivery problems produce a visible host incident before the ordinary turn continues. This incident does not itself add model context or prove the note was read. Residual mailbox information remains available through `session_wait`; ordinary-run draining is not a promise that every retained note precedes that turn.

Hot delivery uses `triggerTurn:false`; cold recipients retain messages for their next run or explicit wait. Result notification delivery is not task completion evidence: the immutable task result remains inspectable even when notification delivery is unknown or mailbox capacity is full. Task completion is explicit `session_finish`, not a legacy automatic creator handoff. Existing authenticated legacy messages remain readable for transcript compatibility.

`session_resources action: wait` takes the exact resource name, optional shared/exclusive mode and bounded timeout. It resolves when that mode is compatible, on an incoming note, timeout, cancellation or session retirement, and returns a fresh status snapshot with `acquired:false`. It does not reserve, queue, or promise priority; contenders must call acquire and may race. A status revision is advisory. Unstarted-grant expiry can make a resource available; active expiry and orphaning do not. Active expired/orphaned leases remain blocking until release or independently verified reclaim. After private owner deletion, public lease records replace the owner identity with a deletion tombstone and erase the deleted owner's address, title, purpose and prior reclaim reason; active orphaned leases continue blocking by exact lease ID.

Tool cancellation sends a private wait-cancel request. Coordinator deadlines, waiter bounds, host close and shutdown independently limit retained waits. Large multi-task responses report result truncation; inspect one task alone for its retained result. Transcript reads remain diagnostic.

## Retention and uncertain operations

Task, pending mailbox, reservation and operation evidence lasts for the coordinator lifetime. Restart does not replay assignments, reconstruct results or wake sessions. Missing/evicted evidence means unavailable, never not-executed. Delivered messages remain in their normal session histories.

The registry permits 64 nonterminal assignments, 512 retained task records and 4 MiB of logical UTF-8 text. Admission reserves result, error and state/outcome space so settlement does not depend on spare capacity. Capacity evicts old terminal evidence, never active or ambiguous work. Mailboxes admit at most 64 items and 256 KiB per recipient, with 4 MiB aggregate capacity. Results remain inspectable when notification delivery fails or the mailbox is full.

Resource coordination permits 128 occupied resource names, 256 conflicting lease holders and 256 recent terminal lease receipts. Capacity rejection creates no reservation; active, expired-active and orphaned holders are not evicted to admit more work. These are coordinator metadata bounds, not a count of qualified simultaneous model workers.

Mutations carry requestKey receipts where applicable. A lost acknowledgement includes a read-only operation.status lookup; used/stale keys cannot replay work. Unknown never licenses automatic recreation or resend. Finish uses task-identity idempotence and task inspection.

Ordinary close preserves retained results for a surviving requester and pending notes for a possible normal reopen. Privacy deletion purges associated coordinator task/mailbox evidence. Content already delivered to another conversation follows that recipient's history/privacy lifecycle.

## Settings and model buckets

Creation captures saved caller settings before durable creation: execution preferences, system-prompt choices, provider choices and bucket choices. Supported explicit overrides apply before the optional assignment. Settings changes remain session overrides rather than shared defaults; notes cannot change settings.

Independent creation starts a separate history; it does not copy the caller's conversation or previously read files. Assignments must carry relevant contract/file references, the exact expected output format, and verification requirements. Settings inheritance does not supply task context.

Creation requires small, medium or frontier and rejects settings.model. Selection filters by caller-enabled eligible providers, uses the requested bucket and descending cheaper buckets, then eligible caller-model fallback. Qualified model IDs never substitute another provider. Selected bucket reasoning applies unless an allowed explicit reasoning override wins; caller fallback inherits caller reasoning. The creation-time catalog is checked before durable admission.

Existing model/reasoning, prompt-toggle, busy-session and host-preference owners retain their validation and acknowledgement semantics. A configuration failure prevents that call's assignment while preserving already committed creation/settings. MCP discovery remains directory-local.

## Cooperative resource coordination

Status reports host total/free RAM, logical CPUs and coordinator RSS with an `observedAt` timestamp, plus up to 256 worker samples tied to worker ID/generation and PID when available. Worker RSS, heap-used and external bytes carry their own sample timestamp, age and freshness (`fresh` under 15 seconds, otherwise `stale`); absent samples report `unavailable`. The response gives total worker count and a `workersTruncated` flag when more than 256 workers exist. Worker samples describe that process, excluding child processes; model context tokens are separate. These observations do not reserve physical memory or guarantee future headroom.

Names match exactly after trimming and locale-independent lowercasing, such as checkout:pie or gpu:0; they imply neither filesystem ancestry nor OS locks. Both acquire and wait accept at most 96 Unicode code points before and after lowercasing; purposes and reclaim reasons accept at most 240 code points after trimming. Unicode normalization is not applied, so canonically equivalent spellings may name different resources. Acquire reserves a shared/exclusive grant and startBy. Start must succeed before that deadline and before resource-consuming work begins; it starts the bounded active TTL. Shared grants coexist; exclusive grants conflict with either mode. A resource waiter observes availability changes but receives no grant or FIFO/fairness guarantee; existing build/runtime/provider gates remain authoritative.

Acquire and wait default to exclusive mode; request shared mode explicitly for compatible simultaneous work. An expired unstarted reservation becomes reusable. Expired started work remains conflicting as expired-active; owner retirement makes it orphaned. Neither establishes process shutdown. The owner releases explicitly. Reclaim requires the exact leaseId, confirmStopped:true and a reason recording independently verified shutdown; it performs no OS inspection or cleanup. Existing build/runtime/provider gates remain authoritative.

An ordinary queued-message edit first checks that no tracked cross-session custom message is pending and holds a short per-session edit gate through replacement and rollback. If an earlier note is pending, the edit fails with `SESSION_NOTE_DELIVERY_PENDING` before clearing the SDK queue. A new note/result arriving while the gate is held is rejected before SDK enqueue with `recipient_queue_edit`; the sender must make a new deliberate attempt after the edit. The five-second same-body deduplication rule also applies to known rejection receipts, so an identical rejected note is not admitted again during that window. The gate releases on success and every rollback path. Explicit Stop and explicit queue clear may intentionally discard queued notes; confirmed clears also release pending-message accounting. Queue replacement does not replay a note that was consumed or an uncertain SDK send.

## Lifecycle and display

Interrupt stops active/queued work while retaining the session. Ordinary close also releases the isolated runtime through a fenced coordinator operation before reporting completed host cleanup; saved history/settings remain available for a later fresh-generation reopen. Concurrent releases join, cold release does not promote a worker, and unconfirmed process shutdown cannot report successful close. Self-close reports host acceptance before caller stop and preserves response handoff before runtime release; other closes wait for terminal cleanup evidence or report failure/unknown. A close during create/configuration cannot resurrect an old send after same-path reopen. Existing private deletion semantics remain in force.

Read preserves character budgets, opaque history/identity-bound cursors, and opt-in tool/reasoning projections. Authenticated messages show Agent plus sender and Task/Note/Result cues. Notes/results render their original body while model input carries addressing/task context. Unauthenticated lookalikes keep their original content and system attribution.

## Owners

Tool schemas: [collaboration.ts](../../harness/tools/session-control/collaboration.ts). Coordination: [session-collaboration.ts](../../harness/agent-processes/coordinator/session-collaboration.ts), [session-tasks.ts](../../harness/agent-processes/coordinator/session-tasks.ts), [session-resources.ts](../../harness/agent-processes/coordinator/session-resources.ts). Membership/settings/lifecycle composition: [server.ts](../../harness/agent-processes/coordinator/server.ts). Non-waking SDK delivery: [session-notes.ts](../../harness/agent-processes/workers/session-notes.ts). Current design and validation: [session coordination v2](../plans/SESSION-COORDINATION-V2.md). Historical evidence: [cross-session investigation](../plans/CROSS-SESSION-COMMUNICATION-AND-CONTROL.md).
