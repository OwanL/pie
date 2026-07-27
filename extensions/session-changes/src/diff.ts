/**
 * Per-file diff computation for the `session_changes` `diff` action.
 *
 * Uses the SHARED git-baseline resolver (shared/git-baseline) so the tool diffs
 * against the same pre-change baseline the changed-files UI does — one
 * implementation, two callers. Produces a minified unified diff body (render.ts
 * drops the 4-line git preamble) plus the stat header render.ts emits.
 *
 * Edge cases (docs/SESSION-CHANGES-TOOL.md §6) — never error:
 *  - Created files: diff vs empty → full content as additions (synthetic patch),
 *    no git baseline needed; capped by render.ts's per-file budget.
 *  - Deleted files: `git diff <pre-deletion-baseline> -- <file>` shows the old
 *    content as deletions (file absent in the working tree).
 *  - Non-git / untracked / no baseline: emit the stat header + an inline note
 *    (`no git baseline; use read to view`) instead of a diff body.
 *  - Multi-commit-same-file: `resolveBaselineRef` walks to the commit before the
 *    LAST change, so the diff may show only the final delta while `list` stats
 *    are session-cumulative — surfaced honestly via the header, not hidden.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { execGit, resolveBaselineRef, isTrackedByGit } from '../../../extension/src/shared/git-baseline.js';
import { minifyDiff, syntheticCreatedDiff } from './render.js';

export type DiffKind = 'created' | 'modified' | 'deleted';

export interface DiffInput {
  /** Path as the manifest reports it (relative to session cwd, or absolute) —
   *  used for display in the diff header. */
  relPath: string;
  /** Resolved absolute path — used for git operations. */
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
  /** The git ref diffed against, or a marker for non-git/created cases. */
  baseline: string;
  /** Minified unified diff body (may be empty when no baseline / no changes). */
  body: string;
  /** Inline note replacing a missing diff body (never thrown). */
  note?: string;
}

const NO_GIT_NOTE = 'no git baseline; use read to view';

/** Compute one file's diff output. Never throws — git/fs failures become a
 *  header + inline note, matching `resolveBaselineRef`'s own `'HEAD'` fallback. */
export async function computeFileDiff(input: DiffInput): Promise<DiffOutput> {
  const { relPath, absPath, context } = input;
  let kind = input.kind;
  const additions = input.additions ?? 0;
  const deletions = input.deletions ?? 0;

  // A `created` kind is the derivation's best guess from the tool NAME (write/
  // create) — it cannot prove the file is new. Verify the claim against git: a
  // tracked file existed before the session, so an overwrite is a modification,
  // not a creation. Only treat as created (diff vs empty) when the file is NOT
  // git-tracked. This is the evidence check: we do not claim a file is
  // definitely created when git shows it already existed.
  if (kind === 'created' && await isTrackedByGit(absPath)) {
    kind = 'modified';
  }

  // Created: full content as additions (diff vs empty). No git baseline needed.
  if (kind === 'created') {
    return createdFileDiff(relPath, absPath, additions, deletions);
  }

  // Modified / deleted: diff against the pre-change git baseline.
  try {
    const baseline = await resolveBaselineRef(absPath);
    const dir = path.dirname(absPath);
    const { stdout, code } = await execGit(
      dir,
      [
        'diff',
        baseline,
        '--no-color',
        `--unified=${context}`,
        '--',
        absPath,
      ],
      // 5 MB: large enough that a real diff is captured and then minified/
      // truncated by the renderer (~8 KB/file) rather than lost to a buffer
      // overflow → "no git baseline" fallback. Truly enormous single-file
      // diffs (>5 MB) still fall back gracefully (use `read`).
      5 * 1024 * 1024,
    );
    // `git diff` exits 0 (identical) or 1 (differences); 1 is normal. Any other
    // code (e.g. 128 for a bad ref / untracked in a non-git dir) → no baseline.
    if (code !== 0 && code !== 1) {
      return noBaseline(relPath, kind, additions, deletions);
    }
    const body = minifyDiff(stdout);
    if (!body) {
      // Working tree matches the baseline (already committed, or no net change).
      return {
        kind,
        path: relPath,
        additions,
        deletions,
        baseline,
        body: '',
        note: 'no changes vs baseline (file may be untracked or already committed); use read to view',
      };
    }
    return { kind, path: relPath, additions, deletions, baseline, body };
  } catch {
    return noBaseline(relPath, kind, additions, deletions);
  }
}

/** Created-file diff: read the file and emit it as an all-additions patch. */
function createdFileDiff(
  relPath: string,
  absPath: string,
  additions: number,
  deletions: number,
): DiffOutput {
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return {
      kind: 'created',
      path: relPath,
      additions,
      deletions,
      baseline: '(new file)',
      body: '',
      note: 'file no longer exists on disk; use read to view',
    };
  }
  return {
    kind: 'created',
    path: relPath,
    additions,
    deletions,
    baseline: '(new file)',
    body: syntheticCreatedDiff(content),
  };
}

function noBaseline(
  relPath: string,
  kind: DiffKind,
  additions: number,
  deletions: number,
): DiffOutput {
  return {
    kind,
    path: relPath,
    additions,
    deletions,
    baseline: 'HEAD',
    body: '',
    note: NO_GIT_NOTE,
  };
}
