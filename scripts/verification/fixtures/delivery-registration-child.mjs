import fs from 'node:fs';
import {createHash} from 'node:crypto';
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

let phase = 'imports';
// Bootstrap remains fail-closed while importing the diagnostic recorder below.
let recordDenial = kind => { process.exitCode = 1; denied.push(kind); };
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
for (const name of ['kill','_kill']) if (typeof process[name] === 'function') process[name] = deny('process.'+name);
syncBuiltinESMExports();
const configBytes = fs.readFileSync(process.argv[2], 'utf8');
if (createHash('sha256').update(configBytes).digest('hex') !== process.argv[3]) throw Error('sealed config digest mismatch');
const config = JSON.parse(configBytes);
const { defaultsFromInventories, validatePrivateEnvironment, loadDefaults, assertRegistration, registerExitReport, createDenialRecorder } = await import('../lib/delivery-registration.mjs');
recordDenial = createDenialRecorder({ process, denied, denyDiagnostics, phase: () => phase });
const report = { ok: false, errors: [], denied, denyDiagnostics, requests: [] };

const assert = (condition, message) => { if (!condition) throw Error(message); };
try {
  validatePrivateEnvironment(config, process.env, process.cwd());
  for (const value of Object.values(config.dirs)) { assert(fs.realpathSync(value) === value, 'private directory redirected'); assert(fs.readdirSync(value).length === 0, 'private directory not fresh'); }
  assert(config.noProvider === true, 'registration-only/no-provider contract required');
  const core = JSON.parse(fs.readFileSync(path.join(config.stageRoot,'resources/bundled-extensions.json'),'utf8'));
  const managed = JSON.parse(fs.readFileSync(path.join(config.stageRoot,'resources/managed-integrations/manifest.json'),'utf8'));
  assert(JSON.stringify(config.defaults) === JSON.stringify(defaultsFromInventories(config.stageRoot,core,managed)), 'sealed defaults mismatch');
  assert(managed.runtimeIdentity === config.identity.piRuntimeIdentity, 'runtime marker binding mismatch');
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
  assert(writableRoots.some(root => inside(root, resultPath)), 'resultPath outside private writable roots');
  assert(path.isAbsolute(config.agentDir) && inside(canonical(config.privateRoot), canonical(config.agentDir)), 'agentDir outside private root');
  assert(config.defaults?.length === 14 && new Set(config.defaults.map(item => item.path)).size === 14, 'exact14 distinct defaults required');
  for (const item of config.defaults) assert(path.isAbsolute(item.path) && inside(stage, realpath(item.path)), 'default outside verified stage');
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
  phase = 'factories';
  const sdk = await import(pathToFileURL(config.sdkEntry));
  const loaded = await loadDefaults(sdk.DefaultResourceLoader, config);
  report.extensions = assertRegistration(loaded, config.defaults);
  assert(denied.length === 0, 'unexpected denied operation');
  report.ok = true;
} catch (error) {
  report.errors.push({ message: error.message, stack: error.stack }); process.exitCode = 1;
}
// Finalize synchronously only at genuine process exit, after factory exit handlers.
// Fire-and-forget work can append swallowed denials after reload has returned.
registerExitReport({ process, report, resultPath: config.resultPath, writeSync: fs.writeFileSync });
