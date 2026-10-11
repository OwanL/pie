import { spawnSync } from "node:child_process";

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
