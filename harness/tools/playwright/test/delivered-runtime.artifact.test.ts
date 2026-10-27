import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readNodeRuntimeManifest } from '../../../../lib/node-runtime/manifest.mjs';
import { extractCandidate } from '../../../../scripts/verification/lib/vsix-candidate.mjs';
import { withWinLddTracePreload } from './fixtures/sidecar-trace-args.mjs';

const VSIX_ENV = 'PIE_DELIVERED_PLAYWRIGHT_VSIX';
const VSIX_SHA256_ENV = 'PIE_DELIVERED_PLAYWRIGHT_VSIX_SHA256';
const BUILD_ID_ENV = 'PIE_DELIVERED_PLAYWRIGHT_BUILD_ID';
const BROWSER_OPT_IN_ENV = 'PIE_RUN_DELIVERED_PLAYWRIGHT_BROWSER';
const HOST_VALIDATION_SKIP_ALIASES = new Set([
  'playwright_skip_validate_host_requirements',
  'npm_config_playwright_skip_validate_host_requirements',
  'npm_package_config_playwright_skip_validate_host_requirements',
]);
const acceptedVsixPath = process.env[VSIX_ENV];
const expectedVsixSha256 = process.env[VSIX_SHA256_ENV];
const expectedBuildId = process.env[BUILD_ID_ENV];
const explicitlyEnabled = process.env[BROWSER_OPT_IN_ENV] === '1';

function validateExpectedInputs(sha256: string | undefined, buildId: string | undefined): { sha256: string; buildId: string } {
  if (!sha256?.trim()) assert.fail(`${VSIX_SHA256_ENV} must provide the expected candidate SHA-256`);
  assert.match(sha256, /^[a-f0-9]{64}$/iu, `${VSIX_SHA256_ENV} must be a 64-character hexadecimal SHA-256`);
  if (!buildId?.trim()) assert.fail(`${BUILD_ID_ENV} must provide the expected candidate build ID`);
  return { sha256, buildId };
}

interface WinLddTraceRecord {
  event: string;
  command: string;
  args: string[];
  cwd: string;
  code: number | null;
  signal: string | null;
}

function assertPackagedWinLddTrace(trace: WinLddTraceRecord[], expectedWinLddExecutable: string, expectedShellExecutable: string): void {
  assert.ok(trace.length > 0, 'the actual packaged validation must record WinLdd checks');
  const expectedCommand = path.win32.resolve(expectedWinLddExecutable).toLowerCase();
  const expectedShell = path.win32.resolve(expectedShellExecutable).toLowerCase();
  for (const call of trace) {
    assert.equal(call.event, 'close', 'every packaged WinLdd check must complete');
    assert.equal(path.win32.resolve(call.command).toLowerCase(), expectedCommand, 'every check must use WinLdd from this accepted payload');
    assert.equal(call.code, 0, 'every packaged WinLdd check must exit successfully');
    assert.equal(call.signal, null, 'packaged WinLdd checks must not be terminated by a signal');
  }
  assert.ok(
    trace.some((call) => call.args.some((argument) => path.win32.resolve(argument).toLowerCase() === expectedShell)),
    'the actual packaged validation must check the exact chrome-headless-shell.exe path',
  );
}

test('packaged WinLdd trace accepts shell plus DLL checks and rejects missing-shell or failed checks', () => {
  const winLdd = 'C:\\payload\\browsers\\winldd-1\\PrintDeps.exe';
  const shell = 'C:\\payload\\browsers\\chromium_headless_shell-1\\chrome-headless-shell-win64\\chrome-headless-shell.exe';
  const cwd = path.win32.dirname(shell);
  const call = (target: string, code = 0): WinLddTraceRecord => ({
    event: 'close', command: winLdd, args: [target], cwd, code, signal: null,
  });
  assert.doesNotThrow(() => assertPackagedWinLddTrace([
    call(shell), call(path.win32.join(cwd, 'libEGL.dll')), call(path.win32.join(cwd, 'libGLESv2.dll')),
  ], winLdd, shell));
  assert.throws(() => assertPackagedWinLddTrace([call(path.win32.join(cwd, 'chrome-headless-shell.exe.backup'))], winLdd, shell), /exact chrome-headless-shell/u);
  assert.throws(() => assertPackagedWinLddTrace([call(shell, 1)], winLdd, shell), /exit successfully/u);
});

