import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import { resolveTypeScriptCompiler } from '../../lib/package-resolution.mjs';
import {
  buildTypecheckArgs,
  createTypecheckCacheKey,
  parseArgs,
  runTypecheck,
} from '../typecheck-project.mjs';

const compilerApi = {
  parseConfigFileTextToJson(_filename, text) {
    return { config: JSON.parse(text) };
  },
};

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function makeNativeSdkWorkspace(root) {
  const sdkPath = path.join(root, 'harness', 'pi', 'packages', 'coding-agent');
  const packageNames = [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    'typebox',
  ];
  for (const [index, name] of packageNames.entries()) {
    const packageRoot = index === 0 ? sdkPath : path.join(sdkPath, 'node_modules', ...name.split('/'));
    write(path.join(packageRoot, 'package.json'), JSON.stringify({
      name,
      type: 'module',
      exports: { '.': { types: './index.d.ts', import: './index.mjs' } },
    }));
    write(path.join(packageRoot, 'index.mjs'), 'export const sdkValue = 1;\n');
    write(path.join(packageRoot, 'index.d.ts'), 'export declare const sdkValue: number;\n');
  }
  return sdkPath;
}

function makeHeldCompilerChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('typecheck CLI accepts one config and an explicit optional SDK path', () => {
  assert.deepEqual(parseArgs(['application/tsconfig.json']), {
    config: 'application/tsconfig.json',
    help: false,
  });
  assert.deepEqual(parseArgs(['tsconfig.json', '--sdk-path=runtime/pi-coding-agent']), {
    config: 'tsconfig.json',
    sdkPath: 'runtime/pi-coding-agent',
    help: false,
  });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs([]), /project config/);
  assert.throws(() => parseArgs(['a.json', 'b.json']), /Only one/);
  assert.throws(() => parseArgs(['a.json', '--sdk-path']), /requires an SDK/);
});

test('typecheck always performs no-emit incremental checks with stable build-info location', () => {
  const args = buildTypecheckArgs('/repo/.cache/typecheck/hash/tsconfig.overlay.json', '/repo/.cache/typecheck/hash/project.tsbuildinfo');
  assert.deepEqual(args, [
    '--noEmit', '--incremental', '--project', '/repo/.cache/typecheck/hash/tsconfig.overlay.json',
    '--tsBuildInfoFile', '/repo/.cache/typecheck/hash/project.tsbuildinfo',
  ]);
  assert.equal(args.includes('--build'), false);
  assert.equal(args.includes('--skipLibCheck'), false);
});

test('incremental compiler state is reused without skipping checks', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tsconfig.json');
  const sourcePath = path.join(root, 'src.ts');
  write(configPath, JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', types: [] },
    files: ['./src.ts'],
  }));
  write(sourcePath, 'const answer: number = 42;\n');
  const compilerPath = resolveTypeScriptCompiler();
  const first = await runTypecheck({ configPath, compilerPath, root });
  assert.equal(first.code, 0, first.output);
  assert.equal(first.cacheDirectory.startsWith(path.join(root, '.cache', 'typecheck')), true);
  assert.equal(existsSync(path.join(first.cacheDirectory, 'tsconfig.overlay.json')), true);
  assert.equal(existsSync(path.join(first.cacheDirectory, 'project.tsbuildinfo')), true);

  write(sourcePath, "const answer: number = 'wrong';\n");
  const second = await runTypecheck({ configPath, compilerPath, root });
  assert.notEqual(second.code, 0, 'source errors are rechecked with existing .tsbuildinfo');
  assert.match(second.output, /string.*not assignable.*number/u);
});

