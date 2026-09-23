# Pie tools

[`index.ts`](index.ts) is the explicit inventory of Pie-owned model-callable
names, implementation paths, registration owners, and context eligibility.
It is metadata-only: importing it must not initialize desktop/browser runtimes
or load the SDK. Schemas, descriptions, and prompt guidance stay in the actual
tool definitions, not duplicated in this catalog.

## Current consolidation status

- `ask_user`: implementation, schema, guidance, and unit tests live in
  [`ask-user/`](ask-user/). `extensions/ask-user/index.ts` is only the SDK discovery
  adapter. Its existing extension ID, toggle, and registration hooks are retained.
- `session_control`: implementation lives in [`session-control/`](session-control/).
  Its worker transport is injected by the backend; session management and IPC
  remain backend-owned. Bridge/inventory integration tests remain under
  `extension/test/` for this first slice. The extension project type-checks these
  imports; `tools/tsconfig.json` also preserves its SDK aliases for bundlers
  resolving source files outside `extension/`.
- The other seven Pie-owned implementations remain at the paths explicitly
  recorded in the catalog. They will move here in subsequent slices. Do not
  infer consolidation is complete from the existence of this directory.

## Registration and availability

The SDK still discovers extension adapters under `extensions/`. Moving an
implementation does not create a second registration. Middleware such as
skill pruning and safeguards remains in `extensions/`.

[`backend.ts`](backend.ts) assembles backend-dependent definitions for both
primary runtimes and initial-context inventory. Inventory has identical
schemas/guidance but no operational transport. In-memory subagents do not get
`session_control` or `defer_trigger`; their capability fence uses this catalog.

Eligibility is not visibility. Agent allowlists, configuration, runtime policy,
and skill pruning still determine which eligible tools are active. This catalog
is not a replacement for the SDK's runtime `getAllTools()`/active-tool catalog.

SDK, web-access, and MCP implementations remain package-owned. Their integration
entries identify default names and dynamic registration behavior; source code
is not copied into this tree.

## Remaining migration steps

1. Move bash, computer, defer-trigger, playwright, session-changes, and subagent
   implementation/tests/configs here; preserve discovery IDs via thin adapters.
2. Extract request-capability from skill-pruner without moving pruning policy or
   duplicating its session-local lifecycle state.
3. Update each moved tool's imports, test/typecheck routing, dependency install
   paths, sidecar paths, and documentation in the same slice.
4. Add loading-path completeness checks for extension registrations, including
   real SDK discovery. Current checks pin catalog entries, moved discovery
   adapter identity, backend primary/inventory parity, and child exclusions;
   they do not yet prove every dynamically loaded extension matches the catalog.

Preserve tool names, argument/result schemas, and execution behavior during
moves. Schema redesign and broader visibility diagnostics are separate work.
The root tool tree follows Pie's existing external agent-directory source
arrangement; backend imports are bundled by the extension build. Do not copy
native/browser dependencies into the VSIX or change installation ownership as
an incidental consequence of relocation.
