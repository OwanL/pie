import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import {
  PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST,
  PLAYWRIGHT_HEADLESS_PAYLOAD_TREE,
  validatePlaywrightHeadlessPayload,
} from './playwright-payload.mjs';

export const PLAYWRIGHT_RUNTIME_PAYLOAD_MANIFEST = 'manifest.json';
export const PLAYWRIGHT_RUNTIME_PAYLOAD_SCHEMA_VERSION = 1;

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 8192;
const MAX_ARCHIVE_ENTRIES = 8192;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_UNSAFE = /[<>:"|?*\u0000-\u001f]/u;
const PLAYWRIGHT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const NPM_PACKAGES = ['playwright', 'playwright-core', 'pngjs'];
const ARCHIVE_VERIFICATION = 'local-content-hash-match';
const NO_ATTESTATION = 'none';
const WINLDD_NOTICES = 'harness/tools/playwright/licenses/WINLDD-NOTICES.txt';

function fail(message) {
  throw new Error(`Playwright runtime payload: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has an unsupported shape.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)
    || value.split(/[\\/]/u).some(part => part === '.' || part === '..')) {
    fail(`${label} must be an explicit absolute path without traversal.`);
  }
  return path.resolve(value);
}

function validateRelative(relative, label = 'archive path') {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || relative.includes('\\')
    || relative.startsWith('/') || /^[A-Za-z]:/u.test(relative)) fail(`${label} is not a canonical bounded relative path.`);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || WINDOWS_UNSAFE.test(part)
    || part.endsWith('.') || part.endsWith(' ') || WINDOWS_RESERVED.test(part))) {
    fail(`${label} contains an unsafe Windows path segment.`);
  }
  return parts;
}

function normalizeHttpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} is not a valid HTTPS URL.`); }
  if (value.length > 4096 || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    fail(`${label} must be an explicit HTTPS URL without credentials or a fragment.`);
  }
  return url.href;
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digest(bytes, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function compareStat(left, right) {
  return [left.dev, left.ino, left.mode, left.size, left.mtimeMs, left.ctimeMs].join(':')
    === [right.dev, right.ino, right.mode, right.size, right.mtimeMs, right.ctimeMs].join(':');
}

async function assertNoSymlinkPath(candidate, label) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail(`${label} traverses a symbolic link: ${current}`);
    if (current !== absolute && !info.isDirectory()) fail(`${label} has a non-directory parent: ${current}`);
  }
  return absolute;
}

