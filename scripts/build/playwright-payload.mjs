import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PLAYWRIGHT_HEADLESS_PAYLOAD_SCHEMA_VERSION = 1;
export const PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST = 'manifest.json';
export const PLAYWRIGHT_HEADLESS_PAYLOAD_TREE = 'headless-shell';
export const PLAYWRIGHT_HEADLESS_EXECUTABLE = `${PLAYWRIGHT_HEADLESS_PAYLOAD_TREE}/chrome-headless-shell.exe`;
export const PLAYWRIGHT_HEADLESS_ABOUT = `${PLAYWRIGHT_HEADLESS_PAYLOAD_TREE}/ABOUT`;
export const PLAYWRIGHT_HEADLESS_LICENSE = `${PLAYWRIGHT_HEADLESS_PAYLOAD_TREE}/LICENSE.headless_shell`;

const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/u;
const REVISION_PATTERN = /^\d+$/u;
const UNSAFE_WINDOWS_CHARS = /[<>:"|?*\\/\u0000-\u001f]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const FORBIDDEN_NON_SHELL_FILES = new Set([
  'chrome.exe', 'chrome.dll', 'chrome_elf.dll', 'chrome_proxy.exe',
  'ffmpeg.exe', 'ffmpeg-win64.exe',
]);

function fail(message) {
  throw new Error(`Playwright headless payload: ${message}`);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has an unsupported shape.`);
  }
}

function assertVersion(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) fail(`${label} must be an explicit version string.`);
}

function normalizeExpected(expected) {
  assertExactKeys(expected, ['target', 'playwrightVersion', 'browserVersion', 'browserRevision'], 'Trusted build-owner contract');
  assertExactKeys(expected.target, ['platform', 'arch'], 'Trusted target');
  if (expected.target.platform !== 'win32' || expected.target.arch !== 'x64') {
    fail('only the explicitly selected win32/x64 headless-shell target is supported.');
  }
  assertVersion(expected.playwrightVersion, 'Playwright version');
  assertVersion(expected.browserVersion, 'Browser version');
  if (typeof expected.browserRevision !== 'string' || !REVISION_PATTERN.test(expected.browserRevision)) {
    fail('browser revision must be an explicit numeric string.');
  }
  return {
    target: { platform: 'win32', arch: 'x64' },
    pins: {
      playwrightVersion: expected.playwrightVersion,
      browserVersion: expected.browserVersion,
      browserRevision: expected.browserRevision,
    },
  };
}

function validateRelativePath(relativePath, label = 'relative path') {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')
    || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    fail(`${label} is not a safe canonical relative path.`);
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..'
    || UNSAFE_WINDOWS_CHARS.test(segment) || segment.endsWith('.') || segment.endsWith(' ')
    || WINDOWS_RESERVED_NAME.test(segment))) {
    fail(`${label} contains an unsafe path segment.`);
  }
  if (segments[0] !== PLAYWRIGHT_HEADLESS_PAYLOAD_TREE || segments.length < 2) {
    fail(`${label} must be beneath ${PLAYWRIGHT_HEADLESS_PAYLOAD_TREE}/.`);
  }
  return relativePath;
}

function assertMandatoryFiles(files) {
  const present = new Set(files.map(file => file.relativePath));
  for (const required of [PLAYWRIGHT_HEADLESS_EXECUTABLE, PLAYWRIGHT_HEADLESS_ABOUT, PLAYWRIGHT_HEADLESS_LICENSE]) {
    if (!present.has(required)) fail(`required headless-shell entry is missing: ${required}`);
  }
  for (const required of [PLAYWRIGHT_HEADLESS_EXECUTABLE, PLAYWRIGHT_HEADLESS_ABOUT, PLAYWRIGHT_HEADLESS_LICENSE]) {
    const file = files.find(candidate => candidate.relativePath === required);
    if (file.sizeBytes === 0) fail(`required headless-shell entry is empty: ${required}`);
  }
}

function normalizeSourceArchiveDeclaration(declaration) {
  if (declaration === undefined) return undefined;
  assertExactKeys(declaration, ['url', 'sha256', 'sizeBytes'], 'Source archive declaration');
  let url;
  try {
    url = new URL(declaration.url);
  } catch {
    fail('source archive declaration URL is invalid.');
  }
  if (url.protocol !== 'https:' || !url.hostname) fail('source archive declaration must use HTTPS.');
  if (typeof declaration.sha256 !== 'string' || !SHA256_PATTERN.test(declaration.sha256)) {
    fail('source archive declaration SHA-256 must be lowercase hexadecimal.');
  }
  if (!Number.isSafeInteger(declaration.sizeBytes) || declaration.sizeBytes < 1) {
    fail('source archive declaration size must be a positive safe integer.');
  }
  // This is deliberately metadata only; this primitive does not assert that
  // the declared archive was the source of the selected tree.
  return {
    url: url.href,
    sha256: declaration.sha256,
    sizeBytes: declaration.sizeBytes,
    verification: 'declaration-only',
  };
}

function identityFields(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    target: { platform: manifest.target.platform, arch: manifest.target.arch },
    pins: {
      playwrightVersion: manifest.pins.playwrightVersion,
      browserVersion: manifest.pins.browserVersion,
      browserRevision: manifest.pins.browserRevision,
    },
    executableRelativePath: manifest.executableRelativePath,
    notices: {
      aboutRelativePath: manifest.notices.aboutRelativePath,
      licenseRelativePath: manifest.notices.licenseRelativePath,
    },
    files: manifest.files.map(file => ({
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
  };
}

function payloadIdentity(manifest) {
  return createHash('sha256').update(JSON.stringify(identityFields(manifest))).digest('hex');
}

function canonicalManifest(manifest) {
  const canonical = {
    ...identityFields(manifest),
    ...(manifest.sourceArchiveDeclaration === undefined ? {} : {
      sourceArchiveDeclaration: {
        url: manifest.sourceArchiveDeclaration.url,
        sha256: manifest.sourceArchiveDeclaration.sha256,
        sizeBytes: manifest.sourceArchiveDeclaration.sizeBytes,
        verification: manifest.sourceArchiveDeclaration.verification,
      },
    }),
    payloadIdentity: manifest.payloadIdentity,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an explicit absolute path.`);
  return path.resolve(value);
}

