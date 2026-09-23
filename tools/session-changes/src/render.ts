/**
 * Output renderers for the `session_changes` tool — most-compact, agent-native.
 *
 * An empirical token sweep (see docs/SESSION-CHANGES-TOOL.md §4) settled the
 * choices: line-oriented text beats JSON for both bodies (JSON's escaping/
 * syntax is pure overhead here), the `list` action is TSV, and the `diff`
 * action is a minified unified diff (drop the 4-line git preamble; keep `@@`
 * hunk headers + diff lines — standard patch format agents are heavily trained
 * on). Truncation is signalled INLINE in the text (never a separate `details`
 * object), mirroring `session_review`'s inline truncation markers.
 */

import type { FileChange } from './types.js';
import type { DiffOutput } from './diff.js';

// Mirrors session_review's MAX_MSG_CHARS / MAX_TOTAL_CHARS budgeting: per-file
// ~8 KB, total ~32 KB, with inline truncation notices + remaining-hunk counts.
const MAX_PER_FILE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 32_000;

type KindCode = 'M' | 'A' | 'D';

function kindCode(kind: FileChange['kind']): KindCode {
  if (kind === 'created') return 'A';
  if (kind === 'deleted') return 'D';
  return 'M';
}

// ─── list (TSV) ────────────────────────────────────────────────────────────

/** Render the file-change manifest as a compact TSV block: a totals line then
 *  one `<KIND>\t<path>\t+<add>\t-<del>` row per file. */
export function renderList(changes: FileChange[]): string {
  if (changes.length === 0) {
    return 'No file changes derived from this session.';
  }
  let additions = 0;
  let deletions = 0;
  let created = 0;
  let modified = 0;
  let deleted = 0;
  for (const c of changes) {
    additions += c.additions ?? 0;
    deletions += c.deletions ?? 0;
    if (c.kind === 'created') created++;
    else if (c.kind === 'modified') modified++;
    else deleted++;
  }
  const lines: string[] = [
    `${changes.length} +${additions} -${deletions} (${created}c/${modified}m/${deleted}d)`,
  ];
  for (const c of changes) {
    lines.push(`${kindCode(c.kind)}\t${c.path}\t+${c.additions ?? 0}\t-${c.deletions ?? 0}`);
  }
  return lines.join('\n');
}

// ─── diff (minified unified diff) ───────────────────────────────────────────

/** Drop the 4-line git preamble (`diff --git` / `index` / `---` / `+++`) —
 *  our header already carries path+kind, so those lines are redundant noise.
 *  Keep `@@` hunk headers (line refs + the enclosing section label git emits)
 *  and the diff lines. Standard patch format; never worse than raw. */
export function minifyDiff(rawGitDiff: string): string {
  if (!rawGitDiff) return '';
  const lines = rawGitDiff.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue;
    }
    out.push(line);
  }
  // Trim a trailing empty line (git always terminates the patch with \n).
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Build a synthetic all-additions patch for a created file (diff vs empty):
 *  `@@ -0,0 +1,N @@` followed by `+`-prefixed lines. Standard patch format for
 *  a new file; avoids the `git diff --no-index /dev/null` portability trap. */
export function syntheticCreatedDiff(content: string): string {
  const text = content.replace(/\r?\n$/, '');
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

/** Truncate a minified diff body at a hunk boundary to fit `maxChars`, returning
 *  the kept body + the count of hunks omitted. Hunk-based truncation (vs
 *  mid-line) keeps the patch valid and lets us report a meaningful "N hunks
 *  omitted" notice — exactly the inline truncation the plan calls for. */
function capDiffBody(
  body: string,
  maxChars: number,
): { body: string; omittedHunks: number } {
  if (body.length <= maxChars) return { body, omittedHunks: 0 };
  const lines = body.split(/\r?\n/);
  // Group into hunks: each starts at a `@@` line; preamble lines before the
  // first `@@` (none after minify, but defensive) form their own group.
  const hunks: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('@@') || hunks.length === 0) hunks.push([line]);
    else hunks[hunks.length - 1].push(line);
  }
  const kept: string[] = [];
  let chars = 0;
  let keptHunks = 0;
  for (const hunk of hunks) {
    const hunkText = hunk.join('\n');
    const cost = hunkText.length + 1; // +1 for the joining newline
    if (keptHunks > 0 && chars + cost > maxChars) break;
    kept.push(...hunk);
    chars += cost;
    keptHunks++;
  }
  const omittedHunks = hunks.length - keptHunks;
  return { body: kept.join('\n'), omittedHunks };
}

/** Render one file's diff result as a header + (optionally truncated) body. */
function renderOneDiff(r: DiffOutput): string {
  const header = `${kindCode(r.kind)} ${r.path} +${r.additions} -${r.deletions} baseline=${r.baseline}`;
  const segments: string[] = [header];
  if (r.note) segments.push(r.note);
  const { body, omittedHunks } = capDiffBody(r.body, MAX_PER_FILE_CHARS);
  if (omittedHunks > 0) {
    segments.push(`… (truncated, ${omittedHunks} hunk${omittedHunks === 1 ? '' : 's'} omitted; use read for the full file)`);
  }
  if (body) segments.push(body);
  return segments.join('\n');
}

/** Render one or more file diff results as a single text block, applying the
 *  total-size budget: files beyond the budget are omitted with a count notice. */
export function renderDiffs(results: DiffOutput[]): string {
  if (results.length === 0) return 'No matching files in this session\'s manifest.';
  const blocks: string[] = [];
  let total = 0;
  for (let i = 0; i < results.length; i++) {
    const block = renderOneDiff(results[i]);
    if (blocks.length > 0 && total + block.length + 1 > MAX_TOTAL_CHARS) {
      const omitted = results.length - i;
      blocks.push(`… (${omitted} more file${omitted === 1 ? '' : 's'} omitted to stay within the size budget; call diff per-file for the rest)`);
      break;
    }
    blocks.push(block);
    total += block.length + 1;
  }
  return blocks.join('\n');
}
