# Viewer.js 1.15.2

Unmodified browser distribution of [Viewer.js](https://github.com/fengyuanchen/viewerjs), licensed under [MIT](LICENSE). The runtime, stylesheet and declarations are vendored so renderer-only builds do not require changing the Pi workspace dependency installation.

Source: https://registry.npmjs.org/viewerjs/-/viewerjs-1.15.2.tgz

Tarball integrity (SHA-512, base64):
`CYEqSFfPUSnmn1PjrhYxXOScaUC7n8+NpSqI+MrOSM8wcKPe35MlwQYwksuD5rjFkYv/ePmY5NsUa51uRNN2jA==`

Upstream files:
- `dist/viewer.esm.js` → `viewer.esm.js`
- `dist/viewer.css` → `viewer.css`
- `types/index.d.ts` → `viewerjs.d.ts`
- `LICENSE` → `LICENSE`

`viewer.esm.d.ts` is a local type-only bridge to the upstream ambient module declaration; the runtime and upstream declarations remain unchanged.

For updates, verify the published tarball integrity and replace these files together. Do not patch the library or override its viewer UI; application integration belongs in `transcript/image-viewer.tsx`.
