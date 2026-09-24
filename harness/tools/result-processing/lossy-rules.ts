// Lossy-recoverable rules for the tool-result-pruner pipeline (§7.2, tier 2).
//
// Each rule is lossy: it drops information the agent usually doesn't want (the
// `ls -l` permission/size/owner columns; the `git log` author/date/body). Lossy
// rules are gated on profile (only `default` runs them — `security` keeps
// permissions/columns) and require a recall stash before their rewrite may
// enter history (§7.3). The stash + fidelity marker are wired by the pipeline
// + index.ts; these rules return a `marker` describing what they removed.
//
// Detection is args-as-signal (§5 principle 2): we gate on the tool-call args
// (`ctx.input.command` for bash) rather than sniffing output shape, because
// args give intent for free and avoid false positives on other tabular output.
// Pipelines/sequences/redirects are skipped — the output isn't ls's/git's.
//
// As with lossless rules: self-caught (throws never escape) and "uncertain →
// keep" (a line that doesn't parse as -l/log-shaped is left alone, and if too
// few lines match the rule returns null entirely).

import type { Rule, RuleContext, RuleResult } from "./types.js";

// ---------------------------------------------------------------------------
// 1. ls -l / -la → names + dir marker.
//
// `drwxr-xr-x 2 user group 4096 Jul 6 12:34 dir`  →  `dir/`
// `-rw-r--r-- 1 user group  123 Jul 6 12:34 file` →  `file`
// `lrwxrwxrwx 1 user group    5 Jul 6 12:34 link -> target` → `link -> target`
// The `total N` summary line is dropped. Directories get a trailing `/`
// (ls -F style); symlinks keep their ` -> target`. Filenames with spaces are
// handled by taking everything right of the datetime field.
// ---------------------------------------------------------------------------
function lsLong(text: string, ctx: RuleContext): RuleResult | null {
  if (ctx.toolName !== "bash") return null; // pi's built-in `ls` tool doesn't emit -l
  const command = ctx.input?.command;
  if (typeof command !== "string" || !isLsLongCommand(command)) return null;
  const parsed = parseLsLong(text);
  if (!parsed) return null; // not -l-shaped → uncertain → keep
  const rewritten = parsed.entries.join("\n") + "\n";
  if (rewritten === text) return null; // no change
  return { text: rewritten, changed: true, marker: `${parsed.entries.length} entries → names only` };
}

/** Is `command` a single `ls` invocation with a long-format flag? Conservative:
 *  skips pipelines/sequences/redirects (the output wouldn't be ls's). */
function isLsLongCommand(command: string): boolean {
  const cmd = command.trim();
  if (!/^ls\b/.test(cmd)) return false;
  if (/[|;\n]|\|\||&&|>>?/.test(cmd)) return false; // not a lone ls (skip pipelines, sequences, redirects, multi-line scripts)
  const tokens = cmd.split(/\s+/);
  for (const tok of tokens.slice(1)) {
    if (tok === "--") break; // end of options
    // A short flag group containing `l` (covers -l, -la, -lah, -lhrt, ...).
    if (/^-[A-Za-z]*l[A-Za-z]*$/.test(tok)) return true;
    if (tok === "--format=long" || tok === "--format=verbose") return true;
  }
  return false;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_RE = new RegExp(`^(?:${MONTHS.join("|")})$`);

/** Parse one -l line into a display name, or null if it isn't -l-shaped. */
function parseLsLongLine(line: string): string | null {
  // First char is the type indicator: d, -, l, b, c, p, s.
  if (!/^[dlsbcpst\-]/.test(line)) return null;
  const fields = line.split(/\s+/);
  // perms(0) links(1) owner(2) group(3) size(4) month(5) day(6) time/year(7) name(8+)
  if (fields.length < 9) return null;
  if (!MONTH_RE.test(fields[5]!)) return null;
  if (!/^\d{1,2}$/.test(fields[6]!)) return null;
  if (!/^(?:\d{1,2}:\d{2}|\d{4})$/.test(fields[7]!)) return null;
  const name = fields.slice(8).join(" ");
  if (!name) return null;
  return line[0] === "d" ? `${name}/` : name; // dir → trailing slash; symlink keeps " -> target"
}

/** Parse -l output into display entries. Returns null unless a strong majority
 *  of non-blank lines are -l-shaped (uncertain → keep). */
function parseLsLong(text: string): { entries: string[] } | null {
  const lines = text.split(/\r?\n/);
  const entries: string[] = [];
  let matched = 0;
  let nonBlank = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (/^total\s+\d+/i.test(line.trim())) continue; // block summary — drop (don't count toward the threshold)
    nonBlank++;
    const entry = parseLsLongLine(line);
    if (entry === null) continue;
    entries.push(entry);
    matched++;
  }
  if (matched === 0) return null;
  // Require 60% of non-blank lines to parse — guards against mis-detecting
  // other columnar output that happens to start with d/-/l.
  if (matched < Math.ceil(nonBlank * 0.6)) return null;
  return { entries };
}

