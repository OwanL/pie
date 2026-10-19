# Token estimate validation

## What was measured

Live requests on 2026-10-18 UTC used `openai-codex/gpt-6-astra` through `openai-codex-responses`. Requests contained synthetic prompts or public shipped tool schemas, never session history. No tools were executed. Input footprint is provider `input + cacheRead + cacheWrite`; identical-message controls remove message overhead. Savings compare paired full/pruned requests. Output was capped at 32 tokens, reasoning low, with no retries and a 60-second request timeout.

The original compact-JSON/cl100k estimator overestimated nested-schema savings by **66%** and multilingual savings by **62%**. Merely switching JSON to o200k fixed multilingual text but not schemas. Counting structural declarations without indentation and preserving descriptions/annotations improved schema agreement. The 12-token tool-block allowance follows the [OpenAI cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb), not a fitted percentage multiplier.

## Production estimator results

Measured incremental tool tokens (provider baseline removed):

| Public schema | Estimate | Provider | Absolute error |
|---|---:|---:|---:|
| read | 147 | 150 | 3 |
| write | 74 | 77 | 3 |
| edit | 201 | 204 | 3 |
| bash | 101 | 104 | 3 |
| ask_user | 176 | 181 | 5 |
| Remove write/edit/bash from the five-tool catalog | 340 | 337 | 3 |

Synthetic coverage includes multilingual text, 70 nested records, 150 deep branches, 18 tools, large enums, and depth-12 nesting. Frozen observed fixtures are checked against the **production estimator**, not a copied estimator. The test criterion is absolute error ≤16 tokens **or** relative error ≤10%; this is an engineering tolerance, not a provider guarantee. Small counts can have larger percentage errors while passing the absolute allowance. Some fixtures informed the final representation; the broad/deep and mixed fixtures also served as held-out checks during development.

**Known failure:** `wakeup_timer` uses unsupported schema combinations and retains the per-tool compact fallback: estimate **602**, provider **511** (17.8% over). This is explicitly not covered by the accuracy claim. Unknown models, other providers, unsupported schema forms, images, and full multi-turn requests remain unqualified. The initial indicator is the full pre-filter inventory, not a predicted outgoing request. Provider usage remains authoritative.

## Reproduce

Use a verified SDK artifact; no build or running-host restart is needed:

```sh
proto run node -- scripts/verification/token-estimate-provider-probe.mjs --run --sdk-node-modules "<verified pi-runtime>/node_modules"
proto run node -- scripts/verification/token-estimate-provider-probe.mjs --run --variants --sdk-node-modules "<verified pi-runtime>/node_modules"
proto run pnpm -- run test:file lib/test/request-token-estimate.test.ts lib/test/request-token-estimate-bundle.test.ts scripts/verification/token-estimate-synthetic-fixtures.test.mjs
```

The first live mode uses eight requests for shipped-schema comparisons; variants uses nine and includes the known wakeup fallback failure. The probe uses the configured default model and in-memory credentials, does not write settings/auth/session state, writes credential-free reports to the OS temp directory, and exits nonzero for unavailable usage or tolerance failures. A relocated bundle test verifies both tokenizers are actually packaged rather than silently reverting to character estimates.
