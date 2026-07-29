---
name: add-provider
description: Add or update an LLM provider in pie's centralized model catalog (`models.yaml`), including secure auth references, model metadata, host-side concurrency, generated config, and verification. Use when the user asks to register a direct API provider, custom OpenAI-compatible endpoint, local model server, or new models for an existing provider.
---

# Add a Provider

`models.yaml` is the single source of truth for providers and model metadata in this repo. `npm run sync-models` validates it and regenerates `models.json`, `model-profiles.yaml`, and model-owned fields in `settings.json`.

Do not edit those derived files directly. The old LiteLLM `settings.json.proxy` workflow no longer exists; providers route directly to their upstream endpoint and concurrency is enforced by the host-side provider gate.

## 1. Gather facts before editing

Read `AGENTS.md`, `models.schema.json`, the closest existing provider in `models.yaml`, and pi's custom-model documentation when needed.

Collect or research:

- provider key: lowercase and stable
- direct upstream `baseUrl`
- API type: `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`
- desired model IDs and display names
- input types, reasoning support, context window, maximum output, supported thinking levels, and compatibility flags
- pricing in USD per million tokens, including cache rates
- host-side concurrency limits

Do not guess model IDs, pricing, or capabilities when authoritative provider documentation or a model-list endpoint is available. Ask the user only for product choices or genuinely unavailable facts.

## 2. Keep credentials out of chat and source control

Never ask the user to paste an API key into chat, a tool argument, `models.yaml`, `settings.json`, or a committed file. Ask them to configure the credential outside the agent transcript and confirm when it is available.

Reference secrets in `models.yaml` with environment interpolation:

```yaml
apiKey: $ACME_API_KEY
```

Pi also supports auth configured through `/login`/`auth.json` and command-backed values, but follow the established convention of the provider being added. For a keyless local server, use the existing local-provider placeholder pattern.

Before finishing, inspect the diff/status for accidental secrets. Never print credential values while verifying; check only whether the reference resolves or whether an authenticated request succeeds.

## 3. Add the provider catalog

Match an existing provider with the same API shape. A direct OpenAI-compatible provider typically looks like:

```yaml
providers:
  acme:
    baseUrl: https://api.acme.example/v1
    api: openai-completions
    apiKey: $ACME_API_KEY
    concurrency:
      maxConcurrentRequests: 4
      afterburnSeconds: 15
      queueWaitSeconds: 30
    compat:
      supportsDeveloperRole: false
      supportsReasoningEffort: false
      supportsUsageInStreaming: true
      maxTokensField: max_tokens
    models:
      - id: acme-model-id
        name: "Acme: Model"
        reasoning: false
        input:
          - text
        contextWindow: 128000
        maxTokens: 16384
        pricing:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        eligible: true
        thinking:
          - minimal
        disabledReason: null
```

Important:

- `baseUrl` is the real upstream endpoint, not a local proxy.
- Every model must include the fields required by `models.schema.json`, including complete pricing, eligibility, thinking levels, and `disabledReason`.
- Use provider-level `compat` for shared behavior and model-level overrides only when a model differs.
- `concurrency.maxConcurrentRequests` is the provider-wide cap. `afterburnSeconds` reserves a recently used slot for session affinity; `queueWaitSeconds` bounds waiting.
- Add each new model identity exactly once to top-level `profileOrder` in the desired picker order; use `{ provider, id }` when the bare ID exists under multiple providers.
- Model IDs must be unique within a provider; duplicate bare IDs across providers are supported through provider-qualified identity.

For adding models to an existing provider, change only its `models` list and `profileOrder`; preserve its established auth, compatibility, and concurrency configuration unless the task explicitly changes them.

## 4. Sync and verify

Run from the repo root:

```bash
npm run sync-models
node scripts/sync-models.mjs --check
```

Run the focused model-config test:

```bash
cd extension
npx tsx --test test/integration/model-config-sync.test.ts
```

If `extension/src/` was changed for provider-specific runtime behavior, also run the required extension build:

```bash
cd extension
npm run build
```

Verify:

- generated config has no drift
- the provider and models appear in `models.json` with the expected endpoint and metadata
- `model-profiles.yaml` contains every new model in the intended order
- `settings.json` retains user-owned defaults and contains no legacy provider routing block
- with auth configured, a minimal model request succeeds without exposing the key

## 5. Safety checklist

- [ ] Only `models.yaml` was edited as model configuration source
- [ ] No secret value appears in the diff, transcript output, or tracked files
- [ ] Provider endpoint and API type match the upstream protocol
- [ ] Model metadata came from authoritative documentation or was explicitly confirmed
- [ ] Every model ID appears exactly once in `profileOrder`
- [ ] Concurrency is provider-wide and intentionally chosen
- [ ] `sync-models --check` passes
- [ ] Focused tests pass, and `extension/` was rebuilt if its source changed
