# Pie stability architecture plan

**Status:** working plan
**Scope:** Pie extension host, webview, backend coordinator, session workers, bundled Pi extensions, persistence, accounting, and local build/install workflow
**Updated:** 2026-09-05

## 1. Purpose

Make Pie dependable during long-running and concurrent work while improving the clarity and speed of the user experience and reducing the cost of future changes.

This is an outcome-oriented plan, not a file-by-file refactor list. The evidence appendix names current seams so findings can be reproduced, but implementation agents are free to change boundaries when a better design satisfies the contracts and acceptance criteria below.

## 2. Desired outcomes

Pie should provide these guarantees:

1. **A user action has one lifecycle.** Send, continue, edit, interrupt, compact, wake, create, and open each have an explicit identity, owner, commit point, and terminal outcome.
2. **Acceptance is not completion.** A transport acknowledgement never implies that provider work, persistence, or rendering completed.
3. **Ambiguity is represented honestly.** A local timeout is not reported as failure when remote work may still commit. Late evidence resolves the operation without duplicate user-visible errors.
4. **Active work survives presentation failures.** Renderer reloads, browser disconnects, and ordinary builds do not stop a healthy session.
5. **Interrupt means spend has stopped or recovery is explicit.** Every provider, retry, history-compaction, branch-summary, shell, and tool window is included in the cancellation barrier.
6. **Usage is conserved.** Every billable invocation is recorded once, attributed when possible, and shown as exact, estimated, or unpriced rather than silently becoming zero.
7. **Resume behavior is unambiguous.** Empty continuation, a new user prompt, and an automatic wake-up are distinct operations and never produce duplicate prompts.
8. **The UI exposes capabilities, not guesses.** The backend or host authority decides whether continuation, interruption, editing, or compaction is available; renderers do not infer it independently from a partial transcript.
9. **Agent exploration is bounded by default.** Generated, vendored, build, cache, session, and runtime trees are excluded from broad traversal unless the caller deliberately opts in.
10. **Complexity follows domain boundaries.** Large orchestration modules are split where ownership or lifecycle changes, not merely to meet a line-count target.

## 3. Scope and non-goals

### In scope

- Session lifecycle, mutation ordering, runtime replacement, and crash recovery.
- Message submission, queued follow-ups, editing, interruption, continuation, and automatic wake-ups.
- History compaction and other auxiliary model calls.
- Token, cost, working-time, and run accounting.
- Error classification, notices, diagnostics, and recovery affordances.
- Host-to-renderer synchronization where it affects stability.
- Build, watch, package, install, and activation behavior around active sessions.
- Process ownership and cleanup.
- Search/file-traversal guardrails for root agents and subagents.
- Dead systems, duplicated implementations, large modules, historical comments, documentation structure, and test architecture.

### Non-goals

- Replacing the pinned Pi SDK or changing its public semantics unnecessarily.
- A wholesale rewrite of the CQRS/Elm-style MVI host.
- Security work unrelated to stability or user experience.
- Refactoring every large file or eliminating all duplication mechanically.
- Preserving accidental behavior solely because current tests encode it.

## 4. Audit basis and confidence

The audit used the working tree on 2026-09-03. It was already heavily modified before this document was created, including active work in accounting, history compaction, host state, protocol, and webview code. Every implementation slice must therefore revalidate its finding against the then-current tree.

Evidence sources:

- `docs/ARCHITECTURE.md` and the authoritative `docs/STATE_CONTRACT.md`.
- The locked Pi SDK, RPC, and extension documentation under `extension/node_modules/@earendil-works/pi-coding-agent/`.
- Host, backend, worker, webview, extension, build, persistence, analytics, and test code.
- Targeted dead-code, duplicate, complexity, large-file, and Markdown-drift scans.

Findings below use three confidence labels:

- **Confirmed:** current code and its documented contract disagree, or two current authorities compute different answers.
- **Structural risk:** the implementation permits a bad outcome, but the user-visible failure still needs a deterministic reproduction.
- **Maintenance pressure:** not itself a defect, but it increases defect probability and diagnosis cost.

## 5. Architectural diagnosis

Pie already contains strong local safeguards: explicit session addressing, per-session mutation queues, generation fences, worker write leases, bounded transport records, optimistic rollback state, renderer delivery ledgers, and process-tree cleanup. The instability is not primarily caused by a lack of safeguards. It comes from the same semantics being re-created in several layers and then reconciled with increasingly specific fences.

### 5.1 Semantic state is split across too many owners

The documented architecture says application state belongs to `ArchState` and the effect runner owns no state. In practice, operation phases, timers, request identities, cancellation boundaries, and recovery flags also live in the effect runner, session service, backend context, worker supervisor, SDK patches, and renderer-local optimistic state.

This creates a recurring failure shape:

1. one layer transitions an operation;
2. another layer has not observed that transition;
3. a timeout or stale event is interpreted using the older phase;
4. compensating logic repairs the display, but may emit a false error, rollback, or busy state first.

The root remedy is an explicit operation lifecycle with clear semantic ownership, not additional boolean fences.

### 5.2 Transcript data is being used as an accounting database

