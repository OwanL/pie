// Shared toolchain verification for the pie installers.
//
// Both install.ps1 and install.sh pin Node, npm, and the global `pi` CLI to
// exact versions (`.node-version`, `package.json#packageManager`, and the
// extension lockfile respectively) and install the pinned npm/pi when the
// running version drifts. The version-READING helpers already live in
// scripts/toolchain.mjs (shared with doctor.mjs); this module adds the
// comparison/decision logic that was previously duplicated inline in both
// shell installers.
//
// `verifyToolchain` is a pure comparison — it NEVER installs anything. The
// shell wrappers act on the returned `installCommands` (or the CLI runner
// prints a dry-run report). This makes the shared verifier safe to invoke in
// tests and in a "doctor/install dry-run" without mutating user state.

import { readPinnedNodeVersion, readPinnedNpmVersion, readPinnedPiVersion } from '../../toolchain.mjs';

/**
 * Read all three pinned versions for a repo.
 * @param {string} repoRoot
 * @returns {{ node: string, npm: string, pi: string }}
 */
export function readPinnedVersions(repoRoot) {
  return {
    node: readPinnedNodeVersion(),
    npm: readPinnedNpmVersion(),
    pi: readPinnedPiVersion(repoRoot),
  };
}

/**
 * Compare pinned vs actual versions and report what (if anything) the installer
 * would install. No side effects.
 *
 * @param {{ pinned: { node: string, npm: string, pi: string }, actual: { node: string, npm: string, pi: string } }} input
 * @returns {{
 *   node: { ok: boolean, actual: string, pinned: string },
 *   npm: { ok: boolean, actual: string, pinned: string, installCommand: string[] | null },
 *   pi: { ok: boolean, actual: string, pinned: string, installCommand: string[] | null },
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
  const pi = {
    ok: !!actual.pi && actual.pi === pinned.pi,
    actual: actual.pi || '',
    pinned: pinned.pi,
    installCommand: !actual.pi || actual.pi !== pinned.pi
      ? ['npm', 'install', '-g', `@earendil-works/pi-coding-agent@${pinned.pi}`]
      : null,
  };
  return { node, npm, pi, allOk: node.ok && npm.ok && pi.ok };
}
