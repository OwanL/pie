# Pie repo specific conventions

Personal pi config stack: VS Code extension GUI ("pie"), custom pi extensions, agents, skills, and centralized settings.

- `extension/` — VS Code extension
- `extensions/` — Custom pi tools ie `subagent`
- `docs/` — Internal design docs; `STATE_CONTRACT.md` is authoritative for host↔webview sync
- `models.yaml` — single source of truth for the provider catalog, pricing, eligibility, concurrency, retry policy, and initial model selections. Run `npm run sync-models` after editing it; that regenerates `models.json` and `model-profiles.yaml`, and merges into `settings.json`. Existing chat/pruning selections are user-owned and preserved. Do not edit generated files directly — `extension/test/integration/model-config-sync.test.ts` fails on drift.

Use the repository-root wrappers for normal development and agent validation:

```bash
npm test                                      # dependency-aware tests for working-tree changes
npm run test:file -- extension/test/x.test.ts # focused test file(s); pass multiple paths if needed
npm run test:all                              # full fast suite
npm run typecheck                             # all TypeScript projects
npm run lint                                  # all configured lint checks (currently the extension)
npm run check                                 # model drift + typecheck + lint + changed tests
npm run verify                                # pre-push: drift + typecheck + lint + full fast suite + build
```

`npm test` is the default final development test command. It resolves changed
files to affected tests, runs package groups concurrently, and conservatively
broadens the selection when dependency evidence is incomplete. Use `test:file`
while iterating rather than invoking `npx tsx` directly. Use
`npm run test:coverage` only for the explicit release coverage gate.

**Always rebuild after editing `extension/src/`** with
`npm run extension:build`; it auto-syncs output to the installed VS Code
extension. Package from the root with `npm run extension:package`. For an
extension-only loop:

```bash
cd extension
npm run build      # build + sync
npm run watch      # incremental
npm run test       # extension unit tests
npm run typecheck  # extension type-check only
npm run lint       # extension ESLint
npm run package    # produce .vsix
```

On Windows the harness `bash` tool is Git Bash, not PowerShell. Use `/dev/null`
for shell redirection, never `NUL`; a literal `NUL` file breaks Windows ripgrep
traversal. Native Windows programs may print `%TEMP%` paths even when Bash also
exposes the same directory as `/tmp`; tools should accept either spelling. Use
native `C:/...` paths for Windows programs and Git-Bash `/c/...` paths for shell
commands. For Node ESM imports from a Windows path, use
`pathToFileURL(...).href` instead of importing a raw drive-letter path. Scope
`MSYS2_ARG_CONV_EXCL` to the individual native command that needs it; never set
it globally. When no ripgrep match is an acceptable result, use `rg ... || true`.

## Context-lean layers

Three distinct mechanisms keep the model's context lean. Don't conflate them — they operate on different objects at different times.

**History compaction**:
pi's LLM summarization of old messages when context exceeds a threshold (`/compact`; `compaction{enabled,reserveTokens,keepRecentTokens}`). Operates on the past, across turns.
_Avoid_: compaction (unqualified), summarization

**Skill pruning**:
The `skill-pruner` extension's LLM prepass that drops skills/tools from the agent's available catalog before a turn (`pruning-result` customType; `disablePruning` flag). Operates on the tool catalog.
_Avoid_: pruning (unqualified)

**Tool-result pruning**:
A deterministic `tool_result` middleware that rewrites a single tool's output bytes before they enter context (strip ANSI, minify JSON, drop permission columns). Operates on the present, per result. See `docs/TOOL-RESULT-PRUNING.md`.
_Avoid_: output compaction, result compaction