The complete-session usage snapshot is rebuilt from renderable transcript structures. Run analytics separately record folded assistant calls and auxiliary model work. The webview contains another pricing and reconciliation implementation. Consequently, the UI and analytics can disagree even when each subsystem is internally consistent.

A transcript is a conversation projection. It cannot reliably represent every billable invocation, especially retries, folded turns, history compaction, branch summaries, title generation, pruning prepasses, nested agents, and failed calls that still incurred usage.

### 5.3 Capability is inferred from partial projections

Continuation availability is independently inferred from a loaded transcript in the renderer and from SDK messages in the backend. Similar activity checks differ between interrupt, open snapshots, and compact guards. A partial transcript window or a post-`agent_end` retry/compaction window can therefore produce a control that the authority rejects, or hide a control while spend continues.

### 5.4 Errors conflate severity, certainty, and outcome

Info and warning notifications can enter the same reducer path as operational errors. Some timeouts are correctly treated as ambiguous, while other paths still stamp or surface a failure before a matching turn exists. History-compaction completion lacks an outcome on the host-facing event, so a failed or aborted operation can be rendered as successful.

A string plus `noticeKind` cannot consistently answer:

- Did the requested mutation commit?
- Is work still running?
- Is retry safe?
- Is the condition informational, recoverable, or terminal?
- Which operation and transcript row does it belong to?

### 5.5 Builds publish into a live installation

Build output is staged and identity-checked, which is good. On Windows, an active locked destination falls back to a multi-file in-place mirror, and the installed extension manifest is rewritten after sync. Watch mode publishes every completed emission to the live installation.

The current build identity protects coordinated output, but it does not make a multi-file live mirror atomic or prove that VS Code will not react to a manifest change. The observed report that builds interrupt sessions needs a focused reproduction, but the publication model permits mixed-generation reloads and unnecessarily touches active host assets.

### 5.6 Agent traversal protection is partial and fragmented

Pie has three different mechanisms with different scopes:

- Git ignore rules protect Git-aware tools such as ordinary `rg`.
- `warm-bash` rewrites some recursive `grep` and bare-root `find` commands using a static directory list.
- codebase-maintenance scanners use their own `.ignore` file.

The lists have drifted. Broad `find` and `grep` can still enter multi-gigabyte runtime/session/cache trees, and the policy is not automatically supplied to every subagent or recursive file walker. This is execution-input safety, distinct from tool-result pruning after a command finishes.

### 5.7 Historical implementation detail has become architecture

The state contract and production comments retain remediation labels such as “Brief”, “Handoff”, “Bug”, and “FIX”. These explain chronology rather than the invariant a future maintainer must preserve. The authoritative state contract also mixes normative rules, transport internals, historical rationale, and implementation notes in very large bullets.

This makes contradictions harder to see. For example, the documented notice-redaction rule and current host projection behavior do not agree, while both are surrounded by extensive historical commentary.

## 6. Target behavioral contracts

These contracts define user-visible truth. Internal boundaries may change.

### 6.1 Common operation lifecycle

Every state-changing action has a stable `operationId` and records:

- session/branch identity;
- operation kind and initiating renderer/source;
- causal parent when one operation creates another;
- backend and worker generation;
- current phase;
- whether the irreversible commit point was crossed;
- non-terminal acceptance/commit/ambiguity state;
- one terminal settled, cancelled, superseded, or failed outcome;
- one terminal reason and any recovery action.

Semantic operation phase belongs to the host state machine. Effect infrastructure may own opaque timer handles, abort controllers, and promises, but it must not independently own user-visible phase or outcome.

`Ambiguous` is a recoverable non-terminal state, never a permanent result. The host retains correlation and uses an idempotent operation-status/reconciliation path. A correlated late result resolves it; confirmed backend-generation death resolves it according to whether the commit point was durable; and a bounded unresolved state offers an explicit restart/reconcile action without permitting a duplicate mutation.

The backend enforces mutation ordering and idempotency even if a caller misbehaves. The host queue improves responsiveness and determinism but is not the backend's only correctness barrier.

### 6.2 Send

- A non-empty prompt creates one user message and one operation.
- Acknowledgement means accepted for processing, not completed.
- Queued follow-ups retain their own identity and delivery state.
- A definitive pre-commit rejection restores the exact draft and attachments once.
- A timeout with unknown backend outcome enters `ambiguous`, keeps correlation alive, and does not restore a possibly committed prompt.
- The first durable or semantic start for that operation resolves acceptance ambiguity.

### 6.3 Empty continuation

- Empty submission is a distinct `continue` command and never creates a user row.
- Availability is authoritative state returned by the backend/host, not a renderer heuristic over the loaded window.
- It preserves Pi's zero-prompt continuation semantics and does not run prompt expansion or `before_agent_start`.
- Rejection before a new assistant row exists must not stamp the prior interrupted assistant as a new failure.
- Losing ownership in the acknowledgement/start gap produces a terminal cancelled or superseded outcome, never a silent busy session.

### 6.4 Editing

