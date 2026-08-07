#!/usr/bin/env node
import path from 'node:path';

import { mergeOutcomesStore } from './install/lib/outcomes.mjs';
import { repoRoot } from './toolchain.mjs';

function parseArgs(argv) {
  let sourceOutcomesRoot = '';
  let sourceSessionDir = '';
  let destinationOutcomesRoot = path.join(repoRoot, 'data', 'outcomes');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') sourceOutcomesRoot = argv[++i] ?? '';
    else if (arg === '--source-session-dir') sourceSessionDir = argv[++i] ?? '';
    else if (arg === '--dest') destinationOutcomesRoot = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/migrate-outcomes-store.mjs (--source <outcomesRoot> | --source-session-dir <sessionsDir>) [--dest <outcomesRoot>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!sourceOutcomesRoot && sourceSessionDir) sourceOutcomesRoot = path.dirname(sourceSessionDir);
  if (!sourceOutcomesRoot) throw new Error('A --source or --source-session-dir is required.');
  return { sourceOutcomesRoot, destinationOutcomesRoot };
}

try {
  const result = mergeOutcomesStore(parseArgs(process.argv.slice(2)));
  if (result.skipped) {
    console.log(`Outcomes migration skipped: ${result.sourceRoot}`);
  } else {
    const runs = result.runStores.reduce((sum, store) => sum + store.appended, 0);
    console.log(
      `Outcomes migration: ${result.sessions.copied} session(s) copied, `
      + `${result.sessions.updated} refreshed, ${result.reviews.appended} review(s), `
      + `${result.closureActions.appended} closure event(s), and ${runs} run snapshot(s) appended.`,
    );
    if (result.reviews.quarantined > 0) {
      console.warn(`${result.reviews.quarantined} canonical review conflict(s) were quarantined under data/outcomes/migration-conflicts/.`);
    }
  }
} catch (error) {
  console.error(`Outcomes migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