async function lstatIfExists(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function canonicalPaths(sourceDir, destinationDir) {
  const sourcePath = assertAbsolutePath(sourceDir, 'sourceDir');
  const destinationPath = assertAbsolutePath(destinationDir, 'destinationDir');
  const [sourceStat, destinationStat, sourceCanonical, destinationParentStat] = await Promise.all([
    lstat(sourcePath),
    lstatIfExists(destinationPath),
    realpath(sourcePath),
    lstat(path.dirname(destinationPath)),
  ]);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) fail('sourceDir must be a real directory, not a symlink or special entry.');
  if (destinationStat) fail('destinationDir already exists; immutable payload destinations are never overwritten.');
  if (destinationParentStat.isSymbolicLink() || !destinationParentStat.isDirectory()) {
    fail('destinationDir parent must be an existing real directory.');
  }
  const destinationCanonical = path.join(await realpath(path.dirname(destinationPath)), path.basename(destinationPath));
  if (within(sourceCanonical, destinationCanonical) || within(destinationCanonical, sourceCanonical)) {
    fail('sourceDir and destinationDir must not overlap.');
  }
  return { sourcePath, destinationPath, sourceCanonical, destinationCanonical };
}

function comparableStat(info) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

async function readAndHashFile(filePath, expectedStat, outputPath, { collectBytes = false } = {}) {
  let input;
  let output;
  const hash = createHash('sha256');
  const chunks = collectBytes ? [] : undefined;
  let sizeBytes = 0;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    input = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const openedStat = await input.stat();
    if (!openedStat.isFile() || comparableStat(openedStat) !== comparableStat(expectedStat)) {
      fail(`file changed or is not regular: ${filePath}`);
    }
    if (outputPath) output = await open(outputPath, 'wx', 0o644);
    const stream = input.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      sizeBytes += chunk.length;
      if (sizeBytes > MAX_FILE_BYTES) fail(`file exceeds the ${MAX_FILE_BYTES}-byte per-file bound: ${filePath}`);
      hash.update(chunk);
      chunks?.push(chunk);
      if (output) {
        let offset = 0;
        while (offset < chunk.length) {
          const result = await output.write(chunk, offset, chunk.length - offset, null);
          offset += result.bytesWritten;
        }
      }
    }
    const finishedStat = await input.stat();
    const pathStat = await lstat(filePath);
    if (!finishedStat.isFile() || !pathStat.isFile()
      || comparableStat(finishedStat) !== comparableStat(expectedStat)
      || comparableStat(pathStat) !== comparableStat(expectedStat)
      || sizeBytes !== expectedStat.size) {
      fail(`file changed while being read: ${filePath}`);
    }
    if (output) await output.sync();
  } finally {
    await Promise.allSettled([input?.close(), output?.close()].filter(Boolean));
  }
  return {
    sizeBytes,
    sha256: hash.digest('hex'),
    ...(chunks ? { bytes: Buffer.concat(chunks, sizeBytes) } : {}),
  };
}

