import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createBundledManagedInventory } from '../../../../../lib/managed-packages/bundled-resources.mjs';
import { MANAGED_PACKAGE_REQUIREMENTS, adaptManagedPackageSources } from '../../../../../lib/managed-packages/managed-package-contract.mjs';
// @ts-expect-error Public test-only JavaScript fixture has no declaration file.
import { pristineSources } from '../../../../../lib/managed-packages/bundled-resources-fixture.mjs';

for (const format of ['cjs', 'esm'] as const) {
  test(`default ${format} guard resolves its own payload, validates read-only and fails closed`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pie-bundled-guard-'));
    const previous = { ...process.env };
    const write = (relative: string, text: string) => {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return file;
    };
    try {
      const output = path.join(root, format === 'cjs' ? 'guard.cjs' : 'guard.mjs');
      await build({ entryPoints: [path.resolve('harness/tools/package-integrations/web-access/index.ts')], outfile: output, bundle: true, platform: 'node', format, logLevel: 'silent' });
      const extension = format === 'cjs' ? createRequire(import.meta.url)(output).default : (await import(pathToFileURL(output).href)).default;
      const base = 'resources/managed-integrations';
      const marker = write(`${base}/manifest.json`, JSON.stringify(createBundledManagedInventory({
        runtimeIdentity: 'a'.repeat(64), closureInventorySha256: 'b'.repeat(64), qualificationRecipeSha256: 'c'.repeat(64),
        target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
      })));
      for (const pin of MANAGED_PACKAGE_REQUIREMENTS) {
        const pkg = `${base}/node_modules/${pin.name}`;
        write(`${pkg}/package.json`, JSON.stringify({ name: pin.name, version: pin.version }));
        for (const file of pin.requiredFiles) write(`${pkg}/${file}`, '// sentinel dependency');
        const adapted = adaptManagedPackageSources(pin.name, pin.name === 'pi-web-access'
          ? { index: pristineSources.webIndex, storage: pristineSources.storage }
          : { index: pristineSources.mcpIndex, agentDir: pristineSources.agentDir });
        for (const [key, text] of Object.entries(adapted)) write(`${pkg}/${key === 'agentDir' ? 'agent-dir' : key}.ts`, text);
      }
      process.env.PI_CODING_AGENT_DIR = path.join(root, 'legacy');
      process.env.PIE_DATA_DIR = path.join(root, 'data');
      process.env.PIE_CACHE_DIR = 'sentinel-cache';
      const legacy = write('legacy/npm/node_modules/pi-web-access/index.ts', pristineSources.webIndex);
      write('legacy/npm/node_modules/pi-web-access/package.json', '{"name":"pi-web-access","version":"0.27.0"}');
      const artifact = write('legacy/npm/node_modules/pi-web-access/missing.js.DELETE.sentinel', 'do not repair');
      const env = { ...process.env };
      const web = path.join(root, base, 'node_modules/pi-web-access/index.ts');
      const prepared = readFileSync(web, 'utf8');
      await extension({});
      assert.deepEqual({ ...process.env }, env);
      assert.equal(readFileSync(legacy, 'utf8'), pristineSources.webIndex);
      assert.equal(existsSync(artifact), true);
      assert.equal(existsSync(artifact.replace('.DELETE.sentinel', '')), false);
      assert.equal(readFileSync(web, 'utf8'), prepared);
      for (const source of [pristineSources.webIndex, prepared + '\n' + pristineSources.webIndex]) {
        writeFileSync(web, source);
        await assert.rejects(extension({}));
        assert.equal(readFileSync(web, 'utf8'), source, 'must not heal bundled bytes');
      }
      writeFileSync(web, prepared);
      writeFileSync(marker, '{broken');
      await assert.rejects(extension({}));
      assert.deepEqual({ ...process.env }, env);
      assert.equal(readFileSync(legacy, 'utf8'), pristineSources.webIndex);
      assert.equal(existsSync(artifact), true);
      // Marker absence preserves the real default legacy readiness route.
      rmSync(marker);
      await extension({});
      assert.equal(process.env.PIE_CACHE_DIR, path.join(root, 'data', 'cache'));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
