# Model Token Pricing Evidence Ledger

**Purpose:** Authoritative traceability record for every price written to `models.json`.
Every non-zero cost field in `models.json` MUST have a corresponding row in this document.

**Retrieval date:** 2026-07-27 (GitHub Copilot catalog refreshed from its official account-scoped `/models` endpoint; OpenAI Codex pricing refreshed 2026-07-16; Ollama Cloud rates last refreshed 2026-06-19 via OpenRouter)
**Format:** All prices in USD per 1M tokens unless otherwise noted.

---

## Methodology

For each model in `model-profiles.yaml`:
- **GitHub Copilot models**: Token pricing sourced from official GitHub Copilot billing documentation. 1 AI credit = $0.01 USD.
- **OpenAI Codex models**: Opportunity-cost rates sourced from the official [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) table. Codex is subscription-billed here, but these rates make its token use comparable with the other providers. Long-context tiers and the 272K threshold match OpenAI's catalog metadata bundled with pi-ai.
- **Ollama Cloud models**: Live per-token pricing from the [OpenRouter](https://openrouter.ai/api/v1/models) model API (`pricing.prompt` / `pricing.completion` / `pricing.input_cache_read`), converted from USD-per-token to USD per 1M tokens. OpenRouter aggregates upstream provider rates (DeepSeek, Google, z-ai/GLM, Moonshot/Kimi, Alibaba/Qwen, MiniMax, NVIDIA, OpenAI); these are real billed rates, not compute estimates. The earlier H100-@-$3/hr compute-estimate methodology is preserved in `ollama-pro-cloud-models-ranked.md` for historical reference only.
- **Umans models**: Subscription coding plans (`api.code.umans.ai`) — unlimited tokens for the plan holder, so the per-token cost billed to the user is $0. For the cost indicator, umans entries that share an underlying model with an Ollama Cloud twin mirror that twin's live OpenRouter API rate (opportunity-cost estimate, consistent with every other model's `cost` block); proprietary umans models with no public API twin remain $0. Cache usage is still captured for token accounting (see Umans section).
- **Ollama Local models**: Free/local (no API cost).
- **Grok models**: No official token pricing found; marked as unknown.

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
| claude-opus-4.6 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Copilot docs table |
| claude-opus-4.7 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Same tier as opus-4.6 per Copilot docs |
| claude-opus-4.8 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Copilot docs table |
| claude-opus-4.8-fast | $10.00 | $1.00 | $12.50 | $50.00 | USD/1M tokens | official | Account-scoped Copilot `/models` token prices, retrieved 2026-07-27 |
| claude-opus-5 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Account-scoped Copilot `/models` token prices, retrieved 2026-07-27 |

**Disabled/ineligible Copilot Anthropic models** (historical pricing):

| Model ID | Input | Cached Input | Cache Write | Output | Confidence | Notes |
|---|---|---|---|---|---|---|
| claude-opus-4.5 | $5.00 | $0.50 | $6.25 | $25.00 | official | Superseded |
| claude-sonnet-4 | $3.00 | $0.30 | $3.75 | $15.00 | official | Superseded |

### OpenAI (via Copilot)

| Model ID | Input | Cached Input | Output | Source Units | Confidence | Notes |
|---|---|---|---|---|---|---|
| gpt-4o | $2.50 | $0.25 | $10.00 | USD/1M tokens | official | Copilot docs table |
| gpt-4.1 | $2.00 | $0.50 | $8.00 | USD/1M tokens | official | Copilot docs table |
| gpt-5-mini | $0.25 | $0.025 | $2.00 | USD/1M tokens | official | Copilot docs table; free-tier included |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 | USD/1M tokens | official | Copilot docs table |
| gpt-5.2 | $1.75 | $0.175 | $14.00 | USD/1M tokens | official | Copilot docs table |
| gpt-5.2-codex | $1.75 | $0.175 | $14.00 | USD/1M tokens | official | Same as gpt-5.2 per docs |
| gpt-5.3-codex | $1.75 | $0.175 | $14.00 | USD/1M tokens | official | Copilot docs table |
| gpt-5.4 | $2.50 | $0.25 | $15.00 | USD/1M tokens | official | Copilot docs table |
| gpt-5.5 | $5.00 | $0.50 | $30.00 | USD/1M tokens | official | Copilot docs table |