async function scanTree(treeRoot, { copyInto } = {}) {
  const rootStat = await lstat(treeRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(`payload tree is not a real directory: ${treeRoot}`);
  const files = [];
  const directories = [];
  let totalBytes = 0;

  async function visit(directory, relativeDirectory) {
    const directoryBefore = await lstat(directory);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) fail(`directory changed or is not regular: ${directory}`);
    const names = await readdir(directory);
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      validateRelativePath(`${PLAYWRIGHT_HEADLESS_PAYLOAD_TREE}/${relativePath}`, 'tree entry path');
      const absolutePath = path.join(directory, name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) fail(`symbolic links are forbidden: ${absolutePath}`);
      if (info.isDirectory()) {
        directories.push(relativePath);
        if (copyInto) await mkdir(path.join(copyInto, relativePath), { recursive: true });
        await visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_FILE_BYTES) {
          fail(`file has an invalid or over-limit size: ${absolutePath}`);
        }
        if (files.length >= MAX_FILES) fail(`tree exceeds the ${MAX_FILES}-file bound.`);
        totalBytes += info.size;
        if (totalBytes > MAX_TOTAL_BYTES) fail(`tree exceeds the ${MAX_TOTAL_BYTES}-byte total bound.`);
        if (FORBIDDEN_NON_SHELL_FILES.has(name.toLowerCase())) {
          fail(`non-headless browser or ffmpeg entry is not part of this payload: ${relativePath}`);
        }
        const destination = copyInto ? path.join(copyInto, relativePath) : undefined;
        const digest = await readAndHashFile(absolutePath, info, destination);
        files.push({
          relativePath: `${PLAYWRIGHT_HEADLESS_PAYLOAD_TREE}/${relativePath}`,
          sizeBytes: digest.sizeBytes,
          sha256: digest.sha256,
        });
      } else {
        fail(`special files are forbidden: ${absolutePath}`);
      }
    }
    const directoryAfter = await lstat(directory);
    if (comparableStat(directoryAfter) !== comparableStat(directoryBefore)) {
      fail(`directory changed while being inventoried: ${directory}`);
    }
  }

  await visit(treeRoot, '');
  files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const foldedPaths = new Set();
  for (const file of files) {
    const folded = file.relativePath.toLocaleLowerCase('en-US');
    if (foldedPaths.has(folded)) fail(`case-colliding paths are not safe for win32/x64: ${file.relativePath}`);
    foldedPaths.add(folded);
  }
  for (const directory of directories) {
    if (!files.some(file => file.relativePath.startsWith(`${PLAYWRIGHT_HEADLESS_PAYLOAD_TREE}/${directory}/`))) {
      fail(`empty directories are not part of the canonical file payload: ${directory}`);
    }
  }
  assertMandatoryFiles(files);
  return files;
}

