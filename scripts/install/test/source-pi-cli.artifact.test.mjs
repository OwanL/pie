// Real immutable SDK CLI smoke test; the artifact route supplies its verified SDK selection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { verifyPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';
import { watchChildProcess, withProcessTreeIsolation } from '../../lib/process-watchdog.mjs';
import { collectChild } from './source-pi-cli-test-helpers.mjs';
import { createSourcePiCli } from '../lib/source-pi-cli.mjs';

const { sourceBackendTarget, sourceDescriptor } = await import(
  '../../../harness/agent-processes/lib/sdk-integration/test/source-fixture.ts'
);
const QUALIFIED_TARGET = { platform: 'win32', arch: 'x64', nodeAbi: '137' };
const qualifiedBackend = sourceBackendTarget.platform === QUALIFIED_TARGET.platform
  && sourceBackendTarget.arch === QUALIFIED_TARGET.arch
  && sourceBackendTarget.nodeAbi === QUALIFIED_TARGET.nodeAbi;

test('real immutable win32/x64/ABI137 artifact runs offline --version under an empty isolated HOME', {
  timeout: 60_000,
  skip: qualifiedBackend ? false : 'selected backend is not win32/x64/ABI137',
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-source-pi-cli-artifact-'));
  const controller = new AbortController();
  let childFinished = false;
  let watchdog;
  t.after(async () => {
    if (!childFinished) controller.abort();
    if (watchdog) {
      const teardown = await watchdog.settle();
      assert.equal(teardown.gone, true, 'source Pi CLI child process tree must exit before fixture cleanup');
    }
    rmSync(root, { recursive: true, force: true });
  });

  const target = sourceBackendTarget;
  const selectedCliPath = path.join(sourceDescriptor.sdkPath, 'dist', 'cli.js');
  assert.ok(existsSync(selectedCliPath), `selected verified SDK CLI is missing: ${selectedCliPath}`);
  const home = path.join(root, 'empty home');
  const preload = path.join(root, 'deny-network.cjs');
  const preloadMarker = path.join(root, 'preload-loaded');
  mkdirSync(home);
  writeFileSync(preload, [
    "const net = require('node:net');",
    "const denied = () => { throw new Error('network disabled by source Pi CLI test'); };",
    'net.Socket.prototype.connect = denied;',
    'net.connect = denied;',
    'net.createConnection = denied;',
    "require('node:tls').connect = denied;",
    "for (const name of ['node:http', 'node:https']) { const api = require(name); api.request = denied; api.get = denied; }",
    "require('node:http2').connect = denied;",
    "require('node:dgram').createSocket = denied;",
    "const dns = require('node:dns');",
    "for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {",
    "  for (const name of Object.getOwnPropertyNames(api)) { if (/^(lookup|resolve|reverse)/.test(name)) api[name] = denied; }",
    '}',
    'globalThis.fetch = denied;',
    "require('node:fs').writeFileSync(process.env.SOURCE_PI_TEST_PRELOAD_MARKER, 'loaded');",
    '',
  ].join('\n'));

  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    SOURCE_PI_TEST_PRELOAD_MARKER: preloadMarker,
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
  };
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }

  const before = await verifyPiRuntimeArtifact(sourceDescriptor.artifactDir, { target });
  assert.equal(before.identity, sourceDescriptor.identity);
  const launcher = await createSourcePiCli({
    artifactDir: sourceDescriptor.artifactDir,
    nodeExecutable: process.execPath,
    target,
    spawn: (executable, args, options) => spawn(executable, args, withProcessTreeIsolation(options)),
  });
  const child = launcher.run(['--offline', '--version'], { cwd: home, env, stdio: 'pipe' });
  watchdog = watchChildProcess(child, {
    signal: controller.signal,
    timeoutMs: 60_000,
    label: 'source Pi CLI artifact smoke test',
  });
  const result = await collectChild(child);
  childFinished = true;

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(watchdog.timedOut, false, 'source Pi CLI child must complete within the 60-second deadline');
  assert.match(result.stdout, /0\.80\.6/);
  assert.equal(readFileSync(preloadMarker, 'utf8'), 'loaded');
  assert.deepEqual(readdirSync(home), []);
  const after = await verifyPiRuntimeArtifact(sourceDescriptor.artifactDir, { target });
  assert.equal(after.identity, before.identity);
});
