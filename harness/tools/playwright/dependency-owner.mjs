import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createNativeOwnerRequire } from '../../../scripts/lib/native-owner.mjs';

// Source mode retains the extension-local owner. A packaged launch supplies an
// explicit resolver root inside its validated immutable Playwright payload.
const moduleResolutionRoot = process.env.PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT;
export const requirePlaywrightDependency = createNativeOwnerRequire(
  'playwright',
  moduleResolutionRoot === undefined ? {} : { moduleResolutionRoot },
);

function sameWindowsPath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && path.win32.isAbsolute(left) && path.win32.isAbsolute(right)
    && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

/**
 * Return the host-check paths and pinned Playwright registry selected by the
 * existing prepared-runtime owner. Source mode intentionally has no host check.
 */
export function getPackagedPlaywrightHostRuntime() {
  if (moduleResolutionRoot === undefined) return undefined;

  const moduleRoot = path.resolve(moduleResolutionRoot);
  const payloadRoot = path.dirname(moduleRoot);
  const manifestPath = path.join(payloadRoot, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (error) { throw new Error(`Invalid packaged Playwright runtime manifest: ${manifestPath}`, { cause: error }); }
  const shell = manifest?.pins?.chromiumHeadlessShell;
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== 'playwright-windows-headless-runtime'
    || manifest?.target?.platform !== 'win32' || manifest?.target?.arch !== 'x64'
    || manifest?.pins?.playwright !== '1.62.1' || manifest?.pins?.playwrightCore !== '1.62.1'
    || shell?.revision !== '1234' || shell?.browserVersion !== '151.0.7922.34') {
    throw new Error(`Packaged Playwright runtime manifest does not match the pinned host-check runtime: ${manifestPath}`);
  }

  const expectedBrowsersRoot = path.join(payloadRoot, 'browsers');
  if (!sameWindowsPath(process.env.PLAYWRIGHT_BROWSERS_PATH, expectedBrowsersRoot)) {
    throw new Error('Packaged Playwright browser root does not match the selected immutable payload.');
  }
  const expectedRevisionDirectory = path.join(expectedBrowsersRoot, `chromium_headless_shell-${shell.revision}`);
  const expectedExecutablePath = path.join(
    expectedRevisionDirectory,
    'chrome-headless-shell-win64',
    'chrome-headless-shell.exe',
  );

  const packageManifest = requirePlaywrightDependency('playwright-core/package.json');
  if (packageManifest?.version !== '1.62.1') {
    throw new Error('Packaged Playwright core version does not match the pinned host-check API.');
  }
  const coreBundle = requirePlaywrightDependency('playwright-core/lib/coreBundle');
  const registry = coreBundle?.registry?.registry;
  if (!registry || typeof registry !== 'object') {
    throw new Error('Packaged Playwright core registry API does not match the pinned host-check API.');
  }

  return {
    registry,
    revision: shell.revision,
    browserVersion: shell.browserVersion,
    expectedRevisionDirectory,
    expectedExecutablePath,
  };
}
