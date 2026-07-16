import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runExperimentTests, validateExperimentTestReport } from '../test-runner.mjs';

const execFileAsync = promisify(execFile);

test('experiment validation rejects failed, cancelled, missing, and incomplete summaries', () => {
  const report = (counts, success = true) => ({ summary: { success, counts: { passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, ...counts } } });
  assert.equal(validateExperimentTestReport(report({ tests: 1, passed: 1 })).valid, true);
  assert.match(validateExperimentTestReport(report({ tests: 1, failed: 1 })).reason, /failed/);
  assert.match(validateExperimentTestReport(report({ tests: 1, cancelled: 1 })).reason, /cancelled/);
  assert.match(validateExperimentTestReport(report({ tests: 2, passed: 1 })).reason, /incomplete/);
  assert.match(validateExperimentTestReport(null).reason, /missing/);
});

test('cancelled node:test cases make the experiment validation command fail', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pie-cancelled-validation-'));
  const fixture = join(root, 'cancelled.test.mjs');
  await writeFile(fixture, "import test from 'node:test'; test('cancelled worker',{timeout:20},()=>new Promise(()=>{}));\n");
  try {
    assert.equal(await runExperimentTests([fixture]), 1);
    let commandError;
    try { await execFileAsync(process.execPath, [join(import.meta.dirname, '..', 'test-runner.mjs'), fixture], { timeout: 5_000 }); }
    catch (error) { commandError = error; }
    assert.equal(commandError?.code, 1);
    assert.match(`${commandError?.stdout ?? ''}${commandError?.stderr ?? ''}`, /cancelled|summary missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