- Editing is one compound operation with restart semantics.
- The backend owns the interrupt → branch/truncate → replacement-send transaction and accepts a stable operation ID for retry/deduplication.
- Cancellation before the destructive commit point restores the original row and editor.
- After the commit point, local cancellation cannot roll back the replacement. The UI shows `saving/restarting` until authoritative late success, definite failure, or backend-generation death resolves it.
- An edit cannot target a row outside the authoritative branch merely because a stale renderer still displays it.

### 6.5 Interrupt

- Interrupt is idempotent. Interrupting an already-idle session is a successful no-op, not an error.
- Its completion barrier includes active generation, queued prompts, retries, history compaction, branch summaries, shell work, and other billable auxiliary windows.
- If cooperative abort does not settle, Pie terminalizes locally, revokes write/network authority, confirms process-tree termination or replacement, and exposes recovery state.
- A late event from the retired operation cannot re-arm busy state or mutate durable history.
- The next send cannot enter the dying operation.

### 6.6 Resume and deferred wake-up

Three concepts remain separate:

1. **Continue:** no new user content; resumes an interrupted provider turn.
2. **User prompt:** new user content; starts or queues ordinary work.
3. **Synthetic wake:** system-generated content used only when an external condition fires without a user prompt.

A `user_input` trigger is consumed by the real user prompt and must not append an additional synthetic follow-up. Timer/session-finished wakes may append a clearly typed synthetic message.

Trigger consumption requires a durable claim. Two hosts observing the same sidecar must not both dispatch the wake. Failed delivery remains retryable or visibly undeliverable; it must not be silently consumed merely because a tab is hidden.

### 6.7 History compaction and maintenance operations

- History compaction is a first-class operation with identity, reason (`manual`, `threshold`, or `overflow`), start, explicit outcome (`succeeded`, `failed`, or `aborted`), usage, and continuation intent.
- A “Compacted” success indicator is shown only after a durable compaction result.
- Failed and aborted operations clear activity without claiming success.
- Context usage can explicitly transition to unknown after compaction or restart; omission never preserves a stale percentage accidentally.
- Retry, shell, branch-summary, and history-compaction activity share one authoritative billable-activity predicate used by open snapshots, controls, interrupt, and compact guards.
- Manual maintenance usage is attributed to its own operation, not opportunistically to whichever run happened most recently.

### 6.8 Build and reload

- Compiling and validating output never stops the active backend.
- A renderer loads only coordinated output, and assets it already references remain available through recovery.
- Host/backend code activates only at an explicit extension reload or installation boundary, with clear user control when sessions are active.
- Preserve same-protocol renderer hot reload when it can meet these guarantees.
- Watch mode must not rewrite the installed manifest merely to publish renderer assets.
- A failed publish leaves the previous complete output usable.

## 7. Target architecture

### 7.1 Session operation coordinator

Introduce one host-owned semantic operation registry, reduced through normal events. It is the source for UI activity, cancellation availability, timeout wording, and recovery actions.

The effect layer receives commands containing operation identity and returns typed observations. It retains only non-serializable execution resources. Backend events echo operation/attempt identity so stale results can be rejected without transcript heuristics.

At the backend boundary, one session mutation coordinator owns serialization, idempotency, runtime transitions, and commit acknowledgements. SDK adapters translate Pi events into the shared operation vocabulary but do not invent separate user-visible states.

### 7.2 Billable invocation ledger

Create an append-only, idempotent ledger of provider invocations. A record contains at least:

- stable invocation and source identity;
- session and branch identity;
- parent operation/run/tool identity;
- invocation kind: conversation, retry attempt, history compaction, branch summary, skill-pruning prepass, session title, subagent attempt, or other automation;
- provider-qualified model identity;
- optional token channels and optional provider total;
- exact reported cost when available;
- catalog price version and calculated cost when derivable;
- `exact`, `estimated`, `unpriced`, or `unknown` provenance;
- timing and terminal outcome.

Unknown token channels are not zero. A provider-reported total cost remains usable when channel pricing cannot be calculated. Repricing is a projection over immutable usage plus a versioned catalog, not a rewrite of historical usage.

Session cost UI, aggregate usage analytics, and usage exports derive from this ledger. Transcript scanning remains a migration/rebuild input, not the steady-state accounting authority.

Private sessions do not durably write this ledger. Any process-local usage needed for their live UI is scrubbed with the rest of private session state, and close/restart/migration tests prove that no ledger, analytics, checkpoint, or export artifact survives.

### 7.3 Activity and settlement timeline

Working time is not derivable from provider invocations alone. Keep a correlated activity timeline for operation, busy, provider, retry-wait, non-overlapping tool, compaction, and auxiliary intervals. It may be persisted with run analytics for ordinary sessions, but it follows the same privacy deletion rules and uses operation/invocation IDs to reconcile rather than duplicate usage.

Propagate Pi's `agent_settled` boundary explicitly from the SDK adapter through worker/coordinator protocol to host state. `agent_end` closes one low-level attempt; only `agent_settled`, an equivalent definitive cancellation/replacement outcome, or confirmed process death can declare all retries, history compaction, queued continuation, and tool work settled.

