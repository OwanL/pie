import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const LOADED_GENERATION_FILENAME = 'analytics-loaded-generation-v1.json';
const MAX_LOADED_GENERATION_BYTES = 64 * 1024;
const LOADED_PROBE_TIMEOUT_MS = 30_000;

/** Read only a strict, bounded shape from the host's readiness marker. A
 * malformed marker is evidence of no loaded generation, never a reason to
 * continue activation. */
export function readLoadedGeneration(stateDir) {
  const loadedPath = path.join(stateDir, LOADED_GENERATION_FILENAME);
  if (!existsSync(loadedPath)) return null;
  try {
    if (statSync(loadedPath).size > MAX_LOADED_GENERATION_BYTES) return null;
    const value = JSON.parse(readFileSync(loadedPath, 'utf8'));
    const loadedAtMs = typeof value?.loadedAt === 'string' ? Date.parse(value.loadedAt) : Number.NaN;
    if (!value || typeof value !== 'object'
      || value.schemaVersion !== 1
      || typeof value.generationId !== 'string'
      || typeof value.buildId !== 'string'
      || typeof value.restartNonce !== 'string'
      || value.restartNonce.length === 0
      || value.restartNonce.length > 256
      || typeof value.hostInstanceId !== 'string'
      || value.hostInstanceId.length === 0
      || !Number.isFinite(loadedAtMs)) return null;
    return {
      generationId: value.generationId,
      buildId: value.buildId,
      restartNonce: value.restartNonce,
      hostInstanceId: value.hostInstanceId,
      loadedAt: value.loadedAt,
      loadedAtMs,
    };
  } catch {
    return null;
  }
}

export function loadedGenerationMatchesRestart(loaded, plan, restartDetail) {
  return Boolean(loaded
    && loaded.generationId === plan.generationId
    && loaded.buildId === plan.buildId
    && loaded.restartNonce === restartDetail.restartNonce
    && loaded.loadedAtMs > restartDetail.requestedAtMs
    && (restartDetail.previousHostInstanceId === null
      || loaded.hostInstanceId !== restartDetail.previousHostInstanceId));
}

export async function waitForFreshLoadedGeneration(stateDir, plan, restartDetail) {
  const deadline = Date.now() + LOADED_PROBE_TIMEOUT_MS;
  let loaded = readLoadedGeneration(stateDir);
  while (!loadedGenerationMatchesRestart(loaded, plan, restartDetail) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    loaded = readLoadedGeneration(stateDir);
  }
  return {
    loaded,
    matched: loadedGenerationMatchesRestart(loaded, plan, restartDetail),
    timedOut: !loadedGenerationMatchesRestart(loaded, plan, restartDetail),
  };
}