function parseManifest(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error('Playwright headless payload: manifest.json is not valid JSON.', { cause: error });
  }
  assertExactKeys(manifest, [
    'schemaVersion', 'kind', 'target', 'pins', 'executableRelativePath', 'notices', 'files', 'payloadIdentity',
    ...(Object.hasOwn(manifest, 'sourceArchiveDeclaration') ? ['sourceArchiveDeclaration'] : []),
  ], 'Manifest');
  assertExactKeys(manifest.target, ['platform', 'arch'], 'Manifest target');
  assertExactKeys(manifest.pins, ['playwrightVersion', 'browserVersion', 'browserRevision'], 'Manifest pins');
  assertExactKeys(manifest.notices, ['aboutRelativePath', 'licenseRelativePath'], 'Manifest notices');
  if (manifest.schemaVersion !== PLAYWRIGHT_HEADLESS_PAYLOAD_SCHEMA_VERSION || manifest.kind !== 'playwright-headless-shell') {
    fail('manifest schema or payload kind is unsupported.');
  }
  if (manifest.target.platform !== 'win32' || manifest.target.arch !== 'x64') fail('manifest target is not win32/x64.');
  assertVersion(manifest.pins.playwrightVersion, 'Manifest Playwright version');
  assertVersion(manifest.pins.browserVersion, 'Manifest browser version');
  if (typeof manifest.pins.browserRevision !== 'string' || !REVISION_PATTERN.test(manifest.pins.browserRevision)) {
    fail('manifest browser revision is invalid.');
  }
  if (manifest.executableRelativePath !== PLAYWRIGHT_HEADLESS_EXECUTABLE) fail('manifest executable path is not canonical.');
  if (manifest.notices.aboutRelativePath !== PLAYWRIGHT_HEADLESS_ABOUT
    || manifest.notices.licenseRelativePath !== PLAYWRIGHT_HEADLESS_LICENSE) fail('manifest notice paths are not canonical.');
  if (!Array.isArray(manifest.files) || manifest.files.length < 3 || manifest.files.length > MAX_FILES) {
    fail('manifest file inventory is empty or exceeds its bound.');
  }
  let totalBytes = 0;
  let priorPath;
  const foldedPaths = new Set();
  for (const entry of manifest.files) {
    assertExactKeys(entry, ['relativePath', 'sizeBytes', 'sha256'], 'Manifest file entry');
    validateRelativePath(entry.relativePath, 'manifest file path');
    if (priorPath !== undefined && priorPath >= entry.relativePath) fail('manifest file inventory is not uniquely sorted.');
    priorPath = entry.relativePath;
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > MAX_FILE_BYTES
      || typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      fail(`manifest file entry is invalid: ${entry.relativePath}`);
    }
    totalBytes += entry.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail('manifest inventory exceeds the total byte bound.');
    const folded = entry.relativePath.toLocaleLowerCase('en-US');
    if (foldedPaths.has(folded)) fail(`manifest contains case-colliding paths: ${entry.relativePath}`);
    foldedPaths.add(folded);
  }
  assertMandatoryFiles(manifest.files);
  if (Object.hasOwn(manifest, 'sourceArchiveDeclaration')) {
    const declaration = manifest.sourceArchiveDeclaration;
    assertExactKeys(declaration, ['url', 'sha256', 'sizeBytes', 'verification'], 'Source archive declaration');
    const normalized = normalizeSourceArchiveDeclaration({ url: declaration.url, sha256: declaration.sha256, sizeBytes: declaration.sizeBytes });
    if (declaration.verification !== 'declaration-only' || JSON.stringify(normalized) !== JSON.stringify(declaration)) {
      fail('source archive metadata must remain explicitly declaration-only.');
    }
  }
  if (typeof manifest.payloadIdentity !== 'string' || !SHA256_PATTERN.test(manifest.payloadIdentity)
    || payloadIdentity(manifest) !== manifest.payloadIdentity) {
    fail('payload identity does not match the canonical content inventory.');
  }
  if (canonicalManifest(manifest) !== source) fail('manifest.json is not in canonical serialized form.');
  return manifest;
}

