import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { prepareToolRuntimeEntry, prepareToolRuntimeLaunch, resolveToolRuntimeEntry } from '../runtime-path.js';

const entries = {
  'computer-use': 'harness/tools/computer-use/sidecar.mjs',
  playwright: 'harness/tools/playwright/sidecar.mjs',
};
const curatedFiles = [
  'harness/tools/computer-use/sidecar.mjs',
  'harness/tools/computer-use/backend.mjs',
  'harness/tools/computer-use/sidecar-core.mjs',
  'harness/tools/computer-use/dependency-owner.mjs',
  'harness/tools/computer-use/image.mjs',
  'harness/tools/computer-use/keys.mjs',
  'harness/tools/computer-use/launch-resolve.mjs',
  'harness/tools/computer-use/sequence.mjs',
  'harness/tools/computer-use/win32-focus.mjs',
  'harness/tools/playwright/sidecar.mjs',
  'harness/tools/playwright/backend.mjs',
  'harness/tools/playwright/sidecar-core.mjs',
  'harness/tools/playwright/dependency-owner.mjs',
  'harness/tools/playwright/image.mjs',
  'harness/tools/playwright/snapshots.mjs',
  'harness/tools/png-image.mjs',
  'scripts/lib/native-owner.mjs',
];
const pins = {
  playwright: '1.62.1', playwrightCore: '1.62.1', pngjs: '7.0.0',
  chromiumHeadlessShell: { revision: '1234', browserVersion: '151.0.7922.34' },
  ffmpeg: '1011', winldd: '1007',
};

