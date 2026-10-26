# Local GUI development

Use the root [README lifecycle](../../README.md#build-and-run-pie-from-source) for the pinned Proto commands and delivery boundary. `proto run pnpm -- build` compiles the host/backend and workspace Pi code into `application/hosts/vscode/out-dev`; `proto run pnpm -- dev` launches the isolated standalone host, and `proto run pnpm -- dev:vscode` launches an isolated VS Code development host. The launcher keeps persistent profile state separate from installed Pie and uses a distinct host coordinator.

- Run `proto run pnpm -- watch` for shared frontend renderer rebuilds. The development host reloads after a completed renderer build; this is not HMR.
- For a one-off renderer-only rebuild, use `proto run node -- scripts/build/build.mjs --renderer-only`. This leaves backend/Pi output untouched and is safe with active Pi readers; passing the flag through Moon's root `build` still selects its Pi prerequisite. Nothing is published.
- Backend or Pi changes require stopping the development host, rebuilding, then relaunching. A reader gate protects the compiled Pi workspace while a development host uses it; there are no Pi workspace snapshots.
- This workflow builds locally only. Ordinary build/watch never stages or publishes an installed extension. Delivery and publication are explicit separate paths documented in the root README.
- Integrated both-host, coverage-equivalence, and delivery acceptance remain pending; the existing legacy full-coverage gate is retained until equivalence is established.

For design goals and the component map, see [UI design philosophy](../architecture/UI-DESIGN-PHILOSOPHY.md). Repository-wide workflow commands are in the [root README](../../README.md).