// ---------------------------------------------------------------------------
// 2. git log (verbose) → oneline + short hash.
//
//   commit a1b2c3d4... (HEAD -> main, origin/main)
//   Author: Name <email>
//   Date:   Fri Jul 4 12:00:00 2025
//
//       Subject line
//
//       Body...
//
//  →  a1b2c3d Subject line (HEAD -> main, origin/main)
// ---------------------------------------------------------------------------
function gitLog(text: string, ctx: RuleContext): RuleResult | null {
  if (ctx.toolName !== "bash") return null;
  const command = ctx.input?.command;
  if (typeof command !== "string" || !isGitLogCommand(command)) return null;
  const commits = parseGitLog(text);
  if (commits.length === 0) return null;
  const rewritten =
    commits
      .map((c) => `${c.shortHash} ${c.subject}${c.refs ? ` (${c.refs})` : ""}`)
      .join("\n") + "\n";
  if (rewritten === text) return null;
  return { text: rewritten, changed: true, marker: `${commits.length} commits → oneline` };
}

/** Is `command` a verbose `git log` asking for the commit *list* (not diffs)?
 *  Conservative: skips pipelines/sequences, already-compact forms (--oneline /
 *  --pretty=oneline), and — crucially — diff/stat options (--patch/-p, --stat,
 *  --name-only, ...). When the agent passes those it wants the diff content,
 *  not just the commit list, so pruning to oneline would starve it (tier-3
 *  territory the design warns against); the recall stash is a safety net, not a
 *  license to drop what was explicitly requested. */
function isGitLogCommand(command: string): boolean {
  const cmd = command.trim();
  if (!/^git\s+log\b/.test(cmd)) return false;
  if (/[|;\n]|\|\||&&|>>?/.test(cmd)) return false; // not a lone git log (skip pipelines, sequences, redirects, multi-line scripts)
  if (/\b--oneline\b/.test(cmd)) return false; // already compact
  if (/--pretty[= ](?:oneline|format:)/.test(cmd)) return false;
  if (/--format[= ](?:oneline|%h)/.test(cmd)) return false;
  // Diff/stat content requested → the agent wants detail, not the list.
  // --cc / --remerge-diff are condensed/re-merged combined diffs; -u is the
  // documented synonym for -p/--patch; -c is combined diff (all imply patch).
  if (/(?:\s|^)--patch\b|(?:\s|^)--stat\b|(?:\s|^)--numstat\b|(?:\s|^)--shortstat\b|(?:\s|^)--raw\b|(?:\s|^)--name-only\b|(?:\s|^)--name-status\b|(?:\s|^)--cc\b|(?:\s|^)--remerge-diff\b/.test(cmd)) return false;
  // Short flag groups requesting patch/combined diff: -p (--patch), -u (alias
  // of --patch), -c (combined). (-m alone does NOT emit diffs — verified — so
  // it stays list-intent and is pruned.)
  for (const tok of cmd.split(/\s+/)) {
    if (/^-[A-Za-z0-9]*[puc][A-Za-z0-9]*$/.test(tok)) return false;
  }
  return true;
}

interface GitCommit {
  shortHash: string;
  subject: string;
  refs?: string;
}

/** Parse verbose `git log` output into commit summaries. Lines that don't fit
 *  the commit-block shape are skipped; returns [] if no commits found. */
