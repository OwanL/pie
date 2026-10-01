#!/usr/bin/env node
// Private source-to-artifact builder. Never installs into the checkout or publishes.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PI_RUNTIME_PACKAGES, writePiRuntimeManifest, verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const OWNER = path.join(REPOSITORY, 'harness/pi-runtime');
const SOURCE = path.join(REPOSITORY, 'harness/pi');
const PACKAGE_DIRS = ['tui', 'ai', 'agent', 'coding-agent'];
const VERSION = '0.80.6';
const UPSTREAM = '2b3fda9921b5590f285165287bd442a25817f17b';
const sha = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const jsonText = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const slug = name => name.slice(name.lastIndexOf('/') + 1);

/** Derived metadata only: runtime source package.json remains its sole editable authority. */
export function sanitizePackageManifest(manifest) {
  const allowed = ['name', 'version', 'description', 'type', 'main', 'module', 'types', 'typings', 'exports',
    'imports', 'bin', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
    'engines', 'os', 'cpu', 'sideEffects', 'piConfig', 'license', 'author', 'repository', 'keywords'];
  return canonical(Object.fromEntries(allowed.filter(key => Object.hasOwn(manifest, key)).map(key => [key, manifest[key]])));
}

/** Deterministic ustar + gzip, independent of npm version, source mtimes and compiled bytes. */
export function createManifestTarball(manifest) {
  const body = Buffer.from(jsonText(sanitizePackageManifest(manifest)));
  const header = Buffer.alloc(512);
  const text = (offset, size, value) => header.write(value, offset, size, 'ascii');
  const octal = (offset, size, value) => text(offset, size, `${value.toString(8).padStart(size - 1, '0')}\0`);
  text(0, 100, 'package/package.json'); octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0);
  octal(124, 12, body.length); octal(136, 12, 0); header.fill(32, 148, 156);
  text(156, 1, '0'); text(257, 6, 'ustar\0'); text(263, 2, '00');
  text(148, 8, `${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `);
  const compressed = gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]), { level: 9 });
  compressed[9] = 255; // gzip OS=unknown: Windows/Unix produce the same manifest tarball.
  return compressed;
}

function validateManifests(manifests) {
  check(manifests.length === 4 && JSON.stringify(manifests.map(m => m.name).sort()) === JSON.stringify([...PI_RUNTIME_PACKAGES].sort()), 'Expected exactly four local Pi manifests');
  for (const manifest of manifests) check(manifest.version === VERSION, `Unexpected ${manifest.name} version`);
}
export function createRuntimeOwnerManifest(manifests) {
  validateManifests(manifests);
  return canonical({ name: 'pie-private-pi-runtime', version: '1.0.0', private: true,
    dependencies: Object.fromEntries(manifests.map(m => [m.name, `file:tarballs/${slug(m.name)}.tgz`])) });
}

/** Validate graph before npm can interpret the lock. Integrity is checked separately against derived bytes. */
export function assertRuntimeLock(lock, manifests) {
  const owner = createRuntimeOwnerManifest(manifests);
  check(lock.lockfileVersion === 3 && lock.packages, 'Expected npm runtime lockfile v3');
  check(JSON.stringify(canonical(lock.packages['']?.dependencies)) === JSON.stringify(owner.dependencies), 'Runtime lock owner drift; explicitly refresh lock');
  const expected = new Set(manifests.map(m => `node_modules/${m.name}`));
  for (const [key, record] of Object.entries(lock.packages)) {
    check(!record.link, `Runtime lock must not contain links: ${key}`);
    const isPi = /(?:^|\/)node_modules\/@(?:earendil-works|mariozechner)\/pi-[^/]+$/.test(key)
      || /^@(?:earendil-works|mariozechner)\/pi-/.test(record.name ?? '')
      || /(?:earendil-works|mariozechner)(?:\/|%2f)pi-[^/]+/i.test(record.resolved ?? '');
    if (isPi) check(expected.has(key), `Unexpected/nested Pi package: ${key}`);
    if (key && !expected.has(key)) {
      check(typeof record.version === 'string' && /^https:\/\/registry\.npmjs\.org\//.test(record.resolved ?? '') && /^sha(?:256|384|512)-/.test(record.integrity ?? ''), `Ordinary dependency must be registry-pinned with integrity: ${key}`);
    }
  }
  for (const manifest of manifests) {
    const record = lock.packages[`node_modules/${manifest.name}`];
    check(record?.version === manifest.version && record.resolved === owner.dependencies[manifest.name]
      && /^sha512-/.test(record.integrity ?? ''), `Missing/mismatched local Pi lock entry: ${manifest.name}`);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
      check(JSON.stringify(canonical(record[field] ?? {})) === JSON.stringify(canonical(manifest[field] ?? {})), `Runtime lock ${field} drift: ${manifest.name}`);
    }
  }
}