Session working-time UI derives from this activity authority. Usage/cost views derive from the billable invocation ledger. Their shared identities allow cross-checks without pretending they are one data model.

### 7.4 Typed incidents and notices

Replace generic error routing with a typed incident model containing:

- operation/session identity;
- severity (`info`, `warning`, `error`);
- certainty (`definitive`, `ambiguous`, `recovered`);
- phase and stable code;
- short user message;
- redacted diagnostic detail;
- retry/restart/log action eligibility;
- deduplication identity.

Only matching operation/turn identity may mark a transcript row failed. Internal request IDs remain in logs and are removed from every renderer-visible field. One incident produces at most one visible notice, even when both correlated response and asynchronous backend event report it.

### 7.5 Capability projection

Project a compact per-session capability/activity object from authoritative host/backend state, for example:

- can send, queue, continue, edit, interrupt, or compact;
- current primary operation and phase;
- whether destructive commit has occurred;
- whether billable activity is present;
- recovery action when unhealthy.

Every renderer consumes this object. Renderer-local state remains limited to presentation concerns already allowed by the state contract.

### 7.6 Build publication boundary

First reproduce and classify the reported interruption. Preserve Pie's supported same-protocol renderer hot reload unless evidence shows it is unsafe. The required architecture is behavioral: a published renderer generation is complete before selection, live references remain loadable, host/backend activation is explicit while sessions run, and a failed publish leaves the previous output usable.

Immutable generation-addressed assets plus an atomic reference are one candidate if the existing sync cannot meet those properties. Simpler manifest-write, version-selection, retention, or Windows mirror changes are preferred when the reproduction proves they are sufficient.

Keep build, publish-to-dev-install, package, and activate/reload as distinct concepts even if some remain combined in convenience commands. Validation must have a build-only path; live publication detects active sessions and must not rewrite the installed manifest merely to update renderer assets.

### 7.7 Workspace traversal policy

Define one canonical traversal policy with adapters for:

- broad shell searches and file walkers;
- codebase-maintenance scanners;
- subagent task preambles/defaults;
- repository-aware search tools;
- test-impact and analysis scripts where applicable.

The policy combines Git ignores with explicit protected classes: dependencies, generated output, caches, coverage, runtime data, session transcripts, logs, packaged artifacts, and temporary SDK trees. Exact reads remain allowed. Deliberate inspection supports a visible opt-in.

Common broad walkers should receive exclusions automatically. Unsupported or ambiguous recursive commands receive a bounded warning/rejection rather than traversing known multi-gigabyte roots. Time, file-count, and output limits remain cancellation backstops, not the primary exclusion mechanism.

## 8. Workstreams

### A. Operation semantics and race hardening

**Goal:** make each mutation a testable state machine rather than a chain of locally coordinated booleans.

Work includes:

- Define the common operation schema and transition table.
- Move semantic timer/phase state into the reducer-owned operation registry.
- Make backend mutations idempotent by operation ID.
- Bound transition waits and return typed recovery outcomes.
- Cover acknowledgement loss, late response, stale event, worker replacement, provider retry, and user interruption at every commit boundary.
- Remove superseded fences only after conservation tests prove equivalent behavior.

### B. Resume, edit, and deferred-trigger UX

**Goal:** eliminate duplicate prompts and controls that predictably fail.

Work includes:

- Replace continuation heuristics with authoritative capability projection.
- Distinguish empty continuation, real user input, and synthetic wake-up end to end.
- Consume `user_input` triggers through the real prompt.
- Add a cross-process claim/delivery protocol for triggers.
- Move edit restart semantics behind one idempotent backend operation.
- Preserve editor/draft state according to the edit commit boundary.

### C. Usage, cost, and working-time accounting

**Goal:** one conserved accounting source for all product surfaces.

Work includes:

- Define and persist the billable invocation ledger.
- Capture all parent, retry, compaction, branch-summary, prepass, title, and subagent invocations.
- Migrate/rebuild historical samples with explicit provenance and incomplete markers.
- Make session UI, aggregate statistics, and usage exports derive from the invocation ledger.
- Make working-time UI derive from the correlated activity/settlement timeline.
- Restore open busy intervals consistently across host restart.
- Remove duplicate pricing/reconciliation implementations after parity tests pass.

### D. History compaction

**Goal:** treat compaction as a durable, cancellable maintenance operation rather than an inferred side effect of a run.

Work includes:

- Add operation identity and explicit outcome to the protocol.
- Unify billable activity checks.
- Correct context-usage clearing and overflow continuation semantics.
- Attribute maintenance usage independently from chat runs.
- Propagate Pi's `agent_settled` event through worker, coordinator, host operation state, accounting, and capability projection instead of reconstructing settlement from local predicates.

### E. Error and recovery UX

**Goal:** show one accurate, actionable condition without corrupting transcript state.

Work includes:

- Introduce typed incidents and severity-aware extension notifications.
- Audit every timeout as definitive or ambiguous.
- Bind transcript errors to exact operation/turn/message identity.
- Enforce renderer-boundary redaction and one-notice-per-incident.
- Prefer inline operation state for expected recovery over global banners.

