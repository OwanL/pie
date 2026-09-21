# Agent workflows investigation

**Status:** Design investigation, not an implementation contract. No runtime changes are authorized by this document. Findings describe the inspected checkout and a small historical trace sample on 2026-09-20, not verified deployed behavior.

## Goal and design direction

Improve agent-native coordination, asynchronous work, change review, and tool guidance without encoding task-specific workflows such as PR babysitting into the harness. Prefer useful primitives and guidance that let agents choose the workflow.

The user proposes allowing main agents to create ordinary persistent sessions, inheriting applicable session controls, choosing the new session's root model through the existing small/medium/frontier buckets, and using context controls similar to current delegation. Exact tool surfaces and implementation remain open. Parent/subagent coordination and collaboration between independent sessions are both in scope.

## Confirmed design decisions

### Independent lifetime

An agent-created persistent session continues independently until explicitly stopped. Its creator finishing, being interrupted, or being closed does not implicitly cancel it. A session may complete its current task and become idle; independent lifetime does not imply continuous model execution.

This is a target behavior, not current subagent behavior. Existing awaited subagents are cancelled with their parent invocation. Shutdown/restart recovery, explicit stop scope, retained parentage, and UI treatment remain open.

### Primary sessions and subagents remain distinct

Creating a primary session is a separate capability from the existing `subagent` workflow. Keep current temporary, awaited delegation rather than converting every subagent into a persistent primary session. An agent-created primary session has the independent lifetime described above.

Sharing model selection, context-handoff code, or coordination mechanisms is an implementation possibility, not a decision to unify their lifecycles. Which communication tools temporary subagents receive remains open.

### Settings inheritance is a creation-time snapshot

An agent-created primary session inherits the creator's effective session-specific settings once, at creation. Later changes to the creator do not propagate to existing created sessions. The created session can subsequently be configured independently.

Which controls are session-specific versus explicitly global still needs definition. This decision does not turn the currently runtime-wide autonomous-mode control into a per-session setting by itself.

### Local primary sessions can discover and message each other

An agent may discover and message any local primary session, not only sessions it created or sessions sharing a repository. Creator lineage and working directory may help filtering and relevance but do not define the communication boundary.

Directory metadata, historical-session visibility, and stopped/unavailable recipient behavior remain open. This decision does not imply copying every session's conversation into the caller's context.

### Direct messages wake idle sessions

An addressed agent-to-agent message automatically wakes an idle recipient session. Agents should not need to poll for direct messages or pre-register a subscription to receive them.

Delivery to busy, explicitly stopped, closed, or unavailable recipients is not yet specified. Shared-board posts are distinct from addressed messages; their notification behavior remains open.

## Current-state findings

### Delegation and communication

- The exposed `subagent` tool delegates one task and awaits its result. Independent sibling calls can execute concurrently. There is no exposed operation to address and message an already-running child.
- Children have isolated context but share the process, filesystem, and credentials. Their session managers are in memory, not independently durable sessions.
- Pi's pinned SDK supports `steer` and `followUp`; those APIs are not themselves an agent-facing cross-session messaging surface in Pie.
- Delegation is task-only by default. `userContext: latest | all` adds user prompts and successful clarifications from the active branch, bounded to 12,000 characters. It does not copy parent findings, reasoning, or tool output.
- Tool availability is agent-frontmatter driven with a configurable drop list. Workers are unrestricted by default; scout and reviewer have narrower tool sets. Skill selection and tool selection have different inheritance rules.

Owners: [subagent reference](../extensions/subagent/README.md), [schema](../extensions/subagent/schema.ts), [runner](../extensions/subagent/runner.ts), [context handoff](../extensions/subagent/src/user-context.ts).

### Session changes

- Successful completed subagent results preserve nested transcripts, which the parent's JSONL-derived manifest scans for edits. A running child's changes are not available through this durable-result join yet.
- The default `session_changes` invocation requires a persisted session path. A worker can inherit the tool but cannot use that default against its own in-memory session. Supplying a parent's path inspects the parent, not the child's current transcript.
- Arbitrary shell writes are not captured. Recognized shell deletions and edit/write-like calls are derived heuristically; this is not a filesystem mutation journal.
- Focused diffs use Git baselines, not session-start file snapshots. Pre-existing hunks can therefore appear. Git worktree checks remain useful, and current tool guidance explicitly requests them separately.
- Child-relative paths are accumulated against the parent session's cwd without preserving the child's different cwd. A historical trace confirms a parent rooted at `C:\dev` delegated to `C:\dev\repos\pie`, received paths such as `extension/src/backend/worker-frame-io.ts`, and got `no git baseline` from the focused diff. A subsequent repository-scoped Git diff supplied the missing patch. Later absolute parent edits produced separately spelled entries for the same file.

Owners: [tool and guidance](../extensions/session-changes/index.ts), [JSONL derivation](../extensions/session-changes/src/session-jsonl.ts), [shared derivation](../extension/src/shared/file-change-derivation.ts).

