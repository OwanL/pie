import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import test from 'node:test';
import { optimizeAutoDetectedShell } from '../src/shell-path.js';
import { findTestBash } from './test-shell.js';

const RUN_INTEGRATION_TESTS = process.env.PIE_RUN_INTEGRATION_TESTS === '1';

function gitInstallExists(candidate: string): boolean {
  return new Set([
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\mingw64\\bin',
  ]).has(candidate);
}

test('optimizeAutoDetectedShell selects real Git Bash and reproduces wrapper environment', () => {
  const originalEnv = {
    Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
    USERPROFILE: 'C:\\Users\\Ada',
  };
  const selected = optimizeAutoDetectedShell(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    originalEnv,
    'win32',
    gitInstallExists,
  );

  assert.equal(selected.shellPath, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  assert.equal(
    selected.env.Path,
    'C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin;C:\\Users\\Ada\\bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
  );
  assert.equal(selected.env.MSYSTEM, 'MINGW64');
  assert.equal(selected.env.EXEPATH, 'C:\\Program Files\\Git\\bin');
  assert.equal(selected.env.PLINK_PROTOCOL, 'ssh');
  assert.deepEqual(originalEnv, {
    Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
    USERPROFILE: 'C:\\Users\\Ada',
  });
});

test('optimizeAutoDetectedShell preserves existing wrapper environment values', () => {
  const selected = optimizeAutoDetectedShell(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    { PATH: 'original', MSYSTEM: 'CUSTOM', EXEPATH: 'custom-exe', PLINK_PROTOCOL: 'custom-link' },
    'win32',
    gitInstallExists,
  );

  assert.equal(selected.env.MSYSTEM, 'CUSTOM');
  assert.equal(selected.env.EXEPATH, 'custom-exe');
  assert.equal(selected.env.PLINK_PROTOCOL, 'custom-link');
});

test('optimizeAutoDetectedShell keeps launcher when Git layout is incomplete', () => {
  const shell = 'C:\\PortableGit\\bin\\bash.exe';
  const env = { PATH: 'original' };
  assert.deepEqual(
    optimizeAutoDetectedShell(shell, env, 'win32', () => false),
    { shellPath: shell, env },
  );
});

test('optimizeAutoDetectedShell does not rewrite a similarly laid-out non-Git shell', () => {
  const shell = 'C:\\cygwin64\\bin\\bash.exe';
  const env = { PATH: 'original' };
  const existsWithoutGitCmd = (candidate: string) => !candidate.endsWith('cmd\\git.exe');
  assert.deepEqual(
    optimizeAutoDetectedShell(shell, env, 'win32', existsWithoutGitCmd),
    { shellPath: shell, env },
  );
});

test('optimizeAutoDetectedShell leaves non-Windows paths unchanged', () => {
  const env = { PATH: '/usr/bin' };
  assert.deepEqual(
    optimizeAutoDetectedShell('/bin/bash', env, 'linux', () => true),
    { shellPath: '/bin/bash', env },
  );
});

test('direct Git Bash retains Unix command resolution with a native Windows PATH', {
  skip: RUN_INTEGRATION_TESTS && process.platform === 'win32'
    ? false
    : 'set PIE_RUN_INTEGRATION_TESTS=1 on Windows to run Git Bash integration tests',
}, () => {
  const discovered = findTestBash();
  const gitRoot = /[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(discovered)
    ? win32.dirname(win32.dirname(win32.dirname(discovered)))
    : win32.dirname(win32.dirname(discovered));
  const wrapper = win32.join(gitRoot, 'bin', 'bash.exe');
  const env = {
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATH: `${process.env.SystemRoot}\\System32;${win32.join(gitRoot, 'cmd')}`,
  };
  const selected = optimizeAutoDetectedShell(wrapper, env);
  const result = spawnSync(
    selected.shellPath,
    ['--norc', '--noprofile', '-c', 'printf "%s|%s" "$(command -v grep)" "$MSYSTEM"'],
    { env: selected.env, encoding: 'utf8', windowsHide: true },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '/usr/bin/grep|MINGW64');
});
