import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const preload = fileURLToPath(new URL('../coverage-capture.cjs', import.meta.url));
const tsxImport = pathToFileURL(require.resolve('tsx')).href;
const tsxCjs = require.resolve('tsx/cjs');
const sameFile = (url, filename) => path.relative(filename, url.startsWith('file://') ? fileURLToPath(url) : url) === '';

function fixture(t) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'pie-coverage-capture-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'source');
  const directory = path.join(temporary, 'capture');
  mkdirSync(root);
  mkdirSync(directory);
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    PIE_TEST_COVERAGE_ROOT: root,
    PIE_TEST_COVERAGE_DIR: directory,
    NODE_V8_COVERAGE: path.join(directory, 'v8'),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.PIE_TEST_COVERAGE_CWD;
  delete env.PIE_TEST_COVERAGE_INCLUDES;
  const runs = [];
  const run = (args, extra = {}) => {
    const before = Date.now();
    const result = spawnSync(process.execPath, args, {
      cwd: root, env, encoding: 'utf8', timeout: 30_000, ...extra,
    });
    runs.push({ before, after: Date.now() });
    return result;
  };
  const records = () => readdirSync(directory).filter(name => name.startsWith('scripts-'))
    .map(name => {
      const record = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
      assert.match(record.captureId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(name, `scripts-${record.pid}-${record.threadId}-${record.captureId}.json`);
      assert.ok(Number.isInteger(record.startedAtMs));
      assert.ok(runs.some(({ before, after }) => record.startedAtMs >= before && record.startedAtMs <= after));
      return record;
    });
  return { temporary, root, directory, env, run, records };
}

test('separate generations with reused PID/thread preserve earlier capture files', t => {
  const f = fixture(t);
  const source = readFileSync(preload, 'utf8');
  const url = pathToFileURL(path.join(f.root, 'reused.cjs')).href;
  const load = (timeOrigin, code) => {
    const fakeProcess = Object.assign(new EventEmitter(), {
      pid: 1234, execArgv: [], env: f.env,
    });
    class Session extends EventEmitter {
      connect() {}
      post(method, params, callback) {
        if (method === 'Debugger.enable') {
          this.emit('Debugger.scriptParsed', { params: { scriptId: '1', url, sourceMapURL: 'exact-map' } });
          params();
        } else callback(null, { scriptSource: code });
      }
    }
    runInNewContext(`(function(require, process) { ${source}\n})`)(name => name === 'node:inspector' ? { Session }
      : name === 'node:worker_threads' ? { threadId: 0 }
      : name === 'node:perf_hooks' ? { performance: { timeOrigin } }
      : require(name), fakeProcess);
    fakeProcess.emit('exit');
    assert.equal(fakeProcess.exitCode, undefined);
    return fakeProcess;
  };
  const first = load(1000.9, 'first exact bytes');
  const [firstName] = readdirSync(f.directory);
  const firstBytes = readFileSync(path.join(f.directory, firstName), 'utf8');
  const second = load(2000.9, 'second exact bytes');
  // Rewriting each generation must target only its own file.
  first.emit('exit');
  second.emit('exit');
  const names = readdirSync(f.directory);
  assert.equal(names.length, 2);
  assert.equal(readFileSync(path.join(f.directory, firstName), 'utf8'), firstBytes);
  const records = names.map(name => JSON.parse(readFileSync(path.join(f.directory, name), 'utf8')));
  assert.equal(new Set(records.map(record => record.captureId)).size, 2);
  assert.deepEqual(records.map(record => record.startedAtMs).sort(), [1000, 2000]);
  for (const [index, record] of records.sort((a, b) => a.startedAtMs - b.startedAtMs).entries()) {
    assert.equal(record.schema, 1);
    assert.equal(record.pid, 1234);
    assert.equal(record.threadId, 0);
    assert.ok(names.includes(`scripts-1234-0-${record.captureId}.json`));
    assert.deepEqual(record.scripts, [{ scriptId: '1', url, code: index ? 'second exact bytes' : 'first exact bytes', sourceMapURL: 'exact-map' }]);
  }
});