Trace evidence: session `01a0bbd8-884b-71a7-9340-58b18b4a3df5`, entries `506a43b7`/`bcb8ddce` (worker dispatch/result), `6c17abbe` (manifest), `45ff7bbe` (missing patches), `6a986d13`/`2f900de0` (Git fallback), and `888211ab` (later manifest). A five-session convenience sample found four `session_changes` calls, no `defer_trigger` calls, and no shell-sleep polling. This does not establish prevalence or disprove the user's other observations.

### Deferred triggers

- Registration persists a wake-up and does not abort the active turn. The required message is replayed to the selected target session when a condition fires; list/cancel remain creator-scoped.
- The tool can be pruned on initial requests. Synthetic deferred wake turns protect it from pruning.
- Timer, user-input, session-finished, and bounded command-predicate conditions are available. There is no native CI/review-comment condition; those workflows need periodic re-checking or an event integration.
- All actions require the calling session's persisted path, so current in-memory subagents cannot successfully use this tool even if inherited.
- Delivery is host-managed and currently requires an open target session. Closed or unavailable targets are not silently redirected; existing recovery and at-most-once dispatch behavior must be considered before promising independent background/restart support.
- Short bounded process waits can reasonably remain shell operations. Longer monitoring needs an explicit wake-up primitive; replacing every shell sleep is not a goal.

Owners: [contract](DEFERRED-TRIGGERS.md), [tool](../extensions/deferred-triggers/index.ts), [pruner](../extensions/skill-pruner/src/register.ts).

### Reusable session infrastructure and constraints

- Durable session creation already flows through host commands/reducer effects, lifecycle serialization, and a backend creation ledger. A new tool should integrate with that lifecycle rather than bypass host ownership.
- Bucket selection already handles provider/capability constraints, but is currently coupled to subagent invocation. Reuse needs a session-creation boundary and persistence of the selected model/thinking level.
- Some provider controls have per-session overrides. Autonomous mode is currently runtime-wide, not a durable per-session setting that can simply be copied.
- Applying inherited model settings must not accidentally change global defaults. Durable creator relationships are separate from existing operation/analytics linkage.

Owners: [host tab actions](../extension/src/host/session-service/tab-actions.ts), [session commands](../extension/src/host/core/reducer/command-session-handlers.ts), [creation ledger](../extension/src/backend/create-operation-ledger.ts), [model selection](../extensions/subagent/src/selection.ts), [settings types](../extension/src/shared/protocol/settings.ts).

## Research and its limits

- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams): product precedent for separating task ownership/dependencies from direct messages. Shared files still need coordination. Vendor documentation, not comparative evidence that this architecture is optimal for Pie.
- [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md): product precedent for discovery, active delivery between tool calls, and idle-session wake-up. A shared board alone does not supply delivery semantics.
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): recommends workflow-oriented tools and realistic outcome/cost evaluations, rather than exposing every low-level operation.
- [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system): describes bounded delegation and external artifacts, while reporting substantially higher token use for multi-agent work. Its research-task results must not be generalized to tightly coupled shared-repository editing.
- [Towards a Science of Scaling Agent Systems, v3](https://arxiv.org/abs/2512.08296v3): controlled evaluation across 260 configurations finds strong task/architecture dependence and coordination overhead on tool-heavy tasks. It does not establish one universally best topology.
- [Why Do Multi-Agent LLM Systems Fail?, v3](https://arxiv.org/abs/2503.13657v3): 1,600+ annotated traces, with failure categories spanning system design, inter-agent misalignment, and verification. More messaging is not by itself a remedy.
- [SE-Blackboard dataset](https://doi.org/10.5281/zenodo.18911614): relevant comparison of message passing, blackboard, and hybrid modes on 50 SWE-bench Verified issues. Only dataset metadata was inspected; the paper was not readable through the fetch surface. No performance conclusion is adopted from it.

## Candidate mailbox model (not decided)

The user clarified that “message board” means a dedicated messaging tool surface with optional recipients or recipient exclusions, where an agent retrieves messages assigned to it that it has not already seen. This is closer to a shared message store with per-session inboxes than to a structured task board. The user has not chosen polling versus event-driven delivery.

Separate durable storage/routing/read state from notification and wake-up. A persisted inbox can support explicit reads, harness-driven delivery, or blocking/event waits without requiring repeated model-driven polling. Direct messages waking idle sessions is already decided; broadcast wake behavior is not.

Candidate semantics to evaluate: bounded unread batches; stable message IDs and per-recipient delivery state; historical read/search; explicit send-time recipient expansion for broadcasts/exclusions; notification coalescing; and a distinction between delivered-to-context and acted-on acknowledgement. These are proposals, not agreed requirements. Avoid promising exactly-once external actions merely because message delivery is tracked.

### Closer implementation precedents

- [Pi Messenger](https://github.com/nicobailon/pi-messenger): same-runtime precedent for a registry, per-recipient file inboxes, and harness-driven wake-up through `pi.sendMessage` with `triggerTurn: true` and `deliverAs: steer`. The inspected [store](https://raw.githubusercontent.com/nicobailon/pi-messenger/main/store.ts) watches inbox files and deletes them after delivery, including on read/parse/delivery failure. Its UI unread counters are in-memory, not durable processing acknowledgements. Useful push-delivery precedent, not a durability contract to copy unchanged.
- [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail): durable mail/thread history with recipient-specific read/ack state. The inspected [implementation](https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail/main/src/mcp_agent_mail/app.py) exposes non-mutating `fetch_inbox` with `unread_only`, separate read/ack operations, and broadcast expansion. Optional local notification signals supplement retrieval; model polling is not the only possible client integration. Current source and quick-reference docs differ on broadcast support. Timestamp-based retrieval is not a robust opaque cursor with ID tie-breaking.
- [AgentBus](https://github.com/jahwag/agentbus): its [README](https://raw.githubusercontent.com/jahwag/agentbus/main/README.md) specifies durable per-recipient receipts, stable delivery IDs, wait/ack, restart recovery, and at-least-once redelivery. This is a useful reliability comparison, not independently exercised behavior or a reason to import a separate daemon into Pie.

These are implementation/documentation comparisons, not controlled measurements showing that one interface produces the best coding-agent outcomes. Upstream `main` sources were inspected on 2026-09-20 and may change.

### Major-lab coding-agent interfaces

The user questioned whether an exposed mailbox/board adds steps to ordinary agent messaging and requested stronger major-lab comparisons. Current verified references:

- [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging): `ListAgents` discovers recipients and `SendMessage` sends text. A busy recipient reads between tool calls without interrupting the running tool; an idle recipient starts a turn. `notify_when_idle` can register a one-shot notice without waking the watched session, and the documentation explicitly says neither side polls. These are documented product semantics, with version requirements on the source page.
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams): automatic message delivery and final-answer/error notifications; the lead need not poll. Its underlying mailbox files do not require an agent-facing fetch/read/ack loop for normal delivery.
- [Codex subagents](https://developers.openai.com/codex/subagents) and current [tool-spec source](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs): hierarchical child threads, spawn/follow-up/wait/close operations, and automatic final-status notifications. The inspected V2 specification distinguishes `send_message` (does not trigger a new turn) from `followup_task` (wakes an idle non-root target, or delivers at message/tool boundaries when running). Its `wait_agent` waits for mailbox activity rather than requiring rapid polling. Discovery is within the current root thread tree, not arbitrary independent local sessions. These V2 statements describe source tool contracts, not verified availability in every installed Codex release.

Revised working recommendation, not an additional confirmed decision: expose direct messaging and automatic delivery as the ordinary workflow. Keep queues, durable delivery bookkeeping, and batching inside the harness. Add history retrieval only where useful; do not require models to post, poll, mark read, and acknowledge every ordinary message. A separate shared-board abstraction should justify itself with needs direct messaging and linked artifacts do not meet. The previously confirmed direct-message wake behavior aligns more closely with Claude Code than Codex V2's non-waking informational message.

## Open design questions

1. Session-specific settings are snapshotted at creation. Which controls are session-specific versus global restrictions? Does autonomous mode become genuinely per-session?
2. Primary-session creation is distinct from subagent delegation. Which callers can create primary sessions, and what limits prevent accidental unbounded spawning? Which coordination tools also apply to temporary subagents?
3. Is bucket choice resolved once at creation? What fallback and model-change behavior applies later?
4. Any local primary session is discoverable/messageable. What directory metadata and filters are exposed, which historical sessions are listed, and how is creator lineage retained without implying lifecycle ownership?
5. Direct messages wake idle recipients. What are delivery boundaries for busy recipients, acknowledgement and ordering semantics, and behavior for stopped, closed, or unavailable recipients?
6. The user's candidate is addressed/excluded-recipient messaging with per-agent unseen-message retrieval, not necessarily task scheduling. How are broadcast audiences resolved, do broadcasts wake recipients, and what prevents context growth? How are retrieval, durable delivery, and explicit acknowledgement distinguished?
7. What delivery and recovery guarantees should deferred triggers have after tab close, host shutdown, or restart?
8. Which change scope is requested: this session, awaited delegation descendants, independently created sessions, or the entire worktree? How are provenance and baseline limitations made explicit?
9. How should created sessions appear to the user, and what can be stopped individually or together?

## Candidate verification scenarios

- Parent and worker use different working directories; returned paths resolve correctly and merge with parent edits.
- A worker reviews its own edits; the parent reviews completed descendants without unrelated worktree attribution.
- A parent creates a session, continues working, and closes without cancelling it.
- Active and idle recipients receive a message at the documented boundary, without duplicated work or invented acknowledgement.
- An agent schedules a future check while continuing work, versus explicitly yielding until a condition is met.
- A PR-watch-like task resumes with bounded useful context, terminates its obligation appropriately, and avoids repeated unchanged-result model work.
- Concurrent agents touch the same file or encounter pre-existing changes; review surfaces state what they can and cannot attribute.

Evaluate task outcome, invalid calls, redundant content reads, coordination tokens, latency, and recovery behavior across representative model buckets. Compare simple alternatives before expanding tool surface area.
