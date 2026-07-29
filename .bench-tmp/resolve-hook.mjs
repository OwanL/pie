import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.cjs'];
// TS ESM interop: './x.js' may mean './x.ts'; './x.jsx' -> './x.tsx', etc.
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.cjs': ['.cts'], '.mjs': ['.mts'] };

function tryFile(p) {
  try { if (existsSync(p) && statSync(p).isFile()) return p; } catch {}
  return null;
}

function resolveExtensions(dir, base) {
  for (const ext of TS_EXTS) {
    const found = tryFile(path.resolve(dir, base + ext));
    if (found) return found;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
  if (!isRelative) return next(specifier, context);
  const dir = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd();
  const ext = path.extname(specifier);

  // 1) Extensionless -> try all TS/JS extensions + index
  if (ext === '') {
    const found = resolveExtensions(dir, specifier);
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
    const dirCandidate = path.resolve(dir, specifier);
    if (existsSync(dirCandidate) && statSync(dirCandidate).isDirectory()) {
      const idx = resolveExtensions(dirCandidate, 'index');
      if (idx) return { url: pathToFileURL(idx).href, shortCircuit: true };
    }
    return next(specifier, context);
  }

  // 2) './x.js' literal missing -> rewrite to './x.ts' etc.
  if (JS_TO_TS[ext]) {
    const literal = path.resolve(dir, specifier);
    if (tryFile(literal)) return next(specifier, context); // real .js exists, keep it
    const base = specifier.slice(0, -ext.length);
    for (const tsExt of JS_TO_TS[ext]) {
      const found = tryFile(path.resolve(dir, base + tsExt));
      if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
