// Source-policy integration only: no host, AgentSession or executable extensions.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';

async function main() {
  const require = createRequire(import.meta.url);
  const attempts: string[] = [];
  const deny = (name: string) => function () { attempts.push(name); throw new Error(`Fixture denied ${name}`); };
  // Include swallowed attempts from pending callbacks after result emission.
  process.on('exit', () => {
    if (attempts.length) {
      console.error(`Forbidden operations attempted: ${attempts.join(', ')}`);
      process.exitCode = 1;
    }
  });
  require('node:child_process').ChildProcess.prototype.spawn = deny('ChildProcess.spawn');
  require('node:worker_threads').Worker = deny('worker_threads.Worker');
  for (const [module, methods] of Object.entries({
    'node:child_process': ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
    'node:net': ['connect', 'createConnection'], 'node:tls': ['connect'],
    'node:http': ['request', 'get'], 'node:https': ['request', 'get'],
    'node:dgram': ['createSocket'], 'node:dns': ['lookup', 'resolve', 'reverse'],
  })) {
    const api = require(module);
    for (const method of methods) api[method] = deny(`${module}.${method}`);
  }
  require('node:net').Socket.prototype.connect = deny('Socket.connect');
  globalThis.fetch = deny('fetch') as typeof fetch;
  syncBuiltinESMExports();
  const [sdkPath, root, generation, workspace, save] = process.argv.slice(2);
  const { SettingsManager, DefaultResourceLoader } = await import(pathToFileURL(path.join(sdkPath, 'dist/index.js')).href);
  const { centralAppendSystemPromptOverride } = require('../../../harness/agent-instructions/prompt-assembly/append-system-prompt.ts');
  const { getApplicationResourceLoaderOptions } = require('../../../harness/agent-instructions/application-resources.ts');
  const { discoverAgents } = require('../../../harness/agent-instructions/agent-discovery/agents.ts');
  const { subagentSystemPrompt } = require('../../../harness/tools/subagent/system-prompt.ts');
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, workspace);
  const moduleDir = path.join(root, generation);
  const instructionsRoot = path.join(moduleDir, 'resources/agent-instructions');
  const settings = SettingsManager.create(cwd, agentDir);
  if (save === 'save') { settings.setTheme('private-saved-theme'); await settings.flush(); }
  const resources = getApplicationResourceLoaderOptions({ cwd, agentDir, moduleDir, instructionsRoot, context: 'primary' });
  if (resources.defaultExtensions.length) throw new Error('Fixture must never supply extension factories');
  const common = { ...resources, cwd, agentDir, settingsManager: settings, noExtensions: true, noPromptTemplates: true, noThemes: true };
  const mainLoader = new DefaultResourceLoader({ ...common, appendSystemPromptOverride: centralAppendSystemPromptOverride(agentDir, { cwd, instructionsRoot, isProjectTrusted: () => true }) });
  await mainLoader.reload({ resolveProjectTrust: async () => true });
  const role = discoverAgents(cwd, 'both', { agentDir, moduleDir, instructionsRoot }).agents.find((entry: { name: string }) => entry.name === 'fixture-role');
  const child = new DefaultResourceLoader({ ...common, appendSystemPrompt: subagentSystemPrompt(agentDir, role?.systemPrompt ?? '', { instructionsRoot }) });
  await child.reload({ resolveProjectTrust: async () => true });
  const skill = mainLoader.getSkills().skills.find((entry: { name: string }) => entry.name === 'fixture-skill');
  if (attempts.length) throw new Error(`Forbidden operations attempted: ${attempts}`);
  process.stdout.write(JSON.stringify({ theme: settings.getTheme(), main: mainLoader.getAppendSystemPrompt(), child: child.getAppendSystemPrompt(), role: role?.systemPrompt.trim(), skill: skill && fs.readFileSync(skill.filePath, 'utf8'), attempts }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