async function lstatIfExists(candidate) {
  try { return await lstat(candidate); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function readStableFile(file, maxBytes, label) {
  await assertNoSymlinkPath(file, label);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size > maxBytes) {
    fail(`${label} must be a regular file within its byte bound.`);
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !compareStat(opened, before)) fail(`${label} changed while opening.`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(file);
    if (!compareStat(after, before) || !compareStat(pathAfter, before) || bytes.length !== before.size) {
      fail(`${label} changed while being read.`);
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function readJson(file, label, maxBytes = MAX_METADATA_BYTES) {
  let source;
  try { source = (await readStableFile(file, maxBytes, label)).toString('utf8'); }
  catch (error) { throw error; }
  try { return JSON.parse(source); }
  catch (error) { throw new Error(`Playwright runtime payload: ${label} is not valid JSON.`, { cause: error }); }
}

function integrityTokens(integrity) {
  if (typeof integrity !== 'string' || !integrity.trim()) fail('lock integrity is missing.');
  const tokens = integrity.trim().split(/\s+/u);
  if (!tokens.some(token => SHA512_SRI.test(token))) fail('lock integrity must include a SHA-512 SRI digest.');
  return tokens;
}

async function readOwnerLock(repositoryRoot) {
  const root = assertAbsolute(repositoryRoot, 'repositoryRoot');
  await assertNoSymlinkPath(root, 'repositoryRoot');
  const [ownerBytes, lockBytes] = await Promise.all([
    readStableFile(path.join(root, 'extensions', 'playwright', 'package.json'), MAX_METADATA_BYTES, 'Playwright owner manifest'),
    readStableFile(path.join(root, 'pnpm-lock.yaml'), MAX_METADATA_BYTES, 'pnpm lock'),
  ]);
  let owner;
  let lock;
  try {
    owner = JSON.parse(ownerBytes.toString('utf8'));
    lock = parseYaml(lockBytes.toString('utf8'));
  } catch (error) {
    throw new Error('Playwright runtime payload: checked-in owner manifest or pnpm lock is invalid.', { cause: error });
  }
  const ownerDeps = owner?.dependencies;
  if (!isRecord(ownerDeps) || Object.keys(ownerDeps).sort().join('\0') !== ['playwright', 'pngjs'].sort().join('\0')) {
    fail('extensions/playwright/package.json must own exactly the pinned playwright and pngjs runtime dependencies.');
  }
  const playwrightVersion = ownerDeps.playwright;
  const pngjsVersion = ownerDeps.pngjs;
  if (![playwrightVersion, pngjsVersion].every(value => typeof value === 'string' && PLAYWRIGHT_VERSION.test(value))) {
    fail('Playwright owner dependencies must be exact versions.');
  }
  if (lock?.lockfileVersion !== '9.0' && lock?.lockfileVersion !== 9) fail('pnpm-lock.yaml must use lockfile version 9.0.');
  const importer = lock?.importers?.['extensions/playwright'];
  for (const [name, version] of [['playwright', playwrightVersion], ['pngjs', pngjsVersion]]) {
    const dependency = importer?.dependencies?.[name];
    if (dependency?.specifier !== version || dependency?.version !== version) {
      fail(`pnpm-lock.yaml importer does not lock ${name}@${version}.`);
    }
  }
  const packageIntegrity = {};
  for (const [name, version] of [['playwright', playwrightVersion], ['pngjs', pngjsVersion]]) {
    const entry = lock.packages?.[`${name}@${version}`];
    const integrity = entry?.resolution?.integrity;
    integrityTokens(integrity);
    packageIntegrity[name] = integrity;
  }
  const playwrightCoreVersion = lock.snapshots?.[`playwright@${playwrightVersion}`]?.dependencies?.['playwright-core'];
  if (playwrightCoreVersion !== playwrightVersion) fail('The locked Playwright package must depend on matching playwright-core.');
  const coreIntegrity = lock.packages?.[`playwright-core@${playwrightCoreVersion}`]?.resolution?.integrity;
  integrityTokens(coreIntegrity);
  packageIntegrity['playwright-core'] = coreIntegrity;
  return {
    root,
    owner,
    lock,
    versions: { playwright: playwrightVersion, playwrightCore: playwrightCoreVersion, pngjs: pngjsVersion },
    packageIntegrity,
  };
}

function parseRevision(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) return value;
  fail(`${label} must be a numeric pinned revision.`);
}

function derivePinsFromBrowsers(browsersJson, versions) {
  if (!isRecord(browsersJson) || !Array.isArray(browsersJson.browsers)) fail('playwright-core browsers.json is invalid.');
  const one = name => {
    const matches = browsersJson.browsers.filter(browser => browser?.name === name);
    if (matches.length !== 1) fail(`playwright-core browsers.json must contain one ${name} pin.`);
    return matches[0];
  };
  const shell = one('chromium-headless-shell');
  const ffmpeg = one('ffmpeg');
  const winldd = one('winldd');
  if (typeof shell.browserVersion !== 'string' || !/^\d+(?:\.\d+){2,3}$/u.test(shell.browserVersion)) {
    fail('playwright-core headless-shell browserVersion is invalid.');
  }
  return {
    playwright: versions.playwright,
    playwrightCore: versions.playwrightCore,
    pngjs: versions.pngjs,
    chromiumHeadlessShell: {
      revision: parseRevision(shell.revision, 'chromium-headless-shell revision'),
      browserVersion: shell.browserVersion,
    },
    ffmpeg: parseRevision(ffmpeg.revision, 'ffmpeg revision'),
    winldd: parseRevision(winldd.revision, 'winldd revision'),
  };
}

function assertSRI(bytes, integrity, label) {
  const supported = integrityTokens(integrity).filter(token => token.startsWith('sha512-'));
  const actual = `sha512-${digest(bytes, 'sha512', 'base64')}`;
  if (!supported.includes(actual)) fail(`${label} archive bytes do not match the checked-in lock integrity.`);
  return actual;
}

function parseOctal(bytes, label) {
  const text = bytes.toString('ascii').replace(/\0.*$/su, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/u.test(text)) fail(`TAR ${label} must be a non-negative octal integer.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail(`TAR ${label} exceeds the safe integer bound.`);
  return value;
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function parsePax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) fail('TAR PAX record has no length separator.');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^\d+$/u.test(lengthText)) fail('TAR PAX record has an invalid length.');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length) {
      fail('TAR PAX record length is invalid.');
    }
    const record = bytes.subarray(space + 1, offset + length).toString('utf8');
    if (!record.endsWith('\n')) fail('TAR PAX record is not newline terminated.');
    const separator = record.indexOf('=');
    if (separator < 1) fail('TAR PAX record has no key/value separator.');
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1, -1);
    if (!['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment'].includes(key)
      || Object.hasOwn(result, key) || /[\u0000-\u001f]/u.test(value)) {
      fail(`TAR PAX key is unsupported or duplicated: ${key}`);
    }
    result[key] = value;
    offset += length;
  }
  return result;
}

function addArchiveNode(nodes, relative, kind, label) {
  const parts = validateRelative(relative, label);
  for (let index = 1; index <= parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const nodeKind = index === parts.length ? kind : 'directory';
    const folded = prefix.toLocaleLowerCase('en-US');
    const previous = nodes.get(folded);
    if (previous && (previous.path !== prefix || previous.kind !== nodeKind)) {
      fail(`${label} contains a conflicting or case-colliding path: ${prefix}`);
    }
    nodes.set(folded, { path: prefix, kind: nodeKind });
  }
  return parts;
}

function parseTgz(bytes, label) {
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES }); }
  catch (error) { throw new Error(`Playwright runtime payload: ${label} is not a bounded gzip TAR archive.`, { cause: error }); }
  const files = [];
  const nodes = new Map();
  let offset = 0;
  let totalBytes = 0;
  let entryCount = 0;
  let pax;
  const declaredEntries = new Set();
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset + 512, offset + 1024).every(byte => byte === 0)
        || !tar.subarray(offset + 1024).every(byte => byte === 0)) fail(`${label} TAR has an incomplete or noncanonical terminator.`);
      ended = true;
      break;
    }
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) fail(`${label} TAR exceeds the file-count bound.`);
    const storedChecksum = parseOctal(header.subarray(148, 156), 'checksum');
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (storedChecksum !== checksum) fail(`${label} TAR header checksum is invalid.`);
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const headerName = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156] || 48);
    const headerSize = parseOctal(header.subarray(124, 136), 'entry size');
    const dataOffset = offset + 512;
    const size = pax?.size === undefined ? headerSize : Number(pax.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || dataOffset + size > tar.length) {
      fail(`${label} TAR entry has an invalid or over-limit size.`);
    }
    const data = tar.subarray(dataOffset, dataOffset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    if (dataOffset + paddedSize > tar.length) fail(`${label} TAR entry is truncated.`);
    offset = dataOffset + paddedSize;
    if (type === 'x') {
      if (pax !== undefined) fail(`${label} TAR has stacked PAX headers.`);
      pax = parsePax(data);
      continue;
    }
    if (type === 'g' || type === 'L' || type === 'K') fail(`${label} TAR uses unsupported global or GNU extension entries.`);
    const relative = pax?.path ?? headerName;
    const isDirectory = type === '5';
    if (!(type === '\0' || type === '0' || isDirectory)) fail(`${label} TAR contains a link or special entry.`);
    if (pax?.size !== undefined && Number(pax.size) !== headerSize) fail(`${label} TAR PAX size disagrees with its header.`);
    pax = undefined;
    const canonical = isDirectory ? relative.replace(/\/$/u, '') : relative;
    if (!canonical) fail(`${label} TAR contains an empty path.`);
    const parts = addArchiveNode(nodes, canonical, isDirectory ? 'directory' : 'file', `${label} TAR path`);
    const foldedName = parts.join('/').toLocaleLowerCase('en-US');
    if (declaredEntries.has(foldedName)) fail(`${label} TAR contains a duplicate entry: ${canonical}`);
    declaredEntries.add(foldedName);
    if (parts[0] !== 'package') fail(`${label} TAR entry is outside package/.`);
    if (isDirectory) {
      if (size !== 0) fail(`${label} TAR directory entry contains bytes.`);
    } else {
      totalBytes += size;
      if (totalBytes > MAX_ARCHIVE_EXPANDED_BYTES) fail(`${label} TAR exceeds the expanded byte bound.`);
      files.push({ relative: parts.slice(1).join('/'), bytes: Buffer.from(data) });
    }
  }
  if (!ended || pax !== undefined || files.length === 0) fail(`${label} TAR is missing a canonical end marker or package files.`);
  files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  return files;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n += 1) {
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

function findZipEocd(bytes, label) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === bytes.length) return offset;
    }
  }
  fail(`${label} ZIP end-of-central-directory record is missing.`);
}

function parseZipDirectory(bytes, label) {
  const eocdOffset = findZipEocd(bytes, label);
  const disk = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = bytes.readUInt16LE(eocdOffset + 8);
  const entriesCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (disk || centralDisk || diskEntries !== entriesCount || entriesCount === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff || entriesCount > MAX_ARCHIVE_ENTRIES
    || centralOffset + centralSize !== eocdOffset) fail(`${label} ZIP uses unsupported multi-disk, ZIP64, or malformed directory metadata.`);
  const entries = [];
  const nodes = new Map();
  const declaredEntries = new Set();
  let cursor = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entriesCount; index += 1) {
    if (cursor + 46 > eocdOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) fail(`${label} ZIP central directory is malformed.`);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocdOffset || diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff || (flags & 1) !== 0 || (flags & ~(0x0008 | 0x0800 | 0x0006)) !== 0
      || ![0, 8].includes(method) || uncompressedSize > MAX_FILE_BYTES || compressedSize > MAX_ARCHIVE_BYTES) {
      fail(`${label} ZIP entry has unsupported flags, compression, size, or ZIP64 metadata.`);
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let name;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch (error) { throw new Error(`Playwright runtime payload: ${label} ZIP entry name is not valid UTF-8.`, { cause: error }); }
    if (!(flags & 0x0800) && /[^\x00-\x7f]/u.test(name)) fail(`${label} ZIP has a non-UTF8 filename without the UTF8 flag.`);
    const directory = name.endsWith('/');
    const relative = directory ? name.slice(0, -1) : name;
    const parts = addArchiveNode(nodes, relative, directory ? 'directory' : 'file', `${label} ZIP path`);
    const foldedName = parts.join('/').toLocaleLowerCase('en-US');
    if (declaredEntries.has(foldedName)) fail(`${label} ZIP contains a duplicate entry: ${relative}`);
    declaredEntries.add(foldedName);
    const mode = (externalAttributes >>> 16) & 0xffff;
    const type = mode & 0o170000;
    if ((type !== 0 && type !== (directory ? 0o040000 : 0o100000)) || (!directory && (externalAttributes & 0x10))) {
      fail(`${label} ZIP contains a link, special entry, or malformed directory.`);
    }
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) fail(`${label} ZIP directory contains bytes.`);
    expanded += uncompressedSize;
    if (expanded > MAX_ARCHIVE_EXPANDED_BYTES) fail(`${label} ZIP exceeds the expanded byte bound.`);
    entries.push({ name: parts.join('/'), nameBytes: Buffer.from(nameBytes), directory, flags, method, checksum, compressedSize, uncompressedSize, localOffset });
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) fail(`${label} ZIP central directory size is inconsistent.`);
  entries.centralOffset = centralOffset;
  return entries;
}

function extractZipEntries(bytes, label, onFile) {
  const entries = parseZipDirectory(bytes, label);
  for (const entry of entries) {
    if (entry.directory) continue;
    const offset = entry.localOffset;
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) fail(`${label} ZIP local header is malformed.`);
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameEnd = offset + 30 + nameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (flags !== entry.flags || method !== entry.method || nameEnd > bytes.length || dataStart > bytes.length
      || dataEnd > entries.centralOffset || !bytes.subarray(offset + 30, nameEnd).equals(entry.nameBytes)) {
      fail(`${label} ZIP local and central entry records disagree.`);
    }
    const localCrc = bytes.readUInt32LE(offset + 14);
    const localCompressedSize = bytes.readUInt32LE(offset + 18);
    const localSize = bytes.readUInt32LE(offset + 22);
    if (!(entry.flags & 0x0008) && (localCrc !== entry.checksum || localCompressedSize !== entry.compressedSize || localSize !== entry.uncompressedSize)) {
      fail(`${label} ZIP local sizes/checksum disagree with its central directory.`);
    }
    let output;
    try {
      const compressed = bytes.subarray(dataStart, dataEnd);
      output = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_FILE_BYTES });
    } catch (error) { throw new Error(`Playwright runtime payload: ${label} ZIP entry could not be decompressed.`, { cause: error }); }
    if (output.length !== entry.uncompressedSize || crc32(output) !== entry.checksum) fail(`${label} ZIP entry size or CRC is invalid: ${entry.name}`);
    onFile(entry.name, output);
  }
  return entries;
}

async function writePayloadFile(root, relative, bytes) {
  const parts = validateRelative(relative, 'runtime payload path');
  const destination = path.join(root, ...parts);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
}

function canonicalIdentityFields(manifest) {
  return {
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
    archiveProvenance: manifest.archiveProvenance.map(item => ({
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
    inventory: manifest.inventory.map(item => ({
      relativePath: item.relativePath,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
    })),
  };
}

function payloadIdentity(manifest) {
  return digest(Buffer.from(JSON.stringify(canonicalIdentityFields(manifest))), 'sha256');
}

function canonicalManifest(manifest) {
  return `${JSON.stringify({ ...canonicalIdentityFields(manifest), payloadIdentity: manifest.payloadIdentity }, null, 2)}\n`;
}

async function inventoryPayload(root) {
  const files = [];
  const allNodes = new Map();
  const directories = [];
  let total = 0;
  async function visit(directory, relativeDirectory) {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail(`runtime directory is not an ordinary directory: ${directory}`);
    const names = await readdir(directory);
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      if (!relativeDirectory && name === PLAYWRIGHT_RUNTIME_PAYLOAD_MANIFEST) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail(`runtime payload contains a symbolic link: ${relative}`);
      if (info.isDirectory()) {
        addArchiveNode(allNodes, relative, 'directory', 'runtime inventory path');
        directories.push(relative);
        await visit(absolute, relative);
      } else if (info.isFile()) {
        const parts = addArchiveNode(allNodes, relative, 'file', 'runtime inventory path');
        if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_FILE_BYTES || files.length >= MAX_FILES) {
          fail(`runtime payload file exceeds its count or size bound: ${relative}`);
        }
        const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!compareStat(opened, info)) fail(`runtime payload file changed while opening: ${relative}`);
          const hash = createHash('sha256');
          let size = 0;
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            size += chunk.length;
            if (size > MAX_FILE_BYTES) fail(`runtime payload file exceeds its byte bound: ${relative}`);
            hash.update(chunk);
          }
          const after = await handle.stat();
          const pathAfter = await lstat(absolute);
          if (!compareStat(after, info) || !compareStat(pathAfter, info) || size !== info.size) {
            fail(`runtime payload file changed while hashing: ${relative}`);
          }
          total += size;
          if (total > MAX_PAYLOAD_BYTES) fail('runtime payload exceeds the aggregate byte bound.');
          files.push({ relativePath: parts.join('/'), sizeBytes: size, sha256: hash.digest('hex') });
        } finally { await handle.close(); }
      } else fail(`runtime payload contains a special entry: ${relative}`);
    }
    const after = await lstat(directory);
    if (!compareStat(before, after)) fail(`runtime directory changed while inventoried: ${directory}`);
  }
  await visit(root, '');
  files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  for (const directory of directories) {
    if (!files.some(file => file.relativePath.startsWith(`${directory}/`))) fail(`runtime payload contains an empty directory: ${directory}`);
  }
  return files;
}

function packageManifestProjection(manifest) {
  if (!isRecord(manifest)) fail('package archive manifest metadata is missing.');
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    engines: manifest.engines ?? {},
  };
}

function normalizeProvenancePackages(provenance, source, archiveInfo) {
  if (provenance?.schema !== 'pie-private-jsdependency-provenance-staging/v1'
    || provenance.source?.authoritativeLock !== 'pnpm-lock.yaml'
    || provenance.source?.ownerManifest !== 'extensions/playwright/package.json'
    || provenance.source?.lockfileVersion !== '9.0') fail('JavaScript archive provenance does not identify the checked-in owner and lock.');
  if (provenance.source.ownerDependencies?.playwright !== source.versions.playwright
    || provenance.source.ownerDependencies?.pngjs !== source.versions.pngjs) fail('JavaScript provenance owner pins differ from the checked-in owner manifest.');
  if (!Array.isArray(provenance.packages) || provenance.packages.length !== NPM_PACKAGES.length) {
    fail('JavaScript provenance must declare exactly the three locked archives.');
  }
  const provenanceByName = new Map(provenance.packages.map(item => [item?.name, item]));
  if (provenanceByName.size !== NPM_PACKAGES.length || NPM_PACKAGES.some(name => !provenanceByName.has(name))) {
    fail('JavaScript provenance has missing or duplicate package declarations.');
  }
  const output = [];
  const extracted = new Map();
  for (const name of NPM_PACKAGES) {
    const version = source.versions[name === 'playwright-core' ? 'playwrightCore' : name];
    const declaration = provenanceByName.get(name);
    const integrity = source.packageIntegrity[name];
    const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    if (declaration.version !== version || declaration.tarballUrl !== url || declaration.registryIntegrity !== integrity
      || declaration.lockIntegrity !== integrity || declaration.verifiedIntegrity !== integrity
      || declaration.sizeBytes !== archiveInfo[name].bytes.length
      || path.resolve(declaration.stagedFile ?? '') !== path.resolve(archiveInfo[name].path)) {
      fail(`${name} provenance declaration does not bind the exact locked archive input.`);
    }
    const computedIntegrity = assertSRI(archiveInfo[name].bytes, integrity, name);
    const files = parseTgz(archiveInfo[name].bytes, name);
    const byPath = new Map(files.map(file => [file.relative, file.bytes]));
    if (!byPath.has('package.json')) fail(`${name} archive has no package/package.json.`);
    let packageManifest;
    try { packageManifest = JSON.parse(byPath.get('package.json').toString('utf8')); }
    catch (error) { throw new Error(`Playwright runtime payload: ${name} package manifest is invalid.`, { cause: error }); }
    if (packageManifest.name !== name || packageManifest.version !== version
      || !equalJson(packageManifestProjection(declaration.archiveManifest), packageManifestProjection(packageManifest))) {
      fail(`${name} archive package metadata does not match its provenance declaration and lock.`);
    }
    const declaredNotices = declaration.licenseNoticeEntries;
    if (!Array.isArray(declaredNotices) || declaredNotices.some(entry => typeof entry !== 'string')
      || declaredNotices.some(entry => !entry.startsWith('package/'))
      || declaredNotices.map(entry => entry.slice('package/'.length)).some(entry => !byPath.has(entry))) {
      fail(`${name} archive provenance names a missing notice or license file.`);
    }
    if (declaration.packageManifestEntry !== true) fail(`${name} archive provenance does not declare package/package.json.`);
    for (const file of files) {
      if (file.relative.toLowerCase().split('/').includes('node_modules')) fail(`${name} package archive embeds node_modules.`);
      extracted.set(`${name}/${file.relative}`, file.bytes);
    }
    output.push({
      kind: 'npm-package', name, version, pin: null,
      archiveFile: `${name}-${version}.tgz`, url, finalUrl: null, integrity: computedIntegrity,
      sizeBytes: archiveInfo[name].bytes.length, sha256: digest(archiveInfo[name].bytes),
      verification: ARCHIVE_VERIFICATION, subject: 'archive-bytes-only', attestation: NO_ATTESTATION,
    });
  }
  const playwrightManifest = JSON.parse(extracted.get('playwright/package.json').toString('utf8'));
  if (playwrightManifest.dependencies?.['playwright-core'] !== source.versions.playwrightCore) {
    fail('Playwright archive does not depend on the locked playwright-core version.');
  }
  return { archiveProvenance: output, extracted };
}

function browserArchiveRecord(collection, name, kind) {
  const matches = collection.filter(item => item?.name === name && item?.kind === kind);
  if (matches.length !== 1) fail(`browser evidence must contain exactly one ${kind} archive declaration.`);
  return matches[0];
}

function validateBrowserCoreFiles(evidence, extracted) {
  for (const key of ['coreBundleAndPinFiles', 'coreLicenseAndNoticeFiles']) {
    const records = evidence.playwright?.[key];
    if (!Array.isArray(records) || records.length === 0 || records.length > 64) fail(`browser evidence is missing or over-bounds ${key}.`);
    const seen = new Set();
    for (const record of records) {
      if (typeof record?.path !== 'string' || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !SHA256.test(record.sha256)) {
        fail(`browser evidence has an invalid ${key} record.`);
      }
      const normalized = record.path.replaceAll('\\', '/');
      const marker = '/playwright-core/';
      const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
      if (markerIndex < 0) fail(`browser evidence ${key} path is outside playwright-core.`);
      const relative = normalized.slice(markerIndex + marker.length);
      validateRelative(relative, `browser evidence ${key} path`);
      const folded = relative.toLocaleLowerCase('en-US');
      if (seen.has(folded)) fail(`browser evidence ${key} contains a duplicate path.`);
      seen.add(folded);
      const bytes = extracted.get(`playwright-core/${relative}`);
      if (!bytes || bytes.length !== record.bytes || digest(bytes) !== record.sha256) {
        fail(`playwright-core archive bytes do not match browser evidence for ${relative}.`);
      }
    }
  }
}

function validateBrowserMetadata(evidence, downloadManifest, pins, actual) {
  if (evidence?.execution?.status !== 'NOT RUN' || evidence.execution.noInstallOrActivation !== true
    || evidence.execution.localMsPlaywrightCacheTouched !== false) {
    fail('browser evidence must remain metadata-only and confirm no install, activation, or browser execution.');
  }
  if (evidence.playwright?.packageVersion !== pins.playwright
    || evidence.playwright.packageLock?.playwrightCore?.version !== pins.playwrightCore
    || evidence.playwright.packageLock?.playwrightCore?.integrity !== actual.coreIntegrity
    || evidence.playwright.packageLock?.trackedPnpmLockIntegrity !== actual.coreIntegrity
    || evidence.playwright.packageLock?.matchesTrackedPnpmLock !== true) {
    fail('browser evidence core-package metadata differs from the checked-in lock.');
  }
  if (downloadManifest?.playwrightVersion !== pins.playwright || !Array.isArray(evidence.archives) || evidence.archives.length > 32
    || !Array.isArray(downloadManifest.archives) || downloadManifest.archives.length > 32) {
    fail('browser download metadata does not match the locked Playwright version.');
  }
  const expected = [
    {
      name: 'chromium-headless-shell-win64.zip', kind: 'chromium-headless-shell',
      version: pins.chromiumHeadlessShell.browserVersion, pin: pins.chromiumHeadlessShell.revision,
      url: `https://cdn.playwright.dev/builds/cft/${pins.chromiumHeadlessShell.browserVersion}/win64/chrome-headless-shell-win64.zip`,
      root: 'chrome-headless-shell-win64', output: `browsers/chromium_headless_shell-${pins.chromiumHeadlessShell.revision}/chrome-headless-shell-win64`,
      archive: actual.shell,
    },
    {
      name: 'ffmpeg-win64.zip', kind: 'ffmpeg', version: null, pin: pins.ffmpeg,
      url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/${pins.ffmpeg}/ffmpeg-win64.zip`,
      root: null, output: `browsers/ffmpeg-${pins.ffmpeg}`, archive: actual.ffmpeg,
    },
  ];
  const declarations = [];
  for (const expectedArchive of expected) {
    const evidence = browserArchiveRecord(actual.evidence.archives, expectedArchive.name, expectedArchive.kind);
    const download = actual.downloadManifest.archives.filter(item => item?.name === expectedArchive.name && item?.kind === expectedArchive.kind);
    if (download.length !== 1) fail(`download manifest must contain exactly one ${expectedArchive.kind} record.`);
    const downloadRecord = download[0];
    const requestedUrl = normalizeHttpsUrl(evidence.requestedUrl, `${expectedArchive.kind} requested URL`);
    const finalUrl = normalizeHttpsUrl(evidence.finalUrl, `${expectedArchive.kind} final URL`);
    if (requestedUrl !== expectedArchive.url || downloadRecord.requestedUrl !== requestedUrl
      || downloadRecord.finalUrl !== finalUrl
      || evidence.bytes !== expectedArchive.archive.bytes.length || evidence.contentLength !== evidence.bytes
      || downloadRecord.bytes !== evidence.bytes || evidence.sha256 !== expectedArchive.archive.sha256
      || downloadRecord.sha256 !== evidence.sha256) {
      fail(`${expectedArchive.kind} archive declaration does not match the input archive bytes and pinned URL.`);
    }
    declarations.push({
      kind: 'browser-download', name: expectedArchive.kind,
      version: expectedArchive.version, pin: expectedArchive.pin,
      archiveFile: expectedArchive.name, url: requestedUrl, finalUrl, integrity: null,
      sizeBytes: expectedArchive.archive.bytes.length, sha256: expectedArchive.archive.sha256,
      verification: ARCHIVE_VERIFICATION, subject: 'archive-bytes-only', attestation: NO_ATTESTATION,
    });
  }
  return { declarations, expected };
}

function validateWinlddMetadata(provenance, actual, pins) {
  if (provenance?.playwrightCore?.version !== pins.playwrightCore
    || provenance.playwrightCore.browserPins?.winldd !== pins.winldd
    || provenance.winlddDownload?.bytes !== actual.bytes.length
    || provenance.winlddDownload?.sha256 !== actual.sha256
    || provenance.winlddDownload?.requestedUrl !== `https://cdn.playwright.dev/dbazure/download/playwright/builds/winldd/${pins.winldd}/winldd-win64.zip`) {
    fail('WinLdd archive provenance does not match the pinned archive bytes and URL.');
  }
  const url = normalizeHttpsUrl(provenance.winlddDownload.requestedUrl, 'WinLdd requested URL');
  const finalUrl = normalizeHttpsUrl(provenance.winlddDownload.finalUrl, 'WinLdd final URL');
  return {
    kind: 'browser-download', name: 'winldd', version: null, pin: pins.winldd,
    archiveFile: 'winldd-win64.zip', url, finalUrl, integrity: null,
    sizeBytes: actual.bytes.length, sha256: actual.sha256,
    verification: ARCHIVE_VERIFICATION, subject: 'archive-bytes-only', attestation: NO_ATTESTATION,
  };
}

async function readArchiveInput(file, label) {
  const bytes = await readStableFile(file, MAX_ARCHIVE_BYTES, label);
  return { path: file, bytes, sha256: digest(bytes) };
}

async function extractPinnedZip(archive, label, expected, root, outputDirectory) {
  const matched = new Set();
  const seen = new Set();
  const writes = [];
  extractZipEntries(archive.bytes, label, (archivePath, bytes) => {
    let relative = archivePath;
    if (expected.root) {
      if (relative !== expected.root && !relative.startsWith(`${expected.root}/`)) fail(`${label} ZIP has an entry outside ${expected.root}/.`);
      if (relative === expected.root) return;
      relative = relative.slice(expected.root.length + 1);
    }
    const parts = validateRelative(relative, `${label} ZIP path`);
    const key = parts.join('/').toLocaleLowerCase('en-US');
    if (seen.has(key)) fail(`${label} ZIP has a duplicate or case-colliding file: ${relative}`);
    seen.add(key);
    matched.add(relative);
    const name = parts.join('/');
    const destination = `${outputDirectory}/${name}`;
    // Browser registry file names stay exactly as they appear inside their pinned ZIP.
    writes.push([destination, bytes]);
  });
  for (const [destination, bytes] of writes) await writePayloadFile(root, destination, bytes);
  return matched;
}

async function copyShellTree(source, destination) {
  const files = [];
  async function visit(directory, relativeDirectory) {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail(`headless-shell source directory is not ordinary: ${directory}`);
    const names = await readdir(directory);
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      validateRelative(relative, 'headless-shell source path');
      const sourceFile = path.join(directory, name);
      const info = await lstat(sourceFile);
      const target = path.join(destination, ...relative.split('/'));
      if (info.isSymbolicLink()) fail(`headless-shell source contains a symbolic link: ${sourceFile}`);
      if (info.isDirectory()) {
        await mkdir(target, { recursive: true });
        await visit(sourceFile, relative);
      } else if (info.isFile()) {
        if (!Number.isSafeInteger(info.size) || info.size > MAX_FILE_BYTES) fail(`headless-shell source file exceeds its bound: ${sourceFile}`);
        await mkdir(path.dirname(target), { recursive: true });
        let input;
        let output;
        try {
          input = await open(sourceFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
          const opened = await input.stat();
          if (!compareStat(opened, info)) fail(`headless-shell source changed while opening: ${sourceFile}`);
          output = await open(target, 'wx', 0o644);
          let copiedBytes = 0;
          for await (const chunk of input.createReadStream({ autoClose: false })) {
            copiedBytes += chunk.length;
            let offset = 0;
            while (offset < chunk.length) {
              const written = await output.write(chunk, offset, chunk.length - offset, null);
              offset += written.bytesWritten;
            }
          }
          const after = await input.stat();
          const pathAfter = await lstat(sourceFile);
          if (copiedBytes !== info.size || !compareStat(after, info) || !compareStat(pathAfter, info)) fail(`headless-shell source changed while copying: ${sourceFile}`);
          files.push(relative);
        } finally { await Promise.allSettled([input?.close(), output?.close()].filter(Boolean)); }
      } else fail(`headless-shell source contains a special entry: ${sourceFile}`);
    }
    if (!compareStat(before, await lstat(directory))) fail(`headless-shell source directory changed while copying: ${directory}`);
  }
  await visit(source, '');
  if (!files.length) fail('headless-shell source tree is empty.');
  return files;
}

async function canonicalInputs(options) {
  const required = [
    'repositoryRoot', 'shellPayloadDirectory', 'javascriptProvenancePath', 'javascriptArchives',
    'browserEvidencePath', 'browserDownloadManifestPath', 'ffmpegArchive', 'winlddProvenancePath',
    'winlddArchive', 'destinationDirectory',
  ];
  exactKeys(options, required, 'preparePlaywrightRuntimePayload arguments');
  exactKeys(options.javascriptArchives, ['playwright', 'playwrightCore', 'pngjs'], 'javascriptArchives');
  const result = {};
  for (const key of ['repositoryRoot', 'shellPayloadDirectory', 'javascriptProvenancePath', 'browserEvidencePath',
    'browserDownloadManifestPath', 'ffmpegArchive', 'winlddProvenancePath', 'winlddArchive', 'destinationDirectory']) {
    result[key] = assertAbsolute(options[key], key);
  }
  result.javascriptArchives = {
    playwright: assertAbsolute(options.javascriptArchives.playwright, 'javascriptArchives.playwright'),
    'playwright-core': assertAbsolute(options.javascriptArchives.playwrightCore, 'javascriptArchives.playwrightCore'),
    pngjs: assertAbsolute(options.javascriptArchives.pngjs, 'javascriptArchives.pngjs'),
  };
  const directoryKeys = ['repositoryRoot', 'shellPayloadDirectory'];
  for (const key of directoryKeys) {
    const info = await lstat(result[key]);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${key} must be an existing nonsymlink directory.`);
  }
  for (const key of ['javascriptProvenancePath', 'browserEvidencePath', 'browserDownloadManifestPath', 'ffmpegArchive', 'winlddProvenancePath', 'winlddArchive', ...NPM_PACKAGES.map(name => `javascriptArchives.${name}`)]) {
    const file = key.startsWith('javascriptArchives.') ? result.javascriptArchives[key.slice('javascriptArchives.'.length)] : result[key];
    await assertNoSymlinkPath(file, key);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) fail(`${key} must be a regular nonsymlink file.`);
  }
  result.shellArchive = path.join(path.dirname(result.browserEvidencePath), 'chromium-headless-shell-win64.zip');
  await assertNoSymlinkPath(result.shellArchive, 'headless-shell archive');
  const shellArchiveInfo = await lstat(result.shellArchive);
  if (!shellArchiveInfo.isFile() || shellArchiveInfo.isSymbolicLink()) fail('headless-shell archive must be a regular nonsymlink file beside browser evidence.');
  const output = result.destinationDirectory;
  const parent = path.dirname(output);
  await assertNoSymlinkPath(parent, 'destinationDirectory parent');
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('destinationDirectory parent must be an existing ordinary directory.');
  const parentCanonical = await realpath(parent);
  const existing = await lstatIfExists(output);
  if (existing) fail('destinationDirectory already exists; runtime payloads are immutable and never overwritten.');
  const repositoryCanonical = await realpath(result.repositoryRoot);
  const inputs = [
    repositoryCanonical,
    await realpath(result.shellPayloadDirectory),
    await realpath(result.javascriptProvenancePath),
    await realpath(result.browserEvidencePath),
    await realpath(result.browserDownloadManifestPath),
    await realpath(result.ffmpegArchive),
    await realpath(result.shellArchive),
    await realpath(result.winlddProvenancePath),
    await realpath(result.winlddArchive),
    ...await Promise.all(NPM_PACKAGES.map(name => realpath(result.javascriptArchives[name]))),
  ];
  const canonicalOutput = path.join(await realpath(parent), path.basename(output));
  if (inputs.some(input => within(input, canonicalOutput) || within(canonicalOutput, input))) {
    fail('destinationDirectory must be new and must not overlap the repository or any source input.');
  }
  return { ...result, destinationPath: output, destinationCanonical: canonicalOutput, parentCanonical };
}

function checkPackageOutput(extracted, pins) {
  for (const [name, version] of [['playwright', pins.playwright], ['playwright-core', pins.playwrightCore], ['pngjs', pins.pngjs]]) {
    const manifestBytes = extracted.get(`${name}/package.json`);
    if (!manifestBytes) fail(`prepared ${name} package has no package.json.`);
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch (error) { throw new Error(`Playwright runtime payload: extracted ${name} package.json is invalid.`, { cause: error }); }
    if (manifest.name !== name || manifest.version !== version) fail(`prepared ${name} version does not match the owner/lock pin.`);
  }
  const playwright = JSON.parse(extracted.get('playwright/package.json').toString('utf8'));
  if (playwright.dependencies?.['playwright-core'] !== pins.playwrightCore) fail('prepared Playwright core dependency does not match the lock.');
}

function expectedArchiveFiles(files, prefix, required) {
  const matching = files.filter(file => file.relativePath.startsWith(prefix));
  for (const relative of required) {
    if (!matching.some(file => file.relativePath === relative)) fail(`runtime payload is missing required archive file: ${relative}`);
  }
  if (!matching.length) fail(`runtime payload is missing ${prefix} files.`);
}

function validateArchiveProvenance(manifest, source, pins) {
  if (!Array.isArray(manifest.archiveProvenance) || manifest.archiveProvenance.length !== 6) {
    fail('manifest archiveProvenance must describe the three JS packages, headless shell, ffmpeg, and WinLdd.');
  }
  const expectedNpm = NPM_PACKAGES.map(name => ({
    kind: 'npm-package', name,
    version: source.versions[name === 'playwright-core' ? 'playwrightCore' : name],
    pin: null,
    archiveFile: `${name}-${source.versions[name === 'playwright-core' ? 'playwrightCore' : name]}.tgz`,
    url: `https://registry.npmjs.org/${name}/-/${name}-${source.versions[name === 'playwright-core' ? 'playwrightCore' : name]}.tgz`,
    finalUrl: null,
    integrity: source.packageIntegrity[name],
  }));
  const expectedOther = [
    {
      kind: 'browser-download', name: 'chromium-headless-shell', version: pins.chromiumHeadlessShell.browserVersion,
      pin: pins.chromiumHeadlessShell.revision, archiveFile: 'chromium-headless-shell-win64.zip',
      url: `https://cdn.playwright.dev/builds/cft/${pins.chromiumHeadlessShell.browserVersion}/win64/chrome-headless-shell-win64.zip`, integrity: null,
    },
    {
      kind: 'browser-download', name: 'ffmpeg', version: null, pin: pins.ffmpeg, archiveFile: 'ffmpeg-win64.zip',
      url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/${pins.ffmpeg}/ffmpeg-win64.zip`, integrity: null,
    },
    {
      kind: 'browser-download', name: 'winldd', version: null, pin: pins.winldd, archiveFile: 'winldd-win64.zip',
      url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/winldd/${pins.winldd}/winldd-win64.zip`, integrity: null,
    },
  ];
  const expected = [...expectedNpm, ...expectedOther];
  for (let index = 0; index < expected.length; index += 1) {
    const entry = manifest.archiveProvenance[index];
    const declaration = expected[index];
    exactKeys(entry, ['kind', 'name', 'version', 'pin', 'archiveFile', 'url', 'finalUrl', 'integrity', 'sizeBytes', 'sha256', 'verification', 'subject', 'attestation'], 'Archive provenance entry');
    for (const field of ['kind', 'name', 'version', 'pin', 'archiveFile', 'url', 'integrity']) {
      if (entry[field] !== declaration[field]) fail(`manifest archive provenance ${field} mismatch for ${declaration.name}.`);
    }
    if (entry.verification !== ARCHIVE_VERIFICATION || entry.subject !== 'archive-bytes-only' || entry.attestation !== NO_ATTESTATION
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > MAX_ARCHIVE_BYTES || !SHA256.test(entry.sha256)) {
      fail(`manifest archive provenance is invalid for ${declaration.name}.`);
    }
    if (declaration.kind === 'npm-package') {
      if (entry.finalUrl !== null) fail(`npm archive finalUrl must be null for ${declaration.name}.`);
    } else normalizeHttpsUrl(entry.finalUrl, `${declaration.name} final URL`);
  }
}

function parseRuntimeManifest(sourceText) {
  let manifest;
  try { manifest = JSON.parse(sourceText); }
  catch (error) { throw new Error('Playwright runtime payload: manifest.json is not valid JSON.', { cause: error }); }
  exactKeys(manifest, ['schemaVersion', 'kind', 'target', 'pins', 'archiveProvenance', 'inventory', 'payloadIdentity'], 'Manifest');
  exactKeys(manifest.target, ['platform', 'arch'], 'Manifest target');
  exactKeys(manifest.pins, ['playwright', 'playwrightCore', 'pngjs', 'chromiumHeadlessShell', 'ffmpeg', 'winldd'], 'Manifest pins');
  exactKeys(manifest.pins.chromiumHeadlessShell, ['revision', 'browserVersion'], 'Headless shell pin');
  if (manifest.schemaVersion !== PLAYWRIGHT_RUNTIME_PAYLOAD_SCHEMA_VERSION || manifest.kind !== 'playwright-windows-headless-runtime'
    || manifest.target.platform !== 'win32' || manifest.target.arch !== 'x64') fail('manifest schema, kind, or target is unsupported.');
  if (![manifest.pins.playwright, manifest.pins.playwrightCore, manifest.pins.pngjs].every(value => typeof value === 'string' && PLAYWRIGHT_VERSION.test(value))
    || !/^\d+$/u.test(manifest.pins.chromiumHeadlessShell.revision)
    || !/^\d+(?:\.\d+){2,3}$/u.test(manifest.pins.chromiumHeadlessShell.browserVersion)
    || !/^\d+$/u.test(manifest.pins.ffmpeg) || !/^\d+$/u.test(manifest.pins.winldd)) fail('manifest pins are invalid.');
  if (!Array.isArray(manifest.inventory) || manifest.inventory.length === 0 || manifest.inventory.length > MAX_FILES) {
    fail('manifest inventory is empty or exceeds the file-count bound.');
  }
  let previous;
  let total = 0;
  const folded = new Set();
  for (const item of manifest.inventory) {
    exactKeys(item, ['relativePath', 'sizeBytes', 'sha256'], 'Inventory entry');
    validateRelative(item.relativePath, 'inventory path');
    if (previous !== undefined && previous >= item.relativePath) fail('manifest inventory is not uniquely sorted.');
    previous = item.relativePath;
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > MAX_FILE_BYTES || !SHA256.test(item.sha256)) {
      fail(`manifest inventory entry is invalid: ${item.relativePath}`);
    }
    const key = item.relativePath.toLocaleLowerCase('en-US');
    if (folded.has(key)) fail(`manifest inventory contains case-colliding paths: ${item.relativePath}`);
    folded.add(key);
    total += item.sizeBytes;
    if (total > MAX_PAYLOAD_BYTES) fail('manifest inventory exceeds the aggregate byte bound.');
  }
  if (typeof manifest.payloadIdentity !== 'string' || !SHA256.test(manifest.payloadIdentity)
    || payloadIdentity(manifest) !== manifest.payloadIdentity) fail('manifest payloadIdentity does not match the canonical payload identity.');
  if (canonicalManifest(manifest) !== sourceText) fail('manifest.json is not in canonical serialized form.');
  return manifest;
}

