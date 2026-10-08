/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { normalizeToolCallName } from '../tool-call-summary-model';
import { isCommandSummaryTool } from './summary-model';

export function toolIconKind(name: string): string {
  const normalized = normalizeToolCallName(name);
  if (isCommandSummaryTool(name)) return 'command';
  if (['read', 'cat'].includes(normalized)) return 'read';
  if (['edit', 'write'].includes(normalized)) return normalized;
  if (['grep', 'find', 'glob', 'web_search'].includes(normalized)) return 'search';
  return 'tool';
}

/** Small, consistent line icons. Labels stay in the trigger's accessible name. */
export function ToolIcon({ kind }: { kind: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {kind === 'read' ? <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>
        : kind === 'command' ? <><path d="m4 6 6 6-6 6M13 18h7" /></>
        : kind === 'edit' ? <><path d="m14 4 6 6M4 20l5-1L21 7l-4-4L5 15Z" /></>
        : kind === 'write' ? <><path d="M14 3H5v18h14V8ZM14 3v5h5M8 13h8M8 17h6" /></>
        : kind === 'search' ? <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>
        : kind === 'raw' ? <><path d="M8 4H6v5l-2 3 2 3v5h2M16 4h2v5l2 3-2 3v5h-2M11 9l2 6" /></>
        : kind === 'open' ? <><path d="M14 4h6v6M20 4l-9 9M10 5H4v15h15v-6" /></>
        : <><path d="m8 5-6 7 6 7M16 5l6 7-6 7M14 4l-4 16" /></>}
    </svg>
  );
}
