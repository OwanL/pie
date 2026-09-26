#!/usr/bin/env node
import { parseCliOptions, formatUsage } from './cli.ts';
import { toErrorMessage } from '../../../lib/structured-logging/error-message.js';
import { buildDuckDbDatabase } from './duckdb.ts';
import { prepareSourceAnalytics } from './prepare.ts';
import { DEFAULT_DUCKDB_PATH, DEFAULT_STAGING_EXPORTS_DIR, loadSourceAnalytics } from './source.ts';

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(formatUsage('npm run build-db --', 'Build a local DuckDB database from a run-analytics source.'));
    return;
  }

  const loaded = await loadSourceAnalytics({ exportPath: options.exportPath, storageDir: options.storageDir });
  if (loaded.sourceKind === 'fixture') {
    console.warn('Warning: using fixture analytics data. Pass --export or --storage-dir to analyze real local runs.');
  }
  const prepared = prepareSourceAnalytics(loaded.source);
  const dbPath = options.dbPath ?? DEFAULT_DUCKDB_PATH;
  const exportsDir = options.exportsDir ?? DEFAULT_STAGING_EXPORTS_DIR;

  await buildDuckDbDatabase({ dbPath, exportsDir, prepared });

  console.log(`Source: ${loaded.sourceKind} (${loaded.sourcePath})`);
  console.log(`Exported at: ${loaded.source.exportedAt}`);
  console.log(`Workspace key: ${loaded.source.workspaceKey}`);
  console.log(`DuckDB: ${dbPath}`);
  console.log(`Staging exports: ${exportsDir}`);
  console.log(`Runs loaded: ${prepared.runs.length}`);
}

main().catch((error) => {
  console.error('build-db failed:', toErrorMessage(error));
  process.exitCode = 1;
});
