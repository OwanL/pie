// Verified launcher for the Pi CLI bundled in a local immutable runtime artifact.
// Callers select the backend Node executable and its target explicitly. Acquire
// once, reuse the returned launcher, and keep the artifact immutable and alive
// until every child it starts has exited; this helper does not provide leases.
import { spawn as childProcessSpawn } from 'node:child_process';
import path from 'node:path';

import { verifyPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';

/**
 * Verify one explicitly selected Pi runtime artifact and return a reusable CLI
 * launcher. The target must describe `nodeExecutable`'s runtime; it is never
 * inferred from the artifact manifest or defaulted to this process's runtime.
 *
 * The caller owns the artifact's immutability and lifetime: do not replace or
 * modify it while any returned launcher child is running, and retain it until
 * all such children exit. There are deliberately no leases or mutable pointers.
 *
 * `run` returns the subprocess seam's child object unchanged, so callers retain
 * native stdio, exit/signal, and spawn-error behavior.
 *
 * @param {{
 *   artifactDir: string,
 *   nodeExecutable: string,
 *   target: { platform: string, arch: string, nodeAbi: string },
 *   spawn?: typeof childProcessSpawn,
 * }} input
 * @returns {Promise<{run: (args: string[], options?: {env?: NodeJS.ProcessEnv, cwd?: string, stdio?: unknown}) => import('node:child_process').ChildProcess}>}
 */
export async function createSourcePiCli({ artifactDir, nodeExecutable, target, spawn = childProcessSpawn }) {
  if (typeof artifactDir !== 'string' || artifactDir.length === 0) {
    throw new TypeError('artifactDir must explicitly name a local runtime artifact');
  }
  if (typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable)) {
    throw new TypeError('nodeExecutable must be an absolute executable path');
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('target must explicitly describe the selected Node executable runtime');
  }
  if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');

  // Snapshot the caller-selected authority before asynchronous artifact I/O.
  const selectedTarget = {
    platform: target.platform,
    arch: target.arch,
    nodeAbi: target.nodeAbi,
  };
  const verified = await verifyPiRuntimeArtifact(artifactDir, { target: selectedTarget });
  const cliPath = path.join(verified.sdkPath, 'dist', 'cli.js');

  return Object.freeze({
    run(args, { env, cwd, stdio } = {}) {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        throw new TypeError('args must be an array of strings');
      }
      // Pass argument values and caller-owned environment/stdio through without
      // shell quoting, normalization, environment merging, or cwd resolution.
      return spawn(nodeExecutable, [cliPath, ...args], {
        env,
        cwd,
        stdio,
        shell: false,
      });
    },
  });
}
