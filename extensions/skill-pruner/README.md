# skill-pruner

Uses an LLM to score and prune skills/tools based on relevance to the current task. Reduces prompt noise and token usage by excluding irrelevant items.

## How it works

Before each agent turn, `skill-pruner` sends the user prompt + available skill/tool descriptions to an LLM (via `@earendil-works/pi-ai`). To keep the prepass itself cheap, the input context is kept lean: each candidate description is compacted to its leading relevance summary (whitespace collapsed; tools cut at the first sentence boundary within ~180 chars since their later text is usage caveats, skills capped more generously so their "Use when …" triggers survive), and only the last few user/assistant exchanges (capped per message) are included. When prior turns exist, it also includes the most recent user/assistant exchanges (read from the session tree, stopping at any compaction boundary) so follow-up prompts like "fix this" or "do that again" are judged in context rather than as standalone two-word requests. The LLM returns one flat **keep list** — candidates with a greater-than-50% chance of actual use before the request is complete — and `skill-pruner` derives the internal skill/tool prune lists by complement. The flat list avoids small models putting a tool name in a skill array (or vice versa). It then:

1. Keeps every skill the LLM did **not** prune. `pinned` / `alwaysKeep` skills are protected and can never be pruned — they're excluded from the prepass entirely so the model never sees them or spends tokens reasoning about them, then re-added unconditionally afterward.
2. Keeps every currently available tool the LLM did not prune, additionally protecting any dependency of a kept tool (so pruning a tool never strands a tool that needs it). Tools hidden by the preceding pruning decision are reconsidered, but tools disabled by the user, the Tools prompt toggle, or another extension are outside the candidate set and are never re-enabled by the pruner. If both the Skills and Tools prompt entries are empty/disabled, the LLM prepass is skipped entirely.
3. Rewrites the system prompt to drop the pruned skills.
4. Disables pruned tools via `pi.setActiveTools()` (auto mode only).
5. Logs the decision — including tool pruning — to `data/pruning.jsonl`.

The scorer returns only the tiny JSON shape `{"keep":[]}` with no explanation. The parser remains backward-compatible with the former `{"pruneSkills":[],"pruneTools":[]}` response and its optional `reasoning` field so cached/test responses remain readable.

The parser is **fail-open**: unreadable output keeps everything. It first recovers safe common formatting mistakes (including fenced/embedded JSON and trailing commas). If a non-empty response is still unreadable, the prepass retries once at the same thinking level with the invalid output plus an explicit JSON-only correction; only a second unreadable response falls back to keeping everything. A valid empty keep list means no optional candidate is probably needed. Pruning 100% of a category still triggers a **keep-all safeguard** when it would strand the agent. The tool safeguard always fires on a true 100% tool-prune (zero tools is fatal). The **skill** safeguard only fires when *no tools remain either* — an agent with zero skills but its tools is still fully functional, so a legitimate full skill-prune is allowed whenever at least one tool survives. Subagents still inherit keep-all on an empty parent kept-set as an independent safety net.

A single `request_capability` recovery tool progressively discloses both hidden tools and hidden skills. With no arguments it returns grouped names only. Selecting an exact tool activates it for the next model step in the same request; selecting an exact trusted skill returns its full `SKILL.md` body immediately. Recovered tools are reconsidered by the next pruning decision rather than remaining sticky for the whole session. Recoveries are logged to `data/pruning.jsonl` as over-pruning quality signals.

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
    "autoSkipBelowTokens": 1200,
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
| `prepass` | _(built-in defaults)_ | Sampling, output, timeout, and manual retry controls for the LLM prepass call; see [Prepass options](#prepass-options) |
| `autoSkipBelowTokens` | `1200` | Skip the LLM and keep all when the assembled prepass input (system prompt plus candidates) is below this estimate. Set `null` to disable |

### Skills options

| Option | Default | Description |
|---|---|---|
| `strategy` | `"discretion"` | Pruning strategy (`discretion` = apply the >50% probability boundary independently; `topK` = use the ceiling only to break ties between borderline candidates) |
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

Tunable knobs for the LLM prepass call itself. Every field is optional — an absent field (or an absent `prepass` block entirely) keeps the provider/built-in default, so you only override the controls you want to change.

| Option | Default | Description |
|---|---|---|
| `temperature` | _(provider default)_ | Optional sampling temperature from 0 to 2 for local Ollama prepasses, forwarded on every initial, correction, retry, and thinking-downgrade call. Non-local models always use their provider default because remote APIs vary in whether they accept this parameter |
| `maxOutputTokens` | _(disabled)_ | Optional scorer output cap, forwarded as pi-ai `maxTokens` on every initial, retry, and thinking-downgrade call. Use cautiously: some providers count hidden reasoning against this budget and may exhaust a low cap before emitting JSON |
| `timeoutMs` | _(see below)_ | Per-thinking-level timeout ceiling (ms) for ONE prepass model call. Ceilings, not waits: a call that completes early returns immediately. A partial map overrides only the levels it lists; any level not enumerated keeps its built-in default. Unknown thinking levels fall back to the effective `minimal` |
| `maxTransportRetries` | `2` | Max extension-level classified transport retries (5xx / 429 / network) per thinking-level attempt, with exponential backoff. `0` disables them. pi-ai `maxRetries` is always `0`, avoiding nested retry amplification |
| `transportBackoffBaseMs` | `1000` | Base (ms) for the exponential backoff between transport retries (`base * 2**(attempt-1)`). `0` retries immediately |
| `oauthRaceBackoffMs` | `1500` | Backoff (ms) for the github-copilot OAuth-token race in `resolveAuth` (the prepass runs before the main agent's first call triggers the lazy OAuth refresh). `0` skips the re-resolve |

The latest successful parse-valid result is cached per session for 30 minutes. It is reused only when the catalog/config/context fingerprint is unchanged and the next prompt is identical or is an explicit continuation/retry phrase such as `continue`, `go ahead`, `retry`, or `fix this`. Cache hits still apply selection, emit feedback and analytics, and are marked `cached`; arbitrary short prompts are never reused. A second, bounded LRU cache (max 64 entries) additionally reuses a prior session's decision across sessions, but only on an **exact** prompt + fingerprint match (whitespace-normalized) — never on continuation prompts, which are context-dependent. The per-session cache is consulted first (it owns continuation semantics); a cross-session hit is promoted to the per-session cache so this session's later continuations still reuse it.

Built-in `timeoutMs` defaults (calibrated for reasoning models like `gpt-5-mini`, which emit encrypted reasoning tokens before the keep-list JSON):

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

Call `request_capability({})` only after checking the active tools and skills and finding no suitable capability. Never poll merely to verify, supplement, or replace a suitable active capability. The result lists hidden tool and skill names without descriptions or schemas. Then select exactly one listed capability:

```json
{ "capabilityType": "tool", "capabilityName": "web_search" }
```

A tool becomes formally available on the next model step within the same user request. For a skill, use `"capabilityType": "skill"`; the recovery result contains the trusted skill body and its relative-reference base directory. Do not repeat a poll whose result remains in context. A new top-level pruning decision may hide a previously recovered tool again.
