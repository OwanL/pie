// Browser-safe renderer summary model for tool-call cards.
//
// Canonical summary helpers are owned by
// `analytics/capture/tool-call-analysis/summary.ts`; this is the presentation
// model entry point for the transcript's tool-call card rendering, kept
// separate from the capture-side analysis entry point.
export {
  normalizeToolCallName,
  summarizeStringList,
  summarizeTaskEntries,
  summarizeUnknown,
  summarizeObject,
  summarizeSubagentToolCallInput,
  getSkillNameFromToolCall,
} from '../../../analytics/capture/tool-call-analysis/summary.js';