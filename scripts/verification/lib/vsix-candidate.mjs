import { createHash } from 'node:crypto';
import { constants, createReadStream, read } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createOwnerRequire } from '../../lib/package-resolution.mjs';
import { verifyPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';
import { verifyManagedIntegrationQualification } from '../managed-qualification-receipt.mjs';
import { verifyBundledManagedOutput } from '../../build/bundled-managed-resources.mjs';
import { verifyBundledExtensionOutput } from '../../build/bundled-extension-verification.mjs';
import { BUNDLED_MANAGED_ROOT_RELATIVE_PATH } from '../../../lib/managed-packages/bundled-resources.mjs';

/** Fingerprint one ordinary file without following a final-component symlink. */
export async function fingerprintCandidate(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Candidate must be a regular nonsymlink file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Candidate changed while opening');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
    }
    const after = await handle.stat();
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error('Candidate changed while fingerprinting');
    }
    return { sha256: hash.digest('hex'), size };
  } finally {
    await handle.close();
  }
}

function entryPath(entry) {
  const name = entry.fileName;
  if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')) throw new Error(`Unsafe VSIX path: ${name}`);
  const directory = name.endsWith('/');
  const parts = (directory ? name.slice(0, -1) : name).split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[:<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error(`Unsafe VSIX path: ${name}`);
  }
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  if (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) throw new Error(`Nonregular VSIX entry: ${name}`);
  if (!directory && (entry.externalFileAttributes & 0x10)) throw new Error(`Invalid VSIX directory: ${name}`);
  return { parts, directory };
}

const MAX_CONTAINER_XML_BYTES = 1024 * 1024;

function one(values, label) {
  if (!Array.isArray(values) || values.length !== 1) throw new Error(`Invalid VSIX container: expected exactly one ${label}`);
  return values[0];
}

async function parseContainer(manifestXml, contentTypesXml, parseStringPromise) {
  for (const xml of [manifestXml, contentTypesXml]) {
    if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid VSIX container XML');
  }
  const options = { explicitArray: true, strict: true, attrkey: '$', charkey: '_' };
  const manifest = (await parseStringPromise(manifestXml, options)).PackageManifest;
  const types = (await parseStringPromise(contentTypesXml, options)).Types;
  if (!manifest || manifest.$?.xmlns !== 'http://schemas.microsoft.com/developer/vsx-schema/2011'
    || !types || types.$?.xmlns !== 'http://schemas.openxmlformats.org/package/2006/content-types') {
    throw new Error('Invalid VSIX container XML roots');
  }
  const identity = one(one(manifest.Metadata, 'Metadata').Identity, 'Identity').$;
  const installation = one(manifest.Installation, 'Installation');
  const targets = installation.InstallationTarget;
  if (!Array.isArray(targets) || targets.length !== 1 || targets[0].$?.Id !== 'Microsoft.VisualStudio.Code') {
    throw new Error('Invalid VSIX container InstallationTarget');
  }
  const assets = one(manifest.Assets, 'Assets').Asset;
  const packageAssets = assets?.filter((asset) => asset.$?.Type === 'Microsoft.VisualStudio.Code.Manifest');
  if (one(packageAssets, 'package manifest asset').$?.Path !== 'extension/package.json') {
    throw new Error('Invalid VSIX container package manifest asset');
  }
  for (const key of ['Id', 'Publisher', 'Version', 'TargetPlatform']) {
    if (typeof identity?.[key] !== 'string' || !identity[key].trim()) throw new Error(`Invalid VSIX container Identity.${key}`);
  }
  return { extensionId: `${identity.Publisher}.${identity.Id}`, version: identity.Version, target: identity.TargetPlatform };
}

