import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';
import {
  preparePlaywrightHeadlessPayload,
} from '../playwright-payload.mjs';
import {
  PLAYWRIGHT_RUNTIME_PAYLOAD_MANIFEST,
  preparePlaywrightRuntimePayload,
  validatePlaywrightRuntimePayload,
} from '../playwright-runtime-payload.mjs';

const versions = { playwright: '1.62.1', playwrightCore: '1.62.1', pngjs: '7.0.0' };
const coreIntegrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const shellUrl = 'https://cdn.playwright.dev/builds/cft/151.0.7922.34/win64/chrome-headless-shell-win64.zip';
const ffmpegUrl = 'https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-win64.zip';
const winlddUrl = 'https://cdn.playwright.dev/dbazure/download/playwright/builds/winldd/1007/winldd-win64.zip';

function packageJson(name, extra = {}) {
  const base = { name, version: versions[name === 'playwright-core' ? 'playwrightCore' : name] };
  if (name === 'playwright') Object.assign(base, {
    dependencies: { 'playwright-core': versions.playwrightCore },
    optionalDependencies: { fsevents: '2.3.2' },
    engines: { node: '>=20' },
    scripts: { postinstall: 'throw new Error("must not run")' },
  });
  if (name === 'playwright-core') Object.assign(base, { engines: { node: '>=20' } });
  if (name === 'pngjs') Object.assign(base, { engines: { node: '>=14.19.0' } });
  return { ...base, ...extra };
}

function archiveManifestProjection(value) {
  return {
    name: value.name,
    version: value.version,
    dependencies: value.dependencies ?? {},
    optionalDependencies: value.optionalDependencies ?? {},
    peerDependencies: value.peerDependencies ?? {},
    engines: value.engines ?? {},
  };
}

function putOctal(buffer, value, offset, length) {
  const text = `${value.toString(8).padStart(length - 1, '0')}\0`;
  buffer.write(text, offset, length, 'ascii');
}

