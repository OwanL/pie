import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyPiRuntimeArtifact } from '../../../../lib/pi-runtime/artifact.mjs';

const entrySource = fileURLToPath(new URL('../index.ts', import.meta.url));

test('registration through Jiti preserves metadata without loading catalog YAML or its resolver', async () => {
  const config = process.env.TSX_TSCONFIG_PATH;
  assert.ok(config, 'use test:file --sdk-path with an independently verified runtime');
  const aliases = JSON.parse(readFileSync(config, 'utf8')).compilerOptions?.paths;
  const sdkEntry = aliases?.['@earendil-works/pi-coding-agent']?.[0];
  assert.ok(sdkEntry && path.isAbsolute(sdkEntry), 'missing selected SDK alias');
  const sdkRoot = path.dirname(path.dirname(sdkEntry));
  const verified = await verifyPiRuntimeArtifact(path.resolve(sdkRoot, '../../..'));
  assert.equal(path.resolve(verified.sdkPath), sdkRoot);
  const sdkRequire = createRequire(sdkEntry);
  const jitiPackage = sdkRequire.resolve('jiti/package.json');
  const staticExport = JSON.parse(readFileSync(jitiPackage, 'utf8')).exports['./static'].import;
  assert.equal(typeof staticExport, 'string');
  const jitiUrl = new URL(staticExport, pathToFileURL(jitiPackage)).href;
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'pie-catalog-registration-'));
  try {
    // Only the SDK directory seam is mocked; all harness registration modules
    // use the real Jiti loader. No session, provider, or user-data access occurs.
    const sdkStub = path.join(fixtureRoot, 'sdk.cjs');
    await writeFile(sdkStub, `exports.getAgentDir = () => ${JSON.stringify(fixtureRoot)};\n`);
    const script = `
      import assert from 'node:assert/strict';
      import Module from 'node:module';
      import { createJiti } from ${JSON.stringify(jitiUrl)};
      const forbidden = /(?:[/\\\\]catalog-sync\\.[cm]?[jt]s$|[/\\\\]package-resolution\\.mjs$|(?:^|[/\\\\])yaml(?:$|[/\\\\]))/;
      const originalLoad = Module._load;
      Module._load = function(request, ...args) {
        assert.ok(!forbidden.test(request), 'registration loaded execution dependency: ' + request);
        return originalLoad.call(this, request, ...args);
      };
      const originalCompile = Module.prototype._compile;
      Module.prototype._compile = function(source, filename) {
        assert.ok(!forbidden.test(filename), 'registration evaluated execution dependency: ' + filename);
        return originalCompile.call(this, source, filename);
      };
      globalThis.fetch = () => { throw new Error('registration must not fetch'); };
      const jiti = createJiti(import.meta.url, {
        moduleCache: false,
        fsCache: false,
        alias: { '@earendil-works/pi-coding-agent': ${JSON.stringify(sdkStub)} },
      });
      const { default: register } = await jiti.import(${JSON.stringify(entrySource)});
      const events = [], commands = [];
      register({
        on: (name, handler) => events.push({name, handler}),
        registerCommand: (name, definition) => commands.push({name, ...definition}),
      });
      assert.deepEqual(events.map(({name, handler}) => ({name, handler: typeof handler})), [
        {name: 'session_start', handler: 'function'},
      ]);
      assert.deepEqual(commands.map(({handler, ...metadata}) => ({...metadata, handler: typeof handler})), [
        {name: 'copilot-sync-models',
         description: 'Force-refresh the GitHub Copilot model catalog now, bypassing the TTL cache',
         handler: 'function'},
      ]);
      assert.ok(Object.keys(Module._cache).every(filename => !forbidden.test(filename)),
        'execution dependency entered the module cache');
      console.log('registration assertions complete');
    `;
    const { NODE_V8_COVERAGE: _coverage, ...env } = process.env;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8', env, timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /registration assertions complete/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
