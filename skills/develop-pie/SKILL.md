---
name: develop-pie
description: Work effectively in the pie repository: its VS Code extension, custom Pi extensions, agents, skills, model catalog, settings, analytics, architecture, build commands, tests, and documentation. Use when implementing, debugging, reviewing, or documenting pie itself or its Pi-based configuration; do not load for unrelated repositories merely because pie is the active agent harness.
---

# Develop pie

Use this skill only for work on the `pie` repository. **pie** is the VS Code sidebar and personal configuration stack built around the **Pi** coding-agent runtime; keep those names distinct.

## Repository map

| Path | Purpose |
|---|---|
| `extension/` | TypeScript VS Code extension: host, embedded Pi backend, Preact webview, and tests |
| `extensions/` | Reusable Pi extensions/tools such as subagents, skill pruning, safeguards, session review, and deferred triggers |
| `agents/` | Specialized subagent definitions |
| `skills/` | On-demand workflows, including this one |
| `models.yaml` | Source of truth for providers, models, pricing, eligibility, concurrency, retry policy, and seed selections |
| `docs/` | Architecture contracts, active plans, operational references, and internal notes |
| `analysis/` | Local DuckDB and static-site run analytics workspace |
| `scripts/` | Repository build, test, model-sync, install, and experiment orchestration |
| `settings.defaults.json` | Tracked portable defaults; model-owned fields are generated from `models.yaml` |
| `settings.json` | Git-ignored, machine-local Pi runtime preferences; seeded from defaults when absent |
| `APPEND_SYSTEM.md` | Personal additions to Pi's system prompt |

Start with [`README.md`](../../README.md) for setup, storage, and repository-wide workflows. Use [`docs/INDEX.md`](../../docs/INDEX.md) rather than scanning `docs/`.

## Common practices

- Read the relevant design documents completely and follow their cross-references before changing behavior.
- Prefer the root path-aware test wrappers. Do not invoke `npx tsx` directly for focused tests.
- After any edit under `extension/src/`, run the extension build; it also syncs the output into the installed VS Code extension.
- Treat [`docs/STATE_CONTRACT.md`](../../docs/STATE_CONTRACT.md) as authoritative for host↔webview synchronization. Contract changes require matching tests under `extension/test/`, including the sync-contract coverage.
- Keep the host architecture CQRS/Elm-style MVI: pure reducer, one effect runner, passive webview, explicit session addressing, and `Record<string, T>` host collections rather than `Map`/`Set`.
- Preserve unrelated working-tree changes. Generated or user-owned files may already be modified; inspect status and focused diffs before finishing.
- On Windows, the harness `bash` tool is Git Bash. Redirect to `/dev/null`, never `NUL`; a literal `NUL` file breaks Windows ripgrep traversal. Accept both `/tmp` and native `%TEMP%` paths from tools.

### Model configuration

Edit `models.yaml`, then run `npm run sync-models`. This regenerates `models.json`, `model-profiles.yaml`, and model-owned fields in `settings.defaults.json`. Do not directly edit generated model files. The git-ignored `settings.json` is machine-owned and must never be overwritten during synchronization; create it when absent with `npm run settings:init`. For provider work, also load the `add-provider` skill.

### Context-lean terminology

Do not conflate these mechanisms:

- **History compaction**: Pi summarizes older conversation history across turns (`/compact`; `compaction{enabled,reserveTokens,keepRecentTokens}`). Avoid unqualified “compaction” or “summarization.”
- **Skill pruning**: the `skill-pruner` extension's prepass removes tools or skills from the catalog for a turn (`pruning-result`; `disablePruning`). Avoid unqualified “pruning.”
- **Tool-result pruning**: deterministic middleware rewrites one tool result before it enters context (for example ANSI stripping or JSON minification). Avoid “output compaction” and “result compaction.” See [`docs/TOOL-RESULT-PRUNING.md`](../../docs/TOOL-RESULT-PRUNING.md).

## Commands

Run from the repository root unless noted:

```bash
npm ci                                      # install all locked dependency trees
npm run test                                # canonical fast unit suite
npm run test:file -- extension/test/path/to/test.ts
npm run test -- --fast --package extension --test-name-pattern="pattern"
npm run test:changed                        # fast suites affected by working-tree changes
npm run typecheck                           # all TypeScript projects
npm run check                               # model drift + typecheck + lint + changed tests
npm run verify                              # full local release gate
npm run sync-models                         # regenerate centralized model configuration
npm run sync-models -- --check              # fail on generated-config drift
npm run extension:build                     # build extension from the root
npm run analytics:serve                     # local analytics workspace
npm run doctor                              # non-destructive installation/config check
```

Extension-only loop:

```bash
cd extension
npm run build       # required after extension/src changes; build + installed-extension sync
npm run watch       # incremental Vite and TypeScript watchers
npm run test        # extension tests
npm run typecheck   # extension typecheck
npm run package     # build a .vsix
```

Choose focused tests while iterating, then run checks proportionate to the changed behavior.

## Read more by task

### pie architecture and UI

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — primary system architecture, data flow, extension points, and invariants
- [`docs/STATE_CONTRACT.md`](../../docs/STATE_CONTRACT.md) — authoritative host↔webview state contract
- [`docs/internal/ARCH-OVERVIEW.md`](../../docs/internal/ARCH-OVERVIEW.md) — concise spine-file map and glossary
- [`extension/README.md`](../../extension/README.md) — UI design philosophy and local GUI workflow
- [`docs/UX_RELIABILITY_SMOKE_TEST.md`](../../docs/UX_RELIABILITY_SMOKE_TEST.md) — manual checks for RPC, prepass, snapshot, and error-surfacing changes

### Pi runtime documentation (locked local version)

Start with [Pi's README](../../extension/node_modules/@earendil-works/pi-coding-agent/README.md), then read the topic that owns the API being changed:

- [extensions](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md) and [extension examples](../../extension/node_modules/@earendil-works/pi-coding-agent/examples/extensions/)
- [skills](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/skills.md)
- [SDK](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md) and [SDK examples](../../extension/node_modules/@earendil-works/pi-coding-agent/examples/sdk/)
- [RPC protocol](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md)
- [custom providers](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md) and [models](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/models.md)
- [settings](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/settings.md), [packages](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/packages.md), and [prompt templates](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/prompt-templates.md)
- [TUI](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/tui.md) and [keybindings](../../extension/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md)

These checked-out docs match the runtime pinned by `extension/package-lock.json`; prefer them over assumptions based on another Pi release. The upstream landing page is [pi.dev](https://pi.dev/).