function parseGitLog(text: string): GitCommit[] {
  const lines = text.split(/\r?\n/);
  const commits: GitCommit[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^commit ([0-9a-f]{7,40})(?:\s+\((.+)\))?$/.exec(lines[i]!);
    if (!m) {
      i++;
      continue;
    }
    const shortHash = m[1]!.slice(0, 7);
    const refs = m[2];
    // Skip header lines (Author:, Date:, Merge:, ...) up to the blank line that
    // precedes the indented message.
    let j = i + 1;
    while (j < lines.length && lines[j] !== "") j++;
    // Skip the blank separator, then any further blanks, to reach the subject.
    while (j < lines.length && lines[j]!.trim() === "") j++;
    let subject = "";
    if (j < lines.length && /^ {4,}/.test(lines[j]!)) {
      subject = lines[j]!.trim();
      j++;
    }
    commits.push({ shortHash, subject, refs });
    i = j; // resume scanning after the subject (body/blank/next commit)
  }
  return commits;
}

// ---------------------------------------------------------------------------
// 3. grep / rg `path:line:content` → grouped by path.
//
//   path/to/file.ts:6:import { Foo } from './foo'
//   path/to/file.ts:14:export type Bar = ...
//   path/other.ts:22:const x = 1
//  →
//   path/to/file.ts
//     6: import { Foo } from './foo'
//     14: export type Bar = ...
//   path/other.ts
//     22: const x = 1
//
// Repeated path prefixes dominate grep/rg output tokens — every match line
// re-emits the full path. Grouping prints each path once and indents its
// matches beneath. Information-preserving (path + line + content all
// present), lossy only in *layout*: the agent can no longer copy `path:line:`
// verbatim for a follow-up command, so the recall stash covers that (§7.3).
//
// Detection is hybrid (§5 principle 2): args-as-signal gates on a grep-family
// invocation (rg/ripgrep/rga/grep/egrep/fgrep, incl. `git grep`) so we never
// group arbitrary `word:number:text` tables; shape confirms a strong majority
// of lines are `path:line:content` with a pathy first field. Unlike ls-long /
// git-log we do NOT skip pipelines — grep's `path:line:` shape survives
// `| head`, `| sort`, etc. (common rg idioms), and mixed output is rejected by
// the 60% shape threshold. Multi-line scripts are still skipped (output is
// ambiguous). Only applied when a path *repeats* — otherwise grouping adds
// newlines/indents for zero savings; a shrink guard backstops that.
// ---------------------------------------------------------------------------

/** Commands whose output is grep-family `path:line:content`. Matches the
 *  invocation as a word anywhere in the command (handles `git grep`, `time rg`,
 *  `sudo rg`, `rg foo | head`). `git grep` is covered by the bare `grep` token. */
const GREP_TOKEN_RE = /\b(?:rg|ripgrep|rga|grep|egrep|fgrep)\b/;

function isGrepCommand(command: string): boolean {
  const cmd = command.trim();
  if (!GREP_TOKEN_RE.test(cmd)) return false;
  // A real newline (post-trim) means a multi-line script — the output could
  // be several commands' and isn't safely attributable to grep. (Pipes and
  // `;`/`&&` are fine: grep's path:line: shape survives them.)
  if (/\n/.test(cmd)) return false;
  return true;
}

/** Does `path` look like a real file path rather than a bare token? grep/rg
 *  emit paths with a separator and/or a file extension. A bare `host` in
 *  `host:42:msg` is almost certainly not grep output (e.g. a config table) —
 *  rejecting it upholds the "zero false positives" discipline (§4.4). The
 *  cost is missing bare-extensionless filenames (rare in multi-file output). */
function looksPathy(p: string): boolean {
  if (p.length < 2) return false;
  return /[/\\]/.test(p) || /\.[A-Za-z0-9]{1,8}$/.test(p);
}

interface GrepMatch {
  path: string;
  /** Line number as-is (preserve original width / zero-padding). */
  line: string;
  content: string;
}

/** Non-greedy up to the first `:digits:` so Windows drive letters (`C:\foo`)
 *  — which contain a colon — parse correctly: the line-number separator is
 *  the first `:digits:`, never the drive colon. */
const GREP_MATCH_RE = /^(.+?):(\d+):(.*)$/;

function parseGrepMatch(line: string): GrepMatch | null {
  const m = GREP_MATCH_RE.exec(line);
  if (!m) return null;
  const path = m[1]!;
  if (!looksPathy(path)) return null;
  return { path, line: m[2]!, content: m[3]! };
}

