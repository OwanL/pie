import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writePiRuntimeManifest } from '../../lib/pi-runtime-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const installedModules = path.join(repositoryRoot, 'application', 'hosts', 'vscode', 'node_modules');

function write(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const runtimePackages = [
  '@earendil-works/pi-tui', '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent',
];
const sdkAssets = [
  'dist/cli.js', 'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json', 'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json', 'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html', 'dist/core/export-html/template.css', 'dist/core/export-html/template.js',
  'dist/core/export-html/vendor/marked.min.js', 'dist/core/export-html/vendor/highlight.min.js',
];

async function makeRuntimeArtifact(root) {
  for (const name of runtimePackages) {
    const sdk = name === '@earendil-works/pi-coding-agent';
    write(root, `node_modules/${name}/package.json`, JSON.stringify({
      name, version: '0.80.6', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.js' } },
    }) + '\n');
    write(root, `node_modules/${name}/LICENSE`, 'MIT License\n');
    write(root, `node_modules/${name}/dist/index.js`, sdk ? "export function candidateOnly() { return 'candidate-sdk'; }\n" : 'export {}\n');
    write(root, `node_modules/${name}/dist/index.d.ts`, sdk ? "export declare function candidateOnly(): 'candidate-sdk';\n" : 'export {};\n');
    if (sdk) for (const asset of sdkAssets) write(root, `node_modules/${name}/${asset}`, `fixture asset: ${asset}\n`);
  }
  write(root, 'node_modules/typebox/package.json', JSON.stringify({
    name: 'typebox', version: '1.0.0', type: 'module', main: './index.js', types: './index.d.ts',
    exports: { '.': { types: './index.d.ts', import: './index.js', require: './index.js' } },
  }) + '\n');
  write(root, 'node_modules/typebox/index.js', 'export {};\n');
  write(root, 'node_modules/typebox/index.d.ts', 'export {};\n');
  return writePiRuntimeManifest(root, {
    upstreamVersion: '0.80.6', upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
    sourceTreeSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64),
    target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
  });
}

function installFakeAcquisition(root, sourceArtifact, counter) {
  write(root, 'scripts/build/pi-runtime.mjs', `
    import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';
    const source = ${JSON.stringify(sourceArtifact)};
    const counterFile = ${JSON.stringify(counter)};
    export async function buildPiRuntime({ output }) {
      await mkdir(output, { recursive: true });
      let count = 0;
      try { count = Number(await readFile(counterFile, 'utf8')); } catch {}
      await writeFile(counterFile, String(count + 1));
      const artifactDir = path.join(output, 'pi-runtime');
      await cp(source, artifactDir, { recursive: true });
      return verifyPiRuntimeArtifact(artifactDir);
    }
  `);
}

