import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import * as path from 'node:path';

import { sessionChangesSchema } from './src/types.js';
import type { SessionChangesParams, FileChange } from './src/types.js';
import { parseSessionFileChanges } from './src/session-jsonl.js';
import type { ParsedSession } from './src/session-jsonl.js';
import { renderList, renderDiffs } from './src/render.js';
import { computeFileDiff } from './src/diff.js';
import type { DiffOutput, DiffKind } from './src/diff.js';

/** Honor the host's per-extension toggle (PIE_EXTENSION_TOGGLES_JSON, keyed by
 *  extension id). Mirrors session-reviewer's isExtensionDisabledByToggle so the
 *  Settings → Extensions checkbox actually disables this tool at runtime. */
function isDisabledByToggle(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed['session-changes'] === false;
  } catch {
    return false;
  }
}

/** Minimal context shape the tool needs: the calling session's file path + cwd.
 *  (ExtensionContext exposes a ReadonlySessionManager with both.) */
interface ToolExecuteCtx {
  sessionManager: {
    getSessionFile(): string | undefined;
    getCwd?(): string;
  };
}

// Success results carry NO `details` object — per docs/SESSION-CHANGES-TOOL.md
// §4 ("No `details` object — every byte is review-relevant signal"), the
// manifest/diff text is the whole payload; truncation is signalled inline.
// (Errors keep a `details: { error }` for machine-readable diagnosis.)
function ok(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: false as const,
  };
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: `session_changes error: ${message}` }],
    details: { error: message },
    isError: true as const,
  };
}

/** Resolve a (possibly relative) manifest path against the session cwd. Falls
 *  back to the path itself when no cwd is available (mirrors FileDiffService's
 *  resolveFileChangePath fallback). */
function resolveAgainstCwd(relPath: string, cwd: string | undefined): string {
  if (path.isAbsolute(relPath)) return relPath;
  return cwd ? path.resolve(cwd, relPath) : relPath;
}

/** Find the manifest entry for a requested path: exact string match first, then
 *  a resolved-against-cwd match (so `src/x.ts` matches `./src/x.ts` or an
 *  absolute form). Returns undefined when the path isn't in the manifest
 *  (defaulting the caller to `modified`). */
function findManifestEntry(
  changes: FileChange[],
  relPath: string,
  cwd: string | undefined,
): FileChange | undefined {
  const exact = changes.find((c) => c.path === relPath);
  if (exact) return exact;
  const resolved = resolveAgainstCwd(relPath, cwd);
  return changes.find((c) => resolveAgainstCwd(c.path, cwd) === resolved);
}

/** Compute one file's diff, mapping the requested path to its manifest entry
 *  (kind + stats) and resolving it against the session cwd for git. */
async function diffOne(
  relPath: string,
  parsed: ParsedSession,
  context: number,
): Promise<DiffOutput> {
  const cwd = parsed.cwd;
  const entry = findManifestEntry(parsed.changes, relPath, cwd);
  const kind: DiffKind = entry?.kind ?? 'modified';
  return computeFileDiff({
    relPath: entry?.path ?? relPath,
    absPath: resolveAgainstCwd(entry?.path ?? relPath, cwd),
    kind,
    additions: entry?.additions,
    deletions: entry?.deletions,
    context,
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'session_changes',
    label: 'Session changes',
    description:
      'Inspect files changed by a pi session. `list` returns a compact manifest with line churn; `diff` returns minified unified diffs for selected manifest paths. Defaults to the calling session and includes subagent-attributed edits.',
    promptSnippet:
      'Inspect this session\'s changed-file manifest and focused diffs. Defaults to your own session.',
    promptGuidelines: [
      'Call `list` first, then `diff` with a `path` array from that manifest. Start with `context=0`; raise it or read the file when surrounding code is needed.',
      'Use the manifest to separate this session\'s work from unrelated checkout changes. Subagent-attributed edits are included.',
      'For created, untracked, non-git, or multi-commit files, the diff may be incomplete; read the current file when the result says so or the churn does not match.',
    ],
    parameters: sessionChangesSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ToolExecuteCtx,
    ) {
      if (isDisabledByToggle()) {
        return err('The session-changes extension is disabled. Enable it in Settings → Extensions to inspect session changes.');
      }
      const p = (params ?? {}) as SessionChangesParams;
      if (p.action !== 'list' && p.action !== 'diff') {
        return err(`action must be one of list | diff (got ${String(p.action)}).`);
      }

      const sessionPath = p.sessionPath || ctx?.sessionManager?.getSessionFile();
      if (!sessionPath) {
        return err('no sessionPath provided and no active session path available — pass sessionPath (a session JSONL file path).');
      }

      let parsed: ParsedSession;
      try {
        parsed = parseSessionFileChanges(sessionPath);
      } catch (e) {
        return err((e as Error).message);
      }

      if (p.action === 'list') {
        return ok(renderList(parsed.changes));
      }

      // action === 'diff'
      if (!p.path) {
        return err('diff requires path (an array of file paths from the list manifest, e.g. ["src/x.ts"]).');
      }
      const paths = p.path;
      if (paths.length === 0) {
        return err('diff requires a non-empty path array (e.g. ["src/x.ts"]).');
      }
      const context = typeof p.context === 'number' && p.context >= 0 ? p.context : 0;

      const results = await Promise.all(
        paths.map((rel) => diffOne(rel, parsed, context)),
      );
      return ok(renderDiffs(results));
    },
  });
}
