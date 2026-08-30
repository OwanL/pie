import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleBackendRequest, type BackendRequestHandlerDeps } from '../../../src/backend/request-handler';
import { validateMcpSetServerEnabled } from '../../../src/backend/rpc';
import { BackendServer } from '../../../src/backend/server';
import type { McpServerEntryView } from '../../../src/backend/mcp-config';

/** Minimal deps: the mcp RPC handlers only read `startupCwd`. */
function makeDeps(cwd: string): BackendRequestHandlerDeps {
  return {
    sdkPath: '/sdk',
    agentDir: cwd,
    startupCwd: cwd,
    sdk: {} as BackendRequestHandlerDeps['sdk'],
    getSessionContext: () => undefined,
    ensureSessionContext: () => Promise.reject(new Error('not used')),
  } as unknown as BackendRequestHandlerDeps;
}

interface McpListResult {
  servers: McpServerEntryView[];
  overridePath: string;
}

interface McpToggleResult extends McpListResult {
  changed: boolean;
}

async function mcpList(cwd: string): Promise<McpListResult> {
  return await handleBackendRequest(makeDeps(cwd), {
    id: 'test-mcp-list',
    method: 'mcp.list',
    params: {},
  }) as McpListResult;
}

async function mcpSetServerEnabled(cwd: string, name: string, enabled: boolean): Promise<McpToggleResult> {
  return await handleBackendRequest(makeDeps(cwd), {
    id: 'test-mcp-toggle',
    method: 'mcp.setServerEnabled',
    params: { name, enabled },
  }) as McpToggleResult;
}

async function makeTempProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-mcp-rpc-'));
  await fs.writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: {
      echo: { command: 'node', args: ['echo-server.js'] },
      jira: { command: 'uvx', args: ['mcp-atlassian'], disabled: true },
    },
  }, null, 2));
  return cwd;
}

test('mcp.list returns the effective server list with merged disabled state', async (t) => {
  const cwd = await makeTempProject();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const result = await mcpList(cwd);
  const echo = result.servers.find((s) => s.name === 'echo');
  const jira = result.servers.find((s) => s.name === 'jira');
  assert.ok(echo, 'server from project .mcp.json must be listed');
  assert.equal(echo.disabled, false);
  assert.ok(jira, 'server disabled in project .mcp.json must be listed');
  assert.equal(jira.disabled, true);
  assert.ok(result.overridePath.endsWith(path.join('.pi', 'mcp.json')), `overridePath should point at .pi/mcp.json, got ${result.overridePath}`);
});

test('mcp.setServerEnabled persists ONLY the disabled field into .pi/mcp.json', async (t) => {
  const cwd = await makeTempProject();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  // Disable a currently-enabled server.
  const first = await mcpSetServerEnabled(cwd, 'echo', false);
  assert.equal(first.changed, true);
  assert.equal(first.servers.find((s) => s.name === 'echo')?.disabled, true);

  const overridePath = path.join(cwd, '.pi', 'mcp.json');
  const override = JSON.parse(await fs.readFile(overridePath, 'utf-8'));
  // The override must contain ONLY the disabled flag — never the server
  // definition or its credentials.
  assert.deepEqual(override, { mcpServers: { echo: { disabled: true } } });

  // Toggling again to the same state is a no-op.
  const again = await mcpSetServerEnabled(cwd, 'echo', false);
  assert.equal(again.changed, false);

  // Enabling removes the override entry entirely.
  const enabled = await mcpSetServerEnabled(cwd, 'echo', true);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.servers.find((s) => s.name === 'echo')?.disabled, false);
  const afterEnable = JSON.parse(await fs.readFile(overridePath, 'utf-8'));
  assert.deepEqual(afterEnable, { mcpServers: {} });
});

