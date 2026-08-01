// Doctor detection for sessions stranded in legacy roots.
//
// The runtime lists sessions from the canonical store only: the installer's
// verified copy/merge is the authority for legacy content, so a perpetual
// legacy scan would only re-surface stale or stranded copies. This module
// detects sessions that are stranded in a legacy root WITHOUT a canonical
// counterpart — e.g. a `pi` run in a shell that did not inherit
// PI_CODING_AGENT_SESSION_DIR wrote a fresh transcript to the old SDK default.
// `npm run doctor` surfaces these so the user can re-run the installer to
// migrate them, instead of the runtime scanning the legacy root forever.
//
// The bucket derivation reuses scripts/install/lib/sessions.mjs so a file is
// "stranded" by exactly the same logic the migration uses to place it.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { listJsonlFiles, sessionInfo } from './install/lib/sessions.mjs';

/**
 * Legacy session roots the installer migrates into the canonical store. Kept in
 * sync with scripts/migrate-local-sessions.mjs defaults and install.bat imports.
 * @param {{ repoRoot: string, homeDir?: string }} input
 * @returns {string[]}
 */
export function legacySessionRoots({ repoRoot, homeDir }) {
  const home = homeDir ?? os.homedir();
  return [
    path.join(home, '.pi', 'agent', 'sessions'),
    path.join(repoRoot, 'data', 'sessions'),
    path.join(repoRoot, 'sessions'),
  ];
}

/**
 * Detect legacy session files without a canonical counterpart.
 *
 * A legacy file is "stranded" when its canonical target —
 * `<canonical>/<bucket>/<basename>`, where the bucket is derived from the
 * session's recorded cwd exactly as the migration computes it — does not
 * exist. Files already migrated (copied, identical, or conflict-backed-up)
 * have a canonical counterpart and are not stranded.
 *
 * @param {{ repoRoot: string, canonicalSessionDir?: string, homeDir?: string }} input
 * @returns {{
 *   canonical: string,
 *   roots: Array<{ root: string, total: number, stranded: number }>,
 *   totalStranded: number,
 * }}
 */
export function collectStrandedLegacySessions({ repoRoot, canonicalSessionDir, homeDir }) {
  const canonical = canonicalSessionDir ?? path.join(repoRoot, 'data', 'outcomes', 'sessions');
  const roots = legacySessionRoots({ repoRoot, homeDir });
  const report = [];
  let totalStranded = 0;

  for (const root of roots) {
    const files = listJsonlFiles(root, { recursive: true });
    if (files.length === 0) continue;
    let stranded = 0;
    for (const file of files) {
      // Use the migration's exact full-file parser. Sessions can contain a
      // later session header (or a first header beyond an unusually large
      // malformed prefix), and a bounded duplicate parser could otherwise
      // look in a different bucket and report a false stranded session.
      const { bucket } = sessionInfo(file);
      const target = path.join(canonical, bucket, path.basename(file));
      if (!fs.existsSync(target)) stranded += 1;
    }
    report.push({ root, total: files.length, stranded });
    totalStranded += stranded;
  }

  return { canonical, roots: report, totalStranded };
}