function tarHeader(name, bytes, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  putOctal(header, 0o644, 100, 8);
  putOctal(header, 0, 108, 8);
  putOctal(header, 0, 116, 8);
  putOctal(header, bytes.length, 124, 12);
  putOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function makeTgz(files) {
  const blocks = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    blocks.push(tarHeader(`package/${name}`, bytes), bytes);
    const padding = (512 - bytes.length % 512) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes);
    const compressed = entry.method === 0 ? bytes : deflateRawSync(bytes);
    const checksum = crc32(bytes);
    const flags = 0x0800;
    const method = entry.method ?? 8;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.declaredSize ?? bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += localHeader.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...local, centralBytes, eocd]);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function listBytes(root, relative = '') {
  const rows = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const absolute = path.join(root, child);
    const info = await lstat(absolute);
    if (info.isDirectory()) rows.push(...await listBytes(root, child));
    else rows.push([child, await readFile(absolute)]);
  }
  return rows;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-playwright-runtime-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repository');
  const extensionRoot = path.join(repositoryRoot, 'extensions', 'playwright');
  const sourceRoot = path.join(root, 'source');
  const browserRoot = path.join(root, 'browser-evidence');
  const winlddRoot = path.join(root, 'winldd-provenance');
  const shellFiles = {
    'chrome-headless-shell.exe': Buffer.from('synthetic shell binary\0'),
    ABOUT: Buffer.from('Synthetic Chromium ABOUT notice\n'),
    'LICENSE.headless_shell': Buffer.from('Synthetic shell license\n'),
    'locales/en-US.pak': Buffer.from([0, 1, 2, 255]),
  };
  await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(sourceRoot), mkdir(browserRoot), mkdir(winlddRoot)]);
  await writeJson(path.join(extensionRoot, 'package.json'), {
    name: 'pie-playwright', private: true, dependencies: { playwright: versions.playwright, pngjs: versions.pngjs },
  });

  const browsersJson = {
    browsers: [
      { name: 'chromium-headless-shell', revision: 1234, browserVersion: '151.0.7922.34' },
      { name: 'ffmpeg', revision: 1011 },
      { name: 'winldd', revision: 1007 },
    ],
  };
  const packageFiles = {
    playwright: {
      'package.json': packageJson('playwright'),
      LICENSE: 'Playwright license\n', NOTICE: 'Playwright notice\n', 'index.js': 'export {};\n',
    },
    'playwright-core': {
      'package.json': packageJson('playwright-core'),
      LICENSE: 'Core license\n', NOTICE: 'Core notice\n', 'ThirdPartyNotices.txt': 'Third-party notices\n',
      'browsers.json': JSON.stringify(browsersJson), 'lib/coreBundle.js': '/* synthetic core */\n',
    },
    pngjs: { 'package.json': packageJson('pngjs'), LICENSE: 'pngjs license\n', 'index.js': 'module.exports = {};\n' },
  };
  const packageBuffers = {};
  for (const name of ['playwright', 'playwright-core', 'pngjs']) {
    const files = Object.fromEntries(Object.entries(packageFiles[name]).map(([relative, value]) => [
      relative, relative.endsWith('.json') && typeof value !== 'string' ? JSON.stringify(value) : value,
    ]));
    packageBuffers[name] = makeTgz(files);
    await writeFile(path.join(sourceRoot, `${name}-${name === 'pngjs' ? versions.pngjs : name === 'playwright' ? versions.playwright : versions.playwrightCore}.tgz`), packageBuffers[name]);
  }
  const integrities = Object.fromEntries(Object.entries(packageBuffers).map(([name, bytes]) => [name, coreIntegrity(bytes)]));
  const lock = {
    lockfileVersion: '9.0',
    importers: { 'extensions/playwright': { dependencies: {
      playwright: { specifier: versions.playwright, version: versions.playwright },
      pngjs: { specifier: versions.pngjs, version: versions.pngjs },
    } } },
    packages: Object.fromEntries([
      ['playwright', versions.playwright], ['playwright-core', versions.playwrightCore], ['pngjs', versions.pngjs],
    ].map(([name, version]) => [`${name}@${version}`, { resolution: { integrity: integrities[name] } }])),
    snapshots: { [`playwright@${versions.playwright}`]: { dependencies: { 'playwright-core': versions.playwrightCore } } },
  };
  await writeJson(path.join(repositoryRoot, 'pnpm-lock.yaml'), lock);
  const jsProvenancePackages = [];
  for (const name of ['playwright', 'playwright-core', 'pngjs']) {
    const version = name === 'playwright-core' ? versions.playwrightCore : versions[name];
    const archivePath = path.join(sourceRoot, `${name}-${version}.tgz`);
    const pkg = packageJson(name);
    jsProvenancePackages.push({
      name, version,
      metadataUrl: `https://registry.npmjs.org/${name}/${version}`,
      tarballUrl: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      registryIntegrity: integrities[name], lockIntegrity: integrities[name], verifiedIntegrity: integrities[name],
      sizeBytes: packageBuffers[name].length, sha512Hex: createHash('sha512').update(packageBuffers[name]).digest('hex'),
      stagedFile: archivePath,
      archiveManifest: archiveManifestProjection(pkg),
      licenseNoticeEntries: name === 'pngjs' ? ['package/LICENSE'] : ['package/LICENSE', 'package/NOTICE'],
      packageManifestEntry: true,
    });
  }
  const javascriptProvenancePath = path.join(sourceRoot, 'provenance.json');
  await writeJson(javascriptProvenancePath, {
    schema: 'pie-private-jsdependency-provenance-staging/v1',
    source: {
      ownerManifest: 'extensions/playwright/package.json',
      ownerDependencies: { playwright: versions.playwright, pngjs: versions.pngjs },
      authoritativeLock: 'pnpm-lock.yaml', lockfileVersion: '9.0',
      lockIntegrities: Object.entries(integrities).map(([name, integrity]) => ({ name, version: name === 'playwright-core' ? versions.playwrightCore : versions[name], integrity })),
    },
    exclusions: { fsevents: { version: '2.3.2', status: 'excluded optional Darwin-only dependency for Windows', basis: 'pnpm-lock.yaml playwright@1.62.1 optionalDependencies' } },
    stagingDirectory: sourceRoot,
    packages: jsProvenancePackages,
  });

  const shellZip = makeZip(Object.entries(shellFiles).map(([name, bytes]) => ({ name: `chrome-headless-shell-win64/${name}`, bytes })));
  const ffmpegZip = makeZip([
    { name: 'ffmpeg-win64.exe', bytes: Buffer.from('synthetic ffmpeg executable\0') },
    { name: 'COPYING.LGPLv2.1', bytes: Buffer.from('Synthetic LGPL notice\n') },
  ]);
  const winlddZip = makeZip([{ name: 'PrintDeps.exe', bytes: Buffer.from('synthetic WinLdd executable\0') }]);
  const shellZipPath = path.join(browserRoot, 'chromium-headless-shell-win64.zip');
  const ffmpegArchive = path.join(browserRoot, 'ffmpeg-win64.zip');
  const winlddArchive = path.join(winlddRoot, 'winldd-win64.zip');
  await Promise.all([
    writeFile(shellZipPath, shellZip), writeFile(ffmpegArchive, ffmpegZip), writeFile(winlddArchive, winlddZip),
  ]);
  const finalShellUrl = 'https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/win64/chrome-headless-shell-win64.zip';
  const finalFfmpegUrl = 'https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-win64.zip';
  const shellArchiveEvidence = {
    name: 'chromium-headless-shell-win64.zip', kind: 'chromium-headless-shell', requestedUrl: shellUrl,
    finalUrl: finalShellUrl, contentLength: shellZip.length, bytes: shellZip.length, sha256: sha256(shellZip),
  };
  const ffmpegArchiveEvidence = {
    name: 'ffmpeg-win64.zip', kind: 'ffmpeg', requestedUrl: ffmpegUrl,
    finalUrl: finalFfmpegUrl, contentLength: ffmpegZip.length, bytes: ffmpegZip.length, sha256: sha256(ffmpegZip),
  };
  const browserEvidencePath = path.join(browserRoot, 'evidence.json');
  const browserDownloadManifestPath = path.join(browserRoot, 'download-manifest.json');
  const browserEvidence = {
    target: 'Synthetic Windows x64 metadata fixture',
    playwright: {
      packageVersion: versions.playwright,
      packageLock: {
        playwrightCore: { version: versions.playwrightCore, integrity: integrities['playwright-core'] },
        trackedPnpmLockIntegrity: integrities['playwright-core'], matchesTrackedPnpmLock: true,
      },
      coreBundleAndPinFiles: ['package.json', 'browsers.json', 'lib/coreBundle.js'].map(relative => {
        const value = packageFiles['playwright-core'][relative];
        const bytes = relative.endsWith('.json') && typeof value !== 'string' ? Buffer.from(JSON.stringify(value)) : Buffer.from(value);
        return { path: `C:/dev/repos/pie/extensions/playwright/node_modules/playwright-core/${relative}`, bytes: bytes.length, sha256: sha256(bytes) };
      }),
      coreLicenseAndNoticeFiles: ['LICENSE', 'NOTICE', 'ThirdPartyNotices.txt'].map(relative => {
        const bytes = Buffer.from(packageFiles['playwright-core'][relative]);
        return { path: `C:/dev/repos/pie/extensions/playwright/node_modules/playwright-core/${relative}`, bytes: bytes.length, sha256: sha256(bytes) };
      }),
    },
    archives: [shellArchiveEvidence, ffmpegArchiveEvidence],
    execution: { status: 'NOT RUN', noInstallOrActivation: true, localMsPlaywrightCacheTouched: false },
  };
  const browserDownloadManifest = {
    playwrightVersion: versions.playwright,
    archives: [shellArchiveEvidence, ffmpegArchiveEvidence],
  };
  await Promise.all([writeJson(browserEvidencePath, browserEvidence), writeJson(browserDownloadManifestPath, browserDownloadManifest)]);

  const winlddProvenancePath = path.join(winlddRoot, 'provenance.json');
  await writeJson(winlddProvenancePath, {
    playwrightCore: { version: versions.playwrightCore, browserPins: { ffmpeg: '1011', winldd: '1007' } },
    winlddDownload: {
      requestedUrl: winlddUrl,
      finalUrl: 'https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/winldd/1007/winldd-win64.zip',
      bytes: winlddZip.length, sha256: sha256(winlddZip),
    },
  });

  const shellSource = path.join(root, 'shell-source');
  await mkdir(path.join(shellSource, 'locales'), { recursive: true });
  for (const [name, bytes] of Object.entries(shellFiles)) {
    await mkdir(path.dirname(path.join(shellSource, name)), { recursive: true });
    await writeFile(path.join(shellSource, name), bytes);
  }
  const shellPayloadDirectory = path.join(root, 'shell-prepared');
  await preparePlaywrightHeadlessPayload({
    sourceDir: shellSource,
    destinationDir: shellPayloadDirectory,
    expected: {
      target: { platform: 'win32', arch: 'x64' },
      playwrightVersion: versions.playwright,
      browserVersion: '151.0.7922.34', browserRevision: '1234',
    },
    sourceArchiveDeclaration: { url: shellUrl, sha256: sha256(shellZip), sizeBytes: shellZip.length },
  });
  const options = {
    repositoryRoot,
    shellPayloadDirectory,
    javascriptProvenancePath,
    javascriptArchives: {
      playwright: path.join(sourceRoot, `playwright-${versions.playwright}.tgz`),
      playwrightCore: path.join(sourceRoot, `playwright-core-${versions.playwrightCore}.tgz`),
      pngjs: path.join(sourceRoot, `pngjs-${versions.pngjs}.tgz`),
    },
    browserEvidencePath,
    browserDownloadManifestPath,
    ffmpegArchive,
    winlddProvenancePath,
    winlddArchive,
    destinationDirectory: path.join(root, 'runtime-payload'),
  };
  return { root, repositoryRoot, shellPayloadDirectory, shellSource, browserRoot, winlddRoot, options, browserEvidencePath, browserDownloadManifestPath, ffmpegArchive };
}

