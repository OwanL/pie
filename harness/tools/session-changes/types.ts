/** Session-attributed file discovery with optional current-Git inspection. */
export type SessionChangesAction = 'list' | 'diff';
export const MAX_DIFF_PATHS = 20;
export type { FileChangeEntry as FileChange } from '../../../lib/file-changes/types.js';

export interface SessionChangesParams {
  action: SessionChangesAction;
  sessionPath?: string;
  path?: string[];
  context?: number;
  /** Zero-based character offset returned by the previous page. Diff paging
   * requires exactly one file. Same arguments, unchanged evidence/working tree. */
  offset?: number;
}

export const sessionChangesSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string', enum: ['list', 'diff'],
      description: 'list: session-attributed files and cumulative input churn as TSV, including completed descendants. diff: current Git changes against HEAD, not session-only edits; `path` is required and restricted to the manifest.',
    },
    sessionPath: {
      type: 'string',
      description: 'Explicit persisted session JSONL path. Omit for current live entries, including in-memory sessions; lightweight contexts fall back to the active session file.',
    },
    path: {
      type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: MAX_DIFF_PATHS,
      description: 'diff (required): paths from list, relative to that session cwd. Use one path when continuing with offset.',
    },
    context: {
      type: 'integer', minimum: 0, maximum: 100,
      description: 'diff: surrounding unchanged lines (default 0, maximum 100). Keep unchanged when paging.',
    },
    offset: {
      type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
      description: 'Zero-based character offset from the previous page\'s continuation instruction (default 0). Applies to list output or one file\'s diff record. Output is recomputed; restart at 0 if evidence or files change.',
    },
  },
  required: ['action'], additionalProperties: false,
} as const;
