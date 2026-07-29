# Centralized Model Configuration

> **Status:** Implemented, with later architecture changes. `models.yaml` owns the provider catalog and seed defaults; `npm run sync-models` regenerates `models.json` and provider-qualified `model-profiles.yaml`, then merges centrally-owned fields into `settings.json`. Model identity is the `(provider, id)` pair; duplicate ids across providers are supported by using `{ provider, id }` entries in `profileOrder`. Active chat and pruning selections are runtime user preferences: sync seeds missing values but preserves existing choices. The historical proxy sections below are retained as design rationale; see `README.md` and `AGENTS.md` for current usage.
> **Current ownership:** `models.yaml` owns catalog data and retry policy. The settings UI owns active chat/pruning model, provider, and thinking-level selections. GitHub Copilot is account-scoped and reconciles its available models into `models.yaml` at session startup via the single-flight, retryable `extensions/copilot-model-discovery`; the normal codegen then regenerates every derived catalog surface. It does not register a parallel runtime provider list.

## 1. Problem

Model configuration is scattered across **four** manually-maintained surfaces with
**zero automated sync**. Adding or changing a model today requires editing 2–4 files,
and one pairing (umans ↔ litellm) has no validation at all.

| Surface | Path | Format | Owns | Readers |
|---|---|---|---|---|
| **models.json** | `./models.json` | JSON (24 KB) | provider wiring, real USD pricing, model registry | ~14 TS files (pricing loaders, subagent-profiles, agent-dir resolution, proxy-service via baseUrl match, startup) |
| **model-profiles.yaml** | `./model-profiles.yaml` | YAML | eligibility flags, thinking-level allowlists, disabled reasons | subagent configuration and picker metadata |
| **litellm_config.yaml** | `./proxy/litellm_config.yaml` | YAML (5.7 KB) | LiteLLM routing for umans: `model_list[]` + concurrency limits | **LiteLLM Python process only** (passed via `--config` path; no TS code parses it) |
| **settings.json** | `./settings.json` | JSON (0.9 KB) | defaultModel, defaultProvider, defaultThinkingLevel, retry, pruning.model/provider/thinkingLevel | extension runtime |

### Current pain points

1. **umans model ids are hard-duplicated** between `models.json` (`providers.umans.models[]`)
   and `litellm_config.yaml` (`model_list[]`). Every umans model must appear in **both** or
   routing silently breaks. **No code or test validates this pairing.**
2. The only enforcement is `extension/test/integration/model-profile-coverage.test.ts` — tests checking
   models.json ↔ model-profiles.yaml id agreement (fail-only, no repair). It does **not** cover
   the litellm pairing.
3. settings.json model fields (`defaultModel`, `pruning.model`, etc.) reference model ids that
   must exist in models.json — validated nowhere.

## 2. Target Architecture

```
                    ┌─────────────────────────────────────┐
                    │       models.yaml  (SOURCE)         │  ← single edit point
                    │       models.schema.json            │  ← validates source
                    └──────────────┬──────────────────────┘
                                   │  npm run sync-models
                    ┌──────────────┴──────────────────────┐
                    │       scripts/sync-models.mjs        │
                    └──┬──────────┬──────────┬─────────────┘
            ┌──────────┘          │          └──────────┐
            ▼                     ▼                     ▼
   ┌────────────────┐   ┌──────────────────┐   ┌────────────────────┐
   │  models.json    │   │ model-profiles   │   │ proxy/litellm_     │   ┌─────────────┐
   │  (generated)    │   │ .yaml (generated) │   │ config.yaml       │   │ settings.json│
   └────────────────┘   └──────────────────┘   │ (generated)        │   │ (merge)      │
                                                 └────────────────────┘   └─────────────┘
```

- **One source file** (`models.yaml`) — the only file a human or agent edits to add/change a model.
- **One JSON Schema** (`models.schema.json`) — validates the source before generation.
- **One sync script** (`scripts/sync-models.mjs`) — regenerates all four derived files.
- **All existing readers stay unchanged** (codegen approach = lowest risk).

### Decisions locked with owner

