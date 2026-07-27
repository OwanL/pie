import os from 'node:os';
import path from 'node:path';

// ─── Bash/shell deletion parsing ───────────────────────────────────────────
//
// Files are frequently deleted through the bash tool (`rm path`) rather than a
// dedicated delete tool. The bash input is `{ command: "..." }` with no `path`
// field, so `extractFilePath` cannot see them. These helpers scan the command
// string for deletion commands and recover the targeted paths.
//
// Lifted from host/core/shell-deletion-parsing.ts into shared/ so both the
// host's in-memory derivation and the session-changes extension's JSONL
// re-derivation call one implementation. Pure (only node builtins) — host- and
// vscode-agnostic.

function looksLikeGlob(p: string): boolean {
  return /[*?[\]]/.test(p);
}

/** Tokenize a single shell segment, honoring single/double quotes and
 *  backslash escapes. Stops at the first redirect/pipe operator — anything
 *  after `|`, `>`, or `<` is not a target of the preceding command. */
function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  const s = segment.trim();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (/[|<>]/.test(s[i])) break;
    let tok = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < s.length && s[i] !== quote) {
          tok += s[i];
          i++;
        }
        if (i < s.length) i++;
      } else if (ch === '\\') {
        i++;
        if (i < s.length) {
          tok += s[i];
          i++;
        }
      } else if (/[|<>]/.test(ch)) {
        // Shell redirections can be attached to the preceding token (`a>out`)
        // or to a file descriptor (`2>/dev/null`). Keep a real argument before
        // the operator, but never report the descriptor/redirection as a path.
        if (tok !== '' && !/^\d+$/.test(tok)) tokens.push(tok);
        return tokens;
      } else {
        tok += ch;
        i++;
      }
    }
    if (tok !== '') tokens.push(tok);
  }
  return tokens;
}

/** Expand a leading `~` or `~user` to the user's home directory.
 *  `~` alone → home dir; `~/foo` → home/foo; `~user/foo` is left as-is
 *  (resolving another user's home requires a passwd lookup we don't do). */
function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  // `~user/...` — can't resolve without passwd; leave as-is.
  return p;
}

/** Expand the first brace-expression in a token into a list of strings.
 *  `file{1,2,3}.ts` → `file1.ts file2.ts file3.ts`
 *  `src/{a,b}/x.ts` → `src/a/x.ts src/b/x.ts`
 *  Supports nested braces and multiple comma options. Only the outermost
 *  leftmost brace group is expanded; any remaining braces in the expanded
 *  pieces are expanded recursively. */
