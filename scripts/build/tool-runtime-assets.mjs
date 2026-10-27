import fs from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createOwnerRequire } from '../lib/package-resolution.mjs';
import { validatePlaywrightHeadlessPayload } from './playwright-payload.mjs';

export const TOOL_RUNTIME_DIRECTORY = 'resources/tool-runtimes';
export const TOOL_RUNTIME_MANIFEST = `${TOOL_RUNTIME_DIRECTORY}/manifest.json`;
export const PLAYWRIGHT_HEADLESS_OUTPUT_DIRECTORY = `${TOOL_RUNTIME_DIRECTORY}/playwright-headless-shell`;
export const PLAYWRIGHT_RUNTIME_OUTPUT_DIRECTORY = `${TOOL_RUNTIME_DIRECTORY}/playwright-runtime`;
const PLAYWRIGHT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PLAYWRIGHT_TARGET = Object.freeze({ platform: 'win32', arch: 'x64' });
export const TOOL_RUNTIME_FILES = Object.freeze([
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
]);

function parsePreparedPlaywrightOption(argv, flag, { requireDelivery = false } = {}) {
  const options = argv.filter(arg => arg === flag || arg.startsWith(`${flag}=`));
  if (options.length > 1) throw new Error(`${flag} may only be supplied once.`);
  if (options.length === 0) return undefined;
  if (requireDelivery && !argv.includes('--delivery')) {
    throw new Error(`${flag} requires explicit --delivery; it is unsupported for development builds.`);
  }
  if (['--watch', '--publish', '--activate'].some(option => argv.includes(option))) {
    throw new Error(`${flag} supports only one-shot, non-publishing delivery builds.`);
  }
  const option = options[0];
  const index = argv.indexOf(option);
  const value = option === flag ? argv[index + 1] : option.slice(flag.length + 1);
  if (!value || value.startsWith('--') || !path.isAbsolute(value)) {
    throw new Error(`${flag} requires an explicit absolute prepared directory.`);
  }
  return path.resolve(value);
}

export function parsePlaywrightPayloadOption(argv, options) {
  return parsePreparedPlaywrightOption(argv, '--playwright-payload', options);
}

export function parsePlaywrightRuntimeOption(argv, options) {
  return parsePreparedPlaywrightOption(argv, '--playwright-runtime', options);
}

/** Validate one explicit composite runtime without acquisition or fallback. */
export async function validatePlaywrightRuntimePayload({ directory, repositoryRoot }) {
  const { validatePlaywrightRuntimePayload: validate } = await import('./playwright-runtime-payload.mjs');
  return validate({ directory, repositoryRoot });
}

export async function verifyPlaywrightRuntimePayloadOutput(buildDirectory, { repositoryRoot, expectedIdentity } = {}) {
  const directory = path.join(buildDirectory, PLAYWRIGHT_RUNTIME_OUTPUT_DIRECTORY);
  const verified = await validatePlaywrightRuntimePayload({ directory, repositoryRoot });
  if (expectedIdentity !== undefined && verified.identity !== expectedIdentity) {
    throw new Error(`Copied Playwright runtime identity mismatch (${verified.identity} != ${expectedIdentity}).`);
  }
  return verified;
}

function readPackageManifest(file, expectedName) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.name !== expectedName) throw new Error(`Expected ${expectedName} package manifest at ${file}.`);
  return manifest;
}

