/** Current Git inspection for manifest files. Attribution comes exclusively
 * from the session transcript; never walk Git history to invent a session
 * baseline. HEAD -> working tree includes both staged and unstaged changes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execGit } from '../../../lib/file-changes/git-baseline.js';
import { minifyDiff } from './render.js';

export type DiffKind = 'created' | 'modified' | 'deleted';
export interface DiffInput {
  relPath: string;
  absPath: string;
  kind: DiffKind;
  additions?: number;
  deletions?: number;
  context: number;
}
export interface DiffOutput {
  kind: DiffKind;
  path: string;
  additions: number;
  deletions: number;
  baseline: string;
  body: string;
  note?: string;
}
export interface DiffDependencies {
  execGit(dir: string, args: string[], maxBuffer: number): ReturnType<typeof execGit>;
}
const defaultDependencies: DiffDependencies = { execGit };
const MAX_GIT_BYTES = 5 * 1024 * 1024;

/** A deleted file may also have lost its parent directory. Run Git in the
 * nearest surviving ancestor so directory deletion still produces a patch. */
function existingParent(absPath: string): string {
  let dir = path.dirname(absPath);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

export async function computeFileDiff(input: DiffInput, deps: DiffDependencies = defaultDependencies): Promise<DiffOutput> {
  const result: DiffOutput = {
    kind: input.kind, path: input.relPath,
    additions: input.additions ?? 0, deletions: input.deletions ?? 0,
    baseline: 'HEAD', body: '',
  };
  const fallback = (note: string, baseline = '(unavailable)'): DiffOutput => ({ ...result, baseline, note });
  try {
    const parent = existingParent(input.absPath);
    // Git expands Windows 8.3 temp-directory spellings. Match that physical
    // parent spelling before deriving a repository-relative literal pathspec;
    // preserve the missing tail for deleted files/directories.
    const physicalPath = path.resolve(fs.realpathSync.native(parent), path.relative(parent, input.absPath));
    const repo = await deps.execGit(parent, ['rev-parse', '--show-toplevel'], MAX_GIT_BYTES);
    if (repo.code !== 0 || !repo.stdout.trim()) {
      return fallback(fs.existsSync(input.absPath)
        ? 'Not in a Git repository; use read for current content (no before-image recorded here).'
        : 'Not in a Git repository and path is absent; no current content or Git diff is available.');
    }
    const root = repo.stdout.trim();
    // Literal pathspecs prevent brackets, stars, etc. in a filename from
    // widening inspection to files not selected from the session manifest.
    const relative = path.relative(root, physicalPath).split(path.sep).join('/');
    const literal = `:(literal)${relative}`;
    const head = await deps.execGit(root, ['rev-parse', '--verify', 'HEAD'], MAX_GIT_BYTES);
    if (head.code !== 0) return fallback('Repository has no HEAD commit; inspect staged content with git diff --cached and current files with read.');
    const diff = await deps.execGit(root, [
      'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
      `--unified=${input.context}`, 'HEAD', '--', literal,
    ], MAX_GIT_BYTES);
    if (diff.code !== 0 && diff.code !== 1) return fallback(`Git diff failed (exit ${diff.code}); inspect this exact path with git status/diff.`);
    result.body = minifyDiff(diff.stdout);
    if (result.body) return result;
    const tracked = await deps.execGit(root, ['ls-files', '--error-unmatch', '--', literal], MAX_GIT_BYTES);
    if (tracked.code !== 0) {
      return fallback(fs.existsSync(input.absPath)
        ? 'Untracked or ignored path; use read for current content. No Git before-image exists.'
        : 'Path is absent and has no current Git diff; inspect the recorded mutation or Git history if needed.', '(untracked/absent)');
    }
    return { ...result, note: 'No current changes against HEAD (the recorded session edits may already be committed or reverted).' };
  } catch {
    // execGit rejects on missing Git, timeout and output-buffer overflow. Never
    // mislabel that as a clean diff or discard omitted deletions via "read".
    return fallback('Git inspection unavailable, timed out, or exceeded the 5 MiB capture limit; use bash with a path-scoped git diff redirected to a temporary file, then read that file in pages.');
  }
}
