# subagent

Delegate tasks to specialized agents running as transcript-isolated, in-process `AgentSession`s.

Each subagent invocation creates a fresh `AgentSession` via the pi SDK (`createAgentSession`).
The session shares the parent's auth, model registry, and OAuth tokens but gets its own
context window, system prompt, tool allowlist, and in-memory session manager. This is
transcript/context isolation, not a security or process boundary: children intentionally
share the parent process, working directory, filesystem access, extension runtime, and
external credentials. An abort-ignoring SDK/provider/tool therefore cannot be forcibly
killed or prevented from producing late external side effects by this extension alone.
This architecture unlocks newer GitHub Copilot models that were broken under the previous
CLI-subprocess approach.

## Invocation and orchestration

One tool call delegates one task:

```json
{ "agent": "worker", "task": "Implement the login form" }
```

Use pi's native orchestration rather than a batch mode:

- **Independent work:** emit multiple sibling `subagent` tool calls in one assistant response. Pi executes sibling calls concurrently.
- **Dependent work:** wait for the prior call's result, then issue another `subagent` call in a later turn. The parent agent decides what context to carry forward.

This keeps scheduling, interruption, and error handling on pi's normal tool-call path instead of duplicating those mechanisms inside this extension.

## Agent Discovery

Agents are discovered automatically from both locations:

- **User agents** (`~/.pi/agent/agents/`)
- **Project agents** (`agents/`, project root)

Project agents require confirmation before running (security measure for untrusted repos). When confirmation is enabled but no UI is available, execution fails closed; explicitly set `confirmProjectAgents: false` only for a trusted repository.

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

- When the requested bucket has no eligible model, selection walks down through
  cheaper buckets (`frontier` → `medium` → `small`) and uses the highest one
  available. If every bucket at or below the request is empty, it falls back to
  the caller's active model (safe default — fresh installs start with all buckets
  empty).
- Models whose provider is toggled off in pie are filtered out of the pool at
  selection time. A disabled provider is never reintroduced by the active-model
  fallback; an unresolved model falls back only when that caller model remains
  available under the current provider toggles.
- **Route around busy providers** is an opt-in, default-off setting. When enabled,
  bucket selection softly excludes a model only when every enabled/configured
  provider offering it is paused or has no immediately claimable ProviderGate
  slot. Afterburn-held slots count as busy. If capacity is unavailable or all
  eligible candidates are busy, selection fails open to the normal pool and the
  chosen provider queues as before. Duplicate model ids prefer an immediately
  available provider over a saturated provider when one exists. Capacity checks
  are advisory rather than reservations: another request may claim the slot
  before the subagent starts, so the chosen provider can still queue.
- A model id may appear in more than one bucket.
- "Always use parent model" (same settings section) skips bucket and capacity
  selection entirely and runs every subagent on the caller's active model.
- **Fallback on provider failure** is enabled by default. After the provider/SDK
  exhausts its own retries for a transient timeout, connection, rate-limit, or
  server failure, the subagent retries the task on another model from the same
  requested bucket (up to five fallback attempts). Auth/client/model errors do
  not fail over. A turn is replayed only before visible output or tool execution,
  preventing duplicate externally-visible work. Disable the setting to surface
  the first provider failure directly.

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

## Removed parameters and routes

The public schema is `{ agent, task, cwd?, bucket?, thinkingLevel?, confirmProjectAgents? }`.

- `agentScope` was removed; discovery always covers user and project agent directories. `prepareArguments` strips this legacy field.
- `tasks` and `chain` batch routes were removed. Old one-item batches are migrated by `prepareArguments`; multi-item batches fail schema validation with guidance to use sibling calls or later turns.

Project-local agents still require confirmation before running (see **Agent Discovery** above).

## Validation errors