/** Resolve trusted Playwright/browser pins only from the installed package owner graph. */
export async function resolvePlaywrightHeadlessPayloadExpected(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) {
    throw new TypeError('repositoryRoot must be an absolute path.');
  }
  const extensionRoot = path.join(repositoryRoot, 'extensions', 'playwright');
  const extensionManifest = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  const playwrightVersion = extensionManifest.dependencies?.playwright;
  if (typeof playwrightVersion !== 'string' || !PLAYWRIGHT_VERSION_PATTERN.test(playwrightVersion)) {
    throw new Error('extensions/playwright/package.json must pin an exact Playwright version.');
  }

  const extensionRequire = createOwnerRequire({ dependencyOwnerRoot: extensionRoot });
  let playwrightManifestPath;
  try { playwrightManifestPath = extensionRequire.resolve('playwright/package.json'); }
  catch (error) { throw new Error('The Playwright package pinned by extensions/playwright is unavailable.', { cause: error }); }
  const playwrightRoot = path.dirname(playwrightManifestPath);
  const playwrightManifest = readPackageManifest(playwrightManifestPath, 'playwright');
  if (playwrightManifest.version !== playwrightVersion) {
    throw new Error(`Installed Playwright version ${playwrightManifest.version ?? '(missing)'} does not match checked-in pin ${playwrightVersion}.`);
  }

  const playwrightRequire = createOwnerRequire({ dependencyOwnerRoot: playwrightRoot });
  let coreManifestPath;
  try { coreManifestPath = playwrightRequire.resolve('playwright-core/package.json'); }
  catch (error) { throw new Error('The selected Playwright package cannot resolve its own playwright-core dependency.', { cause: error }); }
  const coreRoot = path.dirname(coreManifestPath);
  const coreManifest = readPackageManifest(coreManifestPath, 'playwright-core');
  if (coreManifest.version !== playwrightVersion) {
    throw new Error(`Installed playwright-core version ${coreManifest.version ?? '(missing)'} does not match checked-in pin ${playwrightVersion}.`);
  }

  let browsers;
  try { browsers = JSON.parse(await readFile(path.join(coreRoot, 'browsers.json'), 'utf8')); }
  catch (error) { throw new Error('The selected playwright-core browsers.json is unavailable or invalid.', { cause: error }); }
  const headless = Array.isArray(browsers.browsers)
    ? browsers.browsers.filter(browser => browser?.name === 'chromium-headless-shell')
    : [];
  const revision = headless[0]?.revision;
  const browserRevision = typeof revision === 'string' && /^\d+$/u.test(revision)
    ? revision
    : Number.isSafeInteger(revision) && revision >= 0 ? String(revision) : undefined;
  if (headless.length !== 1 || typeof headless[0].browserVersion !== 'string'
    || !/^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(headless[0].browserVersion)
    || browserRevision === undefined) {
    throw new Error('The selected playwright-core browsers.json has no unique valid chromium-headless-shell pin.');
  }
  return {
    target: { platform: PLAYWRIGHT_TARGET.platform, arch: PLAYWRIGHT_TARGET.arch },
    playwrightVersion,
    browserVersion: headless[0].browserVersion,
    browserRevision,
  };
}

export async function verifyPlaywrightHeadlessPayloadOutput(buildDirectory, { expected, expectedIdentity } = {}) {
  const directory = path.join(buildDirectory, PLAYWRIGHT_HEADLESS_OUTPUT_DIRECTORY);
  const verified = await validatePlaywrightHeadlessPayload({ directory, expected });
  if (expectedIdentity !== undefined && verified.identity !== expectedIdentity) {
    throw new Error(`Copied Playwright payload identity mismatch (${verified.identity} != ${expectedIdentity}).`);
  }
  return verified;
}

async function copyPreparedTree(source, destination, label = 'Playwright payload') {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`Refusing to copy ${label} symlink: ${from}`);
    if (info.isDirectory()) {
      await mkdir(to);
      await copyPreparedTree(from, to, label);
    } else if (info.isFile()) {
      await copyFile(from, to);
    } else {
      throw new Error(`Refusing to copy non-regular ${label} entry: ${from}`);
    }
  }
}

/** Copy an explicit prepared root after Vite's curated code emission, then reverify every byte. */
export async function copyPreparedPlaywrightHeadlessPayload({ directory, buildDirectory, expected }) {
  const source = await validatePlaywrightHeadlessPayload({ directory, expected });
  const owner = path.join(buildDirectory, TOOL_RUNTIME_DIRECTORY);
  const ownerInfo = await lstat(owner);
  if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink()) {
    throw new Error('Playwright payload output owner must be an emitted regular resources/tool-runtimes directory.');
  }
  const destination = path.join(buildDirectory, PLAYWRIGHT_HEADLESS_OUTPUT_DIRECTORY);
  let destinationInfo;
  try { destinationInfo = await lstat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (destinationInfo) throw new Error(`Refusing to overwrite Playwright payload output: ${destination}`);
  await mkdir(destination);
  await copyPreparedTree(source.directory, destination);
  const sourceAfterCopy = await validatePlaywrightHeadlessPayload({ directory, expected });
  if (sourceAfterCopy.identity !== source.identity) throw new Error('Prepared Playwright payload changed while being copied.');
  return verifyPlaywrightHeadlessPayloadOutput(buildDirectory, { expected, expectedIdentity: source.identity });
}

