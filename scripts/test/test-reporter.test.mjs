import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import reporter, {
  accountTestFiles,
  normalizeCoverage,
  normalizeTestFileIdentity,
  TEST_FILE_ACCOUNTING_ENV,
  TEST_FILE_MARKER,
} from '../test-reporter.mjs';

test('normalizeCoverage unions duplicate transformed records by source line', () => {
  const normalized = normalizeCoverage({
    totals: {
      totalLineCount: 3, coveredLineCount: 1, coveredLinePercent: 33.33,
      totalBranchCount: 4, coveredBranchCount: 3, coveredBranchPercent: 75,
      totalFunctionCount: 2, coveredFunctionCount: 1, coveredFunctionPercent: 50,
    },
    files: [{
      path: 'src/example.ts',
      lines: [
        { line: 1, count: 1 }, { line: 2, count: 0 }, { line: 3, count: 0 },
        // A second transform covered the lines missed by the first record.
        { line: 1, count: 0 }, { line: 2, count: 2 }, { line: 3, count: 1 },
      ],
    }],
  });
  assert.equal(normalized.totalLineCount, 3);
  assert.equal(normalized.coveredLineCount, 3);
  assert.equal(normalized.coveredLinePercent, 100);
  assert.equal(normalized.coveredBranchPercent, 75, 'branch totals remain Node-authoritative');
});

test('normalizeCoverage falls back to raw totals when file records are unavailable', () => {
  const normalized = normalizeCoverage({
    totals: {
      totalLineCount: 10, coveredLineCount: 8, coveredLinePercent: 80,
      totalBranchCount: 2, coveredBranchCount: 1, coveredBranchPercent: 50,
      totalFunctionCount: 1, coveredFunctionCount: 1, coveredFunctionPercent: 100,
    },
  });
  assert.equal(normalized.totalLineCount, 10);
  assert.equal(normalized.coveredLineCount, 8);
  assert.equal(normalized.coveredLinePercent, 80);
});

test('test-file accounting accepts a normal one-to-one dispatch', () => {
  const expected = ['/repo/test/a.test.ts', '/repo/test/b.test.ts'];
  const accounting = accountTestFiles(expected, [...expected]);
  assert.equal(accounting.success, true);
  assert.equal(accounting.enumerated, 2);
  assert.equal(accounting.executed, 2);
  assert.deepEqual(accounting.missing, []);
  assert.deepEqual(accounting.duplicates, []);
});

test('test-file accounting fails closed when an enumerated suite is missing', () => {
  const accounting = accountTestFiles(['/repo/test/a.test.ts'], []);
  assert.equal(accounting.success, false);
  assert.deepEqual(accounting.missing, [{ file: '/repo/test/a.test.ts', expected: 1, executed: 0 }]);
});

test('test-file accounting rejects accidental duplicate suite dispatch', () => {
  const file = '/repo/test/a.test.ts';
  const accounting = accountTestFiles([file], [file, file]);
  assert.equal(accounting.success, false);
  assert.deepEqual(accounting.duplicates, [{ file, expected: 1, executed: 2 }]);
});

test('test-file accounting treats empty enumerations as a valid empty run', () => {
  const accounting = accountTestFiles([], []);
  assert.equal(accounting.success, true);
  assert.equal(accounting.enumerated, 0);
  assert.equal(accounting.executed, 0);
});

test('intentional reruns are accounted for separately from duplicate dispatch', () => {
  const file = '/repo/test/a.test.ts';
  const accounting = accountTestFiles([file], [file, file], [file]);
  assert.equal(accounting.success, true);
  assert.deepEqual(accounting.duplicates, []);
  assert.deepEqual(accounting.intentionalReruns, [{ file, expected: 1, executed: 1 }]);
});

