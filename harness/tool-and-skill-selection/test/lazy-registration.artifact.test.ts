import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';

const entry = fileURLToPath(new URL('../lifecycle/register.ts', import.meta.url));
const prepass = fileURLToPath(new URL('../prepass/prepass.js', import.meta.url));

test('fresh Jiti registration and skipped turns do not load the execution prepass; first load is shared, retryable and disposal-fenced', async () => {
  const config = process.env.TSX_TSCONFIG_PATH;
  assert.ok(config, 'use test:file --sdk-path with a verified runtime');
  const paths = JSON.parse(readFileSync(config, 'utf8')).compilerOptions.paths;
  const sdkEntry = paths['@earendil-works/pi-coding-agent'][0];
  const sdkRoot = path.dirname(path.dirname(sdkEntry));
  const verified = await verifyPiRuntimeArtifact(path.resolve(sdkRoot, '../../..'));
  assert.equal(path.resolve(verified.sdkPath), sdkRoot);
  const jitiPackage = createRequire(sdkEntry).resolve('jiti/package.json');
  const jitiUrl = new URL(JSON.parse(readFileSync(jitiPackage, 'utf8')).exports['./static'].import, pathToFileURL(jitiPackage)).href;
  const root = await mkdtemp(path.join(tmpdir(), 'pie-pruner-registration-'));
  try {
    const stub = path.join(root, 'execution-prepass.cjs');
    await writeFile(stub, `globalThis.executionLoads++;
if (globalThis.failExecutionLoad) throw new Error('fixture import failure');
exports.getRecentConversation = () => { globalThis.scorerTouches++; return []; };
exports.getCompleteFn = () => { globalThis.scorerTouches++; return null; };
exports.runPruningPrepass = () => { throw new Error('must not call a provider'); };
`);
    const alias = Object.fromEntries(Object.entries(paths).map(([name, targets]) => [name, (targets as string[])[0]]));
    alias['../prepass/prepass.js'] = stub;
    alias['../prepass/prepass.ts'] = stub;
    alias[prepass] = stub;
    alias[prepass.replace(/\.js$/, '.ts')] = stub;
    const script = `
      import assert from 'node:assert/strict';
      import Module from 'node:module';
      import fs, { writeFileSync } from 'node:fs';
      import { createJiti } from ${JSON.stringify(jitiUrl)};
      process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(root)};
      delete process.env.PIE_EXTENSION_TOGGLES_JSON;
      delete process.env.PIE_AUTONOMOUS_MODE;
      globalThis.fetch = () => { throw new Error('no network'); };
      globalThis.scorerTouches = 0;
      let allow = false;
      globalThis.executionLoads = 0;
      globalThis.failExecutionLoad = false;
      const forbidden = /[/\\\\]prepass[/\\\\]prepass\\.[cm]?[jt]s$/;
      const isExecution = filename => forbidden.test(filename) || filename.replaceAll('\\\\', '/') === ${JSON.stringify(stub.replaceAll('\\', '/'))};
      const originalLoad = Module._load;
      Module._load = function(request, ...args) {
        if (isExecution(request)) {
          assert.ok(allow, 'eager execution load: ' + request);
          if (globalThis.failExecutionLoad) throw new Error('fixture import failure');
        }
        return originalLoad.call(this, request, ...args);
      };
      const originalCompile = Module.prototype._compile;
      Module.prototype._compile = function(source, filename) {
        if (isExecution(filename)) {
          assert.ok(allow, 'eager execution evaluation: ' + filename);
        }
        return originalCompile.call(this, source, filename);
      };
      const originalRead = fs.readFileSync;
      fs.readFileSync = function(filename, ...args) {
        if (isExecution(String(filename))) {
          assert.ok(allow, 'eager execution read: ' + filename);
          if (globalThis.failExecutionLoad) throw new Error('fixture import failure');
        }
        return originalRead.call(this, filename, ...args);
      };
      const originalAsyncRead = fs.promises.readFile;
      fs.promises.readFile = async function(filename, ...args) {
        if (isExecution(String(filename))) {
          assert.ok(allow, 'eager async execution read: ' + filename);
          if (globalThis.failExecutionLoad) throw new Error('fixture import failure');
        }
        return originalAsyncRead.call(this, filename, ...args);
      };
      const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: ${JSON.stringify(alias)} });
      const { default: register } = await jiti.import(${JSON.stringify(entry)});
      function registration() {
        const hooks = new Map(), tools = [], renderers = [];
        register({on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.push(tool),
          registerMessageRenderer: (name, fn) => renderers.push({name, type: typeof fn}),
          getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => { throw new Error('unexpected activation'); }});
        return { hooks, tools, renderers };
      }
      const first = registration(), second = registration();
      for (const item of [first, second]) {
        assert.deepEqual([...item.hooks.keys()], ['context', 'session_shutdown', 'input', 'before_agent_start', 'before_compaction_resume', 'tool_call']);
        assert.ok([...item.hooks.values()].every(fn => typeof fn === 'function'));
        assert.deepEqual(item.renderers, [{name: 'pruning-result', type: 'function'}]);
        assert.equal(item.tools.length, 1);
        assert.equal(item.tools[0].name, 'request_capability');
        assert.equal(item.tools[0].label, 'Request Capability');
        assert.equal(item.tools[0].description, 'List tools and skills hidden by the latest pruning decision, or activate/load one by exact type and name.');
        assert.equal(typeof item.tools[0].execute, 'function');
      }
      assert.deepEqual(first.tools[0].parameters, second.tools[0].parameters);
      const messages = [{role: 'user'}, {role: 'custom', customType: 'pruning-result'}, {role: 'custom', customType: 'other'}];
      assert.deepEqual(first.hooks.get('context')({messages}).messages, [messages[0], messages[2]]);
      const settings = {mode: 'auto', model: 'fixture', provider: 'fixture', thinkingLevel: 'minimal',
        skills: {strategy: 'discretion', ceiling: 8, pinned: [], alwaysKeep: []}};
      const configure = changes => writeFileSync(${JSON.stringify(path.join(root, 'settings.json'))}, JSON.stringify({pruning: {...settings, ...changes}}));
      const ctx = id => ({sessionManager: {getSessionId: () => id, getSessionFile: () => ${JSON.stringify(path.join(root, 'session'))}}});
      const event = {prompt: 'A sufficiently long task prompt to consider skills', systemPrompt: 'base', systemPromptOptions: {skills: []}};
      const run = (item, ev, id) => item.hooks.get('before_agent_start')(ev, ctx(id));
      configure({mode: 'off'}); await run(first, event, 'off');
      configure({mainAgentEnabled: false}); await run(first, event, 'disabled');
      configure({}); await run(first, {...event, prompt: 'hi'}, 'short');
      await run(first, event, 'empty');
      first.hooks.get('input')({text: event.prompt, streamingBehavior: 'steer'});
      await run(first, event, 'queued');
      assert.equal(globalThis.executionLoads, 0);
      assert.ok(Object.keys(Module._cache).every(filename => !isExecution(filename)));
      const candidate = {...event, refreshPruning: true, systemPromptOptions: {skills: [{name: 'fixture', description: 'fixture', filePath: '/fixture/SKILL.md'}]}};
      allow = true; globalThis.failExecutionLoad = true;
      await assert.rejects(run(first, candidate, 'failure'), /fixture import failure/);
      const failedLoads = globalThis.executionLoads;
      assert.equal(failedLoads, 0, 'import failure precedes evaluation');
      globalThis.failExecutionLoad = false;
      const pending = [run(first, candidate, 'one'), run(second, candidate, 'two')];
      first.hooks.get('session_shutdown')({}, ctx('one'));
      second.hooks.get('session_shutdown')({}, ctx('two'));
      assert.deepEqual(await Promise.all(pending), [undefined, undefined]);
      assert.equal(globalThis.executionLoads, failedLoads + 1, 'retry shared between registration owners');
      assert.equal(globalThis.scorerTouches, 0, 'shutdown while import pending fences conversation/completion work');
      const result = await run(first, candidate, 'live');
      assert.equal(globalThis.executionLoads, failedLoads + 1);
      assert.equal(globalThis.scorerTouches, 2);
      assert.equal(result.message.details.prepassError, 'No completion function available');
      console.log('LAZY_PRUNER_OK');
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|lang)$/i.test(key)));
    const childPath = path.join(root, 'registration.mjs');
    await writeFile(childPath, script);
    const result = spawnSync(process.execPath, [childPath], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.signal ?? ''}\n${result.stderr || result.stdout}`);
    assert.match(result.stdout, /LAZY_PRUNER_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
