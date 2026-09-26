# Local GUI development

- Run `npm run watch` inside `application/hosts/vscode/` while working on the sidebar UI. It runs both Vite watchers and `tsc --watch`; pass `-- --skip-typecheck` only when a separate typecheck watcher is already running.
- The composer accepts pasted images and file drops when the selected model reports image support.
- Screenshot/image paste is wired at the panel level, so pasting anywhere in the Pie chat while it is focused attaches the image to the active composer.
- Changes to files under `application/frontend/` are rebuilt by Vite automatically. A complete immutable renderer generation is verified before selection, and the prior generation remains available for recovery.
- The running sidebar webview reloads itself after renderer publication, so same-protocol UI tweaks do not need a manual Reload Window cycle.
- Ordinary `build` and `watch` stage complete immutable runtime generations without replacing loaded host/backend files. Restarting VS Code automatically loads the newest verified generation; opening the sidebar alone does not change the running host. Startup shows “Loading updated Pie build…” for a new selection, and an existing window shows “Pie update ready” without forcing a restart. Live renderer publication remains independent.
- Older installations need `npm run extension:activate` from the repository root once to install the startup loader, then a normal VS Code restart. The setup changes the next-start entrypoint without replacing locked running bundles or stopping sessions. Subsequent builds need no installation command. `npm run build:validate` remains compile-only; `npm run publish:renderer` publishes only renderer assets.

For the design goals and component map, see [UI design philosophy](../architecture/UI-DESIGN-PHILOSOPHY.md). Repository-wide workflow commands are in the root [README](../../README.md).
