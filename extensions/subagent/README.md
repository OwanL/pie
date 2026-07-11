# subagent

Delegate tasks to specialized agents running as isolated in-process `AgentSession`s.

Each subagent invocation creates a fresh `AgentSession` via the pi SDK (`createAgentSession`).
The session shares the parent's auth, model registry, and OAuth tokens but gets its own
context window, system prompt, and tool allowlist. This is what unlocks newer GitHub Copilot
models that were broken under the previous CLI-subprocess approach.

## Modes

### Single
```json
{ "agent": "worker", "task": "Implement the login form" }
```

### Parallel
```json
{
  "tasks": [
    { "agent": "worker", "task": "Add unit tests" },
    { "agent": "worker", "task": "Update docs" }
  ]
}
```

### Chain
Sequential execution with `{previous}` placeholder for prior output:
```json
{
  "chain": [
    { "agent": "scout", "task": "Find all API endpoints" },
    { "agent": "worker", "task": "Add validation to: {previous}" }
  ]
}
```

## Agent Discovery

- **User agents** (`~/.pi/agent/agents/`) — default scope
- **Project agents** (`agents/`, project root) — opt-in via `agentScope: "both"` or `"project"`

Project agents require confirmation before running (security measure for untrusted repos).

## Model Buckets

Each subagent call carries a `bucket` hint — `small` (Haiku-class busywork),
`medium` (Sonnet-class main development), or `frontier` (Opus-class hardest
problems), defaulting to `medium`. The subagent tool picks **one model uniformly
at random** from the matching bucket's model list.

The bucket contents are **user-configured** in the pie settings UI
(Extensions → subagent → "Model buckets"), where you add any number of model
ids to each bucket. The config is persisted in `ChatPrefs.subagentBuckets` and
mirrored to the in-process subagent extension via the `PIE_SUBAGENT_BUCKETS_JSON`
env var (set by the pie host on startup and on every change).

- An **empty bucket** falls back to the caller's active model (safe default —
  fresh installs start with all buckets empty).
- Models whose provider is toggled off in pie are filtered out of the pool at
  selection time; a model that can't be resolved falls back to the active model.
- A model id may appear in more than one bucket.
- "Always use parent model" (same settings section) skips bucket selection
  entirely and runs every subagent on the caller's active model.

Model selection still reads `<pi-config>/model-profiles.yaml` (`.json`
fallback) for thinking-level support lookups — the shared registry, also
consumed by pie's model picker.

## Nested Bucket Allowlist

You can restrict which tiers **nested** subagents (depth ≥ 1 — every subagent
spawned via the subagent tool; the root caller is never restricted) may use.
The config is persisted in `ChatPrefs.subagentNestedAllowedBuckets`
(`{ small, medium, frontier }` of booleans, all `true` by default) and mirrored
to the in-process subagent extension via the
`PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON` env var (set by the pie host on
startup and on every change).

