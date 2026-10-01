import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPiRuntime } from '../build/pi-runtime.mjs';
import { verifyPiRuntimeArtifact } from './pi-runtime-artifact.mjs';

/**
 * One invocation's immutable Pi selection, shared explicitly with its children.
 *
 * Without artifactDir, acquire through the existing private builder in a new
 * OS-temp directory. Explicit artifactDir reuse is verified and NEVER removed.
 * No ambient selection, installation in the checkout, or lock refresh occurs.
 *
 * Lifecycle: await ALL child trees (including error/timeout teardown), then call
 * context.confirmChildCompletion(). This is the caller's assertion that no
 * child can still read the artifact and no further children will be launched.
 * Call it also when no children were launched. Callback settlement alone does
 * not prove teardown. Cleanup waits for both confirmation and settlement;
 * absent confirmation, acquisition failure, or an aborted signal retains the
 * fresh directory for diagnosis. The caller owns cancellation/child teardown;
 * this helper neither kills processes nor races the callback against abort.
 * Pass the invocation's AbortSignal so cancellation prevents cleanup even when
 * the callback has already confirmed completion. A pre-aborted signal acquires
 * nothing; abort during acquisition is checked before invoking the callback.
 *
 * The third argument is a test seam, not a second builder/verification owner.
 * @template T
 * @param {{artifactDir?: string, signal?: AbortSignal}} options
 * @param {(context: Readonly<{artifactDir: string, sdkPath: string, identity: string,
 *   confirmChildCompletion: () => void}>) => T | Promise<T>} run
 * @param {{buildPiRuntime?: typeof buildPiRuntime,
 *   verifyPiRuntimeArtifact?: typeof verifyPiRuntimeArtifact}} [dependencies]
 * @returns {Promise<T>}
 */
export async function withPiRuntime({ artifactDir, signal } = {}, run, dependencies = {}) {
  if (typeof run !== 'function') throw new TypeError('withPiRuntime requires a callback');
  if (artifactDir !== undefined && (typeof artifactDir !== 'string' || !path.isAbsolute(artifactDir))) {
    throw new TypeError('artifactDir must be an absolute artifact root');
  }
  signal?.throwIfAborted();
  const build = dependencies.buildPiRuntime ?? buildPiRuntime;
  const verify = dependencies.verifyPiRuntimeArtifact ?? verifyPiRuntimeArtifact;
  let ownedDirectory;
  let childCompletionConfirmed = false;
  try {
    let selectedDirectory = artifactDir;
    if (selectedDirectory === undefined) {
      ownedDirectory = await mkdtemp(path.join(os.tmpdir(), 'pie-pi-runtime-invocation-'));
      // The builder requires a nonexistent leaf, not mkdtemp's existing parent.
      const built = await build({ output: path.join(ownedDirectory, 'build') });
      selectedDirectory = built.artifactDir;
    }
    const verified = await verify(selectedDirectory);
    signal?.throwIfAborted();
    const context = Object.freeze({
      artifactDir: verified.artifactDir,
      sdkPath: verified.sdkPath,
      identity: verified.identity,
      confirmChildCompletion() { childCompletionConfirmed = true; },
    });
    return await run(context);
  } finally {
    if (ownedDirectory && childCompletionConfirmed && !signal?.aborted) {
      await rm(ownedDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
