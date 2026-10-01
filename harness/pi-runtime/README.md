# Private Pi runtime dependency owner

This directory owns the **runtime** npm lock, not a second editable Pi source tree.
The pinned build-tool owner remains `harness/pi/package-lock.json`.

Do not run npm install/ci in this directory. Its `package.json` and four referenced
manifest-only tarballs are derived from the four upstream package manifests. The
builder generates tarballs in a private installation owner; they are not committed.
Only the resulting dependency manifest and lock are committed here.

From the repository root, use a **new absolute directory beneath the OS temporary
directory** for each invocation:

```text
node scripts/build/pi-runtime.mjs --output <new-private-temp-directory>
node scripts/build/pi-runtime.mjs --output <different-new-private-temp-directory> --refresh-lock
```

The first command snapshots current tracked/nonignored Pi source, including local
modifications, without copying mutable `dist` or `node_modules`. It installs the
upstream locked build dependencies privately with scripts/bin links disabled, then
runs the pinned compiler directly in tui → ai → agent → coding-agent order. It
never invokes model generators or the upstream build/check/prepare scripts.

The dedicated runtime lock installs exactly four local manifest-only Pi tarballs
plus integrity-pinned ordinary dependencies. The builder overlays compiled code,
required assets, documentation/examples, native TUI prebuilds and MIT notices, then
runs credential-free, network-denied smoke checks outside the checkout. Smoke
checks cover public/private imports, Pi/TypeBox resolution identity, themes,
Photon WASM, available TUI native helpers and the local CLI version command.

The result is `<output>/pi-runtime/{manifest.json,node_modules/}`. The shared
`scripts/lib/pi-runtime-artifact.mjs` produces and verifies its source/dependency/
platform provenance and payload hashes. Invoke the source-built CLI directly with
Node at `pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`;
installation creates no executable shims. This builder neither deploys nor changes
any live SDK, shared output, settings, data, or installed extension.

Use `--refresh-lock` **only** when sanitized source package metadata/dependencies
change. It preserves existing ordinary dependency pins when possible and updates
the derived owner manifest/lock; review both files. Changes to TypeScript code,
assets, or notices do not affect tarball integrity and do not require a lock refresh.
Do not hand-edit derived manifests or treat the upstream coding-agent shrinkwrap
as runtime authority. No upstream shrinkwrap or lifecycle scripts enter the four
materialized Pi package manifests. Ordinary dependency packages retain their
published metadata, but their install scripts are never executed.

Each explicit output owns its `work/` directory (source snapshot, private npm
configuration/cache/installations, smoke scripts), final artifact and
`build-evidence.json`. Failed work is retained for diagnosis. Remove only output
directories you own after their evidence is no longer needed. Successful smoke
checks establish construction/import parity, **not** session semantic parity or
permission to publish/restart a host. Runtime installation and integration into
Pie resolvers/distribution are separate work packages.
