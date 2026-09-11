# web-access-guard

A load-time policy guard for the pinned managed `pi-web-access@0.27.0` and
`pi-mcp-adapter@2.20.1` Pi packages. It registers no tools of its own.

The guard resolves only `<PI_CODING_AGENT_DIR>/npm/node_modules/<package>` and
never searches or patches a global npm installation. It applies exact
fingerprint checked, atomic, idempotent transforms for the raw-results-only
web workflow and the `PIE_CACHE_DIR` cache targets:

- `pi-web-access`: `PIE_CACHE_DIR/web-search-cache`
- `pi-mcp-adapter`: `PIE_CACHE_DIR/mcp-cache.json` and `PIE_CACHE_DIR/mcp-npx-cache.json`

Readiness reports the managed package manifest, required source files, source
fingerprint (`pristine` or `supported-patched`), and intended cache target. It
fails closed for missing, malformed, wrong-version, or modified source, and
prints the exact `pi install` remediation. `npm run doctor` enforces readiness
as a prerequisite. The runtime factory remains best effort because Pi catches
factory errors; this guard does not claim to block Pi's own global fallback.

The guard preserves package configuration, credentials, onboarding state, the
Copilot catalog, and npm's ordinary `_npx` cache. It also repairs npm
`.DELETE.<hash>` artifacts only when no real file occupies the original name.

## Tests

```powershell
npm.cmd run test:all -- --package web-access-guard
```

Tests use isolated temporary package roots and do not access credentials,
network services, or global installs. The real pinned-tarball install/reinstall
qualification must run separately in a unique scratch root with an isolated
npm cache and `--ignore-scripts`.
