import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const applicationOwner = path.join(repositoryRoot, 'application', 'hosts', 'vscode');

function linkDirectory(source, destination) {
  symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

function copySourceOwner(source, destination) {
  // Preserve the owner's package/TypeScript authority in the moved root. Copy
  // only direct source files; a source-directory junction would realpath
  // relative imports back into this checkout instead of exercising the fixture.
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name !== 'package.json' && entry.name !== 'tsconfig.json' && !/\.(?:mjs|mts|ts)$/u.test(entry.name)) continue;
    copyFileSync(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

export function makeFutureRoot(t) {
  const root = path.join(os.tmpdir(), `pie-unbundled-future-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const futureApplicationOwner = path.join(root, 'application', 'hosts', 'vscode');
  mkdirSync(futureApplicationOwner, { recursive: true });
  copyFileSync(path.join(applicationOwner, 'package.json'), path.join(futureApplicationOwner, 'package.json'));
  linkDirectory(path.join(applicationOwner, 'node_modules'), path.join(futureApplicationOwner, 'node_modules'));

  const futureScripts = path.join(root, 'scripts', 'lib');
  mkdirSync(futureScripts, { recursive: true });
  for (const name of ['package-resolution.mjs', 'native-owner.mjs']) {
    copyFileSync(path.join(repositoryRoot, 'scripts', 'lib', name), path.join(futureScripts, name));
  }

  // Playwright's runtime client imports the shared redaction owner. Preserve
  // that transitive source in the moved fixture rather than reaching checkout.
  copySourceOwner(path.join(repositoryRoot, 'lib', 'sensitive-data'), path.join(root, 'lib', 'sensitive-data'));
  mkdirSync(path.join(root, 'harness', 'tools'), { recursive: true });
  const lifecycleSource = path.join(repositoryRoot, 'harness', 'agent-processes', 'lib', 'process-lifecycle');
  copySourceOwner(lifecycleSource, path.join(root, 'harness', 'agent-processes', 'lib', 'process-lifecycle'));
  mkdirSync(path.join(root, 'extensions'), { recursive: true });
  for (const id of ['computer-use', 'playwright']) {
    const extensionRoot = path.join(root, 'extensions', id);
    mkdirSync(extensionRoot, { recursive: true });
    copyFileSync(path.join(repositoryRoot, 'extensions', id, 'index.ts'), path.join(extensionRoot, 'index.ts'));
    copyFileSync(path.join(repositoryRoot, 'extensions', id, 'package.json'), path.join(extensionRoot, 'package.json'));
    linkDirectory(path.join(repositoryRoot, 'extensions', id, 'node_modules'), path.join(extensionRoot, 'node_modules'));

    const toolRoot = path.join(root, 'harness', 'tools', id);
    copySourceOwner(path.join(repositoryRoot, 'harness', 'tools', id), toolRoot);
  }
  mkdirSync(path.join(root, 'extensions', 'sdk-alias-proof'), { recursive: true });
  assert.equal(existsSync(path.join(root, 'node_modules')), false);
  return root;
}
