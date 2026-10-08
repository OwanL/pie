import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { packPiRuntime } from '../pi-runtime-packaging.mjs';
import { PI_RUNTIME_PACKAGES, writePiRuntimeManifest, verifyPiRuntimeArtifact, verifyPiRuntimeToolingArtifact } from '../../lib/pi-runtime-artifact.mjs';
const provenance = { upstreamVersion: '0.80.6', upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b', sourceTreeSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64), target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } };
const assets = ['dist/cli.js', 'dist/rpc-entry.js', 'dist/modes/interactive/theme/dark.json', 'dist/modes/interactive/theme/light.json', 'dist/modes/interactive/theme/theme-schema.json', 'dist/modes/interactive/assets/clankolas.png', 'dist/core/export-html/template.html', 'dist/core/export-html/template.css', 'dist/core/export-html/template.js', 'dist/core/export-html/vendor/marked.min.js', 'dist/core/export-html/vendor/highlight.min.js'];
const ai = 'node_modules/@earendil-works/pi-ai';
const mistral = 'node_modules/@mistralai/mistralai';
const map = JSON.stringify({ version: 3, sources: ['../src/source.ts'], names: [], mappings: 'AAAA', sourcesContent: ['export const n = 1;'] });
const prefix = 'export const n = 1;\n';
const source = `${prefix}//# sourceMappingURL=index.js.map\n`;
async function put(root, name, content) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
async function files(root, rel = '') {
  const result = [];
  for (const name of (await readdir(path.join(root, rel))).sort()) {
    const file = path.join(rel, name), stat = await lstat(path.join(root, file));
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) result.push(...await files(root, file));
    else { assert.equal(stat.nlink, 1); result.push(file); }
  }
  return result.sort();
}
async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-role-pack-test-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const runtimeDir = path.join(parent, 'pi-runtime'), toolingDir = path.join(parent, 'pi-tooling');
  for (const name of PI_RUNTIME_PACKAGES) {
    const root = `node_modules/${name}`;
    await put(runtimeDir, `${root}/package.json`, JSON.stringify({ name, version: '0.80.6', type: 'module', exports: './dist/index.js' }));
    await put(runtimeDir, `${root}/dist/index.js`, source);
    await put(runtimeDir, `${root}/dist/index.js.map`, map);
    for (const suffix of ['ts', 'mts', 'cts']) for (const extra of ['', '.map']) await put(runtimeDir, `${root}/dist/index.d.${suffix}${extra}`, 'declaration fixture');
    await put(runtimeDir, `${root}/LICENSE`, 'MIT');
    await put(runtimeDir, `${root}/README.md`, 'readme');
    await put(runtimeDir, `${root}/docs/sdk.md`, 'docs');
    await put(runtimeDir, `${root}/examples/raw.ts`, 'export const example = true;');
    await put(runtimeDir, `${root}/src/raw.ts`, 'raw source');
  }
  for (const asset of assets) await put(runtimeDir, `node_modules/@earendil-works/pi-coding-agent/${asset}`, asset.endsWith('.js') ? 'export const asset = 1;' : 'asset fixture');
  await put(runtimeDir, 'node_modules/@earendil-works/pi-tui/native/fixture.node', Buffer.from([0, 1, 255]));
  await put(runtimeDir, `${ai}/dist/provider.js`, 'import { Mistral } from "@mistralai/mistralai"; export const client = Mistral;');
  await put(runtimeDir, `${mistral}/package.json`, JSON.stringify({ name: '@mistralai/mistralai', version: '2.2.6', license: 'Apache-2.0', type: 'module', exports: { '.': { default: './esm/index.js' }, './deep': './esm/deep.js' } }));
  await put(runtimeDir, `${mistral}/esm/index.js`, 'export * from "./client.js"; export * as files from "./files.js"; export const HTTPClient = class {}; export const SDK_METADATA = {}; export const ServerEu = "eu"; export const ServerList = []; export const serverURLFromOptions = () => "fixture";');
  await put(runtimeDir, `${mistral}/esm/client.js`, 'import { z } from "zod"; export class Mistral { constructor() { this.chat = { stream() { return z; } }; } }');
  await put(runtimeDir, `${mistral}/esm/files.js`, 'export const fixture = true;');
  await put(runtimeDir, `${mistral}/esm/deep.js`, 'export const fullToolingOnly = true;');
  await put(runtimeDir, `${mistral}/LICENSE`, 'Apache');
  await put(runtimeDir, `${mistral}/docs/readme.md`, 'original documentation');
  await put(runtimeDir, 'node_modules/zod/package.json', '{"name":"zod","version":"1.0.0","main":"index.js"}');
  await put(runtimeDir, 'node_modules/zod/index.js', 'exports.z = "tiny fixture";');
  const original = await writePiRuntimeManifest(runtimeDir, provenance);
  return { runtimeDir, toolingDir, provenance, original };
}

