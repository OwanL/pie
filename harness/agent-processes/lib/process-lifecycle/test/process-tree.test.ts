import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { windowsGuardianEnvironment, establishWindowsProcessTreeGuardian } from '../process-tree';

test('guardian environment excludes oversized worker variables without changing the source', () => {
  const source = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', Path: 'x'.repeat(40000), PROVIDER_API_KEY: 'secret', VSCODE_ENV: 'x'.repeat(40000) };
  const before = { ...source };
  assert.deepEqual(windowsGuardianEnvironment(source), { SystemRoot: source.SystemRoot, TEMP: source.TEMP });
  assert.deepEqual(source, before);
});

test('guardian environment preserves Windows lookup casing and compiler temp directories', () => {
  const source = { SYSTEMROOT: 'C:\\Windows', windir: 'C:\\Windows', Tmp: 'C:\\Temp', USERPROFILE: 'C:\\Users\\test', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', UNUSED: undefined };
  const { UNUSED: _unused, ...expected } = source;
  assert.deepEqual(windowsGuardianEnvironment(source), expected);
});

test('Windows Add-Type compiles with a filtered oversized environment', { skip: process.platform !== 'win32' }, async () => {
  const source = { ...process.env, PIE_OVERSIZED_TEST: 'x'.repeat(70000) };
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -TypeDefinition 'public class GuardianEnvironmentTest {}'"], {
    env: windowsGuardianEnvironment(source), windowsHide: true, timeout: 20000,
  });
  assert.equal(source.PIE_OVERSIZED_TEST.length, 70000);
});

test('Windows guardian compiles and contains its worker', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    const guardian = await establishWindowsProcessTreeGuardian(child.pid!);
    assert.ok(guardian);
    await guardian.terminate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Guardian did not terminate its worker')), 5000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    child.kill();
  }
});
