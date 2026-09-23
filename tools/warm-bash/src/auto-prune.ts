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
 * etc.), while this uses the canonical protected-directory policy from
 * shared/traversal-policy.ts (plus the static trade-offs described there). The two diverge in
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
 *   - Scoped opt-in is preserved: a grep whose path operand deliberately
 *     targets a protected tree (e.g. `grep -rn foo data/`) is passed through
 *     unpruned so the scoped inspection still returns results.
 *   - Grep commands that already carry some --exclude-dir flags are completed,
 *     not skipped: only the canonical exclusions they are MISSING are injected,
 *     and an already-present directory is never duplicated.
 *   - Unsupported bare-root walkers (`ls -R`, `tree`, and `du`) have no safe
 *     prune mechanism, so they are rewritten to a bounded FAIL-FAST rejection
 *     (explanatory stderr message + nonzero exit) instead of traversing known
 *     multi-gigabyte trees. Exact/scoped inspection (`tree src`, `du data`)
 *     passes through, and the explicit `PIE_BASH_AUTO_PRUNE=0` assignment
 *     prefix opts out entirely.
 *
 * Reassembly is byte-preserving at the SEGMENT level: only segments whose
 * program was rewritten have their substring spliced; every separator, newline,
 * and whitespace run between segments is left identical (byte-preservation guard).
 */

import { spawnSync } from "node:child_process";
import {
  findPruneExpression,
  PROTECTED_DIRECTORY_NAMES,
  PROTECTED_DIRECTORY_REF,
  referencesProtectedDirectory,
} from "../../../shared/traversal-policy.js";
import { QUOTED, TOKEN, HEREDOC, unquote } from "./classifier.js";

/** Options for {@link rewriteForPrune}. */
export interface PruneOpts {
  /** Lazy GNU-grep probe (cached by the caller). grep injection is gated on it. */
  gnuGrepProbe: () => boolean;
}

/** Prune/exclude directories come from the canonical traversal-safety policy
 *  (shared/traversal-policy.ts): dependencies, version control, generated/build
 *  output, caches, coverage, runtime data, sessions, logs, packaged artifacts,
 *  and temporary SDK trees. One policy, three consumers (warm-bash,
 *  codebase-maintenance .ignore drift checks, subagent prompts). */
const FIND_PRUNE_EXPR = findPruneExpression();

/** Shell control keywords → passthrough the WHOLE command. Word-boundary
 *  so `foreach` / `#include` (quoted) don't false-trigger. */
const CONTROL_KEYWORD = /\b(for|while|until|if|then|case|do|function)\b/;

/** A `#` that begins a shell comment: at start, or preceded by whitespace / a
 *  shell operator / subshell paren / redirect. (Quotes are already stripped.) */
const COMMENT_START = /(^|[\s;&|()<>])#/;

/** Leading env-assignment token: `NAME=value` (NOT `--exclude-dir=...`, which
 *  starts with `-`). */
const ASSIGN = /^[A-Za-z_]\w*=/;

/** find primaries that take a name/path pattern argument (used to detect explicit prune-dir searches). */
/** find primaries that take a name/path pattern argument (used to detect explicit prune-dir searches).
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
const PRUNE_DIR_REF = PROTECTED_DIRECTORY_REF;

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
  // A heredoc body is unquoted free text that may contain `;`, `&&`, and
  // even literal `grep -rn foo .`-looking lines. Never split/rewrite it.
  if (HEREDOC.test(command)) return command;

  // Shell control structures and comments are passthrough-the-whole-
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
 *  run between segments identical (byte-preservation guard). */
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
  if (name === "ls") {
    return rewriteLsSegment(text, toks, idx, prog);
  }
  if (name === "tree" || name === "du") {
    return rewriteUnsupportedRootWalker(text, toks, idx, prog, name);
  }
  return text; // rule 3 passthrough (rg, xargs grep …, etc.)
}

