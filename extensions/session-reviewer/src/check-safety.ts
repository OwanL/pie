import type { ReviewerCheckSpec } from './types.js';

const SHELL_CONTROL = /[\r\n;&|<>`]|\$\(|\$\{|\$[A-Za-z_]/;

function words(command: string): string[] | undefined {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && index + 1 < command.length) current += command[++index]!;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) { result.push(current); current = ''; } }
    else current += char;
  }
  if (quote) return undefined;
  if (current) result.push(current);
  return result;
}
function safeGit(args: string[]): boolean {
  if (args[0]?.toLowerCase() !== 'diff') return false;
  const separator = args.indexOf('--');
  const controlArgs = separator < 0 ? args.slice(1) : args.slice(1, separator);
  if (!controlArgs.includes('--no-ext-diff') || !controlArgs.includes('--no-textconv')) return false;
  const safeFlags = new Set([
    '--no-ext-diff', '--no-textconv', '--no-color', '--cached', '--staged', '--stat', '--numstat', '--shortstat',
    '--name-only', '--name-status', '--compact-summary', '--check', '--quiet', '--exit-code', '--merge-base', '--relative',
  ]);
  return controlArgs.every((arg) => !arg.startsWith('-') || safeFlags.has(arg)
    || /^--relative=.+/.test(arg) || /^--unified=\d+$/.test(arg) || /^-U\d+$/.test(arg));
}
function safeSearch(command: string, args: string[]): boolean {
  if (command === 'rg' || command === 'ripgrep') {
    return !args.some((arg) => arg === '--pre' || arg.startsWith('--pre=') || arg === '--hostname-bin' || arg.startsWith('--hostname-bin=') || arg === '--type-add');
  }
  return command === 'grep';
}

/**
 * Conservative command allowlist. Package scripts, compilers, interpreters, and
 * caller-supplied "safe mode" flags are never trusted: unsupported commands are
 * declined because their implementation cannot be guaranteed read-only.
 */
export function checkSafety(spec: ReviewerCheckSpec): { safe: true } | { safe: false; reason: 'mutating' } {
  if (spec.kind === 'static_inspection') return { safe: true };
  const command = spec.command.trim();
  if (!command || SHELL_CONTROL.test(command)) return { safe: false, reason: 'mutating' };
  const tokens = words(command);
  if (!tokens?.length) return { safe: false, reason: 'mutating' };
  const executable = tokens[0]!.toLowerCase().replace(/\.exe$/, '');
  const args = tokens.slice(1);
  let safe = false;
  if (executable === 'git') safe = safeGit(args);
  else if (executable === 'rg' || executable === 'ripgrep' || executable === 'grep') safe = safeSearch(executable, args);
  else if (['cat', 'head', 'tail', 'wc', 'stat', 'readlink', 'pwd', 'ls'].includes(executable)) safe = true;
  return safe ? { safe: true } : { safe: false, reason: 'mutating' };
}