**Disabled/ineligible Copilot OpenAI models** (historical pricing):

| Model ID | Input | Cached Input | Output | Confidence | Notes |
|---|---|---|---|---|---|
| gpt-5.1 | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex-max | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex-mini | $0.75 | $0.075 | $4.50 | official | Superseded |
| gpt-5 | $1.75 | $0.175 | $14.00 | official | Superseded |

Cache write pricing is NOT published for OpenAI Copilot models. Models default cacheWrite to 0 unless explicitly stated.

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
**Retrieval date:** 2026-07-16
**Units:** USD per 1M tokens.

The configured `openai-codex` provider uses a ChatGPT subscription, so these are opportunity-cost estimates rather than incremental charges to the subscription. All six built-in GPT models previously missing pie-side overrides are now represented; this lets the picker and session indicator resolve their pricing instead of reporting them as unpriced.

| Model ID | Input | Cached Input | Cache Write | Output | Long-context Input | Long-context Cached | Long-context Cache Write | Long-context Output | Confidence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| gpt-5.6-sol | $5.00 | $0.50 | $6.25 | $30.00 | $10.00 | $1.00 | $12.50 | $45.00 | official |
| gpt-5.6-terra | $2.50 | $0.25 | $3.125 | $15.00 | $5.00 | $0.50 | $6.25 | $22.50 | official |
| gpt-5.6-luna | $1.00 | $0.10 | $1.25 | $6.00 | $2.00 | $0.20 | $2.50 | $9.00 | official |
| gpt-5.5 | $5.00 | $0.50 | $0 | $30.00 | $10.00 | $1.00 | $0 | $45.00 | official |
| gpt-5.4 | $2.50 | $0.25 | $0 | $15.00 | $5.00 | $0.50 | $0 | $22.50 | official |
| gpt-5.4-mini | $0.75 | $0.075 | $0 | $4.50 | — | — | — | — | official |
| gpt-5.3-codex-spark | $1.75 | $0.175 | $0 | $14.00 | — | — | — | — | official-inferred |

`gpt-5.3-codex-spark` inherits the published `gpt-5.3-codex` rates from OpenAI's Codex pricing row, matching pi-ai's built-in model metadata. Long-context tiers apply above 272K input tokens.

---

## Ollama Cloud Models

**Source:** [OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models) — live aggregator of upstream provider per-token rates.
**Retrieval date:** 2026-06-19
**Confidence:** `openrouter`
**Units:** USD per 1M tokens.

Each Ollama Cloud model is mapped to its OpenRouter slug (e.g. `deepseek-v4-pro:cloud` → `deepseek/deepseek-v4-pro`). `cacheRead` is populated where OpenRouter exposes `input_cache_read`; `—` means the upstream provider does not publish a separate cache-read discount for that model (cache read billed at the input rate, or no caching tier). `cacheWrite` is `0` for every cloud model: where the upstream charges for cache creation it does so at the input rate (DeepSeek, Kimi) or bills context caching per-hour (Gemini, GLM) — neither is a per-token cache-write line item.

