# Copilot catalog synchronization

Keeps pie's authoritative model catalog aligned with the models available to the signed-in GitHub Copilot account.

Once per pi process, at the first session startup, the extension:

1. asks pi's `ModelRegistry` for a refreshed Copilot OAuth token;
2. reads the account-specific `GET /models` endpoint;
3. keeps only selectable, enabled, tool-capable models;
4. reconciles `models.yaml`, adding new models and removing unavailable GitHub Copilot entries;
5. runs the existing `scripts/sync-models.mjs` generator; and
6. refreshes the live `ModelRegistry` from the regenerated `models.json`.

There is no dynamically registered second provider catalog. `models.yaml` remains the source of truth, while `models.json`, `model-profiles.yaml`, and model-owned settings are generated through the existing catalog pipeline.

Existing subagent eligibility decisions are retained for models that remain available. Newly discovered models default to ineligible with a review-required reason, but are immediately available in the normal chat model picker. Endpoint-provided protocol metadata, capabilities, context limits, thinking levels, and token pricing—including long-context tiers—are written into the catalog.

If an endpoint model ID is currently an override-only entry under another built-in provider, catalog ownership is transferred to Copilot to avoid duplicate source IDs; the other provider's SDK-built-in model remains available. A conflicting full custom model is never deleted and is reported as skipped.

Network, authentication, parsing, validation, or generation failures leave the previous source and generated catalog in place.
