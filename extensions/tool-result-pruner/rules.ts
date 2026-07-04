// Lossless rules for the tool-result-pruner pipeline (§7.2, tier 1).
//
// Every rule is:
//   - lossless: the agent sees semantically identical content, fewer bytes.
//   - self-caught: throws never escape (the pipeline also wraps each call).
//   - marker-free: lossless transforms don't get a fidelity marker (§7.3 —
//     markers are for lossy/recoverable changes only).
//
// Order matters (§7.2): ANSI → trailing-whitespace → blank-run collapse →
// JSON minify. ANSI first so structural detection sees clean bytes; minify
// last so it sees normalized text.

import type { Rule, RuleContext, RuleResult } from "./types.js";

/** Return the rewritten text if it differs from `input`, else null. Keeps the
 *  `changed` flag honest without repeating the comparison in each rule. */
function maybe(text: string, rewritten: string): RuleResult | null {
  return rewritten === text ? null : { text: rewritten, changed: true };
}

// ---------------------------------------------------------------------------
// 1. ANSI escape stripping
//
// Uses the ansi-regex pattern (chalk) covering CSI and OSC (BEL-terminated)
// sequences. Agents can't see color, and escapes bloat output ~1.5x.
// ---------------------------------------------------------------------------
const ANSI_RE =
  // eslint-disable-next-line no-control-regex, no-misleading-character-ranges
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function stripAnsi(text: string, _ctx: RuleContext): RuleResult | null {
  if (!text.includes("\u001B") && !text.includes("\u009B")) return null;
  return maybe(text, text.replace(ANSI_RE, ""));
}

// ---------------------------------------------------------------------------
// 2. Trailing-whitespace trim per line.
//
// Removes spaces/tabs/CR/FF/VT from the end of every line. Also incidentally
// normalizes CRLF → LF (the \r is trailing whitespace). Per-line so it never
// touches leading indentation, which is semantically meaningful.
// ---------------------------------------------------------------------------
const TRAILING_WS_RE = /[ \t\r\f\v]+$/gm;

function trimTrailingWhitespace(text: string, _ctx: RuleContext): RuleResult | null {
  // Multiline check: any line ending with horizontal/CR/FF/VT whitespace.
  if (!/[ \t\r\f\v]+$/m.test(text)) return null;
  return maybe(text, text.replace(TRAILING_WS_RE, ""));
}

// ---------------------------------------------------------------------------
// 3. Blank-run collapse (3+ → 1) + trim leading/trailing blank lines.
//
// A "blank" line is one with no non-whitespace chars. Three or more in a row
// collapse to a single blank line; the whole output also loses leading/trailing
// blank lines. Common after ANSI strip + log output.
// ---------------------------------------------------------------------------
function collapseBlankRuns(text: string, _ctx: RuleContext): RuleResult | null {
  if (!text.includes("\n")) return null;
  const lines = text.split("\n");
  // Detect whether any rewrite is warranted:
  //   - a blank-run of 3+ (collapse to 1)
  //   - leading or trailing blank lines (trim)
  //   - any whitespace-only line that is non-empty (normalize to "") —
  //     trim-trailing-whitespace only strips ASCII horizontal ws; a line of
  //     U+00A0 (NBSP) survives it and would otherwise stay as a noisy line.
  let hasLongRun = false;
  let hasNonEmptyBlank = false;
  let run = 0;
  let leadingBlanks = 0;
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blank = line.trim() === "";
    if (blank) {
      run++;
      if (run >= 3) hasLongRun = true;
      if (line !== "") hasNonEmptyBlank = true;
    } else {
      run = 0;
      if (firstNonBlank === -1) {
        firstNonBlank = i;
        leadingBlanks = i;
      }
    }
  }
  const trailingBlanks = firstNonBlank === -1 ? lines.length : lines.length - 1 - lastNonBlankIndex(lines);
  const needsCollapse = hasLongRun || hasNonEmptyBlank || leadingBlanks > 0 || trailingBlanks > 0;
  if (!needsCollapse) return null;

  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blankRun++;
      if (blankRun <= 1) out.push(""); // normalize whitespace-only → empty
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  // Trim leading/trailing blank lines.
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return maybe(text, out.join("\n"));
}

function lastNonBlankIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 4. JSON minify (validate-then-minify).
//
// Only fires when the trimmed text is a single JSON document (starts with `{`
// or `[` and parses cleanly). Emits canonical JSON.stringify output. Falls
// back to raw on any parse failure ("uncertain → keep", §7.4).
//
// Semantically identical JSON, typically 40–60% smaller on pretty-printed
// configs. Note: the agent recovers human formatting via the un-pruned `read`
// tool (the whole pipeline skips `read`, §7.4) — so this never desyncs edits.
// ---------------------------------------------------------------------------
function minifyJson(text: string, _ctx: RuleContext): RuleResult | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // not JSON, or surrounded by other text — keep raw
  }
  const minified = JSON.stringify(parsed);
  // Only claim a change if minification actually shrank anything. Preserves a
  // trailing newline the tool may have emitted, since that's not JSON-owned.
  const hadTrailingNewline = text.endsWith("\n");
  const candidate = hadTrailingNewline ? minified + "\n" : minified;
  return maybe(text, candidate);
}

// ---------------------------------------------------------------------------
// Ordered pipeline (§7.2). Lossy rules will be appended after this list when
// the recall stash lands; the pipeline gates them on profile + stash.
// ---------------------------------------------------------------------------
export const LOSSLESS_RULES: Rule[] = [
  { name: "ansi-strip", tier: "lossless", run: stripAnsi },
  { name: "trim-trailing-whitespace", tier: "lossless", run: trimTrailingWhitespace },
  { name: "collapse-blank-runs", tier: "lossless", run: collapseBlankRuns },
  { name: "minify-json", tier: "lossless", run: minifyJson },
];