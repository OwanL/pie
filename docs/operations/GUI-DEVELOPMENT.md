# Local GUI development

- Run `npm run watch` inside `application/hosts/vscode/` while working on the sidebar UI. It runs both Vite watchers and `tsc --watch`; pass `-- --skip-typecheck` only when a separate typecheck watcher is already running.
- The composer accepts pasted images and file drops when the selected model reports image support.
- Screenshot/image paste is wired at the panel level, so pasting anywhere in the Pie chat while it is focused attaches the image to the active composer.
- Changes to files under `application/frontend/` are rebuilt by Vite automatically. A complete immutable renderer generation is verified before selection, and the prior generation remains available for recovery.
- The running sidebar webview reloads itself after renderer publication, so same-protocol UI tweaks do not need a manual Reload Window cycle.
- Runtime staging, startup-loader selection, and one-time `extension:activate` setup for older installations are owned by the root [README](../../README.md#build-the-pie-vs-code-extension).

For the design goals and component map, see [UI design philosophy](../architecture/UI-DESIGN-PHILOSOPHY.md). Repository-wide workflow commands are in the root [README](../../README.md).