/** Copy an explicit prepared composite runtime, preserving the helper's exact inventory. */
export async function copyPreparedPlaywrightRuntimePayload({ directory, buildDirectory, repositoryRoot, expectedIdentity }) {
  const source = await validatePlaywrightRuntimePayload({ directory, repositoryRoot });
  if (expectedIdentity !== undefined && source.identity !== expectedIdentity) {
    throw new Error(`Prepared Playwright runtime identity changed (${source.identity} != ${expectedIdentity}).`);
  }
  const owner = path.join(buildDirectory, TOOL_RUNTIME_DIRECTORY);
  const ownerInfo = await lstat(owner);
  if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink()) {
    throw new Error('Playwright runtime output owner must be an emitted regular resources/tool-runtimes directory.');
  }
  const destination = path.join(buildDirectory, PLAYWRIGHT_RUNTIME_OUTPUT_DIRECTORY);
  let destinationInfo;
  try { destinationInfo = await lstat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (destinationInfo) throw new Error(`Refusing to overwrite Playwright runtime output: ${destination}`);
  await mkdir(destination);
  await copyPreparedTree(source.directory, destination, 'prepared Playwright runtime');
  const sourceAfterCopy = await validatePlaywrightRuntimePayload({ directory, repositoryRoot });
  if (sourceAfterCopy.identity !== source.identity) throw new Error('Prepared Playwright runtime changed while being copied.');
  return verifyPlaywrightRuntimePayloadOutput(buildDirectory, { repositoryRoot, expectedIdentity: source.identity });
}

export function toolRuntimeManifest({ playwrightRuntimeIdentity } = {}) {
  const entries = {
    'computer-use': 'harness/tools/computer-use/sidecar.mjs',
    playwright: 'harness/tools/playwright/sidecar.mjs',
  };
  if (playwrightRuntimeIdentity === undefined) {
    return { version: 1, codeOnly: true, entries, files: [...TOOL_RUNTIME_FILES] };
  }
  if (typeof playwrightRuntimeIdentity !== 'string' || !SHA256_PATTERN.test(playwrightRuntimeIdentity)) {
    throw new Error('Prepared Playwright runtime identity must be lowercase SHA-256.');
  }
  return {
    version: 2,
    entries,
    files: [...TOOL_RUNTIME_FILES],
    availability: {
      'computer-use': 'unavailable',
      playwright: {
        state: 'prepared',
        payloadDirectory: 'playwright-runtime',
        identity: playwrightRuntimeIdentity,
      },
    },
  };
}

/** Parse static and literal dynamic imports without evaluating sidecar/native code. */
export function readToolRuntimeAssets(root) {
  const require = createRequire(new URL('../../application/hosts/vscode/package.json', import.meta.url));
  const ts = require('typescript');
  const assets = TOOL_RUNTIME_FILES.map(file => ({ file, source: fs.readFileSync(path.join(root, file)) }));
  const files = new Set(TOOL_RUNTIME_FILES);
  const edges = new Map();
  for (const { file, source } of assets) {
    const imports = [];
    const parsed = ts.createSourceFile(file, source.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (parsed.parseDiagnostics.length) throw new Error(`Invalid tool runtime JavaScript: ${file}`);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text));
        if (!files.has(target)) throw new Error(`Tool runtime import outside curated closure: ${file} -> ${specifier.text}`);
        imports.push(target);
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    edges.set(file, imports);
  }
  const reachable = new Set();
  function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const target of edges.get(file)) visit(target);
  }
  for (const entry of Object.values(toolRuntimeManifest().entries)) visit(entry);
  if (reachable.size !== files.size) throw new Error('Curated tool runtime list contains unreachable assets.');
  return assets;
}

export function createToolRuntimeAssetsPlugin(root) {
  return {
    name: 'pie-tool-runtime-assets',
    buildStart() {
      this.addWatchFile(fileURLToPath(new URL('./tool-runtime-assets.mjs', import.meta.url)));
      for (const file of TOOL_RUNTIME_FILES) this.addWatchFile(path.join(root, file));
    },
    generateBundle() {
      for (const { file, source } of readToolRuntimeAssets(root)) {
        this.emitFile({ type: 'asset', fileName: `${TOOL_RUNTIME_DIRECTORY}/${file}`, source });
      }
      const manifest = process.env.PIE_BUILD_PLAYWRIGHT_RUNTIME === '1'
        ? toolRuntimeManifest({ playwrightRuntimeIdentity: process.env.PIE_BUILD_PLAYWRIGHT_PAYLOAD_IDENTITY })
        : toolRuntimeManifest();
      this.emitFile({ type: 'asset', fileName: TOOL_RUNTIME_MANIFEST, source: `${JSON.stringify(manifest, null, 2)}\n` });
    },
  };
}