| Decision | Choice | Rationale |
|---|---|---|
| Propagation mechanism | **Codegen** (generate derived files) | Lowest risk: readers unchanged, derived files auto-synced. LiteLLM needs a YAML file regardless. |
| Scope | **All model config** incl. settings.json model fields | Single source for defaultModel, defaultProvider, retry, pruning.model/provider/thinkingLevel too. |
| Source format | **YAML + JSON Schema** | Human-readable, supports inline comments (pricing sources, disabled reasons, routing notes). Schema adds validation. |

## 3. Source File: `models.yaml`

Lives at repo root. Contains **everything** model-related merged into one file, organized by
concern. Every model entry carries both its `models.json` fields (provider/pricing/metadata)
and its `model-profiles.yaml` fields (eligibility/thinking) in one place.

### Annotated structure (excerpt — full file generated during migration)

```yaml
# ─────────────────────────────────────────────────────────────────────
# pie model configuration — SINGLE SOURCE OF TRUTH.
# Do not edit models.json, model-profiles.yaml, proxy/litellm_config.yaml,
# or settings.json model fields directly. Run:  npm run sync-models
# ─────────────────────────────────────────────────────────────────────

# ── Defaults → settings.json ──────────────────────────────────────────
defaults:
  model: umans-kimi-k2.7
  provider: umans
  thinkingLevel: xhigh

# ── Retry → settings.json.retry ──────────────────────────────────────
retry:
  enabled: true
  maxRetries: 8
  baseDelayMs: 5000
  provider:
    maxRetries: 2
    maxRetryDelayMs: 60000

# ── Pruning model selection → settings.json.pruning.{model,provider,thinkingLevel} ──
# (pruning.tools stays in settings.json — not model config)
pruning:
  model: gpt-5-mini
  provider: github-copilot
  thinkingLevel: low

# ── Proxy-level settings → proxy/litellm_config.yaml top-level keys ──
proxy:
  routerSettings:
    numRetries: 2
    retryAfter: true
    timeout: 600
  litellmSettings:
    dropParams: true
  generalSettings:
    masterKeyEnv: UMANS_API_KEY      # → general_settings.master_key: os.environ/UMANS_API_KEY

# ── Providers & Models ───────────────────────────────────────────────
# Each model entry carries BOTH its models.json fields (pricing, metadata,
# API routing) AND its model-profiles.yaml fields (eligible and thinking).
# The sync script splits them into the right derived files.
providers:

  ollama:
    baseUrl: http://localhost:11434/v1
    api: openai-completions
    apiKey: ollama
    compat:
      supportsDeveloperRole: false
      supportsReasoningEffort: false
      supportsUsageInStreaming: true
      maxTokensField: max_tokens
    models:
      - id: mistral-7b-pi:latest
        name: Ollama Local: Mistral 7B (Pi, 8K ctx)
        contextWindow: 8192
        maxTokens: 512
        pricing:                    # → models.json cost{input,output,cacheRead,cacheWrite} (USD/M-token)
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        eligible: false             # → model-profiles.yaml eligible
        thinking: [minimal]         # → model-profiles.yaml thinking
        disabledReason: Too small for agentic work   # → model-profiles.yaml disabled_reason

      - id: deepseek-v4-pro:cloud
        name: Ollama Cloud: DeepSeek V4 Pro
        reasoning: true
        contextWindow: 1048576
        maxTokens: 65536
        pricing:
          input: 0.435
          output: 0.87
          cacheRead: 0.0036
          cacheWrite: 0
        eligible: true
        thinking: [medium, high, xhigh]
        disabledReason: null

  github-copilot:
    apiKey: copilot
    headers:
      User-Agent: GitHubCopilotChat/0.35.0
      Editor-Version: vscode/1.107.0
      Editor-Plugin-Version: copilot-chat/0.35.0
      Copilot-Integration-Id: vscode-chat
    models:
      # `overrideOnly: true` → goes to modelOverrides map in models.json
      # (pricing/metadata override, no explicit api/compat routing).
      # Default (absent) → goes to models[] array in models.json.
      - id: claude-haiku-4.5
        name: Copilot: Claude Haiku 4.5
        reasoning: true
        contextWindow: 200000
        maxTokens: 16384
        pricing:
          input: 1
          output: 5
          cacheRead: 0.1
          cacheWrite: 1.25
        overrideOnly: true
        eligible: true
        thinking: [minimal, low, medium]
        disabledReason: null

      # Full model: has api + compat → models[] in models.json
      - id: claude-opus-4.8
        name: Copilot: Claude Opus 4.8
        api: anthropic-messages
        compat:
          forceAdaptiveThinking: true
        reasoning: true
        input: [text, image]
        contextWindow: 144000
        maxTokens: 64000
        thinkingLevelMap:
          minimal: medium
          low: medium
          medium: medium
          high: medium
          xhigh: medium
        pricing:
          input: 5
          output: 25
          cacheRead: 0.5
          cacheWrite: 6.25
        eligible: true
        thinking: [medium]
        disabledReason: null

  umans:
    baseUrl: http://localhost:4000/v1   # points at local LiteLLM proxy, NOT upstream
    api: openai-completions
    apiKey: $UMANS_API_KEY
    compat:
      supportsReasoningEffort: true
    # `upstream` → generates proxy/litellm_config.yaml model_list[] entries.
    # ONLY providers with an `upstream` block get litellm entries.
    # Copilot/Ollama have no upstream block → stay direct (never proxied).
    upstream:
      apiBase: https://api.code.umans.ai/v1
      apiKeyEnv: UMANS_API_KEY
      litellmProvider: openai          # litellm syntax: <litellmProvider>/<modelId>
      maxConcurrentRequests: 4         # → litellm_params.max_parallel_requests per model
      # All variants of one upstream share a model_info.id so LiteLLM creates
      # ONE semaphore across them (account-wide cap, not per-model).
      litellmModelInfoId: umans-shared
      alias:                           # model_name aliases (extra model_list entries)
        umans: umans-coder             #   "umans" → routes to umans-coder
    models:
      - id: umans-coder
        name: Umans: Coder
        reasoning: true
        input: [text, image]
        contextWindow: 262144
        maxTokens: 32768
        pricing:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        thinkingLevelMap:
          off: null
          minimal: minimal
          low: low
          medium: medium
          high: high
          xhigh: xhigh
        eligible: true
        thinking: [low, medium, high, xhigh]
        disabledReason: null
```

