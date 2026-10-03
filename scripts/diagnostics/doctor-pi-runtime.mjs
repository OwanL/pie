// Doctor verifies the checkout's built Pi runtime artifact by default, or a
// caller-selected artifact when --pi-runtime is supplied. Both are read-only
// checks against the executing Node target. Never a global-Pi lookup,
// registry/workspace fallback, build or acquisition, and never an artifact
// mutation or Pi module execution.
import path from 'node:path';

import { verifyPiRuntimeArtifact } from '../../lib/pi-runtime/artifact.mjs';

const FLAG = '--pi-runtime';
const DEFAULT_ARTIFACT_RELATIVE_PATH = path.join('application', 'hosts', 'vscode', 'out', 'pi-runtime');

/**
 * Parse doctor's argv for an explicit Pi runtime artifact selection. No other
 * argument is interpreted here. Usage problems are returned as data, not
 * thrown, so doctor can report them while routing must still not fall back to
 * a global-Pi or workspace selection whenever the flag was present.
 * @param {string[]} argv
 * @returns {{artifactDir?: string, selected: boolean, usageError?: string}}
 */
export function parsePiRuntimeRoute(argv) {
  let occurrence = 0;
  let artifactDir;
  let usageError;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== FLAG && !arg.startsWith(`${FLAG}=`)) continue;
    occurrence += 1;
    if (occurrence > 1) {
      usageError ??= `${FLAG} may be specified only once.`;
      continue;
    }
    const value = arg === FLAG ? argv[index + 1] : arg.slice(FLAG.length + 1);
    if (value === undefined || value === '' || value.startsWith('--')) {
      usageError = `${FLAG} requires an artifact path.`;
      if (arg === FLAG) index += 1;
      continue;
    }
    if (!path.isAbsolute(value)) {
      usageError = `${FLAG} requires an absolute artifact root.`;
      continue;
    }
    artifactDir = value;
    if (arg === FLAG) index += 1;
  }
  if (usageError) {
    // A rejected selection never names an artifact; doctor must stay on an
    // explicitly failed route instead of silently falling back.
    return { artifactDir: undefined, selected: true, usageError };
  }
  return { artifactDir, selected: occurrence > 0, usageError };
}

/**
 * Resolve the parsed request to an explicit artifact or the checkout-built
 * default. Invalid explicit selections remain selected but deliberately have
 * no artifact path, so callers cannot fall back to the default.
 * @param {{artifactDir?: string, selected: boolean, usageError?: string}} route
 * @param {string} repoRoot
 * @returns {{artifactDir?: string, selected: boolean, explicit: boolean, usageError?: string}}
 */
export function resolvePiRuntimeRoute(route, repoRoot) {
  if (route.usageError) return { ...route, explicit: true };
  if (route.selected) return { ...route, explicit: true };
  return {
    artifactDir: path.resolve(repoRoot, DEFAULT_ARTIFACT_RELATIVE_PATH),
    selected: true,
    explicit: false,
  };
}

const EXECUTING_NODE_TARGET = () => ({
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
});

/**
 * Read-only verification of one explicitly supplied artifact for the executing
 * Node (or caller-specified) target, describing its source-runtime identity and
 * version. Verification hashes the full payload against the selected manifest;
 * no artifact mutation, source lookup, install, build or global-Pi lookup is
 * performed, and no Pi module is imported or executed.
 * @param {{artifactDir: string,
 *   target?: {platform: string, arch: string, nodeAbi: string},
 *   verify?: typeof verifyPiRuntimeArtifact}} input
 * @returns {Promise<{status: 'ready'|'failed', artifactDir: string} &
 *   ({identity?: string, version?: string, upstreamVersion?: string,
 *     target?: {platform: string, arch: string, nodeAbi: string},
 *     sdkPath?: string, detail?: string})>}
 */
export async function collectPiRuntimeArtifactRoute({
  artifactDir,
  target = EXECUTING_NODE_TARGET(),
  verify = verifyPiRuntimeArtifact,
} = {}) {
  if (typeof artifactDir !== 'string' || !path.isAbsolute(artifactDir)) {
    throw new TypeError('collectPiRuntimeArtifactRoute requires an absolute artifact directory');
  }
  const base = { artifactDir: path.resolve(artifactDir) };
  try {
    const verified = await verify(artifactDir, { target: { ...target } });
    const sdk = verified.manifest.packages['@earendil-works/pi-coding-agent'];
    return {
      // Canonical spelling from the shared verifier (realpath'd), so doctor
      // reports the artifact exactly as it is identified on disk.
      artifactDir: verified.artifactDir,
      status: 'ready',
      identity: verified.identity,
      version: sdk?.version,
      upstreamVersion: verified.manifest.upstreamVersion,
      target: verified.manifest.target,
      sdkPath: verified.sdkPath,
    };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}