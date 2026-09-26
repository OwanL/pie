// Opaque stubs for runtime-provided peers that are absent from node_modules.
// They keep this package's typecheck focused on internal types; add named
// exports as imports are adopted, using the canonical @earendil-works scope.
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