### F. Non-disruptive build and activation

**Goal:** permit development builds while sessions run without terminating work or loading mixed output.

Work includes:

- Build a deterministic reproduction around an actively streaming session.
- Use the reproduction as a decision gate: apply the smallest publication design that proves complete-generation loading and active-session continuity.
- Separate build, publish, and activate concepts and retain same-protocol hot reload when it satisfies the acceptance tests.
- Avoid rewriting the installed manifest during ordinary renderer-asset sync.
- Guard version/folder mismatches, asset retention, and Windows locked-output fallback.
- Add an explicit active-session activation policy for host/backend code.

### G. Agent and file-I/O safety

**Implemented (2026-09-05).** `shared/traversal-policy.ts` is the canonical protected-directory policy. Root `AGENTS.md`, the default Pie harness rewrite, every subagent prompt, warm-bash, codebase-maintenance scanners, test impact, and broad test discovery consume it directly or through a drift-checked adapter. Recursive grep and bare find are pruned; unsupported bare-root `ls -R`, `tree`, and `du` fail fast, while exact/scoped protected-path inspection and the explicit environment opt-out remain available.

**Goal:** prevent accidental traversal of generated or runtime trees without depending on agent memory.

Work includes:

- Centralize traversal exclusions and close the known gaps for sessions, runtime data, caches, logs, temporary output, and packages.
- Apply the policy to root agents and subagents automatically.
- Add command-level tests for recursive `grep`, `find`, and other supported walkers.
- Add bounded failure behavior for unsupported broad traversal.
- Keep tool-result pruning terminology and implementation separate; it acts after execution and cannot prevent traversal.

### H. Maintainability and dead-system retirement

**Goal:** reduce the number of places a lifecycle rule can hide.

Work includes:

- Split high-complexity orchestration by operation/domain ownership.
- Keep protocol validation, state transition, persistence, and rendering separate.
- Consolidate duplicated detail transport, usage reconciliation, sidecar JSONL, and test-runner protocol primitives where their contracts are genuinely identical.
- Single-source the extension/package registry used by tests, typechecks, and scripts.
- Establish a retirement process for legacy migration and extension-ID paths: usage evidence, removal gate, rollback note, then deletion.
- Replace historical remediation labels in production comments with the invariant and reason that still matter.
- Split normative state guarantees from implementation notes and completed remediation history.

Static thresholds are advisory. A large single-concern table may remain; a smaller function that mixes ownership, I/O, mutation, and user messaging should be split.

### I. Verification and observability

**Milestone 0 complete (2026-09-05).** A shared deterministic fake clock and model harness enumerate and fixed-seed-randomize 6,696 operation schedules across send/queue/continue/edit/compact/interrupt/open/close/restart. Focused transport tests inject acknowledgement loss, delayed events, overlong records, worker crash evidence, and backend replacement. Deferred-trigger acceptance includes a real two-process claim race and real dead-owner recovery race. Live diagnostics emit metadata-only operation-transition and incident records with HMACed semantic IDs and closed classifications; request/correlation/worker IDs, free-form incident text, and credentials are excluded.

**Goal:** make races and accounting defects cheap to reproduce before changing architecture.

Work includes:

- Add a model-based session-operation test harness with fake time and deterministic event scheduling.
- Generate interleavings around accept, commit, settle, interrupt, restart, and renderer reload boundaries.
- Add transport fault injection: dropped acknowledgement, delayed event, overlong record, worker crash, and backend replacement.
- Add accounting conservation tests comparing ledger, session UI, aggregate stats, and export totals.
- Add cross-process trigger claim tests.
- Add active-session build/watch acceptance tests.
- Record phase transitions and incident identities in structured, credential-redacted logs.
- Keep ordinary tests fast; isolate real process/browser/provider matrices behind focused integration commands.

## 9. Prioritization and sequencing

### Milestone 0: guardrails and reproducible baselines

**Implemented (2026-09-05).** Canonical traversal policy delivery/adapters and drift tests cover agents, shell guards, maintenance scanners, test impact, and test discovery. Deterministic operation schedules, command-transport fault injection, real two-process deferred-trigger claiming/recovery, structured HMAC/redacted semantic tracing, active-session publication reproduction, and representative accounting fixtures provide the baseline evidence.

1. Centralize and apply traversal exclusions so audit/implementation agents cannot repeatedly enter runtime trees.
2. Add focused reproductions for the reported build interruption and highest-risk lifecycle races.
3. Add structured operation/incident tracing without changing user behavior.
4. Record current accounting totals for representative sessions as migration fixtures.

**Exit:** agents can inspect the repo safely; failures have deterministic loops or are explicitly marked unconfirmed.

### Milestone 1: immediate correctness and UX defects

1. Authoritative continuation capability.
2. User-input trigger consumption without a second synthetic prompt, plus durable cross-host claiming.
3. Explicit compaction outcomes and unified billable-activity checks.
4. Severity-correct notifications and operation-bound transcript errors.
5. Context-usage clearing, total-only cost handling, and active working-time restoration.
6. Bounded transition waits and explicit lost-ownership outcomes.