// Execute the real build entry in a detached source fixture: the old extension
// package has no node_modules, while the new owner provides the compiler and a
// fixture-only declaration. Vite is a tiny output stub to keep this test focused
// on build's preflight rather than its bundling/publication pipeline.
test('build preflight resolves moved extension source through the owner overlay and source-default SDK', async (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'pie-build-typecheck-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const privateBuilds = mkdtempSync(path.join(os.tmpdir(), 'pie-build-typecheck-output-'));
  t.after(() => rmSync(privateBuilds, { recursive: true, force: true }));
  const owner = path.join(fixture, 'application', 'hosts', 'vscode');
  const modules = path.join(owner, 'node_modules');
  for (const file of ['build.mjs', 'publication.mjs', 'runtime-publication.mjs']) {
    write(fixture, `scripts/build/${file}`, readFileSync(path.join(repositoryRoot, 'scripts', 'build', file)));
  }
  for (const file of ['package-resolution.mjs', 'pi-runtime-artifact.mjs', 'pi-runtime-context.mjs']) {
    write(fixture, `scripts/lib/${file}`, readFileSync(path.join(repositoryRoot, 'scripts/lib', file)));
  }
  write(fixture, 'lib/pi-runtime/artifact.mjs', readFileSync(path.join(repositoryRoot, 'lib/pi-runtime/artifact.mjs')));
  write(fixture, 'application/hosts/vscode/runtime/runtime-generations.cjs', readFileSync(path.join(repositoryRoot, 'application/hosts/vscode/runtime/runtime-generations.cjs')));
  write(fixture, 'package.json', '{"type":"module"}\n');
  write(fixture, 'extension/src/entry.ts', "import { owned } from 'owner-only';\nimport { candidateOnly } from '@earendil-works/pi-coding-agent';\nexport const result: string = owned() + candidateOnly();\n");
  write(fixture, 'application/hosts/vscode/tsconfig.json', JSON.stringify({
    compilerOptions: {
      noEmit: true, strict: true, module: 'preserve', moduleResolution: 'bundler',
      target: 'ES2021', types: ['node'], incremental: true,
      tsBuildInfoFile: './node_modules/.cache/typecheck/shared.tsbuildinfo',
    },
    include: ['../../../extension/src/**/*.ts'],
  }));
  write(fixture, 'application/hosts/vscode/package.json', JSON.stringify({
    name: 'pie-fixture', dependencies: { 'owner-only': '1.0.0' },
  }));
  for (const name of ['typescript', 'preact', '@earendil-works/pi-coding-agent', '@types/node']) {
    const target = path.join(installedModules, ...name.split('/'));
    assert.ok(existsSync(target), `fixture prerequisite: ${name}`);
    const link = path.join(modules, ...name.split('/'));
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, 'junction');
  }
  write(fixture, 'application/hosts/vscode/node_modules/owner-only/package.json', '{"name":"owner-only","version":"1.0.0","types":"index.d.ts"}\n');
  write(fixture, 'application/hosts/vscode/node_modules/owner-only/index.d.ts', 'export declare function owned(): string;\n');
  write(fixture, 'application/hosts/vscode/node_modules/vite/package.json', '{"name":"vite","version":"0.0.0-fixture"}\n');
  write(fixture, 'application/hosts/vscode/node_modules/vite/bin/vite.js', `
    const fs = require('node:fs');
    const path = require('node:path');
    const out = process.env.PIE_BUILD_OUTPUT_DIR || path.resolve(process.cwd(), 'out');
    const id = '0123456789abcdefabcd';
    fs.mkdirSync(out, { recursive: true });
    if (process.argv.includes('node')) {
      for (const name of ['extension.js', 'backend.js', 'worker-entry.js', 'analytics-recorder-worker.js', 'analytics-query-worker.js']) {
        fs.writeFileSync(path.join(out, name), '');
      }
      fs.writeFileSync(path.join(out, 'pie-build-id.txt'), id);
    } else {
      const webview = path.join(out, 'webview', 'panel');
      fs.mkdirSync(path.join(webview, '.vite'), { recursive: true });
      fs.writeFileSync(path.join(webview, '.vite', 'manifest.json'), '{}');
      fs.writeFileSync(path.join(webview, 'pie-build-id.txt'), id);
    }
  `);
  const sourceArtifact = path.join(fixture, 'source-pi-runtime');
  const runtime = await makeRuntimeArtifact(sourceArtifact);
  const acquisitionCount = path.join(fixture, 'acquisition-count.txt');
  installFakeAcquisition(fixture, sourceArtifact, acquisitionCount);
  assert.equal(existsSync(path.join(fixture, 'extension', 'node_modules')), false);
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'build', 'build.mjs'), '--no-sync'], {
    cwd: owner, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Running TypeScript check/);
  assert.match(result.stdout, /Coordinated host\/webview identity/);
  assert.equal(readFileSync(acquisitionCount, 'utf8'), '1', 'typecheck and both bundles share one source-default acquisition');
  assert.equal(runtime.identity.length, 64);

  // Real compiler writes, including its inherited incremental build-info path,
  // must follow the isolated boundary rather than the dependency owner.
  write(owner, 'out/preserved.txt', 'shared output');
  write(owner, 'node_modules/.cache/typecheck/shared.tsbuildinfo', 'shared incremental state');
  const isolatedOutput = path.join(privateBuilds, 'valid output');
  const isolated = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'build', 'build.mjs'), '--output-dir', isolatedOutput], {
    cwd: owner, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(isolated.status, 0, `${isolated.stdout}\n${isolated.stderr}`);
  assert.equal(readFileSync(acquisitionCount, 'utf8'), '2', 'a separate isolated build gets one additional source-default acquisition');
  assert.ok(existsSync(path.join(isolatedOutput, '.cache', 'typecheck', 'extension.tsbuildinfo')));
  assert.ok(existsSync(path.join(isolatedOutput, '.cache', 'typecheck', 'tsconfig.overlay.json')));
  assert.equal(readFileSync(path.join(owner, 'out', 'preserved.txt'), 'utf8'), 'shared output');
  assert.equal(readFileSync(path.join(modules, '.cache', 'typecheck', 'shared.tsbuildinfo'), 'utf8'), 'shared incremental state');

  // The build must still enforce the owner's declaration, not skip checking.
  write(fixture, 'extension/src/entry.ts', "import { owned } from 'owner-only';\nimport { candidateOnly } from '@earendil-works/pi-coding-agent';\nexport const result: number = owned() + candidateOnly();\n");
  const invalidOutput = path.join(privateBuilds, 'invalid output');
  const invalid = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'build', 'build.mjs'), '--output-dir', invalidOutput], {
    cwd: owner, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(invalid.status, 1, `${invalid.stdout}\n${invalid.stderr}`);
  assert.match(invalid.stdout, /Type 'string' is not assignable to type 'number'/);
  assert.equal(existsSync(path.join(invalidOutput, 'extension.js')), false);
  assert.equal(readFileSync(path.join(owner, 'out', 'preserved.txt'), 'utf8'), 'shared output');
  assert.equal(readFileSync(path.join(modules, '.cache', 'typecheck', 'shared.tsbuildinfo'), 'utf8'), 'shared incremental state');
});
