// Ambient stubs for the `@earendil-works/pi-*` peer packages.
//
// These are provided by the pi runtime (globally installed via
// `@earendil-works/pi-coding-agent`); they are not in this repo's node_modules,
// so tsc cannot resolve them. Declare them as opaque modules (every export
// `any`) so the tsconfig typecheck gate covers skill-pruner's INTERNAL types
// (the real goal — e.g. the llm-scorer filter narrowing + stale
// PruningDecision fixtures that CI missed) without flagging drift against the
// evolving pi API surface. Imports from these modules resolve to `any`.
//
// Aligning skill-pruner's renderer/tool/registration types with the current
// pi API (pi-tui theme signature, pi-coding-agent AgentToolResult/CustomMessage)
// is tracked as a separate follow-up in TODO.md. When new named imports are
// adopted, add them here.
//
// NOTE: The packages were renamed from `@mariozechner/*` to
// `@earendil-works/*` (v0.80.x). Some hosts still expose a compatibility
// alias for the old names, but relying on it is fragile — all imports and
// these ambient declarations use the canonical new scope.
declare module "@earendil-works/pi-coding-agent" {
  export type Skill = any;
  export type ToolInfo = any;
  export type ExtensionAPI = any;
  export type BeforeAgentStartEvent = any;
  export type InputEvent = any;
  export type ToolCallEvent = any;
  export const formatSkillsForPrompt: any;
}
declare module "@earendil-works/pi-ai" {
  export const completeSimple: any;
}
declare module "@earendil-works/pi-tui" {
  export const Box: any;
  export const Text: any;
}
