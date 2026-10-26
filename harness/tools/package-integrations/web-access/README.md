# web-access-guard

A load-time policy guard for the pinned managed `pi-web-access` and
`pi-mcp-adapter` Pi packages. It registers no tools of its own. The exact
version pins, required files, and `PIE_CACHE_DIR` cache targets are owned by
[`lib/managed-packages/managed-package-contract.mjs`](../../../../lib/managed-packages/managed-package-contract.mjs).

The default factory first checks for a managed payload relative to its actual
module directory using the shared read-only bundled-resource reader. A present
payload must validate or the factory throws; it never writes environment variables,
patches sources, repairs `.DELETE.*` files, or discovers legacy packages on this
route. No mutable agent-directory install participates in bundled validation.

Without a managed marker, the legacy source guard resolves only `<PI_CODING_AGENT_DIR>/npm/node_modules/<package>` and
never searches or patches a global npm installation. It applies exact
fingerprint checked, atomic, idempotent transforms for the raw-results-only
web workflow, the contract's cache targets, and deferred MCP script loading.
MCP tools and hooks still register eagerly. Only the script executor loads on
first use, with session ownership checked again after the import. Unsupported
or partially adapted entry sources are left unchanged.

Readiness reports the managed package manifest, required source files, source
fingerprint (`pristine` or `supported-patched`), and intended cache target. It
fails closed for missing, malformed, wrong-version, or modified source, and
prints the exact `pi install` remediation. `npm run doctor` enforces readiness
as a prerequisite. The legacy source route remains best effort; its never-throws behavior does
not apply to bundled validation. Pi may catch factory errors; this guard does
not claim to block Pi's own global fallback.

The guard preserves package configuration, credentials, onboarding state, the
Copilot catalog, and npm's ordinary `_npx` cache. It also repairs npm
`.DELETE.<hash>` artifacts — triggered only when `@mozilla/readability` fails
to load, and only in the managed `pi-web-access` package root and its exact
`@mozilla/readability` dependency directory — and only when no real file
occupies the original name.

## Tests

```powershell
npm.cmd run test:all -- --package web-access-guard
```

Tests use isolated temporary package roots and do not access credentials,
network services, or global installs. The real pinned-tarball install/reinstall
qualification must run separately in a unique scratch root with an isolated
npm cache and `--ignore-scripts`.

## Immutable preparation precursor

The explicit `verifyBundledManagedPackage(root, name)` export is load-only:
it rejects missing, corrupt or incompletely adapted bytes and never repairs
`.DELETE.*` artifacts or writes files. The default factory selects bundled validation by marker presence; only the
marker-absent source guard remains mutable.

`lib/managed-packages/prepare-managed-packages.mjs` copies explicitly owned,
exact-pinned package trees to a fresh private staging directory and applies the
same pure transforms used by the source guard before final read-only verification.
The caller owns sealing/hash inventory and cleanup of successful staging output.
This is not a complete deployable dependency closure: a future acquisition owner
must supply lock/integrity-bound materialized dependencies, including local
Readability and MCP worker/script dependencies, qualify resolution without
ancestor/global fallback, and bind that closure to delivery identity. No Pi SDK
manifest membership is implied and pins are unchanged.
