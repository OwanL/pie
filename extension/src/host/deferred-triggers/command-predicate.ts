import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import {
  MAX_COMMAND_TIMEOUT_MS,
  type CommandPredicateExecutionResult,
  type CommandTrigger,
} from '../../../../shared/wake-conditions';

/** Keep predicate diagnostics useful without allowing command output to become a
 * host-side memory or renderer payload sink. stdout and stderr are captured only
 * within this bound for diagnostics; exit status determines the predicate result. */
export const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
export const COMMAND_PROCESS_KILL_GRACE_MS = 250;

export interface CommandPredicateShellSelection {
  shellPath: string;
  env: NodeJS.ProcessEnv;
}

export interface CommandPredicateRunnerOptions {
  /** Override platform/shell resolution in deterministic tests. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  shellPath?: string;
  exists?: (candidate: string) => boolean;
  spawnProcess?: typeof spawn;
  killProcessTree?: (child: ChildProcess, platform: NodeJS.Platform) => void;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

/** Injectable runner seam used by the registry and its deterministic tests. */
export type CommandPredicateRunner = (
  spec: CommandTrigger,
  signal?: AbortSignal,
) => Promise<CommandPredicateExecutionResult>;

/**
 * Resolve the same class of shell used by the ordinary bash tool without
 * routing a deferred predicate through a model turn. POSIX uses the configured
 * shell (or bash); Windows deliberately prefers a real Git Bash installation
 * over the System32 WSL launcher.
 */
export function resolveCommandPredicateShell(
  options: Pick<CommandPredicateRunnerOptions, 'platform' | 'env' | 'shellPath' | 'exists'> = {},
): CommandPredicateShellSelection {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const explicit = options.shellPath?.trim() || env.PIE_SHELL?.trim();
  // An explicit PIE_SHELL/configured override is user-owned. Match warm-bash's
  // contract and do not silently rewrite it to another executable.
  if (explicit) return { shellPath: explicit, env };

  if (platform === 'win32') {
    const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter((value): value is string => Boolean(value));
    const candidates = [
      ...roots.flatMap((root) => [
        path.win32.join(root, 'Git', 'bin', 'bash.exe'),
        path.win32.join(root, 'Git', 'usr', 'bin', 'bash.exe'),
      ]),
      env.LOCALAPPDATA
        ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
        : undefined,
      env.LOCALAPPDATA
        ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'bash.exe')
        : undefined,
    ];
    for (const candidate of candidates) {
      if (candidate && exists(candidate) && !isWslLauncher(candidate, env, platform)) {
        return optimizeConfiguredShell(candidate, env, platform, exists);
      }
    }
    // Let CreateProcess resolve a Git Bash path supplied by PATH when the
    // installation is non-standard. Do not fall back to cmd.exe: predicates
    // are registered as shell commands and are expected to run under bash.
    return { shellPath: 'bash.exe', env };
  }

  for (const candidate of [env.SHELL, '/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh']) {
    if (candidate?.trim() && (candidate === 'bash' || exists(candidate))) {
      return { shellPath: candidate, env };
    }
  }
  return { shellPath: 'bash', env };
}

/** Build a bounded shell runner. A fresh process is used for every poll so a
 * predicate cannot leak cwd, shell state, or output into the next condition. */
export function createCommandPredicateRunner(
  options: CommandPredicateRunnerOptions = {},
): CommandPredicateRunner {
  const platform = options.platform ?? process.platform;
  const selection = resolveCommandPredicateShell(options);
  const spawnProcess = options.spawnProcess ?? spawn;
  const maxOutputBytes = Math.max(1, Math.floor(options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES));
  const killGraceMs = Math.max(0, Math.floor(options.killGraceMs ?? COMMAND_PROCESS_KILL_GRACE_MS));
  const killProcessTree = options.killProcessTree ?? defaultKillProcessTree;

  return (spec, signal) => runCommandPredicateProcess({
    spec,
    signal,
    platform,
    selection,
    spawnProcess,
    maxOutputBytes,
    killGraceMs,
    killProcessTree,
  });
}

interface RunProcessOptions {
  spec: CommandTrigger;
  signal?: AbortSignal;
  platform: NodeJS.Platform;
  selection: CommandPredicateShellSelection;
  spawnProcess: typeof spawn;
  maxOutputBytes: number;
  killGraceMs: number;
  killProcessTree: (child: ChildProcess, platform: NodeJS.Platform) => void;
}

