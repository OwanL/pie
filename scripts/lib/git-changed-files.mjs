// Pure-ish git helper: collect repo-relative changed/untracked file paths.
// Shared by scripts/run-affected-tests.mjs (the live `npm test` / `test:changed`
// entry point) so the git-diff logic lives in one tested lib module rather than
// a bespoke CLI wrapper.

import { spawn } from 'node:child_process';

/**
 * Run `git -C repoRoot <args>` and collect stdout as a UTF-8 string.
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, stdout: string }>}
 */
function gitOutput(repoRoot, args) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoRoot, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ ok: false, stdout: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout }));
  });
}

/** Split git `-z` (NUL-delimited) output into a list of non-empty paths. */
function splitNull(output) {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Collect all repo-relative, forward-slash changed/untracked file paths.
 * Tracked changes are diffed against HEAD; if HEAD does not exist (fresh repo),
 * every tracked file is treated as changed. Untracked, non-ignored files are
 * added via `git ls-files --others --exclude-standard`.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
export async function getChangedFiles(repoRoot) {
  const trackedResult = await gitOutput(repoRoot, ['diff', '--name-only', '-z', 'HEAD']);
  let tracked = trackedResult.ok ? splitNull(trackedResult.stdout) : [];
  if (!trackedResult.ok) {
    // No HEAD yet (fresh repo with no commits): treat all tracked files as changed.
    const allTracked = await gitOutput(repoRoot, ['ls-files', '-z']);
    if (!allTracked.ok) throw new Error(`Cannot inspect tracked files in ${repoRoot}`);
    tracked = splitNull(allTracked.stdout);
  }
  const untrackedResult = await gitOutput(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!untrackedResult.ok) throw new Error(`Cannot inspect untracked files in ${repoRoot}`);
  const untracked = splitNull(untrackedResult.stdout);

  const seen = new Set();
  const merged = [];
  for (const file of [...tracked, ...untracked]) {
    // git always emits forward-slash, repo-relative paths; normalize defensively.
    const normalized = file.replace(/\\/g, '/');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged;
}