test('reporter accounts for generated batch markers and direct file-level completions', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-test-accounting-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const batchFile = path.join(directory, 'batched.test.ts');
  const directInput = path.join(directory, 'direct.bundle.js');
  const wrapperInput = path.join(directory, 'batch.mts');
  const directSource = path.join(directory, 'direct.test.ts');
  const contextPath = path.join(directory, 'context.json');
  writeFileSync(contextPath, JSON.stringify({
    expectedFiles: [batchFile, directSource],
    directFiles: { [normalizeTestFileIdentity(directInput)]: directSource },
    ignoredFiles: [wrapperInput],
    intentionalReruns: [],
  }));
  const previousContext = process.env[TEST_FILE_ACCOUNTING_ENV];
  process.env[TEST_FILE_ACCOUNTING_ENV] = contextPath;
  t.after(() => {
    if (previousContext === undefined) delete process.env[TEST_FILE_ACCOUNTING_ENV];
    else process.env[TEST_FILE_ACCOUNTING_ENV] = previousContext;
  });

  async function* events() {
    yield { type: 'test:start', data: { name: `${TEST_FILE_MARKER}${batchFile}` } };
    yield { type: 'test:complete', data: { name: 'nested', file: directInput, nesting: 1 } };
    yield { type: 'test:complete', data: { name: directInput, file: directInput, nesting: 0 } };
    yield { type: 'test:complete', data: { name: wrapperInput, file: wrapperInput, nesting: 0 } };
    yield { type: 'test:summary', data: {} };
  }
  const output = [];
  for await (const chunk of reporter(events())) output.push(chunk);
  const report = JSON.parse(output[0].slice('__PI_TEST_SUMMARY__'.length));
  assert.equal(report.fileAccounting.success, true);
  assert.deepEqual(report.fileAccounting.executedFiles, [batchFile, directSource]);
});

test('real Node CLI reporter and run() account direct files, wrappers, and intentional reruns', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-test-accounting-real-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const direct = path.join(directory, 'direct.test.mjs');
  const wrapper = path.join(directory, 'wrapper.test.mjs');
  const apiDriver = path.join(directory, 'api-driver.mjs');
  const contextPath = path.join(directory, 'context.json');
  const reporterUrl = new URL('../test-reporter.mjs', import.meta.url).href;
  const marker = `${TEST_FILE_MARKER}${direct}`;
  writeFileSync(direct, "import { describe, test } from 'node:test'; describe('nested suite', () => { test('first', () => {}); test('second', () => {}); }); test('top level', () => {});\n");
  writeFileSync(wrapper, `import { describe } from 'node:test'; describe(${JSON.stringify(marker)}, async () => { await import(${JSON.stringify(pathToFileURL(direct).href)}); });\n`);
  writeFileSync(apiDriver, `import { run } from 'node:test'; import reporter from ${JSON.stringify(reporterUrl)}; for await (const chunk of reporter(run({ files: process.argv.slice(2), execArgv: [] }))) process.stdout.write(chunk);\n`);
  const env = { ...process.env, [TEST_FILE_ACCOUNTING_ENV]: contextPath };
  // The API driver and test subprocesses must not inherit a parent Node test runner's flags.
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const runChild = (args, expectedFiles, intentionalReruns = []) => {
    writeFileSync(contextPath, JSON.stringify({
      expectedFiles,
      directFiles: { [normalizeTestFileIdentity(direct)]: direct },
      ignoredFiles: [wrapper],
      intentionalReruns,
    }));
    const child = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 0, `Node test runner failed: ${child.error ?? child.stderr ?? child.stdout}`);
    const line = child.stdout.split(/\r?\n/u).find((entry) => entry.startsWith('__PI_TEST_SUMMARY__'));
    assert.ok(line, `Reporter output absent: ${child.stdout}`);
    return JSON.parse(line.slice('__PI_TEST_SUMMARY__'.length)).fileAccounting;
  };
  const cli = (files, expectedFiles, reruns) => runChild(
    ['--test', `--test-reporter=${reporterUrl}`, ...files], expectedFiles, reruns,
  );
  const first = cli([direct, wrapper], [direct]);
  assert.equal(first.success, false, 'unapproved second execution is a duplicate');
  assert.deepEqual(first.duplicates, [{ file: direct, expected: 1, executed: 2 }]);
  const approved = cli([direct, wrapper], [direct], [direct]);
  assert.equal(approved.success, true);
  assert.equal(approved.executed, 2);
  assert.deepEqual(approved.intentionalReruns, [{ file: direct, expected: 1, executed: 1 }]);
  const api = runChild([apiDriver, direct, wrapper], [direct], [direct]);
  assert.equal(api.success, true, 'run() exposes the same file-level boundary');
  assert.deepEqual(api.executedFiles.map(normalizeTestFileIdentity), [direct, direct].map(normalizeTestFileIdentity));
});
