// Session-scoped MCP server overrides — settings-owned lifecycle.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
// ─── Session-scoped MCP server overrides ─────────────────────────────────────

import { handleBackendRequest, type BackendRequestHandlerDeps } from '../../../agent-processes/coordinator/request-handler';
import { validateMcpSetSessionServerEnabled } from '../../../agent-processes/lib/rpc/backend-rpc';
import { readSessionMcpOverrides, sessionMcpOverridePath } from '../mcp-session-config';
import type { McpServerEntryView } from '../../../tools/package-integrations/mcp/mcp-config.js';

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

async function mcpList(cwd: string): Promise<McpListResult> {
  return await handleBackendRequest(makeDeps(cwd), {
    id: 'test-mcp-list',
    method: 'mcp.list',
    params: {},
  }) as McpListResult;
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
