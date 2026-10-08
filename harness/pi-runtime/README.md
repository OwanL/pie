# Private Pi runtime artifact

The root `package.json`, `pnpm-workspace.yaml` and **single shared `pnpm-lock.yaml`** own the production graph, including all four Pi workspace packages. The former npm bridge manifest/lock and `--refresh-lock` route are retired. Source provenance and acceptance status belong to the [productization plan](../../docs/plans/PIE-PRODUCTIZATION.md).

The [runtime builder](../../scripts/build/pi-runtime.mjs) consumes **already compiled Pi workspace output**; it does not compile or mutate it. It requires current `harness/pi/.cache/build.json` evidence matching source, shared lock/toolchain inputs, Node and compiled bytes. Build the workspace first, then select a new absolute directory beneath OS temporary storage:

```text
proto run node -- scripts/build/pi-workspace.mjs
proto run node -- scripts/build/pi-runtime.mjs --output <new-absolute-private-os-temp-directory>
```

The builder holds a development reader through confirmed teardown and runs the root production pnpm deploy using pinned `.prototools` and `.npmrc` settings (hoisted layout, lifecycle scripts disabled). It materializes deployed `node_modules` as independent ordinary files, omitting pnpm layout metadata and `.bin` shims, adding the Pi MIT license, and rejecting symlinks/shared hardlinks. The full deployed SDK, including compiled output, declarations, maps, docs/examples, assets and native prebuilds, is retained unchanged in `pi-tooling`; no second resolver or dependency graph is installed.

Current inputs include the Git-aware Pi source inventory, root manifest, shared lock, workspace configuration, toolchain configuration and Node target. The builder checks input stability and deployed compiled-byte identity before packing, then checks the unchanged tooling compiler outputs again. Runtime retains SDK JavaScript paths and required assets, removes declarations, and inlines only supported adjacent source maps. Unsupported maps remain external. The qualified Mistral 2.2.6 root graph is bundled behind its original seven-export ESM interface; unsupported package-context or dynamic-import graphs fail qualification.

Output contains `pi-runtime/{manifest.json,node_modules/,tooling-reference.json}`, `pi-tooling/{manifest.json,node_modules/}`, `build-evidence.json` and owned `work/` scratch; failed output is retained for diagnosis. The reference binds the complete tooling identity into runtime hashes. Startup verifies runtime files; typechecking acquires and fully verifies tooling before use, and publication verifies both roles. Legacy unsplit artifacts remain supported. Keeping the full SDK separately increases total package storage; this reduces startup file verification, not total package size. There is no SDK cache.

Credential-free, network-denied offline smoke checks cover public/private imports, cross-package Pi/TypeBox identity, themes, Photon WASM, current-target native helpers and the local CLI `--offline --version`. Run the CLI directly with Node at `pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`; no shim is required.

A clean shared-lock artifact and relocated host use have been qualified. Construction/offline smoke does **not** establish live-provider, browser or session-semantic parity, installation, publication, or permission to restart an installed host. See the root [development/delivery workflow](../../README.md#build-and-run-pie-from-source) and the plan for remaining acceptance limits.