test('conservative runtime and exact independent full tooling pass canonical APIs', async t => {
  const input = await fixture(t), originalRows = await files(input.runtimeDir);
  const result = await packPiRuntime(input);
  assert.equal(result.tooling.identity, input.original.identity);
  assert.deepEqual(await files(input.toolingDir), originalRows);
  assert.deepEqual(await verifyPiRuntimeArtifact(input.runtimeDir), result.runtime);
  assert.deepEqual(await verifyPiRuntimeToolingArtifact(input.runtimeDir), result.tooling);
  assert.deepEqual(JSON.parse(await readFile(path.join(input.runtimeDir, 'tooling-reference.json'))), { schemaVersion: 1, artifactDirectory: '../pi-tooling', identity: input.original.identity });
  for (const rel of originalRows) {
    if (rel === 'manifest.json' || rel.startsWith(path.join('node_modules', '@mistralai/mistralai') + path.sep) || /\.d\.(ts|mts|cts)(\.map)?$/.test(rel) || /\.js\.map$/.test(rel)) continue;
    const runtime = await readFile(path.join(input.runtimeDir, rel)), tooling = await readFile(path.join(input.toolingDir, rel));
    if (rel.endsWith(path.join('dist', 'index.js'))) {
      assert.equal(runtime.toString().slice(0, prefix.length), prefix);
      assert.equal(tooling.toString(), source);
      assert.equal(Buffer.from(runtime.toString().match(/base64,(\S+)/)[1], 'base64').toString(), map);
    } else assert.deepEqual(runtime, tooling, rel);
  }
  assert.equal(result.evidence.counts.declarationsRemoved, 24);
  assert.equal(result.evidence.counts.mapsInlined, 4);
  const require = createRequire(path.join(input.runtimeDir, 'owner.cjs')), cjs = require('@mistralai/mistralai');
  const esm = await import(pathToFileURL(require.resolve('@mistralai/mistralai')).href);
  assert.deepEqual(Object.keys(cjs).sort(), ['HTTPClient', 'Mistral', 'SDK_METADATA', 'ServerEu', 'ServerList', 'files', 'serverURLFromOptions']);
  assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
  for (const name of Object.keys(cjs)) assert.equal(esm[name], cjs[name]);
  assert.equal(new esm.Mistral().chat.stream(), 'tiny fixture');
  assert.equal((await import(pathToFileURL(path.join(input.toolingDir, mistral, 'esm/deep.js')).href)).fullToolingOnly, true);
  await put(input.toolingDir, `${ai}/dist/index.js`, 'tampered');
  await assert.rejects(verifyPiRuntimeToolingArtifact(input.runtimeDir), /hash mismatch/);
  await verifyPiRuntimeArtifact(input.runtimeDir);
  await put(input.runtimeDir, 'tooling-reference.json', '{"schemaVersion":1}');
  await assert.rejects(verifyPiRuntimeArtifact(input.runtimeDir), /tooling reference/);
});

test('real AST terminal comments only; orphan/indexed/external/unsupported maps stay unchanged', async t => {
  const input = await fixture(t);
  const cases = {
    'string.js': ['export const s = "//# sourceMappingURL=string.js.map";\n', map],
    'template.js': ['export const s = `//# sourceMappingURL=template.js.map`;\n', map],
    'regex.js': ['export const s = /sourceMappingURL=regex.js.map/;\n', map],
    'indexed.js': ['export {};\n//# sourceMappingURL=indexed.js.map', JSON.stringify({ version: 3, sections: [] })],
    'external.js': ['export {};\n//# sourceMappingURL=external.js.map', JSON.stringify({ version: 3, sourceRoot: 'https://example.invalid/', sources: [], mappings: '' })],
    'nonterminal.js': ['//# sourceMappingURL=nonterminal.js.map\nexport {};', map],
    'absolute.js': ['export {};\n//# sourceMappingURL=absolute.js.map', JSON.stringify({ version: 3, sources: ['https://example.invalid/a.ts'], mappings: '' })],
  };
  for (const [name, [js, raw]] of Object.entries(cases)) { await put(input.runtimeDir, `${ai}/dist/${name}`, js); await put(input.runtimeDir, `${ai}/dist/${name}.map`, raw); }
  await put(input.runtimeDir, `${ai}/dist/orphan.js.map`, map);
  await writePiRuntimeManifest(input.runtimeDir, provenance);
  const result = await packPiRuntime(input);
  for (const [name, [js, raw]] of Object.entries(cases)) {
    assert.equal(await readFile(path.join(input.runtimeDir, ai, 'dist', name), 'utf8'), js);
    assert.equal(await readFile(path.join(input.runtimeDir, ai, 'dist', name + '.map'), 'utf8'), raw);
  }
  assert.equal(result.evidence.counts.mapsRetained, 8);
});

