# Pie tools

[`index.ts`](index.ts) is the explicit inventory of Pie-owned model-callable
names, implementation paths, registration owners, and context eligibility.
It is metadata-only: importing it must not initialize desktop/browser runtimes
or load the SDK. Schemas, descriptions, and prompt guidance stay in the actual
tool definitions, not duplicated in this catalog.

## Layout

Six catalog tools remain implemented under this tree. The `ask_user`,
`defer_trigger`, and `session_changes` implementations are under
[`harness/tools/`](../harness/tools/) behind the same root extension adapters;
these relocations are recorded in the B4 migration manifest.

- [`harness/tools/ask-user/`](../harness/tools/ask-user/) — `ask_user`
- [`warm-bash/`](warm-bash/) — `bash`
- [`computer-use/`](computer-use/) — `computer`
- [`harness/tools/deferred-triggers/`](../harness/tools/deferred-triggers/) — `defer_trigger`
- [`playwright/`](playwright/) — `playwright`
- [`request-capability/`](request-capability/) — `request_capability`
- [`harness/tools/session-changes/`](../harness/tools/session-changes/) — `session_changes`
- [`session-control/`](session-control/) — `session_control`
- [`subagent/`](subagent/) — `subagent`

`request_capability` is a deliberately stateless implementation
([`request-capability/index.ts`](request-capability/index.ts)): pruning
lifecycle state (hidden/loaded skills, pruned tools), pruning policy, and
recovery telemetry remain owned by the `skill-pruner` extension and reach the
tool through injected ports. The `extensions/skill-pruner` tools adapter
constructs those ports from its own single-owner modules, so there is exactly
one lifecycle state and no import cycle; pruning middleware itself stays in
`extensions/`.

`session_control` remains backend-registered: its worker transport is injected
by the backend, while session management and IPC stay backend-owned. Bridge and
inventory integration tests remain under `extension/test/`. The extension
project type-checks these imports; `tools/tsconfig.json` also preserves SDK
aliases for bundlers resolving source files outside `extension/`.

## Registration and dependency ownership

The SDK still discovers extension adapters under `extensions/`. Each moved
tool's `extensions/<id>/index.ts` is a one-line discovery shim re-exporting its
owner implementation (under `tools/` or `harness/tools/`), so extension IDs,
toggles, and registration hooks are unchanged and no second registration exists.
Middleware relocation is in progress: the tool-result pruner lives in
`harness/tools/result-processing/` and the safeguard implementation in
`harness/tools/execution-safety/`, each behind its retained `extensions/<id>`
adapter; skill pruning and image guarding remain in `extensions/`.

Dependency ownership also stays with the original extension directories:
`extensions/computer-use/` and `extensions/playwright/` keep their manifests,
committed lockfiles, and `node_modules`, so pinned native/runtime packages and
the Playwright Chromium install path are unchanged. Do not copy
native/browser dependencies into the VSIX or move installation ownership as an
incidental consequence of relocation. Minimal manifests under `tools/` preserve
the moved sources' ESM module scope without creating new dependency owners.

[`backend.ts`](backend.ts) assembles backend-dependent definitions for both
primary runtimes and initial-context inventory. Inventory has identical
schemas/guidance but no operational transport. In-memory subagents do not get
`session_control` or `defer_trigger`; their capability fence uses this catalog.

Eligibility is not visibility. Agent allowlists, configuration, runtime policy,
and skill pruning still determine which eligible tools are active. This catalog
is not a replacement for the SDK's runtime `getAllTools()`/active-tool catalog.

SDK, web-access, and MCP implementations remain package-owned. Their
integration entries identify default names and dynamic registration behavior;
source code is not copied into this tree.

## Verification status

Checks pin catalog entries, discovery-adapter identity, backend primary/inventory
parity, and child exclusions. The pinned SDK discovery test loads every catalog
extension entry through its real adapter and verifies exactly one registration
per expected tool. It does not execute desktop/browser tools or claim that
external packages' dynamic registrations are fixed by this catalog.

Preserve tool names, argument/result schemas, and execution behavior in this
tree. Schema redesign and broader visibility diagnostics are separate work.
The root tool tree follows Pie's existing external agent-directory source
arrangement; backend imports are bundled by the extension build.