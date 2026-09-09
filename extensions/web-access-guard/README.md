# web-access-guard

A load-time policy, supported cache-seam adapter, and Windows self-heal
extension for `pi-web-access` and `pi-mcp-adapter`. It registers **no tools**
of its own. It enforces Pie's raw-results-only search workflow, routes the
rebuildable package caches into `PIE_CACHE_DIR`, and repairs a known npm
corruption mode.

## Why it exists

`pi-web-access@0.27.0` loads natively under the pinned Pi 0.80.x runtime,
including its required `@earendil-works/pi-ai/compat` entrypoint. Upstream
nevertheless defaults `web_search` to an interactive curator that automatically
generates a second LLM summary. Pie deliberately avoids that hidden token spend
and returns the provider's cited answer directly, so this extension physically
clamps the workflow to `"none"`.

A separate Windows-specific problem can break loading: **npm `.DELETE`
corruption.** When npm cannot replace a file during install (e.g. a previous pi
process still held it open) it renames it to `<name>.DELETE.<hash>`; if the
replacement write also fails, the real file is left missing and `node_modules`
is corrupted, breaking load again.

## What it does

At extension-load time — and `pie/extensions/*` are discovered *before* package
entries, so this runs before `pi-web-access/index.ts` is loaded — it:

1. Locates only the active managed installs at
   `<PI_CODING_AGENT_DIR>/npm/node_modules/{pi-web-access,pi-mcp-adapter}`
   (mirroring Pi's `getManagedNpmInstallPath`). Stale global installs are
   deliberately ignored.
2. For exactly `pi-web-access@0.27.0` and `pi-mcp-adapter@2.20.1`, applies
   fingerprint-checked, atomic source transforms before package loading:
   `web-search-cache`, `mcp-cache.json`, and `mcp-npx-cache.json` follow the
   absolute internal `PIE_CACHE_DIR` seam. Configuration, credentials, the
   Copilot catalog, and npm's ordinary `_npx` cache retain their existing
   owners. A version/source drift fails closed and is logged.
3. **Hard-clamps `web_search`'s workflow to `"none"`** so the curator + LLM
   summary path can *never* execute — not via config default, not via `/curator`,
   not via a per-call `workflow: "summary-review"` / `"auto-summary"` override
   from the model. `resolveWorkflow` is rewritten to always return `"none"`
   (the single chokepoint: `shouldCurate = workflow === "summary-review"` and
   the `if (workflow === "auto-summary")` summary branch are both gated on its
   return, so `generateSummaryDraft` becomes unreachable), and the tool-schema
   `workflow` enum is reduced to `["none"]` so the model is never even offered
   summary options. This gives the user sole control over token spend.
4. Repairs `.DELETE.<hash>` corruption — renaming each artifact back to its
   original name only when no real file already occupies that name.

Everything is **idempotent and forward-compatible**: if a package rewrites
either workflow site, the corresponding source transform becomes a no-op. The
extension never throws — a failure here must not break the rest of extension
loading.

## Tests

From the repository root:

```bash
npm run test:all -- --package web-access-guard
```

Pure rewrite/strip/cache-seam helpers and the filesystem patch+repair logic are
covered against real temp-dir "packages" (no SDK, no LLM, no network).