function rewriteGrepSegment(
  text: string,
  toks: RawTok[],
  progIdx: number,
  prog: RawTok,
  opts: PruneOpts,
): string {
  const args = toks.slice(progIdx + 1);

  // Recursive? GNU grep supports both clustered short flags and long forms.
  let recursive = false;
  for (const t of args) {
    const v = t.value;
    if (v === "--recursive" || v === "--dereference-recursive"
      || (v.startsWith("-") && !v.startsWith("--") && /[rR]/.test(v.slice(1)))) {
      recursive = true;
      break;
    }
  }
  if (!recursive) return text;

  // Scoped opt-in: a path operand deliberately aimed at a protected tree (e.g.
  // `grep -rn foo data/`) must not be pruned into an empty result — passthrough.
  if (referencesProtectedPath(args)) return text;

  // Gate on GNU grep. --exclude-dir is a GNU extension; a BSD/busybox
  // grep lacking it would ERROR the command — strictly worse than status quo.
  // NOTE: this also documents the GNU-grep dependency for the injection below.
  if (!opts.gnuGrepProbe()) return text;

  // Complete the canonical policy instead of all-or-nothing: inject ONLY the
  // protected directories the command does not already exclude, and never
  // duplicate a flag the caller already carries. A command that already covers
  // every canonical directory passes through byte-identical.
  const existing = existingExcludeDirValues(args);
  const missing = PROTECTED_DIRECTORY_NAMES.filter((d) => !existing.has(d));
  if (missing.length === 0) return text;
  const insert = ` ${missing.map((d) => `--exclude-dir=${d}`).join(" ")}`;
  // Inject flags immediately after the program token (pipe-safe: the rest of the
  // segment — args, redirects, etc. — follows unchanged).
  return text.slice(0, prog.end) + insert + text.slice(prog.end);
}

/** Values already excluded by the command itself, from both flag spellings:
 *  `--exclude-dir=V` and `--exclude-dir V`. Exact basename match against the
 *  canonical names is the dedupe rule; a user glob (e.g. `'*sdk*'`) is NOT
 *  treated as covering a canonical entry (harmless: we would only add a flag
 *  that is not a duplicate of theirs). */
function existingExcludeDirValues(args: RawTok[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const v = args[i]!.value;
    if (v.startsWith("--exclude-dir=")) {
      out.add(v.slice("--exclude-dir=".length));
    } else if (v === "--exclude-dir") {
      const next = args[i + 1]?.value;
      if (next !== undefined) out.add(next);
    }
  }
  return out;
}

/** A non-option argument after the first one is a path operand; when one of
 *  them lives inside a protected tree the caller is deliberately inspecting it
 *  (scoped opt-in), so the segment passes through unpruned. */
function referencesProtectedPath(args: RawTok[]): boolean {
  let sawPattern = false;
  for (const t of args) {
    if (t.value.startsWith("-")) continue; // options (incl. --exclude-dir=…)
    if (!sawPattern) { sawPattern = true; continue; } // first operand = pattern
    if (referencesProtectedDirectory(t.value)) return true;
  }
  return false;
}

function rewriteFindSegment(text: string, toks: RawTok[], progIdx: number, prog: RawTok): string {
  const afterFind = toks.slice(progIdx + 1);
  if (hasExplicitTraversalOptOut(toks, progIdx)) return text;

  // Shell-expanded root globs turn into multiple unpruned find roots before
  // find starts. They cannot be safely rewritten, so reject them rather than
  // traversing every protected top-level tree. Scoped globs (`src/*`) pass.
  const leadingPaths: RawTok[] = [];
  for (const token of afterFind) {
    if (token.value.startsWith("-") || token.value === "(" || token.value === ")" || token.value === "!") break;
    leadingPaths.push(token);
  }
  if (leadingPaths.some((token) =>
    isBroadRootOperand(token.value) && !/^\.[\\/]*$/u.test(token.value))) {
    const prefix = text.slice(0, prog.start);
    const suffix = text.slice(toks[toks.length - 1]!.end);
    return `${prefix}echo "${broadWalkerRejectMessage("find root glob")}" >&2; (exit 2)${suffix}`;
  }

  // "No shell operators in the segment": a find reaching here was already split
  // on top-level operators, but it may still carry `$(…)`, backticks, globs,
  // redirects, or backslash escapes (`\( \) \;`). Any of those → passthrough.
  if (hasShellMeta(text.slice(prog.start))) return text;

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

  // Don't defeat explicit prune-dir searches. `-name node_modules` (or
  // -iname/-path/-ipath referencing node_modules/.git) would match the prune
  // branch and yield zero results.
  if (referencesPruneDir(exprTokens)) return text;

  const prefix = text.slice(0, prog.start); // leading whitespace + assignments
  const exprStr = exprTokens.map((t) => t.raw).join(" ");
  const pruneExpr = FIND_PRUNE_EXPR;
  const tail = exprStr ? `\\( ${exprStr} \\) -print` : "-print";
  // Preserve the segment's trailing bytes (whitespace after the last token) so
  // the splice is byte-faithful at the trailing edge — e.g. `find … *.ts ' ;`
  // keeps the space before the `;` rather than collapsing to `-print;`.
  const suffix = text.slice(toks[toks.length - 1]!.end);
  // Wrap the user expr in `\( … \)` to preserve OR-chain precedence, append -print.
  return `${prefix}${prog.raw} ${pathStr} \\( ${pruneExpr} \\) -prune -o ${tail}${suffix}`;
}

