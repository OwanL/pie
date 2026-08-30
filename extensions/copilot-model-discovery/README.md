# Copilot catalog synchronization

Keeps pie's authoritative model catalog aligned with the models available to the signed-in GitHub Copilot account, without regenerating it on every session.

## Refresh policy

A bounded, cross-process TTL gates the expensive work. At session startup the extension checks a shared marker file (`.copilot-catalog-sync.json` in the agent directory, visible to every VS Code window). When a recent successful refresh already verified the catalog within the TTL (default 6 hours), startup skips the network fetch, reconciliation, and codegen entirely — each session's `ModelRegistry` already loads the current `models.json` at creation, so no live-registry reload is needed.

When the TTL has elapsed, a refresh runs:

1. asks pi's `ModelRegistry` for a refreshed Copilot OAuth token;
2. reads the account-specific `GET /models` endpoint;
3. keeps only selectable, enabled, tool-capable models;
4. reconciles `models.yaml`, adding new models and removing unavailable GitHub Copilot entries;
5. runs the existing `scripts/sync-models.mjs` generator; and
6. refreshes every participating live `ModelRegistry` from the regenerated `models.json`.

Concurrent session startups share one in-process refresh (single-flight), and a cross-process file lock serializes commits from multiple VS Code windows. After a successful sync (whether or not the catalog changed) the TTL marker is updated; a failed refresh is never cached, so the next session retries instead of leaving the process stuck on a stale catalog.

### Forced refresh

Run `/copilot-sync-models` to refresh now, bypassing the TTL gate — for example, right after gaining access to a new Copilot model.

## Catalog ownership

There is no dynamically registered second provider catalog. `models.yaml` remains the source of truth, while `models.json`, `model-profiles.yaml`, and model-owned settings are generated through the existing catalog pipeline.

Existing subagent eligibility decisions are retained for models that remain available. Newly discovered models default to ineligible with a review-required reason, but are immediately available in the normal chat model picker. Endpoint-provided protocol metadata, capabilities, thinking levels, and token pricing—including long-context tiers—are written into the catalog. Pie uses the endpoint's smaller `default` context limit as the effective model window and does not opt into Copilot's extended context variant. Models with no extended tier may fall back to their full capability limit; an extended-tier model without a valid default boundary rejects the refresh so the last known-good catalog remains intact. Long-context rates remain in the catalog so historical or anomalous over-threshold requests are still accounted for correctly.

Models owned by other providers are never changed or removed. Because model identity is `(provider, id)`, the same ID may exist under Copilot and another provider; reconciliation automatically provider-qualifies the corresponding `profileOrder` references.

## Failure handling

Network, authentication, parsing, validation, or generation failures leave the previous source and generated catalog in place and do not update the TTL marker, so the next session retries. An empty selectable-model response is treated as a failed refresh rather than erasing the Copilot catalog. Source and generated surfaces are never written when the catalog is unchanged.
