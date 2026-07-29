# Pie repo specific conventions

Personal pi config stack: VS Code extension GUI ("pie"), custom pi extensions, agents, skills, and centralized settings.

- `extension/` — VS Code extension
- `extensions/` — Custom pi tools ie `subagent`
- `docs/` — Internal design docs; `STATE_CONTRACT.md` is authoritative for host↔webview sync
- `models.yaml` — single source of truth for the provider catalog, pricing, eligibility, concurrency, retry policy, and initial model selections. Run `npm run sync-models` after editing it; that regenerates `models.json` and `model-profiles.yaml`, and merges into `settings.json`. Existing chat/pruning selections are user-owned and preserved. Do not edit generated files directly — `extension/test/integration/model-config-sync.test.ts` fails on drift.

**Always rebuild after editing `extension/src/`** — build auto-syncs output to the installed VS Code extension.

```bash
cd extension
npm run build      # build + sync
npm run watch      # incremental
npm run test       # unit tests
npm run typecheck  # type-check only
npm run package    # produce .vsix
```

Agents only need one development test command, run from the repo root:

```bash
npm test
```

It resolves changed files to affected tests, runs package groups concurrently,
and conservatively broadens the selection when dependency evidence is incomplete.
Use `npm run test:coverage` only for the explicit release coverage gate.

On Windows the harness `bash` tool is Git Bash, not PowerShell. Use `/dev/null`
for shell redirection, never `NUL`; a literal `NUL` file breaks Windows ripgrep
traversal. Native Windows programs may print `%TEMP%` paths even when Bash also
exposes the same directory as `/tmp`; tools should accept either spelling.

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
