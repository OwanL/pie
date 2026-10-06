// Shared toolchain verification for the Windows installer.
//
// Node and pnpm are selected by the repository's `.prototools` pins; their
// duplicate source pins (`.node-version` and `package.json#packageManager`) are
// checked for drift. Pi's source version comes from the matched in-tree Pi
// package manifests. This module only compares versions and never installs
// tooling or changes PATH/user configuration.

import { readPinnedNodeVersion, readPinnedPnpmVersion, readPinnedPiSourceVersion } from '../toolchain.mjs';

/**
 * Read Node/pnpm pins and the pinned Pi source version for a repo.
 * @param {string} repoRoot
 * @returns {{ node: string, pnpm: string, piSource: string }}
 */
export function readPinnedVersions(repoRoot) {
  return {
    node: readPinnedNodeVersion(repoRoot),
    pnpm: readPinnedPnpmVersion(repoRoot),
    piSource: readPinnedPiSourceVersion(repoRoot),
  };
}

/**
 * Compare actual Proto-selected Node/pnpm versions and include Pi source provenance.
 * No side effects or install recommendations.
 *
 * @param {{ pinned: { node: string, pnpm: string, piSource?: string }, actual: { node: string, pnpm: string } }} input
 * @returns {{ node: { ok: boolean, actual: string, pinned: string }, pnpm: { ok: boolean, actual: string, pinned: string }, piSource: { version: string, provenance: string }, allOk: boolean }}
 */
export function verifyToolchain({ pinned, actual }) {
  const node = { ok: actual.node === pinned.node, actual: actual.node, pinned: pinned.node };
  const pnpm = { ok: actual.pnpm === pinned.pnpm, actual: actual.pnpm, pinned: pinned.pnpm };
  const piSource = {
    version: pinned.piSource ?? '',
    provenance: 'harness/pi/packages/{tui,ai,agent,coding-agent}/package.json',
  };
  return { node, pnpm, piSource, allOk: node.ok && pnpm.ok };
}
