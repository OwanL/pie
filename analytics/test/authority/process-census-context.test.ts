import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWindowsProcessOwnerRows } from '../../authority/process-census.js';

const context = { mode: 'canonical-only', generationId: 'capture namespace', buildId: 'build', workspaceId: 'workspace', hostInstanceId: 'host' };
// Node/libuv's Windows spawn serialization: double backslashes preceding a
// quote (and at the end), escape quotes, then surround the argument in quotes.
function quote(value: string): string {
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}
function census(args: string) {
  return parseWindowsProcessOwnerRows([
    { ProcessId: 9000, ProcessCreatedAtMs: 1000 },
    { ProcessId: 9001, ProcessCreatedAtMs: 1100, CommandLine: `node "C:\\Program Files\\pie\\backend.js" --sdkPath "C:\\Program Files\\sdk" --hostPid 9000 --backendGeneration 1 ${args}` },
  ]);
}

test('census decodes libuv quoted JSON and emits only sanitized capture keys', () => {
  for (const buildId of ['build', 'C:\\path with spaces\\', 'quoted "build" \\" tail']) {
    const result = census(`--analyticsContext ${quote(JSON.stringify({ ...context, buildId }))}`);
    assert.equal(result.complete, true);
    assert.deepEqual(result.backendOwners, [{ backendProcessId: 9001, hostProcessId: 9000, backendCreatedAtMs: 1100, hostCreatedAtMs: 1000, backendGeneration: 1, analyticsGenerationId: context.generationId, analyticsHostInstanceId: context.hostInstanceId }]);
    assert.equal(JSON.stringify(result).includes(buildId), false);
  }
});

test('census fails closed for absent, legacy, partial, malformed and duplicate contexts', () => {
  const valid = quote(JSON.stringify(context));
  for (const args of [
    '', '--analyticsGenerationId old --analyticsHostInstanceId host',
    '--analyticsContext', '--analyticsContext "unterminated',
    '--analyticsContext bad-json',
    `--analyticsContext ${quote(JSON.stringify({ ...context, mode: 'legacy' }))}`,
    `--analyticsContext ${quote(JSON.stringify({ ...context, extra: 'field' }))}`,
    `--analyticsContext ${quote(JSON.stringify({ mode: 'canonical-only' }))}`,
    `--analyticsContext ${valid} --analyticsContext ${valid}`,
    `--analyticsContext=${valid} --analyticsContext ${valid}`,
    `--analyticsContext ${quote(JSON.stringify({ ...context, generationId: '\u0000' }))}`,
  ]) {
    const result = census(args);
    assert.equal(result.complete, false, args);
    assert.ok(result.reasons.length > 0, args);
    assert.ok(result.backendOwners.every((owner) => owner.analyticsGenerationId === undefined), args);
  }
});

test('census accepts a single equals-form context and rejects duplicate owner flags', () => {
  const valid = quote(JSON.stringify(context));
  assert.equal(census(`--analyticsContext=${valid}`).complete, true);
  assert.equal(census(`--analyticsContext ${valid} --hostPid 9000`).complete, false);
});
