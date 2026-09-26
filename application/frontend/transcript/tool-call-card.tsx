/** @jsxRuntime automatic */
/** @jsxImportSource preact */

// Behavior-preserving barrel: re-exports the public API previously defined
// inline in this file. Implementation lives in the co-located `tool-call-card/`
// folder. This file is kept (rather than replaced by a folder index) because
// several tests and modules import the explicit `tool-call-card.tsx` path.

export { formatToolCallResultForDisplay } from './tool-call-card/format';
export {
  TOOL_CALL_CLOSE_GRACE_MS,
  TOOL_CALL_CLOSE_TRANSITION_MS,
  TOOL_CALL_EXPAND_MS,
  TOOL_CALL_COMPLETION_PULSE_MS,
} from './tool-call-card/timing';
export type { ToolCallHeaderSummaryModel } from './tool-call-card/types';
export { ToolCallHeader } from './tool-call-card/tool-call-header';
export { ToolCallCard } from './tool-call-card/tool-call-card';