/** Bounded fail-fast for broad walkers the rewriter cannot express exclusions
 *  for (STABILITY-ARCHITECTURE-PLAN §7.7). `ls -R` has no prune mechanism at
 *  all, so a bare-root recursive listing would traverse known multi-gigabyte
 *  trees (runtime data, sessions, caches) with nothing to stop it. The segment
 *  is replaced with a rejection that explains itself on stderr and exits 2 via
 *  a SUBSHELL (`(exit 2)`) so the warm-pool marker protocol survives and the
 *  real exit code still propagates. Everything except a bare-root recursive
 *  ls passes through: exact listings, scoped inspection (`ls -R src`), and the
 *  explicit `PIE_BASH_AUTO_PRUNE=0` assignment prefix. */
function broadWalkerRejectMessage(command: string): string {
  return `pie warm-bash: bare-root '${command}' is blocked to avoid traversing ` +
    "protected and multi-gigabyte trees; scope it to a subdirectory, inspect an " +
    "exact protected path, or prefix the command with PIE_BASH_AUTO_PRUNE=0 to disable this guard.";
}

const LS_REJECT_MESSAGE = broadWalkerRejectMessage("ls -R");
const LS_OPTIONS_WITH_VALUE = new Set([
  "-I", "-T", "-w", "--block-size", "--format", "--hide", "--ignore",
  "--quoting-style", "--sort", "--tabsize", "--time", "--time-style", "--width",
]);

function rewriteLsSegment(text: string, toks: RawTok[], progIdx: number, prog: RawTok): string {
  const args = toks.slice(progIdx + 1);

  // Only the documented explicit override bypasses this guard. Ordinary
  // environment assignments (`LANG=C`) must not accidentally disable it.
  if (hasExplicitTraversalOptOut(toks, progIdx)) return text;

  // Recursive? `--recursive`, or any single-dash flag cluster containing `R`
  // (`-R`, `-laR`, `-1Ra`; GNU ls has no other flag with an `R`).
  let recursive = false;
  for (const t of args) {
    const v = t.value;
    if (v === "--recursive") { recursive = true; break; }
    if (v.startsWith("-") && !v.startsWith("--") && v.slice(1).includes("R")) {
      recursive = true;
      break;
    }
  }
  if (!recursive) return text;

  // Path operands: stop at a redirect, whose target is not an ls path. A
  // `.`/root glob/variable operand (or no operand — ls defaults to `.`) is an
  // unsupported root walk. A clearly scoped operand remains deliberate opt-in,
  // including a scoped glob such as `src/*`.
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!.value;
    if (/^\d*(?:>|>>|<)/u.test(value)) break;
    if (value.startsWith("--")) {
      const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
      if (!value.includes("=") && LS_OPTIONS_WITH_VALUE.has(option)) i += 1;
      continue;
    }
    if (value.startsWith("-")) {
      if (LS_OPTIONS_WITH_VALUE.has(value)) i += 1;
      continue;
    }
    paths.push(value);
  }
  const bareRoot = paths.length === 0 || paths.some((value) =>
    value.includes("$") || value.includes("`") || isBroadRootOperand(value));
  if (!bareRoot) return text;

  // Preserve the segment's leading bytes (whitespace, which for an accepted
  // rejection is never an assignment) so compound reassembly stays faithful.
  const prefix = text.slice(0, prog.start);
  const suffix = text.slice(toks[toks.length - 1]!.end);
  return `${prefix}echo "${LS_REJECT_MESSAGE}" >&2; (exit 2)${suffix}`;
}

const WALKER_OPTIONS_WITH_VALUE: Readonly<Record<'tree' | 'du', ReadonlySet<string>>> = {
  tree: new Set(["-L", "-P", "-I", "-o", "-H", "-T", "--filelimit", "--charset", "--infofile", "--fromfile"]),
  du: new Set(["-B", "-d", "-t", "-X", "--block-size", "--exclude", "--exclude-from", "--files0-from", "--max-depth", "--threshold", "--time-style"]),
};