async function prepare(f, overrides = {}) {
  return preparePlaywrightRuntimePayload({ ...f.options, ...overrides });
}

async function replaceFfmpegProof(f, bytes) {
  await writeFile(f.ffmpegArchive, bytes);
  const evidence = JSON.parse(await readFile(f.browserEvidencePath, 'utf8'));
  const manifest = JSON.parse(await readFile(f.browserDownloadManifestPath, 'utf8'));
  for (const record of [...evidence.archives, ...manifest.archives]) {
    if (record.kind !== 'ffmpeg') continue;
    record.bytes = bytes.length;
    record.contentLength = bytes.length;
    record.sha256 = sha256(bytes);
  }
  await writeJson(f.browserEvidencePath, evidence);
  await writeJson(f.browserDownloadManifestPath, manifest);
}

test('prepares the bounded composite runtime with lock-derived pins, retained notices, and relocatable identity', async t => {
  const f = await fixture(t);
  const inputsBefore = await Promise.all([
    ...Object.values(f.options.javascriptArchives).map(file => readFile(file).then(sha256)),
    readFile(path.join(f.browserRoot, 'chromium-headless-shell-win64.zip')).then(sha256),
    readFile(f.ffmpegArchive).then(sha256),
    readFile(f.options.winlddArchive).then(sha256),
  ]);
  const shellBefore = await listBytes(f.shellPayloadDirectory);
  const prepared = await prepare(f);
  const verified = await validatePlaywrightRuntimePayload({ directory: prepared.directory, repositoryRoot: f.repositoryRoot });
  const manifestText = await readFile(path.join(prepared.directory, PLAYWRIGHT_RUNTIME_PAYLOAD_MANIFEST), 'utf8');
  const manifest = JSON.parse(manifestText);

  assert.equal(prepared.identity, verified.identity);
  assert.equal(prepared.identity, manifest.payloadIdentity);
  assert.equal(manifestText, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'playwright-windows-headless-runtime');
  assert.deepEqual(manifest.target, { platform: 'win32', arch: 'x64' });
  assert.deepEqual(manifest.pins, {
    playwright: '1.62.1', playwrightCore: '1.62.1', pngjs: '7.0.0',
    chromiumHeadlessShell: { revision: '1234', browserVersion: '151.0.7922.34' },
    ffmpeg: '1011', winldd: '1007',
  });
  assert.ok(manifest.inventory.some(item => item.relativePath === 'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/LICENSE.headless_shell'));
  assert.ok(manifest.inventory.some(item => item.relativePath === 'browsers/ffmpeg-1011/COPYING.LGPLv2.1'));
  assert.ok(manifest.inventory.some(item => item.relativePath === 'node_modules/playwright/NOTICE'));
  assert.ok(manifest.inventory.some(item => item.relativePath === 'node_modules/playwright-core/ThirdPartyNotices.txt'));
  assert.ok(manifest.inventory.some(item => item.relativePath === 'node_modules/playwright-core/NOTICE'));
  assert.ok(manifest.inventory.some(item => item.relativePath === 'browsers/winldd-1007/PrintDeps.exe'));
  const copiedPlaywrightManifest = JSON.parse(await readFile(path.join(prepared.directory, 'node_modules/playwright/package.json'), 'utf8'));
  assert.equal(copiedPlaywrightManifest.scripts.postinstall, 'throw new Error("must not run")', 'package lifecycle declarations are copied but never executed');
  assert.equal(manifest.archiveProvenance.length, 6);
  assert.ok(manifest.archiveProvenance.every(item => item.verification === 'local-content-hash-match'
    && item.subject === 'archive-bytes-only' && item.attestation === 'none'));
  assert.ok(manifest.inventory.every(item => item.relativePath === item.relativePath.replaceAll('\\', '/')));
  const postInputs = await Promise.all([
    ...Object.values(f.options.javascriptArchives).map(file => readFile(file).then(sha256)),
    readFile(path.join(f.browserRoot, 'chromium-headless-shell-win64.zip')).then(sha256),
    readFile(f.ffmpegArchive).then(sha256),
    readFile(f.options.winlddArchive).then(sha256),
  ]);
  assert.deepEqual(postInputs, inputsBefore, 'archive inputs remain untouched');
  assert.deepEqual(await listBytes(f.shellPayloadDirectory), shellBefore, 'prepared shell input remains untouched');

  const relocated = path.join(f.root, 'relocated', 'payload');
  await mkdir(path.dirname(relocated));
  await cp(prepared.directory, relocated, { recursive: true, errorOnExist: true, force: false });
  const moved = await validatePlaywrightRuntimePayload({ directory: relocated, repositoryRoot: f.repositoryRoot });
  assert.equal(moved.identity, prepared.identity);
  assert.deepEqual(await listBytes(prepared.directory), await listBytes(relocated));
  await assert.rejects(prepare(f), /already exists|destinationDirectory/iu);
});

