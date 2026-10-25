import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnerRequire } from '../../../lib/package-resolution.mjs';
import { snapshotProcessTree, watchChildProcess } from '../../../lib/process-watchdog.mjs';

// Invocation-only acceptance fixture: never connects to an existing browser or
// installs one. The parent supplies a separate OS-temp HOME/TEMP and private URL.
const [baseUrl, fixtureRoot, executablePath] = process.argv.slice(2);
const origin = new URL(baseUrl).origin;
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.ok(![1996, 1997].includes(Number(new URL(origin).port)));
assert.equal(path.resolve(process.env.TEMP), path.resolve(fixtureRoot));
const providerOptIn = process.env.PIE_RUN_DELIVERED_PROVIDER_TESTS === '1';
const fakeKey = `fixture-only-${randomUUID()}`;
const received = [];
const consoleMessages = [];
const sent = [];
let modelServer;
let modelRequests = 0;
const errors = [];
const externalRequests = [];
let server;
let launchAttempted = false;
let browser;
let watchdog;
let safe = false;
let closeConfirmed = false;
let failure;
let assetVersion;
let page;
let diagnostics;
try {
  const ownerRequire = createOwnerRequire();
  let playwright;
  try {
    playwright = ownerRequire('@playwright/test');
    const installed = ownerRequire('@playwright/test/package.json');
    const owner = ownerRequire('./package.json');
    assert.equal(installed.version, owner.devDependencies['@playwright/test'], 'acceptance must use the VS Code owner pinned Playwright');
    assert.ok(path.isAbsolute(executablePath) && (await lstat(executablePath)).isFile());
  } catch (error) {
    throw new Error(`Delivered-browser blocker: the VS Code owner's pinned @playwright/test and its installed Chromium are required; no download/install is attempted. ${error.message}`);
  }
  await mkdir(path.join(fixtureRoot, 'downloads'), { recursive: true });
  launchAttempted = true;
  server = await playwright.chromium.launchServer({
    headless: true,
    executablePath,
    timeout: 20_000,
    downloadsPath: path.join(fixtureRoot, 'downloads'),
    env: process.env,
  });
  watchdog = watchChildProcess(server.process(), { timeoutMs: providerOptIn ? 120_000 : 60_000, label: 'delivered headless Chromium' });
  const profileArg = server.process().spawnargs.find(arg => arg.startsWith('--user-data-dir='));
  assert.ok(profileArg, 'Chromium must expose its private temporary user-data directory');
  const relative = path.relative(fixtureRoot, profileArg.slice('--user-data-dir='.length));
  assert.ok(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), 'Chromium userData must be under the separate browser fixture root');
  browser = await playwright.chromium.connect(server.wsEndpoint(), { timeout: 10_000 });
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) await route.continue();
    else {
      externalRequests.push(url);
      await route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.protocol === 'ws:' && url.host === new URL(origin).host) {
      const upstream = socket.connectToServer();
      socket.onMessage(message => {
        sent.push(String(message));
        upstream.send(message);
      });
      upstream.onMessage(message => {
        received.push(String(message));
        socket.send(message);
      });
    }
    else {
      externalRequests.push(socket.url());
      socket.close();
    }
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    consoleMessages.push(message.text());
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  const response = await page.goto(baseUrl, { waitUntil: 'load', timeout: 25_000 });
  assert.equal(response.status(), 200);
  const html = await response.text();
  const version = html.match(/name="pie-asset-version" content="([^"]+)"/u)?.[1];
  assert.match(version ?? '', /^[0-9a-f]{16}$/u, 'document must identify the delivered compiled asset build');
  assetVersion = version;
  assert.equal(await page.locator('meta[name="pie-asset-version"]').getAttribute('content'), version);
  const { expect } = playwright;
  await expect(page.locator('body > #app')).not.toBeEmpty({ timeout: 25_000 });
  // A private profile has no open tabs. PanelMain paints its empty surface;
  // the composer is absent, while Settings remains in the empty tab bar.
  await expect(page.locator('.empty-state-title')).toHaveText('Start a session', { timeout: 25_000 });
  await expect(page.locator('.empty-state-title')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveCount(0);
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(settingsButton).toBeVisible();
  await expect(page.locator('.session-tabs-actions').getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
  // AppBody enables New session only when transport is connected AND backendReady.
  // Do not click: startup/handshake only, no prompt or model request.
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeEnabled({ timeout: 25_000 });
  await expect(page.locator('[data-connection-banner]')).toHaveCount(0);
  const compiledScripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src));
  assert.ok(compiledScripts.some(url => new URL(url).origin === origin && /\/assets\/panel-/u.test(new URL(url).pathname)), 'paint must come from this private host compiled panel');
  if (providerOptIn) {
    assert.equal(process.env.PIE_DELIVERED_HOST_ADAPTER, 'vscode');
    const evidence = process.env.PIE_DELIVERED_PROVIDER_EVIDENCE_DIR;
    assert.ok(evidence && path.isAbsolute(evidence), 'explicit absolute OS-temp evidence directory required');
    const contained = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
    const physicalEvidence = await realpath(path.resolve(evidence));
    const checkoutRoot = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'));
    const profileRoot = await realpath(process.env.PIE_DELIVERED_HOST_PROFILE_DIR);
    const physicalFixtureRoot = await realpath(fixtureRoot);
    for (const [label, root] of [['application profile', profileRoot], ['browser fixture', physicalFixtureRoot], ['checkout', checkoutRoot]]) {
      assert.ok(!contained(root, physicalEvidence) && !contained(physicalEvidence, root), `evidence must be outside ${label}`);
    }
    const shot = async name => page.screenshot({ path: path.join(physicalEvidence, `${name}.png`), fullPage: true });
    modelServer = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/v1/models') { response.writeHead(403); response.end(); return; }
      modelRequests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'fixtureModel', object: 'model' }] }));
    });
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
    const stubUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeVisible();
    // The selected model control must not change as a side effect of saving.
    const selectedControls = page.locator('.model-picker-trigger');
    await expect(selectedControls.first()).toBeVisible();
    const selected = await selectedControls.allTextContents();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
    await expect(settings.getByRole('button', { name: 'Add provider', exact: true })).toBeEnabled();
    await shot('home-normal');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('home-narrow');
    await page.setViewportSize({ width: 1000, height: 900 });
    await settings.getByRole('button', { name: 'Add provider', exact: true }).click();
    const flow = page.locator('dialog.provider-setup-preview');
    await flow.getByRole('button', { name: /^Other provider/ }).click();
    await flow.getByLabel('Connection method').selectOption('api-key');
    await flow.getByLabel('Server URL').fill(stubUrl);
    await shot('connect'); // Capture before entering private input.
    await flow.getByLabel('API key', { exact: true }).fill(fakeKey);
    await flow.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(flow.getByRole('heading', { name: 'Provider saved' })).toBeVisible();
    await shot('done');
    assert.deepEqual(await selectedControls.allTextContents(), selected);
    await flow.getByRole('button', { name: 'Add another provider' }).click();
    await expect(flow.getByRole('heading', { name: 'Choose a provider' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(flow).toHaveCount(0);
    await expect(settings).toBeVisible();
    const row = settings.locator('.provider-setup-preview-list li').filter({ has: page.getByRole('button', { name: 'Models', exact: true }) }).filter({ hasText: '1 models' });
    // Core discovery has a 10s deadline; the default 5s assertion can
    // terminate the host while its discovery operation is still pending.
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.getByRole('button', { name: 'Models', exact: true }).click();
    await flow.getByLabel('Visibility for fixtureModel', { exact: true }).selectOption('yes');
    await flow.getByLabel('Exact model ID').fill('fixtureManual');
    await flow.getByRole('button', { name: 'Add model', exact: true }).click();
    await flow.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await expect(flow.getByLabel('Visibility for fixtureModel', { exact: true })).toHaveValue('yes');
    await expect(flow.getByLabel('Visibility for fixtureManual', { exact: true })).toBeVisible();
    await flow.locator('details').first().locator('summary').click();
    await expect(flow.getByText('Price unknown', { exact: true }).first()).toBeVisible();
    await shot('models');
    const config = process.env.PIE_PROVIDER_CONFIG_DIR;
    const savePreferences = flow.getByRole('button', { name: 'Save model visibility preferences' });
    await savePreferences.click();
    await expect.poll(async () => readFile(path.join(config, 'providers.yaml'), 'utf8')).toContain('fixtureManual');
    await expect(savePreferences).toBeEnabled();
    assert.deepEqual(await selectedControls.allTextContents(), selected);
    await page.keyboard.press('Escape');
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(settings).toHaveCount(0);
    assert.equal(path.resolve(config), path.resolve(process.env.PIE_DELIVERED_HOST_PROFILE_DIR, 'providers'));
    for (const filename of ['providers.yaml', 'credentials.json']) {
      assert.ok(contained(profileRoot, await realpath(path.join(config, filename))));
    }
    const yaml = await readFile(path.join(config, 'providers.yaml'), 'utf8');
    assert.ok(yaml.includes('fixtureManual') && yaml.includes('fixtureModel') && yaml.includes(stubUrl));
    const savedConfig = createOwnerRequire()('yaml').parse(yaml);
    assert.equal(savedConfig.providers.other.modelPreferences.fixtureModel.visible, true);
    assert.ok(savedConfig.providers.other.manualModels.includes('fixtureManual'));
    assert.ok(!yaml.includes(fakeKey), 'canonical YAML must not contain private input');
    assert.ok((await readFile(path.join(config, 'credentials.json'), 'utf8')).includes(fakeKey), 'private credential must be saved in owned credential file');
    const cache = path.join(process.env.PIE_DATA_DIR, 'cache', 'provider-models');
    assert.ok(contained(profileRoot, await realpath(cache)));
    const cacheFiles = await readdir(cache);
    assert.ok(cacheFiles.some(name => /^[a-f0-9]{64}\.json$/u.test(name)), 'canonical discovery cache must exist');
    assert.ok(modelRequests >= 2, 'connect and explicit refresh must reach only owned discovery stub');
    const privateFrames = sent.filter(message => message.includes(fakeKey)).map(message => JSON.parse(message));
    assert.equal(privateFrames.length, 1, 'private input must use only one dedicated connect ingress frame');
    assert.equal(privateFrames[0].type, 'providerManagementConnect');
    assert.equal(privateFrames[0].method, 'api-key');
    assert.equal(privateFrames[0].apiKey, fakeKey);
    assert.ok(received.length > 0, 'received WebSocket evidence must be captured');
    assert.ok(!received.some(message => message.includes(fakeKey)), 'private input leaked into received WebSocket snapshots');
    assert.ok(!consoleMessages.some(message => message.includes(fakeKey)), 'private input leaked into renderer console');
  }
  assert.deepEqual(externalRequests, [], 'renderer attempted external network');
  assert.deepEqual(errors, [], 'renderer console/page errors');
} catch (error) {
  failure = error;
  // Text-only, bounded evidence from the still-live DOM, outside the app profile.
  // Diagnostics must never replace the assertion failure or prevent teardown.
  try {
    diagnostics = {
      modelRequests,
      aria: (await page?.locator('body').ariaSnapshot({ timeout: 2_000 }))?.slice(0, 12_000),
      dom: await page?.evaluate(() => ({
        text: document.body.innerText.slice(0, 12_000),
        appRoots: document.querySelectorAll('#app').length,
        assetVersion: document.querySelector('meta[name="pie-asset-version"]')?.content,
        scripts: [...document.querySelectorAll('script[src]')].map(node => node.src).slice(0, 20),
        connectionBanner: !!document.querySelector('[data-connection-banner]'),
        newSessionEnabled: [...document.querySelectorAll('button')].some(node => node.getAttribute('aria-label') === 'New session' && !node.disabled),
        emptyTitle: document.querySelector('.empty-state-title')?.textContent,
        composerPresent: !!document.querySelector('[aria-label="Message composer"]'),
        settingsPresent: !!document.querySelector('button[aria-label="Settings"]'),
      })),
      errors: errors.slice(0, 30), externalRequests: externalRequests.slice(0, 30),
    };
  } catch (diagnosticError) {
    diagnostics = { ...diagnostics, modelRequests, collectionError: diagnosticError.message, errors: errors.slice(0, 30), externalRequests: externalRequests.slice(0, 30) };
  }
  console.error(`Browser diagnostics: ${JSON.stringify(diagnostics).replaceAll(fakeKey, '[redacted]')}`);
} finally {
  // Capture owned descendants while the browser is still live: a snapshot only
  // after close could miss a reparented Chromium child. PID reuse is treated as
  // uncertainty (retention), never authority to kill an unrelated process.
  const owned = server ? snapshotProcessTree(server.process().pid) : [];
  try {
    if (modelServer) await new Promise((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve()));
    await browser?.close();
    await server?.close();
    closeConfirmed = true;
  } catch (error) {
    failure ??= error;
  }
  const tree = watchdog ? await watchdog.settle() : { gone: !server, survivors: [] };
  const stillLive = owned.filter(entry => {
    try { process.kill(entry.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  });
  const ownershipKnown = !launchAttempted || (owned.length > 0 && owned.every(entry => entry.identity != null));
  safe = closeConfirmed && ownershipKnown && stillLive.length === 0 && tree.gone && tree.survivors.length === 0 && !watchdog?.timedOut;
  await writeFile(path.join(fixtureRoot, 'browser-evidence.json'), JSON.stringify({ errors, externalRequests, modelRequests, diagnostics, closeConfirmed, safe, owned, stillLive, tree }, null, 2).replaceAll(fakeKey, '[redacted]'));
  process.send?.({ type: 'browser-result', safe, assetVersion, error: failure?.stack?.replaceAll(fakeKey, '[redacted]') });
  if (!safe) failure ??= new Error(`Chromium teardown unconfirmed; retain ${fixtureRoot}`);
}
if (failure) {
  console.error(String(failure.stack ?? failure).replaceAll(fakeKey, '[redacted]'));
  process.exitCode = 1;
}