function expandBraces(token: string): string[] {
  const start = token.indexOf('{');
  if (start === -1) return [token];

  // Find the matching `}` for the brace at `start`.
  let depth = 0;
  let end = -1;
  for (let i = start; i < token.length; i++) {
    if (token[i] === '{') depth++;
    else if (token[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return [token]; // unbalanced — leave as-is

  const prefix = token.slice(0, start);
  const suffix = token.slice(end + 1);
  const body = token.slice(start + 1, end);

  // Split on top-level commas (commas inside nested braces belong to the
  // nested group, which will be expanded in the recursive call).
  const options: string[] = [];
  let nestedDepth = 0;
  let last = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = i < body.length ? body[i] : ',';
    if (ch === '{') nestedDepth++;
    else if (ch === '}') nestedDepth--;
    else if (ch === ',' && nestedDepth === 0) {
      options.push(body.slice(last, i));
      last = i + 1;
    }
  }

  if (options.length <= 1) return [token]; // `{x}` or `{}` — literal

  const results: string[] = [];
  for (const opt of options) {
    const piece = prefix + opt + suffix;
    // Recursively expand any remaining brace groups in the piece.
    for (const expanded of expandBraces(piece)) {
      results.push(expanded);
    }
  }
  return results;
}

/** Collect path targets for a single deletion command, skipping flags/globs.
 *  Applies tilde and brace expansion to each candidate path. */
function collectDeletionTargets(cmd: string, args: string[]): string[] {
  const raw: string[] = [];
  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'unlink') {
    let afterDashDash = false;
    for (const t of args) {
      if (!afterDashDash && t === '--') { afterDashDash = true; continue; }
      if (!afterDashDash && t.startsWith('-')) continue;
      if (looksLikeGlob(t)) continue;
      raw.push(t);
    }
  } else if (cmd === 'del') {
    // Windows `del`: flags start with `/`
    for (const t of args) {
      if (t.startsWith('/')) continue;
      if (looksLikeGlob(t)) continue;
      raw.push(t);
    }
  } else if (cmd === 'remove-item' || cmd === 'ri') {
    // PowerShell Remove-Item: flags start with `-`
    for (const t of args) {
      if (t.startsWith('-')) continue;
      if (looksLikeGlob(t)) continue;
      raw.push(t);
    }
  } else if (cmd === 'trash' || cmd === 'trash-put' || cmd === 'trash-cli') {
    // `trash` CLI: flags start with `-`
    for (const t of args) {
      if (t.startsWith('-')) continue;
      if (looksLikeGlob(t)) continue;
      raw.push(t);
    }
  }

  // Apply brace expansion then tilde expansion to each raw target.
  const out: string[] = [];
  for (const t of raw) {
    for (const expanded of expandBraces(t)) {
      out.push(expandTilde(expanded));
    }
  }
  return out;
}

/** Parse a bash/shell command string and return literal file paths targeted by
 *  a deletion command (`rm`, `rmdir`, `unlink`, `del`, `Remove-Item`, `git rm`,
 *  `trash`). Globs are excluded (the actual deleted paths can't be known
 *  without a filesystem listing), `git rm --cached` is ignored (index-only),
 *  and nested shells (`bash -c "rm file"`) are recursively parsed.
 *  Tilde (`~`) and brace (`{a,b}`) expansion is applied to each path. */
export function parseDeletedPathsFromCommand(command: string): string[] {
  if (typeof command !== 'string') return [];
  const trimmed = command.trim();
  if (!trimmed) return [];

  const paths: string[] = [];
  // Split on command separators so `cd d && rm f` and `a; rm b` are covered.
  const segments = trimmed.split(/(?:&&|\|\||;|\n)/);

  for (const seg of segments) {
    const tokens = tokenizeShellSegment(seg);
    if (tokens.length === 0) continue;

    // Skip leading `sudo` / env-var assignments (`FOO=bar`).
    let idx = 0;
    while (idx < tokens.length && (tokens[idx] === 'sudo' || tokens[idx] === 'env' || /^\w+=/.test(tokens[idx]))) {
      idx++;
    }
    if (idx >= tokens.length) continue;
    const cmd = tokens[idx].toLowerCase();

    // Nested shell: `bash -c "rm file"` / `sh -c "..."` / `zsh -c "..."`.
    // Recursively parse the string argument after `-c`.
    if ((cmd === 'bash' || cmd === 'sh' || cmd === 'zsh' || cmd === 'dash') && idx + 2 < tokens.length) {
      let cIdx = idx + 1;
      // Skip flags between the shell command and `-c` (e.g. `bash -e -c "..."`).
      while (cIdx < tokens.length && tokens[cIdx] !== '-c') {
        if (tokens[cIdx].startsWith('-')) { cIdx++; continue; }
        break;
      }
      if (cIdx < tokens.length && tokens[cIdx] === '-c' && cIdx + 1 < tokens.length) {
        const innerCommand = tokens[cIdx + 1];
        paths.push(...parseDeletedPathsFromCommand(innerCommand));
        continue;
      }
    }

    if (cmd === 'git') {
      // Locate the `rm` subcommand, tolerating global git flags that take a
      // value (`-C <path>`, `--git-dir <path>`, `--work-tree <path>`).
      let j = idx + 1;
      while (j < tokens.length) {
        const t = tokens[j].toLowerCase();
        if (t === 'rm') break;
        if (t === '-c' || t === '--git-dir' || t === '--work-tree') {
          j += 2;
          continue;
        }
        if (t.startsWith('-')) { j++; continue; }
        // A non-flag token that isn't `rm` ⇒ different subcommand; bail.
        j = tokens.length;
        break;
      }
      if (j >= tokens.length || tokens[j].toLowerCase() !== 'rm') continue;
      const rmArgs = tokens.slice(j + 1);
      // `--cached` removes from the index only, not the working tree.
      if (rmArgs.some((a) => a === '--cached')) continue;
      paths.push(...collectDeletionTargets('rm', rmArgs));
    } else {
      paths.push(...collectDeletionTargets(cmd, tokens.slice(idx + 1)));
    }
  }

  return paths;
}
