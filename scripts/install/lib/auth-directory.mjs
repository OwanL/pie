import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function canonicalDirectoryPath(candidate, { allowMissingTail = false } = {}) {
  const absolutePath = path.resolve(candidate);
  let cursor = absolutePath;
  const missingSegments = [];

  while (true) {
    try {
      const canonicalCursor = realpathSync.native(cursor);
      if (!statSync(cursor).isDirectory()) {
        throw new Error(`'${cursor}' is not a directory`);
      }
      if (missingSegments.length > 0 && !allowMissingTail) {
        throw new Error(`'${absolutePath}' does not exist`);
      }
      return path.resolve(canonicalCursor, ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      if (!allowMissingTail) throw error;

      // A broken alias is an existing component, not a missing directory tail.
      // Its target could appear during later installer steps, so do not guess
      // a lexical location that can change into an in-checkout destination.
      let danglingAlias = false;
      try {
        danglingAlias = lstatSync(cursor).isSymbolicLink();
      } catch (entryError) {
        if (entryError?.code !== 'ENOENT' && entryError?.code !== 'ENOTDIR') throw entryError;
      }
      if (danglingAlias) throw new Error(`'${cursor}' is a directory alias with an unresolved target`);

      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Read-only validation for PI_CODING_AGENT_AUTH_DIR. Existing directory
 * components are canonicalized so junctions/symlinks cannot disguise a path
 * inside the checkout; a not-yet-created external directory remains valid.
 */
export function validateAuthDirectory({ repoRoot, authDir } = {}) {
  if (typeof authDir !== 'string' || !authDir || !path.isAbsolute(authDir)) {
    return { valid: false, reason: 'must point outside the Git checkout using an absolute path' };
  }
  if (typeof repoRoot !== 'string' || !repoRoot) {
    return { valid: false, reason: 'the Git checkout location could not be resolved' };
  }

  let canonicalRoot;
  let canonicalAuthDir;
  try {
    canonicalRoot = canonicalDirectoryPath(repoRoot);
    canonicalAuthDir = canonicalDirectoryPath(authDir, { allowMissingTail: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `could not resolve the auth directory or Git checkout (${detail})` };
  }

  if (isWithinDirectory(canonicalRoot, canonicalAuthDir)) {
    return { valid: false, reason: 'must point outside the Git checkout' };
  }
  return { valid: true };
}
