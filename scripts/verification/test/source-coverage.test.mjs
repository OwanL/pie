import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { createRequire, Module } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { collectSourceCoverage } from '../source-coverage.mjs';

const require = createRequire(new URL('../../../harness/pi/packages/agent/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const { require: tsxRequire } = createRequire(import.meta.url)('tsx/cjs/api');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-source-coverage-'));
  const directory = path.join(root, 'coverage');
  mkdirSync(path.join(directory, 'v8'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, cwd: root, includes: ['owner/**/*.ts'] };
}

async function execute(options, source, { format = 'esm', call = '', threadId = 0, pid = 101, captureId, startedAtMs, timestampMs = 123, scriptId, runtimeName, minifyWhitespace = false, generatedCRLF = false, platform, nodeFile = false, tsxCjs = false, define, nativeJS, sparseMap = false, sourceSnapshots = false } = {}) {
  const sourceFile = path.join(options.root, 'owner', `subject.${nativeJS ?? 'ts'}`);
  const generated = tsxCjs || nativeJS ? sourceFile : path.join(options.root, `${runtimeName ?? `runtime-${pid}-${threadId}`}.${format === 'cjs' ? 'cjs' : 'mjs'}`);
  let snapshots;
  if (sourceSnapshots) {
    mkdirSync(path.dirname(sourceFile), { recursive: true });
    writeFileSync(sourceFile, source);
    snapshots = [{ url: pathToFileURL(sourceFile).href, content: readFileSync(sourceFile, 'utf8') }];
  }
  const output = transformSync(source, {
    loader: nativeJS ? 'js' : 'ts', format, platform, sourcemap: 'inline', sourcesContent: !sparseMap, sourcefile: sourceFile, target: 'node22', minifyWhitespace, charset: 'utf8', define,
  }).code;
  const transformed = generatedCRLF ? output.replaceAll('\n', '\r\n') : output;
  if (nativeJS) mkdirSync(path.dirname(sourceFile), { recursive: true });
  const code = format === 'cjs' ? Module.wrap(transformed) : transformed;
  const session = new Session();
  session.connect();
  const post = (method, args = {}) => new Promise((resolve, reject) => session.post(method, args, (error, result) => error ? reject(error) : resolve(result)));
  const parsed = [];
  session.on('Debugger.scriptParsed', ({ params }) => parsed.push(params));
  try {
    await post('Debugger.enable');
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    let exports;
    if (tsxCjs) {
      mkdirSync(path.dirname(sourceFile), { recursive: true });
      writeFileSync(sourceFile, source);
      exports = tsxRequire(sourceFile, import.meta.url);
    } else if (nodeFile) {
      writeFileSync(generated, transformed);
      exports = require(generated);
    } else if (format === 'cjs') {
      const module = { exports: {} };
      vm.runInThisContext(code, { filename: pathToFileURL(generated).href })(module.exports, require, module, generated, path.dirname(generated));
      exports = module.exports;
    } else {
      writeFileSync(generated, code);
      exports = await import(pathToFileURL(generated).href);
    }
    if (call) vm.runInNewContext(call, { exports });
    const raw = await post('Profiler.takePreciseCoverage');
    const entry = raw.result.find(item => {
      const filename = item.url.startsWith('file:') ? fileURLToPath(item.url) : item.url;
      return filename.replaceAll('\\', '/').toLowerCase() === generated.replaceAll('\\', '/').toLowerCase();
    });
    assert.ok(entry, 'Inspector captured the actual executed script');
    const metadata = parsed.find(item => item.scriptId === entry.scriptId);
    const actual = await post('Debugger.getScriptSource', { scriptId: entry.scriptId });
    const capture = { scriptId: entry.scriptId, url: entry.url, code: actual.scriptSource, sourceMapURL: metadata.sourceMapURL,
      ...(sourceSnapshots ? { sourceSnapshots: snapshots } : {}) };
    // Declared generations may reuse Inspector IDs, just as a later process does.
    if (scriptId) entry.scriptId = capture.scriptId = scriptId;
    writeFileSync(path.join(options.directory, 'v8', `coverage-${pid}-${timestampMs}-${threadId}.json`), JSON.stringify({ result: [entry] }));
    writeFileSync(path.join(options.directory, `scripts-${pid}-${threadId}${captureId ? `-${captureId}` : ''}.json`), JSON.stringify({ schema: 1, pid, threadId, captureId, startedAtMs, scripts: [capture] }));
    return { entry, capture, pid, threadId };
  } finally {
    await post('Profiler.stopPreciseCoverage');
    session.disconnect();
  }
}

const source = `interface Erased { value: string }
export function untouched(flag: boolean) { return flag ? 1 : 2; }
export const anonymous = [(flag: boolean) => flag ? 3 : 4, function () { return 5; }];
`;

test('untouched ternaries and same-line anonymous functions are genuinely uncovered; interfaces are erased', async t => {
  const options = fixture(t);
  await execute(options, source);
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 3);
  assert.equal(report.coveredFunctionCount, 0);
  assert.equal(report.totalBranchCount, 4);
  assert.equal(report.coveredBranchCount, 0);
  assert.ok(report.totalLineCount > 0);
  assert.ok(!report.files[0].lines.some(item => item.line === 1));
});

