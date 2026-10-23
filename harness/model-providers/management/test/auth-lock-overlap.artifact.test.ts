import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { watchChildProcess, withProcessTreeIsolation } from '../../../../scripts/lib/process-watchdog.mjs';
import { loadSdk, type SourceArtifactSdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../../agent-processes/lib/sdk-integration/test/source-fixture';
import { createProviderManagementService } from '../service';

// Regression fixture: no live OAuth, user stores, coordinator, or desktop are used.
// This is the same real SDK broker constructed by the coordinator, with private paths.
export async function runAuthLockOverlap(directory: string, overlap: boolean) {
  const timeline: { event: string; ms: number; detail?: string }[] = [];
  const start = performance.now();
  const mark = (event: string, detail?: string) => timeline.push({ event, ms: Math.round(performance.now() - start), ...(detail ? { detail } : {}) });
  const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode) as SourceArtifactSdkModule;
  const credentialFile = join(directory, 'credentials.json');
  const configFile = join(directory, 'providers.yaml');
  const provider = 'github-copilot';
  const model = sdk.getProviderManagementModels!(provider).find(candidate => candidate.api === 'openai-completions');
  assert.ok(model, 'Fixture needs a native Copilot model surviving account filtering');
  await writeFile(credentialFile, JSON.stringify({ [provider]: { type: 'oauth', refresh: 'synthetic-refresh', access: 'synthetic-expired', expires: 1 } }));
  await writeFile(configFile, JSON.stringify({ version: 1, providers: { [provider]: { enabled: true, api: 'openai-completions', baseUrl: 'https://api.githubcopilot.com', credentialRef: { source: 'saved' } } } }));
  let release!: () => void;
  let entered!: () => void;
  const enteredRefresh = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async input => {
    const url = String(input instanceof Request ? input.url : input);
    mark('fetch', url);
    if (url === 'https://api.github.com/copilot_internal/v2/token') {
      mark('token-fetch-enter'); entered(); await gate; mark('token-fetch-resolve');
      return Response.json({ token: 'synthetic-new', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (url === 'https://api.githubcopilot.com/models' || url === 'https://api.individual.githubcopilot.com/models') {
      mark('models-fetch');
      return Response.json({ data: [{ id: model.id, name: 'Synthetic account listing', model_picker_enabled: true,
        supported_endpoints: ['/chat/completions'], billing: { token_prices: { default: { input_price: 1, output_price: 2 } } } }] });
    }
    throw new Error(`Unexpected intercepted URL: ${url}`);
  };
  const broker = sdk.createProviderManagementAuth!(credentialFile);
  const apiKey = broker.getApiKey.bind(broker);
  broker.getApiKey = async id => {
    mark('getApiKey-enter');
    try { return await apiKey(id); }
    catch (error) { mark('getApiKey-throws', String(error)); throw error; }
    finally { mark('getApiKey-settled'); }
  };
  assert.equal(typeof broker.listSavedCredentialIds, 'function', 'Requires the newly built async broker API');
  const listSaved = broker.listSavedCredentialIds.bind(broker);
  broker.listSavedCredentialIds = async () => {
    mark('presence-enter');
    try { return await listSaved(); }
    finally { mark('presence-settled'); }
  };
  const removeCredential = broker.removeCredential!.bind(broker);
  broker.removeCredential = async id => {
    mark('removeCredential-enter');
    try { await removeCredential(id); } finally { mark('removeCredential-settled'); }
  };
  const service = createProviderManagementService({ configFile, modelCacheDir: join(directory, 'cache'), auth: broker,
    onSnapshot: snapshot => { mark('onSnapshot', JSON.stringify({ revision: snapshot.revision,
      discovery: snapshot.providers[0]?.discovery ?? 'removed', error: snapshot.error })); } });
  let heartbeat = 0;
  const heartbeatTimer = setInterval(() => { heartbeat++; }, 10);
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'Native wait boundary was not reached'); await delay(5); }
  };
  try {
    // read-provider loads without starting automatic discovery.
    const detail = await service.request({ type: 'read-provider', id: provider, operationId: 'detail' });
    assert.equal(detail.status, 'ok');
    const refresh = service.request({ type: 'refresh', id: provider, operationId: 'refresh' });
    await enteredRefresh;
    mark('refresh-gated');
    let cancelStatus: string | undefined, refreshStatus: string;
    let removed: { status: string; error?: string };
    let heartbeatDuringNativeWait = false;
    const remove = () => service.request({ type: 'remove', id: provider, operationId: 'remove', expectedRevision: detail.snapshot.configRevision });
    if (overlap) {
      // Neither response is awaited here: both legitimately need a presence batch
      // behind the held native lock, while cancellation and policy commit must proceed.
      const cancelled = service.request({ type: 'cancel', operationId: 'cancel', targetOperationId: 'refresh' });
      mark('removal-started-before-token-release');
      const removal = remove();
      await until(() => timeline.some(row => row.event === 'removeCredential-enter'));
      const before = heartbeat;
      await until(() => heartbeat >= before + 2);
      heartbeatDuringNativeWait = !timeline.some(row => row.event === 'token-fetch-resolve');
      assert.equal(heartbeatDuringNativeWait, true, 'Event loop must advance while removal waits on the held native refresh');
      mark('heartbeat-during-native-wait');
      mark('token-gate-released'); release();
      const [cancelResponse, refreshResponse, removeResponse] = await Promise.all([cancelled, refresh, removal]);
      cancelStatus = cancelResponse.status;
      assert.equal(cancelStatus, 'ok', 'Cancel must respond normally, not merely abort discovery');
      refreshStatus = refreshResponse.status;
      removed = { status: removeResponse.status, error: removeResponse.snapshot.error };
    } else {
      release();
      const refreshed = await refresh;
      refreshStatus = refreshed.status;
      assert.equal(refreshed.snapshot.providers[0].discovery, 'fresh');
      assert.ok(refreshed.draft?.models.some(candidate => candidate.id === model.id), 'Baseline must produce the current native account model');
      const removeResponse = await remove();
      removed = { status: removeResponse.status, error: removeResponse.snapshot.error };
    }
    mark('cancel-result', cancelStatus); mark('refresh-observer-settled', refreshStatus);
    mark('remove-result', JSON.stringify(removed));
    await until(() => timeline.some(row => row.event === 'getApiKey-settled'));
    // Drain the late key continuation and all queued projections before checking disk.
    await service.request({ type: 'read-provider', id: provider, operationId: 'after-late-work' });
    const credentials = JSON.parse(await readFile(credentialFile, 'utf8'));
    const config = await readFile(configFile, 'utf8');
    const evidence = { overlap, cancelStatus, heartbeatDuringNativeWait, refreshStatus, removed, credentialPersists: Object.hasOwn(credentials, provider), tombstone: /removed: true/.test(config), timeline };
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  } finally { release(); clearInterval(heartbeatTimer); service.dispose(); }
}

