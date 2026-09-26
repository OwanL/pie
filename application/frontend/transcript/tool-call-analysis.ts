// Browser-safe renderer entry point for tool-call analysis presentation.
//
// The canonical tool-call analysis (capture-side classification and mutation
// deltas) is owned by `analytics/capture/tool-call-analysis/`; this module is
// the owner-specific entry point for transcript rendering so frontend code
// never imports the capture owner directly.
export {
  countTextLines,
  normalizeToolCallName,
  summarizeSubagentToolCallInput,
  summarizeStringList,
  summarizeTaskEntries,
  summarizeUnknown,
  summarizeObject,
  getSkillNameFromToolCall,
  getToolCallSizeHint,
  getFileExtensionFromToolCall,
  mergeFileMutationDelta,
  createEmptyFileMutationDelta,
  stripAnsiEscapes,
  extractExitCode,
} from '../../../analytics/capture/tool-call-analysis/index.js';
export { DIRECT_FILE_PATH_KEYS, GENERIC_PATH_KEYS } from '../../../analytics/capture/tool-call-analysis/mutation-tools.js';