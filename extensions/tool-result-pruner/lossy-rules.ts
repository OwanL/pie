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
  const lines = text.split("\n");
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
  const lines = text.split("\n");
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
// Ordered lossy pipeline (§7.2). Runs after LOSSLESS_RULES, only under the
// `default` profile (security keeps columns/permissions). Each rule is gated
// by its toggle in the pipeline; the stash requirement is enforced there too.
// ---------------------------------------------------------------------------
export const LOSSY_RULES: Rule[] = [
  { name: "ls-long", tier: "lossy", run: lsLong },
  { name: "git-log", tier: "lossy", run: gitLog },
];