async function validatePayloadAt(directory, source) {
  const root = assertAbsolute(directory, 'directory');
  await assertNoSymlinkPath(root, 'directory');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('directory must be an ordinary nonsymlink directory.');
  const manifestPath = path.join(root, PLAYWRIGHT_RUNTIME_PAYLOAD_MANIFEST);
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) fail('manifest.json must be a regular nonsymlink file.');
  const text = (await readStableFile(manifestPath, MAX_METADATA_BYTES, 'runtime manifest')).toString('utf8');
  const manifest = parseRuntimeManifest(text);
  const packagedBrowsers = await readJson(path.join(root, 'node_modules', 'playwright-core', 'browsers.json'), 'packaged browsers.json');
  const pins = derivePinsFromBrowsers(packagedBrowsers, source.versions);
  if (!equalJson(manifest.pins, pins)) fail('manifest pins do not match the owner/lock and packaged playwright-core browsers.json.');
  validateArchiveProvenance(manifest, source, pins);
  const entries = await readdir(root);
  if (!equalJson([...entries].sort(), ['browsers', 'manifest.json', 'node_modules'].sort())) fail('runtime payload root contains missing or extra entries.');
  const actual = await inventoryPayload(root);
  if (!equalJson(actual, manifest.inventory)) fail('runtime payload files are missing, extra, or mutated.');
  const shellRoot = `browsers/chromium_headless_shell-${pins.chromiumHeadlessShell.revision}/chrome-headless-shell-win64/`;
  const allowedPrefixes = [
    'node_modules/playwright/', 'node_modules/playwright-core/', 'node_modules/pngjs/', shellRoot,
    `browsers/ffmpeg-${pins.ffmpeg}/`, `browsers/winldd-${pins.winldd}/`,
  ];
  if (actual.some(file => !allowedPrefixes.some(prefix => file.relativePath.startsWith(prefix)))) {
    fail('runtime inventory contains files outside the exact pinned package/browser layout.');
  }
  const playwrightManifest = JSON.parse((await readStableFile(path.join(root, 'node_modules/playwright/package.json'), MAX_METADATA_BYTES, 'packaged Playwright manifest')).toString('utf8'));
  const coreManifest = JSON.parse((await readStableFile(path.join(root, 'node_modules/playwright-core/package.json'), MAX_METADATA_BYTES, 'packaged playwright-core manifest')).toString('utf8'));
  const pngManifest = JSON.parse((await readStableFile(path.join(root, 'node_modules/pngjs/package.json'), MAX_METADATA_BYTES, 'packaged pngjs manifest')).toString('utf8'));
  for (const [manifestValue, name, version] of [
    [playwrightManifest, 'playwright', pins.playwright], [coreManifest, 'playwright-core', pins.playwrightCore], [pngManifest, 'pngjs', pins.pngjs],
  ]) if (manifestValue.name !== name || manifestValue.version !== version) fail(`packaged ${name} manifest does not match the trusted pin.`);
  if (playwrightManifest.dependencies?.['playwright-core'] !== pins.playwrightCore) fail('packaged Playwright manifest has a different core dependency.');
  expectedArchiveFiles(actual, 'node_modules/playwright/', ['node_modules/playwright/package.json']);
  expectedArchiveFiles(actual, 'node_modules/playwright-core/', ['node_modules/playwright-core/package.json', 'node_modules/playwright-core/browsers.json']);
  expectedArchiveFiles(actual, 'node_modules/pngjs/', ['node_modules/pngjs/package.json']);
  expectedArchiveFiles(actual, `browsers/chromium_headless_shell-${pins.chromiumHeadlessShell.revision}/chrome-headless-shell-win64/`, [
    `browsers/chromium_headless_shell-${pins.chromiumHeadlessShell.revision}/chrome-headless-shell-win64/chrome-headless-shell.exe`,
    `browsers/chromium_headless_shell-${pins.chromiumHeadlessShell.revision}/chrome-headless-shell-win64/ABOUT`,
    `browsers/chromium_headless_shell-${pins.chromiumHeadlessShell.revision}/chrome-headless-shell-win64/LICENSE.headless_shell`,
  ]);
  expectedArchiveFiles(actual, `browsers/ffmpeg-${pins.ffmpeg}/`, [
    `browsers/ffmpeg-${pins.ffmpeg}/ffmpeg-win64.exe`, `browsers/ffmpeg-${pins.ffmpeg}/COPYING.LGPLv2.1`,
  ]);
  const winlddPrefix = `browsers/winldd-${pins.winldd}/`;
  expectedArchiveFiles(actual, winlddPrefix, [`${winlddPrefix}PrintDeps.exe`, `${winlddPrefix}LICENSE`]);
  const trustedWinlddNotices = await readStableFile(path.join(source.root, WINLDD_NOTICES), MAX_FILE_BYTES, 'trusted WinLdd notices');
  const packagedWinlddNotices = await readStableFile(path.join(root, winlddPrefix, 'LICENSE'), MAX_FILE_BYTES, 'packaged WinLdd notices');
  if (!packagedWinlddNotices.equals(trustedWinlddNotices)) fail('packaged WinLdd notices do not match the trusted repository notice bytes.');
  return { directory: root, manifest, identity: manifest.payloadIdentity };
}

