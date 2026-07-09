/**
 * Transparent search-pruning guard for the bash tool.
 *
 * Agents embed `grep -r` / `find .` INSIDE compound bash (echo headers + find +
 * grep + fallback chains) that the dedicated grep/find tools cannot express. On
 * a workspace that is ~98% node_modules, a bare `grep -rn PAT .` traverses every
 * vendored file and hangs (>120s). This rewriter injects the same kind of
 * exclude-dir / -prune that rg and the dedicated tools already apply — so bash
 * search becomes fast with ZERO agent awareness (no banners, no convention docs).
 *
 * It is an APPROXIMATION of rg, not exact parity: rg derives its excludes
 * dynamically from each repo's actual .gitignore (nested files, global excludes,
 * etc.), while this uses one static hardcoded prune-dir list. The two diverge in
 * both directions — e.g. twin-api's .gitignore also lists typings/ .grunt
 * boulder_components (not here), while this list adds .venv/.turbo/.moon for other
 * workspace repos. Deriving the list from .gitignore at rewrite time would defeat
 * the "cheap regex rewrite" design, so the drift is an accepted trade-off.
 *
 * Safety model = "never worse than the status quo":
 *   - The whole thing is gated on env PIE_BASH_AUTO_PRUNE (default on; "0" off).
 *   - grep injection is ADDITIONALLY gated on a runtime GNU-grep capability
 *     probe — a BSD/busybox grep lacking --exclude-dir would ERROR the command
 *     outright (strictly worse), so non-GNU environments always passthrough.
 *   - Anything ambiguous (heredocs, shell control keywords, comments, find with
 *     actions/-prune/globals/grouping, scoped finds, prune-dir searches) is
 *     passed through unchanged. Conservative by design.
 *
 * Reassembly is byte-preserving at the SEGMENT level: only segments whose
 * program was rewritten have their substring spliced; every separator, newline,
 * and whitespace run between segments is left identical (FIX #1).
 */

import { spawnSync } from "node:child_process";
import { QUOTED, TOKEN, HEREDOC, unquote } from "./classifier.js";

/** Options for {@link rewriteForPrune}. */
export interface PruneOpts {
  /** Lazy GNU-grep probe (cached by the caller). grep injection is gated on it. */
  gnuGrepProbe: () => boolean;
}

/** Directories pruned from recursive grep via --exclude-dir. */
const GREP_EXCLUDE_DIRS = [
  "node_modules", ".git", ".venv", "dist", "build",
  ".next", "coverage", ".turbo", ".moon",
];

/** Directories pruned from `find` via -prune (the two that matter for traversal). */
const FIND_PRUNE_DIRS = ["node_modules", ".git"];

const GREP_EXCLUDE_FLAGS =
  GREP_EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");

/** Shell control keywords → passthrough the WHOLE command (FIX #1). Word-boundary
 *  so `foreach` / `#include` (quoted) don't false-trigger. */
const CONTROL_KEYWORD = /\b(for|while|until|if|then|case|do|function)\b/;

/** A `#` that begins a shell comment: at start, or preceded by whitespace / a
 *  shell operator / subshell paren / redirect. (Quotes are already stripped.) */
const COMMENT_START = /(^|[\s;&|()<>])#/;

/** Leading env-assignment token: `NAME=value` (NOT `--exclude-dir=...`, which
 *  starts with `-`). */
const ASSIGN = /^[A-Za-z_]\w*=/;

/** find primaries that take a name/path pattern argument (FIX #2 detection). */
/** find primaries that take a name/path pattern argument (FIX #2 detection).
 *  Includes the -path aliases (-wholename/-iwholename) and regex/symlink-target
 *  primaries (-regex/-iregex/-lname/-ilname), all of which can reference a prune
 *  dir and so must trigger passthrough when they do. */
const NAME_FLAGS = new Set([
  "-name", "-iname", "-path", "-ipath",
  "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname",
]);

/** A prune-dir referenced by name anywhere in the value (substring). If the
 *  user's -name/-iname/-path/-ipath pattern mentions node_modules or .git, the
 *  prune branch would hide the very results they're searching for (the dir entry
 *  itself and everything under it), so passthrough — conservative by design
 *  ("never worse than status quo"). This also catches `*node_modules*` /
 *  `*node_modules*`-style substring references, at the cost of also passthroughing
 *  `.gitignore` / `.github` / `.gitconfig` (rewriting those would actually be
 *  safe, but correctness-first wins over the marginal speedup). */
const PRUNE_DIR_REF = /node_modules|\.git/i;

/** find actions (presence → passthrough; we'd otherwise append -print). */
const FIND_ACTIONS = new Set([
  "-print", "-print0", "-printf", "-exec", "-execdir", "-ok", "-okdir",
  "-delete", "-ls", "-fls", "-fprint", "-fprint0", "-fprintf", "-quit", "-exit",
]);

