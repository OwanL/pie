# Tool-Result Pruning

Contract for deterministic transforms applied to a tool result before it enters
model context. Do not conflate the three context-lean mechanisms:

- **History compaction** summarizes older conversation history across turns.
- **Skill pruning** removes tools or skills from the catalog for a turn.
- **Tool-result pruning** rewrites one tool result before it is stored.

See the [context-lean terminology](../../harness/agent-instructions/skills/develop-pie/SKILL.md#context-lean-terminology),
the [implementation guide](../../harness/tools/result-processing/README.md),
and the [extension adapter](../../extensions/tool-result-pruner/index.ts).

## 1. Scope and ordering

The middleware handles `tool_result` events. Tool-internal byte truncation, when
present, happens first. Pruning therefore sees the result after SDK truncation;
it neither replaces that behavior nor owns recovery of the SDK's separately
marked `fullOutputPath`. Pruning changes only the new result, before history
storage, so it does not rewrite earlier messages or disturb the existing prompt
cache prefix.

## 4. Conservative transforms

### 4.4 Uncertain means keep

Transforms are deterministic and conservative. Structural parsing must validate
before rewriting; when parsing or shape checks are uncertain, that rule leaves
the text unchanged. Lossy transforms are allowed only with recall (see
[§7.3](#73-recall)). This avoids silently removing information the agent
explicitly requested.

## 5. Detection

Use tool-call arguments as intent signals where available, with output shape as
confirmation when needed. This avoids identifying output from a command name
alone: for example, `ls` in a pipeline may not produce the result. The shipped
long-list and verbose-log transforms require a single matching `bash` command;
they skip pipelines and redirects. Grep grouping recognizes grep-family bash
commands and the structured `grep` tool, and confirms the output shape. Duplicate
line and progress-noise rules use conservative output-shape checks.

## 6. Persistence and failure behavior

A `tool_result` rewrite is durable: the changed content becomes the stored
`toolResult` message, not just a display-time rendering. Rules are isolated with
defensive error handling; a rule failure leaves its input unchanged rather than
turning a successful tool call into an error. The pipeline itself does not
mutate existing history.

## 7. Processing contract

### 7.1 Order

For eligible results, lossless rules run first, then lossy rules. Lossy rules
receive the lossless-normalized text. A result is eligible only when pruning is
enabled, it is not an error or a `read` result, it is within the configured tool
allowlist, and it contains exactly one text part. Other content, including
multi-part and image results, is left untouched.

### 7.2 Shipped rules

Lossless rules run under either profile and need no recall:

- Strip ANSI escape sequences.
- Trim trailing whitespace per line.
- Collapse blank-line runs and trim leading/trailing blank runs, while keeping
a single terminal newline.
- Minify a single valid JSON document; parse failures and non-JSON text pass
through unchanged.

Lossy rules run only under the `default` profile and require recall:

- `ls -l`-style bash output becomes names, with `/` for directories and symlink
targets retained.
- Verbose `git log` becomes short hashes, subjects, and refs; commands asking
for patch or file-change details are excluded.
- Repeated grep/rg `path:line:content` prefixes are grouped by path. The
`grep-group` rule requires a grep-family command or structured grep result and
shape confirmation; it only applies when grouping shrinks the text.
- Runs of three or more identical consecutive non-severity lines collapse to
one line plus a count.
- Recognized spinner/progress-bar lines are removed only when meaningful output
remains. Severity lines are preserved.

Both profiles apply lossless rules. `security` disables the lossy tier so
permissions, columns, and other details remain available. Each rule can also be
disabled independently.

### 7.3 Recall

Before any lossy rewrite enters history, the extension stashes the exact text it
received—post-truncation, pre-pruning—to a session-owned temporary file. It
prepends a fidelity marker naming the rules and raw path, and merges
`details.pruning = { id, rawPath, rules }` into the result. The existing `read`
tool retrieves that stash; because `read` results skip this pipeline, recalled
text is not transformed again. The stash recovers only pruning's loss; use the
SDK's `fullOutputPath` separately to recover output omitted by SDK truncation.

The marker has a token cost. A lossy rewrite is applied only if it saves at
least eight tokens versus the lossless-only result after marker overhead. If
the session-owned stash cannot be written or the saving is too small, the
lossless-only result is used—never an unstashed lossy rewrite. Stashes are
cleaned up with their session's temporary outputs; load-time age/size reaping
is a fallback for orphans.

### 7.4 Safety guards

- Errors and `read` results pass through unchanged. The `read` exclusion is
  hard-coded, even if `read` is in the tool allowlist: changing bytes the agent
  requested verbatim could break exact-text edits.
- Only one text part is transformed; images and multipart results are untouched.
- JSON minification and lossy rules skip malformed or uncertain input; other
  eligible rules may still apply. Rule exceptions leave that rule's input
  unchanged.
- Lossy rules never run without a successful recall stash.

## 8. Configuration

Settings are read from the `toolResultPruning` block in `settings.json`,
separate from `pruning`, which belongs to skill pruning. Defaults are
`enabled: true`, `profile: "default"`, all shipped rule toggles enabled, and
`tools: null`. `tools: null` allows every tool except the hard-excluded `read`;
a list restricts pruning to those tools and `[]` disables it for all tools.

The `rules` object independently toggles `ansi`, `whitespace`, `blankRun`,
`jsonMinify`, `lsLong`, `gitLog`, `grepGroup`, `duplicateCollapse`, and
`progressNoise`. Invalid fields warn and use their defaults; invalid tool
allowlist entries are dropped. The extension can also be disabled with
`PIE_EXTENSION_TOGGLES_JSON={"tool-result-pruner": false}`.

## 9. Operational signals

### 9.3 Measurement

For changed results, best-effort telemetry records the rules and before/after
token counts in `data/tool-result-pruning.jsonl`; the analytics pipeline ingests
these events for local analysis of savings and whether rules removed useful
information. Telemetry failure does not block pruning.

### 9.7 Visibility

When the final result saves tokens, `details.pruningBadge` carries the fired
rules and estimated tokens saved for transcript visibility. It is merged into
existing details, preserving fields such as the SDK's truncation metadata. The
badge contains no raw path; it is distinct from the lossy-only `details.pruning`
recall record.