/** Map a verified native runtime target to an explicit VS Code target (never universal). */
export function runtimeTargetPlatform(target) {
  const mappings = {
    'win32-x64': 'win32-x64', 'win32-arm64': 'win32-arm64',
    'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64', 'linux-arm': 'linux-armhf',
    'darwin-x64': 'darwin-x64', 'darwin-arm64': 'darwin-arm64',
    'alpine-x64': 'alpine-x64', 'alpine-arm64': 'alpine-arm64',
  };
  const value = mappings[`${target?.platform}-${target?.arch}`];
  if (!value) throw new Error('Unsupported candidate runtime target');
  return value;
}

/** Compare parsed container metadata with the independently verified payload identity. */
export function validateCandidateContainer(container, identity) {
  for (const field of ['extensionId', 'version', 'target']) {
    if (typeof container?.[field] !== 'string' || !container[field] || container[field] !== identity?.[field]) {
      throw new Error(`VSIX container ${field} mismatch`);
    }
  }
}

/** Validate every ZIP entry; extract only extension/ and return container metadata without writing it. */
export async function extractCandidate(file, destination) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Candidate must be a regular nonsymlink file');
  await mkdir(destination, { recursive: true });
  const destinationStat = await lstat(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink() || (await readdir(destination)).length) {
    throw new Error('Extraction destination must be an empty nonsymlink directory');
  }
  const root = await realpath(destination);
  const ownerRequire = createOwnerRequire();
  const vsceRequire = createRequire(ownerRequire.resolve('@vscode/vsce/package.json'));
  const yauzl = vsceRequire('yauzl');
  const { parseStringPromise } = vsceRequire('xml2js');
  const containerXml = new Map();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let closing;
  const close = () => closing ??= handle.close();
  const reader = new yauzl.RandomAccessReader();
  // Installed yauzl's legacy fd-slicer marks its stream destroyed at EOF,
  // suppressing completion under backpressure on large DEFLATE entries.
  // Native range streams retain descriptor ownership here; yauzl still applies
  // its range byte counters and all ZIP/entry-size validation.
  reader._readStreamForRange = (start, end) => createReadStream(file, {
    fd: handle.fd, start, end: end - 1, autoClose: false,
    // yauzl explicitly destroys completed ranges; native destroy calls close
    // even with autoClose:false. Only the reader may close the shared fd.
    fs: { read, close: (_fd, callback) => callback(null) },
  });
  reader.read = (buffer, offset, length, position, callback) => read(handle.fd, buffer, offset, length, position, callback);
  reader.close = callback => { close().then(() => callback(), callback); };
  let zip;
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) throw new Error('Candidate changed while opening');
    zip = await new Promise((resolve, reject) => yauzl.fromRandomAccessReader(reader, openedStat.size, {
      lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false,
    }, (error, value) => error ? reject(error) : resolve(value)));
  } catch (error) {
    await close();
    throw error;
  }
  const entries = new Set();
  const nodes = new Map();
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        (async () => {
          const { parts, directory } = entryPath(entry);
          const name = parts.join('/');
          const key = name.toLowerCase();
          if (entries.has(key)) throw new Error(`Duplicate VSIX path: ${name}`);
          entries.add(key);
          for (let i = 1; i <= parts.length; i++) {
            const prefix = parts.slice(0, i).join('/');
            const kind = i < parts.length || directory ? 'directory' : 'file';
            const previous = nodes.get(prefix.toLowerCase());
            if (previous && (previous.name !== prefix || previous.kind !== kind)) throw new Error(`Conflicting VSIX path: ${name}`);
            nodes.set(prefix.toLowerCase(), { name: prefix, kind });
          }
          if (!directory && (name === 'extension.vsixmanifest' || name === '[Content_Types].xml')) {
            if (entry.uncompressedSize > MAX_CONTAINER_XML_BYTES) throw new Error('VSIX container XML is too large');
            const input = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry,
              (error, stream) => error ? rejectStream(error) : resolveStream(stream)));
            const chunks = [];
            let size = 0;
            for await (const chunk of input) {
              size += chunk.length;
              if (size > MAX_CONTAINER_XML_BYTES) throw new Error('VSIX container XML is too large');
              chunks.push(chunk);
            }
            containerXml.set(name, Buffer.concat(chunks).toString('utf8'));
          }
          if (parts[0] === 'extension' && parts.length > 1) {
            const target = path.join(root, ...parts.slice(1));
            if (directory) await mkdir(target, { recursive: true });
            else {
              await mkdir(path.dirname(target), { recursive: true });
              const input = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry,
                (error, stream) => error ? rejectStream(error) : resolveStream(stream)));
              const output = await open(target, 'wx');
              try {
                await pipeline(input, output.createWriteStream());
              } finally {
                await output.close();
              }
            }
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally {
    try { zip.close(); }
    finally { await close(); }
  }
  if (nodes.get('extension/package.json')?.name !== 'extension/package.json'
    || nodes.get('extension/package.json')?.kind !== 'file') throw new Error('Missing VSIX extension/package.json');
  return parseContainer(containerXml.get('extension.vsixmanifest'), containerXml.get('[Content_Types].xml'), parseStringPromise);
}

