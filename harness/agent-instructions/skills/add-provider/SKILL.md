---
name: add-provider
description: Use when the user asks to connect a provider, add a custom endpoint, or make models available in Pie.
---

# Add a provider or model

Start with the installed application's supported workflow. Do not require a Pie checkout, edit source files, run generators, or request an API key in chat for ordinary setup.

## Installed Pie workflow

1. Use **Settings → Providers** in the running Pie version to add or edit a connection, select a supported protocol/authentication method, and connect it. The UI is the preferred path; available choices depend on the installed version and registered capabilities. Do not invent UI steps or imply every provider supports every authentication method.
2. For a custom endpoint, use the installed version's validated provider configuration YAML only when needed. On Windows the current default is `%LOCALAPPDATA%/pie/config/providers.yaml`; other platform defaults are not yet qualified. Follow that version's schema and preserve unrelated entries. Do not assume a source-checkout schema file describes another installed version.
3. Enter credentials only through the supported private authentication flow. Never ask the user to paste a key into chat, a command argument, YAML, settings, or a committed file. Pie keeps credentials separate from provider YAML. A configured connection or visible model does not prove entitlement or a successful request.
4. Refresh or discover models where supported; otherwise use the installed UI/configuration's supported manual model-ID path. Discovery, authentication and inference are distinct. Do not automatically sign in, send a paid test request, or enable models/routing policies. Explain likely network or billing effects before any explicitly requested connection test.
5. If the protocol or authentication capability is not offered by the running version, do not invent a YAML flag or claim that configuration can add it. Explain that it needs a qualified extension seam or Pie source implementation; load `develop-pie` only if source work is requested.

Settings → Providers is the management home; connection/authentication and model preferences are separate flows. Existing provider behavior and limitations are version-dependent. For Pie source claims, consult the owning provider-management contract (`docs/contracts/STATE_CONTRACT.md#provider-management-state` in the identified Pie source checkout) and implementation, not this bundled skill as authority.

## Pie contributor workflow (only when source changes are requested)

First identify the Pie source checkout and version. Follow its `AGENTS.md` and model configuration documentation. In the Pie source checkout, `models.yaml` is the catalog source; inspect that checkout's `models.schema.json` and nearest provider entry. The contributor generator procedure below is not an installed-user setup step.

Edit `models.yaml` and run the checkout's documented model sync command (currently `proto run pnpm -- run sync-models` from the source root). Do not hand-edit generated `models.json`, `model-profiles.yaml`, model-owned fields in `settings.json`, or `model-pricing-history.json`. Verify drift and the focused model-config test using that checkout's documented wrapper. Do not run source builds or tests for an installed setup request.

When adding catalog entries, use authoritative provider documentation for endpoint, API shape, model IDs, capabilities, limits and pricing; do not guess. Preserve established authentication, compatibility and concurrency configuration unless the source task changes them. `apiKey` in the catalog is a request-time reference, not a place to store secrets. The literal `oauth` is only a convention for an already OAuth-capable registered provider and does not enable OAuth; do not use it to add authentication support. Provider/model identity is `(provider, id)`; follow that checkout's schema and picker-order requirements.

For changes under Pie runtime source, consult [the develop-pie skill](../develop-pie/SKILL.md) and the source checkout's owning contracts. Never treat generated source configuration as installed-user configuration.
