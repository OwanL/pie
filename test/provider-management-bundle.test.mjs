import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createOwnerRequire } from '../scripts/lib/package-resolution.mjs';
import { prepareDevelopment } from '../scripts/development/launch.mjs';

test('development profile overrides ambient provider configuration without seeding private data', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pie-provider-development-'));
  try {
    const repositoryRoot = path.join(temp, 'repository');
    const host = path.join(repositoryRoot, 'application/hosts/vscode');
    await mkdir(path.join(host, 'media'), { recursive: true });
    await writeFile(path.join(repositoryRoot, 'settings.defaults.json'), '{}');
    await writeFile(path.join(repositoryRoot, 'models.json'), '{}');
    await writeFile(path.join(host, 'package.json'), '{"name":"fixture"}');
    await writeFile(path.join(host, 'media/icon.svg'), '<svg/>');
    const prepared = await prepareDevelopment({ repositoryRoot, profileRoot: path.join(temp, 'profile'), sourceEnvironment: { PIE_PROVIDER_CONFIG_DIR: path.join(temp, 'never-read-personal-config') } });
    assert.equal(prepared.env.PIE_PROVIDER_CONFIG_DIR, path.join(prepared.profile, 'providers'));
    assert.deepEqual(await readdir(prepared.env.PIE_PROVIDER_CONFIG_DIR), []);
    assert.deepEqual(await readdir(prepared.env.PI_CODING_AGENT_AUTH_DIR), []);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

const root = fileURLToPath(new URL('../', import.meta.url));
const owner = createOwnerRequire();
test('provider management CJS embeds its schema and loads an empty relocated profile without SDK', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pie-provider-bundle-'));
  try {
    const output = path.join(temp, 'management.cjs');
    await owner('esbuild').build({
      stdin: { contents: `export { createProviderManagementService } from './harness/model-providers/management/service'; export { parseProviderConfig } from './harness/model-providers/catalog/provider-config'; export { assertProviderManagementPathsOutsideGit } from './harness/model-providers/catalog/provider-config-paths';`, resolveDir: root, loader: 'ts' },
      outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      plugins: [{ name: 'owner-dependencies', setup(build) {
        build.onResolve({ filter: /^(yaml|ajv)$/ }, args => ({ path: owner.resolve(args.path) }));
      } }],
    });
    const api = createRequire(import.meta.url)(output);
    const paths = { configDir: path.join(temp, 'providers'), configFile: path.join(temp, 'providers/providers.yaml'), modelCacheDir: path.join(temp, 'cache') };
    await api.assertProviderManagementPathsOutsideGit(paths);
    assert.equal(api.parseProviderConfig('version: 1\nproviders: {}\n').status, 'valid');
    assert.equal(api.parseProviderConfig('version: 2\nproviders: {}\n').status, 'invalid');
    const service = api.createProviderManagementService({ ...paths, auth: { definitions: () => [], hasSavedCredential: () => false }, fetch: () => { throw new Error('Unexpected fetch'); } });
    try {
      const response = await service.request({ type: 'read', operationId: 'empty-profile' });
      assert.equal(response.status, 'ok');
      assert.equal(response.snapshot.loaded, true);
      assert.deepEqual(response.snapshot.providers, []);
    } finally { service.dispose(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