/** Validate one relocated, immutable Playwright Windows x64 headless runtime payload. */
export async function validatePlaywrightRuntimePayload(options) {
  exactKeys(options, ['directory', 'repositoryRoot'], 'validatePlaywrightRuntimePayload arguments');
  const source = await readOwnerLock(options.repositoryRoot);
  return validatePayloadAt(options.directory, source);
}

/**
 * Assemble the narrowly pinned Playwright runtime from explicit local archives.
 * Package lifecycle scripts are never invoked; archive declarations are locally
 * content-hash checked and make no claim of vendor attestation.
 */
export async function preparePlaywrightRuntimePayload(options) {
  const input = await canonicalInputs(options);
  const source = await readOwnerLock(input.repositoryRoot);
  const archivePaths = {
    playwright: input.javascriptArchives.playwright,
    'playwright-core': input.javascriptArchives['playwright-core'],
    pngjs: input.javascriptArchives.pngjs,
  };
  const archiveInfo = {};
  for (const name of NPM_PACKAGES) archiveInfo[name] = await readArchiveInput(archivePaths[name], `${name} archive`);
  const jsProvenance = await readJson(input.javascriptProvenancePath, 'JavaScript archive provenance');
  const extractedPackages = normalizeProvenancePackages(jsProvenance, source, archiveInfo);
  const evidence = await readJson(input.browserEvidencePath, 'browser evidence');
  validateBrowserCoreFiles(evidence, extractedPackages.extracted);
  const coreBrowsersBytes = extractedPackages.extracted.get('playwright-core/browsers.json');
  if (!coreBrowsersBytes) fail('locked playwright-core archive is missing browsers.json.');
  let browsersJson;
  try { browsersJson = JSON.parse(coreBrowsersBytes.toString('utf8')); }
  catch (error) { throw new Error('Playwright runtime payload: locked playwright-core browsers.json is invalid.', { cause: error }); }
  const pins = derivePinsFromBrowsers(browsersJson, source.versions);
  const shellExpected = {
    target: { platform: 'win32', arch: 'x64' },
    playwrightVersion: pins.playwright,
    browserVersion: pins.chromiumHeadlessShell.browserVersion,
    browserRevision: pins.chromiumHeadlessShell.revision,
  };
  const shell = await validatePlaywrightHeadlessPayload({ directory: input.shellPayloadDirectory, expected: shellExpected });
  const shellDeclaration = shell.manifest.sourceArchiveDeclaration;
  const downloadManifest = await readJson(input.browserDownloadManifestPath, 'browser download manifest');
  const shellZip = await readArchiveInput(input.shellArchive, 'headless-shell archive');
  const ffmpeg = await readArchiveInput(input.ffmpegArchive, 'ffmpeg archive');
  const winldd = await readArchiveInput(input.winlddArchive, 'WinLdd archive');
  const winlddProvenance = await readJson(input.winlddProvenancePath, 'WinLdd provenance');
  const browserMetadata = validateBrowserMetadata(evidence, downloadManifest, pins, {
    evidence, downloadManifest, shell: shellZip, ffmpeg,
    coreIntegrity: source.packageIntegrity['playwright-core'],
  });
  if (shellDeclaration && (shellDeclaration.sha256 !== shellZip.sha256 || shellDeclaration.sizeBytes !== shellZip.bytes.length)) {
    fail('prepared shell archive declaration does not match the locally hashed source archive.');
  }
  // Archive evidence paths are explicit in the source metadata, but never used
  // to choose the supplied archive. Require the downloaded byte declarations to
  // match the caller's explicit archive inputs.
  const winlddDeclaration = validateWinlddMetadata(winlddProvenance, winldd, pins);
  const archiveProvenance = [
    ...extractedPackages.archiveProvenance,
    ...browserMetadata.declarations,
    winlddDeclaration,
  ];
  const destination = input.destinationCanonical;
  const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.staging-${randomUUID()}`);
  if (await lstatIfExists(staging)) fail('private staging path unexpectedly already exists.');
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const [name, bytes] of extractedPackages.extracted) {
      const [packageName, ...parts] = name.split('/');
      await writePayloadFile(staging, `node_modules/${packageName}/${parts.join('/')}`, bytes);
    }
    checkPackageOutput(extractedPackages.extracted, pins);

    const shellTree = path.join(input.shellPayloadDirectory, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE);
    const shellOutput = path.join(staging, 'browsers', `chromium_headless_shell-${pins.chromiumHeadlessShell.revision}`, 'chrome-headless-shell-win64');
    await mkdir(shellOutput, { recursive: true });
    await copyShellTree(shellTree, shellOutput);
    const shellAgain = await validatePlaywrightHeadlessPayload({ directory: input.shellPayloadDirectory, expected: shellExpected });
    if (shellAgain.identity !== shell.identity) fail('headless-shell source changed while preparing the runtime payload.');

    if (shellZip.sha256 !== browserMetadata.declarations[0].sha256 || shellZip.bytes.length !== browserMetadata.declarations[0].sizeBytes) {
      fail('headless-shell archive changed after its metadata was checked.');
    }
    // The shell tree comes only from the separately validated prepared payload;
    // the ZIP declaration binds archive bytes but does not claim tree correspondence.
    const ffmpegEntries = await extractPinnedZip(ffmpeg, 'ffmpeg', browserMetadata.expected[1], staging, `browsers/ffmpeg-${pins.ffmpeg}`);
    if (ffmpegEntries.size !== 2 || !ffmpegEntries.has('ffmpeg-win64.exe') || !ffmpegEntries.has('COPYING.LGPLv2.1')) {
      fail('ffmpeg ZIP must retain its executable and COPYING.LGPLv2.1 notice.');
    }
    const winlddEntries = await extractPinnedZip(winldd, 'winldd', { root: null }, staging, `browsers/winldd-${pins.winldd}`);
    if (winlddEntries.size !== 1 || !winlddEntries.has('PrintDeps.exe')) fail('WinLdd ZIP must contain only PrintDeps.exe.');
    const trustedWinlddNotices = await readStableFile(path.join(source.root, WINLDD_NOTICES), MAX_FILE_BYTES, 'trusted WinLdd notices');
    await writePayloadFile(staging, `browsers/winldd-${pins.winldd}/LICENSE`, trustedWinlddNotices);

    const files = await inventoryPayload(staging);
    const shellInventoryPrefix = `browsers/chromium_headless_shell-${pins.chromiumHeadlessShell.revision}/chrome-headless-shell-win64/`;
    const expectedShellInventory = shell.manifest.files.map(item => ({
      relativePath: `${shellInventoryPrefix}${item.relativePath.slice(`${PLAYWRIGHT_HEADLESS_PAYLOAD_TREE}/`.length)}`,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
    }));
    const actualShellInventory = files.filter(item => item.relativePath.startsWith(shellInventoryPrefix));
    if (!equalJson(actualShellInventory, expectedShellInventory)) fail('transformed headless-shell files differ from the validated original payload.');
    const manifest = {
      schemaVersion: PLAYWRIGHT_RUNTIME_PAYLOAD_SCHEMA_VERSION,
      kind: 'playwright-windows-headless-runtime',
      target: { platform: 'win32', arch: 'x64' },
      pins,
      archiveProvenance,
      inventory: files,
      payloadIdentity: '',
    };
    manifest.payloadIdentity = payloadIdentity(manifest);
    await writeFile(path.join(staging, PLAYWRIGHT_RUNTIME_PAYLOAD_MANIFEST), canonicalManifest(manifest), { flag: 'wx', mode: 0o644 });
    const verified = await validatePayloadAt(staging, source);
    if (verified.identity !== manifest.payloadIdentity) fail('staged runtime payload identity changed during validation.');
    if (await lstatIfExists(input.destinationPath)) fail('destinationDirectory appeared during preparation; immutable runtime payloads are never overwritten.');
    const finalParent = path.dirname(input.destinationCanonical);
    await assertNoSymlinkPath(finalParent, 'destinationDirectory parent');
    if (await realpath(finalParent) !== input.parentCanonical) fail('destinationDirectory parent changed during preparation.');
    await rename(staging, input.destinationCanonical);
    return await validatePayloadAt(input.destinationCanonical, source);
  } finally {
    if (await lstatIfExists(staging)) await rm(staging, { recursive: true, force: true });
  }
}
