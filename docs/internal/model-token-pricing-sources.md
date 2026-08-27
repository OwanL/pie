# Model Token Pricing Evidence Ledger

**Purpose:** Authoritative traceability record for every price written to `models.json`.
Every non-zero cost field in `models.json` MUST have a corresponding row in this document.

**Retrieval date:** 2026-08-27 (GLM 5.3 Flash availability, metadata, and comparison rate); broader OpenAI, GitHub Copilot, and Ollama refresh completed 2026-08-24
**Format:** All prices in USD per 1M tokens unless otherwise noted.

---

## Methodology

For each model in `model-profiles.yaml`:
- **GitHub Copilot models**: Token pricing sourced from official GitHub Copilot billing documentation. 1 AI credit = $0.01 USD.
- **OpenAI Codex models**: Opportunity-cost rates sourced from the official [OpenAI model pricing](https://developers.openai.com/api/docs/models) pages. Codex is subscription-billed here, but these rates make its token use comparable with the other providers. Long-context tiers use OpenAI's published 272K threshold and request-wide multipliers; cache writes use the published 1.25x uncached-input rate.
- **Ollama Cloud models**: Availability, IDs, modalities, and served context windows come from Ollama's live cloud catalog and local `/api/show` manifests. Kimi K3 pricing is published directly by Ollama; other opportunity-cost rates come from the live [OpenRouter](https://openrouter.ai/api/v1/models) model API (`pricing.prompt` / `pricing.completion` / `pricing.input_cache_read`), converted from USD per token to USD per 1M tokens. These are comparison rates; Ollama bills individual plans through included usage and optional extra usage rather than charging every request at these rates.
- **Umans models**: No longer active. Umans ended its coding subscriptions; the last configured metadata remains only in `historicalModels` for past-session attribution.
- **Ollama Local models**: Free/local (no API cost).
- **Grok models**: No official token pricing found; marked as unknown.

Pi computes `usage.cost` client-side from the model catalog at turn completion; providers do not return an invoice amount in that field. Pie persists that value as `reportedCostUsd`, but reprices token-bearing usage from the current provider-qualified catalog so catalog corrections repair existing sessions as well as new ones. The stored value remains a fallback for unpriced models or cost-only records. Long-context tiers are applied to individual turn/request samples; multi-turn subagent aggregates use base rates because their per-request threshold crossings cannot be reconstructed. The UI therefore describes every dollar figure as an API-equivalent catalog estimate, not independently reconciled provider billing.

### Confidence levels

| Tag | Meaning |
|---|---|
| `official` | Published on provider's official pricing page |
| `official-inferred` | Derived from official data with documented formula |
| `openrouter` | Sourced live from the OpenRouter model pricing API (aggregates upstream provider rates) |
| `third-party` | From independent analysis or compute estimates (historical compute-estimate methodology) |
| `unknown` | No reliable pricing found |

---

## GitHub Copilot Models

Source: [GitHub Copilot models and pricing](https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing)
Conversion: 1 AI credit = $0.01 USD

### Anthropic (via Copilot)

| Model ID | Input | Cached Input | Cache Write | Output | Source Units | Confidence | Notes |
|---|---|---|---|---|---|---|---|
| claude-haiku-4.5 | $1.00 | $0.10 | $1.25 | $5.00 | USD/1M tokens | official | Copilot docs table |
| claude-sonnet-4.5 | $3.00 | $0.30 | $3.75 | $15.00 | USD/1M tokens | official | Copilot docs table |
| claude-sonnet-4.6 | $3.00 | $0.30 | $3.75 | $15.00 | USD/1M tokens | official | Same tier as sonnet-4.5 per Copilot docs |
| claude-sonnet-5 | $2.00 | $0.20 | $2.50 | $10.00 | USD/1M tokens | official | Promotional Copilot pricing through 2026-08-31 |
| claude-opus-4.6 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Copilot docs table |
| claude-opus-4.7 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Same tier as opus-4.6 per Copilot docs |
| claude-opus-4.8 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Copilot docs table |
| claude-opus-4.8-fast | $10.00 | $1.00 | $12.50 | $50.00 | USD/1M tokens | official | Copilot docs table |
| claude-opus-5 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Copilot docs table |
| claude-fable-5 | $10.00 | $1.00 | $12.50 | $50.00 | USD/1M tokens | official | Copilot docs table |

**Disabled/ineligible Copilot Anthropic models** (historical pricing):

| Model ID | Input | Cached Input | Cache Write | Output | Confidence | Notes |
|---|---|---|---|---|---|---|
| claude-opus-4.5 | $5.00 | $0.50 | $6.25 | $25.00 | official | Superseded |
| claude-sonnet-4 | $3.00 | $0.30 | $3.75 | $15.00 | official | Superseded |

### OpenAI (via Copilot)

| Model ID | Input | Cached Input | Cache Write | Output | Long-context Input | Long-context Cached | Long-context Cache Write | Long-context Output | Threshold | Confidence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| gpt-5-mini | $0.25 | $0.025 | $0 | $2.00 | — | — | — | — | — | official |
| gpt-5.3-codex | $1.75 | $0.175 | $0 | $14.00 | — | — | — | — | — | official |
| gpt-5.4 | $2.50 | $0.25 | $0 | $15.00 | $5.00 | $0.50 | $0 | $22.50 | >272K | official |
| gpt-5.4-mini | $0.75 | $0.075 | $0 | $4.50 | — | — | — | — | — | official |
| gpt-5.5 | $5.00 | $0.50 | $0 | $30.00 | $10.00 | $1.00 | $0 | $45.00 | >272K | official |
| gpt-5.6-luna | $0.20 | $0.02 | $0.25 | $1.20 | $0.40 | $0.04 | $0.50 | $1.80 | >200K | official |
| gpt-5.6-sol | $5.00 | $0.50 | $6.25 | $30.00 | $10.00 | $1.00 | $12.50 | $45.00 | >272K | official |
| gpt-5.6-terra | $2.00 | $0.20 | $2.50 | $12.00 | $4.00 | $0.40 | $5.00 | $18.00 | >272K | official |

**Disabled/ineligible Copilot OpenAI models** (historical pricing):

| Model ID | Input | Cached Input | Output | Confidence | Notes |
|---|---|---|---|---|---|
| gpt-5.1 | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex-max | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex-mini | $0.75 | $0.075 | $4.50 | official | Superseded |
| gpt-5 | $1.75 | $0.175 | $14.00 | official | Superseded |

GPT-5.6 Copilot models have published cache-write rates. Earlier Copilot OpenAI models retain `cacheWrite: 0` because GitHub lists cache write as not applicable.

### Google (via Copilot)

| Model ID | Input | Cached Input | Output | Source Units | Confidence | Notes |
|---|---|---|---|---|---|---|
| gemini-3-flash-preview | $0.50 | $0.05 | $3.00 | USD/1M tokens | official | Copilot docs table (Gemini 3 Flash) |
| gemini-3-pro-preview | $2.00 | $0.20 | $12.00 | USD/1M tokens | official | Copilot docs table (Gemini 3.1 Pro pricing; 3 Pro assumed same tier) |
| gemini-3.1-pro-preview | $2.00 | $0.20 | $12.00 | USD/1M tokens | official | Copilot docs table |

**Disabled/ineligible Copilot Google models**:

| Model ID | Input | Cached Input | Output | Confidence | Notes |
|---|---|---|---|---|---|
| gemini-2.5-pro | $1.25 | $0.125 | $10.00 | official | Superseded |

Cache write pricing is NOT published for Google Copilot models.

### Grok (via Copilot)

| Model ID | Input | Cached Input | Output | Confidence | Notes |
|---|---|---|---|---|---|
| grok-code-fast-1 | unknown | unknown | unknown | unknown | No public token pricing found. The cost:13 heuristic in model-profiles.yaml is a manual estimate. |

---

## OpenAI Codex Models

**Source:** [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
**Retrieval date:** 2026-08-24
**Units:** USD per 1M tokens.

The configured `openai-codex` provider uses a ChatGPT subscription, so these are opportunity-cost estimates rather than incremental charges to the subscription. All six built-in GPT models previously missing pie-side overrides are now represented; this lets the picker and session indicator resolve their pricing instead of reporting them as unpriced.

| Model ID | Input | Cached Input | Cache Write | Output | Long-context Input | Long-context Cached | Long-context Cache Write | Long-context Output | Confidence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00 | official |
| gpt-5.6-terra | $2.00 | $0.20 | $2.50 | $12.00 | $4.00 | $0.40 | $5.00 | $18.00 | official |
| gpt-5.6-luna | $0.20 | $0.02 | $0.25 | $1.20 | $0.40 | $0.04 | $0.50 | $1.80 | official |
| gpt-5.5 | $5.00 | $0.50 | $0 | $30.00 | $10.00 | $1.00 | $0 | $45.00 | official |
| gpt-5.4 | $2.50 | $0.25 | $0 | $15.00 | $5.00 | $0.50 | $0 | $22.50 | official |
| gpt-5.4-mini | $0.75 | $0.075 | $0 | $4.50 | — | — | — | — | official |
| gpt-5.3-codex-spark | $1.75 | $0.175 | $0 | $14.00 | — | — | — | — | official-inferred |

`gpt-5.3-codex-spark` has no published dollar rate (OpenAI labels it “Research preview”), so its row is a planning estimate inherited from `gpt-5.3-codex`, matching pi-ai's built-in model metadata. Long-context tiers apply above 272K input tokens for the GPT-5.4–5.6 models shown with tiers.

---

## Ollama Cloud Models

**Source:** [OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models) — live aggregator of upstream provider per-token rates.
**Retrieval date:** 2026-08-24 for the broader catalog; 2026-08-27 for GLM 5.3 Flash
**Confidence:** `official` for Kimi K3; `openrouter` for the remaining comparison rates
**Units:** USD per 1M tokens.

`cacheRead` is populated where the source exposes a cached-input rate. `cacheWrite` is `0` unless a separate per-token cache-write price is published.

| Model ID | Pricing source/model | Input | Output | Cache Read | Confidence | Ollama-served metadata |
|---|---|---:|---:|---:|---|---|
| kimi-k3:cloud | Ollama Kimi K3 page | $3.00 | $15.00 | $0.30 | official | 1M context; vision/tools/thinking; Pro/Max + extra usage |
| deepseek-v4-flash:0731-cloud | deepseek/deepseek-v4-flash-0731 | $0.140 | $0.280 | $0.028 | openrouter | 1M served context; tools; none/high/max thinking |
| deepseek-v4-pro:0813-cloud | deepseek/deepseek-v4-pro-0813 | $1.122 | $3.366 | $0.0374 | openrouter | 1M served context; tools; none/high/max thinking |
| deepseek-v4-pro:cloud | deepseek/deepseek-v4-pro | $0.526176 | $1.052352 | $0.043848 | openrouter | 1M catalog context; tools/thinking |
| deepseek-v4-flash:cloud | deepseek/deepseek-v4-flash | $0.0574 | $0.1148 | $0.01148 | openrouter | 1M served context; tools/thinking |
| gemini-3-flash-preview:cloud | google/gemini-3-flash-preview | $0.500 | $3.000 | $0.050 | openrouter | Cache write $0.083333/1M; 1M served context; vision/tools/thinking |
| gemma4:31b-cloud | google/gemma-4-31b-it | $0.100 | $0.340 | $0.100 | openrouter | 256K context; vision/tools/thinking |
| glm-5.3-flash:cloud | z-ai/glm-5.3-flash | $0.075 | $0.250 | $0.015 | openrouter | 1M served context; 128K max output; vision/tools; low/high/max thinking |
| glm-5.2:cloud | z-ai/glm-5.2 | $0.966 | $3.036 | $0.1932 | openrouter | 1M context; tools/thinking |
| glm-5.1:cloud | z-ai/glm-5.1 | $0.966 | $3.036 | $0.1794 | openrouter | 198K context; tools/thinking |
| gpt-oss:120b-cloud | openai/gpt-oss-120b | $0.037 | $0.170 | — | openrouter | 128K context; tools/thinking |
| gpt-oss:20b-cloud | openai/gpt-oss-20b | $0.030 | $0.130 | $0.030 | openrouter | 128K context; tools/thinking; picker-ineligible |
| kimi-k2.6:cloud | moonshotai/kimi-k2.6 | $0.950 | $4.000 | $0.160 | openrouter | 256K context; vision/tools/thinking |
| kimi-k2.7-code:cloud | moonshotai/kimi-k2.7-code | $0.670 | $3.400 | $0.170 | openrouter | 256K context; vision/tools/thinking |
| minimax-m2.7:cloud | minimax/minimax-m2.7 | $0.240 | $0.960 | $0.048 | openrouter | 192K served context; tools/thinking |
| minimax-m3:cloud | minimax/minimax-m3 | $0.300 | $1.200 | $0.060 | openrouter | 512K served context; vision/tools/thinking |
| mistral-large-3:675b-cloud | mistralai/mistral-large-2512 | $0.500 | $1.500 | $0.050 | openrouter | 256K context; vision/tools; no thinking |
| nemotron-3-nano:30b-cloud | nvidia/nemotron-3-nano-30b-a3b | $0.050 | $0.200 | $0.030 | openrouter | 1M catalog context; tools/thinking |
| nemotron-3-super:cloud | nvidia/nemotron-3-super-120b-a12b | $0.085 | $0.400 | — | openrouter | 256K served context; tools/thinking |
| nemotron-3-ultra:cloud | nvidia/nemotron-3-ultra-550b-a55b | $0.600 | $3.600 | $0.200 | openrouter | 256K served context; tools/thinking |
| qwen3.5:397b-cloud | qwen/qwen3.5-397b-a17b | $0.500 | $3.600 | $0.300 | openrouter | 256K context; vision/tools/thinking |
| qwen3.5:cloud | qwen/qwen3.5-plus-02-15 | $0.260 | $1.560 | — | openrouter | 256K context; vision/tools/thinking |

Cache write is `$0` for active Ollama rows except `gemini-3-flash-preview:cloud`, whose OpenRouter source publishes `$0.0833333333333` per 1M tokens.

---

## Removed from Ollama Cloud (historical)

Models previously available on Ollama Cloud but no longer listed. Pricing retained for reference.

> Note: removed-model prices below are retained from the earlier compute-estimate methodology and were **not** refreshed via OpenRouter (these models are no longer billable). Current models use OpenRouter rates (see table above).

| Model ID | Input (est.) | Output (est.) | Active Params | Confidence | Notes |
|---|---|---|---|---|---|
| glm-4.7:cloud | $0.40 | $1.75 | 32B | openrouter | Retired 2026-07-15; use GLM 5.2 |
| glm-5:cloud | $0.60 | $1.92 | 32B | openrouter | Retired 2026-07-15; use GLM 5.2 |
| kimi-k2.5:cloud | $0.375 | $2.025 | 32B | openrouter | Retired 2026-07-31; use Kimi K2.6 |
| minimax-m2.1:cloud | $0.29 | $0.95 | unknown | openrouter | Retired 2026-07-15; use MiniMax M3 |
| minimax-m2.5:cloud | $0.15 | $0.90 | unknown | openrouter | Retired 2026-07-31; use MiniMax M2.7 |
| qwen3-coder-next:cloud | $0.11 | $0.80 | 3B | openrouter | Retired 2026-07-15; use Qwen 3.5 397B |
| qwen3-coder:480b-cloud | $0.22 | $1.80 | 35B | openrouter | Retired 2026-07-15; use Qwen 3.5 397B |
| deepseek-v3.2:cloud | $0.0617 | $0.0617 | 37B | third-party | Baseline anchor for Ollama cost scale; Removed from cloud 2026-06 |
| deepseek-v3.1:671b-cloud | $0.0617 | $0.0617 | 37B | third-party | Removed from cloud 2026-06 |
| cogito-2.1:671b-cloud | $0.0617 | $0.0617 | 37B | third-party | Same active params as deepseek-v3.x; Removed from cloud 2026-06 |
| gemma3:27b-cloud | $0.0450 | $0.0450 | 27B | third-party | Dense 27B; Removed from cloud 2026-06 |
| gemma3:12b-cloud | $0.0200 | $0.0200 | 12B | third-party | Dense 12B; Removed from cloud 2026-06 |
| gemma3:4b-cloud | $0.0067 | $0.0067 | 4B | third-party | Too small for agentic; Removed from cloud 2026-06 |
| rnj-1:8b-cloud | $0.0133 | $0.0133 | 8B | third-party | Too small for agentic; Removed from cloud 2026-06 |
| qwen3-next:80b-cloud | $0.0050 | $0.0050 | 3B | third-party | Very small active params; Removed from cloud 2026-06 |
| qwen3-vl:235b-cloud | $0.0367 | $0.0367 | 22B | third-party | VL-specialized; Removed from cloud 2026-06 |
| qwen3-vl:235b-instruct-cloud | $0.0367 | $0.0367 | 22B | third-party | Superseded/redundant; Removed from cloud 2026-06 |
| kimi-k2-thinking:cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Removed from cloud 2026-06 |
| kimi-k2:1t-cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Removed from cloud 2026-06 |
| glm-4.6:cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Removed from cloud 2026-06 |
| minimax-m2:cloud | $0.0167 | $0.0167 | 10B | third-party | Removed from cloud 2026-06 |
| devstral-2:123b-cloud | $0.2050 | $0.2050 | 123B | third-party | Dense 123B; Removed from cloud 2026-06 |
| devstral-small-2:24b-cloud | $0.0400 | $0.0400 | 24B | third-party | Dense 24B; Removed from cloud 2026-06 |
| ministral-3:14b-cloud | $0.0233 | $0.0233 | 14B | third-party | Dense 14B; Removed from cloud 2026-06 |
| ministral-3:8b-cloud | $0.0133 | $0.0133 | 8B | third-party | Removed from cloud 2026-06 |
| ministral-3:3b-cloud | $0.0050 | $0.0050 | 3B | third-party | Removed from cloud 2026-06 |

---

## Ollama Local Models

| Model ID | Input | Output | Cache Read | Cache Write | Confidence | Notes |
|---|---|---|---|---|---|---|
| mistral-7b-pi:latest | $0.00 | $0.00 | $0.00 | $0.00 | official | Runs locally; no API cost |
| llama3.2-3b-pi:latest | $0.00 | $0.00 | $0.00 | $0.00 | official | Runs locally; no API cost |
| gemma4-e2b-pi:latest | $0.00 | $0.00 | $0.00 | $0.00 | official | Runs locally; no API cost |

---

## Retired Umans Provider

Umans ended its coding subscriptions, so the provider and all picker profiles were removed on 2026-08-01. Its final model names, families, and prices remain in `models.yaml` under `historicalModels`; they are emitted only to `analysis/model-pricing-history.json` for past-session attribution.

---

## Gap Analysis

Models in `model-profiles.yaml` without pricing in this evidence document:

| Model ID | Reason |
|---|---|
| grok-code-fast-1 | No official token pricing published by GitHub Copilot; cost remains unavailable until a real token rate is published. |

No active Ollama Cloud model remains unpriced as of 2026-08-27. Kimi K3 uses Ollama's official rate; the remaining Ollama entries use current OpenRouter comparison rates.

---

## Source URLs

1. **GitHub Copilot models and pricing**: https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing
2. **GitHub Copilot model multipliers (annual plans)**: https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans
3. **OpenRouter model pricing API** (Ollama Cloud source): https://openrouter.ai/api/v1/models
4. **Ollama Cloud catalog**: https://ollama.com/search?c=cloud
5. **Ollama Cloud plans and usage**: https://ollama.com/pricing
6. **Ollama cloud/auth documentation**: https://docs.ollama.com/cloud and https://docs.ollama.com/api/authentication
7. **Retired Umans service** (historical only): https://umans.ai
8. Internal historical: `docs/internal/ollama-pro-cloud-models-ranked.md` (compute estimate methodology; superseded for live pricing by OpenRouter)
9. **OpenAI GPT-5.6 Sol**: https://developers.openai.com/api/docs/models/gpt-5.6-sol
10. **OpenAI GPT-5.6 Terra**: https://developers.openai.com/api/docs/models/gpt-5.6-terra
11. **OpenAI GPT-5.6 Luna**: https://developers.openai.com/api/docs/models/gpt-5.6-luna
12. **OpenAI ChatGPT/Codex rate card**: https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing

---

## Changelog

| Date | Change |
|---|---|
| 2026-06-01 | Initial evidence ledger created. Copilot pricing sourced from official docs. Ollama Cloud pricing from compute estimates in `ollama-pro-cloud-models-ranked.md`. |
| 2026-06-15 | Synced Ollama Cloud model list: added glm-5, kimi-k2.7-code, minimax-m2.1, minimax-m2.5; removed 21 models no longer on cloud page |
| 2026-06-17 | Added `glm-5.2:cloud` with compute-estimate pricing (active params estimated 40B pending official spec) |
| 2026-06-19 | **Ollama Cloud refresh to live API pricing.** Replaced stale compute-estimate cost blocks for all 22 compute-estimate Ollama Cloud models with live per-token rates from the OpenRouter model API (`/api/v1/models`), including cache-read where OpenRouter exposes it, and added the previously-missing `glm-5.2:cloud` price (`z-ai/glm-5.2`). Supersedes the 2026-06-04 Portkey snapshot (several Portkey values were stale or mis-mapped, e.g. `kimi-k2.7-code` had matched base `kimi-k2`, `minimax-m3` was 2× the live rate). Added the Umans section: twinned umans entries mirror their Ollama Cloud twin's OpenRouter rate as an opportunity-cost `cost` block (consistent with all other models); proprietary `umans-coder`/`flash`/`qwen3.6-35b-a3b` remain $0 (no public API twin). Cache captured via the shared `openai-completions` path. Newly-listed `umans-qwen3.6-35b-a3b` model + profile added. Copilot models unchanged (already official GitHub token pricing). |
| 2026-07-16 | Added official OpenAI opportunity-cost pricing and long-context tiers for all built-in `openai-codex` GPT-5.4–5.6 models, eliminating unpriced Codex sessions. Corrected GPT-5.6 Terra cache-write precision from $3.12 to the published $3.125. |
| 2026-07-27 | Added Claude Opus 5 and Claude Opus 4.8 Fast using token prices and long-context metadata returned by GitHub Copilot's official account-scoped `/models` endpoint. |
| 2026-08-01 | Removed the canceled Umans provider; synchronized Ollama's active cloud catalog and retirements; added Kimi K3, Nemotron 3 Nano 30B, Mistral Large 3, and DeepSeek V4 Flash 0731; refreshed live comparison rates and served capabilities/context limits; documented signed-in local-daemon auth. |
| 2026-08-24 | Refreshed official OpenAI and GitHub Copilot pricing. Applied the July 30 Terra/Luna reductions and August 21 Sol promotion to direct Codex comparison rates; corrected Copilot Sol, GPT-5 mini, and GPT-5.3-Codex rates; refreshed OpenRouter comparison prices for every active Ollama model and added missing DeepSeek V4 Pro 0813 evidence. Documented that persisted `usage.cost` is a catalog calculation, not an invoice amount, and changed Pie to reprice token-bearing records from the corrected catalog while retaining stored cost as the unpriced/cost-only fallback. |
| 2026-08-27 | Added Ollama Cloud GLM 5.3 Flash availability and served metadata from Ollama's catalog plus local `/api/show`; added current `z-ai/glm-5.3-flash` OpenRouter comparison rates. |
