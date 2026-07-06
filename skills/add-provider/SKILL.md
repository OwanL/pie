---
name: add-provider
description: >-
  Add a new LLM provider to pie end-to-end (the models.yaml catalog + settings.json
  proxy routing + safe API-key storage + sync-models + proxy restart). Use when the
  user asks to add/register/wire up a new provider (e.g. OpenRouter, Groq, Together,
  Mistral, a custom OpenAI-compatible gateway), to route an existing API-key provider
  through the LiteLLM proxy, or to fix a "pending" provider that was added via the
  proxy settings UI but has no models yet. Also use when the user pastes an API key +
  endpoint and wants it working in pie.
---

# Add a Provider

This skill wires a new LLM provider into pie so its models appear in the model picker
and route through the local LiteLLM proxy with a per-provider concurrency cap. It
covers the **full end-to-end** process — including the parts the proxy-settings
"Add provider" form does NOT do (the `models.yaml` catalog + `profileOrder` +
populating `modelListOrder`).

## The two sources of truth (do not conflate)

pie splits provider config across two files. Both must agree, or `sync-models` throws:

| Concern | File | Key | Fields |
|---|---|---|---|
| **Model catalog** (what models exist, their context windows, pricing, profiles) | `models.yaml` (repo root) | `providers.<name>` | `baseUrl`, `api`, `apiKey`, `compat`, `models[]` |
| **Proxy routing** (how the LiteLLM gateway routes + concurrency + which models are exposed) | `settings.json` | `proxy.providers.<name>` | `apiBase`, `apiKeyEnv`, `litellmProvider`, `maxConcurrentRequests`, `litellmModelInfoId`, `modelListOrder`, `alias` |
| **Profile ordering** (display/ranking order in the picker) | `models.yaml` | `profileOrder` (top-level list) | every model `id` must appear once |

`npm run sync-models` regenerates the derived files (`models.json`,
`model-profiles.yaml`, `proxy/litellm_config.yaml`, and the model fields of
`settings.json`) from `models.yaml` + the `settings.json` `proxy` block. **Never
edit the derived files directly.** `sync-models` validates that every
`proxy.providers.<name>` exists in `models.yaml` and that `modelListOrder` matches
the catalog — a mismatch throws.

## What the UI form already does (don't redo it)

The proxy settings menu's **"Add provider"** form (Proxy tab → "Add provider")
handles the deterministic routing half for you:

- derives `apiKeyEnv` = `<NAME>_API_KEY` and stores the key safely in `proxy/.env`
  (gitignored) + `process.env`
- writes a **pending** `proxy.providers.<name>` entry to `settings.json` (empty
  `modelListOrder`, `litellmModelInfoId` = `<name>-shared`)
- runs `sync-models` (which tolerates the pending provider — it has no catalog
  entry yet, so it contributes no routes) and restarts the proxy.

