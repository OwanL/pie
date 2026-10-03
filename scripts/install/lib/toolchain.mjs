// Shared toolchain verification for the Windows installer.
//
// Node and npm are pinned by `.node-version` and `package.json#packageManager`.
// The Pi source version comes from the matched in-tree Pi package manifests;
// host dependency ranges/lockfiles and global `pi` executables are not authority.
// The version-reading helpers live in scripts/install/toolchain.mjs; this
// module owns the comparison and installation-decision logic.
//
// `verifyToolchain` is a pure comparison — it NEVER installs anything. The
// shell wrappers act on the returned npm install command or print a dry-run
// report. This makes the shared verifier safe to invoke in tests and
// `install.bat --check` without mutating user state.

import { readPinnedNodeVersion, readPinnedNpmVersion, readPinnedPiSourceVersion } from '../toolchain.mjs';

/**
 * Read Node/npm pins and the pinned Pi source version for a repo.
 * @param {string} repoRoot
 * @returns {{ node: string, npm: string, piSource: string }}
 */
export function readPinnedVersions(repoRoot) {
  return {
    node: readPinnedNodeVersion(),
    npm: readPinnedNpmVersion(),
    piSource: readPinnedPiSourceVersion(repoRoot),
  };
}

/**
 * Compare actual Node/npm versions and include Pi source provenance. No side effects.
 *
 * @param {{ pinned: { node: string, npm: string, piSource?: string }, actual: { node: string, npm: string } }} input
 * @returns {{
 *   node: { ok: boolean, actual: string, pinned: string },
 *   npm: { ok: boolean, actual: string, pinned: string, installCommand: string[] | null },
 *   piSource: { version: string, provenance: string },
 *   allOk: boolean,
 * }}
 */
export function verifyToolchain({ pinned, actual }) {
  const node = { ok: actual.node === pinned.node, actual: actual.node, pinned: pinned.node };
  const npm = {
    ok: actual.npm === pinned.npm,
    actual: actual.npm,
    pinned: pinned.npm,
    installCommand: actual.npm === pinned.npm ? null : ['npm', 'install', '-g', `npm@${pinned.npm}`],
  };
  const piSource = {
    version: pinned.piSource ?? '',
    provenance: 'harness/pi/packages/{tui,ai,agent,coding-agent}/package.json',
  };
  return { node, npm, piSource, allOk: node.ok && npm.ok };
}