### Derived-field naming

| Source field (`models.yaml`) | models.json field | model-profiles.yaml field | Meaning |
|---|---|---|---|
| `pricing: {input, output, cacheRead, cacheWrite}` | `cost: {input, output, cacheRead, cacheWrite}` | — | Real USD per 1M tokens |
| `disabledReason` | — | `disabled_reason` | snake_case in derived YAML |
| `overrideOnly` | (splits models[] vs modelOverrides) | — | routing flag, source-only |

Source uses **camelCase** throughout; the sync script converts to whatever each derived file
expects (snake_case for model-profiles.yaml `disabled_reason`, camelCase for JSON, LiteLLM's
snake_case for litellm_config.yaml).

### The `overrideOnly` flag

`models.json`'s github-copilot provider has two model collections:
- `models[]` — fully wired models with `api`/`compat`/`thinkingLevelMap` (currently 2 entries)
- `modelOverrides` — pricing/metadata overrides for Copilot-exposed models (~30 entries)

In the source YAML these are **one list**. `overrideOnly: true` (default `false`) tells the
sync script to emit the model into `modelOverrides` instead of `models[]`. This preserves the
exact generated structure so no reader changes are needed.

> **Alternative considered:** eliminate `modelOverrides` entirely, put everything in `models[]`.
> All readers handle `modelOverrides` as optional, so this would work — but it changes the
> generated models.json structure and risks subtle reader dependencies. Flagged as a
> **post-migration simplification**, not part of this plan.

## 4. Field Flow Map (source → derived)