test('Node CJS debug export annotation does not invent branches on erased interfaces', async t => {
  const options = fixture(t);
  const { capture } = await execute(options, 'interface Erased { value: string }\nexport const value = 1;\n', {
    format: 'cjs', platform: 'node', nodeFile: true, minifyWhitespace: true,
  });
  assert.match(capture.code, /0\s*&&\s*\(module\.exports\s*=/u);
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalBranchCount, 0);
  assert.equal(report.totalFunctionCount, 0);
  assert.equal(report.coveredLinePercent, 100);
  assert.ok(!report.files[0].lines.some(item => item.line === 1));
});

test('actual evaluated TSX CJS lexical wrapper excludes mapped helper leaks and debug annotation', async t => {
  const options = fixture(t);
  const { capture } = await execute(options, 'export const value = 1;\nexport const schema = { type: "object" };\n', { tsxCjs: true });
  assert.match(capture.code, /^__filename=.*;\(\(\)=>\{\nvar __defProp=/u);
  assert.match(capture.code, /0&&\(module\.exports=\{schema,value\}\);\n\}\)\(\)/u);
  const map = JSON.parse(Buffer.from(capture.sourceMapURL.split(',')[1], 'base64').toString('utf8'));
  assert.ok(map.mappings.startsWith(';'), 'TSX leaves the wrapper first line unmapped');
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalBranchCount, 0);
  assert.equal(report.totalFunctionCount, 0);
  assert.equal(report.coveredLinePercent, 100);
});

test('actual TSX anonymous default factory excludes only compiler scaffolding', async t => {
  const options = fixture(t);
  const { capture } = await execute(options, 'export default function (flag: boolean) { return flag ? 1 : 2; }\n', { tsxCjs: true });
  assert.match(capture.code, /default:\(\)=>subject_default/u);
  const report = await collectSourceCoverage(options);
  // TSX's fully executed __name helper is retained; the factory is not.
  assert.equal(report.totalFunctionCount, 2);
  assert.equal(report.coveredFunctionCount, 1);
  assert.equal(report.totalBranchCount, 2);
  assert.equal(report.coveredBranchCount, 0);
});

test('actual TSX imported named reexport excludes compiler debug annotation, not untouched body', async t => {
  const options = fixture(t);
  mkdirSync(path.join(options.root, 'owner'), { recursive: true });
  writeFileSync(path.join(options.root, 'owner', 'binding.js'), 'exports.value = 1;');
  const { capture } = await execute(options, 'export { value as publicValue } from "./binding.js";\nexport function untouched(flag: boolean) { return flag ? 1 : 2; }\n', { tsxCjs: true });
  assert.match(capture.code, /publicValue:\(\)=>import_binding.value/u);
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 2);
  assert.equal(report.coveredFunctionCount, 1);
  assert.equal(report.totalBranchCount, 2);
  assert.equal(report.coveredBranchCount, 0);
});

test('TSX nested authored AST-exact helpers and dead annotations remain uncovered', async t => {
  const options = fixture(t);
  await execute(options, `export const value = 1;
export function untouched() {
  var __defProp = Object.defineProperty;
  var __export = (target: object, all: any) => {
    for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __toCommonJS = (mod: any) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var table = {};
  __export(table, { value: () => value });
  module.exports = __toCommonJS(table);
  return 0 && (module.exports = { value });
}
`, { tsxCjs: true });
  const report = await collectSourceCoverage(options);
  assert.ok(report.totalFunctionCount > report.coveredFunctionCount);
  assert.ok(report.totalFunctionCount >= 4);
  assert.ok(report.files[0].lines.some(item => item.line === 5 && item.count === 0));
  // esbuild folds the authored constant-zero expression; the source match
  // must still keep the generated trailing lookalike rather than ignoring it.
  assert.ok(report.files[0].branches.some(branch => branch.counts.includes(0)));
});

test('authored dead module.exports annotations retain zero-count branches', async t => {
  const options = fixture(t);
  await execute(options, 'export const value = 1;\nexport function untouched() { return 0 && (module.exports = { value, untouched }); }\n', {
    format: 'cjs', platform: 'node', nodeFile: true, minifyWhitespace: true,
  });
  const report = await collectSourceCoverage(options);
  assert.ok(report.totalBranchCount > report.coveredBranchCount);
  assert.ok(report.files[0].branches.some(branch => branch.locations.some((loc, index) =>
    loc.start.line === 2 && branch.counts[index] === 0)));
  assert.equal(report.coveredFunctionCount, 0);
  // The source-level match also prevents treating the trailing lookalike as
  // synthetic, even though its dead RHS is never executed.
  assert.ok(report.files[0].branches.some(branch => branch.counts.includes(0) && branch.counts.includes(1)));
});

