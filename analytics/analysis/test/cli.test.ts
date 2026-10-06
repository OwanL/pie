import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { withTempDir } from './helpers.ts';

import { formatUsage, parseCliOptions } from '../scripts/cli.ts';

test('analysis CLI rejects retired dashboard options', () => {
  assert.throws(() => parseCliOptions(['--output-dir', 'site']), /Unknown argument: --output-dir/);
  assert.throws(() => parseCliOptions(['--port', '4173']), /Unknown argument: --port/);

  const usage = formatUsage('analytics', 'Analytics query tools');
  assert.doesNotMatch(usage, /--output-dir|--port/);
  assert.match(usage, /--db/);
  assert.match(usage, /--exports-dir/);
});

test('analysis CLI resolves all path options while preserving query names and help aliases', () => {
  assert.deepEqual(parseCliOptions([
    '--export', 'private export.json', '--db', 'usage.duckdb',
    '--exports-dir', 'staging exports', '--name', 'core_runs', '-h',
  ]), {
    help: true,
    exportPath: path.resolve('private export.json'),
    dbPath: path.resolve('usage.duckdb'),
    exportsDir: path.resolve('staging exports'),
    name: 'core_runs',
  });
  assert.deepEqual(parseCliOptions(['--storage-dir', 'runs', '--help']), {
    help: true, storageDir: path.resolve('runs'),
  });
  assert.deepEqual(parseCliOptions([]), { help: false });
});

test('analysis CLI rejects missing values and conflicting source selections', () => {
  for (const flag of ['--export', '--storage-dir', '--db', '--exports-dir', '--name']) {
    assert.throws(() => parseCliOptions([flag]), { message: `Missing value for ${flag}.` });
    assert.throws(() => parseCliOptions([flag, '']), { message: `Missing value for ${flag}.` });
  }
  assert.throws(() => parseCliOptions(['--export', 'export.json', '--storage-dir', 'runs']),
    /Use either --export or --storage-dir, not both/);
  assert.match(formatUsage('query', 'Query analytics', ['Named queries: core_runs']),
    /\n\nNamed queries: core_runs$/);
});

test('real analytics entrypoints show help and reject invalid queries without creating artifacts', async () => {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve('tsx/cli');
  await withTempDir(async (dir) => {
    for (const [script, args, status, output] of [
      ['build-db.ts', ['--help'], 0, /Build a local DuckDB database/],
      ['query.ts', [], 0, /Named queries: .*core_runs/],
      ['query.ts', ['--name', 'not-a-query'], 1, /Unknown query name: not-a-query/],
    ] as const) {
      const entry = fileURLToPath(new URL(`../scripts/${script}`, import.meta.url));
      const result = spawnSync(process.execPath, [tsxCli, entry, ...args,
        '--db', path.join(dir, 'usage.duckdb'), '--exports-dir', path.join(dir, 'exports')],
      { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr);
      assert.match(result.stdout + result.stderr, output);
    }
    assert.deepEqual(await fs.readdir(dir), [], 'help and invalid queries must not build a database');
  });
});
