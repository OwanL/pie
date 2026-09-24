import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installedModules = path.join(repositoryRoot, 'application', 'hosts', 'vscode', 'node_modules');

function write(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// Execute the real build entry in a detached source fixture: the old extension
// package has no node_modules, while the new owner provides the compiler and a
// fixture-only declaration. Vite is a tiny output stub to keep this test focused
// on build's preflight rather than its bundling/publication pipeline.
test('build preflight resolves moved extension source through the owner overlay', (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'pie-build-typecheck-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const owner = path.join(fixture, 'application', 'hosts', 'vscode');
  const modules = path.join(owner, 'node_modules');
  for (const file of ['build.mjs', 'publication.mjs', 'runtime-publication.mjs']) {
    write(fixture, `scripts/build/${file}`, readFileSync(path.join(repositoryRoot, 'scripts', 'build', file)));
  }
  write(fixture, 'scripts/lib/package-resolution.mjs', readFileSync(path.join(repositoryRoot, 'scripts/lib/package-resolution.mjs')));
  write(fixture, 'application/hosts/vscode/runtime/runtime-generations.cjs', readFileSync(path.join(repositoryRoot, 'application/hosts/vscode/runtime/runtime-generations.cjs')));
  write(fixture, 'package.json', '{"type":"module"}\n');
  write(fixture, 'extension/src/entry.ts', "import { owned } from 'owner-only';\nexport const result: string = owned();\n");
  write(fixture, 'application/hosts/vscode/tsconfig.json', JSON.stringify({
    compilerOptions: {
      noEmit: true, strict: true, module: 'preserve', moduleResolution: 'bundler',
      target: 'ES2021', types: ['node'],
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
    const out = path.resolve(process.cwd(), 'out');
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
  assert.equal(existsSync(path.join(fixture, 'extension', 'node_modules')), false);
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'build', 'build.mjs'), '--no-sync'], {
    cwd: owner, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Running TypeScript check/);
  assert.match(result.stdout, /Coordinated host\/webview identity/);

  // The build must still enforce the owner's declaration, not skip checking.
  write(fixture, 'extension/src/entry.ts', "import { owned } from 'owner-only';\nexport const result: number = owned();\n");
  const invalid = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'build', 'build.mjs'), '--no-sync'], {
    cwd: owner, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(invalid.status, 1, `${invalid.stdout}\n${invalid.stderr}`);
  assert.match(invalid.stdout, /Type 'string' is not assignable to type 'number'/);
});
