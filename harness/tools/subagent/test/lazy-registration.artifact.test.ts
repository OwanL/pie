import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { before } from 'node:test';
import { verifyPiRuntimeArtifact } from '../../../../lib/pi-runtime/artifact.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const entrySource = fileURLToPath(new URL('../../../../extensions/subagent/index.ts', import.meta.url));

// Real schema/TypeBox identity is part of this regression: renderer-only
// metadata mocks cannot make it SDK-free. Use test:artifact, or test:file
// --sdk-path pointing at an independently verified pi-runtime package.
let fixtureConfig: string;
let sdkAliases: Record<string, string>;
let jitiUrl: string;
const contextPath = fileURLToPath(new URL('../runtime-context.ts', import.meta.url));
before(async () => {
  const config = process.env.TSX_TSCONFIG_PATH;
  assert.ok(config, 'lazy-registration requires the native runner --sdk-path alias overlay');
  fixtureConfig = path.resolve(config);
  const paths = JSON.parse(readFileSync(fixtureConfig, 'utf8')).compilerOptions?.paths;
  sdkAliases = {};
  for (const name of ['pi-coding-agent', 'pi-ai', 'pi-tui']) {
    const canonical = paths?.[`@earendil-works/${name}`]?.[0];
    assert.ok(canonical && path.isAbsolute(canonical), `missing selected ${name} SDK alias`);
    assert.equal(paths?.[`@mariozechner/${name}`]?.[0], canonical);
    sdkAliases[`@earendil-works/${name}`] = canonical;
    sdkAliases[`@mariozechner/${name}`] = canonical;
  }
  const sdkRoot = path.dirname(path.dirname(sdkAliases['@earendil-works/pi-coding-agent']));
  const verified = await verifyPiRuntimeArtifact(path.resolve(sdkRoot, '../../..'));
  assert.equal(path.resolve(verified.sdkPath), sdkRoot, 'aliases must select the verified SDK package');
  const sdkRequire = createRequire(sdkAliases['@earendil-works/pi-coding-agent']);
  // jiti/static is import-only; resolve the package through the verified SDK,
  // then use its declared export rather than a private filesystem layout.
  const jitiPackage = sdkRequire.resolve('jiti/package.json');
  const staticExport = JSON.parse(readFileSync(jitiPackage, 'utf8')).exports['./static'].import;
  assert.equal(typeof staticExport, 'string');
  jitiUrl = new URL(staticExport, pathToFileURL(jitiPackage)).href;
});

