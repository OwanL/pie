'use strict';

// Preload only: observe the bytes V8 compiled, never transpile or start a Profiler.
// NODE_OPTIONS inheritance gives every child process / worker its own recorder.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { TextDecoder } = require('node:util');
const { Session } = require('node:inspector');
const { threadId } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// The process-isolated native test coordinator executes no test files and has
// no V8 inspector. Children (NODE_TEST_CONTEXT set) and isolation=none still
// need capture, and any initialization failure in those roles remains fatal.
const singleProcess = process.execArgv.some((arg, index, args) =>
  arg === '--experimental-test-isolation=none'
  || (arg === '--experimental-test-isolation' && args[index + 1] === 'none'));
if (process.execArgv.includes('--test') && !singleProcess && process.env.NODE_TEST_CONTEXT === undefined) {
  return;
}

const directory = process.env.PIE_TEST_COVERAGE_DIR;
const root = process.env.PIE_TEST_COVERAGE_ROOT;
const ownerCwd = process.env.PIE_TEST_COVERAGE_CWD;
const ownerIncludesJSON = process.env.PIE_TEST_COVERAGE_INCLUDES;
let ownerIncludes;
// PID/thread pairs can be reused within one invocation. Keep each preload
// generation distinct, with its process start time for raw V8 correlation.
const captureId = randomUUID();
const identity = { schema: 1, pid: process.pid, threadId, captureId, startedAtMs: Math.floor(performance.timeOrigin) };
const scripts = new Map();
const errors = [];
let pending = 0;
let session;
const excluded = new Set([
  'node_modules', '.git', '.cache', 'cache', 'generated', 'build', 'dist',
  'out', 'out-dev', 'coverage', 'data', 'sessions', 'logs', '.moon', '.turbo',
]);

function recordError(stage, error, details = {}) {
  errors.push({ stage, message: String(error?.message ?? error), ...details });
  process.exitCode = 125;
  // Persist immediately as well: a later explicit process.exit must not hide it.
  if (directory && path.isAbsolute(directory)) {
    try {
      fs.writeFileSync(path.join(directory, `recorder-error-${process.pid}-${threadId}.json`),
        JSON.stringify({ ...identity, errors }));
    } catch {
      // An unwritable capture directory still fails via exit status, without stdout.
    }
  }
}

function filePath(url) {
  if (typeof url !== 'string' || !url) return undefined;
  if (url.startsWith('file:')) return fileURLToPath(url);
  if (path.isAbsolute(url)) return url;
  return undefined;
}

function included(url) {
  const filename = filePath(url);
  if (!filename) return false;
  const relative = path.relative(root, filename);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  if (relative.split(path.sep).some(part => excluded.has(part.toLowerCase()))) return false;
  // Match the accounting adapter's owner-relative glob semantics. The fixed
  // inherited CWD must not follow chdir in this process or its children.
  return ownerIncludes === undefined || ownerIncludes.length === 0
    || ownerIncludes.some(glob => path.matchesGlob(path.relative(ownerCwd, filename).replaceAll('\\', '/'), glob));
}

function inlineMap(sourceMapURL) {
  // Only inspector-provided inline metadata can widen capture. Never read an
  // external map or generated file, or infer a source from an unknown URL.
  if (typeof sourceMapURL !== 'string' || !sourceMapURL.startsWith('data:')) return false;
  if (!sourceMapURL.startsWith('data:application/json;')) throw new Error('Unsupported inline source map');
  const comma = sourceMapURL.indexOf(',');
  if (comma < 0) throw new Error('Invalid inline source map');
  const text = sourceMapURL.slice(0, comma).endsWith(';base64')
    ? Buffer.from(sourceMapURL.slice(comma + 1), 'base64').toString('utf8')
    : decodeURIComponent(sourceMapURL.slice(comma + 1));
  const map = JSON.parse(text);
  if (!map || map.version !== 3 || !Array.isArray(map.sources)
    || (map.sourceRoot !== undefined && typeof map.sourceRoot !== 'string')) {
    throw new Error('Missing inline source map identity');
  }
  return map;
}

function sourcePath(source, map, url) {
  if (typeof source !== 'string' || !source || /^<.*>$/u.test(source)) return undefined;
  const absolute = filePath(source);
  if (absolute) return path.resolve(absolute);
  if (/^[a-z]+:/iu.test(source)) return undefined;
  const sourceRoot = map.sourceRoot || '';
  if (sourceRoot.startsWith('file:')) {
    return filePath(new URL(source.replaceAll('\\', '/'), sourceRoot.endsWith('/') ? sourceRoot : `${sourceRoot}/`).href);
  }
  if (/^[a-z]+:/iu.test(sourceRoot) && !path.isAbsolute(sourceRoot)) return undefined;
  const base = filePath(url);
  if (!base && !path.isAbsolute(sourceRoot)) return undefined;
  return path.resolve(base ? path.dirname(base) : sourceRoot, sourceRoot, source);
}

