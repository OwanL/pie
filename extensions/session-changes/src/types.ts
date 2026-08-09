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
  /** Absolute path of the session JSONL file. Defaults to the calling session
   *  via `ctx.sessionManager.getSessionFile()` — so "review my own changes"
   *  needs no param. Compaction appends (never deletes), so parsing the JSONL
   *  is non-lossy even after compaction. */
  sessionPath?: string;
  /** `diff`: one or more file paths to diff, as an array. Use `["path"]` for a
   *  single file. Paths are relative to the session cwd as the `list` manifest
   *  reports them. */
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
        'diff: emit a minified unified diff (default context=0, changes-only) for one or more files from the manifest.',
    },
    sessionPath: {
      type: 'string',
      description:
        'Absolute path of the session JSONL file. Defaults to the calling session, so reviewing your own changes needs no param.',
    },
    path: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: MAX_DIFF_PATHS,
      description: 'diff: array of file paths from the list manifest, relative to the session cwd. Pass ["path"] for a single file.',
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