test('typecheck cache key follows base configs, SDK runtime lock, compiler, and toolchain inputs', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tsconfig.json');
  const extendedConfig = path.join(root, 'base.json');
  const compilerPath = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const sdkPath = path.join(root, 'runtime', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const runtimeRoot = path.resolve(sdkPath, '../../..');
  write(configPath, JSON.stringify({ extends: './base.json' }));
  write(extendedConfig, JSON.stringify({ compilerOptions: { strict: true } }));
  write(compilerPath, '/* compiler entry */');
  write(path.join(root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3' }));
  write(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  write(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  write(path.join(sdkPath, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1' }));
  write(path.join(runtimeRoot, 'manifest.json'), JSON.stringify({ runtime: 'fixture' }));
  write(path.join(runtimeRoot, 'pnpm-lock.yaml'), 'sdk-lock: first\n');
  const options = { configPath, compilerPath, sdkPath, root, compiler: compilerApi };
  const original = createTypecheckCacheKey(options);
  assert.equal(original, createTypecheckCacheKey(options));
  assert.notEqual(original, createTypecheckCacheKey({ ...options, sdkPath: undefined }), 'SDK selection participates in cache key');

  write(extendedConfig, JSON.stringify({ compilerOptions: { strict: false } }));
  assert.notEqual(original, createTypecheckCacheKey(options), 'extended base config content participates');
  write(extendedConfig, JSON.stringify({ compilerOptions: { strict: true } }));
  write(path.join(runtimeRoot, 'pnpm-lock.yaml'), 'sdk-lock: second\n');
  assert.notEqual(original, createTypecheckCacheKey(options), 'selected runtime lock participates');
  write(path.join(runtimeRoot, 'pnpm-lock.yaml'), 'sdk-lock: first\n');
  write(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.0.0' }));
  assert.notEqual(original, createTypecheckCacheKey(options), 'toolchain manifest participates');
  write(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  write(compilerPath, '/* compiler entry changed */');
  assert.notEqual(original, createTypecheckCacheKey(options), 'compiler executable content participates');
});

test('native-workspace typecheck holds its reader through watchdog-confirmed child close', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-sdk-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdkPath = makeNativeSdkWorkspace(root);
  const workspaceRoot = path.join(root, 'harness', 'pi');
  const configPath = path.join(root, 'tsconfig.json');
  write(configPath, JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', types: [] },
    files: ['./src.ts'],
  }));
  write(path.join(root, 'src.ts'), "import { sdkValue } from '@earendil-works/pi-coding-agent';\nconst answer: number = sdkValue;\n");

  let childReady;
  const ready = new Promise((resolve) => { childReady = resolve; });
  const child = makeHeldCompilerChild();
  const running = runTypecheck({
    configPath,
    sdkPath,
    root,
    compilerPath: resolveTypeScriptCompiler(),
    spawnImpl: () => {
      setImmediate(() => childReady(child));
      return child;
    },
    watchChildProcessImpl: () => ({
      timedOut: false,
      aborted: false,
      settle: async () => ({ gone: true, survivors: [] }),
    }),
  });

  await ready;
  const readersDirectory = path.join(workspaceRoot, '.cache', 'development-runtime', 'readers');
  assert.equal(readdirSync(readersDirectory).length, 1, 'reader is acquired before the compiler child can read aliases');
  await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => {
    assert.fail('Pi workspace writer must not run while tsc is held');
  }), /writer denied[\s\S]*reader/u);

  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0);
  const result = await running;
  assert.equal(result.teardownConfirmed, true);
  assert.equal(readdirSync(readersDirectory).length, 0, 'reader releases only after the watchdog settles gone');
  await withDevelopmentWriter(workspaceRoot, async () => {});
});

test('native-workspace typecheck retains reader evidence when watchdog teardown is unconfirmed', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-sdk-uncertain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdkPath = makeNativeSdkWorkspace(root);
  const workspaceRoot = path.join(root, 'harness', 'pi');
  const configPath = path.join(root, 'tsconfig.json');
  write(configPath, JSON.stringify({ compilerOptions: { strict: true, types: [] }, files: ['./src.ts'] }));
  write(path.join(root, 'src.ts'), 'export {};\n');

  let childReady;
  const ready = new Promise((resolve) => { childReady = resolve; });
  const child = makeHeldCompilerChild();
  const running = runTypecheck({
    configPath,
    sdkPath,
    root,
    compilerPath: resolveTypeScriptCompiler(),
    spawnImpl: () => {
      setImmediate(() => childReady(child));
      return child;
    },
    watchChildProcessImpl: () => ({
      timedOut: false,
      aborted: false,
      settle: async () => ({ gone: false, survivors: [12345] }),
    }),
  });

  await ready;
  const readersDirectory = path.join(workspaceRoot, '.cache', 'development-runtime', 'readers');
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0);
  await assert.rejects(running, (error) => error.teardownUnconfirmed === true);
  assert.equal(readdirSync(readersDirectory).length, 1, 'unknown process-tree teardown keeps durable writer-blocking evidence');
  await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => {}), /writer denied[\s\S]*reader/u);
});
