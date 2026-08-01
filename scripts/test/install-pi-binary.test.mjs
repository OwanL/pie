// Focused unit tests for scripts/install/lib/pi-binary.mjs — the pi CLI
// resolver (PATH first, then npm-prefix probe) shared by both shell installers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lookupOnPath, resolvePiBinary } from '../install/lib/pi-binary.mjs';

test('prefers a PATH-resolved binary over prefix probing', () => {
  assert.equal(resolvePiBinary({ platform: 'posix', prefix: '/p', onPath: '/usr/bin/pi' }), '/usr/bin/pi');
  assert.equal(resolvePiBinary({ platform: 'win32', prefix: 'C:\\p', onPath: 'C:\\bin\\pi.cmd' }), 'C:\\bin\\pi.cmd');
});

test('returns null when nothing is on PATH and no prefix is given', () => {
  assert.equal(resolvePiBinary({ platform: 'posix', onPath: null }), null);
  assert.equal(resolvePiBinary({ platform: 'win32', onPath: null }), null);
});

test('probes Windows prefix candidates in pi.cmd / pi.ps1 / pi order', () => {
  const existing = new Set(['C:\\npm\\pi.ps1']);
  const result = resolvePiBinary({
    platform: 'win32', prefix: 'C:\\npm', onPath: null,
    existsSync: (p) => existing.has(p),
  });
  assert.equal(result, 'C:\\npm\\pi.ps1');
});

test('probes POSIX prefix candidates in bin/pi then pi order and requires executability', () => {
  const existing = new Set(['/p/bin/pi', '/p/pi']);
  const result = resolvePiBinary({
    platform: 'posix', prefix: '/p', onPath: null,
    existsSync: (p) => existing.has(p),
    isExecutable: (p) => p === '/p/pi', // only the non-bin candidate is executable here
  });
  assert.equal(result, '/p/pi');
});

test('returns null when prefix candidates exist but are not executable (posix)', () => {
  const result = resolvePiBinary({
    platform: 'posix', prefix: '/p', onPath: null,
    existsSync: () => true,
    isExecutable: () => false,
  });
  assert.equal(result, null);
});

test('returns null when no prefix candidate exists', () => {
  assert.equal(resolvePiBinary({ platform: 'posix', prefix: '/p', onPath: null, existsSync: () => false }), null);
  assert.equal(resolvePiBinary({ platform: 'win32', prefix: 'C:\\p', onPath: null, existsSync: () => false }), null);
});

test('lookupOnPath finds the first executable on PATH (posix)', () => {
  const existing = new Set(['/usr/bin/pi', '/opt/pi']);
  const result = lookupOnPath({
    name: 'pi', platform: 'posix', env: { PATH: '/usr/bin:/opt' },
    existsSync: (p) => existing.has(p),
    isExecutable: () => true,
  });
  assert.equal(result, '/usr/bin/pi');
});

test('lookupOnPath skips non-executable matches on posix', () => {
  const existing = new Set(['/usr/bin/pi']);
  const result = lookupOnPath({
    name: 'pi', platform: 'posix', env: { PATH: '/usr/bin' },
    existsSync: (p) => existing.has(p),
    isExecutable: () => false,
  });
  assert.equal(result, null);
});

test('lookupOnPath honours PATHEXT on Windows and returns the runnable .cmd shim', () => {
  // The dir contains an extensionless `pi` (a shebang script, not runnable via
  // cmd) and `pi.cmd`; PATHEXT must select pi.cmd, not the bare `pi`.
  const existing = new Set(['C:\\NPM\\PI.CMD']);
  const result = lookupOnPath({
    name: 'pi', platform: 'win32', env: { PATH: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    existsSync: (p) => existing.has(p.toUpperCase()),
  });
  assert.equal(result, 'C:\\npm\\pi.CMD');
});

test('lookupOnPath returns null when PATH is empty or unset', () => {
  assert.equal(lookupOnPath({ name: 'pi', platform: 'posix', env: {}, existsSync: () => true }), null);
  assert.equal(lookupOnPath({ name: 'pi', platform: 'win32', env: {}, existsSync: () => true }), null);
});
