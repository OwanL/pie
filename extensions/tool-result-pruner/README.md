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

### Lossless tier (always on)

| Rule | What it does |
|------|--------------|
| `ansi-strip` | Strip ANSI color / OSC escape sequences (agents can't see color) |
| `trim-trailing-whitespace` | Trim trailing spaces/tabs/CR per line (also normalizes CRLF→LF) |
| `collapse-blank-runs` | Collapse 3+ blank lines → 1; trim leading blanks; trim trailing *runs* (2+) to one (a terminal newline is kept — trimming it fired on ~94% of results for a ~1-token gain, pure noise) |
| `minify-json` | Validate-then-minify a single JSON document (falls back to raw on parse failure) |

Lossless ⇒ semantically identical, fewer bytes ⇒ **no recall stash needed**.

### Lossy-recoverable tier (only under the `default` profile)

| Rule | What it does |
|------|--------------|
| `ls-long` | `ls -l`/`-la` → names + `/` dir marker (drops perms/owner/size/time; keeps ` -> target` for symlinks) |
| `git-log` | verbose `git log` → oneline + 7-char hash (drops author/date/body) |

Lossy ⇒ information is dropped, so a **recall stash is required** before the
rewrite may enter history (§7.3): the pre-pruning text is written to a temp
file, a fidelity marker `[pruned: <rule> (<desc>) — raw: <path>]` is prepended,
and `details.pruning = { id, rawPath, rules }` records the contract. The agent
recovers the raw by pointing the existing `read` tool at `rawPath` (the whole
pipeline skips `read`, so recall is faithful).

**Detection is args-as-signal** (§5 principle 2): lossy rules gate on the
tool-call args (`input.command` for bash), not output shape, so they never
mis-fire on other tabular output. `git log -p`/`--stat`/`--name-only`/… are
**not** pruned — the agent explicitly requested diff content there, and
dropping it would be tier-3 (silently lossy) territory.

**Net-savings gate:** the fidelity marker has a real token cost (the recall
path — ~15 tokens on Linux, ~30+ on Windows long-temp-path platforms). A lossy
rewrite is only applied when it saves at least `LOSSY_MIN_NET_SAVED` (8) tokens
*after* the marker overhead; otherwise the lossless-only result is used (no
marker, no stash). This prevents pruning a tiny `ls -l` (2 entries) from
*increasing* context. If the stash write itself fails, the lossy rewrite is
abandoned and the lossless result is used instead — never silently drop (§7.3).

**Real-world impact** (measured on this repo): `ls -la` 536→77 tokens (85% off),
`git log -8` 2343→180 (92% off), `git log -20` 6323→396 (94% off) — vs the
lossless tier alone which saved ~0.5% on production telemetry.

**Measurement is wired now** (§9.3): `logger.ts` writes a `tool_result_pruned`
JSONL event per pruned result (rules fired + before/after token counts) to
`data/tool-result-pruning.jsonl`, and the `analysis/` pipeline ingests it into a
`tool_result_pruning` DuckDB table + a `tool-result-pruning-impact.json`
site-data artifact with by-rule and by-tool aggregates.

## Safety (enforced in `pipeline.ts`)

- **Errors pass unfiltered** (`event.isError`).
- **`read` results skip the whole pipeline — HARD, non-overridable** — `read` is
  agent-directed; any byte-altering transform (even lossless) would desync the
  model's view from the file's actual bytes and break `edit`'s exact `oldText`
  match. This guard fires *before* the tools allowlist, so listing `read` in the
  allowlist has no effect. (§7.4)
- **Tools allowlist** (`config.tools`): when non-null, only the listed tool names
  are eligible for pruning; `null` (default) = all non-`read` tools. An empty
  array `[]` prunes nothing. This is the user-configurable scope control — see
  Config. `read` is always excluded regardless.
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
  "profile": "default",
  "tools": null
}
```

- `enabled` — master switch (default `true`).
- `profile` — `"default" | "security"`. `security` keeps columns/permissions
  the agent may need (lossy rules stay off; lossless rules run under every
  profile).
- `tools` — allowlist of tool names pruning acts on. `null` (default) = every
  tool except `read` is eligible (current behavior). A non-empty array restricts
  pruning to only the listed tools (e.g. `["bash", "ls"]`); an empty array `[]`
  prunes nothing. `read` is always skipped (hard safety) even if listed.
  Configurable from the settings menu (comma-separated text field).

The extension can also be turned off via the global toggle env var
`PIE_EXTENSION_TOGGLES_JSON={"tool-result-pruner": false}` (same mechanism
`skill-pruner` honors).

## Files

- `index.ts` — factory; registers `pi.on("tool_result")`; recall stash +
  fidelity marker + `details.pruning` + badge noise gate.
- `config.ts` — load + cache `toolResultPruning`; toggle check.
- `types.ts` — `ToolResultPruningConfig`, `Rule`, `RuleContext`, `Profile`,
  `PruningRecall`, `PruningMeta`.
- `rules.ts` — the lossless rule implementations (ordered, §7.2).
- `lossy-rules.ts` — the lossy-recoverable rules (`ls-long`, `git-log`).
- `pipeline.ts` — guards + lossless/lossy orchestration (lossy gated on profile
  + toggles; stash/marker delegated to `index.ts`).
- `tokenize.ts` — BPE token counter (gpt-tokenizer cl100k_base, chars/4 fallback).
- `test/` — `node:test` unit tests (rules, lossy-rules, pipeline, config, index, logger).
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