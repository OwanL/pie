import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PACKAGE_CONFIGS, runPackage } from '../run-tests.mjs';
import { resolveTestFiles } from '../test-node.mjs';

// Explicit supplied artifact only: never acquire/build an SDK or change the default lane.
test('same-loader owner qualification: exact inventories, counts and full AST reports', {
  skip: !process.env.PIE_PARITY_SDK_PATH,
}, async t => {
  const root = process.cwd();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-same-loader-parity-'));
  let success = false;
  try {
    for (const id of ['model-provider-authentication', 'lib']) {
      const owner = PACKAGE_CONFIGS.find(config => config.id === id);
      const globs = (owner.coverageTestGlobs ?? owner.testGlobs).map(glob =>
        path.relative(root, path.resolve(owner.cwd, glob)).replaceAll('\\', '/'));
      const selectors = [...new Set(globs.map(glob => {
        const wildcard = glob.search(/[*?{\[]/u);
        return wildcard < 0 ? glob : glob.slice(0, glob.lastIndexOf('/', wildcard)) || '.';
      }))];
      const expectedFiles = resolveTestFiles(root, selectors, { includeGlobs: globs });
      const context = path.join(directory, `${id}-inventory.json`);
      writeFileSync(context, JSON.stringify({ expectedFiles }));
      const reports = {};
      for (const execution of ['retained', 'native']) {
        const result = await runPackage(owner, false, false, [], undefined,
          { sdkPath: process.env.PIE_PARITY_SDK_PATH }, {
            execution,
            runChild: async (...args) => {
              const { runChildProcess } = await import('../run-tests.mjs');
              args[4] = { ...args[4], PIE_TEST_FILE_ACCOUNTING_CONTEXT: context };
              return runChildProcess(...args);
            },
          });
        writeFileSync(path.join(directory, `${id}-${execution}.json`), JSON.stringify(result, null, 2));
        assert.equal(result.passed, true, `${id}/${execution}`);
        assert.equal(result.fileAccounting?.success, true);
        reports[execution] = result;
      }
      assert.deepEqual(reports.native.fileAccounting, reports.retained.fileAccounting);
      assert.deepEqual(reports.native.summary.counts, reports.retained.summary.counts);
      assert.deepEqual(reports.native.coverage, reports.retained.coverage);
      t.diagnostic(`${id}: ${expectedFiles.length} exact files; ${JSON.stringify(reports.native.summary.counts)}; full coverage report identical`);
    }
    success = true;
  } finally {
    if (success) rmSync(directory, { recursive: true, force: true });
    else t.diagnostic(`Parity evidence retained: ${directory}`);
  }
});
