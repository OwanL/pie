# Documentation index

This folder contains active design contracts, implementation plans, and operational references. Use this index instead of scanning the directory.

## Active design contracts (read first)

- [ARCHITECTURE.md](ARCHITECTURE.md) — **primary architecture reference**. System overview, pattern explanation, data flow scenarios, extension-point recipes, and invariants. Start here.
- [STATE_CONTRACT.md](STATE_CONTRACT.md) — authoritative normative rules for host ↔ webview state sync, session lifecycle, and accounting. Any change here requires matching tests in `extension/test/` (see `sync-contract.test.ts`).
- [STATE_CONTRACT_IMPLEMENTATION.md](STATE_CONTRACT_IMPLEMENTATION.md) — non-normative mechanics behind the state contract: transport/protocol internals, byte budgets, thresholds, and file mappings. Not pinned by tests.
- [STATE_CONTRACT_HISTORY.md](STATE_CONTRACT_HISTORY.md) — completed remediation chronology (retired Brief/Phase/REM/Bug/FIX labels) and documentation-structure decisions.
- [internal/ARCH-OVERVIEW.md](internal/ARCH-OVERVIEW.md) — concise developer-onboarding file map. Spine file locations, glossary table, and "where to make changes" quick-reference.

## Active plans (in progress)

- [STABILITY-ARCHITECTURE-PLAN.md](STABILITY-ARCHITECTURE-PLAN.md) — working, outcome-oriented audit and execution plan for session lifecycle, resume/edit/interrupt behavior, accounting, history compaction, errors, non-disruptive builds, agent traversal safety, maintainability, and verification.
- [BROWSER_SERVER_PLAN.md](BROWSER_SERVER_PLAN.md) — staged plan to serve the existing Pie Preact UI from the VS Code extension host over a loopback HTTP/WebSocket server, with isolated per-renderer delivery and a later authenticated-internet ingress gate. Milestones 0–2 (loopback server, multi-renderer hub, fail-closed ingress, source-aware confirmations) are implemented; milestones 3–5 (resilience pass, browser-native file/diff/export, authenticated ingress) remain.
- [HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md](HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md) — P0 implementation handoff replacing total-duration subagent timeouts with progress-aware phase leases, bounded local settlement, provider circuit breaking, orphan cleanup, and queued-message liveness.

## Implemented design references

- [SESSION-TITLES.md](SESSION-TITLES.md) — behavior, settings, worker contract, validation, and host-owned lifecycle for optional asynchronous LLM session titles.
- [DEFERRED-TRIGGERS.md](DEFERRED-TRIGGERS.md) — design and behavioral contract for the `defer_trigger` tool and its host-side registry: a session registers an asynchronous condition (timer / user input / another session finishing), ends its turn, and is resumed by a synthetic wake-up when it fires. Runtime code lives in `extensions/deferred-triggers/` (tool), `extension/src/host/deferred-triggers/` (registry + sidecar store), and the status-strip webview menu.
- [TOOL-RESULT-PRUNING.md](TOOL-RESULT-PRUNING.md) — design and contract for the deterministic `tool_result` middleware (strip ANSI, minify JSON, prune permission columns, collapse blank lines) before results enter context. One of three context-lean layers (history compaction / skill pruning / tool-result pruning — see `AGENTS.md`). Runtime code lives in `extensions/tool-result-pruner/`; the document remains the behavioral reference and records future lossy/recall considerations.
- [MCP.md](MCP.md) — operational reference for MCP support (via the pinned `pi-mcp-adapter` pi package): the proxy-tool/lazy-server model, config scopes and precedence, how to add a server (Jira current setup), security notes, version pin vs the pi runtime, and the headless verification harness.

## Operational references

- `skills/evaluate-sessions/SKILL.md` — operational reference for evidence-based, blinded agent-session evaluation: criterion-ledger reviews, independent proposals/classification, compact canonical records, batch persistence, and explicit close actions.
- [COMPUTER-USE.md](COMPUTER-USE.md) — selected dependencies, isolated runtime architecture, tool/coordinate/lifecycle contracts, acceptance evidence, verification commands, and known limitations for the generic Windows `computer` tool and skill.
- [PLAYWRIGHT.md](PLAYWRIGHT.md) — implemented contract, isolated headless runtime architecture, revision-scoped accessibility refs, artifact/output bounds, lifecycle recovery, acceptance evidence, and known limits for the first-class `playwright` tool and skill.

## Reference / informational

- [internal/centralized-model-config.md](internal/centralized-model-config.md) — design rationale for centralizing model config into `models.yaml` + the `sync-models` codegen. **Implemented**; see `README.md` (Model Configuration) and `AGENTS.md` for authoritative usage. Kept as the "why" record.
- [internal/ollama-pro-cloud-models-ranked.md](internal/ollama-pro-cloud-models-ranked.md) — model evaluation notes.
- [internal/model-token-pricing-sources.md](internal/model-token-pricing-sources.md) — **authoritative evidence ledger** for all real token pricing in `models.json`. Every non-zero cost field traces back to a row here.
- [IDEAS.md](IDEAS.md) — unstructured brain-dump. Not a roadmap. Items here are candidates for evaluation, not commitments.

## Conventions

- A doc named `*_PLAN.md` under `docs/` describes work that is **either in progress or not yet started**. Remove it when the work completes and update this index.
- Plans under `docs/internal/` are status reports or implementation notes, not user-facing contracts.
- The only files downstream code may depend on (via tests pinning invariants) are `STATE_CONTRACT.md` (normative) and the runtime evidence it names. `STATE_CONTRACT_IMPLEMENTATION.md` and `STATE_CONTRACT_HISTORY.md` are supporting references and must never be pinned.