/** find global options (presence → passthrough; interfere with -prune).
 *  `-d` is `-depth` (unambiguous — find has no `-d` primary). */
const FIND_GLOBALS = new Set([
  "-maxdepth", "-mindepth", "-mount", "-xdev", "-follow", "-regextype",
  "-depth", "-d", "-daystart", "-help", "-version", "-ignore_readdir_race",
  "-noignore_readdir_race", "-noleaf", "-optimization", "-optimize",
  "-warn", "-nowarn",
]);

interface Segment {
  start: number;
  end: number;
  text: string;
}

interface RawTok {
  raw: string;
  value: string;
  start: number;
  end: number;
}

/**
 * Rewrite a bash command string to inject search-pruning exclusions into
 * recursive grep / bare-path find segments. Returns the original string
 * reference (byte-identical) when no segment changed.
 */
export function rewriteForPrune(command: string, opts: PruneOpts): string {
  // FIX #5: a heredoc body is unquoted free text that may contain `;`, `&&`, and
  // even literal `grep -rn foo .`-looking lines. Never split/rewrite it.
  if (HEREDOC.test(command)) return command;

  // FIX #1: shell control structures and comments are passthrough-the-whole-
  // command. Rebuilding would risk `do ; grep` syntax errors and swallow
  // trailing `# comment` lines (the comment would eat the following command).
  // Match against the quote-stripped command so quoted `#include` / `foreach`
  // don't false-trigger.
  const stripped = command.replace(QUOTED, "");
  if (CONTROL_KEYWORD.test(stripped) || COMMENT_START.test(stripped)) return command;

  const segments = splitSegments(command);
  let changed = false;
  const rewritten: string[] = new Array(segments.length);
  for (let i = 0; i < segments.length; i++) {
    const r = rewriteSegment(segments[i]!.text, opts);
    rewritten[i] = r;
    if (r !== segments[i]!.text) changed = true;
  }
  if (!changed) return command; // byte-identical passthrough (no allocation)
  return reassemble(command, segments, rewritten);
}

/** Split on top-level `;` `&&` `||` `|` `&` and newlines, quote / backtick /
 *  `$(…)` / `(…)` / backslash-aware. Tracks [start,end) offsets so reassembly
 *  can splice only changed segments and leave every separator byte identical. */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  const stack: Frame[] = [];
  const n = command.length;
  let segStart = 0;
  let i = 0;

  while (i < n) {
    const c = command[i]!;
    const top = stack[stack.length - 1];

    if (top === "'") {
      if (c === "'") stack.pop();
      i += 1;
      continue;
    }
    if (top === '"') {
      if (c === "\\") { i += 2; continue; }
      if (c === '"') { stack.pop(); i += 1; continue; }
      // `$(` and backtick are active inside double quotes.
      if (c === "$" && command[i + 1] === "(") { stack.push("$("); i += 2; continue; }
      if (c === "`") { stack.push("`"); i += 1; continue; }
      i += 1;
      continue;
    }
    if (top === "`") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") stack.pop();
      i += 1;
      continue;
    }
    if (top === "$(" || top === "(") {
      // Command substitution / subshell: track nested quotes / subs / parens.
      if (c === "\\") { i += 2; continue; }
      if (c === "'") { stack.push("'"); i += 1; continue; }
      if (c === '"') { stack.push('"'); i += 1; continue; }
      if (c === "`") { stack.push("`"); i += 1; continue; }
      if (c === "$" && command[i + 1] === "(") { stack.push("$("); i += 2; continue; }
      if (c === "(") { stack.push("("); i += 1; continue; }
      if (c === ")") { stack.pop(); i += 1; continue; }
      i += 1;
      continue;
    }

    // Top level.
    if (c === "\\") { i += 2; continue; } // escaped char (incl. find's `\(`)
    if (c === "'") { stack.push("'"); i += 1; continue; }
    if (c === '"') { stack.push('"'); i += 1; continue; }
    if (c === "`") { stack.push("`"); i += 1; continue; }
    if (c === "$" && command[i + 1] === "(") { stack.push("$("); i += 2; continue; }
    if (c === "(") { stack.push("("); i += 1; continue; }

    // Separators at top level.
    if (c === "\n" || c === "\r") {
      segments.push(makeSeg(command, segStart, i));
      i += c === "\r" && command[i + 1] === "\n" ? 2 : 1;
      segStart = i;
      continue;
    }
    if (c === ";") {
      segments.push(makeSeg(command, segStart, i));
      i += 1;
      segStart = i;
      continue;
    }
    if (c === "&") {
      segments.push(makeSeg(command, segStart, i));
      i += command[i + 1] === "&" ? 2 : 1;
      segStart = i;
      continue;
    }
    if (c === "|") {
      segments.push(makeSeg(command, segStart, i));
      i += command[i + 1] === "|" ? 2 : 1;
      segStart = i;
      continue;
    }
    i += 1;
  }
  segments.push(makeSeg(command, segStart, n));
  return segments;
}

