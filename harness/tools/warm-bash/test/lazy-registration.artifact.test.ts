import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPiRuntimeArtifact } from '../../../../lib/pi-runtime/artifact.mjs';

const entrySource = fileURLToPath(new URL('../index.ts', import.meta.url));

test('fresh registration defers operations; concurrent first use and shutdown retain lifecycle fences', async () => {
  const config = process.env.TSX_TSCONFIG_PATH;
  assert.ok(config, 'use test:file --sdk-path with a verified runtime');
  const sdkEntry = JSON.parse(readFileSync(config, 'utf8')).compilerOptions.paths['@earendil-works/pi-coding-agent'][0];
  const sdkRoot = path.dirname(path.dirname(sdkEntry));
  const verified = await verifyPiRuntimeArtifact(path.resolve(sdkRoot, '../../..'));
  assert.equal(path.resolve(verified.sdkPath), sdkRoot);
  const sdkRequire = createRequire(sdkEntry);
  const jitiPackage = sdkRequire.resolve('jiti/package.json');
  const jitiUrl = new URL(JSON.parse(readFileSync(jitiPackage, 'utf8')).exports['./static'].import, pathToFileURL(jitiPackage)).href;
  const root = await mkdtemp(path.join(tmpdir(), 'pie-warm-bash-registration-'));
  try {
    const stubs: Record<string, string> = {
      sdk: `
        exports.getAgentDir = () => ${JSON.stringify(root)};
        exports.getShellConfig = () => ({shell: 'fixture-bash'});
        exports.createLocalBashOperations = () => ({exec: async () => { globalThis.fixture.fallbacks++; return {exitCode: 0}; }});
        exports.createBashTool = (cwd, options) => {
          globalThis.fixture.builds.push({cwd, options});
          globalThis.fixture.onBuild?.();
          return {name: 'bash', label: 'Bash', description: 'SDK bash',
            promptSnippet: 'SDK snippet', renderResult: globalThis.fixture.render,
            parameters: {type: 'object', properties: {command: {type: 'string'}, timeout: {type: 'number'}}},
            execute: async (id, params, signal) => {
              const f = globalThis.fixture;
              const spawn = options.spawnHook({command: params.command, cwd, env: process.env});
              f.executions.push({id, params, cwd: spawn.cwd});
              if (signal?.aborted) throw new Error('aborted');
              if (options.operations) await options.operations.exec(params.command, spawn.cwd, {onData() {}, signal, timeout: params.timeout, env: spawn.env});
              return {content: []};
            }};
        };
      `,
      pool: `exports.WarmBashPool = class {
        constructor(options) { this.target = options.size; globalThis.fixture.pools.push(this); }
        setTarget(target) { this.target = target; }
        dispose() { this.disposed = true; }
        getStats() { return {poolSize: this.target, totalWarmupFailures: 0}; }
      };`,
      logger: `exports.logAutoPruneRewrite = () => {};
        exports.logSessionSummary = (...args) => globalThis.fixture.summaries.push(args);
        exports.flushLog = async () => { globalThis.fixture.flushes++; };`,
      probe: `exports.probeGnuGrep = () => true;`,
      // Fallback factory and shell probe are replaced, not the execution graph:
      // real operations, auto-prune, classifier, and fast-path stay absent until execution.
      // resolve.ts stays eager because managed-env.ts also owns its pathKey helper.
    };
    for (const [name, source] of Object.entries(stubs)) await writeFile(path.join(root, `${name}.cjs`), source);
    const aliases = {
      '@earendil-works/pi-coding-agent': path.join(root, 'sdk.cjs'),
      './warm-pool.js': path.join(root, 'pool.cjs'),
      './logger.js': path.join(root, 'logger.cjs'),
      './gnu-grep-probe.js': path.join(root, 'probe.cjs'),
    };
    const script = `
      import assert from 'node:assert/strict';
      import Module from 'node:module';
      import { createJiti } from ${JSON.stringify(jitiUrl)};
      const f = globalThis.fixture = {builds: [], executions: [], pools: [], summaries: [], flushes: 0, fallbacks: 0, render() {}};
      process.env.PIE_SHELL = 'fixture-bash';
      process.env.PIE_BASH_WARM_POOL = '2';
      process.env.PIE_BASH_FAST_PATH = '0';
      process.env.PIE_BASH_AUTO_PRUNE = '0';
      delete process.env.PIE_EXTENSION_TOGGLES_JSON;
      globalThis.fetch = () => { throw new Error('must not fetch'); };
      const boundary = /[/\\\\](operations|auto-prune|classifier|fast-path)\\.[cm]?[jt]s$/;
      let cold = true;
      const operationModules = () => Object.keys(Module._cache).filter(filename => /[/\\\\]warm-bash[/\\\\]operations\\.[cm]?[jt]s$/.test(filename));
      const compile = Module.prototype._compile;
      Module.prototype._compile = function(source, filename) {
        if (boundary.test(filename)) assert.equal(cold, false, 'cold registration evaluated ' + filename);
        return compile.call(this, source, filename);
      };
      const load = Module._load;
      Module._load = function(request, ...args) {
        if (boundary.test(request)) assert.equal(cold, false, 'cold registration loaded ' + request);
        return load.call(this, request, ...args);
      };
      const jiti = createJiti(import.meta.url, {moduleCache: true, fsCache: false, alias: ${JSON.stringify(aliases)}});
      const {default: register} = await jiti.import(${JSON.stringify(entrySource)});
      const events = {}, tools = [];
      const listeners = process.listenerCount('SIGTERM');
      register({registerTool: tool => tools.push(tool), on: (name, handler) => events[name] = handler});
      assert.equal(f.pools.length, 1, 'pool warming remains eager');
      assert.equal(f.pools[0].target, 2);
      assert.equal(process.listenerCount('SIGTERM'), listeners + 1);
      assert.equal(typeof events.session_shutdown, 'function');
      const tool = tools[0];
      assert.equal(tool.name, 'bash');
      assert.equal(tool.promptSnippet, 'SDK snippet');
      assert.equal(tool.renderResult, f.render);
      assert.equal(tool.parameters.properties.command.type, 'string');
      assert.match(tool.parameters.properties.timeout.description, /60/);
      assert.equal(f.builds.length, 1, 'only base tool built at registration');
      assert.equal(typeof f.builds[0].options.spawnHook, 'function');
      assert.deepEqual(Object.keys(Module._cache).filter(filename => boundary.test(filename)), []);
      cold = false;
      const ctx = id => ({cwd: 'fixture-cwd', sessionManager: {getSessionId: () => id}});
      // Toggle-off execution must also avoid the execution graph.
      process.env.PIE_EXTENSION_TOGGLES_JSON = '{"warm-bash":false}';
      await tool.execute('disabled', {command: 'fixture'}, undefined, undefined, ctx('disabled'));
      assert.equal(operationModules().length, 0);
      delete process.env.PIE_EXTENSION_TOGGLES_JSON;
      const aborted = new AbortController();
      const first = tool.execute('first', {command: 'fixture'}, undefined, undefined, ctx('closing'));
      const second = tool.execute('second', {command: 'fixture'}, undefined, undefined, ctx('closing'));
      const aborting = tool.execute('abort', {command: 'fixture'}, aborted.signal, undefined, ctx('aborting'));
      const rejected = [first, second, aborting].map(promise => assert.rejects(promise, /aborted/));
      aborted.abort();
      await events.session_shutdown({}, ctx('closing'));
      await Promise.all(rejected);
      assert.equal(f.executions.length, 1, 'no execution or stale tool created after shutdown/abort');
      assert.equal(f.builds.length, 1);
      assert.equal(f.summaries.length, 0, 'loading-only session has no metrics');
      assert.equal(f.pools[0].disposed, undefined, 'shutdown does not dispose shared pool');
      const active = [
        tool.execute('third', {command: 'fixture'}, undefined, undefined, ctx('active')),
        tool.execute('fourth', {command: 'fixture'}, undefined, undefined, ctx('active')),
      ];
      // Configuration must be sampled after import, not from before its await.
      process.env.PIE_BASH_WARM_POOL = '0';
      await Promise.all(active);
      assert.equal(f.builds.length, 2, 'concurrent first use builds one session tool');
      assert.equal(f.pools[0].disposed, true, 'fresh pool config reconciled after await');
      assert.equal(operationModules().length, 1, 'one module identity across concurrent imports');
      await events.session_shutdown({}, ctx('active'));
      assert.equal(f.summaries.length, 1);
      assert.equal(f.summaries[0][1].fallback, 2);
      assert.equal(f.flushes, 2);
      // Cover the second await boundary: shutdown after getTool builds/returns,
      // but before the registered execute continuation can use the tool.
      f.onBuild = () => queueMicrotask(() => events.session_shutdown({}, ctx('late-close')));
      await assert.rejects(tool.execute('late', {command: 'fixture'}, undefined, undefined, ctx('late-close')), /aborted/);
      assert.equal(f.executions.length, 3);
      assert.equal(f.summaries.length, 2);
      assert.equal(f.summaries[1][1].fallback, 0);
      // Hot config invalidation is not session disposal: another continuation
      // may replace the cached tool without cancelling the earlier invocation.
      f.onBuild = () => { delete f.onBuild; process.env.PIE_BASH_AUTO_PRUNE = '1'; };
      await Promise.all([
        tool.execute('config-a', {command: 'fixture'}, undefined, undefined, ctx('config-change')),
        tool.execute('config-b', {command: 'fixture'}, undefined, undefined, ctx('config-change')),
      ]);
      assert.equal(f.executions.length, 5);
      await events.session_shutdown({}, ctx('config-change'));
      console.log('warm-bash registration and fences verified');
    `;
    const { NODE_V8_COVERAGE: _coverage, ...env } = process.env;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {encoding: 'utf8', env, timeout: 30_000});
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /registration and fences verified/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
