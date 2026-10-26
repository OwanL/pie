import Module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Copy descriptors, never read a native property or retain a native prototype. */
export function createDeniedFacade(source, deny) {
  const memo = new Map();
  const copy = (value, label) => {
    if (value === null || !['object', 'function'].includes(typeof value)) return value;
    if (memo.has(value)) return memo.get(value);
    // A bound ordinary function has no own caller/arguments/prototype slots.
    // Its configurable name/length can safely be replaced with copied metadata.
    const target = typeof value === 'function' ? (function () { return deny(label)(); }).bind(null) : {};
    memo.set(value, target);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const childLabel = `${label}.${String(key)}`;
      const replacement = 'value' in descriptor
        ? { ...descriptor, value: copy(descriptor.value, childLabel) }
        : { enumerable: descriptor.enumerable, configurable: descriptor.configurable,
            ...(descriptor.get ? { get: deny(`${childLabel}.get`) } : {}),
            ...(descriptor.set ? { set: deny(`${childLabel}.set`) } : {}) };
      Object.defineProperty(target, key, replacement);
    }
    return target;
  };
  return copy(source, 'keyring');
}

/** Install exact-route facades before any package factories are imported. */
export function installKeyringFacade({ require, entry, nativeEntry, roots, canonical, deny }) {
  const native = require(nativeEntry);
  const facade = createDeniedFacade(native, deny);
  const nativeId = require.resolve(nativeEntry), entryId = require.resolve(entry);
  if (!require.cache[nativeId]) throw Error('native require cache missing');
  require.cache[nativeId].exports = facade;
  require.cache[entryId] = { id: entryId, filename: entryId, loaded: true, exports: facade };
  const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (typeof resolved === 'string' && path.isAbsolute(resolved)) {
      const file = canonical(resolved);
      if (file === entry || file === nativeEntry) return facade;
      if (roots.some(root => file === root || inside(root, file)) || /(?:^|[\\/])@napi-rs[\\/]keyring[^\\/]*(?:[\\/]|$)/i.test(file)) return deny(`keyring.load ${file}`)();
    }
    return originalLoad.apply(this, arguments);
  };
  const loadNative = Module._extensions['.node'];
  Module._extensions['.node'] = function (module, filename) {
    if (/keyring/i.test(filename)) return deny(`keyring.native ${filename}`)();
    return loadNative(module, filename);
  };
  return { facade, restore() { Module._load = originalLoad; Module._extensions['.node'] = loadNative; } };
}

/** Import the real wrapper source for Node's ESM named-export discovery.
 * No credential method, accessor, constructor or facade function is invoked.
 */
export async function probeKeyringBindings({ require, entry, nativeEntry, facade }) {
  const esm = await import(pathToFileURL(entry));
  const wrapper = require(entry), native = require(nativeEntry);
  const names = Object.keys(esm).filter(name => name !== 'default' && name !== 'module.exports');
  const facts = {
    moduleExportLoad: { esmWrapper: true, cjsWrapper: true, cjsNative: true },
    facadeBinding: {
      esmDefault: esm.default === facade,
      esmNamed: names.length > 0 && names.every(name => {
        const descriptor = Object.getOwnPropertyDescriptor(facade, name);
        return descriptor && 'value' in descriptor && esm[name] === descriptor.value;
      }),
      cjsWrapper: wrapper === facade, cjsNative: native === facade,
    },
  };
  if (!Object.values(facts.facadeBinding).every(Boolean)) throw Error('keyring facade binding mismatch');
  return facts;
}
