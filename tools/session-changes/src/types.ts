/**
 * Parameter schema + shared types for the `session_changes` tool.
 *
 * Mirrors `session_review`'s one-tool/action-discriminated-union shape: a
 * single `session_changes` tool with `action: 'list' | 'diff'`. The two actions
 * are the same domain (session changes) and `diff` takes a `path` returned by
 * `list`. Types are defined locally (not imported from pie's protocol barrel)
 * so the extension stays decoupled from the host build — they mirror the JSON
 * shapes the tool reads from the session JSONL.
 */

export type SessionChangesAction = 'list' | 'diff';
export const MAX_DIFF_PATHS = 20;

/** A derived file change (mirrors pie's FileChangeEntry — re-typed locally to
 *  avoid coupling this extension to the host protocol barrel). */
export interface FileChange {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  toolCallId: string;
  messageId: string;
  description: string;
  timestamp: string;
  additions?: number;
  deletions?: number;
}

export interface SessionChangesParams {
  action: SessionChangesAction;
  /** Absolute path of a session JSONL file to review explicitly. When omitted,
   *  the tool uses the calling runtime session's current `getEntries()` list,
   *  including in-memory sessions; lightweight contexts without that API fall
   *  back to `ctx.sessionManager.getSessionFile()`. */
  sessionPath?: string;
  /** `diff`: required non-empty array of file paths to diff. Use `["path"]`
   *  for a single file. Paths are relative to the session cwd as the `list`
   *  manifest reports them. */
  path?: string[];
  /** `diff`: lines of surrounding diff context. Default `0` (changes-only);
   *  git still emits the enclosing function/section label in the `@@` hunk
   *  header, so semantic context is preserved. Raise it when surrounding
   *  unchanged lines are needed (or just `read` the file). */
  context?: number;
}

export const sessionChangesSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'diff'],
      description:
        "list: derive the set of files this session changed + per-file line churn as a compact TSV manifest. " +
        'diff: emit a minified unified diff (default context=0, changes-only) for one or more files from the manifest; `path` is required for this action.',
    },
    sessionPath: {
      type: 'string',
      description:
        'Explicit session JSONL path. When omitted, use the calling runtime session entries; lightweight contexts fall back to the active session file.',
    },
    path: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      maxItems: MAX_DIFF_PATHS,
      description: 'diff (required): array of file paths from the list manifest, relative to the session cwd. Pass ["path"] for a single file.',
    },
    context: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'diff: lines of surrounding diff context (default 0, changes-only; maximum 100). Raise when surrounding code is needed.',
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const;