test('authored BigInt declarations and untouched BigInt branches survive CJS scaffold matching', async t => {
  const options = fixture(t);
  await execute(options, 'export const value = 1n;\nexport function untouched(flag: boolean) { const other = 2n; return flag ? other : 3n; }\n', {
    format: 'cjs', platform: 'node', nodeFile: true, minifyWhitespace: true,
  });
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 1);
  assert.equal(report.coveredFunctionCount, 0);
  assert.equal(report.totalBranchCount, 2);
  assert.equal(report.coveredBranchCount, 0);
  assert.ok(report.files[0].lines.some(item => item.line === 1 && item.count > 0));
  assert.ok(report.files[0].lines.some(item => item.line === 2 && item.count === 0));
});

test('esbuild import.meta CLI define expression sources retain authored coverage and fail closed', async t => {
  const options = fixture(t);
  const meta = { dirname: options.root, filename: path.join(options.root, 'owner', 'subject.ts'), url: pathToFileURL(path.join(options.root, 'owner', 'subject.ts')).href };
  const record = await execute(options, 'export const filename = import.meta.filename;\nexport function untouched(flag: boolean) { return flag ? import.meta.dirname : import.meta.url; }\n', {
    format: 'cjs', platform: 'node', nodeFile: true, minifyWhitespace: true,
    define: { 'import.meta': JSON.stringify(meta) },
  });
  const originalMap = JSON.parse(Buffer.from(record.capture.sourceMapURL.split(',')[1], 'base64').toString('utf8'));
  const index = originalMap.sources.indexOf('<define:import.meta>');
  assert.ok(index >= 0, 'actual esbuild output identifies its define expression');
  assert.deepEqual(JSON.parse(originalMap.sourcesContent[index]), meta);
  const report = await collectSourceCoverage(options);
  assert.equal(report.files.length, 1);
  assert.equal(report.totalFunctionCount, 1);
  assert.equal(report.coveredFunctionCount, 0);
  assert.equal(report.totalBranchCount, 2);
  assert.equal(report.coveredBranchCount, 0);
  assert.ok(report.files[0].lines.some(item => item.line === 2 && item.count === 0));
  const saveMap = map => {
    const sourceMapURL = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    const capture = { ...record.capture, sourceMapURL, code: record.capture.code.replace(record.capture.sourceMapURL, sourceMapURL).padEnd(record.capture.code.length, ' ') };
    writeFileSync(path.join(options.directory, 'scripts-101-0.json'), JSON.stringify({ schema: 1, pid: 101, threadId: 0, scripts: [capture] }));
  };
  const authoredMap = structuredClone(originalMap);
  authoredMap.sources[index] = path.join(options.root, 'owner', '<define:import.meta>');
  saveMap(authoredMap);
  await assert.rejects(collectSourceCoverage(options), error => error.cause?.reasonCode === 'MissingSemicolon');
  const malformedMap = structuredClone(originalMap);
  malformedMap.sourcesContent[index] = '{ malformed:';
  saveMap(malformedMap);
  await assert.rejects(collectSourceCoverage(options), error => error.cause?.code === 'BABEL_PARSER_SYNTAX_ERROR');
});

test('Node debug annotation follows verified renamed class export bindings', async t => {
  const options = fixture(t);
  await execute(options, 'interface Erased {}\nexport class __export {}\nexport { __export as Alias };\n', {
    format: 'cjs', platform: 'node', nodeFile: true, minifyWhitespace: true,
  });
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalBranchCount, 0);
  assert.equal(report.coveredLinePercent, 100);
  assert.ok(!report.files[0].lines.some(item => item.line === 1));
});

test('anonymous default CJS and ESM graphs retain standard complementary branch counts', async t => {
  const options = fixture(t);
  const authored = 'export default function (flag: boolean) { return flag ? 1 : 2; }\n';
  await execute(options, authored, { format: 'cjs', call: 'exports.default(true)', pid: 501 });
  await execute(options, authored, { call: 'exports.default(false)', pid: 502 });
  const report = await collectSourceCoverage(options);
  assert.equal(report.convertedScripts, 2);
  assert.equal(report.totalFunctionCount, 1);
  assert.equal(report.coveredFunctionCount, 1);
  assert.equal(report.totalBranchCount, 2);
  assert.equal(report.coveredBranchCount, 2);
  assert.ok(report.files[0].branches.every(branch => branch.counts.every(count => count === 1)));
});

test('CJS and ESM source-compatible unions cover both arms and are order stable', async t => {
  const options = fixture(t);
  await execute(options, source, { format: 'cjs', call: 'exports.untouched(true); exports.anonymous[0](true)', pid: 102 });
  await execute(options, source, { call: 'exports.untouched(false); exports.anonymous[0](false); exports.anonymous[1]()', pid: 102, threadId: 7 });
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 3);
  assert.equal(report.coveredFunctionCount, 3);
  assert.equal(report.totalBranchCount, 4);
  assert.equal(report.coveredBranchCount, 4);
  assert.equal(report.coveredLinePercent, 100);
  assert.equal(report.convertedScripts, 2, 'CJS and ESM transforms stay separate');
  // Reverse filename sorting without altering record identities.
  const { renameSync } = await import('node:fs');
  renameSync(path.join(options.directory, 'v8', 'coverage-102-123-0.json'), path.join(options.directory, 'v8', 'coverage-102-999-0.json'));
  renameSync(path.join(options.directory, 'v8', 'coverage-102-123-7.json'), path.join(options.directory, 'v8', 'coverage-102-001-7.json'));
  assert.deepEqual(await collectSourceCoverage(options), report);
});

