# Documentation index

`docs/` is organized by purpose. Use this index rather than scanning the directory.

## Architecture

- [ARCHITECTURE.md](architecture/ARCHITECTURE.md) — **primary architecture reference**: system overview, data flow, extension points, and invariants. Start here.
- [ARCH-OVERVIEW.md](architecture/ARCH-OVERVIEW.md) — concise developer-onboarding file map, glossary, and “where to make changes” guide.
- [STATE_CONTRACT_IMPLEMENTATION.md](architecture/STATE_CONTRACT_IMPLEMENTATION.md) — non-normative mechanics behind the state contract: transport/protocol internals, byte budgets, thresholds, and file mappings. Not pinned by tests.
- [UI-DESIGN-PHILOSOPHY.md](architecture/UI-DESIGN-PHILOSOPHY.md) — UI goals, interaction principles, and component map.

## Contracts

- [STATE_CONTRACT.md](contracts/STATE_CONTRACT.md) — authoritative normative rules for host ↔ webview state sync, session lifecycle, and accounting. Contract changes require matching tests under the registered integration test roots.
- [ANALYTICS_IMPLEMENTATION_CONTRACT.md](contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) — living contract for analytics authority, the OS-local data root, exclusive capture, privacy, read-only queries, retained `analytics/analysis/` tooling, and the gated `PIE_STORAGE_CUTOFF_AUTHORIZATION` cutoff. Activation status is not recorded here.
- [AGENT-SESSION-CONTROL.md](contracts/AGENT-SESSION-CONTROL.md) — local session discovery, transcript paging, messaging, creation, and lifecycle close.
- [DEFERRED-TRIGGERS.md](contracts/DEFERRED-TRIGGERS.md) — behavior and compatibility contract for `defer_trigger` and its host-side registry.
- [SESSION-TITLES.md](contracts/SESSION-TITLES.md) — behavior, settings, worker contract, validation, and host-owned lifecycle for optional asynchronous LLM session titles.
- [STATE_CONTRACT_HISTORY.md](contracts/STATE_CONTRACT_HISTORY.md) — completed remediation chronology and documentation-structure decisions; historical, not pinned by tests.
- [SUBAGENT_PROVIDER_RESILIENCE.md](contracts/SUBAGENT_PROVIDER_RESILIENCE.md) — operational reference for subagent/provider resilience and queued-message delivery.
- [TOOL-RESULT-PRUNING.md](contracts/TOOL-RESULT-PRUNING.md) — deterministic `tool_result` middleware contract. History compaction, skill pruning, and tool-result pruning remain distinct.
- [ANALYTICS-UI-AND-AUTHORITY.md](contracts/ANALYTICS-UI-AND-AUTHORITY.md) — concise retained note on legacy analytics UI visibility and authority behavior; the analytics implementation contract is authoritative.

## Plans

- [BROWSER_SERVER_PLAN.md](plans/BROWSER_SERVER_PLAN.md) — staged plan for the existing Pie Preact UI over loopback-default HTTP/WebSocket, explicit unauthenticated trusted-LAN IPv4 opt-in, isolated per-renderer delivery, and separately gated future authenticated-internet ingress. Milestones 0–2 and standalone runtime extraction are implemented; milestones 3–5 remain.
- [REPOSITORY_ORGANIZATION_PLAN.md](plans/REPOSITORY_ORGANIZATION_PLAN.md) — completed B0–B8 target-organization and migration acceptance record; final post-fix verification is complete in the working tree. No restart/live deployment or commit/push is claimed. See the [migration progress checkpoint](plans/repository-organization-migration-progress.md).
- [Migration baseline verification](plans/repository-organization-baseline-verification.md) — original pre-migration verification evidence and limitations.

## Operations

- [AGENT-WORKFLOWS.md](operations/AGENT-WORKFLOWS.md) — current-state and research findings for agent coordination, session-scoped change review, deferred work, and persistent sessions; not an implemented contract.
- [COMPUTER-USE.md](operations/COMPUTER-USE.md) — selected dependencies, isolated runtime architecture, tool/coordinate/lifecycle contracts, acceptance evidence, verification, and known limitations.
- [GUI-DEVELOPMENT.md](operations/GUI-DEVELOPMENT.md) — local GUI build/watch/reload workflow.
- [MCP.md](operations/MCP.md) — MCP support, configuration scopes, adding servers, security notes, version pin, and headless verification.
- [PLAYWRIGHT.md](operations/PLAYWRIGHT.md) — implemented headless-browser contract, runtime architecture, accessibility refs, artifact bounds, recovery, and known limits.
- [centralized-model-config.md](operations/centralized-model-config.md) — historical rationale for centralizing model configuration. The active usage instructions are in the root README and the [develop-pie skill](../harness/agent-instructions/skills/develop-pie/SKILL.md#model-configuration).

## Research and history

- [repository-organization-navigation-study-2026-09-24.md](research/repository-organization-navigation-study-2026-09-24.md) — qualitative study of 25 synthetic navigation/placement probes, including negative outcomes and limits. It is not a controlled benchmark, validated migration, or superiority claim.
- [analytics-cost-audit-2026-09-23.md](research/analytics-cost-audit-2026-09-23.md) — historical pricing audit.
- [HISTORY-COMPACTION-REAL-SESSION-EVALUATION-2026-07-19.md](research/HISTORY-COMPACTION-REAL-SESSION-EVALUATION-2026-07-19.md) — historical evaluation notes.
- [model-token-pricing-sources.md](research/model-token-pricing-sources.md) — authoritative evidence ledger for real token pricing in `models.json`.
- [ollama-pro-cloud-models-ranked.md](research/ollama-pro-cloud-models-ranked.md) — model evaluation notes.
- [2026-07-16.md](research/2026-07-16.md) — retained historical report.
- [IDEAS.md](research/IDEAS.md) — unstructured brain-dump, not a roadmap; items are candidates for evaluation, not commitments.

## Other active references

- [Pie tool catalog and consolidation](../harness/tools/README.md) — explicit tool ownership/context inventory and registration boundaries. Implementations live under `harness/tools/`; coordinator composition lives under `harness/agent-processes/coordinator/`; stable `extensions/<id>/index.ts` discovery shims remain; native dependency owners remain under `extensions/computer-use/` and `extensions/playwright/`.
- [query-analytics skill](../harness/agent-instructions/skills/query-analytics/SKILL.md) — agent-facing canonical analytics query contract. The store exists only under canonical analytics authority; the skill is not evidence that authority is active.

## Conventions

- Plans live under `docs/plans/` and describe work in progress or not yet started; completed migration plans may be retained as linked closeout records.
- Architecture, contracts, operations, plans, and research live in their corresponding category directories. Historical records retain their original claims and evidence semantics; do not promote them into current contracts.
- The only documentation whose invariants may be pinned by downstream code/tests is [STATE_CONTRACT.md](contracts/STATE_CONTRACT.md) plus its named runtime evidence. [STATE_CONTRACT_IMPLEMENTATION.md](architecture/STATE_CONTRACT_IMPLEMENTATION.md) and [STATE_CONTRACT_HISTORY.md](contracts/STATE_CONTRACT_HISTORY.md) are supporting references and must never be pinned.