if (process.env.PIE_AUTH_LOCK_CHILD !== '1') {
  for (const overlap of [false, true]) test(`real OAuth auth lock ${overlap ? 'overlap' : 'drained baseline'}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pie-auth-lock-repro-'));
    let cleanupConfirmed = false;
    t.after(async () => { if (cleanupConfirmed) await rm(directory, { recursive: true, force: true }); });
    const runner = join(directory, 'runner.cjs');
    const require = createRequire(import.meta.url);
    await writeFile(runner, `require(${JSON.stringify(require.resolve('tsx/cjs'))});\nrequire(${JSON.stringify(fileURLToPath(import.meta.url))}).runAuthLockOverlap(${JSON.stringify(directory)}, ${overlap}).catch(error => { console.error(error); process.exitCode = 1; });\n`);
    const child = spawn(process.execPath, [runner], withProcessTreeIsolation({
      env: { ...process.env, PIE_AUTH_LOCK_CHILD: '1', NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }));
    const watchdog = watchChildProcess(child, { timeoutMs: 45_000, label: 'auth lock reproduction' });
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const cleanup = await watchdog.settle();
    cleanupConfirmed = cleanup.gone;
    assert.equal(cleanupConfirmed, true, `Child teardown uncertain: ${directory}`);
    assert.equal(watchdog.timedOut, false, output);
    assert.equal(code, 0, output);
    const evidence = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8'));
    t.diagnostic(JSON.stringify(evidence));
    if (overlap) {
      assert.equal(evidence.cancelStatus, 'ok', 'Cancellation response must explicitly succeed');
      assert.equal(evidence.heartbeatDuringNativeWait, true);
      const order = (event: string) => evidence.timeline.findIndex((row: { event: string }) => row.event === event);
      assert.ok(order('removal-started-before-token-release') < order('token-gate-released'));
      assert.ok(order('removeCredential-enter') < order('heartbeat-during-native-wait'));
      assert.ok(order('heartbeat-during-native-wait') < order('token-gate-released'));
    }
    assert.equal(evidence.tombstone, true);
    assert.equal(evidence.refreshStatus, overlap ? 'cancelled' : 'ok', 'Refresh must settle normally after native refresh completion or cancellation');
    assert.equal(evidence.removed.status, 'ok', 'Removal must succeed after refresh cancellation, without native lock contention');
    assert.equal(evidence.credentialPersists, false, 'Removal must delete the canonical credential');
  });
}
