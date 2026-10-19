import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGroupTsconfigOverlay,
  inferRepoRoot,
} from '../run-test-files.mjs';

import { parseArgs, runNodeTestsWithOverlay } from '../test-node.mjs';

const repoRoot = inferRepoRoot();
const runnerPath = path.join(repoRoot, 'scripts', 'verification', 'test-node.mjs');
const currentPackages = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
];
const legacyPackages = [
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-tui',
];

function makeFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-run-test-files-sdk-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeCandidatePackage(packageRoot, name) {
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name,
    type: 'module',
    exports: {
      '.': {
        types: './index.d.ts',
        import: './index.mjs',
        require: './index.cjs',
      },
    },
  }, null, 2));
  writeFileSync(path.join(packageRoot, 'index.mjs'), `export const candidate = ${JSON.stringify(name)};\n`);
  writeFileSync(path.join(packageRoot, 'index.cjs'), `exports.candidate = ${JSON.stringify(name)};\n`);
  writeFileSync(path.join(packageRoot, 'index.d.ts'), 'export declare const candidate: string;\n');
}

function makeCandidateSdk(root) {
  const sdkRoot = path.join(root, 'candidate-workspace', 'packages', 'coding-agent');
  writeCandidatePackage(sdkRoot, currentPackages[0]);
  for (const name of [...currentPackages.slice(1), 'typebox']) {
    writeCandidatePackage(path.join(sdkRoot, 'node_modules', ...name.split('/')), name);
  }
  return sdkRoot;
}

test('current SDK selector parser accepts both forms before selectors', () => {
  const expected = {
    selectors: ['a.test.ts'], nodeFlags: [], includeGlobs: [], excludeGlobs: [], sdkPath: 'candidate/sdk',
  };
  assert.deepEqual(parseArgs(['--sdk-path', 'candidate/sdk', 'a.test.ts']), expected);
  assert.deepEqual(parseArgs(['--sdk-path=candidate/sdk', 'a.test.ts']), expected);
  assert.throws(() => parseArgs(['a.test.ts', '--sdk-path=candidate/sdk']), /before test selectors/);
  for (const args of [['--sdk-path'], ['--sdk-path', '--'], ['--sdk-path=']]) {
    assert.throws(() => parseArgs(args), /--sdk-path requires a path/);
  }
});

test('current runner loads all Pi/TypeBox aliases from the explicit SDK candidate', async (t) => {
  const fixtureRoot = makeFixture(t);
  const sdkPath = makeCandidateSdk(fixtureRoot);
  const overlay = createGroupTsconfigOverlay(repoRoot, { id: 'fixture' }, { sdkPath });
  assert.ok(overlay);
  t.after(() => overlay.dispose());

  const config = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
  assert.equal(config.extends, path.join(repoRoot, 'application', 'hosts', 'vscode', 'tsconfig.json'));
  const paths = config.compilerOptions.paths;
  for (const name of [...currentPackages, ...legacyPackages, 'typebox', '@sinclair/typebox']) {
    assert.ok(paths[name]?.[0], `missing candidate alias ${name}`);
    assert.ok(paths[name][0].startsWith(sdkPath), `${name} did not resolve under the candidate: ${paths[name][0]}`);
  }

  const imports = [...currentPackages, ...legacyPackages, 'typebox', '@sinclair/typebox'];
  const bindings = imports.map((name, index) => `import { candidate as candidate${index} } from ${JSON.stringify(name)};`).join('\n');
  const expected = imports.map((name) => currentPackages.includes(name) ? name :
    legacyPackages.includes(name) ? currentPackages[legacyPackages.indexOf(name)] : 'typebox');
  const fixtureTest = path.join(fixtureRoot, 'candidate-aliases.test.ts');
  writeFileSync(fixtureTest, [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    bindings,
    `test('all SDK aliases load from the explicit candidate', () => assert.deepEqual([${imports.map((_, index) => `candidate${index}`).join(', ')}], ${JSON.stringify(expected)}));`,
  ].join('\n'));

  // Exercise public native SDK alias loading, not the retired grouped CLI.
  // node:test sets this marker for its own subprocesses; do not propagate it
  // into the detached runner or Node will intentionally skip its test files.
  const nodeTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let code;
  try {
    code = (await runNodeTestsWithOverlay([fixtureTest], { repoRoot, cwd: repoRoot, sdkPath })).code;
  } finally {
    if (nodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = nodeTestContext;
  }
  assert.equal(code, 0, 'detached fixture must execute imports through the candidate aliases');
});

test('current CLI validates explicit SDK selectors even for SDK-independent tests', (t) => {
  const fixtureRoot = makeFixture(t);
  const selector = 'scripts/verification/test/test-packages.test.mjs';
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [runnerPath, ...args], {
      cwd: fixtureRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1);
    return result.stdout + '\n' + result.stderr;
  };
  assert.match(invoke('--sdk-path'), /--sdk-path requires a path/);
  assert.match(invoke('--sdk-path='), /--sdk-path requires a path/);
  assert.match(invoke(selector, '--sdk-path', fixtureRoot), /must be supplied before test selectors/);
  assert.match(invoke('--sdk-path', path.join(fixtureRoot, 'not-an-sdk'), selector), /SDK|package|ENOENT/i);
  // Runtime acquisition is intentionally not part of the native focused CLI.
  assert.match(invoke('--pi-runtime', fixtureRoot, selector), /Unknown option --pi-runtime/);
});
