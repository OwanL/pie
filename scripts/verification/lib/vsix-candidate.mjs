import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createOwnerRequire } from '../../lib/package-resolution.mjs';
import { verifyPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';

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

/** Validate every ZIP entry; extract only extension/ into an empty private directory. */
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
  const yauzl = createRequire(ownerRequire.resolve('@vscode/vsce/package.json'))('yauzl');
  const zip = await new Promise((resolve, reject) => yauzl.open(file, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false,
  }, (error, value) => error ? reject(error) : resolve(value)));
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
    zip.close();
  }
}

/** Verify the extracted extension and return only its release identity. */
export async function verifyCandidateIdentity(destination) {
  const pkg = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'));
  if (pkg.publisher !== 'pie' || pkg.name !== 'pie' || pkg.main !== './runtime/bootstrap.cjs'
    || typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error('Invalid candidate package identity');
  const buildId = (await readFile(path.join(destination, 'out/pie-build-id.txt'), 'utf8')).trim();
  const panelBuildId = (await readFile(path.join(destination, 'out/webview/panel/pie-build-id.txt'), 'utf8')).trim();
  if (!/^[a-f0-9]{20}$/.test(buildId) || panelBuildId !== buildId) throw new Error('Candidate build IDs must be matching 20-hex identifiers');
  const runtime = await verifyPiRuntimeArtifact(path.join(destination, 'out/pi-runtime'));
  return { extensionId: 'pie.pie', version: pkg.version, buildId, piRuntimeIdentity: runtime.identity };
}