| Source (`models.yaml`) | models.json | model-profiles.yaml | litellm_config.yaml | settings.json |
|---|---|---|---|---|
| `defaults.model` | — | — | — | `defaultModel` |
| `defaults.provider` | — | — | — | `defaultProvider` |
| `defaults.thinkingLevel` | — | — | — | `defaultThinkingLevel` |
| `retry.*` | — | — | — | `retry.*` (whole object, overwritten) |
| `pruning.model` | — | — | — | seeds `pruning.model` when absent |
| `pruning.provider` | — | — | — | seeds `pruning.provider` when absent |
| `pruning.thinkingLevel` | — | — | — | seeds `pruning.thinkingLevel` when absent |
| `proxy.routerSettings.*` | — | — | `router_settings.*` | — |
| `proxy.litellmSettings.*` | — | — | `litellm_settings.*` | — |
| `proxy.generalSettings.masterKeyEnv` | — | — | `general_settings.master_key: os.environ/<ENV>` | — |
| `providers.<p>.baseUrl` | `providers.<p>.baseUrl` | — | — | — |
| `providers.<p>.api` | `providers.<p>.api` | — | — | — |
| `providers.<p>.apiKey` | `providers.<p>.apiKey` | — | `litellm_params.api_key: os.environ/<ENV>` (if upstream) | — |
| `providers.<p>.compat` | `providers.<p>.compat` | — | — | — |
| `providers.<p>.headers` | `providers.<p>.headers` | — | — | — |
| `providers.<p>.upstream` | — | — | → `model_list[]` (one entry per model + aliases) | — |
| `providers.<p>.models[].id` | `models[].id` / `modelOverrides` key | `profiles[].id` | `model_list[].model_name` | — |
| `providers.<p>.models[].name` | `models[].name` / `modelOverrides.name` | — | — | — |
| `providers.<p>.models[].pricing` | `models[].cost` / `modelOverrides.cost` | — | — | — |
| `providers.<p>.models[].contextWindow` | `models[].contextWindow` | — | — | — |
| `providers.<p>.models[].maxTokens` | `models[].maxTokens` | — | — | — |
| `providers.<p>.models[].reasoning` | `models[].reasoning` | — | — | — |
| `providers.<p>.models[].family` | `models[].family` | — | — | — |
| `providers.<p>.models[].input` | `models[].input` | — | — | — |
| `providers.<p>.models[].thinkingLevelMap` | `models[].thinkingLevelMap` | — | — | — |
| `providers.<p>.models[].compat` | `models[].compat` | — | — | — |
| `providers.<p>.models[].overrideOnly` | (routing: models[] vs modelOverrides) | — | — | — |
| `providers.<p>.models[].eligible` | — | `profiles[].eligible` | — | — |
| `providers.<p>.models[].thinking` | — | `profiles[].thinking` | — | — |
| `providers.<p>.models[].disabledReason` | — | `profiles[].disabled_reason` | — | — |

### litellm `model_list` generation rule

For each provider with an `upstream` block, the sync script emits one `model_list` entry per
model in `providers.<p>.models[]`, plus one entry per alias in `upstream.alias`:

```yaml
# Generated for each model:
- model_name: <model.id>            # what pie requests
  litellm_params:
    model: <upstream.litellmProvider>/<upstream.modelId or model.id>
    api_base: <upstream.apiBase>
    api_key: os.environ/<upstream.apiKeyEnv>
    max_parallel_requests: <upstream.maxConcurrentRequests>
  model_info:
    id: <upstream.litellmModelInfoId>   # shared across variants → one global semaphore

# Generated for each alias:
- model_name: <alias.key>           # e.g. "umans"
  litellm_params:
    model: <upstream.litellmProvider>/<alias.value>   # e.g. openai/umans-coder
    api_base: <upstream.apiBase>
    api_key: os.environ/<upstream.apiKeyEnv>
    max_parallel_requests: <upstream.maxConcurrentRequests>
  model_info:
    id: <upstream.litellmModelInfoId>
```

**This is the core win:** adding a new umans model = add one entry to
`providers.umans.models[]` in `models.yaml` → sync generates both the models.json
entry AND the litellm_config.yaml routing entry. The currently-unguarded duplication
becomes structurally impossible to forget.

## 5. JSON Schema: `models.schema.json`

Validates `models.yaml` before generation. Catches:
- Missing required fields (`id`, `name` on models; `eligible`, `thinking` on every model
  since profiles are mandatory per the existing coverage test).
