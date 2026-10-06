import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import {
  resolveDevelopmentSdkWorkspaceRoot,
  withDevelopmentSdkReader,
} from '../development-sdk-reader.mjs';
import { runNodeTestsWithOverlay } from '../../verification/test-node.mjs';

function makeWorkspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-sdk-reader-'));
  const sdkPath = path.join(root, 'harness', 'pi', 'packages', 'coding-agent');
  mkdirSync(sdkPath, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, sdkPath, workspaceRoot: path.join(root, 'harness', 'pi') };
}

function readerEntries(workspaceRoot) {
  return readdirSync(path.join(workspaceRoot, '.cache', 'development-runtime', 'readers'));
}

function makeCompiledSdk(sdkPath) {
  const packageNames = [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    'typebox',
  ];
  for (const [index, name] of packageNames.entries()) {
    const packageRoot = index === 0 ? sdkPath : path.join(sdkPath, 'node_modules', ...name.split('/'));
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name,
      type: 'module',
      exports: { '.': { types: './index.d.ts', import: './index.mjs' } },
    }));
    writeFileSync(path.join(packageRoot, 'index.mjs'), 'export const fixture = true;\n');
    writeFileSync(path.join(packageRoot, 'index.d.ts'), 'export declare const fixture: boolean;\n');
  }
}

test('only the canonical native coding-agent package selects its Pi workspace reader', (t) => {
  const { root, sdkPath, workspaceRoot } = makeWorkspace(t);
  const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
  assert.equal(resolveDevelopmentSdkWorkspaceRoot(sdkPath, { root }), canonicalWorkspaceRoot);
  assert.equal(resolveDevelopmentSdkWorkspaceRoot(path.relative(root, sdkPath), { root }), canonicalWorkspaceRoot);
  assert.equal(resolveDevelopmentSdkWorkspaceRoot(path.join(root, 'fixture-sdk'), { root }), undefined);

  const materializedSdk = path.join(root, 'artifact', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(materializedSdk, { recursive: true });
  assert.equal(resolveDevelopmentSdkWorkspaceRoot(materializedSdk, { root }), undefined,
    'production/materialized package paths are not native source workspaces');
  assert.equal(resolveDevelopmentSdkWorkspaceRoot(undefined, { root }), undefined,
    'SDK-independent checks never select a Pi reader');
});

test('native SDK reader blocks a writer while the owned child is held and releases after confirmed teardown', async (t) => {
  const { root, sdkPath, workspaceRoot } = makeWorkspace(t);
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  let closeChild;
  const held = new Promise((resolve) => { closeChild = resolve; });

  const operation = withDevelopmentSdkReader(sdkPath, async () => {
    childStarted();
    await held;
    return { teardownConfirmed: true };
  }, { root });
  await started;
  assert.equal(readerEntries(workspaceRoot).length, 1, 'reader is durable before the child starts');
  await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => {
    assert.fail('writer must not run while the SDK child is held');
  }), /writer denied[\s\S]*reader/u);

  closeChild();
  await operation;
  assert.equal(readerEntries(workspaceRoot).length, 0, 'confirmed child teardown releases the reader');
  await withDevelopmentWriter(workspaceRoot, async () => {});
});

test('unconfirmed child teardown retains the reader, while pre-child setup errors release it', async (t) => {
  const { root, sdkPath, workspaceRoot } = makeWorkspace(t);
  await withDevelopmentSdkReader(sdkPath, async () => ({ teardownConfirmed: false }), { root });
  assert.equal(readerEntries(workspaceRoot).length, 1);
  await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => {}), /writer denied[\s\S]*reader/u);

  const setupWorkspace = makeWorkspace(t);
  await assert.rejects(withDevelopmentSdkReader(setupWorkspace.sdkPath, async () => {
    throw new Error('alias setup failed before child launch');
  }, { root: setupWorkspace.root }), /alias setup failed before child launch/u);
  assert.equal(readerEntries(setupWorkspace.workspaceRoot).length, 0);
  await withDevelopmentWriter(setupWorkspace.workspaceRoot, async () => {});
});

test('node-test alias setup and child remain inside the explicit native SDK reader lifetime', async (t) => {
  const { root, sdkPath, workspaceRoot } = makeWorkspace(t);
  makeCompiledSdk(sdkPath);
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  let closeChild;
  const held = new Promise((resolve) => { closeChild = resolve; });
  let disposed = 0;

  const running = runNodeTestsWithOverlay(['suite.test.mjs'], { repoRoot: root, sdkPath }, {
    createOverlay(_root, options) {
      assert.equal(options.sdkPath, realpathSync.native(sdkPath));
      assert.equal(readerEntries(workspaceRoot).length, 1, 'reader precedes SDK package alias resolution');
      return { configPath: '/fixture/tsconfig.json', dispose() { disposed += 1; } };
    },
    async run(_files, options) {
      assert.equal(options.env.TSX_TSCONFIG_PATH, '/fixture/tsconfig.json');
      assert.equal(readerEntries(workspaceRoot).length, 1, 'reader remains while the owned node:test child is active');
      childStarted();
      await held;
      return { code: 0, teardownConfirmed: true };
    },
  });

  await started;
  await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => {}), /writer denied[\s\S]*reader/u);
  closeChild();
  await running;
  assert.equal(disposed, 1);
  assert.equal(readerEntries(workspaceRoot).length, 0);
  await withDevelopmentWriter(workspaceRoot, async () => {});
});

test('SDK-independent operation creates no Pi reader', async (t) => {
  const { root, workspaceRoot } = makeWorkspace(t);
  let invoked = false;
  const result = await withDevelopmentSdkReader(undefined, async () => {
    invoked = true;
    return { result: 'checked without SDK' };
  }, { root });
  assert.equal(invoked, true);
  assert.deepEqual(result, { result: 'checked without SDK' });
  assert.equal(existsSync(path.join(workspaceRoot, '.cache')), false,
    'no SDK reader state or Pi build is created for SDK-independent selection');
});