function grepGroup(text: string, ctx: RuleContext): RuleResult | null {
  const isGrepTool = ctx.toolName === "grep";
  if (ctx.toolName !== "bash" && !isGrepTool) return null;
  if (isGrepTool) {
    // Structured pi `grep` tool emits path:line:content for context=0 matches.
    // No command string is available, so we rely on the same shape + savings
    // guards that protect bash grep-family output.
  } else {
    const command = ctx.input?.command;
    if (typeof command !== "string" || !isGrepCommand(command)) return null;
  }

  // Split without the trailing-"" artifact so we can rebuild the exact
  // trailing-newline shape. Internal blank lines are preserved verbatim.
  const hadTrailingNewline = text.endsWith("\n");
  const body = hadTrailingNewline ? text.replace(/\r?\n$/, "") : text;
  const lines = body.split(/\r?\n/);

  const parsed: { match: GrepMatch | null; raw: string }[] = [];
  let matched = 0;
  let nonBlank = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      parsed.push({ match: null, raw: line }); // blank line — pass through
      continue;
    }
    nonBlank++;
    const m = parseGrepMatch(line);
    parsed.push({ match: m, raw: line });
    if (m) matched++;
  }
  if (matched === 0) return null; // not grep-shaped → uncertain → keep
  // Require a strong majority to be grep-shaped (guards mixed output).
  if (matched < Math.ceil(nonBlank * 0.6)) return null;

  // Only worth grouping when a path repeats — otherwise grouping adds
  // newlines/indents for zero savings (unique paths would grow the output).
  const counts = new Map<string, number>();
  for (const { match } of parsed) {
    if (match) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  }
  let repeats = false;
  for (const n of counts.values()) {
    if (n >= 2) { repeats = true; break; }
  }
  if (!repeats) return null;

  // Build grouped output: each path printed once, matches indented beneath.
  // Non-match / blank lines pass through unchanged and reset the current path
  // (we've left the group) so the next match re-prints its path.
  const out: string[] = [];
  let currentPath: string | null = null;
  for (const { match, raw } of parsed) {
    if (!match) {
      out.push(raw);
      currentPath = null;
      continue;
    }
    if (match.path !== currentPath) {
      out.push(match.path);
      currentPath = match.path;
    }
    out.push(`  ${match.line}: ${match.content}`);
  }
  let rewritten = out.join("\n");
  if (hadTrailingNewline) rewritten += "\n";
  // Shrink guard: if grouping didn't actually reduce bytes (e.g. heavily
  // interleaved paths that each repeat only once across a break), don't claim
  // a win — the net-savings gate would reject it anyway, but skip the stash.
  if (rewritten.length >= text.length) return null;
  return { text: rewritten, changed: true, marker: `${matched} matches in ${counts.size} files → path-grouped` };
}

// ---------------------------------------------------------------------------
// 4. Consecutive duplicate-line collapse.
//
// Long-running commands (builds, pings, polls, repeated status checks) often
// emit the same status line many times in a row. Collapsing runs of 3+
// identical consecutive non-blank lines into one line + a count marker saves
// tokens without removing the information that the line occurred. Severity
// lines (error/warning/fatal/notice/...) are never collapsed — the agent must
// still see repeated warnings verbatim. Blank lines are already normalized by
// the lossless blank-run rule and are skipped here.
//
// Lossy + recoverable via recall stash; the count marker makes the collapse
// transparent. A shrink guard skips the rewrite when the marker would not
// actually reduce bytes (e.g. very short repeated lines).
// ---------------------------------------------------------------------------
const SEVERITY_RE = /\b(?:error|warn|warning|fatal|fail|failed|failure|exception|panic|notice)\b/i;

function isSeverityLine(line: string): boolean {
  return SEVERITY_RE.test(line);
}

