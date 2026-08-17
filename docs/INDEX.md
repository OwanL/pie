# Documentation index

This folder contains active design contracts, implementation plans, and operational references. Use this index instead of scanning the directory.

## Active design contracts (read first)

- [ARCHITECTURE.md](ARCHITECTURE.md) — **primary architecture reference**. System overview, pattern explanation, data flow scenarios, extension-point recipes, and invariants. Start here.
- [STATE_CONTRACT.md](STATE_CONTRACT.md) — authoritative rules for host ↔ webview state sync. Any change here requires matching tests in `extension/test/` (see `sync-contract.test.ts`).
- [internal/ARCH-OVERVIEW.md](internal/ARCH-OVERVIEW.md) — concise developer-onboarding file map. Spine file locations, glossary table, and "where to make changes" quick-reference.

## Active plans (in progress)

- [BROWSER_SERVER_PLAN.md](BROWSER_SERVER_PLAN.md) — staged plan to serve the existing Pie Preact UI from the VS Code extension host over a loopback HTTP/WebSocket server, with isolated per-renderer delivery and a later authenticated-internet ingress gate.
- [SESSION_RUNTIME_ISOLATION_PLAN.md](SESSION_RUNTIME_ISOLATION_PLAN.md) — P0 implementation handoff for a lightweight coordinator plus one process-isolated worker per hot root session, preserving cold browse/control liveness and complete demand-driven subagent detail.
- [HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md](HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md) — P0 implementation handoff replacing total-duration subagent timeouts with progress-aware phase leases, bounded local settlement, provider circuit breaking, orphan cleanup, and queued-message liveness.

## Implemented design references

- [TOOL-RESULT-PRUNING.md](TOOL-RESULT-PRUNING.md) — design and contract for the deterministic `tool_result` middleware (strip ANSI, minify JSON, prune permission columns, collapse blank lines) before results enter context. One of three context-lean layers (history compaction / skill pruning / tool-result pruning — see `AGENTS.md`). Runtime code lives in `extensions/tool-result-pruner/`; the document remains the behavioral reference and records future lossy/recall considerations.
- [SESSION-CHANGES-TOOL.md](SESSION-CHANGES-TOOL.md) — design rationale for the implemented `session_changes` tool, which exposes a session-scoped change manifest (`list` / `diff`) for feeding a `reviewer` subagent. Runtime code lives in `extensions/session-changes/`; shared derivation and git-baseline helpers live under `extension/src/shared/`.

## Operational references

- `skills/harness-experiments/SKILL.md` + `benchmarks/README.md` — operational reference for the `experiment:*` command suite and harness-experiments workflow: worktree/recipe/task/result contracts, headless execution, Umans-only model and credential isolation, scoring, and safety gates. The completed design record was retired once the skill and scripts became the living reference.
- `skills/evaluate-sessions/SKILL.md` — operational reference for evidence-based, blinded agent-session evaluation: criterion-ledger reviews, independent proposals/classification, compact canonical records, batch persistence, and explicit close actions.
- [COMPUTER-USE.md](COMPUTER-USE.md) — selected dependencies, isolated runtime architecture, tool/coordinate/lifecycle contracts, acceptance evidence, verification commands, and known limitations for the generic Windows `computer` tool and skill.
- [UX_RELIABILITY_SMOKE_TEST.md](UX_RELIABILITY_SMOKE_TEST.md) — manual smoke-test checklist for the scenarios that need a real backend / human interaction (slow prepass, wedged webview, forced stderr). Companion to the now-completed UX & Reliability remediation (Briefs A–H); run after any change touching the host↔backend RPC boundary, prepass lifecycle, snapshot/reconciliation path, or error surfacing.

## Reference / informational

- [audits/2026-07-15-stability-correctness-audit.md](audits/2026-07-15-stability-correctness-audit.md) — whole-repository stability/correctness audit, verified fixes, provider/transcript matrices, measurements, and prioritized residual risks.
- [OMP-COMPARISON-2026-07.md](OMP-COMPARISON-2026-07.md) — evidence-backed comparison with Oh My Pi at a pinned commit, including capability gaps, features pie should keep distinct, and a measured P0–P2 adoption roadmap. Research/roadmap only; not an active implementation plan.
- [internal/centralized-model-config.md](internal/centralized-model-config.md) — design rationale for centralizing model config into `models.yaml` + the `sync-models` codegen. **Implemented**; see `README.md` (Model Configuration) and `AGENTS.md` for authoritative usage. Kept as the "why" record.
- [internal/ollama-pro-cloud-models-ranked.md](internal/ollama-pro-cloud-models-ranked.md) — model evaluation notes.
- [internal/model-token-pricing-sources.md](internal/model-token-pricing-sources.md) — **authoritative evidence ledger** for all real token pricing in `models.json`. Every non-zero cost field traces back to a row here.
- [internal/experiments/capability-disclosure-screen-2026-07-17.md](internal/experiments/capability-disclosure-screen-2026-07-17.md) — controlled forced-hidden screening of unified vs separate tool/skill recovery and immediate vs metadata skill loading; promotes unified immediate disclosure to end-to-end testing.
- [IDEAS.md](IDEAS.md) — unstructured brain-dump. Not a roadmap. Items here are candidates for evaluation, not commitments.

## Conventions

- A doc named `*_PLAN.md` under `docs/` describes work that is **either in progress or not yet started**. Remove it when the work completes and update this index.
- Plans under `docs/internal/` are status reports or implementation notes, not user-facing contracts.
- The only file in `docs/` that downstream code is allowed to depend on (via tests pinning invariants) is `STATE_CONTRACT.md`.
