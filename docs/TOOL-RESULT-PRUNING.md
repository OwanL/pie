# Tool-Result Pruning

> Design doc for a token-saving middleware that prunes tool *output* before it
> enters the model's context. Consolidates the brainstorm, prior-art survey, pi
> architecture decision, and durability verification.
>
> One of three **context-lean layers** in this stack (see `AGENTS.md` § Context-lean
> layers): **history compaction** (pi — LLM-summarize old messages; past),
> **skill pruning** (pie `skill-pruner` — drop skills/tools from the catalog;
> prepass), **tool-result pruning** (this — prune a tool result's bytes;
> deterministic; per-result).

## 1. Problem

Agent-saved context is dominated by tool output. agent-sieve cites a JetBrains /
NeurIPS 2025 finding that **~83.9% of tokens in coding-agent trajectories are
tool observations**, re-read on every subsequent turn (their citation — not
independently verified). Codex issue #16664 frames the same pain as
disproportionate *quota* burn: each turn re-samples the grown context, so a
single oversized output taxes every following turn multiplicatively.

Today pi handles this with **blunt byte-truncation**: built-in tools cap output
at `DEFAULT_MAX_LINES = 2000` lines or `DEFAULT_MAX_BYTES` (~50 KB), save the
full output to a temp file, and emit a marker with the path
(`dist/core/tools/bash.js:176,274`; utilities `truncateHead`/`truncateTail`/
`truncateLine` in `dist/core/tools/truncate.d.ts`). This is the same pattern
Codex uses (prefix + suffix + marker). It is coarse: it drops the *middle* of
output that is often the most informative part, and it does nothing for the
vast majority of outputs that are under the byte cap but still bloated
(permissions columns, ANSI codes, pretty-printed JSON, blank-line runs).

**Goal:** a deterministic middleware that *semantically* prunes tool output
*before* it is stored to history — giving the agent what it actually wants,
trimming what it never reads. It complements pi's existing byte-truncation,
which is *upstream* of this layer (see §7.1).

## 2. Thesis

The tension between "save tokens" and "don't starve the agent of info it needed"
dissolves if transforms are split into three tiers:

| Tier | Behavior | Risk | Recall needed? |
|------|----------|------|----------------|
| **1. Lossless** | Semantically identical content, fewer bytes | None | No |
| **2. Lossy, recoverable** | Drop what the agent usually doesn't want; raw is stashed | Recoverable | **Yes** |
| **3. Silently lossy** | Drop suspected noise with no recovery | Information loss | Avoid |

Almost everything good lives in tiers 1 and 2. Tier 3 is where you get burned.
A corollary, validated by prior art: **the agent-friendliest format is often
also the token-cheapest** (a tight list, a minified JSON array, a columnar
encoding). It is not just trimming — it is re-presenting tool output in the
agent's native shape.

## 3. Three principles

1. **Split lossless from lossy, and make lossy recoverable.** The recall
   capability is what licenses aggressive pruning. Default lean; the agent can
   escalate to the raw.

2. **Transform on output *shape*, not command name** — upgraded to **hybrid**.
   `ls -l | grep foo` produces grep's output, not ls's; aliases, functions,
   pipelines, and `xargs` all break name-based detection. Sniff the bytes
   (JSON? columnar table? ANSI-colored? stack trace?). But where the *intent*
   is known for free (the tool-call args), use it as a strong prior. token-crunch's
   insight: **the arguments the model passed *are* the query** — if it ran
   `git log --author=foo`, author matters. Shape-first, args-as-prior.

3. **Leave a fidelity marker.** Every pruned result gets a one-line note
   (`[ls -la: 23 entries, names only — raw: /tmp/…]`) so the agent knows what it
   is *not* seeing and can ask. Silent pruning causes "why don't I see the
   permissions?" round-trips. Codex issue #6544 (silent middle-chopping of MCP
   responses) is the cautionary tale.

## 4. Prior art

### 4.1 What the big harnesses do

**Claude Code** (v2.1.68, per a deobfuscated deep-dive) runs a *tiered*
compaction system — and the tiers map onto ours:
- **Microcompact** (non-LLM): clears old tool results when a warning threshold hits.
- **Auto full compact** (LLM): history replacement past a token threshold.
- Manual `/compact`, sub-agent compact, session-memory compact.