test('rejects untrusted pins, malformed metadata, and overlapping or non-absolute destinations', async t => {
  const f = await fixture(t);
  await assert.rejects(prepare(f, { pins: { playwright: '999.0.0' } }), /unsupported shape/u);
  await assert.rejects(prepare(f, { destinationDirectory: 'relative-output' }), /explicit absolute path/u);
  await assert.rejects(
    prepare(f, { destinationDirectory: path.join(f.shellPayloadDirectory, 'nested-output') }),
    /must not overlap/u,
  );
  await assert.rejects(validatePlaywrightRuntimePayload({ directory: f.root, repositoryRoot: f.repositoryRoot, pins: {} }), /unsupported shape/u);
});

test('detects payload mutation, extra files, and browser pin drift', async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  const shell = path.join(prepared.directory, 'browsers/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe');
  await writeFile(shell, 'tampered');
  await assert.rejects(validatePlaywrightRuntimePayload({ directory: prepared.directory, repositoryRoot: f.repositoryRoot }), /missing, extra, or mutated/u);

  const second = await fixture(t);
  const good = await prepare(second);
  await writeFile(path.join(good.directory, 'surprise.bin'), 'extra');
  await assert.rejects(validatePlaywrightRuntimePayload({ directory: good.directory, repositoryRoot: second.repositoryRoot }), /missing or extra entries|missing, extra, or mutated/u);

  const third = await fixture(t);
  const pinPayload = await prepare(third);
  const browsersFile = path.join(pinPayload.directory, 'node_modules/playwright-core/browsers.json');
  const browsers = JSON.parse(await readFile(browsersFile, 'utf8'));
  browsers.browsers.find(item => item.name === 'chromium-headless-shell').revision = 4321;
  await writeFile(browsersFile, JSON.stringify(browsers));
  await assert.rejects(validatePlaywrightRuntimePayload({ directory: pinPayload.directory, repositoryRoot: third.repositoryRoot }), /manifest pins do not match/u);
});

