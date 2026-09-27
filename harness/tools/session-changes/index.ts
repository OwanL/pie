import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import * as path from 'node:path';

import { MAX_DIFF_PATHS, sessionChangesSchema } from './types.js';
import type { SessionChangesParams, FileChange } from './types.js';
import { parseSessionEntriesChanges, parseSessionFileChanges } from './session-jsonl.js';
import type { ParsedSession, SessionEntryLike } from './session-jsonl.js';
import { renderList, renderDiffs } from './render.js';
import { computeFileDiff } from './diff.js';
import type { DiffOutput } from './diff.js';
import { canonicalFilePath } from '../../../lib/file-changes/file-path.js';

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

/** Minimal context shape the tool needs. The runtime API's getEntries()
 *  returns the current session entries (excluding its header); getCwd() supplies
 *  the cwd needed to resolve relative tool inputs. Optional members preserve the
 *  persisted-JSONL fallback used by lightweight test/integration contexts. */
const DIFF_CONCURRENCY = 4;

interface ToolExecuteCtx {
  cwd?: string;
  sessionManager?: {
    getEntries?(): SessionEntryLike[];
    getCwd?(): string;
    getHeader?(): { cwd?: string } | null;
    getSessionFile?(): string | undefined;
  };
}

// The manifest/diff text is the payload; paging instructions are inline.
// Errors also retain a machine-readable diagnostic.
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

/** Prefer the live runtime entry list for default self-review. SessionManager's
 *  getEntries() is intentionally used instead of getBranch()/buildContextEntries
 *  so the existing session-wide attribution semantics do not change. */
function parseRuntimeSessionChanges(ctx: ToolExecuteCtx): ParsedSession | undefined {
  const manager = ctx?.sessionManager;
  if (typeof manager?.getEntries !== 'function') return undefined;

  const entries = manager.getEntries();
  if (!Array.isArray(entries)) return undefined;
  const cwd = manager.getCwd?.() ?? manager.getHeader?.()?.cwd ?? ctx?.cwd;
  return parseSessionEntriesChanges(entries, undefined, cwd);
}

/** Resolve a (possibly relative) manifest path against the session cwd. Falls
 *  back to the path itself when no cwd is available (mirrors FileDiffService's
 *  resolveFileChangePath fallback). */
function resolveAgainstCwd(relPath: string, cwd: string | undefined): string {
  if (path.isAbsolute(relPath)) return relPath;
  return cwd ? path.resolve(cwd, relPath) : relPath;
}

/** Render paths inside the session cwd relative to it. The cwd is already part
 *  of pi's system prompt, so repeating its absolute prefix on every manifest
 *  row wastes context. Paths outside the cwd stay absolute: making them `..`
 *  paths would obscure that the session edited outside its working tree. */
function displayPath(filePath: string, cwd: string | undefined): string {
  if (!cwd) return filePath;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    // Relative `../outside` inputs must not remain deceptively relative to the
    // agent's cwd; make the outside-working-tree boundary explicit.
    return path.isAbsolute(filePath) ? filePath : absolute;
  }
  // Preserve an already-relative in-cwd spelling (including `/` separators)
  // so manifest paths remain stable across platforms. Only absolute inputs
  // need conversion.
  return path.isAbsolute(filePath) ? relative : filePath;
}

/** Find the manifest entry for a requested path: exact string match first, then
 *  a canonical-identity match (so `src/x.ts` matches `./src/x.ts`, an absolute
 *  form, or a case/separator variant on case-insensitive filesystems). Returns
 *  undefined when the path isn't in the manifest. Uses the shared
 *  `canonicalFilePath` so lookup identity matches
 *  the accumulation identity exactly. */
function findManifestEntry(
  changes: FileChange[],
  relPath: string,
  cwd: string | undefined,
): FileChange | undefined {
  const exact = changes.find((c) => c.path === relPath);
  if (exact) return exact;
  const key = canonicalFilePath(relPath, cwd);
  return changes.find((c) => canonicalFilePath(c.path, cwd) === key);
}

/** Compute one file's diff, mapping the requested path to its manifest entry
 *  (kind + stats) and resolving it against the session cwd for git. */