When a nested subagent requests a bucket that is **not** allowed, the selector
downgrades to the highest allowed tier **at or below** the request ("highest
available gets chosen"):

- `frontier` requested, disallowed → `medium` (or `small` if only that's allowed).
- `medium` requested, disallowed → `small`.
- If no tier is allowed at or below the request, the cheapest allowed tier
  overall is used (so the cap is still respected rather than falling back to an
  uncapped active model).
- If no tier is allowed at all, the subagent falls back to the caller's active
  model.

A downgrade is recorded on the result as `bucketDowngradeReason`. All-true
(the default) leaves behaviour unchanged. This is independent of "Always use
parent model", which takes precedence (and skips bucket selection) when enabled.

## Task Scores

Optional hints for model selection:
```json
{
  "agent": "worker",
  "task": "Add validation to the signup form and update its tests",
  "taskScores": { "precision": 3, "thoroughness": 3, "reasoning": 0 }
}
```

Scores: `reasoning`, `precision`, `creativity`, `thoroughness` (0–5 each).

Use the lowest score that fits:
- Omit routine dimensions; omitted fields default to `2`.
- `3` = normal professional work that genuinely depends on that dimension.
- `4` = hard/high-risk or unusually complex work.
- `5` = rare frontier difficulty on that dimension.
- `reasoning` is special: omit/`2` requests low thinking; use `0` for direct/shallow work.
- Score task difficulty, not importance or your uncertainty.

Model selection reads `<pi-config>/model-profiles.yaml` when present, with `.json` fallback for backward compatibility (the shared registry — also consumed by pie's model picker). If no profile registry is available, no score-based model/thinking override is applied and normal agent/caller model resolution takes over.

When running under pie, provider toggles are mirrored into the pi backend. Models that are only available from providers toggled off in pie are removed from the subagent selection pool.

## Disabling Sub Agents

When sub agents are disabled, the tool still registers in the tool list (preventing
LLM tool-call hangs) but immediately returns an error when called.

**Two ways to disable:**

1. **CLI flag:** `pi --no-subagent`
2. **Environment variable:** `PI_SUBAGENT_DISABLED=1` (or `true` / `yes`)

When disabled, the tool's `description` and `promptSnippet` change to inform the LLM
that sub agents are unavailable. Any call returns:

> Sub agents are disabled. Enable them by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.

## Limits

- Max depth: 3 (nested subagent calls) — configurable via `PIE_SUBAGENT_MAX_DEPTH`
  (set by the pie host from the settings menu; default 3).
- Max subagent sessions per reply: 20 — bounds breadth within a single tool call.
- Max parallel tasks: 8
- Concurrency: 4
- Tree-wide session budget: 50 — caps the total number of subagent sessions spawned
  across an *entire* nested tree (independent of the per-reply counter), so increased
  nesting can't run away on cost. Configurable via `PIE_SUBAGENT_MAX_TREE_SESSIONS`
  (default 50).

### `canSpawn` allowlist

An agent's frontmatter may declare `canSpawn:` to restrict which agents it may
spawn via the subagent tool. When omitted, the agent may spawn any agent; when
present, only the listed agent names are permitted. This preserves invariants
such as a read-only agent (e.g. `scout`) only being able to delegate to other
read-only agents:

```yaml
---
name: scout
tools: read, grep, find, ls, bash, subagent
canSpawn: [scout]
---
```

The root caller (the main agent) is never restricted.

## Skill & tool scoping for subagents

Two mechanisms keep subagent system prompts lean and focused:

### Skills: inherit the parent turn's pruned set

The skill-pruner computes a kept-skill set for the **main** turn and rewrites
the main agent's system prompt. Subagents inherit that same kept set — the
pruner records it (keyed by session id) and the subagent runner filters the
subagent's loaded skills by name via the resource loader's `skillsOverride`.
No extra LLM call runs inside the subagent (the prepass is skipped for
subagent sessions, as before). Behaviour:

- A non-empty kept set → the subagent's system prompt includes only those skills.
- `"keep-all"` / no record / unresolvable parent session → no filter (today's
  behaviour — all skills loaded).
- An empty kept set is treated as keep-all (never strips the lot), matching the
  pruner's own keep-all safeguard.
- **Depth-1 only.** Nested subagents (depth ≥ 2) resolve their parent session
  id from the depth-1 subagent's in-memory session, which never had a kept set
  recorded (the pruner skips subagent sessions), so they fall back to all
  skills. Threading the inherited set through the runtime context for deeper
  nesting is a tracked follow-up, not v1.

### Tools: user-configured drop list

A user-defined list of tool names (e.g. `ask_user`) is always dropped from
every subagent's tool set, regardless of the agent's `tools:` frontmatter.
Configured in the Subagent settings flyout ("Drop tools for subagents") and
mirrored to the in-process extension via `PIE_SUBAGENT_DROP_TOOLS_JSON` (same
mirroring pattern as the model buckets). Behaviour:

- For agents with an explicit `tools:` list, the drop names are subtracted from it.
- For unrestricted agents (no `tools:` frontmatter), the names are subtracted
  from the parent session's full tool set.
- An empty list (the default) → no tools dropped (today's behaviour).

Tool *pruning* inheritance (the pruner's `setActiveTools` decisions) is **not**
inherited — subagents remain frontmatter-driven for tools; the drop list is the
only host-side tool override.

## Timeouts

Subagents have **no short wall-clock deadline by default**. Productive work may
continue beyond 15 minutes; provider header/stream watchdogs and the outer
settlement net bound stalled phases. Parent cancellation remains immediate.

Set `PI_SUBAGENT_TIMEOUT_MS` to a positive number of milliseconds only as an
optional absolute containment ceiling. Unset, empty, zero, negative, and
non-finite values disable this per-prompt ceiling.

```bash
# Use a 10-minute safety timeout
export PI_SUBAGENT_TIMEOUT_MS=600000
```

## Parallel output preview

In parallel mode, each task's output is returned to the parent model, truncated
to a preview limit to bound context growth (default **8000 chars** per task;
with up to 8 tasks that's ~64 KB). When truncated, the elided char count is
noted so the parent LLM knows output was cut. Override via
`PI_SUBAGENT_PARALLEL_PREVIEW` (characters). `0` disables truncation entirely
(full output per task — use with care for large outputs).

```bash
# Return full output for every parallel task
export PI_SUBAGENT_PARALLEL_PREVIEW=0
```

Chain mode is unaffected: the `{previous}` placeholder substitutes the prior
step's full output, and the chain returns the final step's full output to the
parent. Single mode returns the agent's full final output.
