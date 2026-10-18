import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OWNERSHIP_STARTUP_TOKEN } from '../ownership-startup.mjs';

function childResult(args, input, { keepOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
    if (keepOpen) child.stdin.write(input);
    else child.stdin.end(input);
  });
}

for (const route of ['native', 'focused']) {
  test(`${route}: actual child requires exact authorization before test/reporter imports`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pie-startup-test-'));
    try {
      const marker = path.join(root, 'executed');
      const entry = path.join(root, 'entry.mjs');
      const reporter = path.join(root, 'reporter.mjs');
      writeFileSync(entry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'test');`);
      writeFileSync(reporter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'reporter'); export default async function* (events) { for await (const event of events) {} }`);
      const config = path.join(root, 'config.json');
      writeFileSync(config, JSON.stringify({ files: [entry], cwd: root, options: {}, reporterNames: [reporter], reporterDestinations: [], waitForOwnership: true }));
      const args = route === 'native'
        ? [fileURLToPath(new URL('../test-node-runner.mjs', import.meta.url)), config]
        : [fileURLToPath(new URL('../focused-test-startup.mjs', import.meta.url)), entry];
      for (const input of ['', OWNERSHIP_STARTUP_TOKEN.slice(0, -1), 'wrong\n', `${OWNERSHIP_STARTUP_TOKEN}extra`, 'x'.repeat(100_000)]) {
        const result = await childResult(args, input);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /startup was not authorized/);
        assert.equal(existsSync(marker), false);
      }
      const result = await childResult(args, OWNERSHIP_STARTUP_TOKEN);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(existsSync(marker), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('actual child times out with open partial authorization before execution', async () => {
  const helper = new URL('../ownership-startup.mjs', import.meta.url).href;
  const result = await childResult(['--input-type=module', '-e', `import { waitForOwnershipAuthorization } from ${JSON.stringify(helper)}; await waitForOwnershipAuthorization(process.stdin, { timeoutMs: 50 }); console.log('EXECUTED');`], OWNERSHIP_STARTUP_TOKEN.slice(0, -1), { keepOpen: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /handshake timed out/);
});