function assertExpected(manifest, expected) {
  const normalized = normalizeExpected(expected);
  if (JSON.stringify(manifest.target) !== JSON.stringify(normalized.target)) fail('manifest target does not match the trusted build-owner contract.');
  if (JSON.stringify(manifest.pins) !== JSON.stringify(normalized.pins)) fail('manifest version pins do not match the trusted build-owner contract.');
}

/** Validate one explicit, already-prepared payload without discovery or fallback. */
export async function validatePlaywrightHeadlessPayload({ directory, expected }) {
  const root = assertAbsolutePath(directory, 'directory');
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('payload directory must be a real directory.');
  const manifestPath = path.join(root, PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST);
  const manifestStat = await lstat(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    fail('manifest.json must be a regular file, not a symlink or special entry.');
  }
  const { bytes: manifestBytes } = await readAndHashFile(manifestPath, manifestStat, undefined, { collectBytes: true });
  const manifest = parseManifest(manifestBytes.toString('utf8'));
  assertExpected(manifest, expected);

  const entries = await readdir(root);
  entries.sort();
  if (entries.join('\0') !== [PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE].sort().join('\0')) {
    fail('payload root contains missing or extra entries.');
  }
  const actualFiles = await scanTree(path.join(root, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE));
  if (actualFiles.length !== manifest.files.length) fail('payload tree has missing or extra files.');
  for (let index = 0; index < actualFiles.length; index += 1) {
    if (JSON.stringify(actualFiles[index]) !== JSON.stringify(manifest.files[index])) {
      fail(`payload file is missing, extra, or mutated: ${manifest.files[index]?.relativePath ?? actualFiles[index].relativePath}`);
    }
  }
  return { directory: root, manifest, identity: manifest.payloadIdentity };
}

/** Copy an explicitly selected shell tree into a new immutable payload directory. */
export async function preparePlaywrightHeadlessPayload({ sourceDir, destinationDir, expected, sourceArchiveDeclaration }) {
  const trusted = normalizeExpected(expected);
  const { sourcePath, destinationPath, destinationCanonical } = await canonicalPaths(sourceDir, destinationDir);
  const stagingPath = path.join(path.dirname(destinationCanonical), `.${path.basename(destinationCanonical)}.staging-${randomUUID()}`);
  const stagingRootStat = await lstatIfExists(stagingPath);
  if (stagingRootStat) fail('private staging path unexpectedly already exists.');
  await mkdir(stagingPath);
  try {
    const treeDestination = path.join(stagingPath, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE);
    await mkdir(treeDestination);
    const files = await scanTree(sourcePath, { copyInto: treeDestination });
    const manifest = {
      schemaVersion: PLAYWRIGHT_HEADLESS_PAYLOAD_SCHEMA_VERSION,
      kind: 'playwright-headless-shell',
      target: trusted.target,
      pins: trusted.pins,
      executableRelativePath: PLAYWRIGHT_HEADLESS_EXECUTABLE,
      notices: {
        aboutRelativePath: PLAYWRIGHT_HEADLESS_ABOUT,
        licenseRelativePath: PLAYWRIGHT_HEADLESS_LICENSE,
      },
      files,
      ...(sourceArchiveDeclaration === undefined ? {} : {
        sourceArchiveDeclaration: normalizeSourceArchiveDeclaration(sourceArchiveDeclaration),
      }),
      payloadIdentity: '',
    };
    manifest.payloadIdentity = payloadIdentity(manifest);
    await writeFile(path.join(stagingPath, PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST), canonicalManifest(manifest), { flag: 'wx' });
    await validatePlaywrightHeadlessPayload({ directory: stagingPath, expected });
    if (await lstatIfExists(destinationPath)) {
      fail('destinationDir appeared during preparation; immutable payload destinations are never overwritten.');
    }
    await rename(stagingPath, destinationCanonical);
    return { directory: destinationCanonical, manifest, identity: manifest.payloadIdentity };
  } finally {
    // A successful rename moved the exclusively owned staging directory.
    if (await lstatIfExists(stagingPath)) await rm(stagingPath, { recursive: true, force: true });
  }
}