| Model ID | OpenRouter slug | Input | Output | Cache Read | Confidence | Notes |
|---|---|---|---|---|---|---|
| deepseek-v4-pro:cloud | deepseek/deepseek-v4-pro | $0.435 | $0.870 | $0.0036 | openrouter | 1.6T MoE, 49B active |
| deepseek-v4-flash:cloud | deepseek/deepseek-v4-flash | $0.090 | $0.180 | $0.020 | openrouter | 284B MoE, 13B active |
| gemini-3-flash-preview:cloud | google/gemini-3-flash-preview | $0.50 | $3.00 | $0.05 | openrouter | Closed-source; previously range-only, now live |
| gemma4:31b-cloud | google/gemma-4-31b-it | $0.120 | $0.350 | $0.090 | openrouter | Dense 31B |
| glm-4.7:cloud | z-ai/glm-4.7 | $0.400 | $1.750 | $0.080 | openrouter | 32B active |
| glm-5:cloud | z-ai/glm-5 | $0.600 | $1.920 | $0.120 | openrouter | 744B MoE; tools+thinking |
| glm-5.1:cloud | z-ai/glm-5.1 | $0.980 | $3.080 | $0.182 | openrouter | 754B MoE; current gen |
| glm-5.2:cloud | z-ai/glm-5.2 | $1.200 | $3.200 | $0.200 | openrouter | 756B MoE; newest gen (was TBD in the Portkey snapshot) |
| gpt-oss:120b-cloud | openai/gpt-oss-120b | $0.039 | $0.180 | — | openrouter | Dense 120B |
| gpt-oss:20b-cloud | openai/gpt-oss-20b | $0.029 | $0.140 | — | openrouter | Dense 20B |
| kimi-k2.5:cloud | moonshotai/kimi-k2.5 | $0.375 | $2.025 | — | openrouter | Earlier K2 gen |
| kimi-k2.6:cloud | moonshotai/kimi-k2.6 | $0.670 | $3.500 | $0.200 | openrouter | 1.04T MoE, 32B active |
| kimi-k2.7-code:cloud | moonshotai/kimi-k2.7-code | $0.740 | $3.500 | $0.150 | openrouter | Coding-focused K2 variant |
| minimax-m2.1:cloud | minimax/minimax-m2.1 | $0.290 | $0.950 | $0.030 | openrouter | Tools only (no thinking) |
| minimax-m2.5:cloud | minimax/minimax-m2.5 | $0.150 | $0.900 | $0.050 | openrouter | Tools+thinking |
| minimax-m2.7:cloud | minimax/minimax-m2.7 | $0.250 | $1.000 | $0.050 | openrouter | Current gen |
| minimax-m3:cloud | minimax/minimax-m3 | $0.300 | $1.200 | $0.060 | openrouter | 428B MoE, 22B active |
| nemotron-3-super:cloud | nvidia/nemotron-3-super-120b-a12b | $0.090 | $0.450 | — | openrouter | 120B MoE, 12B active |
| nemotron-3-ultra:cloud | nvidia/nemotron-3-ultra-550b-a55b | $0.500 | $2.200 | $0.100 | openrouter | 550B MoE, 55B active |
| qwen3-coder-next:cloud | qwen/qwen3-coder-next | $0.110 | $0.800 | $0.070 | openrouter | 80B, 3B active |
| qwen3.5:397b-cloud | qwen/qwen3.5-397b-a17b | $0.385 | $2.450 | — | openrouter | A17B variant |
| qwen3.5:cloud | qwen/qwen3.5-plus-02-15 | $0.260 | $1.560 | — | openrouter | Default Plus variant |
| qwen3-coder:480b-cloud | qwen/qwen3-coder | $0.220 | $1.800 | — | openrouter | 480B, 35B active; code-specialized |

Cache write: `$0` for all rows (see note above).

---

## Removed from Ollama Cloud (historical)

Models previously available on Ollama Cloud but no longer listed. Pricing retained for reference.

> Note: removed-model prices below are retained from the earlier compute-estimate methodology and were **not** refreshed via OpenRouter (these models are no longer billable). Current models use OpenRouter rates (see table above).

| Model ID | Input (est.) | Output (est.) | Active Params | Confidence | Notes |
|---|---|---|---|---|---|
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
| nemotron-3-nano:30b-cloud | $0.0500 | $0.0500 | 30B | third-party | Dense 30B; Removed from cloud 2026-06 |
| glm-4.6:cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Removed from cloud 2026-06 |
| minimax-m2:cloud | $0.0167 | $0.0167 | 10B | third-party | Removed from cloud 2026-06 |
| devstral-2:123b-cloud | $0.2050 | $0.2050 | 123B | third-party | Dense 123B; Removed from cloud 2026-06 |
| devstral-small-2:24b-cloud | $0.0400 | $0.0400 | 24B | third-party | Dense 24B; Removed from cloud 2026-06 |
| mistral-large-3:675b-cloud | $0.0683 | $0.0683 | 41B | third-party | 675B MoE; Removed from cloud 2026-06 |
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

## Umans Models (code by Umans)