test('delivered Playwright artifact expected inputs require an explicit hash and build ID', () => {
  assert.throws(() => validateExpectedInputs(undefined, undefined), /PIE_DELIVERED_PLAYWRIGHT_VSIX_SHA256/u);
  assert.throws(() => validateExpectedInputs('not-a-hash', 'candidate'), /64-character hexadecimal/u);
  assert.throws(() => validateExpectedInputs('a'.repeat(64), '  '), /PIE_DELIVERED_PLAYWRIGHT_BUILD_ID/u);
  assert.deepEqual(validateExpectedInputs('a'.repeat(64), 'candidate-build'), {
    sha256: 'a'.repeat(64), buildId: 'candidate-build',
  });
});

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

interface ZipMember {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface PayloadInventoryItem {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, position);
  assert.equal(bytesRead, length, `incomplete VSIX read at offset ${position}`);
  return bytes;
}

async function verifyExtractedVsixMembers(vsixPath: string, extensionRoot: string, sdkPackage: string): Promise<{ sdkFiles: number; runtimeFiles: number; payloadFiles: number; nodeFiles: number; payloadInventory: PayloadInventoryItem[] }> {
  const handle = await open(vsixPath, 'r');
  try {
    const fileSize = (await handle.stat()).size;
    const tailSize = Math.min(fileSize, 65_557);
    const tail = await readExactly(handle, tailSize, fileSize - tailSize);
    const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    let eocdOffset = tail.lastIndexOf(eocdSignature);
    while (eocdOffset >= 0 && eocdOffset + 22 + tail.readUInt16LE(eocdOffset + 20) !== tail.length) {
      eocdOffset = tail.lastIndexOf(eocdSignature, eocdOffset - 1);
    }
    assert.ok(eocdOffset >= 0, 'the supplied VSIX must be a complete ZIP archive');
    assert.equal(tail.readUInt16LE(eocdOffset + 4), 0, 'multi-disk VSIX archives are unsupported');
    assert.equal(tail.readUInt16LE(eocdOffset + 6), 0);
    const memberCount = tail.readUInt16LE(eocdOffset + 10);
    assert.equal(tail.readUInt16LE(eocdOffset + 8), memberCount);
    assert.notEqual(memberCount, 0xffff, 'ZIP64 VSIX archives are unsupported by this bounded verifier');
    const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
    const centralDirectory = await readExactly(handle, centralDirectorySize, centralDirectoryOffset);
    const members = new Map<string, ZipMember>();
    let cursor = 0;
    for (let index = 0; index < memberCount; index += 1) {
      assert.equal(centralDirectory.readUInt32LE(cursor), 0x02014b50, `invalid VSIX central-directory entry ${index}`);
      const flags = centralDirectory.readUInt16LE(cursor + 8);
      const method = centralDirectory.readUInt16LE(cursor + 10);
      const compressedSize = centralDirectory.readUInt32LE(cursor + 20);
      const uncompressedSize = centralDirectory.readUInt32LE(cursor + 24);
      const nameLength = centralDirectory.readUInt16LE(cursor + 28);
      const extraLength = centralDirectory.readUInt16LE(cursor + 30);
      const commentLength = centralDirectory.readUInt16LE(cursor + 32);
      const localHeaderOffset = centralDirectory.readUInt32LE(cursor + 42);
      const name = centralDirectory.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      assert.equal(flags & 1, 0, `encrypted VSIX member is unsupported: ${name}`);
      if (!name.endsWith('/')) {
        assert.ok(!members.has(name), `duplicate VSIX member: ${name}`);
        members.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset });
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    assert.equal(cursor, centralDirectory.length, 'VSIX central-directory length mismatch');

    async function memberBytes(name: string): Promise<Buffer> {
      const member = members.get(name);
      assert.ok(member, `missing VSIX member: ${name}`);
      const header = await readExactly(handle, 30, member.localHeaderOffset);
      assert.equal(header.readUInt32LE(0), 0x04034b50, `invalid local VSIX header: ${name}`);
      const nameLength = header.readUInt16LE(26);
      const extraLength = header.readUInt16LE(28);
      const localName = (await readExactly(handle, nameLength, member.localHeaderOffset + 30)).toString('utf8');
      assert.equal(localName, name, `VSIX local/central member mismatch: ${name}`);
      const compressed = await readExactly(handle, member.compressedSize, member.localHeaderOffset + 30 + nameLength + extraLength);
      const bytes = member.method === 0 ? compressed : member.method === 8 ? inflateRawSync(compressed) : undefined;
      assert.ok(bytes, `unsupported VSIX compression method ${member.method}: ${name}`);
      assert.equal(bytes.length, member.uncompressedSize, `VSIX member size mismatch: ${name}`);
      return bytes;
    }

    async function verifyMember(archiveName: string, extractedPath: string): Promise<Buffer> {
      const archived = await memberBytes(archiveName);
      const extracted = await readFile(extractedPath);
      assert.equal(archived.compare(extracted), 0, `extracted file differs from accepted VSIX member ${archiveName}`);
      return archived;
    }

    const playwrightEntry = await verifyMember('extension/out/playwright.js', path.join(extensionRoot, 'out', 'playwright.js'));
    const runtimePathMatch = playwrightEntry.toString('utf8').match(/require\(["']\.\/(runtime-path-[^"']+\.js)["']\)/u);
    assert.ok(runtimePathMatch, 'the delivered Playwright factory must reference its packaged runtime resolver');
    await verifyMember(`extension/out/${runtimePathMatch[1]}`, path.join(extensionRoot, 'out', runtimePathMatch[1]));

    const runtimeManifestPath = path.join(extensionRoot, 'out', 'resources', 'tool-runtimes', 'manifest.json');
    const runtimeManifestBytes = await verifyMember('extension/out/resources/tool-runtimes/manifest.json', runtimeManifestPath);
    const runtimeManifest = JSON.parse(runtimeManifestBytes.toString('utf8')) as { files?: unknown };
    assert.ok(Array.isArray(runtimeManifest.files));
    for (const relative of runtimeManifest.files) {
      assert.equal(typeof relative, 'string');
      const relativePath = relative as string;
      assert.ok(!relativePath.startsWith('/') && !relativePath.split('/').includes('..'));
      await verifyMember(
        `extension/out/resources/tool-runtimes/${relativePath}`,
        path.join(extensionRoot, 'out', 'resources', 'tool-runtimes', ...relativePath.split('/')),
      );
    }
    const nodeRuntimeRoot = path.join(extensionRoot, 'out', 'resources', 'node-runtime');
    const nodeManifestBytes = await verifyMember('extension/out/resources/node-runtime/manifest.json', path.join(nodeRuntimeRoot, 'manifest.json'));
    const nodeManifest = await readNodeRuntimeManifest(nodeRuntimeRoot);
    assert.deepEqual(nodeManifest.inventory.map(({ relativePath }) => relativePath), ['LICENSE', 'node.exe']);
    assert.deepEqual(JSON.parse(nodeManifestBytes.toString('utf8')), nodeManifest);
    const nodePrefix = 'extension/out/resources/node-runtime/';
    assert.deepEqual(
      [...members.keys()].filter((name) => name.startsWith(nodePrefix)).sort(),
      [nodePrefix + 'LICENSE', nodePrefix + 'manifest.json', nodePrefix + 'node.exe'].sort(),
      'the accepted VSIX Node runtime tree must contain exactly its manifest inventory',
    );
    for (const item of nodeManifest.inventory) {
      const bytes = await verifyMember(`extension/out/resources/node-runtime/${item.relativePath}`, path.join(nodeRuntimeRoot, item.relativePath));
      assert.equal(bytes.length, item.sizeBytes, `Node runtime inventory size mismatch: ${item.relativePath}`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, `Node runtime inventory hash mismatch: ${item.relativePath}`);
    }

    const payloadRoot = path.join(extensionRoot, 'out', 'resources', 'tool-runtimes', 'playwright-runtime');
    const payloadManifestBytes = await verifyMember(
      'extension/out/resources/tool-runtimes/playwright-runtime/manifest.json',
      path.join(payloadRoot, 'manifest.json'),
    );
    const payloadManifest = JSON.parse(payloadManifestBytes.toString('utf8')) as { inventory?: unknown };
    assert.ok(Array.isArray(payloadManifest.inventory) && payloadManifest.inventory.length > 0 && payloadManifest.inventory.length <= 8192);
    const payloadInventory: PayloadInventoryItem[] = [];
    for (const item of payloadManifest.inventory) {
      assert.ok(item && typeof item === 'object' && !Array.isArray(item));
      const inventoryItem = item as { relativePath?: unknown; sizeBytes?: unknown; sha256?: unknown };
      const relativePath = inventoryItem.relativePath;
      assert.equal(typeof relativePath, 'string');
      assert.ok(Number.isSafeInteger(inventoryItem.sizeBytes) && Number(inventoryItem.sizeBytes) >= 0);
      assert.ok(typeof inventoryItem.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(inventoryItem.sha256));
      const payloadRelativePath = relativePath as string;
      assert.ok(!payloadRelativePath.includes('\\') && !payloadRelativePath.startsWith('/') && !/^[A-Za-z]:/u.test(payloadRelativePath) && !payloadRelativePath.split('/').some((part) => part === '.' || part === '..' || !part));
      const extractedPath = path.resolve(payloadRoot, ...payloadRelativePath.split('/'));
      assert.ok(extractedPath.startsWith(`${path.resolve(payloadRoot)}${path.sep}`));
      const bytes = await verifyMember(
        `extension/out/resources/tool-runtimes/playwright-runtime/${payloadRelativePath}`,
        extractedPath,
      );
      assert.equal(bytes.length, inventoryItem.sizeBytes, `Playwright payload inventory size mismatch: ${payloadRelativePath}`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), inventoryItem.sha256, `Playwright payload inventory hash mismatch: ${payloadRelativePath}`);
      payloadInventory.push({ relativePath: payloadRelativePath, sizeBytes: Number(inventoryItem.sizeBytes), sha256: inventoryItem.sha256 as string });
    }
    const payloadPrefix = 'extension/out/resources/tool-runtimes/playwright-runtime/';
    assert.deepEqual(
      [...members.keys()].filter((name) => name.startsWith(payloadPrefix)).sort(),
      [payloadPrefix + 'manifest.json', ...payloadInventory.map((item) => payloadPrefix + item.relativePath)].sort(),
      'the accepted VSIX browser payload must contain exactly its manifest inventory',
    );

    const sdkPrefix = 'extension/out/pi-runtime/node_modules/@earendil-works/pi-coding-agent/';
    const sdkMembers = [...members.keys()].filter((name) => name.startsWith(sdkPrefix));
    assert.ok(sdkMembers.length > 0, 'the accepted VSIX must contain the coding-agent SDK package');
    for (const archiveName of sdkMembers) {
      const relativePath = archiveName.slice(sdkPrefix.length);
      await verifyMember(archiveName, path.join(sdkPackage, ...relativePath.split('/')));
    }
    return { sdkFiles: sdkMembers.length, runtimeFiles: runtimeManifest.files.length, payloadFiles: payloadInventory.length, nodeFiles: nodeManifest.inventory.length, payloadInventory };
  } finally {
    await handle.close();
  }
}

