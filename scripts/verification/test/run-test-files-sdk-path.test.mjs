import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildTsxArgs,
  createGroupTsconfigOverlay,
  inferRepoRoot,
  parseArgs,
  resolveLocalTsx,
  runGroup,
} from '../run-test-files.mjs';

const repoRoot = inferRepoRoot();
const runnerPath = path.join(repoRoot, 'scripts', 'verification', 'run-test-files.mjs');
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

test('parseArgs accepts both SDK path forms and leaves options after -- as file names', () => {
  assert.deepEqual(parseArgs(['a.test.ts', '--sdk-path', 'candidate/sdk', 'b.test.ts']), {
    files: ['a.test.ts', 'b.test.ts'],
    help: false,
    filesFromStdin: false,
    sdkPath: 'candidate/sdk',
  });
  assert.deepEqual(parseArgs(['--sdk-path=candidate/sdk', 'a.test.ts']), {
    files: ['a.test.ts'],
    help: false,
    filesFromStdin: false,
    sdkPath: 'candidate/sdk',
  });
  assert.deepEqual(parseArgs(['--sdk-path', 'candidate/sdk', '--', '--sdk-path', 'literal.test.ts']), {
    files: ['--sdk-path', 'literal.test.ts'],
    help: false,
    filesFromStdin: false,
    sdkPath: 'candidate/sdk',
  });
  assert.deepEqual(parseArgs(['--', '--sdk-path=candidate/sdk']), {
    files: ['--sdk-path=candidate/sdk'],
    help: false,
    filesFromStdin: false,
  });
  assert.throws(() => parseArgs(['--sdk-path']), /--sdk-path requires a candidate/);
  assert.throws(() => parseArgs(['--sdk-path', '--', 'a.test.ts']), /--sdk-path requires a candidate/);
  assert.throws(() => parseArgs(['--sdk-path=']), /--sdk-path requires a candidate/);
});

test('candidate overlay for an unconfigured group uses root SDK config and binds all Pi/TypeBox aliases', async (t) => {
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

  const group = { id: 'detached-sdk-candidate', cwd: fixtureRoot, tsxBin: resolveLocalTsx(repoRoot) };
  // node:test sets this marker for its own subprocesses; do not propagate it
  // into the detached runner or Node will intentionally skip its test files.
  const nodeTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let code;
  try {
    code = await runGroup(group, buildTsxArgs({ tsxConfig: overlay.configPath, files: [fixtureTest] }));
  } finally {
    if (nodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = nodeTestContext;
  }
  assert.equal(code, 0, 'detached fixture must execute imports through the candidate aliases');
});

test('CLI resolves relative SDK paths from repoRoot and rejects invalid candidates before test discovery', (t) => {
  const fixtureRoot = makeFixture(t);
  const sdkPath = makeCandidateSdk(fixtureRoot);
  const missing = spawnSync(process.execPath, [runnerPath, '--sdk-path'], {
    cwd: fixtureRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(missing.error, undefined, missing.error?.message);
  assert.equal(missing.status, 1);
  assert.match(`${missing.stdout}\n${missing.stderr}`, /--sdk-path requires a candidate coding-agent package directory/);

  const invalidCandidate = path.join(fixtureRoot, 'not-an-sdk');
  const invalid = spawnSync(process.execPath, [

    runnerPath,
    '--sdk-path',
    invalidCandidate,
    'scripts/verification/test/does-not-exist.test.mjs',
  ], { cwd: fixtureRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(invalid.error, undefined, invalid.error?.message);
  assert.equal(invalid.status, 1);
  const invalidOutput = `${invalid.stdout}\n${invalid.stderr}`;
  assert.match(invalidOutput, /Invalid --sdk-path candidate/);
  assert.match(invalidOutput, /Expected @earendil-works\/pi-coding-agent package manifest/);
  assert.doesNotMatch(invalidOutput, /Test file not found/);

  const relativeCandidate = path.relative(repoRoot, sdkPath);
  const valid = spawnSync(process.execPath, [
    runnerPath,
    `--sdk-path=${relativeCandidate}`,
    'scripts/verification/test/does-not-exist.test.mjs',
  ], { cwd: fixtureRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(valid.error, undefined, valid.error?.message);
  assert.equal(valid.status, 1);
  const validOutput = `${valid.stdout}\n${valid.stderr}`;
  assert.doesNotMatch(validOutput, /Invalid --sdk-path candidate/);
  assert.match(validOutput, /Test file not found: scripts\/verification\/test\/does-not-exist\.test\.mjs/);
});
