# Pie tools

[`catalog/index.ts`](catalog/index.ts) is the explicit inventory of Pie-owned
model-callable names, implementation paths, registration owners, and context
eligibility. It is metadata-only: importing it does not initialize
desktop/browser runtimes or load the SDK. [`tool-names.ts`](catalog/tool-names.ts)
keeps shared stable names in one place. Schemas, descriptions, and prompt
guidance remain owned by each implementation.

## Layout

All nine Pie-owned tool implementations now live under this responsibility
tree:

- [`ask-user/`](ask-user/) — `ask_user`
- [`warm-bash/`](warm-bash/) — `bash`
- [`computer-use/`](computer-use/) — `computer`
- [`deferred-triggers/`](deferred-triggers/) — `defer_trigger`
- [`playwright/`](playwright/) — `playwright`
- [`request-capability/`](request-capability/) — `request_capability`
- [`session-changes/`](session-changes/) — `session_changes`
- [`session-control/`](session-control/) — `session_control`
- [`subagent/`](subagent/) — `subagent`

`request_capability` is a deliberately stateless implementation. Pruning
lifecycle state (hidden/loaded skills, pruned tools), policy, and recovery
telemetry remain owned by [`harness/tool-and-skill-selection`](../tool-and-skill-selection/)
and reach the tool through injected ports. The retained
`extensions/skill-pruner/index.ts` adapter constructs those ports from the
canonical selector modules, so there is exactly one lifecycle state and no
import cycle.

`session_control` remains backend-registered: its worker transport is injected
by the backend, while session management and IPC stay backend-owned. The
backend factory [`harness/agent-processes/coordinator/backend-tools.ts`](../../harness/agent-processes/coordinator/backend-tools.ts) assembles
backend-dependent definitions for primary runtimes and initial-context
inventory. Inventory has identical schemas/guidance but no operational
transport. In-memory subagents do not get `session_control` or
`defer_trigger`; their capability fence uses the same catalog. The owner-routed
test is under [`session-control/test/`](session-control/test/), and the
cross-owner catalog/SDK integration gate is under [`test/integration/`](../../test/integration/).

Package integrations have their own responsibility area:

- [`package-integrations/mcp/`](package-integrations/mcp/) — backend MCP config
  adapter, delegated to the pinned managed package.
- [`package-integrations/web-access/`](package-integrations/web-access/) —
  managed `pi-web-access` and `pi-mcp-adapter` load-time policy guard.

Their stable extension discovery shims remain under `extensions/`. The
web-access implementation does not register tools of its own. Native/browser
manifests, lockfiles, and installed dependencies remain under
`extensions/computer-use/` and `extensions/playwright/`; do not copy those
dependencies into the VSIX or move installation ownership as an incidental
consequence of relocation.

Middleware and policy also live beside their responsibility owners:

- [`../tool-and-skill-selection/`](../tool-and-skill-selection/) owns selector
  orchestration, state, prepass, and lifecycle.
- [`selection/tool-policy.ts`](selection/tool-policy.ts) owns tool selection.
- [`../agent-instructions/skill-selection/`](../agent-instructions/skill-selection/)
  owns skill-selection policy.
- [`../model-providers/authentication/`](../model-providers/authentication/)
  owns Copilot request-header authentication behavior.
- [`result-processing/`](result-processing/) and
  [`execution-safety/`](execution-safety/) own their middleware implementations.

Eligibility is not visibility. Agent allowlists, configuration, runtime
policy, and skill pruning still determine which eligible tools are active.
The catalog is not a replacement for the SDK runtime's active-tool catalog.

## Verification

Tests pin catalog entries, stable discovery-adapter identity, backend
primary/inventory parity, child exclusions, and exactly-once SDK registration.
The integration gate loads extension entries through the pinned SDK; it does
not execute desktop/browser tools or claim that external packages' dynamic
registrations are fixed by this catalog. Session-control and package-integration
behavior have focused owner suites and typecheck gates.

Preserve tool names, argument/result schemas, and execution behavior. Schema
redesign and broader visibility diagnostics are separate work.