async function snapshotPackagedPayloadTree(payloadRoot: string, inventory: PayloadInventoryItem[]): Promise<{ directories: string[]; files: PayloadInventoryItem[] }> {
  const directories = [''];
  const files: PayloadInventoryItem[] = [];
  async function walk(relativeDirectory: string): Promise<void> {
    const directory = relativeDirectory === '' ? payloadRoot : path.join(payloadRoot, ...relativeDirectory.split('/'));
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const fullPath = path.join(payloadRoot, ...relativePath.split('/'));
      assert.equal(entry.isSymbolicLink(), false, `packaged Playwright payload must not contain symlinks: ${relativePath}`);
      if (entry.isDirectory()) {
        directories.push(relativePath);
        await walk(relativePath);
      } else {
        assert.equal(entry.isFile(), true, `unsupported packaged Playwright payload entry: ${relativePath}`);
        const info = await stat(fullPath);
        files.push({ relativePath, sizeBytes: info.size, sha256: await sha256File(fullPath) });
      }
    }
  }
  await walk('');
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  directories.sort((left, right) => left.localeCompare(right));

  const expectedFiles = [
    ...inventory,
    { relativePath: 'manifest.json', sizeBytes: (await stat(path.join(payloadRoot, 'manifest.json'))).size, sha256: await sha256File(path.join(payloadRoot, 'manifest.json')) },
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  assert.deepEqual(files.map((item) => item.relativePath), expectedFiles.map((item) => item.relativePath), 'the packaged Playwright payload file tree must match its complete declared inventory');
  for (const expected of inventory) {
    const actual = files.find((item) => item.relativePath === expected.relativePath);
    assert.deepEqual(actual, expected, `packaged Playwright payload differs from its manifest inventory: ${expected.relativePath}`);
  }
  const expectedDirectories = new Set(['']);
  for (const item of expectedFiles) {
    let parent = path.posix.dirname(item.relativePath);
    while (parent !== '.') {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  assert.deepEqual(directories, [...expectedDirectories].sort((left, right) => left.localeCompare(right)), 'the packaged Playwright payload directory tree must contain no extras');
  return { directories, files };
}

function isolatedEnvironment(sandbox: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (HOST_VALIDATION_SKIP_ALIASES.has(name.toLowerCase())) delete env[name];
  }
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  delete env.PIE_EXTENSION_TOGGLES_JSON;
  for (const name of Object.keys(env)) {
    if (/(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_ACCESS_KEY(?:_ID)?|_CREDENTIALS?)$/iu.test(name)) delete env[name];
  }

  const profile = path.join(sandbox, 'profile');
  const data = path.join(sandbox, 'data');
  const cache = path.join(sandbox, 'cache');
  const temporary = path.join(sandbox, 'tmp');
  Object.assign(env, {
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    XDG_CONFIG_HOME: path.join(profile, '.config'),
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: path.join(data, 'state'),
    XDG_CACHE_HOME: cache,
    XDG_RUNTIME_DIR: path.join(temporary, 'runtime'),
    PIE_DATA_ROOT: data,
    PIE_DATA_DIR: data,
    PI_CODING_AGENT_DIR: path.join(sandbox, 'agent'),
    PI_CODING_AGENT_AUTH_DIR: path.join(sandbox, 'auth'),
    PI_CODING_AGENT_SESSION_DIR: path.join(sandbox, 'sessions'),
    PSModulePath: path.join(sandbox, 'ps-modules'),
    PSModuleAnalysisCachePath: path.join(cache, 'powershell', 'module-analysis'),
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
    NPM_CONFIG_CACHE: path.join(cache, 'npm'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(sandbox, 'ambient-browser-path-must-not-be-used'),
    PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT: path.join(sandbox, 'ambient-module-path-must-not-be-used'),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PUPPETEER_CACHE_DIR: path.join(cache, 'puppeteer'),
    PUPPETEER_SKIP_DOWNLOAD: '1',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
  });
  assert.deepEqual(Object.keys(env).filter((name) => HOST_VALIDATION_SKIP_ALIASES.has(name.toLowerCase())), [], 'all case-insensitive Playwright host-validation skip aliases must be cleared');
  return env;
}

test('Windows Node accepts the test-only sidecar preload as a file URL, not a drive-letter path', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'pie-sidecar-preload-probe-'));
  t.after(async () => { await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const tracePath = path.join(sandbox, 'winldd-trace.jsonl');
  const tracePreloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'actual-winldd-trace.mjs');
  const env = { ...isolatedEnvironment(sandbox), PIE_TEST_WINLDD_TRACE_FILE: tracePath };

  const rawPathProbe = spawnSync(process.execPath, ['--import', tracePreloadPath, '-e', ''], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true, env,
  });
  assert.equal(rawPathProbe.error, undefined, `raw-path Node probe failed to complete: ${rawPathProbe.error?.message ?? ''}`);
  assert.equal(rawPathProbe.status, 1);
  assert.match(rawPathProbe.stderr, /ERR_UNSUPPORTED_ESM_URL_SCHEME/u, 'a C:/... path is parsed as the unsupported c: URL scheme');

  const preloadArgs = withWinLddTracePreload(['-e', "process.stdout.write('preload-ready')"], tracePreloadPath);
  assert.deepEqual(preloadArgs.slice(0, 2), ['--import', pathToFileURL(tracePreloadPath).href]);
  const fileUrlProbe = spawnSync(process.execPath, preloadArgs, {
    encoding: 'utf8', timeout: 5_000, windowsHide: true, env,
  });
  assert.equal(fileUrlProbe.error, undefined, `file-URL Node probe failed to complete: ${fileUrlProbe.error?.message ?? ''}`);
  assert.equal(fileUrlProbe.status, 0, fileUrlProbe.stderr);
  assert.equal(fileUrlProbe.stdout, 'preload-ready');
});