A provider added only via the form is **pending**: it routes nothing and shows no
models until its `models.yaml` catalog entry + `profileOrder` + `modelListOrder` are
added. **Finishing a pending provider (or adding one fully by hand) is this skill's
job.** If the user already used the form, skip to [Step 4](#step-4--add-the-modelsyaml-catalog).

## Step 0 — Ask for missing information FIRST

Before touching files, collect what you need. **Do not guess model names, context
windows, or pricing.** Ask the user (use the `ask_user` tool) for anything missing:

- **Provider name** — lowercase, `[a-z][a-z0-9_-]*`, 1–63 chars (e.g. `openrouter`).
  Used as the key in both files.
- **API base URL** — e.g. `https://openrouter.ai/api/v1`. Must be http(s).
- **API key** — the secret. (If the form was used, it's already in `proxy/.env`.)
- **LiteLLM provider type** — `openai` for OpenAI-compatible endpoints (most common:
  OpenRouter, Groq, Together, Mistral, local vLLM, Ollama's OpenAI shim), or
  `anthropic`, `azure`, `gemini`, `mistral`, `cohere`, etc. See
  https://docs.litellm.ai/docs/providers.
- **The model list** — strongly prefer fetching it. **Ask the user for a model-list
  URL** (most OpenAI-compatible providers expose `GET <apiBase>/models`):
  ```bash
  curl -sS -H "Authorization: Bearer $<NAME>_API_KEY" "<apiBase>/models" | head -c 4000
  ```
  The response is usually `{ "data": [{ "id": "..." }, ...] }`. If the provider has
  no list endpoint, ask the user to paste the model ids they want to expose.
- **Context window per model** (for `contextWindow`) — ask if not in the list
  response; default conservatively if the user is unsure, but say so.
- **Max concurrency** — the provider's concurrent-request/account limit (default 4).
  Only raise if the user's tier allows it; this is the real backpressure cap.
- **Pricing** (optional) — `pricing: { input, output, cacheRead, cacheWrite }` in
  USD per million tokens. Skip if unknown; `costRank` can be set later.

Tell the user exactly what you have and what you're missing. Re-ask rather than
assume.

## Step 1 — Store the API key safely

Keys live in **`proxy/.env`** (gitignored — see root `.gitignore`: `.env`, `.env.*`,
`*.env`), referenced by an env var. **Never** paste a key into `models.yaml`,
`settings.json`, a commit, or chat output.

```bash
# Append/update the var in proxy/.env (create the file if absent).
grep -q '^<NAME>_API_KEY=' proxy/.env 2>/dev/null \
  && sed -i 's|^<NAME>_API_KEY=.*|<NAME>_API_KEY=<the-key>|' proxy/.env \
  || echo '<NAME>_API_KEY=<the-key>' >> proxy/.env
```

`<NAME>` is the uppercased provider name (`openrouter` → `OPENROUTER_API_KEY`).
The pie extension loads `proxy/.env` into `process.env` before spawning the proxy
(without overriding OS-installed vars), so the LiteLLM gateway inherits the key via
`api_key: os.environ/<NAME>_API_KEY`. Verify it's ignored: `git check-ignore proxy/.env`
should print `proxy/.env`.

## Step 2 — Pick the LiteLLM provider type

`litellmProvider` determines how LiteLLM shapes requests to the upstream. Use
`openai` for any OpenAI-compatible `/chat/completions` endpoint. For others, check
https://docs.litellm.ai/docs/providers and the existing `models.yaml` providers for
the `api:` value (e.g. `openai-completions`, `anthropic`). The `api:` in
`models.yaml providers.<name>` (what the pie backend uses, direct or via proxy) and
`litellmProvider` in `settings.json proxy.providers.<name>` (what the proxy uses to
talk upstream) must be consistent with the endpoint.

## Step 3 — Confirm the `settings.json` proxy.providers entry

If the user used the UI form, a pending entry already exists:
```json
"openrouter": {
  "apiBase": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "litellmProvider": "openai",
  "maxConcurrentRequests": 4,
  "litellmModelInfoId": "openrouter-shared",
  "modelListOrder": [],
  "alias": {}
}
```
If adding fully by hand, create this entry now. `litellmModelInfoId` = `<name>-shared`
so every model variant shares ONE LiteLLM semaphore (account-wide concurrency cap,
not per-model). Leave `modelListOrder: []` until Step 4 populates it.

## Step 4 — Add the `models.yaml` catalog

Add a `providers.<name>` block to `models.yaml`. Mirror an existing provider's shape
(`umans` is a good OpenAI-compatible example). Minimal fields:

```yaml
providers:
  openrouter:
    baseUrl: http://localhost:4000/v1   # the PROXY (127.0.0.1:proxyPort), not the upstream
    api: openai-completions
    apiKey: $OPENROUTER_API_KEY         # the LOCAL gate the proxy checks (see note)
    compat:
      supportsDeveloperRole: false
      supportsReasoningEffort: false
      supportsUsageInStreaming: true
      maxTokensField: max_tokens
    models:
      - id: openrouter-anthropic/claude-sonnet-5
        name: "OpenRouter: Claude Sonnet 5"
        contextWindow: 200000
      # ...one entry per model, in display order
```

**`baseUrl` points at the proxy** (`http://localhost:4000/v1` — the pie-managed
LiteLLM gateway), NOT the upstream. The proxy forwards to the upstream `apiBase`.
**`apiKey` is `$PIE_PROXY_MASTER_KEY`** (the pie-managed localhost gate the backend
sends to the proxy) — NOT the upstream key. The upstream key is sent by LiteLLM via
`api_key: os.environ/<NAME>_API_KEY` in `litellm_config.yaml`. (Look at the existing
`umans` provider in `models.yaml` + `proxy/litellm_config.yaml` to confirm the exact
convention; match it.)

Each model entry: `id` (unique across ALL providers), `name` (picker label),
`contextWindow` (tokens). Optional: `pricing` (→ `models.json` cost),
`costRank` (→ `model-profiles.yaml` cost), `eligible`/`thinking`/`disabledReason`,
`family`, `reasoning`, `maxTokens`, `thinkingLevelMap`, `overrideOnly`.

## Step 5 — Add model ids to `profileOrder`

Every model `id` must appear exactly once in the top-level `profileOrder` list in
`models.yaml`, or `sync-models` throws `model '...' missing from profileOrder`.
Append the new ids (order = picker display/ranking order; place cheaper/faster models
lower unless the user wants otherwise).

## Step 6 — Populate `proxy.providers.<name>.modelListOrder`

Set `modelListOrder` in `settings.json` `proxy.providers.<name>` to the model ids
(in the order they should be exposed through the proxy). Every catalog model id for
the provider must be in `modelListOrder` (or covered by an `alias`), and every
`modelListOrder` entry must be a catalog model id or an alias key — or `sync-models`
throws. `alias` (optional) maps a public name → a real model id (e.g.
`"openrouter-cheapest": "openrouter-anthropic/claude-haiku"`); alias keys must also
be in `modelListOrder`.

## Step 7 — Sync, validate, restart

```bash
npm run sync-models            # regenerate models.json, model-profiles.yaml, proxy/litellm_config.yaml, settings.json
node scripts/sync-models.mjs --check    # exit 0 = no drift
```

Then restart the proxy so the regenerated `litellm_config.yaml` loads (LiteLLM has no
`/reload`):

- If the pie extension is running and you edited `settings.json` `proxy` via the UI,
  it auto-restarts the proxy. For hand edits, **reload the VS Code window** (the
  extension re-spawns the proxy on activation), or from a terminal:
  ```bash
  npm run proxy:down && npm run proxy:bg   # or npm run proxy (foreground)
  npm run proxy:health                     # exit 0 = up
  ```

The pie extension fail-louds at startup if a proxied provider's `apiKeyEnv` isn't in
`process.env` — that's why Step 1 (proxy/.env) matters.

## Step 8 — Verify

- `node scripts/sync-models.mjs --check` exits 0 (no drift).
- The provider's models appear in the model picker (Proxy settings shows the
  provider group with `N models`).
- A trivial request through the proxy succeeds:
  ```bash
  curl -sS http://127.0.0.1:4000/v1/chat/completions \
    -H "Authorization: Bearer $PIE_PROXY_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"<name>-<first-model>","messages":[{"role":"user","content":"ping"}],"max_tokens":1}'
  ```
  (A 200 with content = the upstream key + routing work. A 401 = the upstream key
  isn't reaching the proxy — re-check `proxy/.env` + `apiKeyEnv`. A 404 = the model
  name isn't in `litellm_config.yaml` — re-check `modelListOrder` + sync.)

## Safety checklist (before declaring done)

- [ ] Key is **only** in `proxy/.env` (gitignored) — never in `models.yaml`,
      `settings.json`, or a commit.
- [ ] `git check-ignore proxy/.env` prints `proxy/.env`.
- [ ] `git status` shows no secrets staged.
- [ ] `sync-models --check` is clean.
- [ ] Proxy restarted + health 200 + a sample request returns 200.
- [ ] Every new model `id` is in `profileOrder` and in `modelListOrder`.

## Common pitfalls

- **`sync-models` throws "proxy.providers references unknown provider"** — the
  `proxy.providers.<name>` entry exists but `models.yaml providers.<name>` doesn't
  (or the names don't match exactly). Add the catalog entry (Step 4).
- **`sync-models` throws "model 'X' missing from proxy.providers.<n>.modelListOrder"**
  — a catalog model isn't exposed. Add it to `modelListOrder` (or an alias).
- **`sync-models` throws "modelListOrder has unknown entry 'X'"** — a `modelListOrder`
  entry isn't a catalog id or alias key. Fix the id or add the catalog model.
- **Proxy 401s every request to the new provider** — `apiKeyEnv` env var isn't set in
  the proxy's process. Confirm `proxy/.env` has it and reload the window (the
  extension loads `.env` into `process.env` on startup).
- **`baseUrl` set to the upstream instead of the proxy** — models.json `baseUrl` must
  be `http://localhost:<proxyPort>/v1`; the upstream URL goes in
  `proxy.providers.<name>.apiBase`.
- **Per-model concurrency instead of account-wide** — each model variant must share
  the same `litellmModelInfoId` (`<name>-shared`) so LiteLLM creates one semaphore.
