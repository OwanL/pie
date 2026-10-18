import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('../../../../extensions/tool-result-pruner/index.ts', import.meta.url));

test('isolated registration keeps hooks and reaping eager but loads transforms only on demand', () => {
  // Compile only the owned adapter in memory. Controlled dependency exports
  // let this SDK-free child exercise import failures without writing caches,
  // touching user data, or invoking a provider/session.
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const Module = require('node:module');
    const ts = require(${JSON.stringify(require.resolve('typescript'))});
    const entry = ${JSON.stringify(entry)};
    let disabled = false, enabled = true, tools = null, fail = null;
    let reaps = 0, legacyReaps = 0, tracked = [], cleaned = [], records = 0;
    const loads = { pipeline: 0, tokens: 0, logger: 0 };
    const evaluated = new Set();
    const failure = new Error('controlled failure');
    const originalLoad = Module._load;
    Module._load = function(request, parent, ...rest) {
      const name = request.replaceAll('\\\\', '/');
      if (name.endsWith('/result-processing/config.js')) return {
        isExtensionDisabledByToggle: () => disabled,
        loadConfig: () => ({ enabled, tools }),
      };
      if (name.endsWith('/result-processing/reaper.js')) return {
        reapPrunedRawStashes: async () => { reaps++; },
        reapSessionStashes: async () => { legacyReaps++; },
      };
      if (name.endsWith('/session-attribution.js')) return {
        getRootSessionId: () => 'root', rootSessionAttribution: () => ({}),
      };
      if (name.endsWith('/session-temp-output-lifecycle.js')) return {
        isSdkSessionTempOutputPath: p => p === '/owned-sdk',
        trackSessionTempOutput: async (...args) => { tracked.push(args); if (fail === 'ownership') throw failure; return true; },
        cleanupSessionTempOutputs: async (...args) => { cleaned.push(args); if (fail === 'cleanup') throw failure; },
        createSessionTempOutput: async () => { throw new Error('unexpected stash'); },
      };
      let key;
      if (name.endsWith('/result-processing/pipeline.js')) key = 'pipeline';
      if (name.endsWith('/tokenization.js')) key = 'tokens';
      if (name.endsWith('/result-processing/logger.js')) key = 'logger';
      if (key) {
        loads[key]++;
        if (fail === key) throw failure;
        evaluated.add(key);
        if (key === 'pipeline') return { runPipeline: e => e.content[0].text === 'unchanged' ? null : ({ meta: {
          beforeText: e.content[0].text, afterText: 'clean', losslessText: 'clean',
          rules: ['ansi-strip'], recallRules: [], markers: [],
        } }) };
        if (key === 'tokens') return { countTokens: text => text.length };
        return { recordPruning: () => { records++; } };
      }
      return originalLoad.call(this, request, parent, ...rest);
    };
    const adapter = new Module(entry, module);
    adapter.filename = entry;
    adapter.paths = Module._nodeModulePaths(require('node:path').dirname(entry));
    adapter._compile(ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
      // This script executes under the source-coverage capture preload too.
      // Preserve ownership of the in-memory CommonJS transform at its TS URL.
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        inlineSourceMap: true, inlineSources: true },
      fileName: entry,
    }).outputText, entry);
    function register() {
      const hooks = new Map();
      adapter.exports.default({ on: (name, handler) => {
        assert.equal(typeof handler, 'function'); assert.ok(!hooks.has(name)); hooks.set(name, handler);
      }});
      assert.deepEqual([...hooks.keys()], ['session_shutdown', 'tool_execution_update', 'tool_result']);
      return hooks;
    }
    const event = overrides => ({ toolName: 'bash', isError: false, input: {},
      content: [{ type: 'text', text: 'original ANSI output' }], ...overrides });
    (async () => {
      assert.deepEqual(Object.keys(adapter.exports).sort(), ['default', 'setStashDirForTesting']);
      const a = register(), b = register();
      assert.equal(reaps, 2);
      assert.notEqual(a.get('tool_result'), b.get('tool_result'), 'handlers belong to their registration');
      assert.equal(evaluated.size, 0);
      const owner = { getSessionId: () => 'session' }, ctx = { sessionManager: owner };
      const run = e => a.get('tool_result')(e, ctx);
      disabled = true;
      await a.get('tool_execution_update')({ toolName: 'bash', partialResult: { details: { fullOutputPath: '/owned-sdk' } } }, ctx);
      assert.equal(await run(event({ details: { fullOutputPath: '/owned-sdk' } })), undefined);
      assert.equal(tracked.length, 2);
      assert.equal(tracked[0][3], owner);
      assert.equal(tracked[0][4], 'root');
      disabled = false; enabled = false;
      assert.equal(await run(event()), undefined);
      enabled = true;
      for (const e of [event({isError: true}), event({toolName: 'read'}), event({content: []}),
        event({content: [{type: 'image'}]}), event({content: [{type: 'text', text: 'a'}, {type: 'text', text: 'b'}]})]) {
        assert.equal(await run(e), undefined);
      }
      tools = []; assert.equal(await run(event()), undefined); tools = null;
      assert.equal(evaluated.size, 0);
      assert.equal(await run(event({content: [{type: 'text', text: 'unchanged'}]})), undefined);
      assert.deepEqual([...evaluated], ['pipeline'], 'unchanged results need no token helpers or logger');
      const outputs = await Promise.all([run(event()), b.get('tool_result')(event(), ctx)]);
      for (const out of outputs) assert.equal(out.content[0].text, 'clean');
      assert.deepEqual([...evaluated], ['pipeline', 'tokens', 'logger']);
      assert.equal(records, 2);
      for (const key of ['pipeline', 'tokens', 'logger']) {
        fail = key;
        const original = event();
        const before = JSON.stringify(original);
        const out = await run(original);
        if (key === 'logger') assert.equal(out.content[0].text, 'clean');
        else assert.equal(out, undefined, key + ' load failure preserves successful output');
        assert.equal(JSON.stringify(original), before);
        await a.get('session_shutdown')({}, ctx);
      }
      fail = 'ownership'; disabled = true;
      await assert.rejects(run(event({details: {fullOutputPath: '/owned-sdk'}})), e => e === failure);
      await assert.rejects(a.get('tool_execution_update')({toolName: 'bash', partialResult: {details: {fullOutputPath: '/owned-sdk'}}}, ctx), e => e === failure);
      fail = 'cleanup';
      await assert.rejects(a.get('session_shutdown')({}, ctx), e => e === failure);
      assert.equal(cleaned.length, 4);
      assert.ok(cleaned.every(args => args[0] === 'session' && args[1] === owner && args[2] === 'root'));
      assert.equal(legacyReaps, 4);
      await assert.rejects(a.get('session_shutdown')({}, {}), /session manager/);
      assert.equal(reaps, 2);
      console.log('lazy registration assertions complete');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { NODE_V8_COVERAGE: _coverage, ...env } = process.env;
  const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /lazy registration assertions complete/);
});