test('lightweight runtime context shares storage across cache-disabled loaders and preserves env fallback', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createJiti } from ${JSON.stringify(jitiUrl)};
    const parent = await createJiti(import.meta.url, { moduleCache: false }).import(${JSON.stringify(contextPath)});
    const child = await createJiti(import.meta.url, { moduleCache: false }).import(${JSON.stringify(contextPath)});
    assert.equal(parent.subagentRuntime, child.subagentRuntime);
    assert.equal(globalThis[Symbol.for('pie.subagent-runtime-context.v1')], parent.subagentRuntime);
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_TRAIL;
    assert.deepEqual(parent.readRuntimeContext(), {depth:0, trail:[]});
    process.env.PI_SUBAGENT_DEPTH = '2legacy';
    process.env.PI_SUBAGENT_TRAIL = 'scout,,worker,';
    assert.deepEqual(child.readRuntimeContext(), {depth:2, trail:['scout','worker']});
    process.env.PI_SUBAGENT_DEPTH = 'invalid';
    assert.ok(Number.isNaN(child.readRuntimeContext().depth));
    const root = {depth:1, trail:['worker'], budget:{sessions:2},
      processPermitScope:{release:()=>{}}, subagentProviderToggles:{umans:false},
      rootSessionId:'root', rootSessionPath:'root-path', canSpawn:[], bucket:'small',
      lineage:[], analyticsCapture:{}};
    await parent.subagentRuntime.run(root, async () => {
      await Promise.resolve();
      assert.equal(child.readRuntimeContext(), root);
      await child.subagentRuntime.run({depth:2,trail:['scout']}, async () => {
        assert.equal(parent.readRuntimeContext().depth, 2);
      });
      assert.equal(child.readRuntimeContext(), root);
    });
    assert.ok(Number.isNaN(parent.readRuntimeContext().depth));
  `;
  const { NODE_V8_COVERAGE: _coverageDir, ...env } = process.env;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', env, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

function freshProcess(body: string): void {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, '--eval', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const { createRequire } = Module;
    const entryRequire = createRequire(${JSON.stringify(entrySource)});
    // Check actual loader resolution, not just inherited environment/config.
    const aliases = JSON.parse(process.env.SUBAGENT_FIXTURE_SDK_ALIASES);
    for (const [name, target] of Object.entries(aliases)) {
      assert.equal(entryRequire.resolve(name), target, 'child lost selected SDK alias: ' + name);
    }
    const legacyAi = entryRequire('@mariozechner/pi-ai');
    assert.equal(legacyAi.Type, entryRequire('@earendil-works/pi-ai').Type);
    // Renderer-only seam, matching description-metadata.test.ts. The selected
    // SDK's renderer does not need an AgentSession for these checks.
    // Keep real pi-ai/schema aliases and all Pie registration modules.
    const sdkLoad = Module._load;
    Module._load = function(request, parent, ...rest) {
      if (request === '@mariozechner/pi-coding-agent' && /[/\\\\]subagent[/\\\\]render\\.ts$/.test(parent?.filename ?? '')) {
        return { getMarkdownTheme: () => ({}) };
      }
      return sdkLoad.call(this, request, parent, ...rest);
    };
    (async () => {
      ${body}
      console.log('lazy-registration assertions complete');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    encoding: 'utf8',
    env: { ...process.env, TSX_TSCONFIG_PATH: fixtureConfig, SUBAGENT_FIXTURE_SDK_ALIASES: JSON.stringify(sdkAliases) },
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /lazy-registration assertions complete/, 'child must finish all assertions');
}

test('fresh discovery import and metadata registration never evaluate the execution graph', () => {
  freshProcess(`
    const originalCompile = Module.prototype._compile;
    Module.prototype._compile = function(source, filename) {
      assert.ok(!/[/\\\\]subagent[/\\\\](execute|runner|single)\\.[cm]?[jt]s$/.test(filename),
        'metadata evaluated execution module: ' + filename);
      return originalCompile.call(this, source, filename);
    };
    const register = entryRequire(${JSON.stringify(entrySource)}).default;
    const tools = [], events = [], flags = [];
    const pi = {
      registerTool: tool => tools.push(tool),
      registerFlag: (...args) => flags.push(args),
      on: (...args) => events.push(args),
      getFlag: () => false,
      getThinkingLevel: () => { throw new Error('root hook must be a no-op'); },
    };
    register(pi);
    assert.equal(tools.length, 1);
    assert.equal(flags[0][0], 'no-subagent');
    assert.equal(events[0][0], 'before_provider_request');
    events[0][1]({}, {});
    const tool = tools[0];
    assert.equal(tool.name, 'subagent');
    assert.match(tool.description, /not sandboxing/);
    assert.ok(tool.promptSnippet && tool.promptGuidelines.length);
    assert.deepEqual(tool.parameters.required, ['agent', 'task']);
    assert.deepEqual(tool.prepareArguments({tasks: [{agent:'worker',task:'work'}]}), {agent:'worker',task:'work'});
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.renderCall, 'function');
    assert.equal(typeof tool.renderResult, 'function');
    const theme = { fg: (_color, text) => text, bold: text => text };
    assert.ok(tool.renderCall({agent:'worker', task:'work'}, theme, {}));
    assert.ok(tool.renderResult({content:[{type:'text',text:'done'}]}, {expanded:false}, theme, {}));
    process.env.PI_SUBAGENT_DISABLED = 'true';
    register(pi);
    assert.match(tools[1].description, /^DISABLED:/);
    assert.match(tools[1].promptSnippet, /^DISABLED:/);
    assert.equal(events.length, 2);
    assert.equal(flags.length, 2);
  `);
});

test('lazy implementation load failures reject concurrent callbacks without evaluating runners', () => {
  freshProcess(`
    let loads = 0;
    const originalCompile = Module.prototype._compile;
    Module.prototype._compile = function(source, filename) {
      if (/[/\\\\]subagent[/\\\\]execute\\.ts$/.test(filename)) {
        loads++;
        throw new Error('controlled module load failure');
      }
      assert.ok(!/[/\\\\]subagent[/\\\\](runner|single)\\.ts$/.test(filename));
      return originalCompile.call(this, source, filename);
    };
    let tool;
    entryRequire(${JSON.stringify(entrySource)}).default({
      on:()=>{}, getThinkingLevel:()=>{}, getFlag:()=>false,
      registerFlag:()=>{}, registerTool:def=>{tool=def},
    });
    assert.equal(loads, 0);
    await (async () => {
      await Promise.all([
        assert.rejects(tool.execute('a', {}), /controlled module load failure/),
        assert.rejects(tool.execute('b', {}), /controlled module load failure/),
      ]);
      assert.equal(loads, 1);
    })().catch(error => { console.error(error); process.exitCode=1; });
  `);
});

test('first and concurrent executions retain each registration API, live flags, signals, updates and failures', () => {
  freshProcess(`
    let evaluated = 0;
    const calls = [];
    const originalCompile = Module.prototype._compile;
    Module.prototype._compile = function(source, filename) {
      if (/[/\\\\]subagent[/\\\\]execute\\.ts$/.test(filename)) {
        evaluated++;
        Object.defineProperty(this.exports, '__esModule', { value: true });
        this.exports.execute = async (...args) => {
          calls.push(args);
          args[3]?.({content:[{type:'text',text:'update'}]});
          if (args[1].fail) throw new Error('controlled execution failure');
          return { pi: args[5], disabled: args[6](), signal: args[2] };
        };
        return;
      }
      return originalCompile.call(this, source, filename);
    };
    const register = entryRequire(${JSON.stringify(entrySource)}).default;
    function registration() {
      let tool, disabled = false;
      const pi = {on:()=>{},getThinkingLevel:()=>{},registerFlag:()=>{},
        getFlag:()=>disabled,registerTool:def=>{tool=def}};
      register(pi);
      return {pi,tool,disable:()=>{disabled=true}};
    }
    const a = registration(), b = registration();
    assert.equal(evaluated, 0);
    a.disable();
    const controller = new AbortController();
    controller.abort();
    const params = {agent:'worker',task:'work'}, ctx = {};
    let updates = 0;
    const update = () => updates++;
    await (async () => {
      const results = await Promise.all([
        a.tool.execute('first', params, controller.signal, update, ctx),
        a.tool.execute('sibling', params, undefined, update, ctx),
        b.tool.execute('other', params, undefined, undefined, ctx),
      ]);
      assert.equal(evaluated, 1);
      assert.equal(calls.length, 3);
      assert.equal(calls[0][1], params);
      assert.equal(calls[0][2], controller.signal);
      assert.equal(calls[0][3], update);
      assert.equal(calls[0][4], ctx);
      assert.equal(results[0].pi, a.pi);
      assert.equal(results[0].disabled, true);
      assert.equal(results[1].pi, a.pi);
      assert.equal(results[2].pi, b.pi);
      assert.equal(results[2].disabled, false);
      assert.equal(updates, 2);
      process.env.PI_SUBAGENT_DISABLED = 'YES';
      assert.equal((await b.tool.execute('env', params)).disabled, true);
      await assert.rejects(a.tool.execute('failure', {fail:true}), /controlled execution failure/);
      assert.equal(evaluated, 1);
    })().catch(error => {console.error(error);process.exitCode=1});
  `);
});
