import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderManagementService } from '../service';

test('private capture is offline, missing is legacy and invalid fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-capture-'));
  const forbidden = () => { throw new Error('unexpected credential/network effect'); };
  const service = createProviderManagementService({ configFile: join(dir, 'providers.yaml'), modelCacheDir: join(dir, 'cache'),
    auth: { definitions: () => [], hasSavedCredential: forbidden, stageOAuthLogin: forbidden,
      saveCredential: forbidden, getApiKey: forbidden, discoveryBaseUrl: forbidden }, fetch: forbidden, onSnapshot: forbidden });
  try {
    assert.equal(await service.captureRuntimeProjection([]), undefined);
    await writeFile(join(dir, 'providers.yaml'), 'version: 1\nproviders: {}\n');
    assert.deepEqual((await service.captureRuntimeProjection([]))?.models, []);
    await writeFile(join(dir, 'providers.yaml'), 'version: 999\nproviders: {}\n');
    await assert.rejects(service.captureRuntimeProjection([]));
  } finally { service.dispose(); await rm(dir, { recursive: true, force: true }); }
});