function runCommandPredicateProcess({
  spec,
  signal,
  platform,
  selection,
  spawnProcess,
  maxOutputBytes,
  killGraceMs,
  killProcessTree,
}: RunProcessOptions): Promise<CommandPredicateExecutionResult> {
  const timeoutMs = Math.max(1, Math.min(spec.timeoutMs, MAX_COMMAND_TIMEOUT_MS));
  if (signal?.aborted) return Promise.resolve({ error: 'command predicate aborted' });

  let child: ChildProcess;
  try {
    child = spawnProcess(
      selection.shellPath,
      shellArgs(selection.shellPath, platform, spec.command),
      {
        cwd: spec.cwd,
        env: selection.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: platform === 'win32',
      },
    );
  } catch (error) {
    return Promise.resolve({ exitCode: null, error });
  }

  return new Promise<CommandPredicateExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError: unknown;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let hardSettleHandle: NodeJS.Timeout | undefined;

    const append = (current: string, chunk: unknown, usedBytes: number): { value: string; bytes: number; exceeded: boolean } => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const remaining = Math.max(0, maxOutputBytes - usedBytes);
      const accepted = buffer.subarray(0, remaining);
      const value = current + accepted.toString('utf8');
      return {
        value,
        bytes: usedBytes + accepted.byteLength,
        exceeded: buffer.byteLength > remaining,
      };
    };

    const terminate = (): void => {
      try {
        killProcessTree(child, platform);
      } catch {
        // A disappearing child is already a completed predicate attempt.
      }
    };

    const settle = (code: number | null, signalName: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (hardSettleHandle) clearTimeout(hardSettleHandle);
      if (signal) signal.removeEventListener('abort', onAbort);
      const result: CommandPredicateExecutionResult = {
        exitCode: code,
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true } : {}),
        ...(outputLimitExceeded
          ? { error: `command predicate output exceeded ${maxOutputBytes} byte limit` }
          : spawnError !== undefined
            ? { error: spawnError }
            : aborted
              ? { error: 'command predicate aborted' }
              : signalName
                ? { error: `command predicate terminated by ${signalName}` }
                : {}),
      };
      resolve(result);
    };

    const scheduleHardSettle = (): void => {
      if (hardSettleHandle) return;
      hardSettleHandle = setTimeout(() => settle(null, null), killGraceMs);
    };

    const onAbort = (): void => {
      if (settled || aborted) return;
      aborted = true;
      terminate();
      scheduleHardSettle();
    };

    child.stdout?.on('data', (chunk: unknown) => {
      if (settled || outputLimitExceeded) return;
      const next = append(stdout, chunk, stdoutBytes);
      stdout = next.value;
      stdoutBytes = next.bytes;
      if (next.exceeded) {
        outputLimitExceeded = true;
        terminate();
        scheduleHardSettle();
      }
    });
    child.stderr?.on('data', (chunk: unknown) => {
      if (settled || outputLimitExceeded) return;
      const next = append(stderr, chunk, stderrBytes);
      stderr = next.value;
      stderrBytes = next.bytes;
      if (next.exceeded) {
        outputLimitExceeded = true;
        terminate();
        scheduleHardSettle();
      }
    });
    child.once('error', (error: unknown) => {
      spawnError = error;
    });
    child.once('close', (code: number | null, signalName: NodeJS.Signals | null) => {
      settle(code, signalName);
    });

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    if (!settled && !aborted) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
        scheduleHardSettle();
      }, timeoutMs);
    }
  });
}

function shellArgs(shellPath: string, platform: NodeJS.Platform, command: string): string[] {
  const isBash = platform === 'win32'
    || /(?:^|[\\/])bash(?:\.exe)?$/i.test(shellPath)
    || shellPath === 'bash';
  return isBash
    ? ['--norc', '--noprofile', '-c', command]
    : ['-c', command];
}

function optimizeConfiguredShell(
  shellPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (candidate: string) => boolean,
): CommandPredicateShellSelection {
  if (platform !== 'win32') return { shellPath, env };
  if (!/[\\/]bin[\\/]bash\.exe$/i.test(shellPath)) return { shellPath, env };

  const gitRoot = path.win32.dirname(path.win32.dirname(shellPath));
  const direct = path.win32.join(gitRoot, 'usr', 'bin', 'bash.exe');
  const gitCmd = path.win32.join(gitRoot, 'cmd', 'git.exe');
  const runtimes = ['mingw64', 'mingw32', 'clangarm64'] as const;
  const runtime = runtimes.find((name) => exists(path.win32.join(gitRoot, name, 'bin')));
  if (!exists(direct) || !exists(gitCmd) || !runtime) return { shellPath, env };

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const home = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH
    ? `${env.HOMEDRIVE}${env.HOMEPATH}`
    : undefined);
  const prefix = [
    path.win32.join(gitRoot, runtime, 'bin'),
    path.win32.join(gitRoot, 'usr', 'bin'),
    home ? path.win32.join(home, 'bin') : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return {
    shellPath: direct,
    env: {
      ...env,
      EXEPATH: env.EXEPATH ?? path.win32.join(gitRoot, 'bin'),
      MSYSTEM: env.MSYSTEM ?? runtime.toUpperCase(),
      PLINK_PROTOCOL: env.PLINK_PROTOCOL ?? 'ssh',
      [pathKey]: [...prefix, env[pathKey] ?? ''].filter(Boolean).join(';'),
    },
  };
}

function isWslLauncher(candidate: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const systemRoot = env.SystemRoot ?? 'C:\\Windows';
  const system32 = path.win32.join(systemRoot, 'System32').toLowerCase();
  return path.win32.normalize(candidate).toLowerCase() === path.win32.join(system32, 'bash.exe');
}

/** Kill the shell and its descendants without waiting on the extension host. */
export function defaultKillProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (platform === 'win32') {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => undefined);
      killer.unref();
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // The process may have exited between the timeout and the kill attempt.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already dead.
  }
}
