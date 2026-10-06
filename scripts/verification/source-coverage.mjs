import { readFile, readdir } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// Keep source eligibility aligned with coverage-capture.cjs, including map origins.
const excluded = new Set([
  'node_modules', '.git', '.cache', 'cache', 'generated', 'build', 'dist',
  'out', 'out-dev', 'coverage', 'data', 'sessions', 'logs', '.moon', '.turbo',
]);
// Coverage dependencies belong to the agent framework, not the native runner.
const ownerRequire = createRequire(new URL('../../harness/pi/packages/agent/package.json', import.meta.url));
const providerRequire = createRequire(ownerRequire.resolve('@vitest/coverage-v8'));
let dependencies;
async function loadDependencies() {
  return dependencies ??= Promise.all([
    import(pathToFileURL(providerRequire.resolve('ast-v8-to-istanbul')).href),
    import(pathToFileURL(providerRequire.resolve('rollup/parseAst')).href),
  ]).then(([converter, parser]) => ({
    convert: converter.convert,
    parse: parser.parseAstAsync,
    coverage: providerRequire('istanbul-lib-coverage'),
    mergeScriptCovs: providerRequire('@bcoe/v8-coverage').mergeScriptCovs,
    parseSource: providerRequire('@babel/parser').parse,
    parseExpression: providerRequire('@babel/parser').parseExpression,
    trace: providerRequire('@jridgewell/trace-mapping'),
  }));
}

function filePath(url) {
  if (typeof url !== 'string' || !url) return undefined;
  if (url.startsWith('file:')) return path.resolve(fileURLToPath(url));
  if (path.isAbsolute(url)) return path.resolve(url);
  return undefined;
}