**Exit:** known false controls, false success/error states, duplicate wake prompts, and obvious accounting omissions are removed without waiting for the larger refactor.

### Milestone 2: unified operation lifecycle

**Implemented (2026-09-05).** `ArchState.operations` now owns the common lifecycle for create, duplicate, open, close, restart, send, edit, interrupt, continue, and manual history compaction. Records preserve trusted source/causality, session/branch and backend/worker identity when known, acknowledgement/commit evidence, bounded ambiguity reconciliation, and one immutable terminal. Backend mutation ledgers deduplicate retryable mutations. `agent.settled` is correlated through operation/request/turn/attempt and generation lineage. The generic EffectRunner retains only opaque execution resources for registered operations; queues and selection tokens remain execution/presentation aids.

1. Introduced the reducer-owned operation registry and capability projection.
2. Added idempotent backend operation handling and read-only status reconciliation.
3. Moved edit, interruption, open/close, and restart to the common contract.
4. Moved registered-operation phase, acknowledgement, reconciliation policy, and barrier-release decisions out of generic effect state.

**Exit:** deterministic model tests cover response/event order, running versus idle/private close, restart drain/death, dropped acknowledgement, stale worker settlement, renderer source, and immutable one-terminal behavior. Injected ambiguity resolves through correlated late evidence, bounded status reconciliation, generation death, or explicit restart recovery without duplicate mutation.

### Milestone 3: conserved accounting

**Acceptance-complete (2026-09-05).** `StatsService` owns the idempotent billable invocation ledger and correlated activity timeline and projects them into session UI, working-time UI, aggregate stats, and explicit/automatic exports. Conversation/retry, compaction/branch-summary, pruning, title, subagent, and unexpected auxiliary seams emit one immutable invocation or explicit gap row. Multi-turn subagent provider responses and no-usage attempts survive terminal transport compaction. Ledger/activity/history/checkpoint/privacy/export mutations share a cross-process transaction lock and durable privacy fence; checkpoint writes merge independent hosts. Open busy/tool intervals retain their original identities and starts across restart without double count. Renderer accounting is ledger-only and explicit unknown when absent.

1. Introduce the billable invocation ledger and correlated activity/settlement timeline alongside existing analytics.
2. Dual-write and compare usage totals and interval boundaries.
3. Migrate usage surfaces to the ledger and working-time surfaces to the activity timeline.
4. Retire transcript-derived steady-state accounting and duplicated pricing logic.

**Exit:** all surfaces agree by construction, with visible incomplete/unpriced provenance. Evidence: `extension/test/host/billable-invocation-ledger.test.ts` (multi-instance append/privacy), `extension/test/host/billable-invocation-stats-integration.test.ts` (checkpoint/export/privacy races, ledger↔activity conservation, restart recovery), `extension/test/host/activity-timeline.test.ts` (multi-instance settlement/identity), `extension/test/backend/runtime/auxiliary-llm-meter.test.ts` (`other` calls/gaps), `extensions/subagent/test/usage-accounting.test.ts` and compacted-terminal integration coverage (per-response/no-usage child evidence), and session cost indicator unknown-authority coverage.

### Milestone 4: non-disruptive publication

**Implemented (2026-09-04).** A fast deterministic mock-streaming reproduction is the decision gate. It repeatedly publishes renderer generations while checking stable mock backend PID and worker ownership, host-owned composer continuity, one tool execution, complete coordinated assets, unchanged installed host/backend/worker files and manifest, prior-generation retention, and failure recovery. This proves the isolated publication boundary exercised by the test; it does not claim observation of real VS Code process behavior.

1. Compile/validate, renderer publication, and host/backend activation are separate commands; the existing build/watch convenience path compiles and publishes only renderer assets.
2. Renderer output is copied to an immutable generation and verified before an append-only selection marker is atomically created. Resolution skips torn/invalid markers, and current plus prior generations are retained.
3. Ordinary publication never rewrites the installed manifest or host/backend/worker bundles. Explicit activation uses directory replacement without the Windows live in-place fallback and requires an exact installed-folder/manifest identity and version match.

**Exit:** satisfied by the deterministic publication acceptance boundary. Real VS Code behavior remains limited to later focused/manual evidence rather than inferred from the mock.

### Milestone 5: consolidation and retirement

**Consolidation commit 2a complete (2026-09-05).** `EffectRunner` remains the sole executor façade while send timing, acknowledgement ambiguity/status reconciliation, and edit/interrupt/continue/compact execution resources are isolated in a session-operation effect controller. The controller retains only opaque execution/correlation resources; operation phase and outcomes remain reducer-owned. Deterministic façade and architectural-boundary tests preserve FIFO behavior and prevent ownership drift.

1. Split remaining multi-concern modules along the new domain boundaries.
2. Consolidate registries and shared primitives.
3. Remove proven-dead compatibility paths and historical comments.
4. Restructure architecture/state documentation around current invariants.

**Exit:** future lifecycle or accounting changes have one obvious owner and one primary test seam.

Milestones 2, 3, and 4 can proceed in parallel after Milestone 0 where their contracts do not overlap. Behavior fixes and mechanical moves should remain separate changes so regressions are attributable.

