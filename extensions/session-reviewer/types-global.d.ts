// Ambient stub for the `@earendil-works/pi-*` peer package.
//
// Provided by the pi runtime (globally installed); not in this repo's
// node_modules, so tsc cannot resolve it. Declared opaque (every export `any`)
// so this extension's tsconfig typecheck gate covers its INTERNAL types
// (schema, store, transcript) — the real goal — without flagging drift against
// the evolving pi API surface. Mirrors skill-pruner's types-global.d.ts.
declare module '@earendil-works/pi-coding-agent' {
  export type ExtensionAPI = any;
}