**Provider:** `api.code.umans.ai` (OpenAI-compatible). Per [umans.ai](https://umans.ai), the service is
subscription-first: hosted Kimi K2.6/K2.7-Code, GLM 5.1/5.2, Qwen 3.6 35B-A3B, plus Umans-coder/flash,
offered as **coding plans with unlimited tokens** (Pro ~$17–20/mo). The configured `$UMANS_API_KEY` is a
plan key, so the per-token cost actually billed to the user is **$0**.

**`cost` block convention (opportunity-cost display).** Every other model's `cost` block holds the model's
public per-token API rate (Copilot token price, OpenRouter rate, or $0 for local) — not the provider's
billing arrangement. To keep the session cost indicator **consistent across all models**, umans entries
that share an underlying model with an Ollama Cloud twin **mirror that twin's live OpenRouter rate** as
their `cost`. The indicator then reflects the *opportunity cost* of the tokens used (what the equivalent
pay-per-token usage would cost), which is more useful for comparing models than the flat subscription.
Actual spend remains the fixed monthly plan fee.

A separate **per-token "service keys for teams"** tier exists but is not configured here; if a service key
is adopted, replace the mirrored rates with Umans's published per-token rates.

Cache usage is still captured for token accounting and the context-window indicator: Umans uses the same
`openai-completions` API path as Ollama, and the host usage parser (`extension/src/backend/transcript/content.ts`,
`usageFromMessage`) reads cache tokens from `prompt_tokens_details.cached_tokens` / `cache_read_input_tokens` /
`prompt_cache_hit_tokens` — the standard fields Kimi/GLM/Qwen return. No Umans-specific wiring is required.

| Model ID | Input | Output | Cache Read | Cache Write | Confidence | Source / Notes |
|---|---|---|---|---|---|---|
| umans-coder | $0.00 | $0.00 | $0.00 | $0.00 | official | Proprietary; no public API twin. Subscription $0 marginal. |
| umans-flash | $0.00 | $0.00 | $0.00 | $0.00 | official | Proprietary; no public API twin. Subscription $0 marginal. |
| umans-kimi-k2.6 | $0.67 | $3.50 | $0.20 | $0.00 | openrouter | Mirrors `kimi-k2.6:cloud` (`moonshotai/kimi-k2.6`) |
| umans-kimi-k2.7 | $0.74 | $3.50 | $0.15 | $0.00 | openrouter | Mirrors `kimi-k2.7-code:cloud` (`moonshotai/kimi-k2.7-code`) |
| umans-glm-5.1 | $0.98 | $3.08 | $0.182 | $0.00 | openrouter | Mirrors `glm-5.1:cloud` (`z-ai/glm-5.1`) |
| umans-glm-5.2 | $1.20 | $3.20 | $0.20 | $0.00 | openrouter | Mirrors `glm-5.2:cloud` (`z-ai/glm-5.2`) |
| umans-qwen3.6-35b-a3b | $0.00 | $0.00 | $0.00 | $0.00 | official | No Ollama Cloud twin. Subscription $0 marginal. |

---

## Gap Analysis

Models in `model-profiles.yaml` without pricing in this evidence document:

| Model ID | Reason |
|---|---|
| grok-code-fast-1 | No official token pricing published by GitHub Copilot; cost remains unavailable until a real token rate is published. |

No models remain at `unknown` confidence as of 2026-06-19:
- `gemini-3-flash-preview:cloud` — previously range-only; now priced via OpenRouter (`google/gemini-3-flash-preview`).
- `glm-5.2:cloud` — previously "TBD" in the Portkey snapshot; now priced via OpenRouter (`z-ai/glm-5.2`).
- Umans models — twinned entries mirror their Ollama Cloud twin's OpenRouter rate (opportunity-cost display); proprietary models (`umans-coder`, `umans-flash`, `umans-qwen3.6-35b-a3b`) remain $0 (no public API twin). See Umans section.

---

## Source URLs

1. **GitHub Copilot models and pricing**: https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing
2. **GitHub Copilot model multipliers (annual plans)**: https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans
3. **OpenRouter model pricing API** (Ollama Cloud source): https://openrouter.ai/api/v1/models
4. **Umans** (code by Umans; subscription + per-token service keys): https://umans.ai
5. **Ollama Cloud documentation**: https://ollama.com/ (pricing measured by GPU time)
6. Internal historical: `docs/internal/ollama-pro-cloud-models-ranked.md` (compute estimate methodology; superseded for live pricing by OpenRouter)

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