Notably, Claude Code does **not** do per-command output rewriting — issue #32311
("use compact output flags for common Bash commands") is still an *open feature
request*. Its bash tool just truncates stdout to ~2 KB and dumps the rest to a
temp file (issue #40100 complains that's too blunt).

**Codex (OpenAI)** truncates tool output at **10 KiB / 256 lines**, preserving
**prefix + suffix** and inserting **markers where the middle was removed**
(`codex-rs/core/src/truncate.rs`: `truncate_function_output_items_with_policy`).
PR #19247 generalizes this into a "truncation policy." Issue #6544 is the
cautionary tale — silent middle-chopping of MCP responses caused real breakage.

### 4.2 Third-party ecosystem — three hook archetypes

| Archetype | Examples | Intercepts | Blind spot |
|-----------|----------|-----------|------------|
| **PreToolUse / tool-result hook** | `squeez`, `agent-sieve` | agent→tool boundary | harness-specific API |
| **API proxy** (on the wire) | `tamp` | model↔harness payload | can't see command semantics without parsing |
| **Shell proxy** (wraps the shell) | `tkn`, `chop`, `cli-denoiser`, `trimout`, `tokenjuice` | the shell itself | only covers shell tools, not `read`/MCP |

### 4.3 Detection philosophies

- **Parse, don't truncate** (`agent-sieve`, `token-crunch`, `tokenjuice`) —
  re-render semantically. Higher quality, more work.
- **Line-classification** (`cli-denoiser`, `log-reducer`, `trimout`) —
  Keep / Drop / Replace / **Uncertain** per line; "Uncertain → keep" is the safe
  default. Great for logs.
- **Per-command heuristics** (`chop` — 52+ commands) — the command-name approach
  principle 2 warns against, but it works *when scoped*. Hybrid is the sweet spot.
- **Use the tool-call args as the compression signal** (`token-crunch`) — the
  cleverest idea in the space: the model's own arguments encode its intent.

### 4.4 Safety rules that recur (steal verbatim)

- **Errors pass unfiltered** (`trimout`, `log-reducer`).
- **Zero false positives; when uncertain, keep** (`cli-denoiser`).
- **Keep the cache prefix stable** (`llmtrim`) — retroactive history rewrites can
  invalidate the prompt KV-cache, costing more than they save.
- **Deterministic over LLM** (`tokenjuice`, `cli-denoiser`) — reserve model-based
  summarization for hard-pressure cases only.
- **Multi-pass pipeline with escalating triggers** (`yoke`):
  ```
  count tokens → trigger (soft/hard/forced) → runPipeline:
    PassDedupeToolCalls → PassTruncateToolResults → PassDropUnusedSkills → PassSummarizeMiddle (only hard/forced)
  ```
  Cheap deterministic passes always; LLM summarization *only* when pressure demands.

### 4.5 Re-presentation tricks worth stealing

- **Columnar array encoding** (`tamp`) — encode JSON arrays columnarly;
  smaller *and* sometimes easier for the model.
- **Tool-schema trimming / drop unused tools** (`llmtrim`, yoke) — adjacent but
  high-leverage; tool descriptions are re-sent every turn.

### 4.6 Gaps → our opening

1. **First-class recall.** Nobody has it cleanly. Codex's temp-file-re-read is a
   side-effect hack. We resolve it by stashing the pre-pruning text and having
   the agent recover it via the existing `read` tool (no new tool) — see §7.3.
2. **Args-as-signal + shape-based + recall, combined.** Most tools pick one or two.
3. **A consistent fidelity-marker contract** across all transforms (Codex has
   it ad hoc for truncation only).

## 5. Architecture decision for pi

Pi exposes **all three archetypes**. The mapping:

| Archetype | pi hook | Verdict |
|-----------|---------|---------|
| **(a) tool-result hook** | `tool_result` event | ✅ **Use this** |
| **(b) API/model-payload proxy** | `before_provider_request` | ⚠️ Reserve for orthogonal wins (trim tool schemas, drop unused tools). *Not* tool-result pruning. |
| **(c) shell wrapper** | bash `spawnHook` (+ `user_bash`) | ⏭️ Subsumed by (a). Keep spawnHook for its real job: inject `--color=never` *preventively*. |

### Why `tool_result` is the right home

The event shape (`dist/core/extensions/types.d.ts:668`):

```typescript
interface ToolResultEventBase {
  type: "tool_result";
  toolCallId: string;
  input: Record<string, unknown>;                 // ← tool-call ARGS (args-as-signal, free)
  content: (TextContent | ImageContent)[];        // ← what the model sees — MUTABLE
  isError: boolean;                               // ← gate: never prune errors
}
// per-tool subclasses: BashToolResultEvent { toolName: "bash"; details: BashToolDetails | undefined }
//   ReadToolResultEvent, LsToolResultEvent, GrepToolResultEvent, ...
// type guards: isBashToolResult, isReadToolResult, isLsToolResult, ...
```

Each principle lands natively:

1. **Args-as-signal is free.** `event.input` is the tool's arguments — for bash
   that's `{ command }`; for ls/grep/find it is their typed params. We know
   *intent* without parsing the command line, and for non-bash tools we get
   structured input, not a shell string. Hybrid detection (shape-first,
   `toolName` + `input` as prior) is the natural mode and is stronger than
   either alone.

2. **`event.details` is typed per-tool and carries truncation metadata.**
   `BashToolDetails` includes `truncated` + `fullOutputPath` — pi *already*
   saves the full raw output to a temp file when it byte-truncates, and surfaces
   that path to the agent in its own `[Full output: <path>]` marker. **Truncation
   recovery is pi's concern, already handled** — the pruner does not re-own it.
   Pruning's recall owns *only* what pruning itself removed: before a lossy rule
   rewrites `content`, the handler stashes the (post-truncation, pre-pruning)
   text it received to a temp file and records an id in `details`. See §7.1
   (pruning is downstream of truncation) and §7.3 (separation of concerns).

3. **`isError` → "errors pass unfiltered" is a one-line guard.**

4. **Middleware chaining.** Handlers run in extension load order; each sees
   the latest result after previous handlers' changes; can return partial
   patches (`content` / `details` / `isError`). Rules compose as separate
   handlers or one handler with an internal pipeline
   (`dist/core/extensions/runner.js:592`, `emitToolResult`).

5. **Cache-safety (structural).** Pruning at this layer rewrites only *new*
   tool results. It never touches history or the provider payload → the
   prompt-cache prefix stays stable. The `llmtrim` risk does not apply.

## 6. Durability verification (confirmed)

Rewriting `content` in a `tool_result` handler durably changes the stored
`toolResult` message — it is not a display-time transform. Evidence chain:

```
tool_result handler returns { content, details, isError }   ← our pruning
      │  dist/core/extensions/runner.js:610-640  (emitToolResult: chains, applies patches)
      ▼
AgentSession.afterToolCall returns the patched result        ← dist/core/agent-session.js:208-229
      ▼
finalizeExecutedToolCall: result.content = afterResult.content ?? result.content
                                                          ← pi-agent-core/dist/agent-loop.js:455-462
      ▼
createToolResultMessage: { role:"toolResult", content: finalized.result.content, … }
                                                          ← agent-loop.js:485-494
      ▼
emitToolResultMessage → message_end                         ← agent-loop.js:497-500
      ▼
sessionManager.appendMessage(event.message)                ← agent-session.js:307-310  (persisted)
```

`details` and `isError` overrides persist too (CHANGELOG #3051 confirms the
override path was deliberately fixed). The `terminate` field is *not* exposed
on `ToolResultEventResult`, so we cannot accidentally break tool-flow termination.

### Three implications

1. **Cache-safety confirmed, stronger than first claimed.** `afterToolCall`
   only ever builds *new* toolResult messages for the just-executed tool — it
   never retroactively rewrites stored history. We only ever modify content
   appended *after* the cached prefix. KV cache stays valid. ✓

2. **Lossy ⇒ recall is *necessary*, not nice-to-have.** Rewriting is one-way and
   persistent; once we prune an output the pre-pruning text is gone from
   history — the *only* recovery path for pruning's own loss is our stashed
   copy (single-raw: the post-truncation, pre-pruning text pruning received).
   Truncation's loss is separately recoverable via pi's existing `fullOutputPath`
   marker. Hard rule: **a lossy transform may not ship without a recall stash.**
   Lossless transforms need none. This is the dividing line for the rule pipeline.

3. **Rules must be defensively try/caught.** If `afterToolCall` throws,
   `finalizeExecutedToolCall` replaces the *entire* result with an error tool
   result (`agent-loop.js:464-467`; CHANGELOG #3084). A buggy pruning rule would
   thus turn a perfectly good `ls` into an error the agent sees. Every rule
   catches its own failures and returns the original content unchanged — never
   propagate. The `cli-denoiser` "zero false positives" discipline, enforced by
   structure.

## 7. Design

### 7.1 Layering

```
tool execute()
   │  byte-truncation happens HERE (inside execute, via OutputAccumulator):
   │  bash.js:188/236/255  →  returns truncated content + details.fullOutputPath
   ▼
tool_result handler: pruning pipeline   (sees POST-truncation content)
   │  top guard: skip entirely if toolName === "read" (agent-directed — §7.4)
   │  lossless rules (always on, no recall)
   │  lossy rules   (only if recall stashed)
   │  → rewritten content + details.pruning
   ▼
stored toolResult message → history → re-sent every turn
```

**Byte-truncation is upstream of pruning, not a fallback for it.** The two are
sequential and both always apply (for tools that self-truncate): truncation runs
inside the tool's `execute()` before `tool_result` fires, so pruning only ever
sees post-truncation content. There is no extension seam that lets pruning run
*before* tool-internal truncation without replacing the tool outright
(archetype c — rejected). Good per-result pruning ⇒ history compaction triggers
later ⇒ less noise summarized.

### 7.2 Rule pipeline

A rule is `(event) => { content, details?, marker? } | null`, self-caught, with
a declared tier. The pipeline short-circuits on `read` results
(`event.toolName === "read"` → no rules run; see §7.4):

- **Lossless rules** run unconditionally, in fixed order:
  1. ANSI escape stripping.
  2. Trailing-whitespace trim per line.
  3. Blank-run collapse (3+ → 1) + trim leading/trailing blanks.
  4. JSON/XML minify — **validate-then-minify**, fall back to raw on parse failure.
- **Lossy-recoverable rules** run only when recall is stashed (see 7.3):
  1. `ls -l`/`-la` → names + dir/file marker (toolName `ls` gives structured
     input; for bash `ls`, parse `input.command`).
  2. `git log` (verbose) → oneline + short hash.
  3. grep/rg `path:line:content` → group by path (path once, matches indented).
  4. Consecutive duplicate lines (builds, pings, polls) → collapse 3+ identical
     non-severity lines to one + count marker.
  5. Progress noise (spinners, progress bars) → drop frames that carry no
     stable information, keep severity lines.
  6. Tabular command output (`ps`, `docker ps`, `kubectl`, `df`) → drop
     low-value columns, detected by whitespace alignment, not command.
  7. Stack traces → dedupe repeated frames, strip timestamps.

Rules are composable: each is a separate `tool_result` handler (chained by pi),
or one handler with an internal pipeline. Order matters (lossless before lossy;
minify before column-prune so column detection sees normalized text).

### 7.3 Recall contract (the differentiator)

**Separation of concerns (decided — grill Q1):** pruning's recall owns *only*
what pruning removed. Truncation's loss is owned by pi's existing `fullOutputPath`
marker (the agent reads that path with the `read` tool) — pruning does not
restate or re-own it.

- **Stash (single-raw):** before a lossy rule rewrites `content`, the handler
  writes the **post-truncation, pre-pruning** text it received to a temp file
  (reuse pi's temp-file convention) and records an id + path in
  `event.details.pruning = { id, rawPath, rules: [...] }`. The stash includes
  pi's own `[Full output: …]` marker verbatim — it is the true pre-pruning state.
- **Discovery:** every lossy result prepends a fidelity marker scoped to
  pruning's own changes — `[pruned: <rules>; raw: <rawPath>]` — so the agent
  sees *what pruning removed* and *where* to recover it. It does **not** restate
  `fullOutputPath` (pi already shows that).
- **Invocation (decided — grill Q2):** reuse the existing `read` tool on
  `<rawPath>` (same idiom as pi's own truncation marker). No new tool. Recall is
  faithful because **the whole pipeline skips `read`** (§7.4) — the stash
  read-back returns the pre-pruning text unchanged, semantically identical to
  what the agent would have seen without pruning.
- **Lifecycle:** stashes are session-scoped temp files; cleaned on session end.
  Bounded LRU if memory is a concern.
- **Hard gate:** a lossy rule that cannot stash (e.g. disk write fails) must
  fall back to *lossless* or no-op — never silently drop.

### 7.4 Safety rules (enforced)

- Errors (`event.isError`) pass through unmodified.
- Every rule is wrapped in try/catch; on failure, return original content.
- Validate-then-transform for any structural parse (JSON, tables); fall back to
  raw on parse failure. "Uncertain → keep."
- **The whole pipeline skips `read` results** (`event.toolName === "read"` →
  return null before any rule runs). `read` is agent-directed — the model asked
  for exactly that file's content, and it may `edit` it by exact `oldText` match;
  any byte-altering transform (minify, whitespace-trim — even lossless ones)
  would desync the model's view from the file's actual bytes and break edits
  unrecoverably (reads aren't stashed). The high-value read transform (minify
  JSON configs) is exactly the broken one; safe transforms (ANSI/whitespace) save
  little on already-lean code/configs. Reads are already byte-truncated by the
  read tool. Cost: forgo pruning savings on reads — acceptable for high-signal,
  agent-chosen content.
- Lossy ⇒ recall stashed, or the rule is skipped.

## 8. Transform catalog

| Output | Tier | Transform | Notes |
|--------|------|-----------|-------|
| ANSI color codes | lossless | strip | always; agents can't see color |
| Trailing whitespace | lossless | trim per line | always |
| Blank-line runs | lossless | 3+ → 1, trim ends | always |
| Pretty JSON/XML | lossless | minify | validate-then-minify; 40-60% off typical |
| `ls -l`/`-la` | lossy+recall | names + dir/file | `toolName==="ls"` structured input; bash `ls` parse command |
| `git log` verbose | lossy+recall | oneline + short hash | |
| grep/rg `path:line:content` | lossy+recall | group by path (path once, matches indented) | args-gate on grep-family + shape-confirm (≥60% pathy lines); pipelines allowed; includes structured `grep` tool; ~26% off grep output |
| Duplicate consecutive lines | lossy+recall | collapse 3+ identical non-severity lines to one + count | long builds, pings, polls; severity lines preserved |
| Progress noise | lossy+recall | drop spinner / progress-bar frames | Braille blocks, block glyphs, bracketed `%` bars; severity lines preserved |
| Tabular (`ps`, `docker ps`, `kubectl`, `df`) | lossy+recall | drop low-value columns | detect by whitespace alignment |
| Stack traces | lossy+recall | dedupe frames, strip timestamps | fiddly; conservative |

## 9. Open decisions / next steps

1. **Recall invocation — RESOLVED (grill Q2):** reuse the existing `read` tool
   on the stashed `<rawPath>` (no new tool); the whole pipeline skips `read`
   results (grill Q4) so recall is faithful. Separation (grill Q1): pruning's
   recall owns only pruning's loss; pi's `fullOutputPath` marker owns
   truncation's loss.
2. **MVP scope -- RESOLVED & SHIPPED (lossless + lossy tiers):** the
   lossless tier (ANSI strip, trailing-whitespace trim, blank-run collapse,
   JSON minify) and the lossy-recoverable tier (`ls -l` → names, `git log` →
   oneline, grep/rg → path-grouped) are all implemented in `extensions/tool-result-pruner/`.
   `RuleResult` gained its `marker` field; the pipeline gained lossy
   orchestration (profile-gated, per-rule-toggled, lossless-before-lossy) and
   returns `meta.recallRules`/`meta.markers`/`meta.losslessText`; `index.ts`
   owns the recall stash (temp file + fidelity marker + `details.pruning`) and
   a net-savings gate (`LOSSY_MIN_NET_SAVED`) so the marker overhead never
   *increases* context on tiny outputs. Recovery reuses the existing `read`
   tool on the stashed raw path (the pipeline skips `read`, so recall is
   faithful). Config key `toolResultPruning` (sibling to `pruning`, which
   skill-pruner owns); extension id `tool-result-pruner`. Each rule is
   independently toggleable via `rules.{ansi,whitespace,blankRun,jsonMinify,
   lsLong,gitLog}` (a disabled rule is skipped entirely); a settings UI
   (enabled + profile + tools + per-rule toggles, incl. the 2 lossy rows)
   and an inline `pruningBadge` transcript marker ship with both tiers — see
   items 5 and 7. `collapse-blank-runs` was softened to keep a terminal
   newline (it fired on ~94% of results for a ~1-token gain) and the badge is
   noise-gated on `tokensSaved > 0` (~45% of lossless rewrites saved 0 tokens
   in production telemetry). Still deferred: tabular column-drop (`ps`/`docker
   ps`/`kubectl`/`df`) and stack-trace dedupe — fiddlier shape detection.
3. **Measurement — RESOLVED & SHIPPED:** per-pruned-result before/after token
   counts + which rules fired are written to `data/tool-result-pruning.jsonl`
   by `extensions/tool-result-pruner/logger.ts`, and ingested end-to-end by the
   analysis pipeline (`ToolResultPruningSourceEvent` -> `PreparedToolResultPruningRow`
   -> DuckDB `tool_result_pruning` table -> `tool-result-pruning-impact.json`
   site-data artifact with by-rule and by-tool aggregates). Per-rule savings are
   visible on the dashboard; the lossy tier will lean on this to decide which
   rules are worth shipping and whether any starved the agent.
4. **Benchmark on real sessions** — intuition about "noise" will be wrong in
   spots (sometimes the agent *does* want the timestamp).
5. **Config — RESOLVED & SHIPPED:** a `toolResultPruning: { enabled, profile }`
   block in `settings.json`,
   sibling to `pruning` (do not overload that flag). Individual rule toggles
   (`ansi`, `whitespace`, `blankRun`, `jsonMinify`, `lsLong`, `gitLog`,
   `grepGroup`) are defaulted in code (`extensions/tool-result-pruner/config.ts`)
   and may be overridden via an optional `rules` object. Tier-1 (lossless) always on
   by default; each rule independently toggleable. Tier-2 will be
   profile-selectable (`default` runs lossy; `security` keeps
   permissions/columns) when the lossy tier ships. A settings UI mirrors the
   skill-pruner settings flow end-to-end (host persistence + reducer + webview):
   enabled toggle, profile select, and 4 per-rule toggles, surfaced in the
   composer settings menu under the `tool-result-pruner` extension. Also
   toggleable via `PIE_EXTENSION_TOGGLES_JSON`.
6. **Orthogonal win (separate effort):** `before_provider_request` to trim tool
   descriptions / drop unused tools (the llmtrim/yoke `PassDropUnusedSkills`
   idea — i.e. extend `skill-pruner`). Do not conflate with tool-result pruning.
7. **Visibility — RESOLVED & SHIPPED:** when a lossless rule fires, the
   `tool_result` handler merges a `pruningBadge: { rules: string[]; tokensSaved:
   number }` into the result's existing `details` (spread, never replace, so
   built-in details like bash `truncated`/`fullOutputPath` are preserved). The
   badge flows the full durability chain (`finalizeExecutedToolCall` →
   `tool_execution_end` → host → webview `toolCall.result.details` → session
   JSONL) and renders an inline `✂ pruned · <rules> · ~<n> tokens saved` chip on
   the tool-call header, visible even when collapsed. This is an intentional
   human-visibility exception to the "telemetry stays out of history" rule
   (rules + tokens only; no raw path; lossless ⇒ no recall needed). It is
   DISTINCT from the future lossy `details.pruning` recall contract (§7.3),
   which is reserved for the lossy tier and NOT used here.

### Implementation status

- `extensions/tool-result-pruner/` — lossless **and** lossy tiers. Files:
  `index.ts` (registers `pi.on("tool_result")`; recall stash + fidelity marker
  + `details.pruning` + net-savings gate + `pruningBadge` noise gate),
  `config.ts` (cached loader + toggle + per-rule parse), `types.ts`
  (`RuleToggles` incl. `lsLong`/`gitLog`, `RULE_KEY_BY_NAME`, `PruningRecall`,
  `PruningMeta` with `recallRules`/`markers`/`losslessText`), `rules.ts`
  (4 lossless rules; `collapse-blank-runs` keeps a terminal newline),
  `lossy-rules.ts` (`ls-long`, `git-log`, `grep-group`; args-as-signal detection, diff-option
  exclusions for `git log`; `grep-group` is the hybrid exception — args-gate
  on a grep-family invocation AND shape-confirm of `path:line:content`), `pipeline.ts` (guards + lossless-then-lossy
  orchestration, profile-gated), `tokenize.ts`, `types-global.d.ts`, `test/`
  (rules, lossy-rules, pipeline, config, index, logger).
- Wired into `extension/package.json` (`typecheck:tool-result-pruner`),
  root `package.json` (`extensions:typecheck` / `extensions:test`), and
  `scripts/run-tests.mjs` (package `tool-result-pruner`, 98% lines gate).
- `settings.json` carries the default `toolResultPruning` block
  (`{ enabled, profile }`); per-rule defaults live in
  `extensions/tool-result-pruner/config.ts` and are only present in settings
  when explicitly overridden.
- Settings UI: mirrors the skill-pruner settings flow — host persistence
  (`tool-result-pruning-settings{,-persistence}.ts`), service set/load, arch
  state, events/commands/reducer/effect-runner/projection/message-router,
  validation, and a webview settings component
  (`settings-menu-tool-result-pruner.tsx`) with enabled + profile + 4 per-rule
  toggles.
- Inline visibility: `tool-result-pruning-badge.tsx` renders the `pruningBadge`
  chip on the tool-call header (§9.7).
- Analytics wired: `logger.ts` records `tool_result_pruned` events;
  `analysis/scripts/{contracts,source,prepare,duckdb,site-data}.ts` ingest
  them into a `tool_result_pruning` DuckDB table and a
  `tool-result-pruning-impact.json` site-data artifact (by-rule + by-tool
  token-saved aggregates). Covered by `analysis/test/tool-result-pruning.test.ts`.

## 10. References

### pi internals (verified)
- `pi-coding-agent/docs/compaction.md` — existing *history* compaction (LLM).
- `pi-coding-agent/docs/extensions.md` — `tool_result` middleware chain (~line 788).
- `pi-coding-agent/dist/core/extensions/types.d.ts:668` — `ToolResultEventBase`.
- `pi-coding-agent/dist/core/extensions/runner.js:592` — `emitToolResult`.
- `pi-coding-agent/dist/core/agent-session.js:208` — `afterToolCall` wiring.
- `pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:439-500` — `finalizeExecutedToolCall`, `createToolResultMessage`.
- `pi-coding-agent/dist/core/tools/bash.js`, `truncate.d.ts` — existing byte-truncation.
- Examples: `examples/extensions/truncated-tool.ts` (truncation pattern + recall-via-tempfile precedent), `provider-payload.ts` (archetype b), `bash-spawn-hook.ts` (archetype c).

### Prior art
- Claude Code: compaction deep-dive (gist, sam-saffron-jarvis, v2.1.68); issue #32311 (compact flags request); issue #40100 (bash truncation).
- Codex: `codex-rs/core/src/truncate.rs`; PR #19247; issues #5913, #6544, #16664.
- Ecosystem: `AgusRdz/chop`, `claudioemmanuel/squeez`, `jajanet/tamp`, `lucasilverentand/tkn`, `agent-sieve`, `ristaloff/trimout`, `cli-denoiser`, `fkiene/llmtrim`, `micaelmalta/token-crunch`, `vincentkoc/tokenjuice`, `launch-it-labs/log-reducer`, `blouargant/yoke`.
