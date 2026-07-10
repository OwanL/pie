import * as cp from 'node:child_process';

import { resolveCommandInvocation } from './command-invocation';
import type { CommandResult } from './runtime-resolution';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * A `CommandExecutor` that additionally accepts an optional `ExecFileOptions` so
 * callers can override the default timeout/maxBuffer. Assignable to
 * `CommandExecutor` (the options param is optional), so it works wherever a
 * plain `CommandExecutor` is expected.
 */
type CommandExecutorWithOptions = (
  command: string,
  args: string[],
  options?: cp.ExecFileOptions,
) => Promise<CommandResult>;

/**
 * Creates a `CommandExecutor` that routes commands through the appropriate
 * shell on the current platform (e.g. `npm` on Windows runs via cmd.exe).
 */
export function createCommandExecutor(platform?: NodeJS.Platform): CommandExecutorWithOptions {
  return (command, args, options?) => {
    const invocation = resolveCommandInvocation(command, args, { platform });
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      cp.execFile(
        invocation.command,
        invocation.args,
        { timeout, maxBuffer: DEFAULT_MAX_BUFFER_BYTES, encoding: 'utf8', ...options },
        (err, stdout, stderr) => {
          if (err && (err.killed === true || err.signal === 'SIGTERM')) {
            err.message = `Command timed out after ${timeout}ms: ${command}`;
          }
          // err.code is a string like 'ENOENT' for spawn errors; normalise to 1.
          // Coerce stdout/stderr to strings: a caller-supplied `encoding` option
          // (via ...options) can make these Buffers, but the default is utf8 strings.
          const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({
            stdout: typeof stdout === 'string' ? stdout : (stdout?.toString('utf8') ?? ''),
            stderr: typeof stderr === 'string' ? stderr : (stderr?.toString('utf8') ?? ''),
            exitCode,
          });
        },
      );
    });
  };
}