/** Verify the extracted extension and return only its release identity. */
export async function verifyCandidateIdentity(destination, { managedIntegration } = {}, deps = {}) {
  const pkg = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'));
  if (pkg.publisher !== 'pie' || pkg.name !== 'pie' || pkg.main !== './runtime/bootstrap.cjs'
    || typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error('Invalid candidate package identity');
  const buildId = (await readFile(path.join(destination, 'out/pie-build-id.txt'), 'utf8')).trim();
  const panelBuildId = (await readFile(path.join(destination, 'out/webview/panel/pie-build-id.txt'), 'utf8')).trim();
  if (!/^[a-f0-9]{20}$/.test(buildId) || panelBuildId !== buildId) throw new Error('Candidate build IDs must be matching 20-hex identifiers');
  const outDir = path.join(destination, 'out');
  const artifactDir = path.join(outDir, 'pi-runtime');
  const runtime = await (deps.verifyPiRuntimeArtifact ?? verifyPiRuntimeArtifact)(artifactDir);
  let managedPresent = false;
  try { await lstat(path.join(outDir, BUNDLED_MANAGED_ROOT_RELATIVE_PATH)); managedPresent = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let managedBindings;
  if (managedIntegration !== undefined) {
    if (!managedIntegration || ![managedIntegration.stageRoot, managedIntegration.receiptPath].every(value => typeof value === 'string' && path.isAbsolute(value))) {
      throw new Error('Managed candidate requires explicit absolute stageRoot and receiptPath');
    }
    const qualification = await (deps.verifyManagedIntegrationQualification ?? verifyManagedIntegrationQualification)({
      stageRoot: managedIntegration.stageRoot, receiptPath: managedIntegration.receiptPath, artifactDir,
    });
    if (qualification.runtime?.identity !== runtime.identity || !isDeepStrictEqual(qualification.runtime?.manifest?.target, runtime.manifest.target)) {
      throw new Error('Managed qualification runtime identity or target does not match the selected candidate runtime');
    }
    await (deps.verifyBundledManagedOutput ?? verifyBundledManagedOutput)(outDir, qualification);
    await (deps.verifyBundledExtensionOutput ?? verifyBundledExtensionOutput)(outDir, buildId);
    managedBindings = {
      runtimeIdentity: qualification.runtime.identity,
      closureInventorySha256: qualification.stage.receipt.inventorySha256,
      qualificationRecipeSha256: qualification.qualificationRecipeSha256,
    };
  } else if (managedPresent) {
    throw new Error('Managed candidate payload requires explicit stageRoot and receiptPath');
  }
  return { extensionId: 'pie.pie', version: pkg.version, target: runtimeTargetPlatform(runtime.manifest.target), buildId, piRuntimeIdentity: runtime.identity,
    ...(managedBindings ? { managedIntegration: managedBindings } : {}) };
}