const WALKER_LONG_OPTIONS_WITHOUT_VALUE: Readonly<Record<'tree' | 'du', ReadonlySet<string>>> = {
  tree: new Set(["--gitignore", "--ignore-case", "--matchdirs", "--metafirst", "--prune", "--info", "--noreport", "--si", "--du", "--inodes", "--device", "--dirsfirst", "--filesfirst", "--hyperlink", "--help", "--version"]),
  du: new Set(["--all", "--apparent-size", "--bytes", "--count-links", "--dereference", "--dereference-args", "--human-readable", "--inodes", "--kilobytes", "--local", "--null", "--separate-dirs", "--si", "--summarize", "--total", "--time", "--help", "--version"]),
};

const WALKER_SHORT_FLAG_CHARS: Readonly<Record<'tree' | 'du', ReadonlySet<string>>> = {
  tree: new Set("adlfxRqNQpsugDFtvcihJX"),
  du: new Set("aAbcDhHklLmnsSx0"),
};

function hasExplicitTraversalOptOut(toks: RawTok[], progIdx: number): boolean {
  const assignments = toks.slice(0, progIdx)
    .map((token) => token.value)
    .filter((value) => value.startsWith("PIE_BASH_AUTO_PRUNE="));
  return assignments[assignments.length - 1] === "PIE_BASH_AUTO_PRUNE=0";
}

function isBroadRootOperand(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "." || /^\.\/+$/u.test(normalized) || normalized === "*") return true;
  const relative = normalized.replace(/^\.\/+/, "");
  return /^[*?\[]/u.test(relative) || (relative.startsWith("{") && relative.includes("*"));
}

/** Reject common recursive walkers that cannot express the canonical policy.
 * A non-root path (including a protected path) is a deliberate scoped opt-in.
 * `*`/`./*` are treated as root walks because the shell would expand them to
 * every top-level protected tree before the command starts. */
function rewriteUnsupportedRootWalker(
  text: string,
  toks: RawTok[],
  progIdx: number,
  prog: RawTok,
  name: 'tree' | 'du',
): string {
  if (hasExplicitTraversalOptOut(toks, progIdx)) return text;
  const args = toks.slice(progIdx + 1);
  const paths: string[] = [];
  const optionsWithValue = WALKER_OPTIONS_WITH_VALUE[name];
  const longOptionsWithoutValue = WALKER_LONG_OPTIONS_WITHOUT_VALUE[name];
  const shortFlagChars = WALKER_SHORT_FLAG_CHARS[name];
  let endOfOptions = false;
  let ambiguous = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!.value;
    if (/^\d*(?:>|>>|<)/u.test(value)) break;
    if (!endOfOptions && value === "--") { endOfOptions = true; continue; }
    if (!endOfOptions && value.startsWith("--")) {
      const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
      if (optionsWithValue.has(option)) {
        if (!value.includes("=")) {
          if (args[i + 1] === undefined) ambiguous = true;
          else i += 1;
        }
      } else if (!longOptionsWithoutValue.has(option)) {
        ambiguous = true;
      }
      continue;
    }
    if (!endOfOptions && /^-[^-]/.test(value)) {
      if (optionsWithValue.has(value)) {
        if (args[i + 1] === undefined) ambiguous = true;
        else i += 1;
      } else if (![...value.slice(1)].every((flag) => shortFlagChars.has(flag))) {
        // Attached value forms such as -d2/-t1/-L3 are safe to classify.
        const option = value.slice(0, 2);
        if (!optionsWithValue.has(option) || value.length === 2) ambiguous = true;
      }
      continue;
    }
    paths.push(value);
  }
  const broad = ambiguous || paths.length === 0 || paths.some((value) =>
    value.includes("$") || value.includes("`") || isBroadRootOperand(value));
  if (!broad) return text;

  const prefix = text.slice(0, prog.start);
  const suffix = text.slice(toks[toks.length - 1]!.end);
  return `${prefix}echo "${broadWalkerRejectMessage(name)}" >&2; (exit 2)${suffix}`;
}

/** Shell-meta guard for the find rewrite AND the ls fail-fast: a candidate
 *  segment containing anything beyond plain flags/paths is passthrough
 *  (conservative). Mirror classifier.ts's shell-meta checks (without its
 *  cd-peel / builtin logic, which don't apply to a single split segment). Also
 *  catches bare `( )` (subshell grouping) which classifier's OPERATORS regex
 *  does not. */
function hasShellMeta(remainder: string): boolean {
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
