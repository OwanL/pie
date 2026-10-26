import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { parseManagedIntegrationSelection } from '../managed-integration-selection.mjs';

const stage = path.join(os.tmpdir(), 'managed-stage');
const receipt = path.join(os.tmpdir(), 'managed-proof', 'qualification-receipt.json');
test('managed inputs are an explicit pair, independent of unrelated CLI options', () => {
  assert.equal(parseManagedIntegrationSelection(['--delivery']), undefined);
  assert.deepEqual(parseManagedIntegrationSelection(['--delivery', '--managed-stage', stage, `--managed-qualification-receipt=${receipt}`]), { stageRoot: stage, receiptPath: receipt });
});
test('partial, duplicate and nonabsolute managed selections fail', () => {
  for (const args of [
    ['--managed-stage', stage],
    ['--managed-qualification-receipt', receipt],
    ['--managed-stage', stage, `--managed-stage=${stage}`, '--managed-qualification-receipt', receipt],
    ['--managed-stage', stage, '--managed-qualification-receipt', receipt, `--managed-qualification-receipt=${receipt}`],
    ['--managed-stage', 'relative', '--managed-qualification-receipt', receipt],
    ['--managed-stage', stage, '--managed-qualification-receipt='],
    ['--managed-stage', '--managed-qualification-receipt', receipt],
  ]) assert.throws(() => parseManagedIntegrationSelection(args));
});
