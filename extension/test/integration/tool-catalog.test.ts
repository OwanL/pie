import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PIE_TOOLS, TOOL_INTEGRATIONS, pieToolsForContext, unavailablePieToolNames } from '../../../tools/index';
import { createBackendTools } from '../../../tools/backend';
import { WORKER_IPC_VERSION } from '../../src/backend/worker-protocol';

const EXPECTED_PIE_TOOLS = [
  'ask_user', 'bash', 'computer', 'defer_trigger', 'playwright',
  'request_capability', 'session_changes', 'session_control', 'subagent',
];

test('catalog explicitly owns every baseline Pie tool and references real source/registration paths', async () => {
  assert.deepEqual(PIE_TOOLS.map((entry) => entry.name), EXPECTED_PIE_TOOLS);
  assert.equal(new Set(PIE_TOOLS.map((entry) => entry.name)).size, PIE_TOOLS.length);
  for (const entry of PIE_TOOLS) {
    await access(path.resolve(process.cwd(), '..', entry.sourcePath));
    if (entry.registration.kind === 'extension') {
      await access(path.resolve(process.cwd(), '..', entry.registration.entryPath));
    }
  }
  assert.deepEqual(TOOL_INTEGRATIONS.map((entry) => entry.source), [
    '@earendil-works/pi-coding-agent', 'pi-web-access', 'pi-mcp-adapter',
  ]);
});