function payloadIdentityFor(manifest: Record<string, any>): string {
  const canonical = {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    target: { platform: manifest.target.platform, arch: manifest.target.arch },
    pins: {
      playwright: manifest.pins.playwright,
      playwrightCore: manifest.pins.playwrightCore,
      pngjs: manifest.pins.pngjs,
      chromiumHeadlessShell: {
        revision: manifest.pins.chromiumHeadlessShell.revision,
        browserVersion: manifest.pins.chromiumHeadlessShell.browserVersion,
      },
      ffmpeg: manifest.pins.ffmpeg,
      winldd: manifest.pins.winldd,
    },
    archiveProvenance: manifest.archiveProvenance.map((item: Record<string, unknown>) => ({
      kind: item.kind, name: item.name, version: item.version, pin: item.pin, archiveFile: item.archiveFile,
      url: item.url, finalUrl: item.finalUrl, integrity: item.integrity, sizeBytes: item.sizeBytes, sha256: item.sha256,
      verification: item.verification, subject: item.subject, attestation: item.attestation,
    })),
    inventory: manifest.inventory.map((item: Record<string, unknown>) => ({
      relativePath: item.relativePath, sizeBytes: item.sizeBytes, sha256: item.sha256,
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function makeV2Fixture(t: { after(callback: () => void): void }): {
  module: string; root: string; payload: string; manifestPath: string; payloadManifestPath: string;
} {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'pie-runtime-v2-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const out = path.join(temporary, 'out');
  const root = path.join(out, 'resources', 'tool-runtimes');
  const payload = path.join(root, 'playwright-runtime');
  const manifestPath = path.join(root, 'manifest.json');
  const payloadManifestPath = path.join(payload, 'manifest.json');
  for (const owner of ['playwright', 'computer-use'] as const) {
    const entry = path.join(root, entries[owner]);
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, `// packaged ${owner} sidecar`);
  }

  const nodeModules = path.join(payload, 'node_modules');
  const packageData = [
    ['playwright', '1.62.1', { 'playwright-core': '1.62.1' }],
    ['playwright-core', '1.62.1', {}],
    ['pngjs', '7.0.0', {}],
  ] as const;
  for (const [name, version, dependencies] of packageData) {
    const directory = path.join(nodeModules, name);
    mkdirSync(directory, { recursive: true });
    writeJson(path.join(directory, 'package.json'), { name, version, dependencies });
    writeFileSync(path.join(directory, 'index.js'), 'module.exports = {};');
  }
  writeJson(path.join(nodeModules, 'playwright-core', 'browsers.json'), { browsers: [
    { name: 'chromium-headless-shell', revision: '1234', browserVersion: '151.0.7922.34' },
  ] });
  const browserRoot = path.join(payload, 'browsers');
  const shellDirectory = path.join(browserRoot, 'chromium_headless_shell-1234', 'chrome-headless-shell-win64');
  mkdirSync(shellDirectory, { recursive: true });
  writeFileSync(path.join(shellDirectory, 'chrome-headless-shell.exe'), 'fixture shell');
  writeFileSync(path.join(shellDirectory, 'ABOUT'), 'fixture about');
  writeFileSync(path.join(shellDirectory, 'LICENSE.headless_shell'), 'fixture license');
  for (const [directoryName, executable] of [['ffmpeg-1011', 'ffmpeg-win64.exe'], ['winldd-1007', 'PrintDeps.exe']]) {
    const directory = path.join(browserRoot, directoryName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, executable), 'fixture helper');
    if (directoryName === 'ffmpeg-1011') writeFileSync(path.join(directory, 'COPYING.LGPLv2.1'), 'fixture notice');
  }
  const files = [
    'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe',
    'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/ABOUT',
    'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/LICENSE.headless_shell',
    'browsers/ffmpeg-1011/ffmpeg-win64.exe',
    'browsers/ffmpeg-1011/COPYING.LGPLv2.1',
    'browsers/winldd-1007/PrintDeps.exe',
    'node_modules/playwright-core/browsers.json',
    'node_modules/playwright-core/package.json',
    'node_modules/playwright/package.json',
    'node_modules/pngjs/package.json',
  ].sort().map((relativePath) => ({ relativePath, sizeBytes: 1, sha256: 'b'.repeat(64) }));
  const archiveProvenance = [
    ['npm-package', 'playwright'], ['npm-package', 'playwright-core'], ['npm-package', 'pngjs'],
    ['browser-download', 'chromium-headless-shell'], ['browser-download', 'ffmpeg'], ['browser-download', 'winldd'],
  ].map(([kind, name], index) => ({
    kind, name,
    version: index < 3 ? (index === 2 ? '7.0.0' : '1.62.1') : index === 3 ? '151.0.7922.34' : null,
    pin: index < 3 ? null : ['1234', '1011', '1007'][index - 3],
    archiveFile: `${name}.archive`, url: `https://example.test/${name}.archive`,
    finalUrl: index < 3 ? null : `https://example.test/${name}.archive`,
    integrity: index < 3 ? 'sha512-AA==' : null,
    sizeBytes: 1, sha256: 'c'.repeat(64),
    verification: 'local-content-hash-match', subject: 'archive-bytes-only', attestation: 'none',
  }));
  const payloadManifest = {
    schemaVersion: 1, kind: 'playwright-windows-headless-runtime',
    target: { platform: 'win32', arch: 'x64' }, pins, archiveProvenance, inventory: files, payloadIdentity: '',
  };
  payloadManifest.payloadIdentity = payloadIdentityFor(payloadManifest);
  writeJson(payloadManifestPath, payloadManifest);
  writeJson(manifestPath, {
    version: 2, entries, files: curatedFiles,
    availability: {
      'computer-use': 'unavailable',
      playwright: { state: 'prepared', payloadDirectory: 'playwright-runtime', identity: payloadManifest.payloadIdentity },
    },
  });
  return { module: pathToFileURL(path.join(out, 'worker.mjs')).href, root, payload, manifestPath, payloadManifestPath };
}

for (const owner of ['computer-use', 'playwright'] as const) {
  test(`${owner}: source keeps colocated sidecar without cwd authority`, () => {
    const module = pathToFileURL(path.join(os.tmpdir(), 'source', owner, 'runtime-client.ts')).href;
    const expected = path.join(os.tmpdir(), 'source', owner, 'sidecar.mjs');
    assert.equal(resolveToolRuntimeEntry(owner, module), expected);
    assert.equal(prepareToolRuntimeEntry(owner, module), expected);
  });

  test(`${owner}: unrelated ancestor markers are ignored`, (t) => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'pie-runtime-ancestor-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'resources', 'tool-runtimes');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), 'malformed unrelated marker');
    const module = pathToFileURL(path.join(temporary, 'source', owner, 'runtime-client.ts')).href;
    const expected = path.join(temporary, 'source', owner, 'sidecar.mjs');
    assert.equal(resolveToolRuntimeEntry(owner, module), expected);
    assert.equal(prepareToolRuntimeEntry(owner, module), expected);
  });

  test(`${owner}: exact v1 code-only manifest is accepted but blocks preparation`, (t) => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'pie-runtime-v1-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const out = path.join(temporary, 'out');
    const root = path.join(out, 'resources', 'tool-runtimes');
    mkdirSync(root, { recursive: true });
    const marker = path.join(root, 'manifest.json');
    writeFileSync(marker, JSON.stringify({ version: 1, codeOnly: true, entries, files: Object.values(entries) }));
    const module = pathToFileURL(path.join(out, 'worker.mjs')).href;
    const expected = path.join(root, entries[owner]);
    assert.throws(() => resolveToolRuntimeEntry(owner, module), /sidecar asset is missing/);
    mkdirSync(path.dirname(expected), { recursive: true });
    writeFileSync(expected, '// code only');
    assert.equal(resolveToolRuntimeEntry(owner, module), expected);
    assert.throws(() => prepareToolRuntimeEntry(owner, module), /preparation unavailable.*no prepared native dependency owner/);
    rmSync(marker);
    assert.throws(() => resolveToolRuntimeEntry(owner, module), /manifest is missing/);
    rmSync(root, { recursive: true });
    writeFileSync(path.join(out, 'resources', 'bundled-extensions.json'), '{}');
    assert.throws(() => resolveToolRuntimeEntry(owner, module), /manifest is missing/);
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, JSON.stringify({ version: 1, codeOnly: true, entries: { ...entries, [owner]: '../sidecar.mjs' }, files: [] }));
    assert.throws(() => resolveToolRuntimeEntry(owner, module), /Invalid packaged tool runtime manifest/);
  });
}

