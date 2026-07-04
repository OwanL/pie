// Ambient stubs for the `@earendil-works/pi-*` peer packages.
//
// Provided by the pi runtime (globally installed via PI_CODING_AGENT_DIR) and
// NOT in this repo's node_modules, so tsc cannot resolve them. Declared here
// so this tsconfig's typecheck gate covers tool-result-pruner's INTERNAL types
// — its real purpose — without flagging drift against the evolving pi API
// surface. Mirrors skill-pruner / warm-bash / web-access-compat.
//
// The event/result/content shapes below are precise (not `any`) because they
// are the contract the pipeline depends on, and they are stable (verified
// against `dist/core/extensions/types.d.ts` at the time of writing). If pi
// changes them, update this file; the typecheck gate will not catch drift on
// its own. ExtensionAPI stays `any` to avoid coupling to the full API surface.
declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;

  export interface TextContent {
    type: "text";
    text: string;
  }
  export interface ImageContent {
    type: "image";
    [key: string]: unknown;
  }
  export type ToolContent = TextContent | ImageContent;

  export interface ToolResultEvent {
    type: "tool_result";
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
    content: ToolContent[];
    isError: boolean;
    details: unknown;
  }

  export interface ToolResultEventResult {
    content?: ToolContent[];
    details?: unknown;
    isError?: boolean;
  }
}