- Invalid `pricing` values (negative, NaN, non-number).
- Invalid `thinkingLevel` enum values (`minimal | low | medium | high | xhigh | off`).
- Duplicate model ids (within and across providers — the coverage test already requires
  bidirectional id agreement, so duplicates would break consumers).
- `overrideOnly` models missing `pricing` (overrides exist for pricing; an override without
  pricing is meaningless).
- Models in a provider with `upstream` but missing required upstream fields.

The schema is a **starting point** — it should be tightened during implementation. A
`additionalProperties: true` (lenient) initial version is acceptable; tighten to `false`
per-section as confidence grows.

## 6. Sync Script: `scripts/sync-models.mjs`

### Interface

```bash
npm run sync-models          # validate + regenerate all derived files
npm run sync-models -- --check   # dry-run: exit 1 if any derived file would change
npm run sync-models -- --verbose # print what changed per file
```

### Behavior

1. **Load** `models.yaml` (parse with the `yaml` package, already a dependency).
2. **Validate** against `models.schema.json` (use `ajv` or a lightweight hand-written
   validator — see Open Items §11.2). **Fail fast** on schema errors; do not write files.
3. **Generate** the four outputs (in memory):
   - `models.json` — split each provider's models into `models[]` (overrideOnly absent/false)
     and `modelOverrides` (overrideOnly: true). Emit `cost` (from `pricing`), not `pricing`.
   - `model-profiles.yaml` — `profiles: [{ id, eligible, thinking, disabled_reason, cost }]`
     for every model, in source order. Emit a generated-file header comment.
   - `proxy/litellm_config.yaml` — top-level `model_list`, `router_settings`,
     `litellm_settings`, `general_settings` per §4. Emit a generated-file header comment
     preserving the key operational notes (timeout warning, master_key explanation).
   - `settings.json` — **read-modify-write merge**: overwrite centrally-owned `retry`, seed
     missing chat/pruning selections from `models.yaml`, and preserve existing user selections
     plus all unrelated runtime settings.
4. **Write** each file only if content changed (compare to existing; skip writes that are
   no-ops to avoid touching mtimes — `subagent-profiles.ts` caches by mtime).
5. **Report** a summary: which files updated, which unchanged, any warnings.

### Generated file headers

Each generated file gets a banner:
```yaml
# ⚠️  GENERATED by `npm run sync-models` from models.yaml — DO NOT EDIT.
# Source of truth: models.yaml (repo root). Edit there and re-run sync.
```

For `litellm_config.yaml` specifically, the script emits a **static operational-notes block**
after the banner (the timeout/master_key warnings currently in the file) so the Python-only
consumers still have their context. These notes are hardcoded in the sync script (not in
models.yaml) because they describe LiteLLM's behavior, not model config.

### settings.json merge details

settings.json is **not** a fully generated file — it has non-model fields the extension
modifies at runtime (`lastChangelogVersion`) and that users edit independently (`packages`,
`sessionDir`). The sync script does a targeted field-level overwrite:

```js
// Pseudocode
const settings = JSON.parse(read('settings.json'));
settings.defaultModel ||= source.defaults.model;
settings.defaultProvider ||= source.defaults.provider;
settings.defaultThinkingLevel ||= source.defaults.thinkingLevel;
settings.retry = source.retry;                          // whole-object overwrite
settings.pruning ??= {};
settings.pruning.model ||= source.pruning.model;
settings.pruning.provider ||= source.pruning.provider;
settings.pruning.thinkingLevel ||= source.pruning.thinkingLevel;
write('settings.json', JSON.stringify(settings, null, 2));
```

## 7. Validation & Testing

### New: sync-consistency test

`extension/test/integration/model-config-sync.test.ts` — the primary guard against drift:

1. Run the sync script's generation logic **in-memory** from `models.yaml`.
2. Compare against the committed `models.json`, `model-profiles.yaml`,
   `proxy/litellm_config.yaml`, and the model fields of `settings.json`.
3. **Fail** with a diff if any derived file doesn't match what sync would produce.