test('identical compiled executions merge complementary real branches before one conversion', async t => {
  const options = fixture(t);
  const first = await execute(options, source, { format: 'cjs', pid: 401,
    call: 'exports.untouched(true); exports.anonymous[0](true)' });
  const second = await execute(options, source, { format: 'cjs', pid: 402,
    call: 'exports.untouched(false); exports.anonymous[0](false); exports.anonymous[1]()' });
  assert.equal(first.capture.code, second.capture.code);
  assert.notEqual(first.capture.url, second.capture.url, 'isolated execution paths differ');
  const report = await collectSourceCoverage(options);
  assert.equal(report.convertedScripts, 1);
  assert.equal(report.totalFunctionCount, 3);
  assert.equal(report.coveredFunctionCount, 3);
  assert.equal(report.totalBranchCount, 4);
  assert.equal(report.coveredBranchCount, 4);
  assert.equal(report.coveredLinePercent, 100);
  assert.ok(report.files[0].branches.every(branch => branch.counts.every(count => count === 1)));
  // Every raw record still needs validation, even after an equal transform was seen.
  second.entry.functions[0].ranges[0].endOffset = second.capture.code.length + 1;
  writeFileSync(path.join(options.directory, 'v8', 'coverage-402-123-0.json'), JSON.stringify({ result: [second.entry] }));
  await assert.rejects(collectSourceCoverage(options), /range\/code capture mismatch/i);
});

