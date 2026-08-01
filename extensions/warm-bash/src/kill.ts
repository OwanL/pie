import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * Kill an entire process tree (the shell plus all descendant commands).
 * Used on timeout / abort to match the built-in `killProcessTree` behaviour.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // Do not block the extension host on taskkill. In particular, `/T` can
      // take seconds when a launcher has a large descendant tree—the exact
      // moment Stop must return promptly. This matches pi's built-in executor:
      // launch best-effort tree cleanup and let local cancellation settle.
      const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      // spawn failures are asynchronous; try/catch cannot observe them. Keep a
      // sink so a missing/broken taskkill never becomes an uncaught host error.
      killer.once("error", () => undefined);
      killer.unref();
    } else {
      // Worker is spawned detached → it leads its own process group.
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    /* group may already be gone */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already dead */
  }
}

/**
 * Kill ONLY the shell PID, leaving backgrounded children (`cmd &`) orphaned
 * and still running — matching the built-in `bash -c "foo &"` behaviour where
 * bash exits and the background job survives. Used on normal completion of a
 * warm worker (one-use, then replaced).
 */
export function killShellOnly(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // No /T → do not recurse into descendants.
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* already dead */
  }
}