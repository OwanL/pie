import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function existing(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return trimmed && existsSync(trimmed) ? trimmed : null;
}

function isWslLauncher(candidate: string): boolean {
  if (process.platform !== 'win32') return false;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const system32 = path.win32.join(systemRoot, 'System32').toLowerCase();
  return path.win32.normalize(candidate).toLowerCase() === path.win32.join(system32, 'bash.exe');
}

/** Resolve a real bash executable for integration tests. On Windows the legacy
 * System32/bash.exe WSL launcher is not argv-compatible with Git Bash, so it is
 * deliberately excluded instead of producing misleading warmup failures. */
export function findTestBash(): string {
  const explicit = existing(process.env.PIE_SHELL);
  if (explicit) {
    if (isWslLauncher(explicit)) {
      throw new Error(`PIE_SHELL points to the WSL launcher (${explicit}); warm-bash tests require Git Bash`);
    }
    return explicit;
  }

  if (process.platform === 'win32') {
    const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((value): value is string => !!value);
    const candidates = [
      ...roots.flatMap((root) => [path.win32.join(root, 'Git', 'bin', 'bash.exe'), path.win32.join(root, 'Git', 'usr', 'bin', 'bash.exe')]),
      process.env.LOCALAPPDATA ? path.win32.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
      process.env.SHELL,
    ];
    for (const candidate of candidates) {
      const found = existing(candidate);
      if (found && !isWslLauncher(found)) return found;
    }

    const where = spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true });
    for (const candidate of where.stdout?.split(/\r?\n/) ?? []) {
      const found = existing(candidate);
      if (found && !isWslLauncher(found)) return found;
    }
    throw new Error('Git Bash was not found; install Git for Windows or set PIE_SHELL to its bash.exe');
  }

  for (const candidate of [process.env.SHELL, '/bin/bash', '/usr/bin/bash']) {
    const found = existing(candidate);
    if (found) return found;
  }
  return 'bash';
}
