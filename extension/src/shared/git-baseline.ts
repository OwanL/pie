import * as cp from 'node:child_process';
import * as path from 'node:path';

// ─── Git baseline resolution (shared, pure-node) ───────────────────────────
//
// Extracted from host/core/file-diff-service.ts so the session-changes
// extension's `diff` action can resolve the same pre-change baseline the
// changed-files UI diffs against — one implementation, two callers. Pure node
// (child_process + path); no vscode, no ArchState. The host's FileDiffService
// imports these and keeps its vscode-wired openFileDiff/revertFile wiring.

/** Run `git` in `dir`; resolve `{ stdout, code }`. Non-zero exit codes (e.g.
 *  `git diff --exit-code` → 1 on differences, 128 for a bad ref) resolve with
 *  their code for callers to inspect; only non-numeric failures (git not
 *  installed) reject. */
export function execGit(
  dir: string,
  args: string[],
  /** Max stdout bytes before the exec rejects (ENOBUFS). Defaults to 1 MB —
   *  enough for the small queries the baseline walk / tracker use. The
   *  session-changes `diff` action passes a larger value (5 MB) so large-but-
   *  reasonable diffs are captured and then minified/truncated by the renderer,
   *  rather than lost to a buffer overflow → "no git baseline" fallback. */
  maxBuffer: number = 1024 * 1024,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      'git',
      args,
      { cwd: dir, maxBuffer },
      (err, stdout) => {
        if (err) {
          const code = (err as { code?: number }).code;
          if (typeof code === 'number') {
            resolve({ stdout: typeof stdout === 'string' ? stdout : '', code });
            return;
          }
          reject(err);
          return;
        }
        resolve({ stdout: typeof stdout === 'string' ? stdout : '', code: 0 });
      },
    );
  });
}

/** Whether the working-tree version of `absPath` differs from its content
 *  at `sha`. `git diff --quiet` exits 0 when identical, 1 when different, and
 *  — unlike `--exit-code` — emits no patch to stdout, so it can't overflow
 *  the exec buffer on large changes. */
export async function differsFromCommit(
  dir: string,
  sha: string,
  absPath: string,
): Promise<boolean> {
  const { code } = await execGit(dir, ['diff', '--quiet', sha, '--', absPath]);
  if (code === 0) return false;
  if (code === 1) return true;
  throw new Error(`git diff --quiet ${sha} exited ${code}`);
}

/**
 * Resolve the git ref to diff a changed file against — the pre-change
 * baseline rather than a bare `HEAD`.
 *
 * Walks the file's git history (commits that touched it, newest first) and
 * returns the most recent commit whose content DIFFERS from the working
 * tree. For an uncommitted (dirty) change that is `HEAD` itself (current
 * behaviour preserved); for a change the agent has since committed it is the
 * commit just before the change — without this, `HEAD` already holds the
 * agent's edits and the diff is empty.
 *
 * Known limitation: if the agent made several commits to the same file
 * during a session and the working tree matches the latest of them, the
 * baseline is the commit before the LAST change, so the diff shows only
 * that final delta rather than the whole session's churn. Returns `'HEAD'`
 * (no regression) when the file is untracked, git is unavailable, or the
 * walk finds no differing commit.
 */
export async function resolveBaselineRef(resolvedPath: string): Promise<string> {
  const dir = path.dirname(resolvedPath);
  try {
    const { stdout, code } = await execGit(dir, [
      'log',
      '--format=%H',
      '-n',
      '50',
      '--',
      resolvedPath,
    ]);
    if (code !== 0) return 'HEAD';
    const shas = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const sha of shas) {
      if (await differsFromCommit(dir, sha, resolvedPath)) return sha;
    }
    return 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/** Whether `absPath` is tracked by git (staged or committed). Used to decide
 *  whether a created-by-agent file should be reverted via `git checkout` (tracked)
 *  or deleted from the working tree (untracked). Extracted alongside the baseline
 *  walk as a second pure git query the host and extension both need. */
export async function isTrackedByGit(absPath: string): Promise<boolean> {
  const dir = path.dirname(absPath);
  try {
    const { code } = await execGit(dir, ['ls-files', '--error-unmatch', absPath]);
    return code === 0;
  } catch {
    return false;
  }
}
