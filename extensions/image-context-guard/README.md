# image-context-guard

Deterministic outgoing-image projection that bounds the image parts sent to a
provider request against the active model's configured `maxImagesPerRequest`.

This is a **request-safety** layer, distinct from the three context-lean layers
(history compaction, skill pruning, tool-result pruning — see `AGENTS.md`):
those reduce token cost; this prevents accumulated session images from reaching a
provider request limit. It is the only layer that sees the complete accumulated
message context immediately before each LLM call (initial user turns, follow-up
and steering turns, `read` images, `computer` screenshots, and in-process
subagent turns).

## Contract

The extension hooks the `context` event and, **non-destructively** (the deep
copy pi hands the handler, never durable session history):

1. **Computer newest-three bound (source-specific).** Reuses
   `computer-use`'s `projectComputerImageContext` helper so the latest
   observation always wins over stale captures. This is the first pass.
2. **Per-model total bound.** Traverses the resulting complete context
   newest-first and retains at most the active model's `maxImagesPerRequest`
   image parts, regardless of producer (user attachments, `read`, `computer`,
   custom tools, subagent turns).
3. **One aggregate notice.** Appends a bounded text notice to the outgoing
   projection describing any omission, the active model limit, and how to
   recover the omitted evidence.

One deterministic guard owns both passes so two independently ordered handlers
never enforce overlapping limits. The standalone `computer-use` `context`
registration is removed when this guard is installed; `computer-use`'s
projection helper is reused, not duplicated.

## Policy source

`maxImagesPerRequest` lives in `models.yaml` (single source of truth) and flows
to the generated `models.json` via `npm run sync-models`. Because the upstream
SDK `Model` type is not guaranteed to retain this pie-owned field, the guard
loads the policy from the generated provider-qualified catalog
(`models.json`), keyed by `(provider, id)` — never from incidental SDK
passthrough. `overrideOnly` entries surface in `models.json` as
`providers.<p>.modelOverrides` and are folded into the same provider-qualified
map.

`sync-models` validates that every image-capable model (including `overrideOnly`
entries that declare `input: [text, image]`) carries a positive integer
`maxImagesPerRequest`, and that text-only models declare none.

The initial catalog intentionally uses a conservative maximum of **one** for
all provider-qualified image declarations. Runtime/provider capability evidence
establishes that each declaration accepts one image, while the configured
provider gateways do not expose stronger provider-qualified batch-limit
evidence. Raise an entry above one only when provider documentation or a
measured acceptance record supports that exact value; never infer it from a
model family name.

## Fail-safe

A runtime image-capable model **absent from the generated policy** (for example a
newly discovered Copilot model before reconciliation writes its maximum) uses a
conservative fail-safe of **one image per request** and emits a diagnostic. It
never receives an unbounded image context. Image capability itself comes from the
runtime model's `input` (authoritative); only the *maximum* is loaded from the
catalog. If the context hook cannot resolve any active provider-qualified model,
it fails closed at zero images and emits an explicit unresolved-model notice.

## Notices

Notices exist only in the outgoing projection, never in durable session history,
so repeated requests do not accumulate synthetic notices. The notice distinguishes:

- **Text-only model** — all image parts omitted; an unsupported-input notice is
  appended (do not infer their contents).
- **Image-capable, configured, exceeded** — older excess images omitted newest-
  first; an image-budget notice reports the limit and omitted count.
- **Image-capable, absent from policy (fail-safe)** — bounded to one and a
  diagnostic announces the missing configuration.

## Model switching

The maximum is evaluated for the model serving the current request. Switching
models immediately reprojects the same durable history against the new maximum;
images omitted for one model are not permanently unavailable. No persistent
`(session, model)` consumption counter is needed — the durable transcript plus
the current provider-qualified model completely determine the projection.

## Toggle

Disable via `PIE_EXTENSION_TOGGLES_JSON { "image-context-guard": false }`, the
same global toggle `computer-use` / `tool-result-pruner` honor.

See `extensions/subagent/README.md` for the complementary hard
`modelRequirements.inputKinds=["image"]` delegation contract and
`docs/COMPUTER-USE.md` for the source-specific screenshot bound.
