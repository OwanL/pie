import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const tracePath = process.env['PIE_TEST_WINLDD_TRACE_FILE'];
if (!tracePath || !path.isAbsolute(tracePath)) {
  throw new Error('The test-only WinLdd trace requires an absolute private trace path.');
}

const childProcess = createRequire(import.meta.url)('node:child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const executable = String(command);
  const argumentsList = Array.isArray(args) ? args.map(String) : [];
  const isWinLdd = path.win32.basename(executable).toLowerCase() === 'printdeps.exe';
  const child = originalSpawn.call(this, command, args, options);
  if (isWinLdd) {
    const record = { command: executable, args: argumentsList, cwd: options?.cwd ?? '', event: 'close', code: null, signal: null };
    child.once('close', (code, signal) => {
      appendFileSync(tracePath, `${JSON.stringify({ ...record, code, signal })}\n`, { encoding: 'utf8', flag: 'a' });
    });
    child.once('error', (error) => {
      appendFileSync(tracePath, `${JSON.stringify({ ...record, event: 'error', error: error.message })}\n`, { encoding: 'utf8', flag: 'a' });
    });
  }
  return child;
};