test('rejects unsafe ZIP paths, case-collisions, and advertised over-limit entries before committing output', async t => {
  for (const [label, entries, pattern] of [
    ['traversal', [{ name: '../escape.exe', bytes: 'x' }], /unsafe Windows path segment/u],
    ['case-collision', [
      { name: 'ffmpeg-win64.exe', bytes: 'x' }, { name: 'FFMPEG-WIN64.EXE', bytes: 'y' },
      { name: 'COPYING.LGPLv2.1', bytes: 'notice' },
    ], /conflicting or case-colliding/u],
    ['size-bound', [
      { name: 'ffmpeg-win64.exe', bytes: 'x', declaredSize: 512 * 1024 * 1024 + 1 },
      { name: 'COPYING.LGPLv2.1', bytes: 'notice' },
    ], /unsupported flags, compression, size/u],
  ]) {
    const f = await fixture(t);
    await replaceFfmpegProof(f, makeZip(entries));
    const destinationDirectory = path.join(f.root, `output-${label}`);
    await assert.rejects(prepare(f, { destinationDirectory }), pattern);
    await assert.rejects(lstat(destinationDirectory), { code: 'ENOENT' });
  }
});

test('rejects mismatched lock integrity and archive declaration size without changing sources', async t => {
  const f = await fixture(t);
  const lockPath = path.join(f.repositoryRoot, 'pnpm-lock.yaml');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const fakeIntegrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  lock.packages['playwright@1.62.1'].resolution.integrity = fakeIntegrity;
  await writeJson(lockPath, lock);
  const provenance = JSON.parse(await readFile(f.options.javascriptProvenancePath, 'utf8'));
  provenance.source.lockIntegrities.find(item => item.name === 'playwright').integrity = fakeIntegrity;
  const playwrightDeclaration = provenance.packages.find(item => item.name === 'playwright');
  playwrightDeclaration.registryIntegrity = fakeIntegrity;
  playwrightDeclaration.lockIntegrity = fakeIntegrity;
  playwrightDeclaration.verifiedIntegrity = fakeIntegrity;
  await writeJson(f.options.javascriptProvenancePath, provenance);
  const before = await readFile(f.options.javascriptArchives.playwright);
  await assert.rejects(prepare(f), /checked-in lock integrity/u);
  assert.deepEqual(await readFile(f.options.javascriptArchives.playwright), before);
});

test('rejects symlinked archives and malformed caller-selected archive entries', async t => {
  const f = await fixture(t);
  const archive = f.options.javascriptArchives.playwright;
  const link = path.join(f.root, 'playwright-link.tgz');
  try { await symlink(archive, link, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Platform did not permit a synthetic symlink: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(prepare(f, { javascriptArchives: { ...f.options.javascriptArchives, playwright: link } }), /symbolic link/u);
});
