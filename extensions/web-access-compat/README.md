# web-access-compat

A load-time self-heal extension that makes the `pi-web-access` package actually
load under the host `@earendil-works/pi-coding-agent`. It registers **no tools**
of its own — it exists solely to unblock `pi-web-access`'s `web_search` /
`fetch_content` / `get_search_content` tools.

## Why it exists

`pi-web-access@0.13.0` (the latest release) imports the subpath
`@earendil-works/pi-ai/compat`. Two problems conspire to make that import — and
therefore the whole extension — fail to load, leaving the web tools as "ghosts"
(listed in `pruning.tools.alwaysKeep` but never registered):

1. **Version skew.** The host `@earendil-works/pi-ai` (bundled with
   `@earendil-works/pi-coding-agent` 0.74.x) dropped the `./compat` export; its
   symbols (`complete`, `StringEnum`, `getModel`, …) now live in the main entry.
   Worse, pi's extension loader aliases `@earendil-works/pi-ai` to a *file*
   (`dist/index.js`), so the subpath resolves to the invalid
   `dist/index.js/compat`. This fails on **every** machine, regardless of OS.

2. **npm `.DELETE` corruption (Windows).** When npm cannot replace a file during
   install (e.g. a previous pi process still held it open) it renames it to
   `<name>.DELETE.<hash>`; if the replacement write also fails, the real file is
   left missing and `node_modules` is corrupted, breaking load again.

## What it does

At extension-load time — and `pie/extensions/*` are discovered *before* package
entries, so this runs before `pi-web-access/index.ts` is loaded — it:

1. Locates the installed `pi-web-access` package with **no hardcoded paths**
   (queries `npm root -g` / `pnpm root -g`, mirroring pi's own
   `getGlobalNpmRoot`), so it works on every machine.
2. Rewrites every `@earendil-works/pi-ai/compat` import → `@earendil-works/pi-ai`.
   All runtime symbols pi-web-access needs already live in the main entry;
   `Model`/`Message` are type-only and erased, so this is behaviour-preserving.
3. Repairs `.DELETE.<hash>` corruption — renaming each artifact back to its
   original name only when no real file already occupies that name.
4. **Hard-clamps `web_search`'s workflow to `"none"`** so the curator + LLM
   summary path can *never* execute — not via config default, not via `/curator`,
   not via a per-call `workflow: "summary-review"` / `"auto-summary"` override
   from the model. `resolveWorkflow` is rewritten to always return `"none"`
   (the single chokepoint: `shouldCurate = workflow === "summary-review"` and
   the `if (workflow === "auto-summary")` summary branch are both gated on its
   return, so `generateSummaryDraft` becomes unreachable), and the tool-schema
   `workflow` enum is reduced to `["none"]` so the model is never even offered
   summary options. This gives the user sole control over token spend.

Everything is **idempotent and forward-compatible**: if `pi-web-access` drops the
`./compat` import upstream (or `pi-ai` re-adds the export), or rewrites either
workflow site, every step becomes a no-op. The extension never throws — a
failure here must not break the rest of extension loading.

## Tests

```bash
npm run test -- --package web-access-compat
```

Pure rewrite/strip helpers and the filesystem patch+repair logic are covered
against real temp-dir "packages" (no SDK, no LLM, no network).