type Frame = "'" | '"' | "$(" | "(" | "`";

function makeSeg(command: string, start: number, end: number): Segment {
  return { start, end, text: command.slice(start, end) };
}

/** Splice only changed segments back; leave every separator/newline/whitespace
 *  run between segments identical (FIX #1 byte-preservation). */
function reassemble(command: string, segments: Segment[], rewritten: string[]): string {
  let result = "";
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.start > cursor) result += command.slice(cursor, seg.start); // separator gap
    result += rewritten[i];
    cursor = seg.end;
  }
  if (cursor < command.length) result += command.slice(cursor);
  return result;
}

/** Tokenize a segment into raw (quote-preserving) tokens with byte offsets. */
function rawTokens(text: string): RawTok[] {
  const out: RawTok[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0];
    out.push({ raw, value: unquote(raw), start: m.index ?? 0, end: (m.index ?? 0) + raw.length });
  }
  return out;
}

/** Program name from a token value: strip quotes, then take the basename
 *  (handles `/usr/bin/grep`, `./find`). */
function programName(value: string): string {
  return value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
}

function rewriteSegment(text: string, opts: PruneOpts): string {
  const toks = rawTokens(text);
  if (toks.length === 0) return text;

  // Peel leading `VAR=val` assignments so `LANG=C grep …` still rewrites.
  let idx = 0;
  while (idx < toks.length && ASSIGN.test(toks[idx]!.raw)) idx++;
  if (idx >= toks.length) return text; // only assignments, no program

  const prog = toks[idx]!;
  const name = programName(prog.value);
  if (name === "grep" || name === "egrep" || name === "fgrep") {
    return rewriteGrepSegment(text, toks, idx, prog, opts);
  }
  if (name === "find") {
    return rewriteFindSegment(text, toks, idx, prog);
  }
  return text; // rule 3 passthrough (rg, ls, xargs grep …, etc.)
}

function rewriteGrepSegment(
  text: string,
  toks: RawTok[],
  progIdx: number,
  prog: RawTok,
  opts: PruneOpts,
): string {
  const args = toks.slice(progIdx + 1);

  // Recursive? any single-dash flag containing r/R (covers -r, -R, -rn, -rnI, -Er).
  let recursive = false;
  for (const t of args) {
    const v = t.value;
    if (v.startsWith("-") && !v.startsWith("--") && /[rR]/.test(v.slice(1))) {
      recursive = true;
      break;
    }
  }
  if (!recursive) return text;

  // Already excluded node_modules? passthrough (duplicate flags are pointless).
  if (hasExcludeNodeModules(args)) return text;

  // FIX #3: gate on GNU grep. --exclude-dir is a GNU extension; a BSD/busybox
  // grep lacking it would ERROR the command — strictly worse than status quo.
  // NOTE: this also documents the GNU-grep dependency for the injection below.
  if (!opts.gnuGrepProbe()) return text;

  // Inject flags immediately after the program token (pipe-safe: the rest of the
  // segment — args, redirects, etc. — follows unchanged).
  const insert = ` ${GREP_EXCLUDE_FLAGS}`;
  return text.slice(0, prog.end) + insert + text.slice(prog.end);
}

function hasExcludeNodeModules(args: RawTok[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const v = args[i]!.value;
    if (v === "--exclude-dir=node_modules") return true;
    if (v === "--exclude-dir" && args[i + 1]?.value === "node_modules") return true;
  }
  return false;
}

