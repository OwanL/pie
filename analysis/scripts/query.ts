#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseCliOptions, formatUsage } from './cli.ts';
import { toErrorMessage } from '../../shared/error-message.js';
import { buildDuckDbDatabase, runNamedDuckDbQuery, type NamedQuery, QUERY_FILE_BY_NAME } from './duckdb.ts';
import { prepareSourceAnalytics } from './prepare.ts';
import { DEFAULT_DUCKDB_PATH, DEFAULT_OUTCOMES_ROOT, DEFAULT_STAGING_EXPORTS_DIR, loadSourceAnalytics } from './source.ts';
import { shouldRebuildLocalDefaultDuckDb } from './source-auto.ts';

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help || !options.name) {
    console.log(formatUsage(
      'npm run query --',
      'Run a named DuckDB analytics query.',
      ['Named queries: ' + Object.keys(QUERY_FILE_BY_NAME).join(', ')],
    ));
    return;
  }

  const queryName = options.name as NamedQuery;
  if (!(queryName in QUERY_FILE_BY_NAME)) {
    throw new Error(`Unknown query name: ${options.name}`);
  }

  const dbPath = options.dbPath ?? DEFAULT_DUCKDB_PATH;
  const localDefaultMode = options.dbPath === undefined && !options.exportPath && !options.storageDir;
  const reviewSidecarPath = path.join(DEFAULT_OUTCOMES_ROOT, 'session-reviews', 'reviews.jsonl');
  const configRoot = path.resolve(DEFAULT_OUTCOMES_ROOT, '..', '..');
  const localDefaultInputs = [
    path.join(configRoot, 'models.json'),
    path.join(configRoot, 'analysis', 'model-pricing-history.json'),
    path.join(configRoot, 'data', 'pruning.jsonl'),
    path.join(configRoot, 'data', 'tool-result-pruning.jsonl'),
    path.join(configRoot, 'data', 'warm-bash.jsonl'),
  ];
  const shouldRebuild = !fs.existsSync(dbPath)
    || Boolean(options.exportPath || options.storageDir)
    || (localDefaultMode && await shouldRebuildLocalDefaultDuckDb(dbPath, DEFAULT_OUTCOMES_ROOT, reviewSidecarPath, localDefaultInputs));
  if (shouldRebuild) {
    const loaded = await loadSourceAnalytics({ exportPath: options.exportPath, storageDir: options.storageDir });
    const prepared = prepareSourceAnalytics(loaded.source);
    await buildDuckDbDatabase({
      dbPath,
      exportsDir: options.exportsDir ?? DEFAULT_STAGING_EXPORTS_DIR,
      prepared,
    });
  }

  const rows = await runNamedDuckDbQuery(dbPath, queryName);
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((error) => {
  console.error('query failed:', toErrorMessage(error));
  process.exitCode = 1;
});