function collapseDuplicateLines(text: string, _ctx: RuleContext): RuleResult | null {
  if (!text.includes("\n")) return null;
  const hadTrailingNewline = text.endsWith("\n");
  const body = hadTrailingNewline ? text.replace(/\r?\n$/, "") : text;
  const lines = body.split(/\r?\n/);

  const out: string[] = [];
  let current = "";
  let run = 0;
  let totalRemoved = 0;

  function flushRun(): void {
    if (run === 0) return;
    out.push(current);
    if (run >= 3) {
      out.push(`  (... ${run - 1} identical lines)`);
      totalRemoved += run - 1;
    } else {
      for (let i = 1; i < run; i++) out.push(current);
    }
    run = 0;
  }

  for (const line of lines) {
    if (line.trim() === "" || isSeverityLine(line)) {
      flushRun();
      out.push(line);
      continue;
    }
    if (run > 0 && line === current) {
      run++;
    } else {
      flushRun();
      current = line;
      run = 1;
    }
  }
  flushRun();

  if (totalRemoved === 0) return null;
  let rewritten = out.join("\n");
  if (hadTrailingNewline) rewritten += "\n";
  if (rewritten.length >= text.length) return null; // shrink guard
  return { text: rewritten, changed: true, marker: `${totalRemoved} duplicate lines collapsed` };
}

// ---------------------------------------------------------------------------
// 5. Spinner / progress-bar noise removal.
//
// CLI progress updates (npm install, ora spinners, progress bars) emit frames
// like `⠋ Fetching metadata…` or `[====>    ] 23%`. These are pure noise to the
// agent: they carry no stable information and are never cited in follow-ups.
// Drop lines that are clearly progress updates, while preserving any line that
// contains an error/warning/notice keyword (e.g. `npm WARN`, `error:`). If the
// rewrite would leave no meaningful non-noise lines, keep the original — a
// command that produced only spinner frames is better surfaced through recall
// than hidden entirely.
//
// Detection is conservative: a line must contain a Unicode spinner (Braille
// block U+2800–U+28FF), or a progress bar pattern (`%` plus block glyphs or a
// bracketed `%` bar). Lines with percentages but no spinner/progress glyphs are
// kept (e.g. coverage reports).
// ---------------------------------------------------------------------------
const BRAILLE_RE = /[\u2800-\u28FF]/;
const PROGRESS_BLOCK_RE = /[\u2588-\u259F\u25A0-\u25A9]/;
const BRACKETED_PERCENT_RE = /^\s*[\(\[].*%[\)\]]/;

function looksLikeProgressNoise(line: string): boolean {
  if (line.trim() === "") return false;
  if (isSeverityLine(line)) return false; // always keep warnings/errors/notices
  if (BRAILLE_RE.test(line)) return true;
  if (line.includes("%")) {
    if (PROGRESS_BLOCK_RE.test(line)) return true;
    if (BRACKETED_PERCENT_RE.test(line)) return true;
  }
  return false;
}

function removeProgressNoise(text: string, _ctx: RuleContext): RuleResult | null {
  if (!text.includes("\n")) return null;
  const hadTrailingNewline = text.endsWith("\n");
  const body = hadTrailingNewline ? text.replace(/\r?\n$/, "") : text;
  const lines = body.split(/\r?\n/);

  const out: string[] = [];
  let removed = 0;
  for (const line of lines) {
    if (looksLikeProgressNoise(line)) {
      removed++;
      continue;
    }
    out.push(line);
  }
  if (removed === 0) return null;
  // Require at least one meaningful non-noise, non-blank line to remain;
  // otherwise the command produced only noise and is left for recall explicitly.
  const keptMeaningful = out.some((line) => line.trim() !== "" && !looksLikeProgressNoise(line));
  if (!keptMeaningful) return null;

  let rewritten = out.join("\n");
  if (hadTrailingNewline) rewritten += "\n";
  if (rewritten.length >= text.length) return null; // shrink guard
  return { text: rewritten, changed: true, marker: `${removed} progress-noise lines removed` };
}

// ---------------------------------------------------------------------------
// Ordered lossy pipeline (§7.2). Runs after LOSSLESS_RULES, only under the
// `default` profile (security keeps columns/permissions). Each rule is gated
// by its toggle in the pipeline; the stash requirement is enforced there too.
// ---------------------------------------------------------------------------
export const LOSSY_RULES: Rule[] = [
  { name: "ls-long", tier: "lossy", run: lsLong },
  { name: "git-log", tier: "lossy", run: gitLog },
  { name: "grep-group", tier: "lossy", run: grepGroup },
  { name: "progress-noise", tier: "lossy", run: removeProgressNoise },
  { name: "duplicate-collapse", tier: "lossy", run: collapseDuplicateLines },
];
