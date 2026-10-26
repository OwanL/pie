---
name: develop-pie
description: "Use for Pie application/runtime source implementation, debugging, review and documentation; use customize-pie for supported workflow and configuration customisation."
---

# Develop pie

Use this skill for actual Pie source work. **Pie** is the application and configuration stack; **Pi** is its coding-agent runtime.

Prefer `customize-pie` for supported instructions, named agents/skills, compatible extensions/custom tools and integration configuration. Writing extension code does not inherently require a source fork. Built-in UI, storage, runtime/lifecycle changes and implementations beyond supported hooks belong here; do not force fragile customisation workarounds.

Ordinary instruction additions retain defaults (bundled → eligible user → applicable project); named agent/skill replacement targets project > user > bundled, selecting complete definitions rather than merging bodies. `SYSTEM.md` explicitly replaces the base prompt, unlike `APPEND_SYSTEM.md`; separately enabled context/role layers remain separate. Respect main/child boundaries, tool scopes and prompt toggles. These are selected boundaries, not a claim that every installed loader implements layered additions or packaged replacement. Inspect the active version/profile and owning discovery code before promising behavior. MCP and executable extensions retain their own loading/merge rules.

Identify the source checkout and version before proceeding. If source work is necessary and no suitable checkout exists, read [source setup](source-setup.md) on demand; do not acquire source automatically. Repository references below are relative to **that identified source checkout**, never to a bundled skill. Only skill-local companion links resolve from this skill directory.

Also load `add-provider` for provider/model work, `diagnose` for difficult bugs, or `grill-with-docs` when challenging a plan against documented decisions.

## Common practices

- Use repository-root Proto/pnpm scripts. Preserve unrelated working-tree changes, including user-owned settings.
- Start with the README (`README.md` in the source checkout) for setup and workflows, and Architecture (`docs/architecture/ARCHITECTURE.md#ownership-and-dependencies` in the source checkout) for ownership boundaries. Search for task-specific docs rather than loading everything. Follow the documentation policy (`docs/DOCUMENTATION-POLICY.md` in the source checkout): keep guidance short and link instead of duplicating.
- Keep the host CQRS/Elm-style MVI: pure reducer, one effect runner, passive webview, explicit session addressing, and `Record<string, T>` host collections rather than `Map`/`Set`.
- Read the state contract (`docs/contracts/STATE_CONTRACT.md` in the source checkout) before changing host↔webview synchronization; update owning tests, including `test/integration/sync-contract.test.ts`, when the contract changes.
- Read the analytics contract (`docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md` in the source checkout) before changing capture, privacy, or storage. Production uses canonical SQLite, never legacy fallback or dual-write. Source behavior does not prove live activation or authorize the separate storage cutoff.
- Moon's affected selection needs explicit consumer-source inputs; project dependencies alone do not select consumers. Do not add deep task traversal to ordinary checks: it can include artifact tasks. Use `proto run moon -- run root:graphTest` to qualify selection without builds or providers.
- Stage builds after completing milestones.

## Commands

Run from the repository root:

```bash
proto run pnpm -- run setup              # gated, frozen-lockfile dependency setup
proto run pnpm -- run test:file path/to/test.ts
proto run pnpm -- run test               # affected Moon project tests
proto run pnpm -- run test:all           # all configured ordinary test tasks
proto run pnpm -- run test:artifact      # separate SDK/artifact fixtures
proto run pnpm -- run check              # model drift, typecheck, affected tests
proto run pnpm -- run verify             # model drift, typecheck, all ordinary tests, build
proto run pnpm -- run build              # local development output only
proto run pnpm -- run watch              # local build plus renderer reload
proto run pnpm -- run dev                # isolated standalone development host
proto run pnpm -- run dev:vscode         # isolated VS Code development host
```

### Verification

Choose focused tests while iterating, then checks proportionate to the change. Use `test:file`, not direct `npx tsx`; native test flags follow `--`, for example `-- --test-name-pattern=pattern`.

Ordinary tests exclude `*.artifact.test.*`. Use `test:artifact` for those fixtures; provider/integration cases may still require credentials or opt-in. For focused SDK-backed tests, `test:file --sdk-path` must point to the coding-agent package inside a separately verified `pi-runtime`, never the native Pi workspace. That option supplies aliases; it does not verify or acquire the artifact.

Use `test:coverage` / `verify:release` for TypeScript coverage; native TypeScript coverage remains unqualified. See test and validation guidance (`README.md#test-and-validate` in the source checkout) for artifact reuse, compatibility limits, browser/integration routes, and coverage details.

### Build and delivery

`build` and `watch` write to `application/hosts/vscode/out-dev`, never installed output. For backend/Pi refresh: **stop the isolated host → build → relaunch**. Renderer watch rebuilds/reloads; it is not HMR. The development profile does not copy installed settings/auth, but may inherit provider environment variables.

Setup/rebuild must respect active workspace readers. Preserve the installed host; never bypass the workspace gate (`lib/development-runtime/lifetime.mjs` in the source checkout), reclaim registrations by PID/age, or delete gate state. Uncertain process teardown is not permission to rebuild.

Delivery is explicit: `delivery:build` builds without publishing, `delivery:qualify` runs private relocated-host/browser smoke checks, and `extension:publish` publishes to the matching local installed extension (not the Marketplace). Loader setup/upgrade additionally requires explicit `--delivery --activate`. **Built, staged, loaded, and behavior verified are different states.** Verify the active host/build before claiming a live fix; reopening the sidebar is not an extension-host restart.

Visible Electron acceptance requires user consent and `PIE_RUN_ELECTRON_ACCEPTANCE=1`; it is never an ordinary check. See the build/run guide (`README.md#build-and-run-pie-from-source` in the source checkout) for delivery, profiles, and opt-in acceptance commands.

## Model configuration

Edit `models.yaml`, then run `proto run pnpm -- run sync-models`. Do not hand-edit generated `models.json`, `model-profiles.yaml`, or model-owned fields in `settings.json`. Settings are tracked; preserve user-owned chat/pruning selections. If missing, seed settings with `proto run pnpm -- run settings:init`.

Use `proto run pnpm -- run sync-models -- --check` and the focused `scripts/model-config/test/model-config-sync.test.ts` test to check drift. Load `add-provider` for provider-specific rules.

## Pi API references

For the running harness's Pi APIs, use the pinned SDK docs/examples identified in the session instructions. For changes to in-tree Pi source, also consult that checkout's coding-agent README (`harness/pi/packages/coding-agent/README.md` in the source checkout) and its linked docs/examples. Do not assume checkout source and the installed runtime match.

A package version alone does not identify a built runtime: use the verified artifact's `pi-runtime/manifest.json`. The runtime guide (`harness/pi-runtime/README.md` in the source checkout) owns artifact construction/identity; the productization plan (`docs/plans/PIE-PRODUCTIZATION.md` in the source checkout) records source provenance and acceptance status.

## Terminology

Keep these mechanisms distinct; avoid unqualified “compaction” or “pruning”:

- **History compaction:** Pi summarizes older conversation history across turns (`/compact`).
- **Skill pruning:** the `skill-pruner` prepass removes tools/skills from a turn's catalog.
- **Tool-result pruning:** deterministic middleware rewrites a tool result before it enters context; see its contract (`docs/contracts/TOOL-RESULT-PRUNING.md` in the source checkout).
