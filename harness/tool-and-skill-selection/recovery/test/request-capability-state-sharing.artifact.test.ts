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

const entry = fileURLToPath(new URL('../../lifecycle/register.ts', import.meta.url));
const prepass = fileURLToPath(new URL('../../prepass/prepass.js', import.meta.url));

test('installed Jiti shares real pruning-hook state with registered request_capability recovery', async () => {
  const config = process.env.TSX_TSCONFIG_PATH;
  assert.ok(config, 'use test:file --sdk-path with a verified runtime');
  const paths = JSON.parse(readFileSync(config, 'utf8')).compilerOptions.paths;
  const sdkEntry = paths['@earendil-works/pi-coding-agent'][0];
  const sdkRoot = path.dirname(path.dirname(sdkEntry));
  const verified = await verifyPiRuntimeArtifact(path.resolve(sdkRoot, '../../..'));
  assert.equal(path.resolve(verified.sdkPath), sdkRoot);
  const jitiPackage = createRequire(sdkEntry).resolve('jiti/package.json');
  const jitiUrl = new URL(JSON.parse(readFileSync(jitiPackage, 'utf8')).exports['./static'].import, pathToFileURL(jitiPackage)).href;
  const root = await mkdtemp(path.join(tmpdir(), 'pie-capability-state-'));
  try {
    const stub = path.join(root, 'prepass.cjs');
    const skillPath = path.join(root, 'SKILL.md');
    await writeFile(skillPath, '---\nname: fixture-skill\n---\nFixture recovery instructions.\n');
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({pruning: {
      mode: 'auto', model: 'fixture', provider: 'fixture', thinkingLevel: 'minimal',
      skills: {strategy: 'discretion', ceiling: 8, pinned: [], alwaysKeep: []},
      tools: {strategy: 'discretion', ceiling: 10, dependencies: {}, alwaysKeep: []},
    }}));
    await writeFile(stub, `
exports.getRecentConversation = () => [];
exports.getCompleteFn = () => () => { throw new Error('must not call provider'); };
exports.runPruningPrepass = async (_ctx, input) => {
  globalThis.prepassCalls++;
  require('node:assert/strict').deepEqual(input.skills.map(s => s.name), ['fixture-skill']);
  require('node:assert/strict').deepEqual(input.tools.map(t => t.name), ['fixture-tool']);
  return {prunedSkills: ['fixture-skill'], prunedTools: ['fixture-tool'], error: null,
    rawResponse: '{}', rawThinking: '', rawSystemPrompt: '', rawUserMessage: '',
    thinkingLevel: 'minimal', latencyMs: 0};
};
`);
    const alias = Object.fromEntries(Object.entries(paths).map(([name, targets]) => [name, (targets as string[])[0]]));
    alias['../prepass/prepass.js'] = stub;
    alias['../prepass/prepass.ts'] = stub;
    alias[prepass] = stub;
    alias[prepass.replace(/\.js$/, '.ts')] = stub;
    const script = `
      import assert from 'node:assert/strict';
      import { createJiti } from ${JSON.stringify(jitiUrl)};
      process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(root)};
      delete process.env.PIE_EXTENSION_TOGGLES_JSON;
      delete process.env.PIE_AUTONOMOUS_MODE;
      globalThis.fetch = () => { throw new Error('no network'); };
      globalThis.prepassCalls = 0;
      // Match the installed extension loader, including uncached module identity.
      const jiti = createJiti(import.meta.url, {moduleCache: false, fsCache: false, alias: ${JSON.stringify(alias)}});
      const {default: register} = await jiti.import(${JSON.stringify(entry)});
      const hooks = new Map();
      let recovery;
      let active = ['request_capability', 'fixture-tool'];
      register({on: (name, fn) => hooks.set(name, fn), registerMessageRenderer: () => {},
        registerTool: tool => { recovery = tool; },
        getAllTools: () => [{name: 'request_capability', description: 'recover'}, {name: 'fixture-tool', description: 'fixture'}],
        getActiveTools: () => [...active], setActiveTools: names => { active = [...names]; }});
      const ctx = {sessionManager: {getSessionId: () => 'fixture-session', getSessionFile: () => ${JSON.stringify(path.join(root, 'session'))}}};
      const result = await hooks.get('before_agent_start')({
        prompt: 'Perform a deterministic fixture task with pruning', refreshPruning: true,
        systemPrompt: 'Base\\n\\nThe following skills provide specialized instructions for specific tasks.\\n<available_skills>\\nfixture-skill\\n</available_skills>',
        systemPromptOptions: {skills: [{name: 'fixture-skill', description: 'fixture', filePath: ${JSON.stringify(skillPath)}, baseDir: ${JSON.stringify(root)}, source: 'user'}]},
      }, ctx);
      assert.equal(globalThis.prepassCalls, 1);
      assert.deepEqual(active, ['request_capability'], 'real hook pruned the tool');
      assert.ok(result.systemPrompt && !result.systemPrompt.includes('fixture-skill'), 'real hook pruned the skill');
      const call = params => recovery.execute('fixture-call', params, new AbortController().signal, () => {}, ctx);
      const listing = await call({});
      assert.equal(listing.content[0].text, 'tools\\tfixture-tool\\nskills\\tfixture-skill', 'recovery must see the hook-owned hidden catalogs');
      const tool = await call({capabilityType: 'tool', capabilityName: 'fixture-tool'});
      assert.notEqual(tool.isError, true);
      assert.ok(active.includes('fixture-tool'));
      const skill = await call({capabilityType: 'skill', capabilityName: 'fixture-skill'});
      assert.notEqual(skill.isError, true);
      assert.match(skill.content[0].text, /Fixture recovery instructions/);
      assert.equal((await call({})).content[0].text, 'No capabilities are hidden by the latest pruning decision.');
      console.log('CAPABILITY_STATE_OK');
    `;
    const childPath = path.join(root, 'state-sharing.mjs');
    await writeFile(childPath, script);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|lang)$/i.test(key)));
    const result = spawnSync(process.execPath, [childPath], {env, encoding: 'utf8', timeout: 60_000});
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.signal ?? ''}\n${result.stderr || result.stdout}`);
    assert.match(result.stdout, /CAPABILITY_STATE_OK/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
