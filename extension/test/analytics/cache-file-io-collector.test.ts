import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error The collector is a qualification-only plain ESM script.
import { COLLECTOR_VERSION, startCacheFileIoCollector, validateCacheIoCatch, validateCacheIoEvidence } from '../../scripts/cache-file-io-collector.mjs';

function catchEvent(overrides = {}) {
  return {
    type: 'io',
    file: 'C:\\cache\\mcp-cache.json',
    pid: 4242,
    processStartTime100ns: '13400990000000000',
    processStartTimeUnixMs: 1789416632039,
    appName: 'node.exe',
    applicationType: 1,
    appStatus: 0,
    tsSessionId: 0,
    restartable: false,
    observedAtMs: Date.now(),
    pollTick: 3,
    identity: null,
    ...overrides,
  };
}

function identity(overrides = {}) {
  return { pid: 4242, creationUnixMs: 1789416632039, ...overrides };
}

test('cache IO catch validation rejects malformed observations', () => {
  for (const malformed of [
    null,
    {},
    catchEvent({ type: 'receipt' }),
    catchEvent({ pid: 0 }),
    catchEvent({ processStartTime100ns: 'not-numeric' }),
    catchEvent({ processStartTimeUnixMs: 0 }),
    catchEvent({ appName: '' }),
    catchEvent({ file: 'relative\\path.json' }),
    catchEvent({ pollTick: -1 }),
  ]) {
    const result = validateCacheIoCatch(malformed, []);
    assert.equal(result.valid, false, JSON.stringify(malformed));
    assert.ok(result.errors.length > 0);
  }
});

test('cache IO catch validation binds pid and kernel process start time', () => {
  const expected = [identity()];
  const exact = validateCacheIoCatch(catchEvent(), expected);
  assert.equal(exact.valid, true, exact.errors.join('; '));

  const withinWindow = validateCacheIoCatch(catchEvent({ processStartTimeUnixMs: 1789416632039 + 1500 }), expected);
  assert.equal(withinWindow.valid, true, withinWindow.errors.join('; '));

  const outsideWindow = validateCacheIoCatch(catchEvent({ processStartTimeUnixMs: 1789416632039 + 5000 }), expected);
  assert.equal(outsideWindow.valid, false);
  assert.match(outsideWindow.errors.join('; '), /creation window/u);

  const unknownPid = validateCacheIoCatch(catchEvent({ pid: 9999 }), expected);
  assert.equal(unknownPid.valid, false);
  assert.match(unknownPid.errors.join('; '), /expected identity/u);

  // A loose tolerance restores the wide window.
  const loose = validateCacheIoCatch(catchEvent({ processStartTimeUnixMs: 1789416632039 + 5000 }), expected, 8000);
  assert.equal(loose.valid, true, loose.errors.join('; '));
});

test('cache IO evidence validation requires bounded honest envelopes', () => {
  const validCatch = catchEvent();
  const base = {
    version: COLLECTOR_VERSION,
    enabled: true,
    platform: process.platform,
    qualificationOnly: true,
    files: ['C:\\cache\\mcp-cache.json'],
    pollTicks: 40,
    catches: [validCatch],
    stopReason: 'duration-expired',
    protocolErrors: [],
  };
  const result = validateCacheIoEvidence(base, [identity()]);
  assert.equal(result.valid, true, result.errors.join('; '));

  const unqualified = { ...base, qualificationOnly: false };
  assert.equal(validateCacheIoEvidence(unqualified, [identity()]).valid, false);

  const noCatch = { ...base, catches: [] };
  const empty = validateCacheIoEvidence(noCatch, [identity()]);
  assert.equal(empty.valid, false);
  assert.match(empty.errors.join('; '), /no catches/u);

  const forcedStop = { ...base, stopReason: 'killed-hard' };
  assert.equal(validateCacheIoEvidence(forcedStop, [identity()]).valid, false);

  const protocolFailure = { ...base, protocolErrors: ['malformed-json'] };
  assert.equal(validateCacheIoEvidence(protocolFailure, [identity()]).valid, false);
});

test('collector validates bounded options before any platform startup', async () => {
  await assert.rejects(
    startCacheFileIoCollector({ pollIntervalMs: 1 }),
    /pollIntervalMs/u,
  );
  await assert.rejects(
    startCacheFileIoCollector({ maxEvents: 0 }),
    /maxEvents/u,
  );
  await assert.rejects(
    startCacheFileIoCollector({ maxDurationMs: 999 }),
    /maxDurationMs/u,
  );
  await assert.rejects(
    startCacheFileIoCollector({ files: [] }),
    /between 1 and 16/u,
  );
});

test('Windows collector binds a live same-process cache write to the runner identity', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-cache-io-collector-'));
  const monitored = path.join(directory, 'proof-cache.json');
  fs.writeFileSync(monitored, 'seed\n');
  const creationOutput = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')`,
  ], { encoding: 'utf8' }).trim();
  const ownCreationUnixMs = Date.parse(creationOutput);
  assert.ok(Number.isFinite(ownCreationUnixMs), `runner creation time unreadable: ${creationOutput}`);
  const expected = [{ pid: process.pid, creationUnixMs: ownCreationUnixMs }];

  const collector = await startCacheFileIoCollector({
    files: [monitored],
    pollIntervalMs: 5,
    maxEvents: 32,
    maxDurationMs: 20_000,
  });
  assert.equal(collector.enabled, true, JSON.stringify(collector));
  try {
    // Hold the file open in bounded bursts so the momentary handle is wide
    // enough for a Restart Manager poll to observe it without changing the
    // collector's read-only posture.
    for (let burst = 0; burst < 120 && collector.catches.length === 0; burst += 1) {
      const handle = fs.openSync(monitored, 'a');
      try {
        fs.writeSync(handle, `${burst}\n`);
        const end = Date.now() + 8;
        while (Date.now() < end) { /* hold the open handle briefly */ }
      } finally {
        fs.closeSync(handle);
      }
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    assert.ok(collector.catches.length > 0, JSON.stringify(collector.snapshot()));
    const caught = collector.catches[0];
    // Windows may expand 8.3 short names inside the native helper; compare
    // resolved long paths case-insensitively (native realpath expands 8.3
    // components, unlike the JS default resolver).
    const monitoredReal = (() => {
      try { return fs.realpathSync.native(monitored).toLowerCase(); }
      catch { return fs.realpathSync(monitored).toLowerCase(); }
    })();
    assert.equal(caught.file.toLowerCase(), monitoredReal);
    assert.equal(caught.pid, process.pid);
    const binding = validateCacheIoCatch(caught, expected);
    assert.equal(binding.valid, true, JSON.stringify({ binding, caught }));
  } finally {
    const evidence = await collector.stop();
    const validation = validateCacheIoEvidence(evidence, expected);
    assert.equal(validation.valid, true, JSON.stringify({ validation, evidence }));
  }
});