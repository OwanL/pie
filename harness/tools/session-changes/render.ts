/** Compact session manifests and bounded, explicitly Git-scoped diff pages. */
import type { FileChange } from './types.js';
import type { DiffOutput } from './diff.js';

export const MAX_PER_FILE_CHARS = 8_000;
export const MAX_TOTAL_CHARS = 32_000;

function kindCode(kind: FileChange['kind']): 'M' | 'A' | 'D' {
  return kind === 'created' ? 'A' : kind === 'deleted' ? 'D' : 'M';
}

/** Character paging also handles a single enormous line/hunk. Reserve the
 * entire continuation notice before slicing; neither the first item nor its
 * metadata is allowed to bypass the output budget. Prefer line boundaries but
 * do not silently drop content when a line itself exceeds the page size. */
function pageText(text: string, maxChars: number, offset: number, action: 'list' | 'diff'): string {
  if (offset > text.length) return `Offset ${offset} exceeds output length ${text.length}; restart with offset=0.`;
  const prefix = offset > 0 ? `[continued at offset=${offset}]\n` : '';
  if (prefix.length + text.length - offset <= maxChars) return prefix + text.slice(offset);
  const notice = (end: number) => `\n[truncated; next: action=${action}, ${action === 'diff' ? 'path=[this file only], ' : ''}offset=${end}. Keep other arguments unchanged; output is recomputed, so restart if it changes.]`;
  let end = offset + maxChars - prefix.length - notice(text.length).length;
  const newline = text.lastIndexOf('\n', end - 1);
  if (newline >= offset) end = newline + 1;
  // Avoid splitting a UTF-16 surrogate pair, including on giant single lines.
  if (end > offset && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return prefix + text.slice(offset, end) + notice(end);
}

/** The manifest is derived from successful recorded mutations, not Git.
 * Counts are cumulative tool-input churn, not a net patch or proof of creation. */
export function renderList(changes: FileChange[], offset = 0): string {
  if (changes.length === 0) return 'No file changes derived from this session.';
  let additions = 0; let deletions = 0; let created = 0; let modified = 0; let deleted = 0;
  for (const c of changes) {
    additions += c.additions ?? 0;
    deletions += c.deletions ?? 0;
    if (c.kind === 'created') created++;
    else if (c.kind === 'modified') modified++;
    else deleted++;
  }
  const lines = [`${changes.length} +${additions} -${deletions} (${created}c/${modified}m/${deleted}d)`];
  for (const c of changes) lines.push(`${kindCode(c.kind)}\t${c.path}\t+${c.additions ?? 0}\t-${c.deletions ?? 0}`);
  lines.push('Recorded operations only; kinds are inferred and counts are cumulative input churn, not net Git changes.');
  return pageText(lines.join('\n'), MAX_TOTAL_CHARS, offset, 'list');
}

/** Remove only actual preamble headers. Header-looking additions/deletions
 * inside a hunk are content and must survive byte-for-byte (apart from CRLF). */
export function minifyDiff(rawGitDiff: string): string {
  if (!rawGitDiff) return '';
  let inHunk = false;
  const out: string[] = [];
  for (const line of rawGitDiff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (line.startsWith('@@')) inHunk = true;
    if (!inHunk && (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ '))) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function renderOneDiff(r: DiffOutput, offset: number, budget: number): string {
  const header = `${kindCode(r.kind)} ${r.path} recorded=+${r.additions}/-${r.deletions} baseline=${r.baseline}`;
  const text = [header, r.note, r.body].filter(Boolean).join('\n');
  return pageText(text, budget, offset, 'diff');
}

export function renderDiffs(results: DiffOutput[], offset = 0): string {
  if (results.length === 0) return 'No matching files in this session\'s manifest.';
  const blocks = ['Current Git changes, not session-only edits; may include older work or other sessions\' edits.'];
  let total = blocks[0]!.length;
  // Reserve the complete omission notice before admitting each file block.
  const omission = (count: number) => `\n[${count} more files omitted to stay within the size budget; call diff per-file for the remaining requested paths.]`;
  for (let i = 0; i < results.length; i++) {
    const block = renderOneDiff(results[i]!, offset, MAX_PER_FILE_CHARS - blocks[0]!.length - 1);
    const reserve = i < results.length - 1 ? omission(results.length).length : 0;
    if (total + 1 + block.length + reserve > MAX_TOTAL_CHARS) {
      blocks.push(omission(results.length - i).slice(1));
      break;
    }
    blocks.push(block);
    total += block.length + 1;
  }
  return blocks.join('\n');
}