## 10. Acceptance criteria

### Session lifecycle

- Randomized and enumerated race tests cover send, queue, continue, edit, interrupt, compact, open, close, restart, and worker replacement.
- No operation has two terminal outcomes.
- No stale generation can append durable data, re-arm busy state, or settle a newer operation.
- A timeout classified as ambiguous resolves through late evidence, status reconciliation, confirmed generation death, or explicit recovery without duplicate prompt, rollback, or error; ambiguity cannot persist without a visible bounded recovery path.
- Stop followed immediately by send cannot enter the retired turn.
- `agent_end` alone never marks a session settled; propagated `agent_settled` or a definitive cancellation/death boundary does.

### Resume and triggers

- Empty continuation creates no user message and runs no prompt prepass.
- The Continue control is never offered from a partial renderer heuristic.
- A real user prompt consumes a `user_input` trigger and produces exactly one user prompt.
- Two host processes racing one trigger produce at most one durable claim and one wake delivery.
- Hidden/closed-tab delivery has an explicit retained or failed state.

### Accounting

- Every provider invocation has one ledger identity or an explicit instrumentation-gap record.
- Session, aggregate, and export usage views reconcile from the same fixture ledger; working-time views reconcile from a correlated fixture activity timeline.
- Unknown usage and unpriced usage never display as known zero.
- History compaction, branch summaries, retries, title generation, pruning, and subagent attempts have visible source attribution.
- For non-private sessions, restart during an open busy interval neither drops nor double-counts elapsed time.
- Private sessions leave no durable usage, timing, checkpoint, analytics, or export artifact after close or restart.

### Compaction and activity

- Success, failure, and abort produce distinct terminal UI states.
- Session open, Stop availability, and compact guards use the same billable-activity authority.
- Context usage becomes explicitly unknown when no fresh value exists.
- `agent_end` cannot finalize a run while Pi still reports unsettled retry, compaction, queue, or tool work.

### Errors and UX

- Info/warning extension notifications do not render as operational errors.
- Internal request IDs and credentials never cross the renderer boundary.
- One incident produces one notice and one analytics error record.
- An assistant row is marked failed only by a matching turn/message identity.
- Expected recovery states use accurate copy and do not instruct unsafe duplicate retries.

### Build and renderer resilience

- A focused test repeatedly builds/publishes while a mock or real session streams.
- The backend PID and worker ownership remain stable through build-only and renderer-asset publication.
- Renderer reload recovers from a full snapshot with no lost draft, duplicated tool execution, or session interruption.
- Publication failure leaves the prior generation loadable.

### Traversal safety

- Default broad traversal does not enter dependency, generated, cache, runtime, session, log, package, or temporary SDK trees.
- Root agents and subagents receive the same policy.
- Exact opt-in inspection of an excluded path remains possible.
- Common accidental root scans fail fast or complete within a small bounded budget on the current checkout.

### Maintainability

- Core lifecycle functions have focused ownership and deterministic unit seams.
- Semantic operation state is absent from generic effect infrastructure.
- Extension registration has one source of truth and a drift check.
- Production comments contain current invariants rather than obsolete project-plan labels.
- Normative contracts are concise enough that contradictions can be reviewed mechanically.

## 11. Implementation guardrails

- Preserve the pinned Pi semantics: steering versus follow-up boundaries, `agent_end` versus `agent_settled`, abort signals, session replacement lifecycle, and append-only session-tree behavior.
- Keep the webview passive. Do not solve races by moving semantic state into renderer hooks.
- Do not use a new timeout to conceal an ownership defect. Timeouts need an owner, phase, certainty, and recovery transition.
- Do not treat a local JSON-RPC cancellation as proof that backend mutation stopped.
- Do not derive durable accounting from what happens to be rendered.
- Do not add another sidecar without defining writer count, locking/claim semantics, crash recovery, compaction, and source of truth.
- Do not remove compatibility paths until their runtime use is measured or migration is proven complete.
- Revalidate `docs/STATE_CONTRACT.md` and matching contract tests in every behavior-changing slice.
- Prefer vertical slices with one user-visible invariant over broad simultaneous file moves.

## 12. Preliminary evidence ledger

This section records why the workstreams exist. It is evidence, not a required implementation map.

