import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type RuntimeOwner = 'computer-use' | 'playwright';
const entries = {
  'computer-use': 'harness/tools/computer-use/sidecar.mjs',
  playwright: 'harness/tools/playwright/sidecar.mjs',
} as const;
const CURATED_FILES = [
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
] as const;
const PLAYWRIGHT_PAYLOAD_DIRECTORY = 'playwright-runtime';
const PLAYWRIGHT_MODULE_ROOT_ENV = 'PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT';
const PLAYWRIGHT_HOST_VALIDATION_SKIP_ENV = new Set([
  'PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS',
  'npm_config_playwright_skip_validate_host_requirements',
  'npm_package_config_playwright_skip_validate_host_requirements',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const WINDOWS_UNSAFE_PATH = /[<>:"|?*\u0000-\u001f]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

interface CodeOnlyRuntime { root: string; version: 1; codeOnly: true }
interface PreparedPlaywrightRuntime { root: string; version: 2; payloadRoot: string; identity: string }
type PackagedRuntime = CodeOnlyRuntime | PreparedPlaywrightRuntime;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function readJson(file: string, description: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(value)) throw new Error('expected an object');
    return value;
  } catch (error) {
    throw new Error(`Invalid ${description}: ${file}`, { cause: error });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertDirectory(file: string, description: string): void {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('not a regular directory');
  } catch (error) {
    throw new Error(`Packaged Playwright ${description} is missing or invalid: ${file}`, { cause: error });
  }
}

function assertFile(file: string, description: string): void {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('not a regular file');
  } catch (error) {
    throw new Error(`Packaged Playwright ${description} is missing or invalid: ${file}`, { cause: error });
  }
}

function validateInventory(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8192) {
    throw new Error('Playwright payload file inventory is invalid.');
  }
  let previous: string | undefined;
  for (const record of value) {
    if (!hasExactKeys(record, ['relativePath', 'sizeBytes', 'sha256'])) {
      throw new Error('Playwright payload file inventory entry is invalid.');
    }
    const relativePath = record.relativePath;
    if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')
      || relativePath.startsWith('/') || /^[A-Za-z]:/u.test(relativePath)
      || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
      || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..'
        || WINDOWS_UNSAFE_PATH.test(segment) || segment.endsWith('.') || segment.endsWith(' ')
        || WINDOWS_RESERVED_NAME.test(segment))) {
      throw new Error('Playwright payload file inventory contains an unsafe path.');
    }
    if (previous !== undefined && previous >= relativePath) {
      throw new Error('Playwright payload file inventory is not uniquely sorted.');
    }
    previous = relativePath;
    if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0
      || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)) {
      throw new Error(`Playwright payload inventory entry is invalid: ${relativePath}`);
    }
    if (![ 'node_modules/playwright/', 'node_modules/playwright-core/', 'node_modules/pngjs/',
      'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/', 'browsers/ffmpeg-1011/', 'browsers/winldd-1007/',
    ].some((prefix) => relativePath.startsWith(prefix))) {
      throw new Error(`Playwright payload inventory path is outside the prepared layout: ${relativePath}`);
    }
  }
  const required = [
    'node_modules/playwright/package.json',
    'node_modules/playwright-core/package.json',
    'node_modules/playwright-core/browsers.json',
    'node_modules/pngjs/package.json',
    'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe',
    'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/ABOUT',
    'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/LICENSE.headless_shell',
    'browsers/ffmpeg-1011/ffmpeg-win64.exe',
    'browsers/ffmpeg-1011/COPYING.LGPLv2.1',
    'browsers/winldd-1007/PrintDeps.exe',
  ];
  const present = new Set(value.map((record) => (record as Record<string, unknown>).relativePath));
  for (const relativePath of required) {
    if (!present.has(relativePath)) throw new Error(`Playwright payload inventory is missing required path: ${relativePath}`);
  }
}

function validateArchiveProvenance(value: unknown): void {
  const expected = [
    ['npm-package', 'playwright'], ['npm-package', 'playwright-core'], ['npm-package', 'pngjs'],
    ['browser-download', 'chromium-headless-shell'], ['browser-download', 'ffmpeg'], ['browser-download', 'winldd'],
  ];
  const keys = ['kind', 'name', 'version', 'pin', 'archiveFile', 'url', 'finalUrl', 'integrity', 'sizeBytes', 'sha256', 'verification', 'subject', 'attestation'];
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error('Playwright payload archive provenance is invalid.');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const raw = value[index];
    if (!hasExactKeys(raw, keys)) throw new Error('Playwright payload archive provenance entry is invalid.');
    const entry = raw as Record<string, unknown>;
    if (entry.kind !== expected[index][0] || entry.name !== expected[index][1]
      || (entry.version !== null && typeof entry.version !== 'string')
      || (entry.pin !== null && typeof entry.pin !== 'string')
      || typeof entry.archiveFile !== 'string' || typeof entry.url !== 'string'
      || (entry.finalUrl !== null && typeof entry.finalUrl !== 'string')
      || (entry.integrity !== null && typeof entry.integrity !== 'string')
      || !Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 1
      || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)
      || entry.verification !== 'local-content-hash-match'
      || entry.subject !== 'archive-bytes-only' || entry.attestation !== 'none') {
      throw new Error(`Playwright payload archive provenance is invalid: ${String(entry.name)}`);
    }
  }
}

