/**
 * Classify a bash command string for the warm-bash fast path.
 *
 * Returns either:
 *   - { kind: "simple", program, args, ... } — safe to exec directly with NO shell
 *   - { kind: "shell", ... }                — needs a shell (pipes / redirects / globs / && / heredocs)
 *
 * "simple" = one program + arguments with no shell metacharacters outside quotes.
 * A leading `cd <dir> && <rest>` is peeled so the remainder can still be
 * fast-pathed with an effective cwd. This handles the dominant agent pattern
 * where the model simulates a per-call cwd with `cd ... &&` because the bash
 * tool has no cwd parameter. (See scripts/analyze-bash.mjs — ~60% of shell-needing
 * commands carry a `cd` prefix.)
 *
 * Classification is CONSERVATIVE: when in doubt, return "shell". A wrong
 * "simple" verdict would run a shell-needing command without a shell (wrong
 * output); a wrong "shell" verdict just takes the existing path (correct, slower).
 */

const CD_PREFIX = /^cd\s+("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s&|;()<>]+)\s*&&\s*([\s\S]+)$/;
// Exported for reuse by auto-prune.ts (segment tokenizing / quote stripping).
export const QUOTED = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g;
export const TOKEN = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g;
export const HEREDOC = /<<-?\s*['"]?\w/;
const OPERATORS = /[\n|;&]|\|\||&&|>>|<|>|`|\$\(|\$\{/;

// Shell builtins have no binary to execFile; routing them to the shell avoids a
// pointless ENOENT round-trip. `echo` is intentionally absent — it is handled
// in-process by the fast path (and falls back to the shell when it has flags).
const BUILTINS = new Set([
  "cd", "pushd", "popd", "export", "set", "unset", "unsetopt", "setopt",
  "alias", "unalias", "source", ".", "eval", "exec", "trap", "umask",
  "read", "wait", "jobs", "fg", "bg", "disown", "hash", "type", "builtin",
  "command", "enable", "help", "history", "let", "local", "declare",
  "typeset", "readonly", "getopts", "mapfile", "readarray", "caller",
  "shopt", "complete", "compgen", "bind", "coproc", "ulimit", "return",
]);

export interface Classification {
  kind: "simple" | "shell";
  /** Command with any leading `cd <dir> && ` peeled off. For the warm path the
   *  wrapper re-applies `cd "<cwd>"`, so this is the thing the shell should run. */
  rest: string;
  /** Peeled `cd` target (relative), or null when there was no leading cd. */
  cwd: string | null;
  hasHeredoc: boolean;
  /** Present only for kind === "simple". */
  program?: string;
  args?: string[];
}

export function classify(command: string): Classification {
  const c = command.trim();
  if (!c) return { kind: "shell", rest: c, cwd: null, hasHeredoc: false };

  let cwd: string | null = null;
  let rest = c;
  const cd = c.match(CD_PREFIX);
  if (cd) {
    cwd = unquote(cd[1]!);
    rest = cd[2]!;
  }

  const hasHeredoc = HEREDOC.test(rest);
  if (hasHeredoc) return { kind: "shell", rest, cwd, hasHeredoc: true };

  // Strip quoted spans so operators/globs/vars inside quotes don't route to shell.
  const stripped = rest.replace(QUOTED, "");
  if (OPERATORS.test(stripped)) return { kind: "shell", rest, cwd, hasHeredoc };
  if (/[*?~]/.test(stripped)) return { kind: "shell", rest, cwd, hasHeredoc }; // bare glob/tilde
  if (/\$/.test(stripped)) return { kind: "shell", rest, cwd, hasHeredoc }; // var expansion
  if (/\\/.test(stripped)) return { kind: "shell", rest, cwd, hasHeredoc }; // unquoted backslash escape
  if (/\{[^{}]*,[^{}]*\}/.test(stripped)) return { kind: "shell", rest, cwd, hasHeredoc }; // brace expansion
  if (/^\s*\w+=/.test(rest)) return { kind: "shell", rest, cwd, hasHeredoc }; // env-assignment prefix

  const tokens = tokenize(rest);
  if (tokens.length === 0) return { kind: "shell", rest, cwd, hasHeredoc };
  const program = tokens[0]!;
  if (BUILTINS.has(program)) return { kind: "shell", rest, cwd, hasHeredoc };

  return { kind: "simple", rest, cwd, hasHeredoc, program, args: tokens.slice(1) };
}

/** Strip one layer of surrounding single/double quotes. Exported for auto-prune.ts. */
export function unquote(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(TOKEN)) out.push(unquote(m[0]));
  return out;
}