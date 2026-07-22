// Ambient stubs for the `@earendil-works/pi-coding-agent` peer package.
//
// Provided by the pi runtime (globally installed via PI_CODING_AGENT_DIR) and
// NOT in this repo's node_modules, so tsc cannot resolve it. Declared opaque
// (every export `any`) so this tsconfig's typecheck gate covers warm-bash's
// INTERNAL types — its real purpose — without flagging drift against the
// evolving pi API surface. Mirrors skill-pruner / web-access-compat.
declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  export type BashOperations = any;
  export const createBashTool: any;
  export const createLocalBashOperations: any;
  export const getShellConfig: any;
  export const getAgentDir: any;
}