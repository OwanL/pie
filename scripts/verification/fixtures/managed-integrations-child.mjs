/** Trusted, provider-free qualifier. Usage: node managed-integrations-child.mjs CONFIG.json
 * Required absolute paths: stageRoot, runtimeRoot, privateRoot, sdkEntry, webRoot, mcpRoot, keyringEntry,
 * keyringNativeEntry, workDir, resultPath. keyringNativeEntry is the exact pinned
 * .node file. Parent supplies an empty private environment (HOME/USERPROFILE,
 * APPDATA/LOCALAPPDATA, TMP/TEMP, PI_CODING_AGENT_DIR, PI_OFFLINE=1) and a fresh workDir outside
 * the immutable stage. Result JSON: ok, errors, denied, requests, identity,
 * extensions, results, legacySmoke. No events emitted and no tools executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dgram from 'node:dgram';
import cp from 'node:child_process';
import workerThreads from 'node:worker_threads';

const denied = [];
const denyDiagnostics = [];
const nativeWorker = workerThreads.Worker;
let phase = 'imports';
const recordDenial = kind => {
  denied.push(kind);
  if (denyDiagnostics.length < 100) denyDiagnostics.push({ kind, phase, stack: new Error(`DENIED ${kind}`).stack?.split('\n').slice(0, 12).join('\n').slice(0, 2000) });
};
const deny = kind => function () { recordDenial(kind); throw new Error(`DENIED ${kind}`); }; 
// Installed before any SDK, managed-package, native or fixture-helper imports.
for (const [object, names, kind] of [
  [net, ['connect', 'createConnection', 'createServer'], 'net'],
  [net.Socket.prototype, ['connect'], 'socket'],
  [net.Server.prototype, ['listen'], 'listen'],
  [tls, ['connect', 'createServer'], 'tls'],
  [http, ['request', 'get', 'createServer'], 'http'],
  [https, ['request', 'get', 'createServer'], 'https'],
  [http2, ['connect', 'createServer', 'createSecureServer'], 'http2'],
  [dgram, ['createSocket'], 'udp'],
  [cp, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'process'],
  [cp.ChildProcess.prototype, ['spawn'], 'process.prototype'],
  [workerThreads, ['Worker'], 'worker'],
]) for (const name of names) object[name] = deny(`${kind}.${name}`);
for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(object)) if (/^(lookup|resolve|reverse|setServers)/.test(name) && typeof object[name] === 'function') object[name] = deny(`dns.${name}`);
}
for (const name of ['fetch', 'WebSocket', 'EventSource']) globalThis[name] = deny(name);
syncBuiltinESMExports();
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const report = { ok: false, errors: [], denied, denyDiagnostics, requests: [] };
let imageWorkerGuard;
const assert = (condition, message) => { if (!condition) throw Error(message); };
try {
  for (const key of ['stageRoot','runtimeRoot','privateRoot','sdkEntry','webRoot','mcpRoot','keyringEntry','keyringNativeEntry','workDir','resultPath']) assert(typeof config[key] === 'string' && path.isAbsolute(config[key]), `absolute ${key} required`);
  const stage = fs.realpathSync(config.stageRoot);
  const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const runtime = fs.realpathSync(config.runtimeRoot);
  assert(inside(runtime, fs.realpathSync(config.sdkEntry)), 'sdkEntry outside runtimeRoot');
  for (const key of ['webRoot','mcpRoot','keyringEntry','keyringNativeEntry']) assert(inside(stage, fs.realpathSync(config[key])), `${key} outside stage`);
  assert(!inside(stage, fs.realpathSync(config.workDir)) && fs.realpathSync(config.workDir) !== stage, 'workDir must be outside stage');
  assert(fs.readdirSync(config.workDir).length === 0, 'workDir must be fresh');
  assert(process.env.PI_OFFLINE === '1', 'parent must set PI_OFFLINE=1');
  // Resolve existing ancestors too: a writable directory must not use a symlink
  // to reach the immutable stage/runtime (including for not-yet-created files).
  const realpath = fs.realpathSync.bind(fs);
  const canonical = value => {
    let file = path.resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
    const tail = [];
    while (true) {
      try { return path.join(realpath(file), ...tail.reverse()); }
      catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
      const parent = path.dirname(file);
      if (parent === file) throw Error('cannot resolve write path');
      tail.push(path.basename(file)); file = parent;
    }
  };
  const writableRoots = [config.workDir, config.privateRoot].map(canonical);
  for (const root of writableRoots) assert(![stage, runtime].some(protectedRoot => root === protectedRoot || inside(protectedRoot, root) || inside(root, protectedRoot)), 'writable root overlaps immutable tree');
  const resultPath = canonical(config.resultPath);
  const checkWrite = value => {
    if (typeof value === 'number') { if (!writableFds.has(value)) deny('fs.write fd')(); return; }
    const file = canonical(value);
    if ([stage, runtime].some(root => file === root || inside(root, file)) || !(file === resultPath || writableRoots.some(root => file === root || inside(root, file)))) deny(`fs.write ${file}`)();
  };
  const writableFds = new Set();
  const writes = flags => typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags ?? 'r');
  for (const name of ['appendFile','writeFile','truncate','chmod','chown','utimes','unlink','rm','rmdir','mkdir','mkdtemp','rename','copyFile','cp','link','symlink','lchmod','lchown','lutimes','fchmod','fchown','ftruncate','futimes','write','writev']) {
    for (const object of [fs, fs.promises]) for (const method of [name, `${name}Sync`]) {
      if (typeof object[method] !== 'function') continue;
      const original = object[method];
      object[method] = function (...args) {
        checkWrite(args[0]);
        if (['rename','copyFile','cp','link','symlink'].includes(name)) checkWrite(args[1]);
        // Symlinks are unnecessary for these fixtures; disallow creating escapes.
        if (name === 'symlink') deny('fs.symlink')();
        return original.apply(this, args);
      };
    }
  }
  for (const object of [fs, fs.promises]) {
    const open = object.open;
    object.open = function (...args) {
      const writing = writes(args[1]);
      if (writing) checkWrite(args[0]);
      if (object === fs) {
        const callback = args.at(-1);
        args[args.length - 1] = (error, fd) => { if (!error && writing) writableFds.add(fd); callback(error, fd); };
        return open.apply(this, args);
      }
      return open.apply(this, args).then(handle => {
        if (writing) writableFds.add(handle.fd);
        for (const method of ['appendFile','writeFile','write','writev','truncate','chmod','chown','utimes','createWriteStream']) {
          const original = handle[method];
          if (typeof original === 'function') handle[method] = function (...values) { checkWrite(handle.fd); return original.apply(this, values); };
        }
        const close = handle.close;
        handle.close = function (...values) { writableFds.delete(handle.fd); return close.apply(this, values); };
        return handle;
      });
    };
  }
  const openSync = fs.openSync;
  fs.openSync = function (file, flags, ...rest) { const writing = writes(flags); if (writing) checkWrite(file); const fd = openSync.call(this, file, flags, ...rest); if (writing) writableFds.add(fd); return fd; };
  for (const method of ['close','closeSync']) {
    const original = fs[method];
    fs[method] = function (fd, ...args) { writableFds.delete(fd); return original.call(this, fd, ...args); };
  }
  for (const method of ['createWriteStream','createReadStream']) {
    const original = fs[method];
    fs[method] = function (file, options) {
      if (method === 'createWriteStream' || writes(options?.flags)) checkWrite(options?.fd ?? file);
      return original.call(this, file, options);
    };
  }
  syncBuiltinESMExports();
  const require = createRequire(pathToFileURL(config.mcpRoot + '/package.json'));
  assert(fs.realpathSync(require.resolve('@napi-rs/keyring')) === fs.realpathSync(config.keyringEntry), 'keyring entry mismatch');
  assert(process.platform === 'win32' && process.arch === 'x64', 'only pinned Windows x64 binding qualified');
  const nativePackage = require.resolve('@napi-rs/keyring-win32-x64-msvc/package.json');
  assert(fs.realpathSync(path.join(path.dirname(nativePackage), 'keyring.win32-x64-msvc.node')) === fs.realpathSync(config.keyringNativeEntry), 'native binding mismatch');
  assert(config.keyringNativeEntry.endsWith('.node'), 'exact native binding required');
  const { installKeyringFacade, probeKeyringBindings } = await import('./keyring-denied-facade.mjs');
  const entry = realpath(config.keyringEntry), nativeEntry = realpath(config.keyringNativeEntry);
  const { facade } = installKeyringFacade({ require, entry, nativeEntry,
    roots: [path.dirname(entry), path.dirname(nativePackage)].map(file => realpath(file)), canonical, deny });
  phase = 'keyring';
  Object.assign(report, await probeKeyringBindings({ require, entry, nativeEntry, facade }));
  assert(denied.length === 0, 'keyring binding probe attempted a denied operation');
  const workerPath = realpath(path.join(path.dirname(config.sdkEntry), 'utils', 'image-resize-worker.js'));
  assert(inside(runtime, workerPath), 'image worker outside runtimeRoot');
  const { createImageWorkerGuard } = await import('./image-worker-guard.mjs');
  imageWorkerGuard = createImageWorkerGuard({ workerPath, env: { ...process.env }, deny: recordDenial, nativeWorker });
  workerThreads.Worker = imageWorkerGuard.Worker;
  syncBuiltinESMExports();
  phase = 'factories';
  const sdk = await import(pathToFileURL(config.sdkEntry));
  const sdkRequire = createRequire(pathToFileURL(config.sdkEntry));
  const typebox = await import(pathToFileURL(sdkRequire.resolve('typebox')));
  const { staticFixtures } = await import('./managed-integrations-static.mjs');
  const fixtures = staticFixtures();
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const fixture = fixtures.get(url);
    if (!fixture || (init?.method && init.method !== 'GET')) return deny(`fetch ${url}`)();
    report.requests.push(url);
    return new Response(fixture[1], { status: 200, headers: { 'content-type': fixture[0] } });
  };
  const q = globalThis.__managedIntegrationQualification = { sdk, typebox, urls: [...fixtures.keys()] };
  globalThis.__managedIntegrationPhase = value => { phase = value; };
  const probe = path.join(config.workDir, 'probe.ts');
  fs.writeFileSync(probe, `import {resizeImage as current} from '@earendil-works/pi-coding-agent';
import {resizeImage as legacy} from '@mariozechner/pi-coding-agent';
import {Type as currentType} from 'typebox';
import {Type as legacyType} from '@sinclair/typebox';
import {fetchAllContent} from ${JSON.stringify(path.join(config.webRoot, 'extract.ts').replaceAll('\\', '/'))};
export default async function(){const q=globalThis.__managedIntegrationQualification;q.identity=current===q.sdk.resizeImage&&legacy===current&&currentType===legacyType&&currentType===q.typebox.Type;globalThis.__managedIntegrationPhase('static-extraction');q.results=await fetchAllContent(q.urls,undefined,{lookup:async(host)=>{if(host!=='fixture.example')throw Error('unexpected lookup');return [{address:'93.184.216.34',family:4}];}});}`);
  const loaderFor = (dir, options) => {
    const cwd = path.join(dir, 'cwd'), agentDir = path.join(dir, 'agent');
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(agentDir, { recursive: true });
    return new sdk.DefaultResourceLoader({ cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, ...options });
  };
  const loader = loaderFor(config.workDir, { additionalExtensionPaths: [config.webRoot, config.mcpRoot, probe] });
  phase = 'factories';
  await loader.reload();
  const loaded = loader.getExtensions();
  report.extensions = loaded.extensions.map(extension => ({ path: extension.path, tools: [...extension.tools.keys()] }));
  report.errors.push(...loaded.errors);
  report.identity = q.identity;
  report.results = q.results;
  assert(!loaded.errors.length && loaded.extensions.length >= 3, 'managed factory load failed');
  assert(q.identity, 'SDK/typebox peer identity failed');
  assert(q.results?.length === 3 && q.results.every(result => !result.error), 'extraction failed');
  assert(q.results[0].content.includes('Qualification paragraph'), 'HTML text missing');
  const pdfPath = q.results[1].content.match(/saved to: (.+)/)?.[1];
  assert(pdfPath && fs.readFileSync(pdfPath, 'utf8').includes('Private static PDF qualification text'), 'PDF text missing');
  assert(q.results[2].thumbnail, 'PNG thumbnail missing');
  assert(report.requests.length === 3, 'unexpected fetch count');
  phase = 'legacy-smoke';
  report.legacySmoke = [];
  for (const disabled of [false, true]) {
    const dir = path.join(config.workDir, disabled ? 'legacy-disabled' : 'legacy-missing');
    fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
    const source = 'npm:pie-qualification-missing@0.0.0';
    fs.mkdirSync(path.join(dir, 'cwd', '.pi'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cwd', '.pi', 'settings.json'), JSON.stringify({ packages: disabled ? [{ source, extensions: [] }] : [source] }));
    const fallback = path.join(dir, 'fallback.ts');
    fs.writeFileSync(fallback, 'export default function(){globalThis.__managedFallbackRan=true;}');
    globalThis.__managedFallbackRan = false;
    const smoke = loaderFor(dir, { defaultExtensions: [{ path: fallback, legacyPaths: [], legacyPackageSources: ['npm:pie-qualification-missing'] }] });
    await smoke.reload({ resolveProjectTrust: async () => true });
    assert(!globalThis.__managedFallbackRan, 'legacyPackageSources ignored');
    assert(!smoke.getExtensions().extensions.some(extension => extension.path === fallback), 'legacy fallback discovered');
    report.legacySmoke.push({ scope: 'project', disabled, suppressed: true, errors: smoke.getExtensions().errors });
  }
  assert(denied.length === 0, 'denied operation attempted');
  const workers = await imageWorkerGuard.settle();
  report.imageWorker = workers;
  assert(workers.length > 0 && workers.some(worker => worker.results > 0 && worker.exited && (worker.exitCode === 0 || worker.terminated)), 'real image worker result and teardown not confirmed');
  report.ok = true;
} catch (error) {
  report.errors.push({ message: error.message, stack: error.stack });
  if (imageWorkerGuard) {
    try { report.imageWorker = await imageWorkerGuard.settle(); }
    catch (settleError) { report.imageWorkerSettleError = { message: settleError.message }; }
  }
  process.exitCode = 1;
}
fs.writeFileSync(config.resultPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