async function diffOne(
  relPath: string,
  parsed: ParsedSession,
  context: number,
): Promise<DiffOutput> {
  const cwd = parsed.cwd;
  // execute validates every selected path before any Git inspection starts.
  const entry = findManifestEntry(parsed.changes, relPath, cwd)!;
  return computeFileDiff({
    relPath: displayPath(entry.path, cwd),
    absPath: resolveAgainstCwd(entry.path, cwd),
    kind: entry.kind,
    additions: entry.additions,
    deletions: entry.deletions,
    context,
  });
}

async function diffPaths(
  paths: string[],
  parsed: ParsedSession,
  context: number,
): Promise<DiffOutput[]> {
  const results = new Array<DiffOutput>(paths.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(DIFF_CONCURRENCY, paths.length) },
    async () => {
      while (nextIndex < paths.length) {
        const index = nextIndex++;
        results[index] = await diffOne(paths[index]!, parsed, context);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'session_changes',
    label: 'Session changes',
    description: 'Review files changed by the current or specified Pi session after editing, using a session-scoped manifest before workspace-wide Git checks. Includes successful mutations from completed subagents and nested descendants, even when their task failed; not running children or a complete filesystem mutation journal. Optional diff inspects current Git changes only for manifest paths.',
    promptSnippet: 'Review this session\'s changed-file manifest and focused diffs after file edits.',
    promptGuidelines: [
      'For the current runtime session, omit sessionPath so session_changes reads live entries (including in-memory sessions); pass sessionPath only to review another persisted session.',
      'After editing files, use session_changes list before claiming or reviewing what this session changed; then use session_changes diff only for relevant manifest paths.',
      'session_changes list uses recorded execution evidence, not Git; kinds are inferred and line counts are cumulative input churn, not net changes. diff shows current HEAD-to-working-tree Git changes (staged and unstaged), which may include older work or other sessions editing the same file. Do not attribute every hunk to this session. Use git status/diff separately for overall worktree checks.',
      'Follow inline offset instructions for omitted output; diff continuation requires one path and the same context. Pages are recomputed, so restart at offset=0 if the files change. For untracked or non-Git files, read current content; no historical before-image is implied.',
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

      const offset = p.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) return err('offset must be a non-negative safe integer.');
      const requestedSessionPath = p.sessionPath || undefined;

      let parsed: ParsedSession | undefined;
      try {
        // An explicit path always selects that persisted session, even when a
        // live runtime session is also available. Defaults use current runtime
        // entries first so in-memory sessions never require a JSONL file.
        parsed = requestedSessionPath
          ? parseSessionFileChanges(requestedSessionPath)
          : parseRuntimeSessionChanges(ctx);

        if (!parsed) {
          const sessionPath = ctx?.sessionManager?.getSessionFile?.();
          if (!sessionPath) {
            return err('no sessionPath provided and no active runtime session entries or session path available — pass sessionPath (a session JSONL file path).');
          }
          parsed = parseSessionFileChanges(sessionPath);
        }
      } catch (e) {
        return err((e as Error).message);
      }

      if (p.action === 'list') {
        const displayChanges = parsed.changes.map((change) => ({
          ...change,
          path: displayPath(change.path, parsed.cwd),
        }));
        return ok(renderList(displayChanges, offset));
      }

      // action === 'diff'
      if (!p.path) {
        return err('diff requires path (an array of file paths from the list manifest, e.g. ["src/x.ts"]).');
      }
      const paths = p.path;
      if (!Array.isArray(paths)) return err('diff path must be an array of file paths from the list manifest.');
      if (paths.length === 0) {
        return err('diff requires a non-empty path array (e.g. ["src/x.ts"]).');
      }
      if (paths.length > MAX_DIFF_PATHS) {
        return err(`diff accepts at most ${MAX_DIFF_PATHS} paths per call.`);
      }
      if (!paths.every((rel) => typeof rel === 'string' && rel.length > 0)) {
        return err('diff path entries must be non-empty strings.');
      }
      if (offset > 0 && paths.length !== 1) return err('diff continuation with offset requires exactly one path.');
      if (paths.some((rel) => !findManifestEntry(parsed.changes, rel, parsed.cwd))) {
        return err('Every diff path must belong to this session\'s list manifest; call list for the recorded paths.');
      }
      const context = p.context ?? 0;
      if (!Number.isInteger(context) || context < 0 || context > 100) return err('context must be an integer from 0 to 100.');

      return ok(renderDiffs(await diffPaths(paths, parsed, context), offset));
    },
  });
}