function rewriteFindSegment(text: string, toks: RawTok[], progIdx: number, prog: RawTok): string {
  const afterFind = toks.slice(progIdx + 1);

  // "No shell operators in the segment": a find reaching here was already split
  // on top-level operators, but it may still carry `$(…)`, backticks, globs,
  // redirects, or backslash escapes (`\( \) \;`). Any of those → passthrough.
  if (findHasShellMeta(text.slice(prog.start))) return text;

  // Parse [path...] [expression]. Leading path tokens are the maximal run of
  // non-option, non-grouping tokens before the first `-flag` / `(` / `)` / `!`.
  // Bare path = exactly one leading path that is `.` / `./` (or none at all).
  // Multiple paths (find . src …) or a scoped path (find src …) → passthrough:
  // our -prune wrap only handles a single `.` root, and a scoped find shouldn't
  // be pruned at the root anyway.
  let pathCount = 0;
  while (pathCount < afterFind.length) {
    const t = afterFind[pathCount]!.value;
    if (t.startsWith("-") || t === "(" || t === ")" || t === "!") break;
    pathCount++;
  }
  let pathStr = ".";
  let exprTokens: RawTok[];
  if (pathCount === 0) {
    exprTokens = afterFind; // no path given → defaults to `.`
  } else if (pathCount === 1 && (afterFind[0]!.value === "." || /^\.[\\/]+$/.test(afterFind[0]!.value))) {
    pathStr = afterFind[0]!.raw;
    exprTokens = afterFind.slice(1);
  } else {
    return text; // scoped path OR multiple paths → passthrough
  }

  // No actions / existing -prune / global options.
  for (const t of exprTokens) {
    const v = t.value;
    if (FIND_ACTIONS.has(v)) return text;
    if (v === "-prune") return text;
    if (FIND_GLOBALS.has(v)) return text;
  }

  // FIX #2: don't defeat explicit prune-dir searches. `-name node_modules` (or
  // -iname/-path/-ipath referencing node_modules/.git) would match the prune
  // branch and yield zero results.
  if (referencesPruneDir(exprTokens)) return text;

  const prefix = text.slice(0, prog.start); // leading whitespace + assignments
  const exprStr = exprTokens.map((t) => t.raw).join(" ");
  const pruneExpr = FIND_PRUNE_DIRS.map((d) => `-name ${d}`).join(" -o ");
  const tail = exprStr ? `\\( ${exprStr} \\) -print` : "-print";
  // Preserve the segment's trailing bytes (whitespace after the last token) so
  // the splice is byte-faithful at the trailing edge — e.g. `find … *.ts ' ;`
  // keeps the space before the `;` rather than collapsing to `-print;`.
  const suffix = text.slice(toks[toks.length - 1]!.end);
  // Wrap the user expr in `\( … \)` to preserve OR-chain precedence, append -print.
  return `${prefix}${prog.raw} ${pathStr} \\( ${pruneExpr} \\) -prune -o ${tail}${suffix}`;
}

/** Mirror classifier.ts's shell-meta checks (without its cd-peel / builtin
 *  logic, which don't apply to a single split segment). Also catches bare `( )`
 *  (subshell grouping) which classifier's OPERATORS regex does not. */
function findHasShellMeta(remainder: string): boolean {
  if (HEREDOC.test(remainder)) return true;
  const stripped = remainder.replace(QUOTED, "");
  if (/[()]/.test(stripped)) return true; // subshell / find grouping via bare parens
  if (/[\n|;&]/.test(stripped)) return true;
  if (/&&|\|\||>>|<|>/.test(stripped)) return true;
  if (/[*?~]/.test(stripped)) return true; // globs
  if (/\$/.test(stripped)) return true; // var / $()
  if (/`/.test(stripped)) return true; // backtick cmd-subst
  if (/\\/.test(stripped)) return true; // backslash (incl. \( \) \; )
  if (/\{[^{}]*,[^{}]*\}/.test(stripped)) return true; // brace expansion
  return false;
}

function referencesPruneDir(exprTokens: RawTok[]): boolean {
  for (let i = 0; i < exprTokens.length; i++) {
    if (NAME_FLAGS.has(exprTokens[i]!.value)) {
      const next = exprTokens[i + 1];
      if (next && PRUNE_DIR_REF.test(next.value)) return true;
    }
  }
  return false;
}

/**
 * Probe whether the runtime grep is GNU grep (or otherwise accepts
 * `--exclude-dir`). Probed once per process and cached by the caller (index.ts).
 * Conservative: any doubt (spawn failure, ambiguous output) → false, so a
 * non-GNU environment never gets a broken `--exclude-dir` grep.
 */
export function probeGnuGrep(shellPath: string): boolean {
  const run = (cmd: string, args: string[]): { out: string } | null => {
    try {
      const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
      if (r.error) return null;
      return { out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
    } catch {
      return null;
    }
  };

  // 1. `grep --version` — direct, then via the configured shell (Windows: grep
  //    isn't directly spawnable outside Git Bash's PATH).
  let v = run("grep", ["--version"]);
  if (v === null) v = run(shellPath, ["-c", "grep --version"]);
  if (v && /GNU grep/i.test(v.out)) return true;

  // 2. Capability probe: `--exclude-dir` accepted without an "unrecognized
  //    option" error (covers GNU builds whose --version text is unusual, and
  //    any other grep that genuinely supports the flag). `.` is the pattern and
  //    /dev/null the (empty) search target, so this never scans the cwd.
  const c = run(shellPath, ["-c", "grep --exclude-dir=__pi_probe__ . /dev/null"]);
  if (c && !/unrecognized|invalid option|unknown option|usage:/i.test(c.out)) return true;

  return false;
}
