import Module, { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import threads, { parentPort } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Audited SDK worker returns {result} / {error}, without request IDs. Core uses
// exif-orientation and photon; photon uses createRequire('fs') and reads WASM.
// Deliberately only suitable for that verified graph, not arbitrary hostile JS.
const workerPath = process.env.PIE_IMAGE_WORKER_PATH;
delete process.env.PIE_IMAGE_WORKER_PATH;
const post = parentPort.postMessage.bind(parentPort);
function deny(reason) {
  post({ __pieImageWorkerDenial: `image-worker: ${reason}` });
  throw new Error(`image-worker denied: ${reason}`);
}
const canonical = fs.realpathSync.native.bind(fs.realpathSync);
const root = dirname(workerPath);
const allowedFiles = new Set([workerPath, ...['image-resize-core.js', 'exif-orientation.js', 'photon.js'].map(name => join(root, name))].map(path => pathToFileURL(path).href));
let photon;
try { photon = createRequire(pathToFileURL(workerPath)).resolve('@silvia-odwyer/photon-node'); allowedFiles.add(pathToFileURL(photon).href); } catch { /* absence yields null in SDK */ }
const allowedBuiltins = new Set(['worker_threads', 'module', 'path', 'url', 'fs', 'fs/promises', 'util', 'buffer', 'assert']);
const load = Module._load;
Module._load = function(specifier, parent, ...rest) {
  const name = specifier.replace(/^node:/, '');
  if (!allowedBuiltins.has(name)) {
    let resolved;
    try { resolved = Module._resolveFilename(specifier, parent); } catch { return deny(`import ${specifier}`); }
    if (!allowedFiles.has(pathToFileURL(resolved).href)) return deny(`import ${specifier}`);
  }
  return load.call(this, specifier, parent, ...rest);
};
registerHooks({ resolve(specifier, context, next) {
  const name = specifier.replace(/^node:/, '');
  if (allowedBuiltins.has(name)) return next(specifier, context);
  let resolved;
  try { resolved = next(specifier, context); } catch { return deny(`import ${specifier}`); }
  const permitted = allowedFiles.has(resolved.url) || (resolved.url.startsWith('file:') && [...allowedFiles].some(url => canonical(fileURLToPath(url)) === canonical(fileURLToPath(resolved.url))));
  if (!permitted) return deny(`import ${specifier}`);
  return resolved;
} });
const read = fs.readFileSync.bind(fs);
const openSync = fs.openSync.bind(fs), readSync = fs.readSync.bind(fs);
let auditedRead = false;
fs.readFileSync = function(path, ...args) {
  const file = path instanceof URL ? fileURLToPath(path) : path;
  if (typeof file !== 'string' || (!allowedFiles.has(pathToFileURL(file).href) && file !== (photon && join(dirname(photon), 'photon_rs_bg.wasm')))) return deny('filesystem read');
  auditedRead = true;
  try { return read(path, ...args); } finally { auditedRead = false; }
};
// No worker-facing filesystem operations except the one audited WASM read.
for (const target of [fs, fsp]) {
  for (const key of Object.keys(target)) {
    if (typeof target[key] !== 'function' || !/^(write|append|truncate|ftruncate|unlink|rm|rmdir|mkdir|mkdtemp|rename|copy|cp|link|symlink|chmod|chown|lchmod|lchown|fchmod|fchown|utimes|futimes|lutimes|open|createWriteStream|readFile$|readFileSync$|read$|readSync$|readv|createReadStream|readdir|opendir|watch)/.test(key)) continue;
    if (target === fs && key === 'readFileSync') continue;
    if (key === 'constants') continue;
    if (!Object.getOwnPropertyDescriptor(target, key)?.writable) continue;
    target[key] = () => deny(`filesystem ${key}`);
  }
}
fs.openSync = (...args) => auditedRead && (args[1] === 'r' || args[1] === 0) ? openSync(...args) : deny('filesystem openSync');
fs.readSync = (...args) => auditedRead ? readSync(...args) : deny('filesystem readSync');
fs.existsSync = path => { if (path !== (photon && join(dirname(photon), 'photon_rs_bg.wasm'))) return deny('filesystem exists'); return true; };
threads.Worker = class { constructor() { deny('nested worker'); } };
globalThis.fetch = () => deny('fetch');
for (const key of ['WebSocket', 'EventSource']) if (key in globalThis) globalThis[key] = class { constructor() { deny(key); } };
process.dlopen = () => deny('native addon');
process.binding = () => deny('process binding');
syncBuiltinESMExports();
