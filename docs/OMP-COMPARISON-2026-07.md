# Oh My Pi comparison and adoption plan (2026-07)

## Scope

This review compares pie's current VS Code + `@earendil-works/pi-coding-agent` stack with [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) (OMP) at commit [`79faf94f265100a5c05234a16ce67cd621f6e5e8`](https://github.com/can1357/oh-my-pi/tree/79faf94f265100a5c05234a16ce67cd621f6e5e8), package version 16.5.2.

The conclusion is **selective adoption, not a runtime swap**. OMP is materially ahead in coding-tool capability and tool-format optimization. Pie is ahead in its VS Code-native surface, host/webview reliability contract, local outcome analytics, cautious provider-capacity handling, and task-specific skill/tool pruning. OMP is a Bun-first fork with native Rust packages and divergent SDK/runtime assumptions, while pie is a Node 24 host with backend hot patches and direct dependencies on the Earendil SDK. Replacing the SDK would be a migration project, not a package-name change.

OMP is MIT licensed, so focused ports are legally possible when attribution and notices are retained ([license](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/LICENSE#L1-L14)).

## Executive verdict

The most valuable lessons are not “ship 32 tools.” They are:

1. **Treat tool protocols as a product and benchmark them per model.** OMP reports large model-dependent gains from its edit format and actively probes what tool-prompt text is load-bearing rather than guessing ([claimed results](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/README.md#L78-L94), [prompt-ablation method](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/.omp/skills/tool-prompt-optimization/SKILL.md#L6-L37)). Pie already has the analytics foundation to do this more rigorously for our own workload.
2. **Expose semantic code intelligence, especially LSP.** This is the clearest capability gap. OMP exposes diagnostics, definitions, references, symbols, rename, code actions, and raw requests ([LSP actions](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/lsp.md#L23-L35)) and applies workspace edits and rename lifecycle notifications ([runtime flow](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/lsp.md#L45-L57)). Pie runs inside VS Code, so it should eventually have a stronger—not weaker—semantic tool.
3. **Make subagent outputs typed and editing isolated.** OMP's task system supports schemas, persistent artifacts, background delivery, follow-up, and optional isolated workspaces ([outputs/artifacts](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/task.md#L49-L73), [isolation and lifecycle](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/task.md#L75-L110)). Pie's in-process subagents are carefully bounded and provider-aware, but the parent still consumes prose and concurrent editors share a workspace.
4. **Use structural summaries and content anchors as optional modes, then A/B test.** OMP summarizes parseable files and directs the model to re-read only elided ranges ([read behavior](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/read.md#L97-L110)); its edit protocol uses a whole-file content tag plus line/block operations ([hashline format](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/edit.md#L21-L48)). These should be tested against pie's exact-match multi-edit rather than adopted on claims alone.
5. **Prefer deterministic catalog discovery as the tool surface grows.** OMP can hide non-essential tools, BM25-search their metadata, and activate matches in the same turn ([discovery flow](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/search_tool_bm25.md#L44-L78)). Pie's LLM prepass is more context-aware but adds latency/cost. A hybrid can preserve skill pruning while making tool recovery deterministic.

## Where OMP is better

| Area | OMP advantage | Pie today | Assessment |
|---|---|---|---|
| Semantic code intelligence | First-class LSP with 14 actions; refactors apply workspace edits and file-renaming hooks. DAP exposes live debugger operations ([overview](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/README.md#L106-L118)). | No LSP or debugger tool; agents use text search, typecheck/build, and print-style debugging. | **Largest practical gap.** LSP first; DAP later. |
| Edit reliability | Hash-tagged snapshots reject stale edits; line/block operations avoid retyping unchanged text ([protocol](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/edit.md#L21-L48), [stale limits](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/edit.md#L154-L158)). | Exact `oldText` replacement, with multiple non-overlapping edits. Safe and simple, but whitespace/stale-context failures require retries. | Promising, but model-specific. Prototype and measure before replacement. |
| Read efficiency | Tree-sitter summaries, selectors, archives/SQLite/PDF/notebook/URL/internal schemes through one read interface ([capabilities](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/README.md#L220-L243)). | Exact file reads plus separate find/grep/web/session tools; tool-result pruning deliberately skips read to preserve edit fidelity. | Add an explicit outline/summary mode; do not silently alter exact reads. |
| Subagent contracts | Schema-validated `yield`, artifacts under `agent://`, history, background jobs, resumable idle agents, IRC, and workspace isolation ([task details](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/task.md#L49-L99)). | In-process isolated contexts, model buckets, provider-capacity routing, nested limits, ask-user bridge, compacted persisted results. Shared working directory and prose final answer. | Add typed output first; optional git-worktree isolation second. Background/IRC is lower value for our mostly sequential policy. |
| Executable analysis | Persistent Python and JavaScript cells, structured display, cancellation, and tool/subagent callbacks ([eval contract](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/eval.md#L1-L40), [tool bridge](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/eval.md#L121-L143)). | Bash and warm-bash; one-shot scripts are possible but state/output are unstructured. | Useful for data-heavy work, but security and lifecycle cost make it P2. |
| In-turn guardrails | Regex or AST rules monitor prose/tool streams, abort generation, inject a rule, and continue ([lifecycle](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/ttsr-injection-lifecycle.md#L63-L105)). | Safeguard blocks dangerous shell/file operations before execution; AGENTS rules are always in context. | OMP is more expressive. Pie's pre-execution guards are safer and simpler. Pilot tool-argument rules before stream interruption. |
| Continuous review | Optional advisor sees turn deltas in a private context and can emit nit/concern/blocker steering ([visibility/isolation](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/advisor-watchdog.md#L54-L85), [delivery guard](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/advisor-watchdog.md#L87-L118)). | Manual reviewer subagent plus `session_changes`/`session_review`; no automatic second model. | A finish-gate reviewer is more cost-effective than review after every turn. |
| Project memory | Background extraction and consolidation produce a project memory, summary, and generated skills, with secret redaction ([pipeline](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/memory.md#L42-L56)). | Durable sessions and analytics, but no curated cross-session knowledge injected into new sessions. | Valuable but high risk for stale context. Start recall-only and citation-backed. |
| Runtime/tool breadth | In-process Rust search/glob/shell/AST and a wide built-in catalog; same behavior across supported OSes ([native modules](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/README.md#L371-L403)). | Upstream Node tools plus warm-bash and deterministic output pruning. | OMP is faster/broader in principle, but porting the native runtime is poor ROI without measured bottlenecks. |
| Tool ergonomics | Unified path-like internal URLs and deterministic hidden-tool activation reduce schema proliferation ([internal schemes](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/README.md#L192-L210), [tool discovery](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/README.md#L220-L275)). | Separate purpose-built tools, with skill pruning and `request_tool` recovery. | Borrow deterministic activation; keep specialized web/video interfaces where their schema carries useful intent. |

## Where pie is better or should remain different

- **VS Code-native workflow.** Pie owns a sidebar, tabs, changed-files rail, diff inspection, model/settings controls, image paste, and host-owned state. OMP's strongest editor integration is ACP, but its primary product remains a terminal TUI.
- **Explicit state and durability engineering.** Pie's CQRS/Elm reducer, single effect runner, sequenced live pipeline, checkpoint repair, and passive webview are designed around reliable multi-session UI state (`docs/ARCHITECTURE.md`, `docs/STATE_CONTRACT.md`). Do not bypass that architecture to graft in OMP-style tools.
- **Outcome analytics and safe experimentation.** Pie already records run factors, tool rollups, verification classes, file mutations, pruning recoveries, and result-pruning impact. OMP publishes benchmark claims; pie can validate the same ideas against the maintainer's actual repositories and models.
- **Provider-aware subagent containment.** Pie has process-wide root-tree limits, tree session budgets, progress-aware leases, optional provider-busy routing, nested model caps, and parent cancellation. Preserve these if typed outputs or isolation are added.
- **Recoverable output pruning.** Pie's lossy result transforms retain a raw stash and fidelity marker. OMP's native summarizers are broader, but pie's recoverability contract is a strong invariant.
- **Minimal surface by default.** Browser automation, TTS, image generation, SSH, collaboration relay, and a full DAP are impressive but are not automatically useful for this personal VS Code workflow. Tool count is not a quality metric.

## Recommended roadmap

### P0 — measure before porting

#### 1. Tool protocol benchmark harness

Build a replayable benchmark package over representative pie tasks and model buckets. Initial treatments:

- current exact `edit` vs a hash-anchored prototype;
- current raw/limited `read` vs opt-in structural outline + targeted re-read;
- current tool descriptions vs schema-aware trimmed prompts;
- skill-pruner tool selection vs deterministic BM25 selection/recovery.

Record first-attempt success, retries, output/input tokens, elapsed time, malformed calls, stale-edit rejection, verification result, and final session rating. Use fixed repo snapshots/worktrees. OMP's own method explicitly says prompt lines should be removed only after multi-model/multi-sample evidence and history review ([method and caveats](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/.omp/skills/tool-prompt-optimization/SKILL.md#L68-L100)).

**Gate:** no runtime default changes until a treatment improves completion or tokens without increasing setbacks on at least two model families.

#### 2. LSP architecture spike and read-only MVP

Prototype `lsp` actions in this order:

1. diagnostics;
2. definition;
3. references;
4. hover/document symbols;
5. rename preview;
6. rename apply after host-side file-change reconciliation is proven.

Evaluate two implementations:

- **VS Code host bridge (preferred):** backend tool emits a correlated host-capability request; the extension host executes VS Code language features and returns a bounded result through the existing serialized effect path.
- **Backend LSP client:** independent language-server processes, closer to OMP but duplicates VS Code's already-running semantic state.

The host bridge must be a typed command/effect/result path, not an ad-hoc webview message. Mutating workspace edits must flow through change tracking and surface in the changed-files UI.

**Gate:** TypeScript diagnostics/references work in `pie`, `reveal`, `twin-api`, and `twin-ui`; unavailable servers fail cleanly; no host/webview contract bypass.

### P1 — high-value workflow improvements

#### 3. Typed subagent results

Add optional agent-frontmatter output contracts rather than a free-form schema on every call. A hidden finish/yield tool should validate the child payload and return a compact typed object to the parent while preserving the rich transcript for UI inspection. Start with reusable shapes such as `findings[]`, `verdict`, `files[]`, and `summary`.

**Gate:** parent code no longer regex/parses reviewer prose; malformed results are retried within a bounded budget and then fail visibly; legacy agents continue returning prose.

#### 4. Optional git-worktree isolation for editing subagents

Add `isolated?: true` only for agents allowed to mutate. Create a temporary worktree from a captured baseline, run the child there, return a patch/change manifest, and apply only after checking the parent's current tree. Do not auto-merge conflicts. Reuse `session_changes` rendering and existing safeguard policy.

**Gate:** two editing siblings cannot overwrite each other; parent changes made during child execution are preserved; cleanup runs on success, error, timeout, and cancellation; Windows Git Bash paths are covered.

#### 5. Structural outline tool/mode

Do not change `read` semantics first. Add an opt-in, exact-recoverable source outline that retains declarations and names explicit elided ranges. Prefer TypeScript/JavaScript first (using VS Code symbols or tree-sitter), then measure expansion.

**Gate:** every elision points to a valid exact re-read range; generated output never feeds exact-match edits directly; token and completion impact is measured.

#### 6. Deterministic tool discovery hybrid

Keep a small essential set active. Index hidden tool name, summary, schema keys, and dependencies with a deterministic local ranker. Let `request_tool` accept a natural-language query and activate ranked matches. Continue using the LLM prepass for skill selection and genuinely ambiguous catalog pruning, but skip it for tool selection when deterministic confidence is high.

Unlike OMP's current implementation, include extension/custom tools in the corpus; its documentation notes those source types exist but are not yet assembled into the searchable set ([current limitation](https://github.com/can1357/oh-my-pi/blob/79faf94f265100a5c05234a16ce67cd621f6e5e8/docs/tools/search_tool_bm25.md#L109-L116)).

**Gate:** lower prepass latency/cost, no increase in `request_tool` recoveries, and dependencies are activated atomically.

### P2 — experiments after P0/P1

#### 7. Finish-gate advisor, not per-turn advisor

At a natural completion boundary, optionally launch a read-only reviewer with `session_changes`, relevant transcript tail, tests, and project `WATCHDOG.md` guidance. Only blockers/concerns return to the main agent; “no issue” stays silent. This captures most advisor value without doubling every turn's model traffic.

#### 8. Project memory in recall-only mode

Build a local, project-scoped index from explicitly completed/high-rated sessions and accepted review findings. Initially expose `memory_recall` only—do not inject summaries into every system prompt. Each memory must include session/date/source and instruct the agent to verify current repo state. Add secret redaction before persistence.

#### 9. Persistent eval kernel

Start with JavaScript only, disabled by default, process-isolated, with bounded output and no ambient tool callback. Add Python/tool re-entry only if analytics shows repeated shell-script friction. OMP's full bridge is powerful but substantially expands the execution and permission surface.

#### 10. Conditional rule hooks

Extend safeguard with project-defined rules over completed tool arguments/results before considering token-stream interruption. AST-match edit/write payloads and issue a blocking or advisory result. Stream abort/retry should remain experimental because false positives waste provider calls and complicate pie's live-pipeline invariants.

## Explicit non-goals

- Do not replace `@earendil-works/pi-coding-agent` with OMP in the current backend.
- Do not port OMP's Rust/native runtime wholesale.
- Do not add tools merely to match OMP's count.
- Do not silently summarize normal `read` output while exact-match edit remains the default.
- Do not enable automatic cross-session memory injection by default.
- Do not add always-on per-turn advisor cost without outcome evidence.
- Do not implement collaboration relay, TTS, image generation, SSH, or browser control unless a concrete pie workflow demands them.

## Suggested implementation order

1. Benchmark harness and baseline dataset.
2. Read-only LSP bridge MVP.
3. Typed subagent yield.
4. Hash-anchor + outline prototypes behind experiment flags.
5. Worktree isolation.
6. Deterministic tool discovery.
7. Advisor/memory/eval experiments only after measured demand.

This order gets the largest capability gain early, uses pie's analytics advantage, and avoids turning a focused VS Code agent into a broad OMP clone.
