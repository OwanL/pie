// Ambient stubs for the `@mariozechner/pi-*` peer packages.
//
// These are provided by the pi runtime (globally installed via
// `@mariozechner/pi-coding-agent`); they are not in this repo's node_modules,
// so tsc cannot resolve them. Declare them as opaque modules (every export
// `any`) so the tsconfig typecheck gate covers web-access-guard's INTERNAL
// types (its real purpose) without flagging drift against the evolving pi API
// surface. Imports from these modules resolve to `any`.
declare module "@mariozechner/pi-coding-agent" {
  export type ExtensionAPI = any;
}
