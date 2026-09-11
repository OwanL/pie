import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const parentFlagsScript = fileURLToPath(new URL('./fixtures/recorder-supervisor-parent-flags.mjs', import.meta.url));
const tsxLoader = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

test('dedicated analytics helpers do not inherit arbitrary parent Node flags', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ['--trace-warnings', `--import=${tsxLoader}`, parentFlagsScript], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, stderr);
});
