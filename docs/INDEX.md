# Documentation index

This folder contains active design contracts, implementation plans, and operational references. Use this index instead of scanning the directory.

## Active design contracts (read first)

- [ARCHITECTURE.md](ARCHITECTURE.md) — **primary architecture reference**. System overview, pattern explanation, data flow scenarios, extension-point recipes, and invariants. Start here.
- [STATE_CONTRACT.md](STATE_CONTRACT.md) — authoritative rules for host ↔ webview state sync. Any change here requires matching tests in `extension/test/` (see `sync-contract.test.ts`).
- [internal/ARCH-OVERVIEW.md](internal/ARCH-OVERVIEW.md) — concise developer-onboarding file map. Spine file locations, glossary table, and "where to make changes" quick-reference.

## Active plans (in progress)

- [HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md](HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md) — P0 implementation handoff replacing total-duration subagent timeouts with progress-aware phase leases, bounded local settlement, provider circuit breaking, orphan cleanup, and queued-message liveness.
- [TOOL-RESULT-PRUNING.md](TOOL-RESULT-PRUNING.md) — design and contract for the implemented deterministic `tool_result` middleware (strip ANSI, minify JSON, prune permission columns, collapse blank lines) before results enter context. One of three context-lean layers (history compaction / skill pruning / tool-result pruning — see `AGENTS.md`). Runtime code lives in `extensions/tool-result-pruner/`; the document remains the behavioral reference and records future lossy/recall considerations.
- [SESSION-CHANGES-TOOL.md](SESSION-CHANGES-TOOL.md) — design for a `session_changes` tool that lets an agent inspect its own session's file changes (`list` / `diff` actions), as a compaction-surviving **change manifest** for feeding a `reviewer` subagent. **Implemented.** A new `extensions/session-changes/` extension mirroring `session-reviewer`, re-deriving from the session JSONL (compaction appends a cursor, doesn't delete — non-lossy). Extracts two shared modules: the per-tool-call derivation core (generic over `{id,name,input}`) and `FileDiffService`'s git-baseline walk. Output is most-compact and empirically tuned: `list`=TSV, `diff`=minified unified diff at `context=0` (with a `context` escape hatch), text-only with inline truncation. Own-session defaults via `ctx.sessionManager.getSessionFile()`.

## Operational references

- `skills/harness-experiments/SKILL.md` + `benchmarks/README.md` — operational reference for the `experiment:*` command suite and harness-experiments workflow: worktree/recipe/task/result contracts, headless execution, Umans-only model and credential isolation, scoring, and safety gates. The completed design record was retired once the skill and scripts became the living reference.
- `skills/evaluate-sessions/SKILL.md` — operational reference for evidence-based, blinded agent-session evaluation: criterion-ledger reviews, independent proposals/classification, scoped human verification, compact canonical records, batch persistence, and explicit close actions.
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