test('mcp.setServerEnabled overrides a lower-precedence disabled flag with explicit false', async (t) => {
  const cwd = await makeTempProject();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  // `jira` is disabled in the project .mcp.json (lower precedence than
  // .pi/mcp.json). Enabling it must write an EXPLICIT disabled:false so the
  // lower layer cannot re-disable it through merge semantics.
  const enabled = await mcpSetServerEnabled(cwd, 'jira', true);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.servers.find((s) => s.name === 'jira')?.disabled, false);
  const override = JSON.parse(await fs.readFile(path.join(cwd, '.pi', 'mcp.json'), 'utf-8'));
  assert.deepEqual(override, { mcpServers: { jira: { disabled: false } } });
});

test('mcp RPC validates its params', () => {
  assert.throws(() => validateMcpSetServerEnabled({ name: '', enabled: true }), /non-empty/);
  assert.throws(() => validateMcpSetServerEnabled({ name: 'jira', enabled: 'yes' }), /boolean/);
  assert.throws(() => validateMcpSetServerEnabled(null), /expected an object/);
  assert.deepEqual(validateMcpSetServerEnabled({ name: ' jira ', enabled: true }), { name: 'jira', enabled: true });
});

test('mcp RPCs reach the backend through BackendServer.handleRequest without a hot worker', async (t) => {
  const cwd = await makeTempProject();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  // Coordinator-only server: no worker runtime router, no SDK session
  // runtime. The host MCP UI RPCs must still be served by the coordinator
  // (they are runtime-free config reads/writes), not rejected as
  // isolated-runtime operations.
  const server = new BackendServer({ sdkPath: '/sdk', cwd, workerEntryPath: '/worker-entry.js' }) as any;
  server.agentDir = cwd;
  server.sessionDir = cwd;
  server.sessionDirResolved = true;
  server.sdk = { VERSION: 'test' };
  server.emit = () => undefined;
  server.emitSessionListChanged = async () => undefined;

  const listed = await server.handleRequest({ v: 1, id: 'server-mcp-list', method: 'mcp.list', params: {} }) as McpListResult;
  const echo = listed.servers.find((s) => s.name === 'echo');
  const jira = listed.servers.find((s) => s.name === 'jira');
  assert.ok(echo, 'mcp.list through BackendServer must list the project server');
  assert.equal(echo.disabled, false);
  assert.ok(jira, 'mcp.list through BackendServer must list the disabled project server');
  assert.equal(jira.disabled, true);

  const toggled = await server.handleRequest({
    v: 1, id: 'server-mcp-toggle', method: 'mcp.setServerEnabled',
    params: { name: 'echo', enabled: false },
  }) as McpToggleResult;
  assert.equal(toggled.changed, true);
  assert.equal(toggled.servers.find((s) => s.name === 'echo')?.disabled, true);
  const override = JSON.parse(await fs.readFile(path.join(cwd, '.pi', 'mcp.json'), 'utf-8'));
  assert.deepEqual(override, { mcpServers: { echo: { disabled: true } } });
});

// ─── Session-scoped MCP server overrides ─────────────────────────────────────

import { validateMcpSetSessionServerEnabled } from '../../../src/backend/rpc';
import { readSessionMcpOverrides, sessionMcpOverridePath } from '../../../src/backend/mcp-session-config';

function sessionRpc(cwd: string, params: unknown, deps?: Partial<BackendRequestHandlerDeps>): Promise<unknown> {
  return handleBackendRequest({ ...makeDeps(cwd), ...deps }, {
    id: 'test-mcp-session',
    method: 'mcp.setSessionServerEnabled',
    params,
  });
}