| Priority | Confidence | Finding | Current evidence |
|---|---|---|---|
| P0 | Resolved 2026-09-05 | Broad agent traversal could enter very large runtime trees. | The canonical policy now drives warm-bash grep/find guards, root and subagent prompts, test impact/discovery, and scanner drift tests; unsupported root `ls -R`, `tree`, and `du` fail fast with scoped and explicit opt-ins. |
| P0 | Confirmed | `user_input` resume adds a second synthetic prompt after dispatching the real user prompt. | The message router dispatches Send and then notifies the trigger registry; the registry dispatches another Send. |
| P0 | Resolved 2026-09-05 | Deferred triggers previously lacked proven cross-host at-most-once delivery. | Atomic hard-link claims and dead-owner recovery are now exercised by two independent OS-process races, including one real owner exit before dispatch. |
| P0 | Confirmed | Continue availability has multiple classifiers. | The webview scans its loaded transcript while the backend classifies SDK messages and context-window overflow. |
| P0 | Structural risk | A lost Continue owner in the acknowledgement/start gap can return without an explicit terminal event. | Deferred start checks ownership and returns silently; a focused race test is still required. |
| P0 | Confirmed | Some session transition waits are unbounded. | Send/continue/title paths loop while transition pending without a local bound or typed wait outcome. |
| P0 | Confirmed | Activity predicates differ by operation. | Interrupt includes retry/compaction/bash windows, while current open/compact checks use narrower subsets. |
| P0 | Confirmed | Failed/aborted compaction can look successful. | Host-facing compaction-ended data omits outcome and the reducer records a success chip on every end event. |
| P0 | Resolved 2026-09-05 | Session usage and aggregate analytics previously covered different calls. | All usage/cost surfaces now consume the invocation ledger; compaction, branch summary, title, retry, pruning, subagent, and other automation retain explicit source kinds. |
| P0 | Resolved 2026-09-05 | Total-only usage could be priced as zero. | Provider totals/reported cost remain independent immutable evidence; unavailable channels remain absent and explicit incomplete provenance prevents known-zero display. |
| P0 | Resolved 2026-09-05 | Working-time restart could lose an open interval. | Correlated busy/tool intervals are persisted open, restored from their original start, and settled idempotently; covered run aggregates are excluded from clock restoration. |
| P0 | Confirmed | Info/warning notifications use the generic error path. | Extension UI notifications are prefixed and dispatched as `Error` regardless of severity. |
| P0 | Confirmed | Notice request-ID documentation and behavior disagree. | The state contract says renderer-visible raw detail excludes internal IDs; host state/tests preserve them and projection currently only performs credential redaction. |
| P1 | Structural risk | Continuation failure can mark an older assistant row failed. | Generic backend error stamping selects a latest assistant when no matching new assistant exists; reproduce at the continuation pre-message seam. |
| P1 | Structural risk | Live build publication may load mixed generations or trigger host churn. | Windows lock fallback mirrors multiple files in place; watch sync rewrites the installed manifest; active-session reproduction is pending. |
| P1 | Confirmed | Installed extension folder and manifest versions can diverge. | Installed-directory selection permits prefix fallback, followed by writing the workspace manifest into that directory. |
| P1 | Resolved 2026-09-05 | Full Pi settlement previously lacked complete host correlation. | `agent_settled` now propagates as `agent.settled` with operation/request/turn/attempt, operation-attempt, backend-generation, and worker-generation lineage; stale settlements are reducer-rejected. |
| P2 | Resolved 2026-09-05 | Effect infrastructure previously owned semantic operation state despite the documented ownership rule. | Registered-operation phase, commit ambiguity, acknowledgement/reconciliation policy, and cancellation/barrier decisions now live in reducer state/events; the runner retains opaque execution resources only. |
| P2 | Maintenance pressure | Core lifecycle and accounting modules have concentrated complexity. | Static analysis found high complexity in SDK event handling, live transitions, protocol validation, aggregate accounting, request handling, and session cost projection; more than twenty production modules exceed 800 lines. |
| P2 | Maintenance pressure | Similar algorithms are duplicated across process/UI boundaries. | Duplicate scan identified usage reconciliation, detail subscription/storage, and live transition/checkpoint blocks. Some parity is intentional, but each pair needs an explicit shared-contract or generated-test strategy. |
| P2 | Maintenance pressure | Test/package registration is repeated. | Package lists are maintained in root scripts, typecheck scripts, batch runners, and package scripts without one drift authority. |
| P2 | Maintenance pressure | Historical remediation labels dominate comments. | Production source contains many `Brief`, `Handoff`, `Bug`, and `FIX` references that no longer explain a standalone invariant. |
| P3 | Tooling gap | Static smell analysis can fail on valid current TypeScript while reporting no findings. | The maintenance smell scan returned a parser syntax error and exit code 2; scanner failure must not be interpreted as a clean result. |

The dead-code scan produced only two verified “unused file” candidates, both consistent with bundler/worker entry points, so this audit does **not** claim proven production dead code. Markdown internal-reference and anchor checks were clean. Legacy migration and extension-ID paths remain retirement candidates only after usage/migration evidence exists.

## 13. Decisions to preserve unless new evidence changes them

- Continue using the host-owned CQRS/Elm-style MVI state model.
- Keep isolated per-root workers and coordinator-owned global provider admission.
- Keep session browsing runtime-free and session mutations explicitly addressed.
- Keep full renderer snapshots as recovery authority and renderer delivery independent per surface.
- Preserve supported same-protocol renderer hot reload unless a reproduction proves it cannot satisfy session-continuity requirements.
- Keep the pinned SDK as the semantic reference rather than reimplementing its agent loop.
- Prefer fail-closed ownership and persistence boundaries, but represent uncertainty to the user instead of converting it into a false failure.

This plan should be updated as reproductions convert structural risks into confirmed findings, implementation changes invalidate evidence, or a workstream reaches its exit criteria.
