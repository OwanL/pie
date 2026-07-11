# Documentation index

This folder mixes design contracts, implementation plans (some completed, some open), and historical brain-dumps. Use this index instead of scanning the directory.

## Active design contracts (read first)

- [ARCHITECTURE.md](ARCHITECTURE.md) — **primary architecture reference**. System overview, pattern explanation, data flow scenarios, extension-point recipes, and invariants. Start here.
- [STATE_CONTRACT.md](STATE_CONTRACT.md) — authoritative rules for host ↔ webview state sync. Any change here requires matching tests in `extension/test/` (see `sync-contract.test.ts`).
- [internal/ARCH-OVERVIEW.md](internal/ARCH-OVERVIEW.md) — concise developer-onboarding file map. Spine file locations, glossary table, and "where to make changes" quick-reference.

## Active plans (in progress)

- [HARDENING-AUDIT-2026-07.md](HARDENING-AUDIT-2026-07.md) — current reliability/DX/analytics/portability audit, reproduced failures, completed first-response fixes, and prioritized P0–P2 acceptance gates.
- [HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md](HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md) — P0 implementation handoff replacing total-duration subagent timeouts with progress-aware phase leases, bounded local settlement, provider circuit breaking, orphan cleanup, and queued-message liveness.
- [AGENT-HARNESS-IMPROVEMENTS.md](AGENT-HARNESS-IMPROVEMENTS.md) — agent/harness reliability plan (subagent fan-out, umans provider backpressure, prompt hygiene). **Mostly shipped**: LiteLLM proxy (item 1), in-process subagent semaphore + configurable throughput caps (item 2), `subagentMaxDepth = 0` disabled mode (item 3), tightened defaults (item 5), and the static `APPEND_SYSTEM.md` "prefer sequential" rewrite (item 4) are all done. **Only item 4's adaptive portion remains** — injecting the directive dynamically from a measured `providerBusy` signal (extend `token-rate-service.ts`) instead of a static prompt.
- [TOOL-RESULT-PRUNING.md](TOOL-RESULT-PRUNING.md) — design and contract for the implemented deterministic `tool_result` middleware (strip ANSI, minify JSON, prune permission columns, collapse blank lines) before results enter context. One of three context-lean layers (history compaction / skill pruning / tool-result pruning — see `AGENTS.md`). Runtime code lives in `extensions/tool-result-pruner/`; the document remains the behavioral reference and records future lossy/recall considerations.
- [SESSION-CHANGES-TOOL.md](SESSION-CHANGES-TOOL.md) — design for a `session_changes` tool that lets an agent inspect its own session's file changes (`list` / `diff` actions), as a compaction-surviving **change manifest** for feeding a `reviewer` subagent. **Implemented.** A new `extensions/session-changes/` extension mirroring `session-reviewer`, re-deriving from the session JSONL (compaction appends a cursor, doesn't delete — non-lossy). Extracts two shared modules: the per-tool-call derivation core (generic over `{id,name,input}`) and `FileDiffService`'s git-baseline walk. Output is most-compact and empirically tuned: `list`=TSV, `diff`=minified unified diff at `context=0` (with a `context` escape hatch), text-only with inline truncation. Own-session defaults via `ctx.sessionManager.getSessionFile()`.

## Operational references

- [UX_RELIABILITY_SMOKE_TEST.md](UX_RELIABILITY_SMOKE_TEST.md) — manual smoke-test checklist for the scenarios that need a real backend / human interaction (slow prepass, wedged webview, forced stderr). Companion to the now-completed UX & Reliability remediation (Briefs A–H); run after any change touching the host↔backend RPC boundary, prepass lifecycle, snapshot/reconciliation path, or error surfacing.

## Archived plans (removed — see git history)

Historical migration and planning documents were removed from the tree after completion. Check git history for the original content:

