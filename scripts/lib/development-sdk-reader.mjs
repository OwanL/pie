import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDevelopmentReader } from '../../lib/development-runtime/lifetime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function nativeRealpath(filePath) {
  return typeof realpathSync.native === 'function'
    ? realpathSync.native(filePath)
    : realpathSync(filePath);
}

function sameCanonicalPath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function isMissingPath(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

/**
 * Return the canonical Pi workspace root only when an explicitly selected SDK
 * resolves to this repository's native coding-agent package. Materialized SDK
 * packages and direct fixture packages are not workspace readers.
 */
export function resolveDevelopmentSdkWorkspaceRoot(sdkPath, { root = repositoryRoot } = {}) {
  if (sdkPath === undefined) return undefined;
  if (typeof sdkPath !== 'string' || sdkPath.trim() === '') {
    throw new TypeError('sdkPath must be a non-empty path string when supplied.');
  }
  const absoluteRoot = path.resolve(root);
  const absoluteSdk = path.isAbsolute(sdkPath) ? path.resolve(sdkPath) : path.resolve(absoluteRoot, sdkPath);
  const nativeWorkspaceSdk = path.join(absoluteRoot, 'harness', 'pi', 'packages', 'coding-agent');
  let selectedCanonical;
  let workspaceSdkCanonical;
  try {
    selectedCanonical = nativeRealpath(absoluteSdk);
    workspaceSdkCanonical = nativeRealpath(nativeWorkspaceSdk);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  if (!sameCanonicalPath(selectedCanonical, workspaceSdkCanonical)) return undefined;

  // Resolve the lease root independently as well; the gate keys registrations
  // by its native canonical path (including on Windows short-path spellings).
  return nativeRealpath(path.resolve(workspaceSdkCanonical, '..', '..'));
}

/**
 * Hold the existing development reader around explicit native-workspace SDK
 * aliases and child reads. Successful operations must provide
 * `{ teardownConfirmed: true }`; unconfirmed teardown deliberately retains the
 * durable registration. Ordinary setup errors are safe to release because the
 * caller has not launched a child, while child owners must mark uncertain
 * teardown with `error.teardownUnconfirmed = true`.
 */
export async function withDevelopmentSdkReader(sdkPath, operation, { root = repositoryRoot, acquireReader = acquireDevelopmentReader } = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function.');
  const workspaceRoot = resolveDevelopmentSdkWorkspaceRoot(sdkPath, { root });
  if (!workspaceRoot) return operation();

  const reader = await acquireReader(workspaceRoot, {
    metadata: { operation: 'development-sdk-reader', invocation: randomUUID() },
  });
  let teardownConfirmed = false;
  let result;
  let operationError;
  try {
    result = await operation();
    teardownConfirmed = result?.teardownConfirmed === true;
  } catch (error) {
    operationError = error;
    teardownConfirmed = error?.teardownUnconfirmed !== true;
  }

  try {
    await reader.release({ teardownConfirmed });
  } catch (releaseError) {
    if (operationError) {
      const combined = new AggregateError([operationError, releaseError], 'SDK reader operation failed and its registration could not be released.');
      if (!teardownConfirmed) combined.teardownUnconfirmed = true;
      throw combined;
    }
    throw releaseError;
  }
  if (operationError) throw operationError;
  return result;
}
