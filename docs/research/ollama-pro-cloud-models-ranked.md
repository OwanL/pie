# Ollama Pro Cloud Models — Ranked by Parameter Size (Largest to Smallest)

> Sorted by total parameters. Source: `models.json` (pi-config).

> **Pricing update (2026-06-19):** All per-token costs below are sourced live from the [OpenRouter](https://openrouter.ai/api/v1/models) model API (`pricing.prompt` / `pricing.completion` / `pricing.input_cache_read`), converted to USD per 1M tokens. OpenRouter aggregates upstream provider rates (DeepSeek, Google, z-ai/GLM, Moonshot/Kimi, Alibaba/Qwen, MiniMax, NVIDIA, OpenAI); these are real billed rates. `cacheRead` is shown where OpenRouter exposes it. This supersedes the 2026-06-04 Portkey snapshot — several Portkey values were stale or mis-mapped (e.g. `kimi-k2.7-code` had matched base `kimi-k2` at $0.57/$2.30, and `minimax-m3` was 2× the live rate); `glm-5.2:cloud` is now priced (was TBD in the Portkey snapshot). The earlier H100 @ $3/hr compute-estimate methodology is preserved at the bottom of this document for historical reference only.

## Full Model List (23 models)

| Rank | Model ID | Display Name | Total Params | Active Params | Cost (USD / 1M tokens) — OpenRouter (2026-06-19) |
|------|----------|--------------|-------------:|-------------:|----------------------------------------:|
| 1 | deepseek-v4-pro:cloud | DeepSeek V4 Pro | 1.6T | 49B | $0.435 in / $0.870 out (cacheR $0.0036) |
| 2 | kimi-k2.6:cloud | Kimi K2.6 | 1.04T | 32B | $0.670 in / $3.500 out (cacheR $0.200) |
| 3 | kimi-k2.7-code:cloud | Kimi K2.7 Code | ~1T | 32B | $0.740 in / $3.500 out (cacheR $0.150) |
| 4 | kimi-k2.5:cloud | Kimi K2.5 | ~1T | 32B (est.) | $0.375 in / $2.025 out |
| 5 | glm-5.2:cloud | GLM 5.2 | 756B | 40B (est.) | $1.200 in / $3.200 out (cacheR $0.200) |
| 6 | glm-5.1:cloud | GLM 5.1 | 754B | 40B | $0.980 in / $3.080 out (cacheR $0.182) |
| 7 | glm-5:cloud | GLM 5 | 744B | 40B | $0.600 in / $1.920 out (cacheR $0.120) |
| 8 | nemotron-3-ultra:cloud | Nemotron 3 Ultra | 550B | 55B | $0.500 in / $2.200 out (cacheR $0.100) |
| 9 | qwen3-coder:480b-cloud | Qwen3 Coder 480B | 480B | 35B | $0.220 in / $1.800 out |
| 10 | minimax-m3:cloud | MiniMax M3 | 428B | 22B | $0.300 in / $1.200 out (cacheR $0.060) |
| 11 | qwen3.5:397b-cloud | Qwen 3.5 397B (A17B variant) | 397B | 17B | $0.385 in / $2.450 out |
| 12 | glm-4.7:cloud | GLM 4.7 | 355B | 32B | $0.400 in / $1.750 out (cacheR $0.080) |
| 13 | deepseek-v4-flash:cloud | DeepSeek V4 Flash | 284B | 13B | $0.090 in / $0.180 out (cacheR $0.020) |
| 14 | minimax-m2.7:cloud | MiniMax M2.7 | 230B | 10B | $0.250 in / $1.000 out (cacheR $0.050) |
| 15 | minimax-m2.5:cloud | MiniMax M2.5 | 230B | 10B | $0.150 in / $0.900 out (cacheR $0.050) |
| 16 | minimax-m2.1:cloud | MiniMax M2.1 | 230B | 10B | $0.290 in / $0.950 out (cacheR $0.030) |
| 17 | nemotron-3-super:cloud | Nemotron 3 Super | 120B | 12B | $0.090 in / $0.450 out |
| 18 | gpt-oss:120b-cloud | GPT OSS 120B | 120B | 120B | $0.039 in / $0.180 out |
| 19 | qwen3-coder-next:cloud | Qwen3 Coder Next | 80B | 3B | $0.110 in / $0.800 out (cacheR $0.070) |
| 20 | gemma4:31b-cloud | Gemma 4 31B | 31B | 31B | $0.120 in / $0.350 out (cacheR $0.090) |
| 21 | gpt-oss:20b-cloud | GPT OSS 20B | 20B | 20B | $0.029 in / $0.140 out |
| 22 | qwen3.5:cloud | Qwen 3.5 (default variants) | 397B | 35B / 27B / 9B / 4B / 2B / 0.8B | $0.260 in / $1.560 out |
| 23 | gemini-3-flash-preview:cloud | Gemini 3 Flash Preview | undisclosed | — | $0.500 in / $3.000 out (cacheR $0.050) |

**Key observation:** OpenRouter pricing is often asymmetric (input ≠ output) and reflects live upstream provider rates. Cache-read (`cacheR`) is shown where OpenRouter exposes `input_cache_read`; absent entries bill cache reads at the input rate or have no caching tier. `cacheWrite` is `$0` for all models — where upstreams charge for cache creation it is at the input rate (DeepSeek, Kimi) or billed per-hour for context caching (Gemini, GLM). These are real billed rates, not compute projections. The previously-TBD `glm-5.2:cloud` now has a live price ($1.20/$3.20, cacheR $0.20).

---

## Parameter Tiers

| Tier | Range | Count | Models |
|------|-------|------:|---------|
| Frontier | >600B | 7 | DeepSeek-V4-Pro, Kimi K2.6/K2.7-Code/K2.5, GLM-5.2/5.1/5 |
| Large | 200–600B | 10 | Nemotron-3-Ultra, Qwen3-Coder-480B, MiniMax-M3, Qwen-3.5-397B, GLM-4.7, DeepSeek-V4-Flash, MiniMax-M2.7/M2.5/M2.1, Qwen-3.5 (default) |
| Medium | 80–200B | 3 | Nemotron-3-Super, GPT-OSS-120B, Qwen3-Coder-Next |
| Compact | <40B | 2 | Gemma-4-31B, GPT-OSS-20B |
| Undisclosed | — | 1 | Gemini-3-Flash-Preview |

## Reasoning Models

These models support explicit reasoning/thinking modes:

- deepseek-v4-flash:cloud
- deepseek-v4-pro:cloud
- gemini-3-flash-preview:cloud
- gemma4:31b-cloud
- glm-4.7:cloud
- glm-5:cloud
- glm-5.1:cloud
- glm-5.2:cloud
- gpt-oss:120b-cloud
- gpt-oss:20b-cloud
- kimi-k2.5:cloud
- kimi-k2.6:cloud
- kimi-k2.7-code:cloud
- minimax-m2.5:cloud
- minimax-m2.7:cloud
- minimax-m3:cloud
- nemotron-3-super:cloud
- nemotron-3-ultra:cloud
- qwen3-coder:480b-cloud
- qwen3.5:397b-cloud
- qwen3.5:cloud

> **Note:** minimax-m2.1:cloud and qwen3-coder-next:cloud do **not** support thinking/reasoning mode.

## Multimodal Models (Vision)

Models that accept image input:

- gemini-3-flash-preview:cloud
- gemma4:31b-cloud
- kimi-k2.5:cloud
- kimi-k2.6:cloud
- kimi-k2.7-code:cloud
- minimax-m3:cloud
- qwen3.5:397b-cloud
- qwen3.5:cloud

---

## Historical: Compute Estimate Methodology *(superseded)*

The following methodology was used prior to 2026-06-04 when OpenRouter pricing was adopted, and later superseded by Portkey-AI/models in 2026-06-04. It is kept for reference and for any models not yet listed on OpenRouter (e.g., `devstral-small-2:24b-cloud`).

- Ollama Cloud measures usage primarily by GPU time (their docs). We convert model compute to an estimated GPU time and then to USD. These are compute-only estimates (no platform markup, networking, or request overhead).
- FLOPs per token (approx): 2 × active_parameters (this is a common inference approximation for decoder transformers; for MoE use activated params per token). Example: a 10B active model ≈ 20 GFLOPs / token.
- Baseline GPU and effective throughput (assumption): NVIDIA H100 (FP8 peak ≈ 3.958e15 FLOPS). Assume a conservative model FLOPS utilization (MFU) so effective sustained FLOPS ≈ 1.0e15 FLOPS (≈25% of peak). This is the dominant uncertainty.
- Baseline GPU price: $3.00 per GPU‑hour (market median / example). => $0.0008333333 per GPU‑second.
- Cost formula (used to produce the table):
  cost_per_1M_tokens = (1e6 tokens × 2 × active_params) / effective_FLOPS × (GPU_price_per_hour / 3600)
  With the baseline numbers above this simplifies to approximately:
  cost_per_1M_tokens (USD) ≈ active_params_in_billions / 600
- Rescaling notes:
  - To change the GPU price: multiply all costs by (new_GPU_hour_price / $3.00).
  - To change the effective FLOPS: multiply all costs by (1e15 / new_effective_FLOPS).
  - To move from a slower GPU, reduce effective_FLOPS accordingly (cost ∝ 1 / effective_FLOPS).

**Caveats:**
- These are lower‑bound, model‑compute-only estimates. Ollama Cloud may add platform margin, minimums, model‑load costs, caching effects, and billing rounding that increase the real billed amount.
- MoE models have extra routing/overhead and often benefit from batching; the "2 × active_params" rule is a simplification but gives a consistent relative comparison across models.
- Several table entries use estimated/rounded active‑param values where vendor docs are ambiguous; rows with "(est.)" are marked.

**Key sources used:** Ollama pricing/docs (usage measured by GPU time); model cards / Hugging Face pages and publisher docs for DeepSeek, Kimi, Qwen/Qwen3.5, NVIDIA Nemotron, GLM, MiniMax, Gemma families and other vendors (used to determine MoE vs dense and active‑param counts).