// Isolated managed-native probe. Invoke with one JSON configuration argument.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const config = JSON.parse(process.argv[2]);
for (const key of ['stageRoot', 'workDir', 'resultPath']) {
  if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) {
    throw new Error(`Expected absolute ${key}`);
  }
}
const stageRoot = fs.realpathSync(config.stageRoot);
process.chdir(config.workDir);
const stagedRequire = createRequire(path.join(stageRoot, 'package.json'));
const denied = [];
const observed = [];
const children = new Set();
let api;
let failure;
let result;
const deny = (name) => function () {
  denied.push(name);
  throw new Error(`Managed recheck probe denied ${name}`);
};
const insideStage = (filename) => {
  const canonical = fs.realpathSync(filename);
  const relative = path.relative(stageRoot, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Resolved outside stage: ${filename}`);
  }
  return canonical;
};

// Install before loading any staged code; no network, listening, or IPC transport.
for (const [module, names] of [
  ['node:net', ['connect', 'createConnection', 'createServer']],
  ['node:tls', ['connect', 'createServer']],
  ['node:http', ['request', 'get', 'createServer']],
  ['node:https', ['request', 'get', 'createServer']],
  ['node:http2', ['connect', 'createServer', 'createSecureServer']],
  ['node:dgram', ['createSocket']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']],
]) {
  const target = require(module);
  for (const name of names) target[name] = deny(`${module}.${name}`);
}
require('node:net').Socket.prototype.connect = deny('Socket.connect');
require('node:net').Server.prototype.listen = deny('Server.listen');
for (const name of Object.keys(require('node:dns').promises)) {
  if (typeof require('node:dns').promises[name] === 'function') {
    require('node:dns').promises[name] = deny(`dns.promises.${name}`);
  }
}
globalThis.fetch = deny('fetch');
globalThis.WebSocket = deny('WebSocket');
require('node:worker_threads').Worker = deny('Worker');
const cp = require('node:child_process');
const originalSpawn = cp.spawn;
const originalPrototypeSpawn = cp.ChildProcess.prototype.spawn;
let allowingSpawn = false;
cp.ChildProcess.prototype.spawn = function (...args) {
  if (!allowingSpawn) return deny('ChildProcess.spawn')();
  return originalPrototypeSpawn.apply(this, args);
};
for (const name of Object.keys(cp)) {
  if (typeof cp[name] === 'function' && name !== 'spawn') cp[name] = deny(`child_process.${name}`);
}
let executable;
cp.spawn = function (command, args, options) {
  let canonical;
  try {
    if (typeof command !== 'string' || !path.isAbsolute(command)) throw new Error('PATH lookup');
    canonical = insideStage(command);
    if (canonical !== executable || observed.length !== 0 ||
        JSON.stringify(args) !== '["agent"]' || options?.shell ||
        JSON.stringify(options?.stdio) !== '["pipe","pipe","inherit"]') {
      throw new Error('Not allowlisted');
    }
  } catch {
    return deny(`child_process.spawn:${String(command)}`)();
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(canonical)).digest('hex');
  allowingSpawn = true;
  let child;
  try {
    child = originalSpawn(canonical, args, { ...options, cwd: config.workDir, shell: false });
  } finally {
    allowingSpawn = false;
  }
  children.add(child);
  child.once('spawn', () => observed.push({ executable: canonical, sha256 }));
  return child;
};
syncBuiltinESMExports();

// The native agent persists between checks. Own its lifetime rather than waiting
// for its unref'ed handles; also bound startup/ping failures independently.
const deadline = setTimeout(() => {
  failure = new Error('Managed recheck probe timed out');
  finish();
}, 15000);
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  api?.__mock__?.pool?.kill();
  api?.__mock__?.agent?.kill();
  for (const child of children) {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill();
  }
  fs.writeFileSync(config.resultPath, `${JSON.stringify({
    ok: !failure, observed, result, denied,
    ...(failure ? { error: failure.stack ?? String(failure) } : {}),
  }, null, 2)}\n`);
  process.exitCode = failure ? 1 : 0;
}
try {
  const packagePath = insideStage(stagedRequire.resolve('recheck/package.json'));
  if (JSON.parse(fs.readFileSync(packagePath, 'utf8')).version !== '4.5.0') {
    throw new Error('Expected recheck@4.5.0');
  }
  const nativePackage = insideStage(stagedRequire.resolve('recheck-windows-x64/package.json'));
  executable = insideStage(path.join(path.dirname(nativePackage), 'recheck.exe'));
  process.env.RECHECK_BACKEND = 'native';
  process.env.RECHECK_BIN = executable;
  delete process.env.RECHECK_JAR;
  api = stagedRequire(insideStage(stagedRequire.resolve('recheck')));
  result = await api.check('^a+$', '', { timeout: 3000 });
  if (result?.status !== 'safe' || observed.length !== 1 || denied.length !== 0) {
    throw new Error('Expected safe result from exactly one allowlisted native spawn and no denied operations');
  }
} catch (error) {
  failure = error;
} finally {
  finish();
}
