#!/usr/bin/env node
// Migrate (or merge) legacy session-history stores into this checkout's
// machine-local data/outcomes/sessions store, preserving conflicting copies in
// .conflict.*.bak backups.
//
// This is the shared session-migration runner for both shell installers:
//   - install.sh:  `node scripts/migrate-local-sessions.mjs` (no args -> the
//                  three default legacy locations, all recursive)
//   - install.ps1: `node scripts/migrate-local-sessions.mjs --source <path>
//                  [--flat-source <path>] --dest <path>` (explicit sources, so
//                  the Windows installer can import from a configured sessionDir
//                  non-recursively while keeping its settings.json orchestration)
//
// The file-merge core lives in scripts/install/lib/sessions.mjs (pure, tested).
// When invoked with no sources, this runner preserves the original aggregate
// one-line report so install.sh's output is unchanged. With explicit sources it
// prints one line per source (matching install.ps1's per-import reporting).

import os from 'node:os';
import path from 'node:path';

import { repoRoot } from './toolchain.mjs';
import { mergeLegacySessions } from './install/lib/sessions.mjs';

function parseArgs(argv) {
  const sources = [];
  const flatSources = [];
  let dest = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') sources.push(argv[++i]);
    else if (arg === '--flat-source') flatSources.push(argv[++i]);
    else if (arg === '--dest') dest = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/migrate-local-sessions.mjs [--source <path>]... [--flat-source <path>]... [--dest <path>]');
      console.log('  No --source: migrate the default legacy locations (~/.pi/agent/sessions, <repo>/data/sessions, <repo>/sessions), all recursive.');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { sources, flatSources, dest };
}

const { sources, flatSources, dest } = parseArgs(process.argv.slice(2));
const destination = dest || path.join(repoRoot, 'data', 'outcomes', 'sessions');

const explicit = sources.length + flatSources.length > 0;
const sourceList = explicit
  ? [
      ...sources.map((p) => ({ path: p, recursive: true })),
      ...flatSources.map((p) => ({ path: p, recursive: false })),
    ]
  : [
      { path: path.join(os.homedir(), '.pi', 'agent', 'sessions'), recursive: true },
      { path: path.join(repoRoot, 'data', 'sessions'), recursive: true },
      { path: path.join(repoRoot, 'sessions'), recursive: true },
    ];

const { totals, perSource } = mergeLegacySessions({ sources: sourceList, destination });

if (explicit) {
  for (const entry of perSource) {
    if (entry.skipped) continue;
    const r = entry.result;
    console.log(
      `==> Imported ${r.copied} new session file(s); refreshed ${r.updated} newer file(s); ` +
      `preserved ${r.conflicts} conflicting backup file(s); skipped ${r.identical} identical file(s) ` +
      `from ${entry.path}`,
    );
  }
} else {
  console.log(
    `Session migration: ${totals.copied} copied, ${totals.updated} refreshed, ` +
    `${totals.identical} identical, ${totals.conflicts} conflict backup(s).`,
  );
}