function inlineOwnedSource(url, map) {
  if (!map) return false;
  return map.sources.some(source => {
    const filename = sourcePath(source, map, url);
    return filename !== undefined && included(filename);
  });
}

function sourceSnapshots(url, map) {
  const filename = filePath(url);
  if (!map || !filename || !included(url) || !/\.(?:mjs|js|cjs)$/iu.test(filename)
    || map.sources.length === 0) return undefined;
  const same = other => other !== undefined && path.relative(filename, other) === '';
  if (!map.sources.every(source => same(sourcePath(source, map, url)))) return undefined;
  if (map.sources.every((_, index) => typeof map.sourcesContent?.[index] === 'string')) return undefined;
  // Only an ordinary self-origin native JS file may fill sparse map content.
  // Resolve/stat checks do not grant a wider read, including through symlinks.
  if (!fs.lstatSync(filename).isFile() || !same(fs.realpathSync(filename))) {
    throw new Error('Source snapshot requires an ordinary self-origin file');
  }
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(filename));
  return [{ url: pathToFileURL(path.resolve(filename)).href, content }];
}

process.on('exit', () => {
  if (pending) recordError('getScriptSource', `Exit with ${pending} pending source requests`);
  if (directory && path.isAbsolute(directory)) {
    try {
      fs.writeFileSync(path.join(directory, `scripts-${process.pid}-${threadId}-${captureId}.json`),
        JSON.stringify({ ...identity, scripts: [...scripts.values()] }));
    } catch (error) {
      recordError('write', error);
    }
  }
  if (errors.length) process.exitCode = 125;
});

try {
  if (!directory || !path.isAbsolute(directory) || !root || !path.isAbsolute(root)) {
    throw new Error('PIE_TEST_COVERAGE_DIR and PIE_TEST_COVERAGE_ROOT must be absolute paths');
  }
  // The parent sets NODE_V8_COVERAGE to directory/v8. Node's test coverage
  // may temporarily redirect that variable and copy the raw files back on exit.
  // The invocation owner creates and cleans up this directory.
  if (!fs.statSync(directory).isDirectory() || !fs.statSync(root).isDirectory()) {
    throw new Error('Capture directory and source root must exist');
  }
  if (ownerCwd !== undefined || ownerIncludesJSON !== undefined) {
    if (!ownerCwd || !path.isAbsolute(ownerCwd) || ownerIncludesJSON === undefined) {
      throw new Error('PIE_TEST_COVERAGE_CWD must be absolute and paired with PIE_TEST_COVERAGE_INCLUDES');
    }
    const includes = JSON.parse(ownerIncludesJSON);
    if (!Array.isArray(includes) || includes.some(glob => typeof glob !== 'string')) {
      throw new Error('PIE_TEST_COVERAGE_INCLUDES must be a JSON array of glob strings');
    }
    ownerIncludes = includes.map(glob => glob.replaceAll('\\', '/'));
  }
  session = new Session();
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => {
    let capture;
    try { capture = included(params.url); }
    catch (error) { recordError('url', error, { scriptId: params.scriptId, url: params.url }); return; }
    let map;
    try {
      map = inlineMap(params.sourceMapURL);
      capture = inlineOwnedSource(params.url, map) || capture;
    } catch (error) {
      // A malformed map on an already eligible script must fail closed. For
      // foreign/unknown scripts it proves no repo origin and grants no capture.
      if (capture) recordError('sourceMapURL', error, { scriptId: params.scriptId, url: params.url });
      return;
    }
    if (!capture) return;
    let snapshots;
    try {
      // Read synchronously in scriptParsed, before the parsed script executes;
      // never defer provenance reads to exit or even the source callback.
      snapshots = sourceSnapshots(params.url, map);
    } catch (error) {
      recordError('sourceSnapshot', error, { scriptId: params.scriptId, url: params.url });
      return;
    }
    pending += 1;
    try {
      session.post('Debugger.getScriptSource', { scriptId: params.scriptId }, (error, result) => {
        pending -= 1;
        if (error || typeof result?.scriptSource !== 'string') {
          recordError('getScriptSource', error ?? 'Missing scriptSource', { scriptId: params.scriptId, url: params.url });
          return;
        }
        scripts.set(params.scriptId, {
          scriptId: params.scriptId,
          url: params.url,
          code: result.scriptSource,
          sourceMapURL: params.sourceMapURL ?? '',
          ...(snapshots === undefined ? {} : { sourceSnapshots: snapshots }),
        });
      });
    } catch (error) {
      pending -= 1;
      recordError('getScriptSource', error, { scriptId: params.scriptId, url: params.url });
    }
  });
  session.post('Debugger.enable', error => { if (error) recordError('Debugger.enable', error); });
} catch (error) {
  recordError('initialize', error);
}