for (const format of ['cjs', 'esm']) {
  test(`captures exact evaluated ${format} TypeScript with native V8 counts`, t => {
    const f = fixture(t);
    const source = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nconst classify = (value: number): string => value > 0 ? 'positive' : 'other';\ntest('typed branch', () => assert.equal(classify(1), 'positive'));\n`;
    const filename = path.join(f.root, format === 'cjs' ? 'typed.cts' : 'typed.mts');
    writeFileSync(filename, source);
    const entry = path.join(f.root, `entry.${format === 'cjs' ? 'cjs' : 'mjs'}`);
    writeFileSync(entry, format === 'cjs'
      ? `require(${JSON.stringify(tsxCjs)}); require(${JSON.stringify(filename)});`
      : `import ${JSON.stringify(pathToFileURL(filename).href)};`);
    const result = f.run(['--import', tsxImport, '--experimental-test-coverage', entry]);
    assert.equal(result.status, 0, result.stderr + result.stdout + readdirSync(f.directory).filter(name => name.startsWith('recorder-error-')).map(name => readFileSync(path.join(f.directory, name), 'utf8')).join('\n'));
    assert.ok(!readdirSync(f.directory).some(name => name.startsWith('recorder-error-')));
    const raw = readdirSync(path.join(f.directory, 'v8')).filter(name => name.endsWith('.json'))
      .flatMap(name => JSON.parse(readFileSync(path.join(f.directory, 'v8', name), 'utf8')).result);
    let matched = false;
    for (const record of f.records()) {
      assert.equal(record.schema, 1);
      assert.equal(typeof record.pid, 'number');
      assert.equal(typeof record.threadId, 'number');
      for (const script of record.scripts.filter(script => sameFile(script.url, filename))) {
        assert.notEqual(script.code, source);
        assert.ok(!script.code.includes('value: number'));
        assert.match(script.sourceMapURL, /^data:application\/json.*base64,/);
        const map = JSON.parse(Buffer.from(script.sourceMapURL.split('base64,')[1], 'base64').toString());
        assert.ok(map.sourcesContent.includes(source));
        const coverage = raw.find(item => item.scriptId === script.scriptId && item.url === script.url);
        assert.ok(coverage, `Missing raw V8 record for ${script.url} (${script.scriptId})`);
        assert.ok(coverage.functions.some(fn => fn.ranges.some(range => range.count > 0)));
        assert.ok(coverage.functions.some(fn => fn.ranges.some(range => range.count === 0)));
        matched = true;
      }
    }
    assert.ok(matched, 'Typed script captured');
  });
}

test('snapshots physical native JS before TSX dynamic-import transformed code executes', t => {
  const f = fixture(t);
  const filename = path.join(f.root, 'native.mjs');
  const dependency = path.join(f.root, 'dependency.mjs');
  writeFileSync(dependency, 'export const value = 42;\n');
  const source = `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL(import.meta.url), 'changed after execution');\nexport const value = (await import('./dependency.mjs')).value;\n`;
  writeFileSync(filename, source);
  const entry = path.join(f.root, 'entry.mjs');
  writeFileSync(entry, `import { value } from './native.mjs';\nif (value !== 42) throw new Error('import failed');\n`);
  const result = f.run(['--import', tsxImport, entry]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(filename, 'utf8'), 'changed after execution');
  assert.ok(!readdirSync(f.directory).some(name => name.startsWith('recorder-error-')));
  const scripts = f.records().flatMap(record => record.scripts);
  const script = scripts.find(script => sameFile(script.url, filename));
  assert.ok(script, 'Native JS script captured');
  assert.notEqual(script.code, source);
  assert.match(script.code, /\.then\(/);
  const map = JSON.parse(Buffer.from(script.sourceMapURL.split('base64,')[1], 'base64').toString());
  assert.equal(map.sources.length, 1);
  assert.ok(!map.sourcesContent || map.sourcesContent[0] == null);
  assert.deepEqual(script.sourceSnapshots, [{ url: pathToFileURL(filename).href, content: source }]);
  const plain = scripts.find(script => sameFile(script.url, dependency));
  assert.equal(plain.code, 'export const value = 42;\n');
  assert.equal(plain.sourceSnapshots, undefined, 'No snapshot for unmapped unchanged JS');
});

test('sparse snapshot reads stay self-origin, native JS, owner-selected and fail closed', t => {
  const f = fixture(t);
  const preloadSource = readFileSync(preload, 'utf8');
  const native = path.join(f.root, 'native.js');
  const typed = path.join(f.root, 'typed.ts');
  const foreign = path.join(f.temporary, 'foreign.js');
  const selected = path.join(f.root, 'selected.cjs');
  const invalid = path.join(f.root, 'invalid.mjs');
  const missing = path.join(f.root, 'missing.js');
  const ordinaryDirectory = path.join(f.root, 'directory.js');
  mkdirSync(ordinaryDirectory);
  writeFileSync(native, 'physical bytes');
  writeFileSync(selected, 'selected bytes');
  writeFileSync(invalid, Buffer.from([0xff]));
  const cases = [
    { filename: native, sources: [native], expected: 'physical bytes' },
    { filename: selected, sources: ['./selected.cjs'], expected: 'selected bytes' },
    { filename: native, sources: [native], content: ['embedded bytes'] },
    { filename: native, sources: [selected] },
    { filename: native, sources: [native, foreign] },
    { filename: typed, sources: [typed] },
    { filename: foreign, sources: [foreign] },
    { filename: path.join(f.root, 'out-dev', 'bundle.js'), sources: [selected] },
    { filename: native, sources: [native], includes: ['selected.cjs'] },
    { filename: missing, sources: [missing], error: true },
    { filename: invalid, sources: [invalid], error: true },
    { filename: ordinaryDirectory, sources: [ordinaryDirectory], error: true },
    { filename: native, sources: [native], readError: true, error: true },
  ];
  for (const [index, item] of cases.entries()) {
    const reads = [];
    const fakeProcess = Object.assign(new EventEmitter(), {
      pid: 1234, execArgv: [], env: { ...f.env, PIE_TEST_COVERAGE_CWD: f.root,
        PIE_TEST_COVERAGE_INCLUDES: JSON.stringify(item.includes ?? []) },
    });
    const url = pathToFileURL(item.filename).href;
    const sourceMapURL = `data:application/json;base64,${Buffer.from(JSON.stringify({
      version: 3, sources: item.sources, sourcesContent: item.content, names: [], mappings: 'AAAA',
    })).toString('base64')}`;
    class Session extends EventEmitter {
      connect() {}
      post(method, params, callback) {
        if (method === 'Debugger.enable') {
          this.emit('Debugger.scriptParsed', { params: { scriptId: '1', url, sourceMapURL } });
          params();
        } else {
          if (item.expected !== undefined) assert.deepEqual(reads, [item.filename], 'Read before getScriptSource');
          callback(null, { scriptSource: 'exact generated code' });
        }
      }
    }
    runInNewContext(`(function(require, process) { ${preloadSource}\n})`, { Buffer, URL })(name => name === 'node:inspector' ? { Session }
      : name === 'node:fs' ? { ...require(name), readFileSync(filename) {
        reads.push(filename);
        if (item.readError) throw new Error('required source read failed');
        return readFileSync(filename);
      } } : require(name), fakeProcess);
    fakeProcess.emit('exit');
    assert.equal(fakeProcess.exitCode, item.error ? 125 : undefined, `Case ${index}: ${readdirSync(f.directory).filter(name => name.startsWith('recorder-error-')).map(name => readFileSync(path.join(f.directory, name), 'utf8')).join('')}`);
    const record = readdirSync(f.directory).filter(name => name.startsWith('scripts-'))
      .map(name => JSON.parse(readFileSync(path.join(f.directory, name), 'utf8'))).at(-1);
    const captured = record.scripts.find(script => script.url === url);
    if (item.expected !== undefined) {
      assert.deepEqual(captured.sourceSnapshots, [{ url, content: item.expected }]);
      assert.equal(captured.code, 'exact generated code');
      assert.equal(captured.sourceMapURL, sourceMapURL);
    } else if (!item.error) {
      assert.deepEqual(reads, [], `No widened read in case ${index}`);
      assert.equal(captured?.sourceSnapshots, undefined);
    } else {
      const errorRecord = JSON.parse(readFileSync(path.join(f.directory, 'recorder-error-1234-0.json'), 'utf8'));
      assert.ok(errorRecord.errors.some(error => error.stage === 'sourceSnapshot'));
      assert.equal(captured, undefined);
    }
    for (const name of readdirSync(f.directory)) rmSync(path.join(f.directory, name));
  }
});

for (const singleProcess of [false, true]) {
  test(`native CLI captures two test files (${singleProcess ? 'isolation=none' : 'process isolation'}) without an inspector listener`, t => {
    const f = fixture(t);
    const files = ['first', 'second'].map(name => {
      const filename = path.join(f.root, `${name}.test.cjs`);
      const source = `const { test } = require('node:test');\nconst classify = value => value > 0 ? 'positive' : 'other';\ntest('${name}', () => require('node:assert/strict').equal(classify(1), 'positive'));\n`;
      writeFileSync(filename, source);
      return { filename, source };
    });
    const result = f.run([
      '--test', '--test-concurrency=1', '--experimental-test-coverage',
      ...(singleProcess ? ['--experimental-test-isolation=none'] : []),
      ...files.map(file => file.filename),
    ], {
      env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS}${singleProcess ? '' : ' --inspect-port=0'}` },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.doesNotMatch(result.stderr, /Debugger listening/);
    assert.ok(!readdirSync(f.directory).some(name => name.startsWith('recorder-error-')));
    const records = f.records();
    if (!singleProcess) assert.ok(!records.some(record => record.pid === result.pid), 'Coordinator must not record');
    for (const { filename, source } of files) {
      const record = records.find(record => record.scripts.some(script => sameFile(script.url, filename)));
      assert.ok(record, `Missing captured source for ${filename}`);
      assert.equal(record.pid === result.pid, singleProcess);
      const script = record.scripts.find(script => sameFile(script.url, filename));
      assert.equal(script.code, source);
      const raw = readdirSync(path.join(f.directory, 'v8'))
        .filter(name => name.startsWith(`coverage-${record.pid}-`) && name.endsWith(`-${record.threadId}.json`))
        .flatMap(name => JSON.parse(readFileSync(path.join(f.directory, 'v8', name), 'utf8')).result);
      const coverage = raw.find(item => item.scriptId === script.scriptId && item.url === script.url);
      assert.ok(coverage, `Missing matching raw V8 script ID for ${filename}`);
      assert.ok(coverage.functions.some(fn => fn.ranges.some(range => range.count > 0)));
      assert.ok(coverage.functions.some(fn => fn.ranges.some(range => range.count === 0)));
    }
  });
}

