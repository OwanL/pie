# Documentation index

This folder contains active design contracts, implementation plans, and operational references. Use this index instead of scanning the directory.

## Active design contracts (read first)

- [ARCHITECTURE.md](ARCHITECTURE.md) — **primary architecture reference**. System overview, pattern explanation, data flow scenarios, extension-point recipes, and invariants. Start here.
- [STATE_CONTRACT.md](STATE_CONTRACT.md) — authoritative normative rules for host ↔ webview state sync, session lifecycle, and accounting. Any change here requires matching tests in `extension/test/` (see `sync-contract.test.ts`).
- [STATE_CONTRACT_IMPLEMENTATION.md](STATE_CONTRACT_IMPLEMENTATION.md) — non-normative mechanics behind the state contract: transport/protocol internals, byte budgets, thresholds, and file mappings. Not pinned by tests.
- [STATE_CONTRACT_HISTORY.md](STATE_CONTRACT_HISTORY.md) — completed remediation chronology (retired Brief/Phase/REM/Bug/FIX labels) and documentation-structure decisions.
- [internal/ARCH-OVERVIEW.md](internal/ARCH-OVERVIEW.md) — concise developer-onboarding file map. Spine file locations, glossary table, and "where to make changes" quick-reference.

## Active plans (in progress)

- [ANALYTICS_REWORK_PLAN.md](ANALYTICS_REWORK_PLAN.md) — agreed unified analytics/runtime-storage scope, architecture, retention and cutover. At storage cutoff, existing sessions close and their files stay in place; new session-owned writes use the final root. Ordinary JSONL/managed artifacts expire 24h after closure; captured analytics remains. Privacy enabled at explicit close instead deletes the session's captured data; capture while open is allowed.
- [ANALYTICS_IMPLEMENTATION_CONTRACT.md](ANALYTICS_IMPLEMENTATION_CONTRACT.md) — owning engineering specification for typed/referenced capture, metrics, delete-on-close/lifecycle mechanics, cross-host refresh, schema evolution, query interface, handoff gates and performance budgets. Production changes still require implementation/tests.
- [ANALYTICS_EXPERIMENTS.md](ANALYTICS_EXPERIMENTS.md) — corrected synthetic SQLite/DuckDB micro-experiments, invalidated preliminary runs and remaining performance qualification. No production engine selected.
- [ANALYTICS_OVERNIGHT_RUNBOOK.md](ANALYTICS_OVERNIGHT_RUNBOOK.md) — authorized full implementation/cutover workflow, model-setting prerequisites, bounded delegation, milestone pushes to `master`, terminal activation handoff and copy-paste launch prompt.
- [BROWSER_SERVER_PLAN.md](BROWSER_SERVER_PLAN.md) — staged plan to serve the existing Pie Preact UI from the VS Code extension host over a loopback HTTP/WebSocket server, with isolated per-renderer delivery and a later authenticated-internet ingress gate. Milestones 0–2 (loopback server, multi-renderer hub, fail-closed ingress, source-aware confirmations) are implemented; milestones 3–5 (resilience pass, browser-native file/diff/export, authenticated ingress) remain.

## Implemented design references

- [SUBAGENT_PROVIDER_RESILIENCE.md](SUBAGENT_PROVIDER_RESILIENCE.md) — operational reference for the implemented subagent/provider resilience model: settlement without elapsed-time force settlement (local terminal CAS, explicit cancellation, provider bounds, generation fencing, bounded detached cleanup), provider retry/failover/circuit breaking, and correlated queued-message FIFO delivery. Remaining queued-message dwell UX and finer producer telemetry are nonblocking optional follow-ups.
- [SESSION-TITLES.md](SESSION-TITLES.md) — behavior, settings, worker contract, validation, and host-owned lifecycle for optional asynchronous LLM session titles.
- [DEFERRED-TRIGGERS.md](DEFERRED-TRIGGERS.md) — design and behavioral contract for the `defer_trigger` tool and its host-side registry: a session registers an asynchronous condition (timer / user input / another session finishing), ends its turn, and is resumed by a synthetic wake-up when it fires. Runtime code lives in `extensions/deferred-triggers/` (tool), `extension/src/host/deferred-triggers/` (registry + sidecar store), and the status-strip webview menu.
- [TOOL-RESULT-PRUNING.md](TOOL-RESULT-PRUNING.md) — design and contract for the deterministic `tool_result` middleware (strip ANSI, minify JSON, prune permission columns, collapse blank lines) before results enter context. One of three context-lean layers (history compaction / skill pruning / tool-result pruning — see the [develop-pie skill's context-lean terminology](../skills/develop-pie/SKILL.md#context-lean-terminology)). Runtime code lives in `extensions/tool-result-pruner/`; the document remains the behavioral reference and records future lossy/recall considerations.
- [MCP.md](MCP.md) — operational reference for MCP support (via the pinned `pi-mcp-adapter` pi package): the proxy-tool/lazy-server model, config scopes and precedence, how to add a server (Jira current setup), security notes, version pin vs the pi runtime, and the headless verification harness.

## Operational references

- `skills/query-analytics/SKILL.md` — agent-facing canonical analytics query contract: the normalized `analytics/analytics.sqlite` store, `analytics_provider_usage_v1` view, bounded read-only schema/query/detail/storage commands, int64-as-decimal-string rule, explicit truncation/cancellation/coverage metadata, owning-root scope and timezone/missingness semantics, and the no-legacy-fallback rule (P5; consumer routing stays cutover-gated until P7a).
- `skills/evaluate-sessions/SKILL.md` — operational reference for evidence-based, blinded agent-session evaluation: criterion-ledger reviews, independent proposals/classification, compact canonical records, batch persistence, and explicit close actions.
- [COMPUTER-USE.md](COMPUTER-USE.md) — selected dependencies, isolated runtime architecture, tool/coordinate/lifecycle contracts, acceptance evidence, verification commands, and known limitations for the generic Windows `computer` tool and skill.
- [PLAYWRIGHT.md](PLAYWRIGHT.md) — implemented contract, isolated headless runtime architecture, revision-scoped accessibility refs, artifact/output bounds, lifecycle recovery, acceptance evidence, and known limits for the first-class `playwright` tool and skill.

## Reference / informational

- [internal/centralized-model-config.md](internal/centralized-model-config.md) — design rationale for centralizing model config into `models.yaml` + the `sync-models` codegen. **Implemented**; see `README.md` (Model Configuration) for authoritative usage and the [develop-pie skill's model configuration guidance](../skills/develop-pie/SKILL.md#model-configuration). Kept as the "why" record.
- [internal/ollama-pro-cloud-models-ranked.md](internal/ollama-pro-cloud-models-ranked.md) — model evaluation notes.
- [internal/model-token-pricing-sources.md](internal/model-token-pricing-sources.md) — **authoritative evidence ledger** for all real token pricing in `models.json`. Every non-zero cost field traces back to a row here.
- [IDEAS.md](IDEAS.md) — unstructured brain-dump. Not a roadmap. Items here are candidates for evaluation, not commitments.

## Conventions

- A doc named `*_PLAN.md` under `docs/` describes work that is **either in progress or not yet started**. Remove it when the work completes and update this index.
- Plans under `docs/internal/` are status reports or implementation notes, not user-facing contracts.
- The only files downstream code may depend on (via tests pinning invariants) are `STATE_CONTRACT.md` (normative) and the runtime evidence it names. `STATE_CONTRACT_IMPLEMENTATION.md` and `STATE_CONTRACT_HISTORY.md` are supporting references and must never be pinned.