test('packaged v2 prepares only Playwright with its explicit package and browser roots', (t) => {
  const fixture = makeV2Fixture(t);
  const priorBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const priorNodePath = process.env.NODE_PATH;
  const priorOwner = process.env.PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT;
  process.env.PLAYWRIGHT_BROWSERS_PATH = 'C:/ambient/playwright-browsers';
  process.env.NODE_PATH = 'C:/ambient/node_modules';
  process.env.PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT = 'C:/ambient/modules';
  try {
    const launch = prepareToolRuntimeLaunch('playwright', fixture.module);
    assert.equal(launch.entry, path.join(fixture.root, entries.playwright));
    assert.equal(launch.env.PLAYWRIGHT_BROWSERS_PATH, path.join(fixture.payload, 'browsers'));
    assert.equal(launch.env.PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT, path.join(fixture.payload, 'node_modules'));
    assert.equal(launch.env.NODE_PATH, undefined);
    assert.equal(prepareToolRuntimeEntry('playwright', fixture.module), launch.entry);
    assert.throws(() => resolveToolRuntimeEntry('computer-use', fixture.module), /computer-use runtime unavailable/);
    assert.throws(() => prepareToolRuntimeLaunch('computer-use', fixture.module), /computer-use runtime unavailable/);
  } finally {
    if (priorBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = priorBrowsers;
    if (priorNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = priorNodePath;
    if (priorOwner === undefined) delete process.env.PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT; else process.env.PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT = priorOwner;
  }
});

test('only packaged Playwright launches clear ambient host-validation skip variables', (t) => {
  const fixture = makeV2Fixture(t);
  const skipNames = new Set([
    'PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS',
    'npm_config_playwright_skip_validate_host_requirements',
    'npm_package_config_playwright_skip_validate_host_requirements',
  ]);
  const injectedNames = [
    'pLaYwRiGhT_sKiP_VALIDATE_HOST_REQUIREMENTS',
    'NPM_CONFIG_Playwright_SKIP_VALIDATE_HOST_REQUIREMENTS',
    'NPM_PACKAGE_CONFIG_PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS',
  ];
  const previous = Object.keys(process.env)
    .filter((name) => skipNames.has(name.toLowerCase()))
    .map((name) => [name, process.env[name]] as const);
  const valueForName = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  try {
    for (const name of injectedNames) process.env[name] = '1';

    const packaged = prepareToolRuntimeLaunch('playwright', fixture.module);
    assert.equal(Object.keys(packaged.env).some((name) => skipNames.has(name.toLowerCase())), false);

    const sourceModule = pathToFileURL(path.join(os.tmpdir(), 'source', 'playwright', 'runtime-client.ts')).href;
    const source = prepareToolRuntimeLaunch('playwright', sourceModule);
    for (const name of injectedNames) assert.equal(valueForName(source.env, name), '1');
  } finally {
    for (const name of Object.keys(process.env)) {
      if (skipNames.has(name.toLowerCase())) delete process.env[name];
    }
    for (const [name, value] of previous) {
      if (value !== undefined) process.env[name] = value;
    }
  }
});

test('packaged v2 rejects malformed schema, target, identity, and arbitrary payload paths', (t) => {
  const fixture = makeV2Fixture(t);
  const top = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
  const payload = JSON.parse(readFileSync(fixture.payloadManifestPath, 'utf8'));
  for (const value of [
    { ...top, extra: true },
    { ...top, files: [...top.files, '../outside'] },
    { ...top, availability: { ...top.availability, playwright: { ...top.availability.playwright, payloadDirectory: '../outside' } } },
    { ...top, availability: { ...top.availability, playwright: { ...top.availability.playwright, identity: 'bad' } } },
  ]) {
    writeJson(fixture.manifestPath, value);
    assert.throws(() => prepareToolRuntimeLaunch('playwright', fixture.module), /Invalid packaged tool runtime manifest/);
  }
  writeJson(fixture.manifestPath, top);
  writeJson(fixture.payloadManifestPath, { ...payload, target: { platform: 'linux', arch: 'x64' } });
  assert.throws(() => prepareToolRuntimeLaunch('playwright', fixture.module), /Invalid packaged Playwright runtime manifest/);
  const forgedIdentity = 'c'.repeat(64);
  writeJson(fixture.payloadManifestPath, { ...payload, payloadIdentity: forgedIdentity });
  writeJson(fixture.manifestPath, {
    ...top,
    availability: { ...top.availability, playwright: { ...top.availability.playwright, identity: forgedIdentity } },
  });
  assert.throws(() => prepareToolRuntimeLaunch('playwright', fixture.module), /Invalid packaged Playwright runtime manifest/);
  writeJson(fixture.manifestPath, top);
  writeJson(fixture.payloadManifestPath, payload);
  writeJson(fixture.payloadManifestPath, {
    ...payload, inventory: [{ ...payload.inventory[0], relativePath: '../outside' }, ...payload.inventory.slice(1)],
  });
  assert.throws(() => prepareToolRuntimeLaunch('playwright', fixture.module), /unsafe path/);
});

test('packaged v2 fails closed when a package or pinned browser executable is missing', (t) => {
  const fixture = makeV2Fixture(t);
  const pngjs = path.join(fixture.payload, 'node_modules', 'pngjs', 'package.json');
  rmSync(pngjs);
  assert.throws(() => prepareToolRuntimeLaunch('playwright', fixture.module), /pngjs package manifest is missing/);
  writeJson(pngjs, { name: 'pngjs', version: '7.0.0', dependencies: {} });
  rmSync(path.join(fixture.payload, 'browsers', 'chromium_headless_shell-1234', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
  assert.throws(() => prepareToolRuntimeLaunch('playwright', fixture.module), /headless-shell executable is missing/);
});