test('identical code with different captured map layouts is converted separately', async t => {
  const options = fixture(t);
  const first = await execute(options, source, { format: 'cjs', pid: 411, call: 'exports.untouched(true)' });
  const second = await execute(options, source, { format: 'cjs', pid: 412, call: 'exports.untouched(false)' });
  const map = JSON.parse(Buffer.from(second.capture.sourceMapURL.split(',')[1], 'base64').toString('utf8'));
  map.mappings += ';'; // A distinct, valid generated-line layout.
  for (const record of [first, second]) {
    record.capture.code = record.capture.code.replace(/\/\/# sourceMappingURL=.*$/mu, value => ' '.repeat(value.length));
  }
  second.capture.sourceMapURL = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
  assert.equal(first.capture.code, second.capture.code);
  for (const record of [first, second]) {
    writeFileSync(path.join(options.directory, `scripts-${record.pid}-0.json`), JSON.stringify({ schema: 1, pid: record.pid, threadId: 0, scripts: [record.capture] }));
  }
  const report = await collectSourceCoverage(options);
  assert.equal(report.convertedScripts, 2);
  assert.equal(report.totalBranchCount, 4);
  assert.equal(report.coveredBranchCount, 2);
});

test('PID/thread/script ID reuse selects declared generations by raw timestamp, not URL or filename order', async t => {
  const options = fixture(t);
  const first = await execute(options, source, { pid: 25324, scriptId: '77', runtimeName: 'old',
    captureId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', startedAtMs: 100, timestampMs: 150 });
  const second = await execute(options, source, { pid: 25324, scriptId: '77', runtimeName: 'new',
    captureId: '00000000-0000-4000-8000-000000000000', startedAtMs: 200, timestampMs: 200,
    call: 'exports.untouched(true)' });
  const report = await collectSourceCoverage(options);
  assert.equal(report.files.length, 1, 'identical authored source merges normally');
  assert.equal(report.coveredFunctionCount, 1);
  const raw = (timestamp, entry) => writeFileSync(path.join(options.directory, 'v8', `coverage-25324-${timestamp}-0.json`), JSON.stringify({
    result: [entry], 'source-map-cache': { [entry.url]: { data: { sources: [path.join(options.root, 'owner', 'subject.ts')] } } },
  }));
  raw(99, first.entry);
  await assert.rejects(collectSourceCoverage(options), /Missing.*generation/i);
  rmSync(path.join(options.directory, 'v8', 'coverage-25324-99-0.json'));
  raw(199, second.entry);
  await assert.rejects(collectSourceCoverage(options), /URL mismatch/i);
  rmSync(path.join(options.directory, 'v8', 'coverage-25324-199-0.json'));
  raw(200, first.entry);
  await assert.rejects(collectSourceCoverage(options), /URL mismatch/i);
  raw(200, second.entry);
  raw(999999, second.entry);
  assert.equal((await collectSourceCoverage(options)).files.length, 1, 'last generation has no exit-time upper bound');
  raw(999999, first.entry);
  await assert.rejects(collectSourceCoverage(options), /URL mismatch/i);
});

test('same URL and script ID with different transforms retain generation-specific code and maps', async t => {
  const options = fixture(t);
  // CJS VM execution permits the same URL with two genuinely different transforms.
  const first = await execute(options, source, { format: 'cjs', pid: 301, scriptId: '77',
    captureId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', startedAtMs: 100, timestampMs: 199 });
  const second = await execute(options, source, { format: 'cjs', minifyWhitespace: true, pid: 301, scriptId: '77',
    captureId: '00000000-0000-4000-8000-000000000000', startedAtMs: 200, timestampMs: 201,
    call: 'exports.untouched(true)' });
  assert.equal(first.capture.url, second.capture.url);
  assert.notEqual(first.capture.code, second.capture.code);
  const report = await collectSourceCoverage(options);
  assert.equal(report.convertedScripts, 2, 'different generated layouts stay separate');
  assert.equal(report.files.length, 1);
  assert.equal(report.coveredFunctionCount, 1);
  writeFileSync(path.join(options.directory, 'v8', 'coverage-301-201-0.json'), JSON.stringify({ result: [first.entry] }));
  await assert.rejects(collectSourceCoverage(options), /range\/code capture mismatch/i);
});

test('multiple generations without starts or with identical starts fail closed', async t => {
  const options = fixture(t);
  const first = await execute(options, source);
  const name = path.join(options.directory, 'scripts-101-0-00000000-0000-4000-8000-000000000000.json');
  const save = startedAtMs => writeFileSync(name, JSON.stringify({ schema: 1, pid: 101, threadId: 0,
    captureId: '00000000-0000-4000-8000-000000000000', startedAtMs, scripts: [first.capture] }));
  save(100);
  await assert.rejects(collectSourceCoverage(options), /Ambiguous.*generation/i);
  writeFileSync(path.join(options.directory, 'scripts-101-0.json'), JSON.stringify({ schema: 1, pid: 101, threadId: 0,
    startedAtMs: 100, scripts: [first.capture] }));
  await assert.rejects(collectSourceCoverage(options), /Ambiguous.*generation/i);
  save(-1);
  await assert.rejects(collectSourceCoverage(options), /Invalid.*capture/i);
});

test('enum and namespace runtime and user-authored helper-like functions remain executable', async t => {
  const options = fixture(t);
  await execute(options, `export enum Choice { A, B }
export namespace Space { export const run = (flag: boolean) => flag ? Choice.A : Choice.B; }
export function __toCommonJS(flag: boolean) { return flag ? 1 : 2; }
`, { format: 'cjs', call: 'exports.Space.run(true)' });
  const report = await collectSourceCoverage(options);
  assert.ok(report.coveredFunctionCount > 0);
  assert.ok(report.totalFunctionCount > report.coveredFunctionCount);
  assert.ok(report.totalBranchCount > report.coveredBranchCount);
  assert.ok(report.files[0].lines.some(item => item.line === 1));
  assert.ok(report.files[0].lines.some(item => item.line === 2));
});

test('whitespace-minified CJS export scaffolding does not cover untouched user code', async t => {
  const options = fixture(t);
  await execute(options, source, { format: 'cjs', minifyWhitespace: true });
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 3);
  assert.equal(report.coveredFunctionCount, 0);
  assert.equal(report.totalBranchCount, 4);
  assert.equal(report.coveredBranchCount, 0);
  assert.ok(!report.files[0].lines.some(item => item.line === 1));
});

test('a user-authored AST-exact esbuild helper is not ignored', async t => {
  const options = fixture(t);
  await execute(options, `const __defProp = Object.defineProperty;
export const __export = (target: object, all: any) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
`, { format: 'cjs', minifyWhitespace: true });
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 1);
  assert.equal(report.coveredFunctionCount, 0);
  assert.ok(report.files[0].lines.some(item => item.line === 3 && item.count === 0));
});

test('valid TS angle-bracket assertions are not parsed as JSX', async t => {
  const options = fixture(t);
  await execute(options, 'export const value = <number>1;\nexport function untouched() { return <number>2; }\n', { format: 'cjs' });
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 1);
  assert.equal(report.coveredFunctionCount, 0);
  assert.equal(report.totalLineCount, 2);
});

test('CRLF and non-ASCII use UTF-16 offsets with a real CJS wrapper', async t => {
  const options = fixture(t);
  await execute(options, 'interface Erased { text: string }\r\nexport const label = "😀é";\r\nexport function choose(flag: boolean) { return flag ? "✓" : "✗"; }\r\n', {
    format: 'cjs', call: 'exports.choose(true)', generatedCRLF: true,
  });
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 1);
  assert.equal(report.coveredFunctionCount, 1);
  assert.equal(report.totalBranchCount, 2);
  assert.equal(report.coveredBranchCount, 1);
  assert.ok(!report.files[0].lines.some(item => item.line === 1));
});

test('included TS fails closed on missing capture, map and conflicting source identity', async t => {
  const options = fixture(t);
  const record = await execute(options, source);
  // Match source URL directly so absent capture cannot be hidden by a generated URL.
  record.entry.url = pathToFileURL(path.join(options.root, 'owner', 'subject.ts')).href;
  record.capture.url = record.entry.url;
  const rawPath = path.join(options.directory, 'v8', 'coverage-101-123-0.json');
  const capturePath = path.join(options.directory, 'scripts-101-0.json');
  writeFileSync(rawPath, JSON.stringify({ result: [record.entry] }));
  rmSync(capturePath);
  await assert.rejects(collectSourceCoverage(options), /capture/i);
  const save = capture => writeFileSync(capturePath, JSON.stringify({ schema: 1, pid: 101, threadId: 0, scripts: [capture] }));
  save({ ...record.capture, sourceMapURL: '', code: record.capture.code.replace(/\/\/# sourceMappingURL=.*$/mu, value => ' '.repeat(value.length)) });
  await assert.rejects(collectSourceCoverage(options), /map/i);
  save({ ...record.capture, sourceMapURL: 'data:application/json;base64,e30=' });
  await assert.rejects(collectSourceCoverage(options), /conflicting source map/i);
  save({ ...record.capture, url: record.capture.url + '?wrong' });
  await assert.rejects(collectSourceCoverage(options), /URL mismatch/i);
  save({ ...record.capture, code: record.capture.code.slice(0, -10) });
  await assert.rejects(collectSourceCoverage(options), /map|range/i);
  const originalMap = JSON.parse(Buffer.from(record.capture.sourceMapURL.split(',')[1], 'base64').toString('utf8'));
  const saveMap = map => {
    const sourceMapURL = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    save({ ...record.capture, sourceMapURL, code: record.capture.code.replace(record.capture.sourceMapURL, sourceMapURL).padEnd(record.capture.code.length, ' ') });
  };
  saveMap({ ...originalMap, sourcesContent: undefined });
  await assert.rejects(collectSourceCoverage(options), /source map identity/i);
  saveMap({ ...originalMap, sources: [path.join(options.root, 'unrelated.ts')] });
  await assert.rejects(collectSourceCoverage(options), /source identity/i);
  save(record.capture);
  await execute(options, source.replace('value: string', 'value: number'), { pid: 104 });
  await assert.rejects(collectSourceCoverage(options), /source identity/i);
});

test('uncaptured generated URLs fail closed when raw map origins are included', async t => {
  const options = fixture(t);
  const url = pathToFileURL(path.join(options.root, 'generated', 'temp.mjs')).href;
  const entry = { scriptId: '77', url, functions: [] };
  const rawPath = path.join(options.directory, 'v8', 'coverage-201-123-0.json');
  writeFileSync(path.join(options.directory, 'scripts-201-0.json'), JSON.stringify({ schema: 1, pid: 201, threadId: 0, scripts: [] }));
  const save = data => writeFileSync(rawPath, JSON.stringify({ result: [entry], 'source-map-cache': { [url]: { data } } }));
  for (const data of [
    { sources: ['../owner/subject.ts'] },
    { sourceRoot: '../owner', sources: ['subject.ts'] },
    { sourceRoot: pathToFileURL(path.join(options.root, 'owner')).href, sources: ['subject.ts'] },
    { sources: [path.join(options.root, 'owner', 'subject.ts')] },
    { sources: [null, 'https://foreign.invalid/source.ts', pathToFileURL(path.join(options.root, 'owner', 'subject.ts')).href] },
  ]) {
    save(data);
    await assert.rejects(collectSourceCoverage(options), /Missing script capture:.*temp\.mjs/u);
  }
  for (const data of [
    { sourceRoot: '../node_modules/foreign', sources: ['subject.ts'] },
    { sources: [pathToFileURL(path.join(options.root, '..', 'foreign', 'subject.ts')).href] },
    { sources: [null, 'https://foreign.invalid/source.ts'] },
    { sources: 'invalid' },
    undefined,
  ]) {
    save(data);
    const report = await collectSourceCoverage(options);
    assert.deepEqual(report.files, []);
    assert.equal(report.convertedScripts, 0);
    assert.equal(report.totalLineCount, 0);
  }
  entry.url = pathToFileURL(path.join(options.root, 'owner', 'subject.ts')).href;
  save({ sources: [null] });
  await assert.rejects(collectSourceCoverage(options), /Missing script capture:/u);
});

test('foreign loader-thread records need no generation, but owned records still do', async t => {
  const options = fixture(t);
  const rawPath = path.join(options.directory, 'v8', 'coverage-201-123-1.json');
  const url = pathToFileURL(path.join(options.root, 'generated', 'loader.mjs')).href;
  const save = (url, data) => writeFileSync(rawPath, JSON.stringify({
    result: [{ scriptId: '77', url, functions: [] }], 'source-map-cache': { [url]: { data } },
  }));
  // A main-thread recorder is not evidence for the internal ESM loader thread.
  writeFileSync(path.join(options.directory, 'scripts-201-0.json'), JSON.stringify({ schema: 1, pid: 201, threadId: 0, scripts: [] }));
  save(url, { sources: ['../node_modules/foreign/src.ts'] });
  assert.deepEqual((await collectSourceCoverage(options)).files, []);
  save('node:internal/modules/esm/worker', undefined);
  assert.deepEqual((await collectSourceCoverage(options)).files, []);
  save(pathToFileURL(path.join(options.root, 'owner', 'subject.ts')).href, undefined);
  await assert.rejects(collectSourceCoverage(options), /Missing script capture generation:/u);
  save(url, { sources: ['../owner/subject.ts'] });
  await assert.rejects(collectSourceCoverage(options), /Missing script capture generation:/u);
});

test('broad owner globs exclude protected and outside-root runtime paths and map origins', async t => {
  const options = fixture(t);
  options.cwd = path.join(options.root, 'owner');
  options.includes = ['../**/*.ts', '../**/*.js'];
  const rawPath = path.join(options.directory, 'v8', 'coverage-201-123-0.json');
  const capturePath = path.join(options.directory, 'scripts-201-0.json');
  const excluded = ['node_modules', '.git', '.cache', 'cache', 'generated', 'build', 'dist',
    'out', 'out-dev', 'coverage', 'data', 'sessions', 'logs', '.moon', '.turbo'];
  for (const filename of [
    ...excluded.map(part => path.join(options.root, part.toUpperCase(), 'foreign.ts')),
    path.join(options.root, '..', 'foreign.ts'),
  ]) {
    const sourceURL = pathToFileURL(filename).href;
    const generatedURL = pathToFileURL(path.join(options.root, 'generated', 'foreign.js')).href;
    const data = { version: 3, sources: [sourceURL], sourcesContent: ['const value = 1;'], names: [], mappings: 'AAAA' };
    const sourceMapURL = `data:application/json;base64,${Buffer.from(JSON.stringify(data)).toString('base64')}`;
    for (const url of [sourceURL, generatedURL]) {
      const entry = { scriptId: '77', url, functions: [] };
      writeFileSync(rawPath, JSON.stringify({ result: [entry], 'source-map-cache': { [url]: { data } } }));
      for (const scripts of [[], [{ scriptId: '77', url, code: 'const value = 1;', sourceMapURL }]]) {
        writeFileSync(capturePath, JSON.stringify({ schema: 1, pid: 201, threadId: 0, scripts }));
        const report = await collectSourceCoverage(options);
        assert.deepEqual(report.files, []);
        assert.equal(report.convertedScripts, 0);
        assert.equal(report.totalLineCount, 0);
      }
    }
  }
  // Widening to genuine owned origins still requires capture.
  const url = pathToFileURL(path.join(options.root, 'generated', 'owned.js')).href;
  writeFileSync(capturePath, JSON.stringify({ schema: 1, pid: 201, threadId: 0, scripts: [] }));
  writeFileSync(rawPath, JSON.stringify({ result: [{ scriptId: '77', url, functions: [] }],
    'source-map-cache': { [url]: { data: { sources: ['../owned/subject.ts'] } } } }));
  await assert.rejects(collectSourceCoverage(options), /Missing script capture:/u);
});

test('dependency saxes external cached map cannot establish owner provenance', async t => {
  const options = fixture(t);
  options.cwd = path.join(options.root, 'application', 'hosts', 'vscode');
  options.includes = ['src/**/*.ts'];
  const url = pathToFileURL(path.join(options.cwd, 'node_modules', 'saxes', 'saxes.js')).href;
  // Shape observed in Node's raw cache: an external dependency map has
  // already been normalized to the unrelated owner's source directory.
  const wrongSource = pathToFileURL(path.join(options.cwd, 'src', 'saxes.ts')).href;
  const rawPath = path.join(options.directory, 'v8', 'coverage-201-123-0.json');
  writeFileSync(rawPath, JSON.stringify({ result: [{ scriptId: '77', url, functions: [] }],
    'source-map-cache': { [url]: { url: `${url}.map`, data: { version: 3, sources: [wrongSource], sourcesContent: [null], mappings: '' } } } }));
  assert.deepEqual((await collectSourceCoverage(options)).files, []);
  writeFileSync(path.join(options.directory, 'scripts-201-0.json'), JSON.stringify({ schema: 1, pid: 201, threadId: 0,
    scripts: [{ scriptId: '77', url, code: '//# sourceMappingURL=saxes.js.map', sourceMapURL: 'saxes.js.map' }] }));
  assert.deepEqual((await collectSourceCoverage(options)).files, []);
  // An exact inline capture remains positive provenance, even in a dependency.
  const sourceMapURL = `data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: [wrongSource], sourcesContent: ['const value = 1;'], names: [], mappings: 'AAAA' })).toString('base64')}`;
  writeFileSync(path.join(options.directory, 'scripts-201-0.json'), JSON.stringify({ schema: 1, pid: 201, threadId: 0,
    scripts: [{ scriptId: '77', url, code: 'const value = 1;', sourceMapURL }] }));
  assert.equal((await collectSourceCoverage(options)).convertedScripts, 1);
});

test('raw cache relative sources resolve against map URL, but absolute sources remain facts', async t => {
  const options = fixture(t);
  const url = pathToFileURL(path.join(options.root, 'generated', 'temp.js')).href;
  const mapURL = pathToFileURL(path.join(options.root, 'owner', 'maps', 'temp.js.map')).href;
  const save = sources => writeFileSync(path.join(options.directory, 'v8', 'coverage-201-123-0.json'), JSON.stringify({
    result: [{ scriptId: '77', url, functions: [] }], 'source-map-cache': { [url]: { url: mapURL, data: { sources } } },
  }));
  save(['../subject.ts']);
  await assert.rejects(collectSourceCoverage(options), /Missing script capture generation/u);
  save([pathToFileURL(path.join(options.root, 'owner', 'subject.ts')).href]);
  await assert.rejects(collectSourceCoverage(options), /Missing script capture generation/u);
  save(['../../node_modules/foreign.ts']);
  assert.deepEqual((await collectSourceCoverage(options)).files, []);
});

test('sparse transformed native JS self maps require exact pre-execution source snapshots', async t => {
  for (const extension of ['mjs', 'js', 'cjs']) {
    const options = fixture(t);
    options.includes = ['owner/**/*'];
    const physical = 'export function untouched(flag) {\n  return flag ? 1 : 2;\n}\n';
    const record = await execute(options, physical, { nativeJS: extension, format: extension === 'mjs' ? 'esm' : 'cjs',
      nodeFile: extension !== 'mjs', sparseMap: true, sourceSnapshots: true, minifyWhitespace: true });
    assert.ok(!record.capture.code.startsWith(physical), 'runtime bytes differ from physical source');
    const report = await collectSourceCoverage(options);
    assert.equal(report.totalFunctionCount, 1);
    assert.equal(report.coveredFunctionCount, 0);
    assert.equal(report.totalBranchCount, 2);
    assert.equal(report.coveredBranchCount, 0);
    assert.ok(report.files[0].branches.every(branch => branch.locations.every(loc => loc.start.line === 2)));
    // Conversion cannot reread a newer physical file or use transformed bytes.
    writeFileSync(path.join(options.root, 'owner', `subject.${extension}`), 'throw new Error("modified");');
    assert.deepEqual(await collectSourceCoverage(options), report);
    const save = capture => writeFileSync(path.join(options.directory, 'scripts-101-0.json'), JSON.stringify({ schema: 1, pid: 101, threadId: 0, scripts: [capture] }));
    for (const sourceSnapshots of [undefined, [], [{ url: record.capture.url + '.wrong', content: physical }],
      [{ url: record.capture.url, content: '' }], [{ url: record.capture.url, content: physical }, { url: record.capture.url, content: physical + ' ' }]]) {
      save({ ...record.capture, sourceSnapshots });
      await assert.rejects(collectSourceCoverage(options), /source map identity|source snapshot/iu);
    }
    save({ ...record.capture, url: record.capture.url + '.wrong' });
    await assert.rejects(collectSourceCoverage(options), /URL mismatch/u);
    save(record.capture);
    writeFileSync(path.join(options.directory, 'v8', 'coverage-202-123-0.json'), JSON.stringify({ result: [record.entry] }));
    writeFileSync(path.join(options.directory, 'scripts-202-0.json'), JSON.stringify({ schema: 1, pid: 202, threadId: 0,
      scripts: [{ ...record.capture, sourceSnapshots: [{ url: record.capture.url, content: physical + '\n// modified snapshot' }] }] }));
    await assert.rejects(collectSourceCoverage(options), /Conflicting source identity/u);
  }
});

test('snapshots cannot complete typed maps or override captured source content', async t => {
  const options = fixture(t);
  await execute(options, source, { sparseMap: true, sourceSnapshots: true });
  await assert.rejects(collectSourceCoverage(options), /Incomplete source map identity/u);
  const record = await execute(options, source, { sourceSnapshots: true, runtimeName: 'complete-map' });
  record.capture.sourceSnapshots[0].content += '\n// modified snapshot';
  writeFileSync(path.join(options.directory, 'scripts-101-0.json'), JSON.stringify({ schema: 1, pid: 101, threadId: 0, scripts: [record.capture] }));
  await assert.rejects(collectSourceCoverage(options), /Conflicting source snapshot/u);
});

test('unknown native JavaScript uses captured code without excluding test-looking paths', async t => {
  const options = fixture(t);
  options.cwd = path.join(options.root, 'test');
  options.includes = ['*.js'];
  const url = pathToFileURL(path.join(options.root, 'test', 'native.test.js')).href;
  const code = 'function __toCommonJS(flag) { return flag ? 1 : 2; }';
  const entry = { scriptId: '77', url, functions: [
    { functionName: '', ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }], isBlockCoverage: true },
    { functionName: '__toCommonJS', ranges: [{ startOffset: 0, endOffset: code.length, count: 0 }], isBlockCoverage: false },
  ] };
  writeFileSync(path.join(options.directory, 'v8', 'coverage-201-123-0.json'), JSON.stringify({ result: [entry] }));
  writeFileSync(path.join(options.directory, 'scripts-201-0.json'), JSON.stringify({ schema: 1, pid: 201, threadId: 0, scripts: [{ scriptId: '77', url, code, sourceMapURL: '' }] }));
  const report = await collectSourceCoverage(options);
  assert.equal(report.totalFunctionCount, 1);
  assert.equal(report.coveredFunctionCount, 0);
  assert.equal(report.totalBranchCount, 2);
});