test('inherits into children and workers; captures sourceURL bytes but excludes non-source roots', t => {
  const f = fixture(t);
  const child = path.join(f.root, 'child.cjs');
  writeFileSync(child, 'globalThis.childWasRun = true;');
  const included = path.join(f.root, 'virtual.js');
  const absolute = path.join(f.root, 'absolute.js').replaceAll('\\', '/');
  const excluded = path.join(f.root, 'node_modules', 'sdk.js');
  const output = path.join(f.root, 'out-dev', 'bundle.js');
  const entry = path.join(f.root, 'parent.cjs');
  const code = `globalThis.exact = 'preserved';\n//# sourceURL=${pathToFileURL(included).href}`;
  writeFileSync(entry, `
    const { spawnSync } = require('node:child_process');
    const { Worker } = require('node:worker_threads');
    require('node:vm').runInThisContext(${JSON.stringify(code)});
    require('node:vm').runInThisContext('4;\\n//# sourceURL=${absolute}');
    require('node:vm').runInThisContext('1;\\n//# sourceURL=${pathToFileURL(excluded).href}');
    require('node:vm').runInThisContext('2;\\n//# sourceURL=${output.replaceAll('\\', '/') }');
    require('node:vm').runInThisContext('3;\\n//# sourceURL=node:ignored');
    const result = spawnSync(process.execPath, [${JSON.stringify(child)}], { stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = result.status;
    new Worker(${JSON.stringify(child)});
  `);
  const result = f.run([entry]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const records = f.records();
  assert.ok(records.some(record => record.pid !== result.pid));
  assert.ok(records.some(record => record.threadId !== 0));
  const scripts = records.flatMap(record => record.scripts);
  assert.equal(scripts.find(script => script.url === pathToFileURL(included).href)?.code, code);
  assert.equal(scripts.find(script => script.url === absolute)?.code, `4;\n//# sourceURL=${absolute}`);
  assert.ok(!scripts.some(script => script.url === pathToFileURL(excluded).href || script.url === output.replaceAll('\\', '/')));
});

test('captures inline repo provenance at generated URLs without rewriting URLs or opening an inspector listener', t => {
  const f = fixture(t);
  const owned = pathToFileURL(path.join(f.root, 'source.ts')).href;
  const outside = pathToFileURL(path.join(f.temporary, 'transforms', 'generated.js')).href;
  const cached = pathToFileURL(path.join(f.root, '.cache', 'generated.js')).href;
  const mapURL = (sources, sourceRoot = '') => `data:application/json;base64,${Buffer.from(JSON.stringify({
    version: 3, sources, sourceRoot, sourcesContent: sources.map(() => 'const value: number = 1;'),
    names: [], mappings: 'AAAA',
  })).toString('base64')}`;
  const cases = [
    { url: outside, map: mapURL([owned]), capture: true },
    { url: cached, map: mapURL(['source.ts'], pathToFileURL(f.root).href), capture: true },
    { url: `${outside}?relative`, map: mapURL(['../source/source.ts']), capture: true },
    { url: `${cached}?relative-root`, map: mapURL(['source.ts'], '..'), capture: true },
    { url: `${outside}?absolute-root`, map: mapURL(['source.ts'], f.root), capture: true },
    { url: `${outside}?multiple`, map: mapURL(['https://sdk.invalid/source.ts', owned]), capture: true },
    { url: `${outside}?percent`, map: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({ version: 3, sources: [owned], sourcesContent: ['const value: number = 1;'], names: [], mappings: 'AAAA' }))}`, capture: true },
    { url: `${outside}?foreign`, map: mapURL([pathToFileURL(path.join(f.temporary, 'foreign.ts')).href]), capture: false },
    { url: `${outside}?protected`, map: mapURL([pathToFileURL(path.join(f.root, 'node_modules', 'sdk.ts')).href]), capture: false },
    { url: `${outside}?protected-root`, map: mapURL(['sdk.ts'], pathToFileURL(path.join(f.root, '.cache')).href), capture: false },
    { url: `${cached}?synthetic`, map: mapURL(['<define:import.meta>', '<stdin>'], pathToFileURL(f.root).href), capture: false },
    { url: `${cached}?unknown`, map: mapURL(['webpack://sdk/source.ts']), capture: false },
    { url: `${outside}?external`, map: 'file:///never-read-external.map', capture: false },
    { url: `${outside}?invalid`, map: 'data:application/json;base64,bm90LWpzb24=', capture: false },
    { url: `${outside}?none`, map: '', capture: false },
  ].map((item, index) => ({ ...item, code: `globalThis.mappedValue = ${index};\n//# sourceMappingURL=${item.map}\n//# sourceURL=${item.url}` }));
  const entry = path.join(f.root, 'maps.cjs');
  writeFileSync(entry, `const vm = require('node:vm');\n${cases.map(item => `vm.runInThisContext(${JSON.stringify(item.code)});`).join('\n')}`);
  const result = f.run([entry]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /Debugger listening/);
  assert.ok(!readdirSync(f.directory).some(name => name.startsWith('recorder-error-')));
  const scripts = f.records().flatMap(record => record.scripts);
  const raw = readdirSync(path.join(f.directory, 'v8')).filter(name => name.endsWith('.json'))
    .flatMap(name => JSON.parse(readFileSync(path.join(f.directory, 'v8', name), 'utf8')).result);
  for (const item of cases) {
    const script = scripts.find(script => script.url === item.url);
    assert.equal(Boolean(script), item.capture, item.url);
    if (!item.capture) continue;
    assert.equal(script.code, item.code);
    assert.equal(script.sourceMapURL, item.map);
    assert.ok(raw.some(record => record.url === item.url && record.scriptId === script.scriptId
      && record.functions.some(fn => fn.ranges.some(range => range.count > 0))), item.url);
  }
});

test('captures only owner-selected scripts and inline origins with inherited fixed CWD', t => {
  const f = fixture(t);
  const owner = path.join(f.root, 'owner');
  const other = path.join(f.root, 'other');
  mkdirSync(owner);
  mkdirSync(other);
  mkdirSync(path.join(owner, 'src'));
  const selected = path.join(owner, 'src', 'selected.cjs');
  const unselected = path.join(other, 'loaded.cjs');
  const selectedCode = 'globalThis.selectedWasRun = true;\n';
  const unselectedCode = 'globalThis.otherWasRun = true;\n';
  writeFileSync(selected, selectedCode);
  writeFileSync(unselected, unselectedCode);
  const mapURL = source => `data:application/json;base64,${Buffer.from(JSON.stringify({
    version: 3, sources: [pathToFileURL(source).href], sourcesContent: ['const value: number = 1;'],
    names: [], mappings: 'AAAA',
  })).toString('base64')}`;
  const cases = [
    { origin: path.join(owner, 'src', 'mapped.ts'), capture: true },
    { origin: path.join(other, 'mapped.ts'), capture: false },
    { origin: path.join(owner, 'src', 'generated', 'mapped.ts'), capture: false },
    { origin: path.join(f.temporary, 'foreign.ts'), capture: false },
  ].map((item, index) => {
    const url = pathToFileURL(path.join(f.root, 'out-dev', `generated-${index}.js`)).href;
    const map = mapURL(item.origin);
    return { ...item, url, map, code: `globalThis.mappedValue = ${index};\n//# sourceMappingURL=${map}\n//# sourceURL=${url}` };
  });
  const child = path.join(f.root, 'child.cjs');
  writeFileSync(child, `
    process.chdir(${JSON.stringify(other)});
    require(${JSON.stringify(selected)});
    require(${JSON.stringify(unselected)});
    if (!globalThis.selectedWasRun || !globalThis.otherWasRun) throw new Error('sources did not execute');
    ${cases.map(item => `require('node:vm').runInThisContext(${JSON.stringify(item.code)});`).join('\n')}
  `);
  const entry = path.join(f.root, 'parent.cjs');
  writeFileSync(entry, `
    process.chdir(${JSON.stringify(other)});
    const result = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(child)}], { stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = result.status;
  `);
  const result = f.run([entry], { env: {
    ...f.env, PIE_TEST_COVERAGE_CWD: owner,
    PIE_TEST_COVERAGE_INCLUDES: JSON.stringify(['src\\\\**\\\\*.{cjs,ts}', '../../foreign.ts']),
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(!readdirSync(f.directory).some(name => name.startsWith('recorder-error-')));
  const records = f.records();
  const scripts = records.flatMap(record => record.scripts);
  assert.ok(records.some(record => record.pid !== result.pid));
  assert.equal(scripts.find(script => sameFile(script.url, selected))?.code, selectedCode);
  for (const filename of [unselected, entry, child]) {
    assert.ok(!scripts.some(script => sameFile(script.url, filename)), filename);
  }
  for (const item of cases) {
    const script = scripts.find(script => script.url === item.url);
    assert.equal(Boolean(script), item.capture, item.url);
    if (item.capture) {
      assert.equal(script.code, item.code);
      assert.equal(script.sourceMapURL, item.map);
    }
  }
});

test('empty owner includes retain accounting full-root semantics', t => {
  const f = fixture(t);
  const entry = path.join(f.root, 'entry.cjs');
  writeFileSync(entry, 'globalThis.ran = true;');
  const result = f.run([entry], { env: {
    ...f.env, PIE_TEST_COVERAGE_CWD: f.root, PIE_TEST_COVERAGE_INCLUDES: '[]',
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.records().flatMap(record => record.scripts).find(script => sameFile(script.url, entry))?.code,
    'globalThis.ran = true;');
});

for (const [name, configuration] of [
  ['missing includes', root => ({ PIE_TEST_COVERAGE_CWD: root })],
  ['missing CWD', () => ({ PIE_TEST_COVERAGE_INCLUDES: '["**/*.cjs"]' })],
  ['relative CWD', () => ({ PIE_TEST_COVERAGE_CWD: '.', PIE_TEST_COVERAGE_INCLUDES: '[]' })],
  ['empty CWD', () => ({ PIE_TEST_COVERAGE_CWD: '', PIE_TEST_COVERAGE_INCLUDES: '[]' })],
  ['invalid JSON', root => ({ PIE_TEST_COVERAGE_CWD: root, PIE_TEST_COVERAGE_INCLUDES: '[' })],
  ['non-array includes', root => ({ PIE_TEST_COVERAGE_CWD: root, PIE_TEST_COVERAGE_INCLUDES: '{}' })],
  ['non-string glob', root => ({ PIE_TEST_COVERAGE_CWD: root, PIE_TEST_COVERAGE_INCLUDES: '[null]' })],
]) {
  test(`fails closed on owner capture configuration: ${name}`, t => {
    const f = fixture(t);
    const entry = path.join(f.root, 'entry.cjs');
    writeFileSync(entry, 'globalThis.ran = true;');
    const result = f.run([entry], { env: { ...f.env, ...configuration(f.root) } });
    assert.equal(result.status, 125, result.stderr);
    assert.equal(result.stdout, '');
    const errors = readdirSync(f.directory).filter(name => name.startsWith('recorder-error-'));
    assert.equal(errors.length, 1);
    const record = JSON.parse(readFileSync(path.join(f.directory, errors[0]), 'utf8'));
    assert.ok(record.errors.some(error => error.stage === 'initialize'));
    assert.ok(f.records().every(record => record.scripts.length === 0));
  });
}

test('fails closed on an unparseable inline map only for an already eligible URL', t => {
  const f = fixture(t);
  const url = pathToFileURL(path.join(f.root, 'mapped.js')).href;
  const entry = path.join(f.root, 'invalid-map.cjs');
  writeFileSync(entry, `require('node:vm').runInThisContext(${JSON.stringify(`1;\n//# sourceMappingURL=data:application/json;base64,bm90LWpzb24=\n//# sourceURL=${url}`)});`);
  const result = f.run([entry]);
  assert.equal(result.status, 125, result.stderr);
  assert.equal(result.stdout, '');
  const errors = readdirSync(f.directory).filter(name => name.startsWith('recorder-error-'));
  assert.equal(errors.length, 1);
  const record = JSON.parse(readFileSync(path.join(f.directory, errors[0]), 'utf8'));
  assert.ok(record.errors.some(error => error.stage === 'sourceMapURL' && error.url === url));
  assert.ok(!f.records().some(record => record.scripts.some(script => script.url === url)));
});

for (const role of ['runtime', 'test child', 'isolation=none']) {
  test(`fails closed on inspector initialization failure in ${role}`, t => {
    const f = fixture(t);
    const mock = path.join(f.temporary, 'inspector-connect-failure.cjs');
    writeFileSync(mock, `require('node:inspector').Session.prototype.connect = function() { throw new Error('inspector unavailable'); };`);
    const entry = path.join(f.root, 'entry.test.cjs');
    writeFileSync(entry, `require('node:test').test('runs', () => {});`);
    const result = f.run([
      ...(role === 'runtime' ? [] : ['--test']),
      ...(role === 'isolation=none' ? ['--experimental-test-isolation=none'] : []),
      entry,
    ], {
      env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(mock)} ${f.env.NODE_OPTIONS}${role === 'test child' ? ' --inspect-port=0' : ''}` },
    });
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    const errors = readdirSync(f.directory).filter(name => name.startsWith('recorder-error-'));
    assert.equal(errors.length, 1);
    const record = JSON.parse(readFileSync(path.join(f.directory, errors[0]), 'utf8'));
    assert.ok(record.errors.some(error => error.stage === 'initialize' && error.message === 'inspector unavailable'));
    assert.equal(record.pid === result.pid, role !== 'test child');
  });
}

test('fails closed with a structured recorder error if included source cannot be retrieved', t => {
  const f = fixture(t);
  const mock = path.join(f.temporary, 'inspector-failure.cjs');
  writeFileSync(mock, `
    const { Session } = require('node:inspector');
    const original = Session.prototype.post;
    Session.prototype.post = function(method, params, callback) {
      if (method === 'Debugger.getScriptSource') return callback(new Error('source retrieval failed'));
      return original.apply(this, arguments);
    };
  `);
  const entry = path.join(f.root, 'entry.cjs');
  writeFileSync(entry, 'process.exit(0);');
  const result = f.run(['--require', mock, '--require', preload, entry], {
    env: { ...f.env, NODE_OPTIONS: '' },
  });
  assert.equal(result.status, 125, result.stderr);
  assert.equal(result.stdout, '');
  const errors = readdirSync(f.directory).filter(name => name.startsWith('recorder-error-'));
  assert.equal(errors.length, 1);
  const record = JSON.parse(readFileSync(path.join(f.directory, errors[0]), 'utf8'));
  assert.equal(record.schema, 1);
  assert.ok(record.errors.some(error => error.stage === 'getScriptSource' && sameFile(error.url, entry)), JSON.stringify(record));
});