test('delivered Playwright artifact registers and runs its real SDK-loaded tool, then session shutdown reaps its runtime', {
  skip: !acceptedVsixPath || !explicitlyEnabled,
  timeout: 300_000,
}, async (t) => {
  assert.ok(acceptedVsixPath, `${VSIX_ENV} must name the candidate VSIX`);
  const expected = validateExpectedInputs(expectedVsixSha256, expectedBuildId);
  assert.equal(process.platform, 'win32', 'this delivered browser payload targets Windows');
  assert.equal(process.arch, 'x64', 'this delivered browser payload targets x64');

  const vsixPath = path.resolve(acceptedVsixPath);
  const initialHash = await sha256File(vsixPath);
  assert.equal(initialHash, expected.sha256, 'the test must consume the exact explicitly identified candidate VSIX');

  const privateRoot = await mkdtemp(path.join(tmpdir(), 'pie-delivered-playwright-'));
  let testSucceeded = false;
  t.after(async () => {
    if (!testSucceeded) {
      t.diagnostic(`delivered artifact failure diagnostics preserved at ${privateRoot} (sidecar stderr: ${path.join(privateRoot, 'sidecar-stderr.log')}; WinLdd trace: ${path.join(privateRoot, 'actual-winldd-trace.jsonl')})`);
      return;
    }
    await rm(privateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.equal(existsSync(privateRoot), false, 'the owned artifact-test tree must be removed after child shutdown');
  });
  const extensionRoot = path.join(privateRoot, 'extracted-extension');
  await extractCandidate(vsixPath, extensionRoot);
  const extensionEntry = path.join(extensionRoot, 'out', 'playwright.js');
  const sdkPackage = path.join(extensionRoot, 'out', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const sdkEntry = path.join(sdkPackage, 'dist', 'index.js');
  const runtimeRoot = path.join(extensionRoot, 'out', 'resources', 'tool-runtimes');
  const sidecarEntry = path.join(runtimeRoot, 'harness', 'tools', 'playwright', 'sidecar.mjs');
  const browserRoot = path.join(runtimeRoot, 'playwright-runtime', 'browsers');
  const moduleRoot = path.join(runtimeRoot, 'playwright-runtime', 'node_modules');
  const verifiedMembers = await verifyExtractedVsixMembers(vsixPath, extensionRoot, sdkPackage);
  assert.ok(verifiedMembers.sdkFiles > 0);
  assert.ok(verifiedMembers.runtimeFiles > 0);
  assert.ok(verifiedMembers.payloadFiles > 0);
  assert.equal(verifiedMembers.nodeFiles, 2);
  t.diagnostic(`accepted VSIX extraction verified: ${verifiedMembers.sdkFiles} SDK files, ${verifiedMembers.runtimeFiles} curated runtime files, ${verifiedMembers.payloadFiles} browser-payload files, and ${verifiedMembers.nodeFiles} Node runtime files`);
  for (const file of [extensionEntry, sdkEntry, sidecarEntry, path.join(runtimeRoot, 'manifest.json')]) {
    assert.ok(existsSync(file), `missing delivered artifact file: ${file}`);
  }
  assert.equal((await readFile(path.join(extensionRoot, 'out', 'pie-build-id.txt'), 'utf8')).trim(), expected.buildId);

  const sandbox = privateRoot;
  const proofPath = path.join(sandbox, 'runtime-proof.json');
  const hostCheckTracePath = path.join(sandbox, 'actual-winldd-trace.jsonl');
  const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const fixturePath = path.join(fixtureDirectory, 'delivered-runtime-child.mjs');
  const tracePreloadPath = path.join(fixtureDirectory, 'actual-winldd-trace.mjs');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const childEnv = isolatedEnvironment(sandbox);
  const nodeRuntimeRoot = path.join(extensionRoot, 'out', 'resources', 'node-runtime');
  const nodeManifestPath = path.join(nodeRuntimeRoot, 'manifest.json');
  const nodeExecutable = path.join(nodeRuntimeRoot, 'node.exe');
  const payloadAbsent = !existsSync(nodeRuntimeRoot);
  let selectedNode: string;
  if (payloadAbsent) {
    selectedNode = process.execPath;
  } else {
    const nodeManifest = await readNodeRuntimeManifest(nodeRuntimeRoot);
    assert.ok(existsSync(nodeExecutable), 'present Node runtime payload must include its manifest-declared node.exe');
    const probe = spawnSync(nodeExecutable, ['--version'], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
      env: isolatedEnvironment(sandbox),
    });
    assert.equal(probe.error, undefined, `delivered Node runtime probe failed: ${probe.error?.message ?? ''}`);
    assert.equal(probe.status, 0, `delivered Node runtime probe exited ${String(probe.status)}: ${probe.stderr ?? ''}`);
    assert.equal(probe.stdout.trim(), `v${nodeManifest.nodeVersion}`, 'actual delivered Node version must match its manifest');
    const abiProbe = spawnSync(nodeExecutable, ['-p', 'process.versions.modules'], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
      env: isolatedEnvironment(sandbox),
    });
    assert.equal(abiProbe.error, undefined, `delivered Node ABI probe failed: ${abiProbe.error?.message ?? ''}`);
    assert.equal(abiProbe.status, 0, `delivered Node ABI probe exited ${String(abiProbe.status)}: ${abiProbe.stderr ?? ''}`);
    assert.equal(abiProbe.stdout.trim(), nodeManifest.target.nodeAbi, 'actual delivered Node ABI must match its manifest');
    selectedNode = nodeExecutable;
  }
  const payloadBeforeLaunch = await snapshotPackagedPayloadTree(
    path.join(runtimeRoot, 'playwright-runtime'), verifiedMembers.payloadInventory,
  );
  assert.equal(existsSync(hostCheckTracePath), false, 'the sidecar-only WinLdd trace must start empty');
  const payloadManifest = JSON.parse(await readFile(path.join(runtimeRoot, 'playwright-runtime', 'manifest.json'), 'utf8')) as {
    pins: { chromiumHeadlessShell: { revision: string }; winldd: string };
  };
  const expectedShellExecutable = path.join(
    browserRoot, `chromium_headless_shell-${payloadManifest.pins.chromiumHeadlessShell.revision}`,
    'chrome-headless-shell-win64', 'chrome-headless-shell.exe',
  );
  const expectedWinLddExecutable = path.join(browserRoot, `winldd-${payloadManifest.pins.winldd}`, 'PrintDeps.exe');
  const child = spawnSync(selectedNode, [fixturePath, extensionRoot, sdkPackage, sandbox, proofPath, hostCheckTracePath, tracePreloadPath], {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  await writeFile(path.join(privateRoot, 'artifact-child.stdout.log'), child.stdout ?? '');
  await writeFile(path.join(privateRoot, 'artifact-child.stderr.log'), child.stderr ?? '');
  assert.equal(child.error, undefined, `isolated artifact child failed to complete: ${child.error?.message ?? ''}\n${child.stderr ?? ''}\n${child.stdout ?? ''}`);
  assert.equal(child.status, 0, `isolated artifact child exited ${String(child.status)}\n${child.stderr ?? ''}\n${child.stdout ?? ''}`);

  const payloadAfterShutdown = await snapshotPackagedPayloadTree(
    path.join(runtimeRoot, 'playwright-runtime'), verifiedMembers.payloadInventory,
  );
  assert.deepEqual(payloadAfterShutdown, payloadBeforeLaunch, 'the complete packaged Playwright payload tree and file hashes must remain unchanged through actual session shutdown');
  const validationMarker = path.join(browserRoot, `chromium_headless_shell-${payloadManifest.pins.chromiumHeadlessShell.revision}`, 'DEPENDENCIES_VALIDATED');
  assert.equal(existsSync(validationMarker), false, 'actual packaged validation must not add Playwright\'s cached DEPENDENCIES_VALIDATED marker');

  const proof = JSON.parse(await readFile(proofPath, 'utf8')) as {
    nodeExecutable: string;
    extensionRoot: string;
    extensionEntry: string;
    sdkEntry: string;
    loadedExtensions: string[];
    registeredTools: string[];
    sessionPath: string;
    sessionFileBytes: number;
    sessionArtifactsRoot: string;
    screenshotPaths: string[];
    screenshotBytes: number[];
    openText: string;
    routedText: string;
    observeText: string;
    screenshotImageParts: number;
    sidecarLaunches: Array<{ executable: string; entry: string; args: string[]; hostValidationSkipVariables: string[]; env: Record<string, string | undefined> }>;
    winLddTrace: WinLddTraceRecord[];
    pids: { sidecarPid: number; browserPids: number[] };
    shutdownHandlerInvoked: boolean;
    registryEntryBeforeShutdown: boolean;
    sidecarAliveBeforeShutdown: boolean;
    browserPidsAfterClose: number[];
    registryEntryAfterShutdown: boolean;
    deadPids: number[];
    cleanupErrors: string[];
  };

  const resolvedPrivateRoot = await realpath(sandbox);
  assert.equal(path.resolve(proof.nodeExecutable), path.resolve(selectedNode), 'record the Node executable selected for the isolated child');
  assert.equal(path.resolve(proof.extensionRoot), path.resolve(extensionRoot));
  assert.equal(path.resolve(proof.extensionEntry), path.resolve(extensionEntry));
  assert.equal(path.resolve(proof.sdkEntry), path.resolve(sdkEntry));
  assert.deepEqual(proof.loadedExtensions.map((entry) => path.resolve(entry)), [path.resolve(extensionEntry)], 'only the delivered Playwright factory may load');
  assert.deepEqual(proof.registeredTools, ['playwright']);
  assert.match(proof.openText, /browser: headless Chromium/);
  assert.match(proof.openText, /isolated context/);
  assert.match(proof.routedText, /external page requests blocked/);
  assert.match(proof.observeText, /url: about:blank/);
  assert.equal(proof.screenshotImageParts, 1, 'the actual text+image context should receive one requested screenshot');
  assert.equal(proof.sessionFileBytes, 0, 'the durable session owner file remains inside the private tree');
  assert.ok(path.resolve(proof.sessionPath).startsWith(`${resolvedPrivateRoot}${path.sep}`));
  assert.ok((await stat(proof.sessionPath)).isFile());
  assert.equal(proof.screenshotPaths.length, 2);
  assert.equal(proof.screenshotBytes.length, 2);
  assert.ok(proof.screenshotBytes.every((size) => size > 0));
  const sessionArtifactsRoot = path.resolve(proof.sessionArtifactsRoot);
  assert.ok(sessionArtifactsRoot.startsWith(`${resolvedPrivateRoot}${path.sep}`), 'durable session artifacts must remain inside the private owned tree');
  for (const artifactPath of proof.screenshotPaths) {
    assert.ok(path.resolve(artifactPath).startsWith(`${sessionArtifactsRoot}${path.sep}`));
    assert.ok((await stat(artifactPath)).size > 0, `screenshot artifact was not durable: ${artifactPath}`);
  }
  assert.equal(proof.sidecarLaunches.length, 1, 'the instrumented parent spawn must observe the actual sidecar launch');
  const [launch] = proof.sidecarLaunches;
  assert.equal(path.resolve(launch.executable), path.resolve(selectedNode), 'record the actual selected Node executable');
  assert.equal(path.resolve(launch.entry), path.resolve(sidecarEntry), 'the runtime must launch the sidecar extracted from this VSIX');
  assert.deepEqual(launch.args, ['--import', pathToFileURL(tracePreloadPath).href, sidecarEntry], 'only the actual sidecar command receives the owned read-only WinLdd trace preload as a file URL, before its unchanged entry');
  assert.deepEqual(launch.hostValidationSkipVariables, [], 'no case-insensitive host-validation skip alias may reach the actual sidecar');
  assert.equal(path.resolve(launch.env['PIE_TEST_WINLDD_TRACE_FILE'] ?? ''), path.resolve(hostCheckTracePath));
  assert.equal(path.resolve(launch.env['PLAYWRIGHT_BROWSERS_PATH'] ?? ''), path.resolve(browserRoot));
  assert.equal(path.resolve(launch.env['PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT'] ?? ''), path.resolve(moduleRoot));
  assert.notEqual(launch.env['PLAYWRIGHT_BROWSERS_PATH'], childEnv.PLAYWRIGHT_BROWSERS_PATH, 'the invalid ambient browser path must be overridden');
  assert.notEqual(launch.env['PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT'], childEnv.PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT, 'the invalid ambient module path must be overridden');
  assert.equal(launch.env['HOME'], childEnv.HOME);
  assert.equal(launch.env['USERPROFILE'], childEnv.USERPROFILE);
  assert.equal(launch.env['TEMP'], childEnv.TEMP);
  assert.equal(launch.env['PIE_DATA_DIR'], childEnv.PIE_DATA_DIR);
  assert.equal(launch.env['PI_CODING_AGENT_DIR'], childEnv.PI_CODING_AGENT_DIR);
  assert.equal(launch.env['NODE_OPTIONS'], undefined, 'inherited Node options must not reach the SDK-owned sidecar');
  assertPackagedWinLddTrace(proof.winLddTrace, expectedWinLddExecutable, expectedShellExecutable);
  assert.ok(proof.pids.sidecarPid > 0);
  assert.ok(proof.pids.browserPids.length > 0, 'the real tool must have launched its headless browser');
  assert.equal(proof.shutdownHandlerInvoked, true);
  assert.equal(proof.registryEntryBeforeShutdown, true, 'the real runtime must remain registered after close and before owner shutdown');
  assert.equal(proof.sidecarAliveBeforeShutdown, true, 'the owning shutdown event must have a live sidecar to terminate');
  assert.deepEqual(proof.browserPidsAfterClose, [], 'the actual close action must have already reaped its browser');
  assert.equal(proof.registryEntryAfterShutdown, false, 'session_shutdown must remove the real runtime registry entry');
  assert.deepEqual([...proof.deadPids].sort((a, b) => a - b), [proof.pids.sidecarPid, ...proof.pids.browserPids].sort((a, b) => a - b), 'session_shutdown must terminate the sidecar and every reported browser process');
  assert.deepEqual(proof.cleanupErrors, []);

  const finalHash = await sha256File(vsixPath);
  assert.equal(finalHash, expected.sha256, 'the candidate VSIX must remain byte-identical');
  testSucceeded = true;
});
