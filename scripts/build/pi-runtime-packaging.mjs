// Qualified role packing of a caller-owned, freshly materialized private SDK.
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveOwnerModule } from '../lib/package-resolution.mjs';
import { PI_RUNTIME_PACKAGES, writePiRuntimeManifest, verifyPiRuntimeArtifact, verifyPiRuntimeToolingArtifact } from '../lib/pi-runtime-artifact.mjs';

const COMPILER_OWNER = { dependencyOwnerRoot: fileURLToPath(new URL('../../', import.meta.url)) };
const MISTRAL = '@mistralai/mistralai';
const BINDINGS = ['HTTPClient', 'Mistral', 'SDK_METADATA', 'ServerEu', 'ServerList', 'files', 'serverURLFromOptions'];
const check = (value, message) => { if (!value) throw new Error(`Pi role packing qualification: ${message}`); };
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const textJson = value => `${JSON.stringify(value, null, 2)}\n`;

// Bounded admission, stop on failure and drain every admitted operation.
async function jobs(rows, action) {
  let next = 0, stopped = false;
  const results = await Promise.allSettled(Array.from({ length: 8 }, async () => {
    while (!stopped && next < rows.length) {
      const row = rows[next++];
      try { await action(row); } catch (error) { stopped = true; throw error; }
    }
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
async function inventory(root) {
  const files = [], pending = [''];
  // Each batch only enqueues descendants, never waits on another worker.
  while (pending.length) {
    const batch = pending.splice(0, 8);
    await jobs(batch, async relative => {
      const directory = path.join(root, relative), info = await lstat(directory);
      check(info.isDirectory() && !info.isSymbolicLink(), `nonordinary directory: ${relative}`);
      for (const name of (await readdir(directory)).sort()) {
        const rel = path.join(relative, name), stat = await lstat(path.join(root, rel));
        check(!stat.isSymbolicLink(), `link: ${rel}`);
        if (stat.isDirectory()) pending.push(rel);
        else { check(stat.isFile() && stat.nlink === 1, `shared/nonordinary file: ${rel}`); files.push(rel); }
      }
    });
  }
  return files.sort();
}
async function assertOwnedPair(runtimeDir, toolingDir) {
  check(path.isAbsolute(runtimeDir) && path.isAbsolute(toolingDir), 'absolute private paths required');
  check(path.basename(runtimeDir) === 'pi-runtime' && toolingDir === path.join(path.dirname(runtimeDir), 'pi-tooling'), 'fixed sibling pi-runtime/pi-tooling required');
  const parent = await realpath(path.dirname(runtimeDir)), temp = await realpath(os.tmpdir());
  check(within(temp, parent) && parent !== temp, 'caller-owned fresh package directory must be below OS temp');
  for (let current = runtimeDir;; current = path.dirname(current)) {
    const stat = await lstat(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'linked output ancestor');
    if (current === path.dirname(current)) break;
  }
  const names = (await readdir(runtimeDir)).sort();
  check(names.every(name => ['manifest.json', 'node_modules'].includes(name)) && names.includes('node_modules'), 'expected fresh materialized SDK, not already packed output');
  try { await lstat(toolingDir); throw new Error('Tooling output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function ast(ts, name, text) { return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); }
function visit(ts, node, action) { action(node); ts.forEachChild(node, child => visit(ts, child, action)); }
function specifier(ts, node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) return node.moduleSpecifier;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) return node.arguments[0];
}
function comments(ts, tree, text) {
  const ranges = new Map();
  visit(ts, tree, node => {
    for (const position of [node.pos, node.end]) for (const range of [...(ts.getLeadingCommentRanges(text, position) ?? []), ...(ts.getTrailingCommentRanges(text, position) ?? [])]) ranges.set(range.pos, range);
  });
  return [...ranges.values()].sort((a, b) => a.pos - b.pos);
}
async function thinMaps(runtimeDir, rows, ts, counts) {
  await jobs(rows, async rel => {
    const file = path.join(runtimeDir, rel);
    if (/\.d\.(?:ts|mts|cts)(?:\.map)?$/.test(rel)) { await unlink(file); counts.declarationsRemoved++; return; }
    if (!/\.(?:js|mjs|cjs)\.map$/.test(rel)) return;
    const bytes = await readFile(file), js = file.slice(0, -4);
    let text, map;
    let jsBytes;
    try { jsBytes = await readFile(js); text = jsBytes.toString('utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; counts.mapsRetained++; return; }
    if (!Buffer.from(text).equals(jsBytes)) { counts.mapsRetained++; return; }
    try { map = JSON.parse(bytes.toString('utf8')); } catch { counts.mapsRetained++; return; }
    const tree = ast(ts, js, text);
    const refs = comments(ts, tree, text).map(range => ({ ...range, body: text.slice(range.pos + 2, range.end - (range.kind === ts.SyntaxKind.MultiLineCommentTrivia ? 2 : 0)) }))
      .filter(range => /^[#@]\s*sourceMappingURL\s*=/.test(range.body.trim()));
    const ref = refs[0], url = ref?.body.trim().match(/^[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/)?.[1];
    const relative = value => typeof value === 'string' && !/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(value);
    if (tree.parseDiagnostics.length || map?.version !== 3 || Object.hasOwn(map, 'sections') || map.sourceRoot || typeof map.mappings !== 'string' || !Array.isArray(map.sources) || !map.sources.every(relative) || refs.length !== 1 || text.slice(ref.end).trim() || url !== path.basename(file)) { counts.mapsRetained++; return; }
    const body = ref.body.replace(url, `data:application/json;base64,${bytes.toString('base64')}`);
    const comment = ref.kind === ts.SyntaxKind.MultiLineCommentTrivia ? `/*${body}*/` : `//${body}`;
    await writeFile(js, text.slice(0, ref.pos) + comment + text.slice(ref.end));
    await unlink(file); counts.mapsInlined++;
  });
}
async function qualifyMistral(toolingDir, rows, ts, esbuild) {
  let sdkUses = 0;
  await jobs(rows.filter(rel => PI_RUNTIME_PACKAGES.some(name => rel.startsWith(path.join('node_modules', name) + path.sep)) && /\.[cm]?js$/.test(rel)), async rel => {
    const tree = ast(ts, rel, await readFile(path.join(toolingDir, rel), 'utf8'));
    visit(ts, tree, node => {
      const spec = specifier(ts, node);
      if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith(MISTRAL)) return;
      check(spec.text === MISTRAL && ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.every(element => (element.propertyName ?? element.name).text === 'Mistral') && !node.importClause.name, 'SDK must use only the static named Mistral root import');
      sdkUses++;
    });
  });
  check(sdkUses > 0, 'SDK Mistral root import missing');
  const root = path.join(toolingDir, 'node_modules', MISTRAL), metadata = await json(path.join(root, 'package.json'));
  const entry = metadata.exports?.['.']?.default;
  check(metadata.name === MISTRAL && metadata.version === '2.2.6' && metadata.type === 'module' && typeof entry === 'string' && Object.keys(metadata.exports['.']).every(key => ['source', 'types', 'default'].includes(key)) && entry.startsWith('./') && /\.js$/.test(entry), 'unqualified Mistral version/root exports');
  const graph = new Map(), exports = new Map();
  async function inspect(file) {
    check(within(root, file), 'Mistral relative graph escaped package');
    if (graph.has(file)) return;
    const source = await readFile(file, 'utf8'), tree = ast(ts, file, source), children = [], names = [], stars = [];
    check(!tree.parseDiagnostics.length, 'unparseable Mistral graph'); graph.set(file, source);
    visit(ts, tree, node => {
      check(!(ts.isIdentifier(node) && ['__dirname', '__filename', 'eval', 'createRequire', 'readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync', 'existsSync'].includes(node.text)) && !(ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword), 'unsupported package-context graph');
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // Mistral 2.2.6 lazily enables tracing through one static package-local edge.
        check(path.relative(root, file).split(path.sep).join('/') === 'esm/hooks/tracing.js'
          && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
          && node.arguments[0].text === '../extra/observability/otel.js', 'dynamic imports unsupported');
      }
      check(!(ts.isPropertyAccessExpression(node) && ['cwd', 'chdir', 'resolve'].includes(node.name.text) && ts.isIdentifier(node.expression) && ['process', 'require'].includes(node.expression.text)), 'package-location lookup unsupported');
      if (ts.isStringLiteral(node)) check(!/\.(?:node|wasm)(?:$|[?#])/.test(node.text), 'native/asset graph unsupported');
      const spec = specifier(ts, node);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') check(spec && ts.isStringLiteral(spec), 'dynamic require unsupported');
      if (spec) {
        check(ts.isStringLiteral(spec), 'nonstatic graph');
        check(!['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'module', 'node:module'].includes(spec.text), 'filesystem/package-context graph unsupported');
        if (spec.text.startsWith('.')) { check(/\.js$/.test(spec.text), 'non-JS graph input'); children.push(path.resolve(path.dirname(file), spec.text)); }
        else check(!path.isAbsolute(spec.text) && !spec.text.startsWith('file:'), 'absolute graph input');
      }
    });
    for (const node of tree.statements) {
      if (ts.isExportDeclaration(node)) {
        if (node.exportClause) {
          if (ts.isNamespaceExport(node.exportClause)) names.push(node.exportClause.name.text);
          else names.push(...node.exportClause.elements.map(element => element.name.text));
        } else { check(node.moduleSpecifier?.text.startsWith('.'), 'external export star'); stars.push(path.resolve(path.dirname(file), node.moduleSpecifier.text)); }
      } else if (ts.isExportAssignment(node)) names.push('default');
      else if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if (node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) names.push('default');
        else if (ts.isVariableStatement(node)) names.push(...node.declarationList.declarations.map(declaration => declaration.name.text));
        else if (node.name) names.push(node.name.text);
        else check(false, 'unsupported root export');
      }
    }
    exports.set(file, { names, stars });
    for (const child of children) await inspect(child);
  }
  const entryFile = path.resolve(root, entry); await inspect(entryFile);
  function exported(file, seen = new Set()) { if (seen.has(file)) return []; seen.add(file); const value = exports.get(file); return [...value.names, ...value.stars.flatMap(child => exported(child, seen).filter(name => name !== 'default'))]; }
  check(JSON.stringify([...new Set(exported(entryFile))].sort()) === JSON.stringify(BINDINGS), 'Mistral root named exports changed');
  const config = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external', sourcemap: 'inline', sourcesContent: true, minify: false };
  const result = await esbuild.build({ ...config, absWorkingDir: root, entryPoints: [entry], outfile: 'bundle.cjs', write: false, metafile: true, logLevel: 'silent' });
  check(!result.warnings.length && result.outputFiles.length === 1, 'compiler warnings/additional outputs');
  for (const file of Object.keys(result.metafile.inputs)) check(graph.has(path.resolve(root, file)), 'uninspected compiler input');
  const external = [...new Set([...Object.values(result.metafile.inputs), ...Object.values(result.metafile.outputs)].flatMap(value => value.imports).filter(value => value.external).map(value => value.path))].sort();
  const require = createRequire(path.join(root, 'package.json'));
  for (const spec of external) if (!isBuiltin(spec)) check(within(path.join(toolingDir, 'node_modules'), require.resolve(spec)), 'external dependency escaped verified graph');
  const bundle = result.outputFiles[0].contents, bundleText = Buffer.from(bundle).toString('utf8');
  const inline = bundleText.match(/\/\/# sourceMappingURL=data:application\/json;base64,(\S+)/)?.[1];
  check(inline && JSON.parse(Buffer.from(inline, 'base64').toString()).sources.every(source => !path.isAbsolute(source) && !/^[a-z][a-z\d+.-]*:/i.test(source)), 'bundle sourcemap must use relative sources');
  return { root, metadata: { ...metadata, main: './index.mjs', exports: { '.': { default: './index.mjs' }, './package.json': './package.json' } }, bundle, config, sdkUses, graphFiles: graph.size, external };
}

/** Caller owns this fresh OS-temp package and must check compiled source identity before packing.
 * Unsupported qualification throws before SDK evaluation; retained outputs are diagnostic, not usable artifacts.
 */
export async function packPiRuntime({ runtimeDir, toolingDir, provenance }) {
  await assertOwnedPair(runtimeDir, toolingDir);
  const rows = await inventory(runtimeDir);
  const options = { target: provenance.target };
  const prior = rows.includes('manifest.json') ? await verifyPiRuntimeArtifact(runtimeDir, options) : undefined;
  if (prior) for (const key of ['upstreamVersion', 'upstreamCommit', 'sourceTreeSha256', 'lockSha256']) check(prior.manifest[key] === provenance[key], 'original provenance differs');
  const original = await writePiRuntimeManifest(runtimeDir, provenance);
  check(!prior || prior.identity === original.identity, 'original identity changed');
  check((await verifyPiRuntimeArtifact(runtimeDir, options)).identity === original.identity, 'original verification failed');
  await mkdir(toolingDir);
  await jobs([...new Set([...rows, 'manifest.json'])], async rel => {
    const destination = path.join(toolingDir, rel); await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(runtimeDir, rel), destination);
  });
  await inventory(toolingDir);
  const tooling = await verifyPiRuntimeArtifact(toolingDir, options);
  check(tooling.identity === original.identity, 'tooling copy identity differs');
  const ts = (await import(pathToFileURL(resolveOwnerModule('typescript', COMPILER_OWNER)).href)).default;
  const esbuild = await import(pathToFileURL(resolveOwnerModule('esbuild', COMPILER_OWNER)).href);
  const thin = await qualifyMistral(toolingDir, rows, ts, esbuild);
  const counts = { declarationsRemoved: 0, mapsInlined: 0, mapsRetained: 0 };
  await thinMaps(runtimeDir, rows, ts, counts);
  const runtimeMistral = path.join(runtimeDir, 'node_modules', MISTRAL);
  const docs = rows.filter(rel => rel.startsWith(path.join('node_modules', MISTRAL) + path.sep) && /(?:^|[\\/])(?:LICENSE[^\\/]*|NOTICE[^\\/]*|README[^\\/]*|docs)(?:[\\/]|$)/i.test(rel));
  await rm(runtimeMistral, { recursive: true }); await mkdir(runtimeMistral);
  await jobs(docs, async rel => { const file = path.join(runtimeDir, rel); await mkdir(path.dirname(file), { recursive: true }); await copyFile(path.join(toolingDir, rel), file); });
  await writeFile(path.join(runtimeMistral, 'bundle.cjs'), thin.bundle);
  // Keep the original ESM namespace instead of exposing synthetic CJS defaults.
  await writeFile(path.join(runtimeMistral, 'index.mjs'), `export { ${BINDINGS.join(', ')} } from './bundle.cjs';\n`);
  await writeFile(path.join(runtimeMistral, 'package.json'), textJson(thin.metadata));
  await writeFile(path.join(runtimeDir, 'tooling-reference.json'), textJson({ schemaVersion: 1, artifactDirectory: '../pi-tooling', identity: original.identity }));
  await writePiRuntimeManifest(runtimeDir, provenance);
  const runtime = await verifyPiRuntimeArtifact(runtimeDir, options), verifiedTooling = await verifyPiRuntimeToolingArtifact(runtimeDir, options);
  check(verifiedTooling.identity === tooling.identity, 'final tooling identity differs');
  return { runtime, tooling: verifiedTooling, evidence: { recipe: 1, typescript: ts.version, esbuild: esbuild.version, config: thin.config, originalIdentity: original.identity, runtimeIdentity: runtime.identity, counts, mistral: { version: thin.metadata.version, sdkUses: thin.sdkUses, graphFiles: thin.graphFiles, external: thin.external } } };
}
