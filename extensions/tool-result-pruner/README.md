# tool-result-pruner

Deterministic middleware that prunes tool **output bytes** before they enter the
model's context. One of three context-lean layers in this stack
(see `AGENTS.md` § Context-lean layers):

- **history compaction** — pi; LLM-summarize old messages; past
- **skill pruning** — `skill-pruner`; drop skills/tools from the catalog; prepass
- **tool-result pruning** — **this extension**; prune a tool result's bytes; per-result

Design and prior art: [`docs/TOOL-RESULT-PRUNING.md`](../../docs/TOOL-RESULT-PRUNING.md).

## What it does

Hooks the pi `tool_result` event and rewrites `content` *before* it is stored to
history. The rewrite is durable (replaces the stored `toolResult` message) and
cache-safe (only new results are touched, never stored history — see §6).

### MVP — lossless tier only

| Rule | What it does |
|------|--------------|
| `ansi-strip` | Strip ANSI color / OSC escape sequences (agents can't see color) |
| `trim-trailing-whitespace` | Trim trailing spaces/tabs/CR per line (also normalizes CRLF→LF) |
| `collapse-blank-runs` | Collapse 3+ blank lines → 1; trim leading/trailing blanks |
| `minify-json` | Validate-then-minify a single JSON document (falls back to raw on parse failure) |

Lossless ⇒ semantically identical, fewer bytes ⇒ **no recall stash needed**.

### Follow-up pass (not yet shipped)

Lossy-recoverable rules — `ls -l`, `git log`, tabular (`ps`/`docker ps`/`df`),
stack traces — plus the recall stash (single-raw temp file + fidelity marker +
recovery via the existing `read` tool). The `Rule` / `RuleContext` / `Profile`
types in `types.ts` are in place, but `RuleResult` will gain a `marker` field and
the pipeline will gain stash + `details.pruning` wiring when the lossy tier lands
— that is the real seam work, deferred intentionally with this MVP.

**Measurement is wired now** (§9.3): `logger.ts` writes a `tool_result_pruned`
JSONL event per pruned result (rules fired + before/after token counts) to
`data/tool-result-pruning.jsonl`, and the `analysis/` pipeline ingests it into a
`tool_result_pruning` DuckDB table + a `tool-result-pruning-impact.json`
site-data artifact with by-rule and by-tool aggregates.

## Safety (enforced in `pipeline.ts`)

- **Errors pass unfiltered** (`event.isError`).
- **`read` results skip the whole pipeline** — `read` is agent-directed; any
  byte-altering transform would desync the model's view from the file's actual
  bytes and break `edit`'s exact-match. (§7.4)
- **Multi-part / image content is left untouched** — only a single text part is
  rewritten.
- **Every rule is defensively try/caught** — a buggy rule never propagates and
  never turns a good result into an error. (§6 implication 3)
- **Validate-then-transform** for structural parses; "uncertain → keep". (§7.4)

## Config

`sibling to \`pruning\`` (which is owned by `skill-pruner`). In `settings.json`:

```json
"toolResultPruning": {
  "enabled": true,
  "profile": "default"
}
```

- `enabled` — master switch (default `true`).
- `profile` — `"default" | "security"`. `security` keeps columns/permissions the
  agent may need (matters once the lossy column-drop rules ship; lossless rules
  run under every profile).

The extension can also be turned off via the global toggle env var
`PIE_EXTENSION_TOGGLES_JSON={"tool-result-pruner": false}` (same mechanism
`skill-pruner` honors).

## Files

- `index.ts` — factory; registers `pi.on("tool_result")`.
- `config.ts` — load + cache `toolResultPruning`; toggle check.
- `types.ts` — `ToolResultPruningConfig`, `Rule`, `RuleContext`, `Profile`.
- `rules.ts` — the lossless rule implementations (ordered, §7.2).
- `pipeline.ts` — guards + rule orchestration.
- `test/` — `node:test` unit tests (rules, pipeline, config).
- `types-global.d.ts` — ambient stubs for the `@earendil-works/pi-*` peer
  packages (precise event/content shapes, `ExtensionAPI` stays `any`).

## Develop

```bash
# typecheck this extension
npm --prefix extension run typecheck:tool-result-pruner --

# run its tests (via the repo test runner)
node ./scripts/run-tests.mjs --package tool-result-pruner

# or the whole extensions suite
npm run extensions:typecheck
npm run extensions:test
```