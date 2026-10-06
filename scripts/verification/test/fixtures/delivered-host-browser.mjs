import assert from 'node:assert/strict';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOwnerRequire } from '../../../lib/package-resolution.mjs';
import { snapshotProcessTree, watchChildProcess } from '../../../lib/process-watchdog.mjs';

// Invocation-only acceptance fixture: never connects to an existing browser or
// installs one. The parent supplies a separate OS-temp HOME/TEMP and private URL.
const [baseUrl, fixtureRoot, executablePath] = process.argv.slice(2);
const origin = new URL(baseUrl).origin;
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.ok(![1996, 1997].includes(Number(new URL(origin).port)));
assert.equal(path.resolve(process.env.TEMP), path.resolve(fixtureRoot));
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
  watchdog = watchChildProcess(server.process(), { timeoutMs: 60_000, label: 'delivered headless Chromium' });
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
    if (url.protocol === 'ws:' && url.host === new URL(origin).host) socket.connectToServer();
    else {
      externalRequests.push(socket.url());
      socket.close();
    }
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
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
  // BottomSection intentionally omits the composer AND Settings in this state.
  await expect(page.locator('.empty-state-title')).toHaveText('Start a session', { timeout: 25_000 });
  await expect(page.locator('.empty-state-title')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  // AppBody enables New session only when transport is connected AND backendReady.
  // Do not click: startup/handshake only, no prompt or model request.
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeEnabled({ timeout: 25_000 });
  await expect(page.locator('[data-connection-banner]')).toHaveCount(0);
  const compiledScripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src));
  assert.ok(compiledScripts.some(url => new URL(url).origin === origin && /\/assets\/panel-/u.test(new URL(url).pathname)), 'paint must come from this private host compiled panel');
  assert.deepEqual(externalRequests, [], 'renderer attempted external network');
  assert.deepEqual(errors, [], 'renderer console/page errors');
} catch (error) {
  failure = error;
  // Text-only, bounded evidence from the still-live DOM, outside the app profile.
  // Diagnostics must never replace the assertion failure or prevent teardown.
  try {
    diagnostics = {
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
    diagnostics = { ...diagnostics, collectionError: diagnosticError.message, errors: errors.slice(0, 30), externalRequests: externalRequests.slice(0, 30) };
  }
  console.error(`First-paint diagnostics: ${JSON.stringify(diagnostics)}`);
} finally {
  // Capture owned descendants while the browser is still live: a snapshot only
  // after close could miss a reparented Chromium child. PID reuse is treated as
  // uncertainty (retention), never authority to kill an unrelated process.
  const owned = server ? snapshotProcessTree(server.process().pid) : [];
  try {
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
  await writeFile(path.join(fixtureRoot, 'browser-evidence.json'), JSON.stringify({ errors, externalRequests, diagnostics, closeConfirmed, safe, owned, stillLive, tree }, null, 2));
  process.send?.({ type: 'browser-result', safe, assetVersion, error: failure?.stack });
  if (!safe) failure ??= new Error(`Chromium teardown unconfirmed; retain ${fixtureRoot}`);
}
if (failure) {
  console.error(failure.stack ?? failure);
  process.exitCode = 1;
}