This catches: (a) someone editing a derived file directly, (b) someone editing
`models.yaml` but forgetting to run `npm run sync-models`, (c) a sync-script bug.

### Existing: model-profile-coverage.test.ts

Becomes **partially redundant** (models.json ↔ model-profiles.yaml can't drift if both are
generated from one source). **Keep it** as a defense-in-depth safety net — it's cheap and
catchs sync-script bugs. Add one **new** assertion to it: umans models in models.json ↔
litellm model_list agreement (the currently-unguarded pairing).

### New: schema validation test

A unit test that loads `models.yaml` + `models.schema.json` and asserts the source validates.
Catches source edits that break the schema.

### CI gate (optional, recommended)

Add `npm run sync-models -- --check` as a pre-commit hook or CI step so uncommitted drift
fails the build.

## 8. Migration Steps (ordered)

Each step is independently verifiable. Commit after each.

1. **Write the sync script** (`scripts/sync-models.mjs`) with generation logic for all four
   outputs. No schema validation yet — just generation.

2. **Hand-build `models.yaml`** from the current derived files:
   - Merge `models.json` providers/models + `model-profiles.yaml` profiles (join on `id`).
   - Rename the `cost` pricing object → `pricing` and `disabled_reason` →
     `disabledReason`.
   - Mark github-copilot `modelOverrides` entries with `overrideOnly: true`.
   - Add `upstream` block to the umans provider (extracted from `litellm_config.yaml`).
   - Add `defaults`, `retry`, `pruning`, `proxy` sections from settings.json + litellm globals.

3. **Run sync, diff outputs against existing files.** Iterate until the generated files are
   **semantically identical** to the current ones (field-for-field; comments/header
   whitespace differences are acceptable but field values must match exactly). This is the
   correctness proof — if sync reproduces the current state, no behavior changes.

4. **Add `models.schema.json`** and wire validation into the sync script (step 1 of
   script behavior).

5. **Add `npm run sync-models`** to `package.json` scripts. Add `--check` flag.

6. **Add the sync-consistency test** (`extension/test/integration/model-config-sync.test.ts`).

7. **Add the umans ↔ litellm assertion** to `model-profile-coverage.test.ts`.

8. **Add generated-file banners** to the sync output. Re-run sync to apply them.

9. **Update documentation** (§9).

10. **Commit.** Derived files are now generated artifacts living in git.

### Migration verification commands

```bash
# After step 3 — verify no semantic diff:
npm run sync-models -- --verbose   # should report "all files unchanged" (or only banner diffs)

# After step 6 — verify sync-consistency test passes:
npm test                           # all tests green including new sync test

# After step 8 — verify banners applied and nothing else changed:
git diff --stat                    # should show only the 4 derived files + banner lines
```

## 9. Documentation Updates

| File | Update |
|---|---|
| `AGENTS.md` (pie root) | Add: "Model config lives in `models.yaml`. Run `npm run sync-models` after editing. Do not edit models.json / model-profiles.yaml / litellm_config.yaml / settings.json model fields directly." |
| `README.md` | Add a "Model Configuration" section pointing to `models.yaml` as source of truth + the sync command. |
| `proxy/README.md` | Note that `litellm_config.yaml` is now generated from `models.yaml`'s `upstream` blocks; remove the "add a matching baseUrl redirect block in models.json" manual instruction. |
| `docs/internal/model-token-pricing-sources.md` | Add a header note: pricing now lives in `models.yaml` `pricing:` fields; this doc remains the evidence ledger/changelog. |
| `models.yaml` (self-documenting) | Header comment block explaining the file, the sync command, and the field-flow. |

