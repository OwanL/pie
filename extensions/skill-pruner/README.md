# skill-pruner

Uses an LLM to score and prune skills/tools based on relevance to the current task. Reduces prompt noise and token usage by excluding irrelevant items.

## How it works

Before each agent turn, `skill-pruner` sends the user prompt + available skill/tool descriptions to an LLM (via `@earendil-works/pi-ai`). When prior turns exist, it also includes the most recent user/assistant exchanges (read from the session tree, stopping at any compaction boundary) so follow-up prompts like "fix this" or "do that again" are judged in context rather than as standalone two-word requests. The LLM returns a **prune list** — the skills and tools it judges safe to *remove* for this turn — and `skill-pruner` then:

1. Keeps every skill the LLM did **not** prune. `pinned` / `alwaysKeep` skills are protected and can never be pruned — they're excluded from the prepass entirely so the model never sees them or spends tokens reasoning about them, then re-added unconditionally afterward.
2. Keeps every tool the LLM did not prune, additionally protecting any dependency of a kept tool (so pruning a tool never strands a tool that needs it).
3. Rewrites the system prompt to drop the pruned skills.
4. Disables pruned tools via `pi.setActiveTools()` (auto mode only).
5. Logs the decision — including tool pruning — to `data/pruning.jsonl`.

The model is **keep-biased**: an empty prune list (or an unreadable response) keeps everything, so "return nothing" always means "prune nothing". Pruning 100% of a category triggers a **keep-all safeguard**: everything is kept (with a recorded reason) rather than leaving the agent with nothing. This can also fire for a legitimate full prune — e.g. a non-coding query where no skill is relevant to the arc of work — since the prepass can't reliably distinguish that from an over-prune.

A `request_tool` recovery tool lets the agent re-enable a pruned tool mid-session; each recovery is logged to `data/pruning.jsonl` as the over-pruning quality signal.

## Configuration

Add a `pruning` block to `settings.json`:

```json
{
  "pruning": {
    "mode": "auto",
    "model": "gpt-5.4-mini",
    "provider": "github-copilot",
    "thinkingLevel": "minimal",
    "prepass": {
      "timeoutMs": { "minimal": 30000, "low": 45000 },
      "maxTransportRetries": 2,
      "transportBackoffBaseMs": 1000,
      "oauthRaceBackoffMs": 1500
    },
    "skills": {
      "strategy": "discretion",
      "ceiling": 8,
      "pinned": []
    },
    "tools": {
      "strategy": "discretion",
      "ceiling": 10,
      "dependencies": {
        "edit": ["read"],
        "subagent": ["bash"]
      }
    }
  }
}
```

### Top-level options

| Option | Default | Description |
|---|---|---|
| `mode` | `"auto"` | `auto` = prune + apply; `shadow` = log only; `off` = disabled |
| `model` | `"gpt-5.4-mini"` | LLM model for relevance scoring |
| `provider` | `"github-copilot"` | Provider for the scoring model |
| `thinkingLevel` | `"minimal"` | Reasoning effort for the scorer (e.g., `"minimal"`, `"medium"`, `"high"`) |
| `prepass` | _(built-in defaults)_ | Timeout / retry budgets for the LLM prepass call; see [Prepass options](#prepass-options) |

### Skills options

| Option | Default | Description |
|---|---|---|
| `strategy` | `"discretion"` | Pruning strategy (`discretion` = keep-biased, prune only clearly irrelevant items; `topK` = also steer toward the ceiling by pruning the least relevant) |
| `ceiling` | `8` | Soft guidance communicated to the LLM on the effective context size; **not** a hard cap (hard-enforcing it would force over-pruning) |
| `pinned` | `[]` | Skills protected from pruning regardless of the LLM's list |
| `alwaysKeep` | `[]` | Skills protected from pruning regardless of the LLM's list (set via the UI's "Omitted skills (never pruned)") |

### Tools options

| Option | Default | Description |
|---|---|---|
| `strategy` | `"discretion"` | Pruning strategy (see skills) |
| `ceiling` | `10` | Soft guidance (see skills) |
| `dependencies` | `{ edit: [read], subagent: [bash] }` | Tool → dependency mapping; a dependency of a **kept** tool is protected from pruning |
| `alwaysKeep` | `[]` | Tools protected from pruning regardless of the LLM's list (set via the UI's "Omitted tools (never pruned)") |

### Prepass options

Tunable knobs for the LLM prepass call itself (timeouts + retry budgets). Every field is optional — an absent field (or an absent `prepass` block entirely) keeps the built-in default, so you only override the budgets you want to change.

| Option | Default | Description |
|---|---|---|
| `timeoutMs` | _(see below)_ | Per-thinking-level timeout ceiling (ms) for ONE prepass model call. Ceilings, not waits: a call that completes early returns immediately. A partial map overrides only the levels it lists; any level not enumerated keeps its built-in default. Unknown thinking levels fall back to the effective `minimal` |
| `maxTransportRetries` | `2` | Max transport-level retries (5xx / 429 / network) per thinking-level attempt, with exponential backoff. `0` disables prepass-level transport retrying (pi-ai's own `maxRetries` is still forwarded) |
| `transportBackoffBaseMs` | `1000` | Base (ms) for the exponential backoff between transport retries (`base * 2**(attempt-1)`). `0` retries immediately |
| `oauthRaceBackoffMs` | `1500` | Backoff (ms) for the github-copilot OAuth-token race in `resolveAuth` (the prepass runs before the main agent's first call triggers the lazy OAuth refresh). `0` skips the re-resolve |

Built-in `timeoutMs` defaults (calibrated for reasoning models like `gpt-5-mini`, which emit encrypted reasoning tokens before the prune-list JSON):

| Thinking level | Default timeout |
|---|---|
| `minimal` | `30000` |
| `low` | `45000` |
| `medium` | `60000` |
| `high` | `75000` |
| `xhigh` | `90000` |

## Modes

| Mode | Prune? | Apply to prompt? | Log decisions? |
|---|---|---|---|
| `auto` | Yes | Yes | Yes |
| `shadow` | Yes | No | Yes |
| `off` | No | No | No (baseline reads only) |

## Integration

`skill-pruner` is a pi extension (loaded via `settings.json` packages). It hooks into:

- `before_agent_start` — main pruning logic. Any unexpected error fails open: the prompt and active tools are left untouched and the error is surfaced in the pruning-result message.
- `tool_call(read)` — tracks skill file reads for analytics

A `pruning-result` custom message is rendered in the transcript showing what was kept/pruned and estimated tokens saved; the agent turn then proceeds normally (no input handler is needed to continue).

## Recovery

- **Skills**: Use `/skill:name` on the next turn to explicitly include a skill
- **Tools**: Call `request_tool({ toolName: "web_search" })` to re-enable a pruned tool for the remainder of the session (the recovery is logged to `data/pruning.jsonl`)