const isWithin = (file, root) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
/** New, explicitly addressed private output only; never overwrite an existing directory. */
export function assertPrivateOutput(output, repositoryRoot = REPOSITORY) {
  check(typeof output === 'string' && path.isAbsolute(output), 'Output must be an explicit absolute private path');
  const absolute = path.resolve(output);
  check(isWithin(absolute, path.resolve(os.tmpdir())) && absolute !== path.resolve(os.tmpdir()), 'Output must be a new directory beneath OS temporary storage');
  const forbidden = [repositoryRoot, path.join(os.homedir(), '.vscode'), path.join(os.homedir(), '.vscode-insiders'),
    path.join(os.homedir(), '.pi'), path.join(os.homedir(), '.config'), 'C:/dev/data'];
  check(!forbidden.some(root => isWithin(absolute, path.resolve(root))), 'Output is inside a protected live location');
  check(!/(?:^|[\\/])(?:node_modules|out|settings|data)(?:[\\/]|$)/i.test(absolute), 'Output must not target shared dependencies/output/data/settings');
  check(absolute !== path.parse(absolute).root && absolute !== path.resolve(os.homedir()), 'Output must not be a root/home directory');
  let current = absolute;
  while (true) {
    if (existsSync(current)) check(!lstatSync(current).isSymbolicLink(), `Symlink/junction output ancestor: ${current}`);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  check(!existsSync(absolute), 'Output already exists; choose a new private output');
}

/** Only process/toolchain essentials survive. No inherited provider credentials or Pie/npm overrides. */
export function buildChildEnvironment(parent, privateRoot) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive',
    'lang', 'lc_all', 'http_proxy', 'https_proxy', 'no_proxy', 'ssl_cert_file', 'node_extra_ca_certs']);
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => allowed.has(key.toLowerCase())));
  return { ...env, HOME: path.join(privateRoot, 'home'), USERPROFILE: path.join(privateRoot, 'home'),
    APPDATA: path.join(privateRoot, 'home', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(privateRoot, 'home', 'AppData', 'Local'),
    TEMP: path.join(privateRoot, 'temp'), TMP: path.join(privateRoot, 'temp'), TMPDIR: path.join(privateRoot, 'temp'),
    npm_config_cache: path.join(privateRoot, 'npm-cache') };
}

