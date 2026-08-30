---
name: add-provider
description: Add or update an LLM provider in pie's centralized model catalog (`models.yaml`), including secure auth references, model metadata, host-side concurrency, generated config, and verification. Use when the user asks to register a direct API provider, custom OpenAI-compatible endpoint, local model server, or new models for an existing provider.
---

# Add a Provider

`models.yaml` is the single source of truth for providers and model metadata in this repo. `npm run sync-models` validates it and regenerates every derived surface: `models.json`, `model-profiles.yaml`, model-owned fields in `settings.json` (model picker seeds and retry config; existing chat/pruning selections are user-owned and preserved), and `analysis/model-pricing-history.json` (pricing/attribution metadata for retired or superseded models, consumed by the analytics loaders — not part of the live picker).

Do not edit any of those generated files directly. The old LiteLLM `settings.json.proxy` workflow no longer exists; providers route directly to their upstream endpoint and concurrency is enforced by the host-side provider gate.

## 1. Gather facts before editing

Read `AGENTS.md`, `models.schema.json`, the closest existing provider in `models.yaml`, and pi's custom-model documentation when needed.

Collect or research:

- provider key: lowercase and stable
- direct upstream `baseUrl`
- API type: `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`
- desired model IDs and display names
- input types, reasoning support, context window, maximum output, supported thinking levels, and compatibility flags
- for image-capable models, `maxImagesPerRequest`: pie's policy maximum is conservatively 1; raise a limit only with provider-qualified documentation or measured acceptance evidence, never by inferring behavior from a model family name
- pricing in USD per million tokens, including cache rates
- host-side concurrency limits

Do not guess model IDs, pricing, or capabilities when authoritative provider documentation or a model-list endpoint is available. Ask the user only for product choices or genuinely unavailable facts.

## 2. Keep credentials out of chat and source control

Never ask the user to paste an API key into chat, a tool argument, `models.yaml`, `settings.json`, or a committed file. Ask them to configure the credential outside the agent transcript and confirm when it is available.

Reference secrets in `models.yaml` with environment interpolation:

```yaml
apiKey: $ACME_API_KEY
```

Understand the `apiKey` distinction: in `models.yaml` it is a request-time reference, never a stored secret. `$ENV_VAR`/`${ENV_VAR}` interpolate the environment, a leading `!command ` runs a command for the whole value, and `$$` and `$!` escape literal `$`/`!`. The generic config resolver treats `apiKey: oauth` as a literal; in this catalog it is only a placeholder convention for a provider already registered as OAuth-capable (for example, the SDK's `openai-codex` provider). It is not a generic OAuth sentinel and does not implement or register OAuth or make a provider OAuth-capable: the existing provider registration and `/login` flow must supply the credential in `auth.json`. Do not add it to a new provider as a way to enable OAuth. For a keyless local server, use the existing local-provider placeholder pattern.

Before finishing, inspect the diff/status for accidental secrets. Never print credential values while verifying; check only whether the reference resolves or whether an authenticated request succeeds.

## 3. Add the provider catalog

Match an existing provider with the same API shape. The catalog composes the four built-in streaming APIs — `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai` — so a catalog provider needs no code. Pie does not use pi's `custom-provider` extension mechanism (`pi.registerProvider`), which is a separate, code-based path for proxies, OAuth login flows, and custom streaming implementations; declaring a provider here must not create or depend on an extension.

A direct OpenAI-compatible provider typically looks like:

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
- Image-capable models declare `maxImagesPerRequest` (see step 1); keep it at the conservative policy maximum of 1.
- `overrideOnly: true` marks a user-authored partial override for a model whose full runtime definition comes from a provider or SDK catalog — for example the `openai-codex` OAuth catalog. Sync routes these entries to `providers.<p>.modelOverrides` in `models.json` instead of `models[]`, where the runtime merges the supported override fields with the built-in model. Override records are not limited to pricing or picker profiles: use supported metadata such as name, input/image policy, cost, context/output limits, reasoning/thinking maps, and compatibility when needed; source-only `eligible`, `thinking`, and `disabledReason` fields still control picker/subagent policy.
- `concurrency` is an intentional policy enforced by the host-side provider gate at runtime (read from the generated `models.json`): `maxConcurrentRequests` is the provider-wide cap, `afterburnSeconds` reserves a recently used slot for session affinity, and `queueWaitSeconds` bounds waiting. Choose the values deliberately for the provider's real rate limits and load profile instead of copying another provider's.
- Model identity is the pair `(provider, id)`: bare IDs must be unique within a provider, but the same bare ID may exist under several providers (provider-qualified identity).
- Add each new model identity exactly once to top-level `profileOrder` in the desired picker order, provider-qualifying with `{ provider, id }` whenever the bare ID exists under more than one provider.

For adding models to an existing provider, change only its `models` list and `profileOrder`; preserve its established auth, compatibility, and concurrency configuration unless the task explicitly changes them.

GitHub Copilot models are the one exception to hand-editing: the `copilot-model-discovery` extension reconciles the `github-copilot` provider against the signed-in account's model list (TTL-gated at session start; `/copilot-sync-models` forces a refresh). Auto-discovered Copilot models are full catalog entries in `github-copilot.models`, not `overrideOnly` records; discovery supplies their endpoint metadata and preserves the Pie-owned policy fields. Do not hand-edit endpoint metadata of auto-discovered Copilot models; newly discovered models are ineligible by default with an auto-discovery `disabledReason` until deliberately vetted, and models owned by other providers are never changed by the sync.

## 4. Sync and verify

Run from the repo root:

```bash
npm run sync-models
npm run sync-models -- --check
```

Run the focused model-config test through the root wrapper (never invoke `npx tsx` directly):

```bash
npm run test:file -- extension/test/integration/model-config-sync.test.ts
```

If `extension/src/` was changed for provider-specific runtime behavior, also run the required extension build:

```bash
cd extension
npm run build
```

Verify:

- generated config has no drift (`npm run sync-models -- --check`)
- the provider and models appear in `models.json` with the expected endpoint and metadata: full discovered Copilot models are under `models[]`, while only user-authored `overrideOnly` records are under `modelOverrides`
- `model-profiles.yaml` contains every new model in the intended order
- `analysis/model-pricing-history.json` mirrors the final catalog's pricing for retired entries
- `settings.json` retains user-owned defaults and contains no legacy provider routing block
- with auth configured, a minimal model request succeeds without exposing the key

## 5. Safety checklist

- [ ] Only `models.yaml` was edited as model configuration source
- [ ] No secret value appears in the diff, transcript output, or tracked files
- [ ] Provider endpoint and API type match the upstream protocol
- [ ] Model metadata came from authoritative documentation or was explicitly confirmed
- [ ] Every model ID appears exactly once in `profileOrder`
- [ ] Concurrency is provider-wide and intentionally chosen
- [ ] Image-capable models declare `maxImagesPerRequest`, kept at the policy maximum 1 unless provider documentation or measured evidence justifies more
- [ ] User-authored `overrideOnly` entries land in `modelOverrides` (not `models[]`); full discovered Copilot models remain in `models[]`
- [ ] `sync-models --check` passes
- [ ] Focused tests pass, and `extension/` was rebuilt if its source changed