test('SDK discovery loads every catalog extension tool once from its stable path without catalog-owned schemas', async () => {
  const repoRoot = path.resolve(process.cwd(), '..');
  const extensionEntries = PIE_TOOLS.flatMap((entry) => entry.registration.kind === 'extension'
    ? [{ ...entry, registration: entry.registration }]
    : []);
  const expectedToolNames = extensionEntries.map((entry) => entry.name).sort();
  const expectedExtensionPaths = extensionEntries.map((entry) => path.resolve(repoRoot, entry.registration.entryPath));

  for (const entry of PIE_TOOLS) {
    assert.ok(entry.sourcePath.startsWith('tools/'), `${entry.name} source must remain under tools/`);
    assert.deepEqual(Object.keys(entry).sort(), ['contexts', 'name', 'registration', 'sourcePath']);
    assert.deepEqual(Object.keys(entry.registration).sort(), entry.registration.kind === 'extension'
      ? ['entryPath', 'extensionId', 'kind']
      : ['kind']);
    assert.equal('parameters' in entry, false, `${entry.name} schema belongs to its implementation`);
    assert.equal('schema' in entry, false, `${entry.name} schema belongs to its implementation`);
    await access(path.resolve(repoRoot, entry.sourcePath));
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pie-tool-catalog-'));
  const projectDir = path.join(tempRoot, 'project');
  const agentDir = path.join(tempRoot, 'agent');
  const configuredPackageDir = path.join(tempRoot, 'configured-extensions');
  const previousEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PIE_EXTENSION_TOGGLES_JSON: process.env.PIE_EXTENSION_TOGGLES_JSON,
    PIE_BASH_WARM_POOL: process.env.PIE_BASH_WARM_POOL,
  };
  try {
    await Promise.all([projectDir, agentDir, configuredPackageDir].map((dir) => mkdir(dir, { recursive: true })));
    // Isolate SDK global/project discovery and ensure registration does not warm
    // operational tools. Only factories are loaded; no event handlers or tools run.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PIE_EXTENSION_TOGGLES_JSON = JSON.stringify(Object.fromEntries(
      extensionEntries.map((entry) => [entry.registration.extensionId, false]),
    ));
    process.env.PIE_BASH_WARM_POOL = '0';

    await writeFile(path.join(configuredPackageDir, 'package.json'), JSON.stringify({
      name: 'pie-tool-catalog-fixture',
      pi: { extensions: expectedExtensionPaths },
    }));

    // Import the actual loader shipped by the extension's pinned SDK. The
    // configured package manifest lets discovery scan only the catalog entries
    // while retaining the real source paths for relative shim imports.
    const loaderPath = path.resolve(
      process.cwd(),
      'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js',
    );
    const loader = await import(pathToFileURL(loaderPath).href) as {
      discoverAndLoadExtensions(
        configuredPaths: string[],
        cwd: string,
        agentDir: string,
      ): Promise<{
        extensions: Array<{
          path: string;
          resolvedPath: string;
          tools: Map<string, { definition: { name: string; parameters?: unknown } }>;
        }>;
        errors: Array<{ path: string; error: string }>;
      }>;
    };
    const result = await loader.discoverAndLoadExtensions([configuredPackageDir], projectDir, agentDir);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.extensions.map((extension) => extension.path).sort(), expectedExtensionPaths.sort());

    const loadedById = new Map(result.extensions.map((extension) => {
      const pathSegments = extension.path.replace(/\\/g, '/').split('/').filter(Boolean);
      const id = path.basename(path.dirname(extension.path));
      assert.ok(pathSegments.includes('extensions'), `${extension.path} must retain its extensions/ discovery path`);
      assert.equal(extension.resolvedPath, extension.path);
      return [id, extension] as const;
    }));
    assert.deepEqual([...loadedById.keys()].sort(), extensionEntries.map((entry) => entry.registration.extensionId).sort());

    const registeredTools = result.extensions.flatMap((extension) => [...extension.tools.values()].map((tool) => tool.definition));
    const registeredNames = registeredTools.map((tool) => tool.name);
    assert.deepEqual([...registeredNames].sort(), expectedToolNames);
    for (const toolName of expectedToolNames) {
      assert.equal(registeredNames.filter((name) => name === toolName).length, 1, `${toolName} must register exactly once`);
      assert.ok(registeredTools.find((tool) => tool.name === toolName)?.parameters, `${toolName} must retain its implementation-owned schema`);
    }

    for (const entry of extensionEntries) {
      const extension = loadedById.get(entry.registration.extensionId);
      assert.ok(extension, `${entry.registration.extensionId} must be discovered by its path-based ID`);
      assert.equal(extension.path, path.resolve(repoRoot, entry.registration.entryPath));
      assert.deepEqual([...extension.tools.keys()], [entry.name]);
    }
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousEnv.PI_CODING_AGENT_DIR ?? '';
    process.env.PIE_EXTENSION_TOGGLES_JSON = previousEnv.PIE_EXTENSION_TOGGLES_JSON ?? '';
    process.env.PIE_BASH_WARM_POOL = previousEnv.PIE_BASH_WARM_POOL ?? '';
    if (previousEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
    if (previousEnv.PIE_EXTENSION_TOGGLES_JSON === undefined) delete process.env.PIE_EXTENSION_TOGGLES_JSON;
    if (previousEnv.PIE_BASH_WARM_POOL === undefined) delete process.env.PIE_BASH_WARM_POOL;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('inventory mirrors primary eligibility while in-memory children exclude host lifecycle tools', () => {
  assert.deepEqual(pieToolsForContext('inventory'), pieToolsForContext('primary'));
  assert.deepEqual(unavailablePieToolNames('subagent'), ['defer_trigger', 'session_control']);
  assert.deepEqual(createBackendTools({ kind: 'subagent' }), []);
});

test('primary and inventory assemble identical backend definitions without giving inventory a transport', async () => {
  let requests = 0;
  const primary = createBackendTools({
    kind: 'primary',
    requestSessionControl: async () => {
      requests += 1;
      return {
        ipcVersion: WORKER_IPC_VERSION,
        coordinatorGeneration: 1, workerId: 'test', workerGeneration: 1, workerPid: 1,
        rootSessionPath: 'C:/session.jsonl', sessionPath: 'C:/session.jsonl',
        leasePath: 'C:/session.jsonl', leaseRevision: 1, seq: 1,
        kind: 'session.control.result', requestId: 'test', ok: true, result: { sessions: [] },
      };
    },
  });
  const inventory = createBackendTools({ kind: 'inventory' });
  assert.deepEqual(primary.map((tool) => tool.name), PIE_TOOLS
    .filter((entry) => entry.registration.kind === 'backend').map((entry) => entry.name));
  const surface = (tools: typeof primary) => tools.map(({ execute: _execute, ...definition }) => definition);
  assert.deepEqual(surface(inventory), surface(primary));
  const context = { sessionManager: { getSessionFile: () => 'C:/session.jsonl' } } as never;
  const denied = await inventory[0].execute('inventory-call', { action: 'list' }, undefined, undefined, context);
  assert.equal('isError' in denied && denied.isError, true);
  assert.match(JSON.stringify(denied.content), /Inventory tool definitions cannot execute/);
  assert.equal(requests, 0);
  await primary[0].execute('primary-call', { action: 'list' }, undefined, undefined, context);
  assert.equal(requests, 1);
});