test('qualification errors never evaluate unsupported graphs and retain original full tooling', async t => {
  for (const [file, text, message] of [
    [`${ai}/dist/provider.js`, 'import { Mistral } from "@mistralai/mistralai/deep";', /static named Mistral/],
    [`${ai}/dist/provider.js`, 'const m = await import("@mistralai/mistralai");', /static named Mistral/],
    [`${mistral}/esm/client.js`, 'throw Error("must not evaluate"); export class Mistral {} ; import("./files.js");', /dynamic imports/],
    [`${mistral}/esm/client.js`, 'import fs from "node:fs"; export class Mistral {}', /filesystem/],
    [`${mistral}/package.json`, '{"name":"@mistralai/mistralai","version":"3.0.0"}', /unqualified Mistral/],
  ]) {
    const input = await fixture(t); await put(input.runtimeDir, file, text);
    const original = await writePiRuntimeManifest(input.runtimeDir, provenance);
    await assert.rejects(packPiRuntime(input), message);
    assert.equal((await verifyPiRuntimeArtifact(input.toolingDir)).identity, original.identity);
    assert.equal((await verifyPiRuntimeArtifact(input.runtimeDir)).identity, original.identity);
  }
});

test('qualified Mistral tracing edge stays lazy and resolves inside its shared graph', async t => {
  const input = await fixture(t);
  await put(input.runtimeDir, `${mistral}/esm/client.js`, 'import { trace } from "./hooks/tracing.js"; export class Mistral { trace() { return trace(); } }');
  await put(input.runtimeDir, `${mistral}/esm/hooks/tracing.js`, 'export async function trace() { return (await import("../extra/observability/otel.js")).value; }');
  await put(input.runtimeDir, `${mistral}/esm/extra/observability/otel.js`, 'globalThis.__packingTraceLoads = (globalThis.__packingTraceLoads ?? 0) + 1; export const value = 42;');
  await writePiRuntimeManifest(input.runtimeDir, provenance);
  await packPiRuntime(input);
  const require = createRequire(path.join(input.runtimeDir, 'owner.cjs'));
  const { Mistral } = await import(pathToFileURL(require.resolve('@mistralai/mistralai')).href);
  assert.equal(globalThis.__packingTraceLoads, undefined);
  assert.equal(await new Mistral().trace(), 42);
  assert.equal(await new Mistral().trace(), 42);
  assert.equal(globalThis.__packingTraceLoads, 1);
  delete globalThis.__packingTraceLoads;
});

test('reproducible bytes across independently allocated private output roots', async t => {
  const a = await fixture(t), b = await fixture(t), first = await packPiRuntime(a), second = await packPiRuntime(b);
  assert.equal(first.runtime.identity, second.runtime.identity);
  assert.equal(first.tooling.identity, second.tooling.identity);
  assert.deepEqual(first.evidence, second.evidence);
  for (const rel of await files(a.runtimeDir)) assert.deepEqual(await readFile(path.join(a.runtimeDir, rel)), await readFile(path.join(b.runtimeDir, rel)), rel);
});

test('filesystem effect failure retains independently verified original tooling', async t => {
  const input = await fixture(t);
  const module = new URL('../pi-runtime-packaging.mjs', import.meta.url).href;
  const code = `import { packPiRuntime } from ${JSON.stringify(module)}; try { await packPiRuntime(${JSON.stringify(input)}); } catch (error) { console.error(error.code, error.message); process.exitCode = 1; }`;
  // Permit the independent copy and manifest writes but deny runtime JS mutation.
  await assert.rejects(promisify(execFile)(process.execPath, ['--permission', '--allow-fs-read=*', `--allow-fs-write=${input.toolingDir}`, `--allow-fs-write=${input.toolingDir}/*`, `--allow-fs-write=${path.join(path.dirname(input.original.artifactDir), 'pi-tooling')}`, `--allow-fs-write=${path.join(path.dirname(input.original.artifactDir), 'pi-tooling')}/*`, `--allow-fs-write=${path.join(input.runtimeDir, 'manifest.json')}`, `--allow-fs-write=${path.join(input.original.artifactDir, 'manifest.json')}`, '--allow-child-process', '--input-type=module', '-e', code]), error => error.code === 1 && /ERR_ACCESS_DENIED/.test(error.stderr));
  assert.equal((await verifyPiRuntimeArtifact(input.toolingDir)).identity, input.original.identity);
});

test('input tampering fails before resealing/copying', async t => {
  const input = await fixture(t);
  await put(input.runtimeDir, `${ai}/dist/index.js`, 'tampered source');
  await assert.rejects(packPiRuntime(input), /hash mismatch/);
  await assert.rejects(lstat(input.toolingDir), /ENOENT/);
});

test('ownership/layout checks precede mutation', async t => {
  const input = await fixture(t);
  await assert.rejects(packPiRuntime({ ...input, toolingDir: path.join(path.dirname(input.runtimeDir), 'other') }), /fixed sibling/);
  await mkdir(input.toolingDir);
  await assert.rejects(packPiRuntime(input), /already exists/);
  assert.equal((await verifyPiRuntimeArtifact(input.runtimeDir)).identity, input.original.identity);
});
