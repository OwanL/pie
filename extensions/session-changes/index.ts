import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import * as path from 'node:path';

import { MAX_DIFF_PATHS, sessionChangesSchema } from './src/types.js';
import type { SessionChangesParams, FileChange } from './src/types.js';
import { parseSessionFileChanges } from './src/session-jsonl.js';
import type { ParsedSession } from './src/session-jsonl.js';
import { renderList, renderDiffs } from './src/render.js';
import { computeFileDiff } from './src/diff.js';
import type { DiffOutput, DiffKind } from './src/diff.js';
import { canonicalFilePath } from '../../extension/src/shared/file-path.js';

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
const DIFF_CONCURRENCY = 4;

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
 *  undefined when the path isn't in the manifest (defaulting the caller to
 *  `modified`). Uses the shared `canonicalFilePath` so lookup identity matches
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
  const entry = findManifestEntry(parsed.changes, relPath, cwd);
  const kind: DiffKind = entry?.kind ?? 'modified';
  const manifestPath = entry?.path ?? relPath;
  return computeFileDiff({
    relPath: displayPath(manifestPath, cwd),
    absPath: resolveAgainstCwd(manifestPath, cwd),
    kind,
    additions: entry?.additions,
    deletions: entry?.deletions,
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
    description: 'List files changed by a pi session or return focused diffs for selected paths. Defaults to this session and includes subagent edits.',
    promptSnippet: 'Inspect a session\'s changed-file manifest and focused diffs.',
    promptGuidelines: [
      'Use session_changes list before diff to isolate this session; read files when generated or untracked-file diffs are incomplete.',
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
        const displayChanges = parsed.changes.map((change) => ({
          ...change,
          path: displayPath(change.path, parsed.cwd),
        }));
        return ok(renderList(displayChanges));
      }

      // action === 'diff'
      if (!p.path) {
        return err('diff requires path (an array of file paths from the list manifest, e.g. ["src/x.ts"]).');
      }
      const paths = p.path;
      if (paths.length === 0) {
        return err('diff requires a non-empty path array (e.g. ["src/x.ts"]).');
      }
      if (paths.length > MAX_DIFF_PATHS) {
        return err(`diff accepts at most ${MAX_DIFF_PATHS} paths per call.`);
      }
      if (!paths.every((rel) => typeof rel === 'string' && rel.length > 0)) {
        return err('diff path entries must be non-empty strings.');
      }
      const context = Number.isInteger(p.context) && p.context! >= 0 && p.context! <= 100 ? p.context! : 0;

      return ok(renderDiffs(await diffPaths(paths, parsed, context)));
    },
  });
}