function validatePackageManifest(file: string, name: string, version: string): Record<string, unknown> {
  assertFile(file, `${name} package manifest`);
  const manifest = readJson(file, `${name} package manifest`);
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`Packaged Playwright ${name} package pin mismatch: ${file}`);
  }
  return manifest;
}

function canonicalPlaywrightPayloadIdentity(manifest: Record<string, unknown>): string {
  const pins = manifest.pins as Record<string, unknown>;
  const shell = pins.chromiumHeadlessShell as Record<string, unknown>;
  const archiveProvenance = manifest.archiveProvenance as Record<string, unknown>[];
  const inventory = manifest.inventory as Record<string, unknown>[];
  const canonical = {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    target: {
      platform: (manifest.target as Record<string, unknown>).platform,
      arch: (manifest.target as Record<string, unknown>).arch,
    },
    pins: {
      playwright: pins.playwright,
      playwrightCore: pins.playwrightCore,
      pngjs: pins.pngjs,
      chromiumHeadlessShell: { revision: shell.revision, browserVersion: shell.browserVersion },
      ffmpeg: pins.ffmpeg,
      winldd: pins.winldd,
    },
    archiveProvenance: archiveProvenance.map((item) => ({
      kind: item.kind,
      name: item.name,
      version: item.version,
      pin: item.pin,
      archiveFile: item.archiveFile,
      url: item.url,
      finalUrl: item.finalUrl,
      integrity: item.integrity,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      verification: item.verification,
      subject: item.subject,
      attestation: item.attestation,
    })),
    inventory: inventory.map((item) => ({
      relativePath: item.relativePath,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validatePlaywrightPayload(payloadRoot: string, expectedIdentity: string): void {
  assertDirectory(payloadRoot, 'payload root');
  const manifestPath = path.join(payloadRoot, 'manifest.json');
  assertFile(manifestPath, 'payload manifest');
  const manifest = readJson(manifestPath, 'Playwright payload manifest');
  const pins = isRecord(manifest.pins) ? manifest.pins : undefined;
  const headlessShell = pins && isRecord(pins.chromiumHeadlessShell) ? pins.chromiumHeadlessShell : undefined;
  if (!hasExactKeys(manifest, ['schemaVersion', 'kind', 'target', 'pins', 'archiveProvenance', 'inventory', 'payloadIdentity'])
    || manifest.schemaVersion !== 1 || manifest.kind !== 'playwright-windows-headless-runtime'
    || !hasExactKeys(manifest.target, ['platform', 'arch'])
    || manifest.target.platform !== 'win32' || manifest.target.arch !== 'x64'
    || !pins || !hasExactKeys(pins, ['playwright', 'playwrightCore', 'pngjs', 'chromiumHeadlessShell', 'ffmpeg', 'winldd'])
    || !headlessShell || !hasExactKeys(headlessShell, ['revision', 'browserVersion'])
    || pins.playwright !== '1.62.1' || pins.playwrightCore !== '1.62.1' || pins.pngjs !== '7.0.0'
    || headlessShell.revision !== '1234' || headlessShell.browserVersion !== '151.0.7922.34'
    || pins.ffmpeg !== '1011' || pins.winldd !== '1007'
    || typeof manifest.payloadIdentity !== 'string' || !SHA256.test(manifest.payloadIdentity)
    || manifest.payloadIdentity !== expectedIdentity) {
    throw new Error(`Invalid packaged Playwright runtime manifest: ${manifestPath}`);
  }
  validateArchiveProvenance(manifest.archiveProvenance);
  validateInventory(manifest.inventory);
  if (canonicalPlaywrightPayloadIdentity(manifest) !== manifest.payloadIdentity
    || manifest.payloadIdentity !== expectedIdentity) {
    throw new Error(`Invalid packaged Playwright runtime manifest: ${manifestPath}`);
  }

  const nodeModules = path.join(payloadRoot, 'node_modules');
  const browsers = path.join(payloadRoot, 'browsers');
  assertDirectory(nodeModules, 'node_modules directory');
  assertDirectory(browsers, 'browser directory');
  assertDirectory(path.join(nodeModules, 'playwright'), 'playwright package');
  assertDirectory(path.join(nodeModules, 'playwright-core'), 'playwright-core package');
  assertDirectory(path.join(nodeModules, 'pngjs'), 'pngjs package');

  const playwrightManifest = validatePackageManifest(path.join(nodeModules, 'playwright', 'package.json'), 'playwright', '1.62.1');
  validatePackageManifest(path.join(nodeModules, 'playwright-core', 'package.json'), 'playwright-core', '1.62.1');
  validatePackageManifest(path.join(nodeModules, 'pngjs', 'package.json'), 'pngjs', '7.0.0');
  const dependencies = isRecord(playwrightManifest.dependencies) ? playwrightManifest.dependencies : {};
  if (dependencies['playwright-core'] !== '1.62.1') {
    throw new Error('Packaged Playwright does not declare its pinned playwright-core dependency.');
  }

  const resolver = createRequire(path.join(payloadRoot, 'package.json'));
  for (const packageName of ['playwright', 'playwright-core', 'pngjs']) {
    let resolved: string;
    try { resolved = resolver.resolve(packageName); }
    catch (error) { throw new Error(`Packaged Playwright dependency is unavailable: ${packageName}`, { cause: error }); }
    if (!isWithin(nodeModules, resolved)) {
      throw new Error(`Packaged Playwright dependency resolves outside its prepared owner: ${packageName}`);
    }
  }

  const browsersManifest = path.join(nodeModules, 'playwright-core', 'browsers.json');
  assertFile(browsersManifest, 'browser metadata');
  const browserMetadata = readJson(browsersManifest, 'browser metadata');
  const shellRecords = Array.isArray(browserMetadata.browsers)
    ? browserMetadata.browsers.filter((item) => isRecord(item) && item.name === 'chromium-headless-shell')
    : [];
  const shell = shellRecords[0];
  const browserRevision = shell?.revision === undefined ? undefined : String(shell.revision);
  if (shellRecords.length !== 1 || browserRevision !== '1234' || shell?.browserVersion !== '151.0.7922.34') {
    throw new Error(`Packaged Playwright browser metadata does not match the prepared headless shell: ${browsersManifest}`);
  }

  assertDirectory(path.join(browsers, 'chromium_headless_shell-1234'), 'headless-shell revision directory');
  assertDirectory(path.join(browsers, 'chromium_headless_shell-1234', 'chrome-headless-shell-win64'), 'headless-shell executable directory');
  const shellRoot = path.join(browsers, 'chromium_headless_shell-1234', 'chrome-headless-shell-win64');
  assertFile(path.join(shellRoot, 'chrome-headless-shell.exe'), 'headless-shell executable');
  assertFile(path.join(shellRoot, 'ABOUT'), 'headless-shell metadata');
  assertFile(path.join(shellRoot, 'LICENSE.headless_shell'), 'headless-shell license');
  assertDirectory(path.join(browsers, 'ffmpeg-1011'), 'ffmpeg revision directory');
  assertFile(path.join(browsers, 'ffmpeg-1011', 'ffmpeg-win64.exe'), 'ffmpeg executable');
  assertFile(path.join(browsers, 'ffmpeg-1011', 'COPYING.LGPLv2.1'), 'ffmpeg license');
  assertDirectory(path.join(browsers, 'winldd-1007'), 'winldd revision directory');
  assertFile(path.join(browsers, 'winldd-1007', 'PrintDeps.exe'), 'winldd executable');
}

function packagedRuntime(moduleUrl: string): PackagedRuntime | undefined {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const root = path.join(directory, 'resources', 'tool-runtimes');
  const marker = path.join(root, 'manifest.json');
  if (existsSync(marker)) {
    assertDirectory(path.dirname(root), 'resources directory');
    assertDirectory(root, 'tool runtime directory');
    assertFile(marker, 'tool runtime manifest');
    const manifest = readJson(marker, 'packaged tool runtime manifest');
    if (manifest.version === 1) {
      const v1Entries = isRecord(manifest.entries) ? manifest.entries : undefined;
      if (manifest.codeOnly !== true || !v1Entries
        || v1Entries['computer-use'] !== entries['computer-use']
        || v1Entries.playwright !== entries.playwright || !Array.isArray(manifest.files)) {
        throw new Error(`Invalid packaged tool runtime manifest: ${marker}`);
      }
      return { root, version: 1, codeOnly: true };
    }
    if (manifest.version !== 2 || !hasExactKeys(manifest, ['version', 'entries', 'files', 'availability'])) {
      throw new Error(`Invalid packaged tool runtime manifest: ${marker}`);
    }
    const v2Entries = isRecord(manifest.entries) ? manifest.entries : undefined;
    const v2Files = manifest.files;
    const availability = isRecord(manifest.availability) ? manifest.availability : undefined;
    const playwrightAvailability = availability && isRecord(availability.playwright) ? availability.playwright : undefined;
    if (!v2Entries || !hasExactKeys(v2Entries, ['computer-use', 'playwright'])) {
      throw new Error(`Invalid packaged tool runtime manifest: ${marker}`);
    }
    const selectedEntries = v2Entries as Record<string, unknown>;
    if (selectedEntries['computer-use'] !== entries['computer-use'] || selectedEntries.playwright !== entries.playwright
      || !Array.isArray(v2Files) || v2Files.length !== CURATED_FILES.length
      || !CURATED_FILES.every((file, index) => v2Files[index] === file)
      || !availability || !hasExactKeys(availability, ['computer-use', 'playwright'])) {
      throw new Error(`Invalid packaged tool runtime manifest: ${marker}`);
    }
    const selectedAvailability = availability as Record<string, unknown>;
    if (selectedAvailability['computer-use'] !== 'unavailable' || !playwrightAvailability
      || !hasExactKeys(playwrightAvailability, ['state', 'payloadDirectory', 'identity'])) {
      throw new Error(`Invalid packaged tool runtime manifest: ${marker}`);
    }
    const selectedPlaywrightAvailability = playwrightAvailability as Record<string, unknown>;
    if (selectedPlaywrightAvailability.state !== 'prepared'
      || selectedPlaywrightAvailability.payloadDirectory !== PLAYWRIGHT_PAYLOAD_DIRECTORY
      || typeof selectedPlaywrightAvailability.identity !== 'string'
      || !SHA256.test(selectedPlaywrightAvailability.identity)) {
      throw new Error(`Invalid packaged tool runtime manifest: ${marker}`);
    }
    const payloadRoot = path.join(root, PLAYWRIGHT_PAYLOAD_DIRECTORY);
    validatePlaywrightPayload(payloadRoot, selectedPlaywrightAvailability.identity);
    return { root, version: 2, payloadRoot, identity: selectedPlaywrightAvailability.identity };
  }
  if (existsSync(root) || existsSync(path.join(directory, 'resources', 'bundled-extensions.json'))) {
    throw new Error(`Packaged tool runtime manifest is missing: ${marker}`);
  }
  return undefined;
}

function packagedEntry(owner: RuntimeOwner, packaged: PackagedRuntime): string {
  if (packaged.version === 2 && owner !== 'playwright') {
    throw new Error('computer-use runtime unavailable: this packaged tool runtime has no prepared computer-use dependency owner. No sidecar was started.');
  }
  const entry = path.join(packaged.root, entries[owner]);
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`Packaged ${owner} sidecar asset is missing: ${entry}`);
  }
  return entry;
}

/** Select packaged code explicitly; never substitute checkout or working-directory assets. */
export function resolveToolRuntimeEntry(owner: RuntimeOwner, moduleUrl: string): string {
  const packaged = packagedRuntime(moduleUrl);
  if (packaged) return packagedEntry(owner, packaged);
  return fileURLToPath(new URL('./sidecar.mjs', moduleUrl));
}

/** Resolve a sidecar and the environment that selects its immutable dependency owner. */
export function prepareToolRuntimeLaunch(owner: RuntimeOwner, moduleUrl: string): { entry: string; env: NodeJS.ProcessEnv } {
  const packaged = packagedRuntime(moduleUrl);
  const env = { ...process.env };
  if (!packaged) {
    // This private selector belongs only to packaged sidecars; an ambient value
    // must not change the established source-mode owner.
    delete env[PLAYWRIGHT_MODULE_ROOT_ENV];
    return { entry: fileURLToPath(new URL('./sidecar.mjs', moduleUrl)), env };
  }
  const entry = packagedEntry(owner, packaged);
  if (packaged.version === 1) {
    throw new Error(`${owner} runtime preparation unavailable: this code-only packaged tool runtime has no prepared native dependency owner. No sidecar was started.`);
  }
  delete env.NODE_PATH;
  env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(packaged.payloadRoot, 'browsers');
  env[PLAYWRIGHT_MODULE_ROOT_ENV] = path.resolve(packaged.payloadRoot, 'node_modules');
  for (const name of Object.keys(env)) {
    if (PLAYWRIGHT_HOST_VALIDATION_SKIP_ENV.has(name.toLowerCase())) delete env[name];
  }
  return { entry, env };
}

/** Compatibility path API for source callers and code-only package diagnostics. */
export function prepareToolRuntimeEntry(owner: RuntimeOwner, moduleUrl: string): string {
  return prepareToolRuntimeLaunch(owner, moduleUrl).entry;
}