Early failures — disabled subagents, depth/tree limits, missing or unknown agents, or a caller `canSpawn` allowlist violation — surface as error tool results. Each sibling call settles independently through pi's normal tool lifecycle.

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
- Process-wide active root trees: 2 by default — configurable via `PIE_SUBAGENT_MAX_INFLIGHT`. The same value limits sibling subagent calls emitted in one agent turn. Each root child holds one permit for its full lifetime; nested descendants borrow that tree scope so parents waiting on nested work cannot exhaust the same semaphore and deadlock.
- Tree-wide session budget: 10 — caps the total number of subagent sessions spawned
  across an *entire* nested tree (independent of the per-reply counter), so increased
  nesting can't run away on cost. Configurable via `PIE_SUBAGENT_MAX_TREE_SESSIONS`
  (default 10).

### `canSpawn` allowlist

An agent's frontmatter may declare `canSpawn:` to restrict which agents it may
spawn via the subagent tool. When omitted, the agent may spawn any agent; when
present, only the listed agent names are permitted. An explicit empty list
(`canSpawn: []`) makes the agent a leaf that cannot delegate at all. This
preserves invariants such as a read-only agent (e.g. `scout`) only being able
to delegate to other read-only agents:

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
- The selected set is threaded through the tree's async-local runtime context,
  so depth-2+ children inherit the same main-turn selection. They do not widen
  back to all skills merely because their immediate parent is an in-memory
  subagent session (the pruner intentionally skips those sessions).

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
continue indefinitely while it reports credible progress. An outer settlement inactivity
net force-settles a completely silent dispatch after 12 minutes by default.
Only credible child progress renews that outer deadline: lifecycle/retry/terminal
transitions, model/reasoning/tool-call streaming, and tool start/update/end
(including nested descendant progress propagated through `tool_execution_update`).
Repeated identical `onUpdate` snapshots do not renew it.
`PIE_SUBAGENT_SETTLEMENT_MS` can override the inactivity budget or disable it
with `0`. Parent cancellation remains immediate.

Phase-specific queue/header/first-token/tool leases are planned but are **not
current runtime controls**. Provider-aware retry backoff/`Retry-After` is now
active: failed transient attempts record bounded per-attempt analytics, exclude
every configured model of the failed provider from fallback, and wait with a
clamped Retry-After hint or bounded exponential backoff before replaying a
safe turn. Auth/client failures and any turn with visible output or tool side
effects are never retried.
An orphan cleanup registry is also active: if session creation loses an
abort/timeout race, the underlying creation promise is retained, and a
late-resolved session is disposed exactly once without ever reaching setup or
prompt. The registry retries disposal with bounded backoff, caps total
retention, exposes observable stats, and drains best-effort on process shutdown.
Because the upstream `DefaultResourceLoader` has no reliable `dispose()` API,
cleanup is limited to session disposal and reclaiming leaked exit-signal
listeners; the loader itself is not torn down.

The executable containment today is the outer renewable settlement net plus the
optional whole-prompt ceiling below. Local settlement can release UI/permit
ownership even when an in-process upstream operation ignores abort, but it
cannot quarantine that operation's external side effects.

Set `PI_SUBAGENT_TIMEOUT_MS` to a positive number of milliseconds only as an
optional absolute containment ceiling. Unset, empty, zero, negative, and
non-finite values disable this per-prompt ceiling.

```bash
# Use a 10-minute safety timeout
export PI_SUBAGENT_TIMEOUT_MS=600000
```

## Persisted result size

Live updates retain the child transcript needed for rich progress rendering. Once a child settles, the result persisted in the parent session is compacted:

- the final answer is stored once in bounded `finalOutput` (32,000 characters),
- reasoning and duplicate final prose are removed from nested messages,
- intermediate prose and tool output are capped,
- tool-call metadata remains available for transcript rendering and `session_changes` file-change derivation,
- nested subagent tool results are compacted recursively.

Legacy stored parallel/chain results remain renderable, but new calls only produce single-result details.
