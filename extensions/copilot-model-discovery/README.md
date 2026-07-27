# Copilot catalog synchronization

Keeps pie's authoritative model catalog aligned with the models available to the signed-in GitHub Copilot account.

At session startup, the extension:

1. asks pi's `ModelRegistry` for a refreshed Copilot OAuth token;
2. reads the account-specific `GET /models` endpoint;
3. keeps only selectable, enabled, tool-capable models;
4. reconciles `models.yaml`, adding new models and removing unavailable GitHub Copilot entries;
5. runs the existing `scripts/sync-models.mjs` generator; and
6. refreshes every participating live `ModelRegistry` from the regenerated `models.json`.

Concurrent session startups share one in-process refresh, and a cross-process file lock serializes commits from multiple VS Code windows. Failed refreshes are not cached: the next session retries instead of leaving the process permanently stuck on a stale catalog.

There is no dynamically registered second provider catalog. `models.yaml` remains the source of truth, while `models.json`, `model-profiles.yaml`, and model-owned settings are generated through the existing catalog pipeline.

Existing subagent eligibility decisions are retained for models that remain available. Newly discovered models default to ineligible with a review-required reason, but are immediately available in the normal chat model picker. Endpoint-provided protocol metadata, capabilities, context limits, thinking levels, and token pricing—including long-context tiers—are written into the catalog.

Models owned by other providers are never changed or removed. Because model identity is `(provider, id)`, the same ID may exist under Copilot and another provider; reconciliation automatically provider-qualifies the corresponding `profileOrder` references.

Network, authentication, parsing, validation, or generation failures leave the previous source and generated catalog in place. An empty selectable-model response is treated as a failed refresh rather than erasing the Copilot catalog.
