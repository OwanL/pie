---
name: customize-pie
description: "Use when tailoring Pie instructions, agents, skills, supported extensions/custom tools, or integration configuration without changing application/runtime source."
---

# Customize Pie

Prefer supported customisation when it meets the request. Writing an extension or helper is not automatically a source fork. Changes to built-in UI, storage, runtime lifecycle or implementations beyond supported hooks are source work: load `develop-pie`. Do not force a fragile workaround to avoid source changes.

## Choose the surface

- **Working preferences/project rules:** use supported user instructions and applicable project context such as `AGENTS.md`. These are guidance, not execution hooks. Preserve existing defaults and user-owned files; add only the requested preferences.
- **Named agents:** define a role, description and supported tool/delegation scope. A tool allowlist selects available tools; it does not implement tools. Preserve read-only and child delegation boundaries.
- **Skills:** add focused `SKILL.md` guidance with `name` and `description` frontmatter, plus necessary local companions. Discovery neither installs helper dependencies nor grants tools. Resolve companion links from the skill directory, not the working directory.
- **Extensions/custom tools/helper scripts:** use supported runtime hooks and current loading/trust rules. Check the installed SDK API, dependencies, tool collisions and Pie host/UI compatibility. Arbitrary Pi/OMP terminal-UI extensions are not necessarily compatible. Do not promise same-name tool replacement or a plugin installer/update manager.
- **Provider/model configuration:** use the running version's supported Settings, validated configuration and authentication routes. An endpoint using an existing protocol can be configuration; unsupported protocols/authentication require a qualified extension seam or source changes. Load `add-provider` for specialised work.
- **MCP:** server definitions, external server software and credentials are separate from the adapter implementation. Inspect the active adapter/configuration before editing. Preserve its own merge, lazy-connection and global/session reload rules; instruction precedence does not apply to MCP. Do not bundle personal connections or secrets, or assume main-session switches govern children.

Keep useful bundled capabilities available; dependencies or source-oriented passages call for focused adaptation, not wholesale removal of skills. Keep preferences, credentials, history and caches outside application-owned immutable generations and public commits.

## Additions versus replacement

The selected composition is bundled defaults → eligible user additions → applicable project additions; explicit user/project guidance can override defaults without discarding the rest. `AGENTS.md` is separately scoped context, not a named agent replacement.

For **named agent/skill definitions**, the selected target is project > user > bundled within the applicable project and explicit discovery scope. Select one complete definition (including its skill companions), not merged bodies/directories. A replacement stays user-owned across updates; manually incorporate later default improvements. Removing it should reveal the current applicable default.

`APPEND_SYSTEM.md` is an addition surface. Native `SYSTEM.md` is explicit **base-prompt replacement**, not a routine way to add preferences; separately enabled context/role layers remain separate. Keep main working preferences out of children; children retain their role, shared child guidance and supported child-specific additions. Respect prompt-entry toggles and tool eligibility; never re-enable disabled layers through customisation.

**Implementation limit:** these are selected product boundaries, not proof that every installed release implements layered additions or three-level replacement. Earlier loaders choose one project/global append and use central guidance only as fallback. Resource packaging/discovery is still being qualified. Inspect the running version, resolved profile/config and actual discovery before choosing file locations or promising precedence. Do not invent normal-user resource directories, copy another profile, or present planned UI/CLI operations as available. Use the supported reload lifecycle; do not silently hot-swap active work.

## Make and verify a bounded change

1. Identify the active version/profile and applicable project; inspect its supported resource roots and current definitions. Ask for the intended scope if unclear. Use the running harness's pinned SDK references for extension APIs, not an unrelated checkout or latest upstream docs.
2. Preserve existing personal files. Edit only the selected surface; keep executable hooks and external-service access explicit rather than hiding them in preferences. Obtain approval for dependencies, credentials, external traffic or application activation when needed.
3. Verify discovery, effective instructions and applicable role/tool scope with a small local example. Check project isolation and removal of replacements where relevant. Do not claim loading or live behavior from file creation alone.

For checkout-backed investigation, first identify the source checkout matching the relevant version. Paths below are relative to **that checkout**, never to this bundled skill: `harness/agent-instructions/agent-discovery/agents.ts`, `harness/agent-instructions/skill-discovery/README.md`, `harness/tools/README.md`, `docs/operations/MCP.md`, and `docs/plans/PIE-PRODUCTIZATION.md`. No source checkout is required for ordinary supported customisation; if implementation changes are necessary, hand off to `develop-pie` and its on-demand setup companion.