- `ARCH-MIGRATION-PLAN.md` — multi-phase extension host + webview migration to CQRS/Elm/MVI.
- `HANDOFF_mvi-migration.md` — MVI migration tracker (Phases 0–5, 12 Phase 5 items). **Completed** — the MessageRouter is 100% Commands, `QueueManager` deleted, all per-session keyed maps cleaned on session close, optimistic-op TTL in place, all deferred items resolved. The code is now the authoritative record; see `ARCHITECTURE.md` and `STATE_CONTRACT.md`.
- `PLAN-extension-ui-questions.md` — extension UI question resolution.
- `PLAN-llm-pruner-rewrite.md` — LLM-based skill pruning implementation.
- `PLAN-skill-tool-pruning.md` — skill/tool pruning design and implementation.
- `model-token-pricing-implementation-plan.md` — token-pricing migration; **completed**. Pricing now lives in `extensions/subagent/pricing.ts` + `extension/src/backend/pricing.ts`; authoritative price evidence in `internal/model-token-pricing-sources.md`.
- `ui-ux-review.md` — pie webview UI/UX engineering review (41 findings across hitboxes, a11y, streaming jank, virtualization, tabs, overlays). **Completed** across two rounds (commits `b1a0107` + `5a1804c`); the code is the authoritative record.
- `audit-ui-subagent-prompt.md` — UI & subagent systems audit (integrity / duplication / architecture findings with P0–P2 remediation steps). Historical report; remediations landed in code.
- `model-scoring-methodology.md` — superseded fitness-based model-scoring methodology; replaced by the data-driven stratified leaderboard (`analysis/scripts/stratified-ranker.ts`).
- `subagent-ask-user-design.md` — subagent `ask_user` support design (multi-entry pending requests, parent-bridge proxy, subagent-scoped webview rendering). **Implemented**.
- `subagent-model-selection-v2.md` — subagent model-selection v2 (bucket system). **Implemented** in `extensions/subagent/bucket-selector.ts` + `bridge.ts`.
- `EXPANDED-SECTION-UI-PLAN.md` — bash/terminal + reasoning-preview expanded-section decisions (bound reasoning, shared `expandedSectionMaxHeight`, reduced default max-height, removed "hold close while turn active"). **Implemented**; `expandedSectionMaxHeight` lives in `extension/src/shared/protocol/settings.ts`; the code is authoritative.
- `CHANGED-FILES-UI-PLAN.md` — right-side changed-files rail decisions (peek-vs-pin, drag-resizable width, removed auto-open-on-arrival, per-file diff bar). **Implemented**; `autoOpenFileChangesRail` / `autoExpandedBySession` removed, `use-resizable-width.ts` present; the code is authoritative.
- `UX_RELIABILITY_PLAN.md` — orchestrator playbook for Briefs A–H (timeout, optimistic lifecycle, stale-state, error mapping). **Completed** across 4 rounds (commits `5d8b964`, `3222af9`, `135cb52`, `a2575a9`); the code is authoritative. The manual smoke-test matrix lives on as `UX_RELIABILITY_SMOKE_TEST.md`.
- `HANDOFF_UX_RELIABILITY_REMAINING.md` — handoff for UX-reliability follow-ups (Bucket 1–3). **Completed**: NoticeBanner action buttons wired, `disablePruning` restores prior mode, `PREPASS_TIMEOUT_PATTERN` handles decimal budgets, pie log channel exists, Brief F/D transition tests added. The code is authoritative.

## Reference / informational

- [internal/centralized-model-config.md](internal/centralized-model-config.md) — design rationale for centralizing model config into `models.yaml` + the `sync-models` codegen. **Implemented**; see `README.md` (Model Configuration) and `AGENTS.md` for authoritative usage. Kept as the "why" record.
- [internal/ollama-pro-cloud-models-ranked.md](internal/ollama-pro-cloud-models-ranked.md) — model evaluation notes.
- [internal/copilot-model-pricing.md](internal/copilot-model-pricing.md) — GitHub Copilot premium request multipliers, token pricing, and cost mapping for `model-profiles.yaml`. Self-marked superseded by the ledger below.
- [internal/model-token-pricing-sources.md](internal/model-token-pricing-sources.md) — **authoritative evidence ledger** for all real token pricing in `models.json`. Every non-zero cost field traces back to a row here.
- [internal/code-review/](internal/code-review/) — completed codebase-review pass (findings `01_…`–`09_…`, `SUMMARY_structural_issues.md`, `ORCHESTRATOR_PROMPT.md`, `TODO-archive.md`). Historical; all items done (see `TODO-archive.md` status table). Referenced by `README.md` (macOS/Linux install parity) and `package.json`. Read as a record, not a live backlog.
- [IDEAS.md](IDEAS.md) — unstructured brain-dump. Not a roadmap. Items here are candidates for evaluation, not commitments.

## Conventions

- A doc named `*_PLAN.md` under `docs/` describes work that is **either in progress or not yet started**. When work completes, update the plan with an explicit "closed" status at the top, or remove the plan doc and update this index to reflect the code as the authoritative record.
- Plans under `docs/internal/` are status reports or implementation notes, not user-facing contracts.
- The only file in `docs/` that downstream code is allowed to depend on (via tests pinning invariants) is `STATE_CONTRACT.md`.