function identity(filename) {
  const normalized = path.resolve(filename).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sourcePath(source, map, url) {
  if (typeof source !== 'string' || !source) throw new Error(`Missing source identity: ${url}`);
  if (source.startsWith('file:')) return filePath(source);
  if (path.isAbsolute(source)) return path.resolve(source);
  const root = map.sourceRoot || '';
  if (root.startsWith('file:')) return fileURLToPath(new URL(source.replaceAll('\\', '/'), root.endsWith('/') ? root : `${root}/`));
  if (/^[a-z]+:/iu.test(source) || /^[a-z]+:/iu.test(root)) throw new Error(`Unsupported source identity: ${source}`);
  return path.resolve(path.dirname(filePath(url)), root, source);
}

function decodeMap(capture, code) {
  const inline = [...code.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/gu)].at(-1)?.[1];
  const captured = capture.sourceMapURL || undefined;
  if (inline && captured && inline !== captured) throw new Error(`Conflicting source map capture: ${capture.url}`);
  const url = captured ?? inline;
  if (!url) return undefined;
  if (!url.startsWith('data:application/json;')) throw new Error(`Inline source map required: ${capture.url}`);
  const comma = url.indexOf(',');
  let map;
  try {
    const text = url.slice(0, comma).endsWith(';base64')
      ? Buffer.from(url.slice(comma + 1), 'base64').toString('utf8')
      : decodeURIComponent(url.slice(comma + 1));
    map = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Invalid inline source map: ${capture.url}`, { cause });
  }
  if (!Array.isArray(map.sources)) throw new Error(`Missing source map identity: ${capture.url}`);
  const sources = map.sources.map(source => sourcePath(source, map, capture.url));
  return { ...map, sourceRoot: undefined, sourceOrigins: map.sources, sources: sources.map(source => pathToFileURL(source).href) };
}

// Only a pre-execution native-JS self snapshot can complete a sparse map.
// Transformed bytes are not evidence of the authored source text.
function completeNativeSelfMap(map, capture, filename) {
  if (!map || capture.sourceSnapshots === undefined) return;
  if (!Array.isArray(capture.sourceSnapshots)) throw new Error(`Invalid source snapshot: ${capture.url}`);
  const snapshots = new Map();
  for (const snapshot of capture.sourceSnapshots) {
    const source = filePath(snapshot?.url);
    if (!source || typeof snapshot.content !== 'string' || snapshot.content.length === 0) {
      throw new Error(`Invalid source snapshot: ${capture.url}`);
    }
    const key = identity(source);
    if (snapshots.has(key) && snapshots.get(key) !== snapshot.content) throw new Error(`Conflicting source snapshot: ${snapshot.url}`);
    snapshots.set(key, snapshot.content);
  }
  map.sources.forEach((url, index) => {
    const content = snapshots.get(identity(filePath(url)));
    if (content !== undefined && typeof map.sourcesContent?.[index] === 'string'
      && content !== map.sourcesContent[index]) throw new Error(`Conflicting source snapshot: ${url}`);
  });
  if (!/\.[cm]?js$/iu.test(filename) || map.sources.length !== 1
    || identity(filePath(map.sources[0])) !== identity(filename)) return;
  const content = snapshots.get(identity(filename));
  if (content !== undefined && (map.sourcesContent == null
    || (Array.isArray(map.sourcesContent) && map.sourcesContent.length <= 1 && map.sourcesContent[0] == null))) {
    map.sourcesContent = [content];
  }
}

function runtimeCode(capture, record) {
  let code = capture.code;
  if (typeof code !== 'string') throw new Error(`Missing code capture: ${record.url}`);
  // Debugger.getScriptSource may include Node's exact CJS wrapper. Never infer an
  // offset from function names or raw range lengths alone.
  let wrapperLength = 0;
  if (code.startsWith(Module.wrapper[0]) && code.endsWith(Module.wrapper[1])) {
    wrapperLength = Module.wrapper[0].length;
    code = code.slice(wrapperLength, -Module.wrapper[1].length);
  }
  if (!Array.isArray(record.functions)) throw new Error(`Invalid raw coverage: ${record.url}`);
  for (const fn of record.functions) {
    if (!Array.isArray(fn.ranges)) throw new Error(`Missing raw ranges: ${record.url}`);
    for (const range of fn.ranges) {
      if (!Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset)
        || range.startOffset < 0 || range.endOffset < range.startOffset
        || range.endOffset > capture.code.length || !Number.isFinite(range.count) || range.count < 0) {
        throw new Error(`Raw range/code capture mismatch: ${record.url}`);
      }
    }
  }
  return { code, wrapperLength };
}

// esbuild's CJS export table/getters are mapped to source line 1 even when
// line 1 is an erased interface. Most other helpers are already unmapped and
// skipped by the standard converter. Recognize this exact scaffold only when
// its export table is synthetic and helper nodes have unmapped provenance.
const ESBUILD_CJS_HELPERS = `
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
`;
let knownHelpers;
function syntax(node) {
  return JSON.stringify(node, (key, value) => {
    if (['start', 'end', 'loc', 'raw'].includes(key)) return undefined;
    // Keep BigInt tokens distinct from both numeric and string literals.
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    if (key === 'name' && typeof value === 'string') return value.replace(/^(__(?:defProp|getOwnPropDesc|getOwnPropNames|hasOwnProp|export|copyProps|toCommonJS))\d+$/u, '$1');
    return value;
  });
}

// Only the dead, plain export-binding object used by esbuild's Node debug
// annotation is eligible. The same authored syntax must never be discarded.
function debugExportObject(node) {
  if (node?.type !== 'LogicalExpression' || node.operator !== '&&'
    || node.left.type !== 'Literal' || node.left.value !== 0) return undefined;
  const assignment = node.right;
  if (assignment.type !== 'AssignmentExpression' || assignment.operator !== '='
    || assignment.left.type !== 'MemberExpression' || assignment.left.computed
    || assignment.left.object.type !== 'Identifier' || assignment.left.object.name !== 'module'
    || assignment.left.property.type !== 'Identifier' || assignment.left.property.name !== 'exports'
    || assignment.right.type !== 'ObjectExpression') return undefined;
  const properties = assignment.right.properties;
  return properties.every(property => property.type === 'Property' && !property.computed
    && !property.method && property.kind === 'init' && property.value.type === 'Identifier'
    && (property.key.type === 'Identifier' || property.key.type === 'Literal')) ? properties : undefined;
}

function exportKey(property) {
  return property.key.type === 'Identifier' ? property.key.name : String(property.key.value);
}

async function exportScaffold(ast, code, sourceMap, parseSource, parseExpression, parse, trace) {
  if (!sourceMap) return undefined;
  knownHelpers ??= new Set((await parse(ESBUILD_CJS_HELPERS)).body.map(syntax));
  // TSX evaluates CJS output inside an arrow-function block. Match scaffolds
  // within each lexical statement list, never across scope boundaries.
  const scopes = [];
  const collectScopes = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Program' || node.type === 'BlockStatement') scopes.push(node.body);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(collectScopes);
      else if (value && typeof value === 'object') collectScopes(value);
    }
  };
  collectScopes(ast);
  const candidates = scopes.flatMap(body => body.filter(node => knownHelpers.has(syntax(node))));
  if (!candidates.some(node => /^__export\d*$/u.test(node.declarations[0].id.name))) return undefined;
  const identifiers = new Set();
  const anonymousDefaults = [];
  const namedReexports = [];
  let authoredDebugExport = false;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier') identifiers.add(node.name);
    if (debugExportObject(node)) authoredDebugExport = true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  sourceMap.sourcesContent.forEach((source, index) => {
    // esbuild's CLI define creates an expression source, not an authored
    // module. Use the raw map identity, never a normalized path basename or
    // a parse-error fallback, and still visit every node for provenance.
    if (sourceMap.sourceOrigins[index] === '<define:import.meta>') {
      visit(parseExpression(source, { plugins: ['estree'] }));
    } else {
      const jsx = /\.[jt]sx$/iu.test(filePath(sourceMap.sources[index]));
      const program = parseSource(source, { sourceType: 'unambiguous', plugins: ['typescript', 'estree', ...(jsx ? ['jsx'] : [])] }).program;
      visit(program);
      for (const node of program.body) {
        if (node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'FunctionDeclaration'
          && node.declaration.id === null) {
          anonymousDefaults.push({ source: sourceMap.sources[index], node });
        }
        if (node.type === 'ExportNamedDeclaration' && node.source) {
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ExportSpecifier') namedReexports.push({
              source: sourceMap.sources[index], node, from: node.source.value,
              imported: specifier.local.name ?? specifier.local.value,
              exported: specifier.exported.name ?? specifier.exported.value,
            });
          }
        }
      }
    }
  });
  const lineStarts = [0];
  for (let offset = 0; offset < code.length; offset += 1) {
    if (code.charCodeAt(offset) === 10) lineStarts.push(offset + 1);
  }
  const traced = new trace.TraceMap(sourceMap);
  const mappedOffsets = trace.decodedMappings(traced).flatMap((segments, line) =>
    segments.filter(segment => segment.length > 1).map(segment => lineStarts[line] + segment[0]));
  // esbuild reserves its helper names and may rename user bindings. A helper
  // therefore needs positive unmapped provenance, not just an absent TS name.
  const unmappedHelpers = new Set(candidates.filter(node => !mappedOffsets.some(offset => offset >= node.start && offset < node.end)));
  const originalPosition = node => {
    let line = lineStarts.length - 1;
    while (lineStarts[line] > node.start) line -= 1;
    return trace.originalPositionFor(traced, { line: line + 1, column: node.start - lineStarts[line] });
  };
  const authoredIdentifier = node => {
    if (identifiers.has(node.name)) return true;
    const position = originalPosition(node);
    return position.name !== null && identifiers.has(position.name);
  };
  const mapsToExport = (generated, authored) => {
    const position = originalPosition(generated);
    const { start, end } = authored.node.loc;
    return position.source === authored.source && position.line !== null
      && (position.line > start.line || position.line === start.line && position.column >= start.column)
      && (position.line < end.line || position.line === end.line && position.column < end.column);
  };
  const authoredGetter = (property, body) => {
    const binding = property.value.body;
    if (binding.type === 'Identifier') {
      if (authoredIdentifier(binding)) return true;
      // Anonymous default functions acquire a compiler binding. Verify that
      // binding's declaration against the captured authored default export;
      // only the getter/scaffold is ignored, never the function body.
      return exportKey(property) === 'default' && body.some(node => node.type === 'FunctionDeclaration'
        && node.id?.name === binding.name && anonymousDefaults.some(authored => mapsToExport(node, authored)));
    }
    if (binding.type !== 'MemberExpression' || binding.computed
      || binding.object.type !== 'Identifier' || binding.property.type !== 'Identifier') return false;
    // Named reexports are getters into a generated require binding. Require
    // both exact import syntax and source-mapped authored export provenance.
    return body.some(node => node.type === 'VariableDeclaration' && node.declarations.some(declaration =>
      declaration.id.type === 'Identifier' && declaration.id.name === binding.object.name
      && declaration.init?.type === 'CallExpression' && declaration.init.callee.type === 'Identifier'
      && declaration.init.callee.name === 'require' && declaration.init.arguments.length === 1
      && declaration.init.arguments[0].type === 'Literal'
      && namedReexports.some(authored => authored.exported === exportKey(property)
        && authored.imported === binding.property.name && authored.from === declaration.init.arguments[0].value
        && mapsToExport(node, authored))));
  };
  const ignored = [];
  for (const body of scopes) {
    const helpers = body.filter(node => unmappedHelpers.has(node));
    const helper = helpers.find(node => /^__export\d*$/u.test(node.declarations[0].id.name));
    const toCommonJS = helpers.find(node => /^__toCommonJS\d*$/u.test(node.declarations[0].id.name));
    if (!helper || !toCommonJS) continue;
    const commonJSName = toCommonJS.declarations[0].id.name;
    const helperName = helper.declarations[0].id.name;
    for (let index = 0; index < body.length - 2; index += 1) {
      const table = body[index];
      const call = body[index + 1];
      const assignment = body[index + 2];
      if (table.type !== 'VariableDeclaration' || table.kind !== 'var' || table.declarations.length !== 1) continue;
      const declaration = table.declarations[0];
      if (declaration.id.type !== 'Identifier' || identifiers.has(declaration.id.name)
        || declaration.init?.type !== 'ObjectExpression' || declaration.init.properties.length !== 0) continue;
      const expression = call.type === 'ExpressionStatement' && call.expression;
      if (expression?.type !== 'CallExpression' || expression.callee.type !== 'Identifier'
        || expression.callee.name !== helperName || expression.arguments.length !== 2
        || expression.arguments[0].name !== declaration.id.name || expression.arguments[1].type !== 'ObjectExpression') continue;
      const getters = expression.arguments[1].properties;
      if (!getters.every(property => property.type === 'Property' && !property.computed
        && !property.method && property.kind === 'init'
        && (property.key.type === 'Identifier' || property.key.type === 'Literal')
        && property.value.type === 'ArrowFunctionExpression' && property.value.params.length === 0
        && authoredGetter(property, body))) continue;
      const assigned = assignment.type === 'ExpressionStatement' && assignment.expression;
      if (assigned?.type !== 'AssignmentExpression' || assigned.operator !== '='
        || assigned.left.type !== 'MemberExpression' || assigned.left.computed
        || assigned.left.object.name !== 'module' || assigned.left.property.name !== 'exports'
        || assigned.right.type !== 'CallExpression' || assigned.right.callee.type !== 'Identifier'
        || assigned.right.callee.name !== commonJSName
        || assigned.right.arguments.length !== 1 || assigned.right.arguments[0].name !== declaration.id.name) continue;
      ignored.push([table.start, assignment.end]);
      if (!authoredDebugExport) {
        const bindings = new Map(getters.map(property => [exportKey(property), property.value.body.type === 'Identifier'
          ? property.value.body.name : undefined]));
        // Require the trailing expression in this scope, the verified CJS
        // table, and exactly its export keys/bindings (including renamed classes).
        const trailing = body.at(-1);
        const properties = trailing?.type === 'ExpressionStatement' && debugExportObject(trailing.expression);
        if (properties && properties.length === bindings.size
          && new Set(properties.map(exportKey)).size === bindings.size
          && properties.every(property => {
            const key = exportKey(property);
            // esbuild's debug object can use the public export name instead of
            // its real (renamed or aliased) binding; that binding was verified
            // against captured source above in the corresponding getter.
            return bindings.has(key) && (bindings.get(key) === property.value.name || key === property.value.name);
          })) {
          ignored.push([trailing.start, trailing.end]);
        }
      }
      // On whitespace-minified output, the first mapping can also leak backwards
      // to helpers on that same generated line. Exclude only AST-exact helpers.
      for (const helper of helpers) {
        if (helper.end <= table.start) ignored.push([helper.start, helper.end]);
      }
    }
  }
  return node => ignored.some(([start, end]) => node.start >= start && node.end <= end)
    ? 'ignore-this-and-nested-nodes' : undefined;
}

function normalized(summary) {
  const result = {};
  for (const [kind, plural] of [['Line', 'lines'], ['Branch', 'branches'], ['Function', 'functions']]) {
    const item = summary[plural];
    result[`total${kind}Count`] = item.total;
    result[`covered${kind}Count`] = item.covered;
    result[`covered${kind}Percent`] = item.total === 0 ? 100 : item.covered / item.total * 100;
  }
  return result;
}

/** Convert only captured executions; no source discovery, disk reread or re-transform. */
export async function collectSourceCoverage({ directory, root = repoRoot, cwd = root, includes = [] }) {
  const { convert, parse, parseSource, parseExpression, trace, coverage, mergeScriptCovs } = await loadDependencies();
  directory = path.resolve(directory);
  root = path.resolve(root);
  cwd = path.resolve(root, cwd);
  const included = filename => {
    if (filename === undefined) return false;
    const relative = path.relative(root, filename);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    if (relative.split(path.sep).some(part => excluded.has(part.toLowerCase()))) return false;
    return includes.length === 0
      || includes.some(glob => path.matchesGlob(path.relative(cwd, filename).replaceAll('\\', '/'), glob.replaceAll('\\', '/')));
  };
  const captures = new Map();
  for (const name of (await readdir(directory)).sort()) {
    const match = /^scripts-(\d+)-(\d+)(?:-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}))?\.json$/iu.exec(name);
    if (!match) continue;
    const data = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    if (data.schema !== 1 || data.pid !== Number(match[1]) || data.threadId !== Number(match[2]) || !Array.isArray(data.scripts)
      || (match[3] !== undefined && (data.captureId !== match[3] || data.startedAtMs === undefined))
      || (data.startedAtMs !== undefined && (!Number.isSafeInteger(data.startedAtMs) || data.startedAtMs < 0))) {
      throw new Error(`Invalid script capture identity: ${name}`);
    }
    const key = `${data.pid}:${data.threadId}`;
    const scripts = new Map();
    for (const script of data.scripts) {
      if (typeof script.scriptId !== 'string') throw new Error(`Invalid script capture ID: ${name}`);
      const previous = scripts.get(script.scriptId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(script)) throw new Error(`Conflicting script capture: ${key}:${script.scriptId}`);
      scripts.set(script.scriptId, script);
    }
    const generations = captures.get(key) ?? [];
    generations.push({ startedAtMs: data.startedAtMs, scripts });
    captures.set(key, generations);
  }
  for (const [key, generations] of captures) {
    generations.sort((a, b) => a.startedAtMs - b.startedAtMs);
    if (generations.length > 1 && generations.some((generation, index) => generation.startedAtMs === undefined
      || (index > 0 && generation.startedAtMs === generations[index - 1].startedAtMs))) {
      throw new Error(`Ambiguous script capture generation: ${key}`);
    }
  }
  const map = coverage.createCoverageMap({});
  const sources = new Map();
  const transforms = new Map();
  const remember = (filename, code) => {
    const key = identity(filename);
    if (sources.has(key) && sources.get(key) !== code) throw new Error(`Conflicting source identity: ${filename}`);
    sources.set(key, code);
  };
  for (const name of (await readdir(path.join(directory, 'v8'))).sort()) {
    const match = /^coverage-(\d+)-(\d+)-(\d+)\.json$/u.exec(name);
    if (!match) continue;
    const raw = JSON.parse(await readFile(path.join(directory, 'v8', name), 'utf8'));
    const timestampMs = Number(match[2]);
    if (!Array.isArray(raw.result) || !Number.isSafeInteger(timestampMs)) throw new Error(`Invalid raw coverage file: ${name}`);
    const generations = captures.get(`${Number(match[1])}:${Number(match[3])}`) ?? [];
    // V8 flushes after exit handlers: only the next process start bounds a
    // generation. A legacy capture without a start is safe only when alone.
    const generation = generations.find((item, index) => (item.startedAtMs === undefined || timestampMs >= item.startedAtMs)
      && (index === generations.length - 1 || timestampMs < generations[index + 1].startedAtMs));
    // Internal loader threads may have only foreign records and no recorder.
    // Require a generation only after positively selecting an owned execution.
    for (const record of raw.result) {
      const filename = filePath(record.url);
      if (!filename) continue;
      const capture = generation?.scripts.get(record.scriptId);
      if (!capture) {
        // The raw cache is identity evidence only, never a replacement for
        // captured code or its strict inline map. Generated URLs can belong to
        // included authored sources even when their runtime path is excluded.
        const cached = raw['source-map-cache']?.[record.url];
        const rawMap = cached?.data;
        // Node's dependency cache may already contain incorrectly normalized
        // absolute sources (e.g. saxes -> the owner's src/saxes.ts). Neither
        // those paths nor an external map establish dependency ownership.
        const dependency = filename.split(path.sep).some(part => part.toLowerCase() === 'node_modules');
        const includedOrigin = !dependency && Array.isArray(rawMap?.sources) && rawMap.sources.some(source => {
          try {
            return included(sourcePath(source, rawMap, filePath(cached.url) ? cached.url : record.url));
          } catch {
            // Invalid identities cannot positively classify an excluded owner.
            return false;
          }
        });
        if (included(filename) || includedOrigin) {
          if (!generation) throw new Error(`Missing script capture generation: ${name}`);
          throw new Error(`Missing script capture: ${record.url} (${name}, script ${record.scriptId})`);
        }
        continue;
      }
      // Native dependencies with external maps are outside this adapter's
      // inline-map contract. Owner-included executions must still fail closed.
      const mapURL = capture.sourceMapURL || [...(capture.code ?? '').matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/gu)].at(-1)?.[1];
      if (!included(filename) && (!mapURL || !mapURL.startsWith('data:application/json;'))) continue;
      const sourceMap = decodeMap(capture, capture.code ?? '');
      const sourceFiles = sourceMap?.sources.map(filePath) ?? [filename];
      if (!sourceFiles.some(included) && !included(filename)) continue;
      if (capture.url !== record.url) throw new Error(`Script capture URL mismatch: ${record.url}`);
      const { code, wrapperLength } = runtimeCode(capture, record);
      completeNativeSelfMap(sourceMap, capture, filename);
      if (sourceMap && (sourceMap.version !== 3 || !Array.isArray(sourceMap.sourcesContent)
        || sourceMap.sources.length === 0 || sourceMap.sources.length !== sourceMap.sourcesContent.length
        || typeof sourceMap.mappings !== 'string' || sourceMap.sourcesContent.some(source => typeof source !== 'string'))) {
        throw new Error(`Incomplete source map identity: ${capture.url}`);
      }
      if (/\.[cm]?tsx?$/iu.test(filename) && included(filename)) {
        if (!sourceMap) throw new Error(`Missing TypeScript source map: ${record.url}`);
        if (!sourceFiles.some(source => identity(source) === identity(filename))) {
          throw new Error(`Source map source identity mismatch: ${record.url}`);
        }
      }
      sourceFiles.forEach((source, index) => {
        if (included(source)) remember(source, sourceMap ? sourceMap.sourcesContent[index] : code);
      });
      // Validate every execution above before grouping. Isolated runtime paths
      // can share a transform only when their canonical authored origins agree.
      // Keep the exact captured bytes/map as well as the resolved map: offsets,
      // wrapper layouts and relative map identities must never be conflated.
      const key = JSON.stringify([capture.code, wrapperLength, mapURL, sourceMap, sourceFiles.map(identity)]);
      const transform = transforms.get(key);
      if (transform) transform.records.push(record);
      else transforms.set(key, { code, wrapperLength, sourceMap, filename, records: [record] });
    }
  }
  let convertedScripts = 0;
  for (const { code, wrapperLength, sourceMap, filename, records } of transforms.values()) {
    let converted;
    try {
      // Use the standard V8 range-tree merger, not Istanbul merging on generated
      // offsets. Different transforms still meet only in the source-level merge.
      const record = mergeScriptCovs(records);
      const ast = await parse(code);
      converted = await convert({ ast, code, sourceMap, coverage: { ...record, url: pathToFileURL(filename).href }, wrapperLength,
        ignoreNode: await exportScaffold(ast, code, sourceMap, parseSource, parseExpression, parse, trace),
      });
      convertedScripts += 1;
    } catch (cause) {
      throw new Error(`Source coverage conversion failed: ${records[0].url}`, { cause });
    }
    const selected = coverage.createCoverageMap(converted);
    selected.filter(included);
    map.merge(selected);
  }
  const files = map.files().sort().map(filename => {
    const file = map.fileCoverageFor(filename);
    return {
      path: filename,
      ...normalized(file.toSummary().toJSON()),
      lines: Object.entries(file.getLineCoverage()).map(([line, count]) => ({ line: Number(line), count })),
      branches: Object.entries(file.branchMap).map(([id, branch]) => ({
        type: branch.type, loc: branch.loc, locations: branch.locations, counts: file.b[id],
      })),
    };
  });
  return { ...normalized(map.getCoverageSummary().toJSON()), files, convertedScripts };
}