function npmCli() {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.resolve(dir, '../lib/node_modules/npm/bin/npm-cli.js'));
  }
  const found = candidates.find(file => existsSync(file));
  check(found, 'Cannot locate npm CLI beside Node/on PATH; no installation attempted');
  return realpathSync(found);
}
async function run(executable, args, cwd, env, label) {
  console.log(`[pi-runtime] ${label}`);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${label} failed (${signal ?? code})`)));
  });
}
async function npm(args, cwd, env, work) {
  await run(process.execPath, [npmCli(), ...args, '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', `--userconfig=${path.join(work, 'user.npmrc')}`, `--globalconfig=${path.join(work, 'global.npmrc')}`], cwd, env, `npm ${args.join(' ')}`);
}
async function copyTree(source, destination, exclude = []) {
  const entries = (await readdir(source, { withFileTypes: true })).filter(entry => !exclude.includes(entry.name));
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    check(!entry.isSymbolicLink(), `Refusing copy-through link: ${path.join(source, entry.name)}`);
    if (entry.isDirectory()) await copyTree(path.join(source, entry.name), path.join(destination, entry.name), exclude);
    else { check(entry.isFile(), 'Unsupported file type'); await copyFile(path.join(source, entry.name), path.join(destination, entry.name)); }
  }
}
async function snapshotSource(destination, env) {
  // Git-aware inventory includes current tracked modifications and nonignored new source,
  // never traversing mutable dist/node_modules. Read-only Git, no index mutations.
  const inventory = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'harness/pi'], { cwd: REPOSITORY, env, encoding: 'utf8' });
  const names = [...new Set(inventory.split('\0').filter(Boolean))].sort();
  check(names.length > 0, 'Imported Pi source is missing');
  const records = [];
  for (const name of names) {
    const relative = name.slice('harness/pi/'.length);
    check(!relative.split('/').some(part => ['node_modules', 'dist', '.git'].includes(part)), `Generated source inventory entry: ${name}`);
    const original = path.join(REPOSITORY, name);
    check(lstatSync(original).isFile() && !lstatSync(original).isSymbolicLink(), `Not an ordinary source file: ${name}`);
    const bytes = await readFile(original);
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    records.push([relative, sha(bytes)]);
  }
  for (const [relative, digest] of records) check(sha(await readFile(path.join(SOURCE, relative))) === digest, `Source changed while snapshotting: ${relative}; retry with stable inputs`);
  return sha(JSON.stringify(records));
}
async function prepareStubs(root, manifests) {
  await mkdir(path.join(root, 'tarballs'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), jsonText(createRuntimeOwnerManifest(manifests)));
  for (const manifest of manifests) await writeFile(path.join(root, 'tarballs', `${slug(manifest.name)}.tgz`), createManifestTarball(manifest));
}
function assertTarballIntegrity(lock, manifests) {
  for (const manifest of manifests) check(lock.packages[`node_modules/${manifest.name}`].integrity === `sha512-${sha(createManifestTarball(manifest), 'sha512', 'base64')}`, `Derived metadata changed for ${manifest.name}; run explicit --refresh-lock`);
}
async function copyRuntimeFiles(source, runtime) {
  for (let index = 0; index < PACKAGE_DIRS.length; index++) {
    const from = path.join(source, 'packages', PACKAGE_DIRS[index]);
    const to = path.join(runtime, 'node_modules', PI_RUNTIME_PACKAGES[index]);
    await copyTree(path.join(from, 'dist'), path.join(to, 'dist'));
    await copyFile(path.join(source, 'LICENSE'), path.join(to, 'LICENSE'));
    for (const name of ['README.md', 'CHANGELOG.md']) if (existsSync(path.join(from, name))) await copyFile(path.join(from, name), path.join(to, name));
    if (PACKAGE_DIRS[index] === 'tui') {
      for (const platform of ['win32', 'darwin']) await copyTree(path.join(from, 'native', platform, 'prebuilds'), path.join(to, 'native', platform, 'prebuilds'));
    }
    if (PACKAGE_DIRS[index] === 'coding-agent') {
      for (const name of ['docs', 'examples']) await copyTree(path.join(from, name), path.join(to, name), ['node_modules']);
      if (existsSync(path.join(from, 'containerization.md'))) await copyFile(path.join(from, 'containerization.md'), path.join(to, 'containerization.md'));
      const assets = ['modes/interactive/theme', 'modes/interactive/assets', 'core/export-html'];
      for (const relative of assets) {
        const copyAssets = async (dir, target) => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            check(!entry.isSymbolicLink(), 'Asset link is forbidden');
            const file = path.join(dir, entry.name), output = path.join(target, entry.name);
            if (entry.isDirectory()) await copyAssets(file, output);
            else if (/\.(json|png|html|css|js)$/.test(entry.name)) { await mkdir(target, { recursive: true }); await copyFile(file, output); }
          }
        };
        await copyAssets(path.join(from, 'src', relative), path.join(to, 'dist', relative));
      }
    }
  }
}

// Imported before SDK code, denies JS network/process escape points. Child's credential-free
// home is private; Node permissions additionally prohibit writes and subprocesses.
const DENY_NETWORK = `import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns'; import dgram from 'node:dgram'; import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{throw new Error('Network denied in Pi artifact smoke');};
net.connect=net.createConnection=net.Socket.prototype.connect=tls.connect=http.request=http.get=https.request=https.get=dgram.createSocket=deny;
for(const key of ['lookup','resolve','resolve4','resolve6']){dns[key]=deny;dns.promises[key]=deny;}
globalThis.fetch=deny;globalThis.WebSocket=class{constructor(){deny();}};syncBuiltinESMExports();\n`;
const SMOKE = `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import {realpathSync,existsSync} from 'node:fs'; import path from 'node:path'; import {pathToFileURL,fileURLToPath} from 'node:url';
assert.throws(()=>fetch('https://network-denied.invalid'),/Network denied/);
const root=path.resolve(process.argv[2]), require=createRequire(path.join(root,'smoke-owner.cjs'));
const resolve=(name,from=root)=>fileURLToPath(import.meta.resolve(name,pathToFileURL(path.join(from,'smoke-owner.mjs')).href));
const names=${JSON.stringify(PI_RUNTIME_PACKAGES)};const loaded={};
for(const name of [...names,'@earendil-works/pi-ai/compat','@earendil-works/pi-ai/oauth','@earendil-works/pi-ai/providers/openai','typebox','typebox/compile','typebox/value']){const entry=resolve(name);assert.ok(entry.startsWith(root+path.sep),entry);loaded[name]=await import(pathToFileURL(entry).href);}
const sdk=path.join(root,'node_modules/@earendil-works/pi-coding-agent');
const schema=realpathSync(resolve('typebox'));
for(const name of names){const from=path.join(root,'node_modules',name);for(const dep of names){assert.equal(realpathSync(resolve(dep,from)),realpathSync(resolve(dep)));}assert.equal(realpathSync(resolve('typebox',from)),schema);}
assert.ok(loaded['@earendil-works/pi-ai/compat'].getModel('openai','gpt-4o-mini'));
loaded['@earendil-works/pi-coding-agent'].initTheme('dark',false);
for(const rel of ['dist/core/agent-session.js','dist/core/session-manager.js','dist/core/agent-session-runtime.js','dist/core/compaction/compaction.js'])await import(pathToFileURL(path.join(sdk,rel)).href);
const photon=require('@silvia-odwyer/photon-node');const image=new photon.PhotonImage(new Uint8Array([255,0,0,255]),1,1);assert.equal(image.get_width(),1);image.free();
assert.ok(existsSync(path.join(sdk,'dist/core/export-html/vendor/marked.min.js')));
const platform=process.platform,arch=process.arch;if(['win32','darwin'].includes(platform)){const base=path.join(root,'node_modules/@earendil-works/pi-tui/native',platform,'prebuilds',platform+'-'+arch);const filename=platform==='win32'?'win32-console-mode.node':'darwin-modifiers.node';if(existsSync(path.join(base,filename)))require(path.join(base,filename));}
console.log('Pi runtime offline import/identity/theme/Photon/native smoke passed');\n`;
async function smoke(runtime, work, env) {
  const deny = path.join(work, 'deny-network.mjs'); const entry = path.join(work, 'smoke.mjs');
  await writeFile(deny, DENY_NETWORK); await writeFile(entry, SMOKE);
  const flags = ['--experimental-import-meta-resolve', '--permission', `--allow-fs-read=${work}`, `--allow-fs-read=${runtime}`, '--allow-addons', '--import', pathToFileURL(deny).href];
  await run(process.execPath, [...flags, entry, runtime], work, env, 'network-denied artifact imports/assets/native smoke');
  await run(process.execPath, [...flags, path.join(runtime, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--offline', '--version'], work, env, 'network-denied source-built local CLI --version');
}

/** Explicit output owns all scratch and artifact bytes. A failed build is retained for diagnosis. */
export async function buildPiRuntime({ output, refreshLock = false }) {
  assertPrivateOutput(output);
  await mkdir(output, { recursive: true });
  const work = path.join(output, 'work'); await mkdir(work);
  const env = buildChildEnvironment(process.env, work);
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'npm_config_cache']) await mkdir(env[key], { recursive: true });
  for (const name of ['user.npmrc', 'global.npmrc']) await writeFile(path.join(work, name), '');
  const source = path.join(work, 'source');
  const sourceTreeSha256 = await snapshotSource(source, env);
  const manifests = await Promise.all(PACKAGE_DIRS.map(dir => readJson(path.join(source, 'packages', dir, 'package.json'))));
  validateManifests(manifests);
  const install = path.join(work, 'runtime-install'); await prepareStubs(install, manifests);
  const lockFile = path.join(OWNER, 'package-lock.json');
  if (refreshLock) {
    if (existsSync(lockFile)) {
      // Preserve ordinary pins, but force npm to inspect newly derived Pi metadata
      // even when its file: URL and upstream version have not changed.
      const previous = await readJson(lockFile);
      previous.packages[''] = createRuntimeOwnerManifest(manifests);
      delete previous.packages[''].private;
      for (const name of PI_RUNTIME_PACKAGES) delete previous.packages[`node_modules/${name}`];
      await writeFile(path.join(install, 'package-lock.json'), jsonText(previous));
    }
    await npm(['install', '--package-lock-only'], install, env, work);
    const lock = await readJson(path.join(install, 'package-lock.json')); assertRuntimeLock(lock, manifests); assertTarballIntegrity(lock, manifests);
    await mkdir(OWNER, { recursive: true });
    await copyFile(path.join(install, 'package.json'), path.join(OWNER, 'package.json'));
    await copyFile(path.join(install, 'package-lock.json'), lockFile);
    console.log(`[pi-runtime] Refreshed derived runtime dependency authority only; private evidence: ${output}`);
    return { output, refreshedLock: true };
  }
  check(existsSync(lockFile), 'Runtime dependency lock missing; explicitly run --refresh-lock first');
  check((await readFile(path.join(OWNER, 'package.json'), 'utf8')) === jsonText(createRuntimeOwnerManifest(manifests)), 'Derived runtime owner manifest drift; explicitly refresh lock');
  const lockBytes = await readFile(lockFile); const lock = JSON.parse(lockBytes); assertRuntimeLock(lock, manifests); assertTarballIntegrity(lock, manifests);
  await writeFile(path.join(install, 'package-lock.json'), lockBytes);
  await npm(['ci'], source, env, work);
  const compiler = path.join(source, 'node_modules/@typescript/native-preview/bin/tsgo.js');
  check(existsSync(compiler), 'Pinned source compiler missing after scripts-disabled install');
  for (const dir of PACKAGE_DIRS) await run(process.execPath, [compiler, '-p', 'tsconfig.build.json'], path.join(source, 'packages', dir), env, `compile ${dir} (retained generated source)`);
  await npm(['ci'], install, env, work);
  const runtime = path.join(output, 'pi-runtime'); await mkdir(runtime);
  await copyTree(path.join(install, 'node_modules'), path.join(runtime, 'node_modules'));
  await copyRuntimeFiles(source, runtime);
  await smoke(runtime, work, env);
  const verified = await writePiRuntimeManifest(runtime, { upstreamVersion: VERSION, upstreamCommit: UPSTREAM,
    sourceTreeSha256, lockSha256: sha(lockBytes), target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } });
  await verifyPiRuntimeArtifact(runtime);
  await writeFile(path.join(output, 'build-evidence.json'), jsonText({ identity: verified.identity, sdkPath: verified.sdkPath,
    sourceTreeSha256, buildLockSha256: sha(await readFile(path.join(source, 'package-lock.json'))), runtimeLockSha256: sha(lockBytes), node: process.version, offlineSmoke: true }));
  console.log(`[pi-runtime] Verified ${verified.identity}\n${runtime}`);
  return verified;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('node scripts/build/pi-runtime.mjs --output <new-absolute-private-directory> [--refresh-lock]\nDefault: private snapshot/install/compile/materialize/offline smoke/verify. --refresh-lock: explicit dependency metadata refresh only. Never deploys.');
  else {
    const outputIndex = args.indexOf('--output');
    check(outputIndex >= 0 && args[outputIndex + 1], 'Required --output <new-absolute-private-directory>');
    const valid = args.filter((_, i) => i !== outputIndex && i !== outputIndex + 1);
    check(valid.every(arg => arg === '--refresh-lock'), 'Unknown builder argument');
    buildPiRuntime({ output: args[outputIndex + 1], refreshLock: args.includes('--refresh-lock') }).catch(error => { console.error(error); process.exitCode = 1; });
  }
}
