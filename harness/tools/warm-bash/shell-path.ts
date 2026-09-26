import { existsSync } from "node:fs";
import { win32 } from "node:path";

export interface ShellSelection {
  shellPath: string;
  env: NodeJS.ProcessEnv;
}

const GIT_RUNTIME_LAYOUTS = [
  { dir: "mingw64", msystem: "MINGW64" },
  { dir: "mingw32", msystem: "MINGW32" },
  { dir: "clangarm64", msystem: "CLANGARM64" },
] as const;

/**
 * Skip Git for Windows' small `bin/bash.exe` launcher when its real Bash
 * executable is available, while reproducing the environment bootstrap that
 * launcher normally performs. An installation must also contain Git's cmd
 * entrypoint and a known runtime layout, avoiding accidental rewrites of other
 * MSYS/Cygwin installations that happen to use a similar directory structure.
 *
 * Only auto-detected shells pass through this helper. Explicit PIE_SHELL values
 * are handled by the caller and remain entirely user-owned.
 */
export function optimizeAutoDetectedShell(
  shell: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): ShellSelection {
  if (platform !== "win32" || !/[\\/]bin[\\/]bash\.exe$/i.test(shell)) {
    return { shellPath: shell, env };
  }

  const gitRoot = win32.dirname(win32.dirname(shell));
  const direct = win32.join(gitRoot, "usr", "bin", "bash.exe");
  const gitCmd = win32.join(gitRoot, "cmd", "git.exe");
  const runtime = GIT_RUNTIME_LAYOUTS.find(({ dir }) => exists(win32.join(gitRoot, dir, "bin")));
  if (!exists(direct) || !exists(gitCmd) || !runtime) return { shellPath: shell, env };

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const home = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH
    ? `${env.HOMEDRIVE}${env.HOMEPATH}`
    : undefined);
  const prefix = [
    win32.join(gitRoot, runtime.dir, "bin"),
    win32.join(gitRoot, "usr", "bin"),
    home ? win32.join(home, "bin") : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  return {
    shellPath: direct,
    env: {
      ...env,
      EXEPATH: env.EXEPATH ?? win32.join(gitRoot, "bin"),
      MSYSTEM: env.MSYSTEM ?? runtime.msystem,
      PLINK_PROTOCOL: env.PLINK_PROTOCOL ?? "ssh",
      [pathKey]: [...prefix, env[pathKey] ?? ""].filter(Boolean).join(";"),
    },
  };
}