## 10. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sync script has a bug that corrupts a derived file | Medium | High | Step 3 (semantic diff against current files) catches this before merge. Sync-consistency test catches it after. |
| Someone edits a derived file directly (bypassing sync) | Medium | Medium | Generated-file banner + sync-consistency test (`--check`) fails CI. |
| `overrideOnly` flag mis-set, model lands in wrong models.json collection | Low | Medium | Schema can warn if `overrideOnly: true` but model has `api`/`compat` (contradictory). Reviewer catches in PR. |
| settings.json merge clobbers a runtime user choice | Low | High | Chat/pruning selections are seeded only when absent; preservation and fresh-settings behavior are both tested. |
| Generated `model-profiles.yaml` loses the section comments ("=== COPILOT MODELS ===") | Low | Low | Source YAML keeps comments for organization; generated file is pure data with a banner. Acceptable tradeoff. |
| `litellm_config.yaml` loses operational notes (timeout warning) | Low | Medium | Sync script emits a static notes block hardcoded in the script (not from models.yaml). |
| Future LiteLLM schema changes require new fields | Low | Low | Add fields to `proxy.*` in models.yaml + extend generation. Single edit point makes this trivial. |

## 11. Open Items / Points to Verify During Implementation

### 11.1 `overrideOnly` — confirm no reader depends on `modelOverrides` being separate

All identified readers handle `modelOverrides` as **optional** (`if (provider.modelOverrides && ...)`):
`pricing.ts`, `subagent-profiles.ts`, `model-profile-coverage.test.ts`, analysis loaders.
The plan preserves `modelOverrides` via the `overrideOnly` flag, so this is safe regardless.
But during implementation, grep for any reader doing `provider.modelOverrides[id]` (direct key
access without guard) and confirm it's guarded. If all are guarded, the post-migration
simplification (eliminate `modelOverrides`, put everything in `models[]`) becomes viable.

### 11.2 Schema validation library choice

Options:
- **`ajv`** — full JSON Schema support, adds a dependency. Recommended for correctness.
- **Hand-written validator** — no dependency, but must be maintained as schema evolves.
- **`zod`** — ergonomic, but it's a different schema language (not JSON Schema file on disk).

Recommend `ajv` (or `@hyperjump/json-schema` for draft-2020-12). The schema file on disk is
useful as documentation and for editor autocomplete. Confirm the extension's existing
dependency tree doesn't already include a validator before adding one.

### 11.2a Verify `yaml` package is available to the sync script

The `yaml` package is already used by `subagent-profiles.ts` and `bucket-selector.ts`
(lazy-loaded). Confirm it resolves from `scripts/` context (root `package.json` may need it
as a direct dep, or the script resolves it via the extension's node_modules — check the
`createRequire` pattern in `bucket-selector.ts`).

### 11.3 YAML key ordering / formatting

The generated `model-profiles.yaml` and `litellm_config.yaml` must be deterministic
(re-running sync with no source changes = no diff). The `yaml` package's `stringify` with
fixed options (`sortMapEntries: false`, consistent indent) handles this. Verify no-ops don't
touch mtimes (compare before write).

### 11.4 `thinkingLevelMap` `off` / `null` values

Some umans models use `off: null` or `off: "none"` in `thinkingLevelMap`. The source YAML
must preserve these verbatim. Verify YAML serialization of `null` values matches the current
JSON output (`null`, not `~` or empty). May need explicit handling in the generator.

### 11.5 Does `analysis/` read litellm_config.yaml?

The grep showed no `analysis/` file references `litellm_config`. Confirm analysis scripts
derive umans routing info from models.json only (they do, per the scout). If an analysis
script ever needs litellm routing, it should read `models.yaml`'s `upstream` block directly
going forward.

### 11.6 install.ps1 / install.sh

Scout reported these write only VS Code's `settings.json` (IDE settings), not pi's
`models.json`/`settings.json`. Verify they don't reference model config files in a way that
breaks. If they do, update them to point at `models.yaml` (the source) or leave as-is if they
only read derived files.

## 12. What this plan does NOT do (non-goals)

- **Does not change any reader.** All ~14 TS reader files stay byte-identical. This is the
  codegen tradeoff: derived files still exist, just auto-synced. A future "runtime unification"
  phase can migrate readers to import `models.yaml` directly and eliminate 2 of 3 derived files.
- **Does not restructure the `modelOverrides` concept.** Preserved via `overrideOnly` flag.
- **Does not touch non-model settings.json fields** (`packages`, `sessionDir`, `subagent`,
  `httpIdleTimeoutMs`, `lastChangelogVersion`, `pruning.tools`).