test('mcp.setSessionServerEnabled validates its params', () => {
  assert.throws(() => validateMcpSetSessionServerEnabled({ sessionPath: '', overrides: {} }), /sessionPath/);
  assert.throws(() => validateMcpSetSessionServerEnabled({ sessionPath: 's', overrides: 'x' }), /overrides/);
  assert.throws(() => validateMcpSetSessionServerEnabled({ sessionPath: 's', overrides: { jira: 'yes' } }), /boolean/);
  assert.throws(() => validateMcpSetSessionServerEnabled({ sessionPath: 's', overrides: { jira: true }, recycle: 'maybe' }), /recycle/);
  assert.deepEqual(
    validateMcpSetSessionServerEnabled({ sessionPath: ' s ', overrides: { jira: true }, recycle: true }),
    { sessionPath: 's', overrides: { jira: true }, recycle: true },
  );
  assert.deepEqual(
    validateMcpSetSessionServerEnabled({ sessionPath: 's', overrides: {} }),
    { sessionPath: 's', overrides: {}, recycle: false },
  );
});

test('mcp.list hydrates a session override set when sessionPath is given', async (t) => {
  const cwd = await makeTempProject();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  // No overrides yet.
  const before = await handleBackendRequest(makeDeps(cwd), {
    id: 'list-1', method: 'mcp.list', params: { sessionPath: path.join(cwd, 'session.jsonl') },
  }) as McpListResult & { sessionOverrides?: Record<string, boolean> };
  assert.deepEqual(before.sessionOverrides, {});

  await sessionRpc(cwd, {
    sessionPath: path.join(cwd, 'session.jsonl'),
    overrides: { echo: true, jira: false },
    recycle: false,
  });
  const after = await handleBackendRequest(makeDeps(cwd), {
    id: 'list-2', method: 'mcp.list', params: { sessionPath: path.join(cwd, 'session.jsonl') },
  }) as McpListResult & { sessionOverrides?: Record<string, boolean> };
  assert.deepEqual(after.sessionOverrides, { echo: true, jira: false });

  // A plain mcp.list carries no session payload.
  const plain = await mcpList(cwd) as McpListResult & { sessionOverrides?: Record<string, boolean> };
  assert.equal(plain.sessionOverrides, undefined);
});

test('mcp.setSessionServerEnabled writes the session artifact and recycles only when asked (idle)', async (t) => {
  const cwd = await makeTempProject();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const sessionPath = path.join(cwd, 'session.jsonl');

  const recycles: Array<{ sessionPath: string; reason: string }> = [];
  const depsWithRecycle = {
    recycleSessionRuntime: async (sessionPath: string, reason: string) => {
      recycles.push({ sessionPath, reason });
      return true;
    },
  };

  // recycle: false → the artifact is written but no recycle is attempted.
  await sessionRpc(cwd, { sessionPath, overrides: { echo: true }, recycle: false }, depsWithRecycle);
  assert.equal(recycles.length, 0);
  assert.deepEqual(await readSessionMcpOverrides(sessionPath), { echo: true });

  // recycle: true → the deps hook runs and returns true.
  const result = await sessionRpc(cwd, { sessionPath, overrides: { echo: true }, recycle: true }, depsWithRecycle) as { recycled: boolean };
  assert.equal(result.recycled, true);
  assert.deepEqual(recycles, [{ sessionPath, reason: 'mcp session server override changed' }]);

  // An empty override set removes the artifact entirely.
  await sessionRpc(cwd, { sessionPath, overrides: {}, recycle: false }, depsWithRecycle);
  assert.equal(await readSessionMcpOverrides(sessionPath), null);
  await assert.rejects(() => fs.access(sessionMcpOverridePath(sessionPath)));
});

test('mcp.setSessionServerEnabled reports a refused recycle as recycled:false', async (t) => {
  const cwd = await makeTempProject();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const sessionPath = path.join(cwd, 'session.jsonl');

  const refused = await sessionRpc(cwd, {
    sessionPath, overrides: { echo: true }, recycle: true,
  }, {
    recycleSessionRuntime: async () => false,
  }) as { recycled: boolean };
  assert.equal(refused.recycled, false, 'a busy session must surface recycled:false (pending hint)');

  // The artifact still landed — application rides the next session reload.
  assert.deepEqual(await readSessionMcpOverrides(sessionPath), { echo: true });
});
